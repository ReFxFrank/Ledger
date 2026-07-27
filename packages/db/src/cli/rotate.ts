/**
 * `pnpm keys:rotate` — re-wraps every sealed record under the current primary KEK.
 *
 * The procedure this implements is docs/RUNBOOK.md "Key rotation": the new key is already in
 * `ENCRYPTION_KEY`, the old one is in `ENCRYPTION_KEY_RETIRED`, the app is serving reads with
 * both, and this walks the tables re-wrapping data keys. It never re-encrypts payloads, which is
 * why it is fast and safe against a live system.
 *
 * The decisions — rotate, already current, unopenable — are pure and live in `@ledger/crypto`
 * (`decideReseal`). This file is the IO: paging rows out, applying UPDATEs, printing the report.
 * It lives in this package rather than `@ledger/crypto` because rotating requires a Postgres
 * driver and crypto deliberately has none.
 *
 * Resumable by construction: a row already under the primary key is skipped (`reseal` returns
 * null), so an interrupted run picks up where it stopped. Safe against concurrent writers: each
 * UPDATE is conditional on the key id the row was read under, so a re-link that re-seals a fresh
 * token mid-rotation wins and loses nothing.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Keyring,
  type ResealDecision,
  type RotationTally,
  type SealedRecord,
  aadFor,
  createTally,
  decideReseal,
  envKekProvider,
  recordDecision,
} from '@ledger/crypto';
import { loadRootEnv } from '@ledger/env';
import { and, asc, eq, gt } from 'drizzle-orm';
import { type Database, createDatabase } from '../client';
import { bankConnections } from '../schema/banking';

const BATCH_SIZE = 100;

type RotateDecision = Extract<ResealDecision, { kind: 'rotate' }>;

/**
 * One sealed column. Adding the next encrypted column to the rotation is one more entry here:
 * how to page its rows out (with enough context to rebuild the AAD), and how to apply one
 * optimistic re-wrap.
 */
interface SealedColumn {
  readonly label: string;
  page(db: Database, afterId: string | null): Promise<readonly SealedRecord[]>;
  /** Returns false when the conditional UPDATE matched nothing — a concurrent writer won. */
  applyRotate(db: Database, decision: RotateDecision): Promise<boolean>;
}

const SEALED_COLUMNS: readonly SealedColumn[] = [
  {
    label: 'bank_connections.access_token_ciphertext',
    async page(db, afterId) {
      const rows = await db
        .select({
          id: bankConnections.id,
          keyId: bankConnections.keyId,
          ciphertext: bankConnections.accessTokenCiphertext,
          provider: bankConnections.provider,
          externalItemId: bankConnections.externalItemId,
        })
        .from(bankConnections)
        .where(afterId === null ? undefined : gt(bankConnections.id, afterId))
        .orderBy(asc(bankConnections.id))
        .limit(BATCH_SIZE);

      return rows.map((row) => ({
        id: row.id,
        keyId: row.keyId,
        ciphertext: row.ciphertext,
        // Byte-for-byte the AAD `accessTokenAad` builds in packages/banking/src/adapter.ts —
        // provider:item rather than the row uuid, because the token is sealed before the row
        // exists. Restated here rather than imported because `@ledger/banking` depends on this
        // package; its `adapter.test.ts` pins the construction, and any drift fails every open.
        aad: aadFor(
          'bank_connections',
          `${row.provider}:${row.externalItemId}`,
          'access_token_ciphertext',
        ),
      }));
    },
    async applyRotate(db, decision) {
      // Conditional on the key id we read: if a re-link replaced the ciphertext since, this
      // matches nothing and the fresher seal — already under the new primary — survives.
      const updated = await db
        .update(bankConnections)
        .set({
          accessTokenCiphertext: decision.sealed.ciphertext,
          keyId: decision.sealed.keyId,
        })
        .where(and(eq(bankConnections.id, decision.id), eq(bankConnections.keyId, decision.fromKeyId)))
        .returning({ id: bankConnections.id });
      return updated.length === 1;
    },
  },
];

interface ColumnResult {
  readonly tally: RotationTally;
  /** Rows whose conditional UPDATE matched nothing — re-sealed by a concurrent writer. */
  readonly raced: number;
}

async function rotateColumn(
  db: Database,
  column: SealedColumn,
  keyring: Keyring,
  dryRun: boolean,
): Promise<ColumnResult> {
  const tally = createTally();
  let raced = 0;
  let afterId: string | null = null;

  for (;;) {
    const rows = await column.page(db, afterId);
    for (const row of rows) {
      const decision = decideReseal(keyring, row);
      if (decision.kind === 'rotate' && !dryRun) {
        const applied = await column.applyRotate(db, decision);
        if (!applied) {
          raced += 1;
          continue;
        }
      }
      recordDecision(tally, decision);
    }
    if (rows.length < BATCH_SIZE) break;
    const last = rows.at(-1);
    if (last === undefined) break;
    afterId = last.id;
  }

  return { tally, raced };
}

function printTwoKeyProcedure(): void {
  console.error(
    [
      'ENCRYPTION_KEY_RETIRED is not set. With only one key configured, every record is either',
      'already under that key or unopenable — there is nothing a rotation could do.',
      '',
      'The two-key procedure (docs/RUNBOOK.md, "Key rotation"):',
      '',
      '  1. Generate the new key:  openssl rand -base64 32',
      '  2. Move the CURRENT key into ENCRYPTION_KEY_RETIRED and put the NEW key into',
      '     ENCRYPTION_KEY. Both must be present. Restart the app — it can now open old',
      '     records and seals new ones under the new key.',
      '  3. Run `pnpm keys:rotate` to re-wrap every existing record.',
      '  4. Only once it reports zero rows under a retired key, remove ENCRYPTION_KEY_RETIRED',
      '     and restart.',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  loadRootEnv(dirname(fileURLToPath(import.meta.url)));
  const dryRun = process.argv.includes('--dry-run');

  let keyring: Keyring;
  try {
    const { primary, retired } = await envKekProvider().load();
    if (retired.length === 0) {
      printTwoKeyProcedure();
      process.exitCode = 1;
      return;
    }
    keyring = new Keyring(primary, retired);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
    process.exitCode = 1;
    return;
  }

  console.log(dryRun ? 'Key rotation — dry run, nothing will be written' : 'Key rotation');
  console.log(`  primary key id:  ${keyring.primaryKeyId}`);
  console.log(
    `  retired key ids: ${keyring
      .knownKeyIds()
      .filter((id) => id !== keyring.primaryKeyId)
      .join(', ')}`,
  );

  // One connection: the walk is sequential, and fewer sockets to leak if a page fails.
  const handle = createDatabase({ url, max: 1 });
  let remaining = 0;

  try {
    for (const column of SEALED_COLUMNS) {
      const { tally, raced } = await rotateColumn(handle.db, column, keyring, dryRun);

      console.log('');
      console.log(column.label);
      console.log(`  total:                     ${tally.total + raced}`);
      console.log(`  ${dryRun ? 'would rotate' : 'rotated'}:${' '.repeat(dryRun ? 14 : 19)}${tally.rotated}`);
      console.log(`  already under primary key: ${tally.alreadyCurrent}`);
      if (raced > 0) {
        console.log(`  re-sealed concurrently:    ${raced} (skipped — already under a current key)`);
      }
      console.log(`  failed to open:            ${tally.failures.length}`);

      for (const failure of tally.failures) {
        console.error(`    FAILED id=${failure.id} key_id=${failure.keyId}: ${failure.reason}`);
      }
      remaining += tally.failures.length;
    }
  } finally {
    await handle.close();
  }

  console.log('');
  if (dryRun) {
    console.log('Dry run — nothing was written. Re-run without --dry-run to rotate.');
  }
  if (remaining > 0) {
    console.error(
      `${remaining} row(s) could not be opened and remain under their old key id. An unopenable ` +
        'row means the KEK that sealed it is not in the ring, or the row was corrupted or moved. ' +
        'If a retired key was removed too early, put it back in ENCRYPTION_KEY_RETIRED and ' +
        're-run. If the key is genuinely gone, those connections must be re-linked by their ' +
        'users — see docs/RUNBOOK.md, "Key rotation".',
    );
    process.exitCode = 1;
  } else {
    console.log(
      dryRun
        ? '0 rows would remain under a retired key id.'
        : '0 rows remain under a retired key id. It is now safe to remove ENCRYPTION_KEY_RETIRED and restart.',
    );
  }
}

await main();
