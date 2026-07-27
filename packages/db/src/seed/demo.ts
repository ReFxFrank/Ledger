/**
 * `pnpm seed:demo` — a demo user whose data exercises the cases that break subscription trackers.
 *
 * Two halves, deliberately separated:
 *
 *  - **The dataset** (`demo-data.ts`) is a pure function of a `Clock`. It is what `demo.test.ts`
 *    asserts against, and it is why the acceptance criteria ("an annual plan with exactly two
 *    occurrences", "a trial that converts in two days") are checkable without a database.
 *  - **The write** is here, and it is idempotent. Every id is derived from a stable name, so a
 *    second run is a pile of `ON CONFLICT DO UPDATE`s rather than a second set of twenty
 *    subscriptions.
 *
 * The merchant registry is seeded too. That is not mock data — it is `packages/providers`'
 * YAML, the thing the product is actually built around, and without it every subscription is an
 * unrecognised string with no cancellation playbook behind it.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { FixedClock, formatPlainDate, parsePlainDate, toInstant } from '@ledger/core';
import { loadRootEnv } from '@ledger/env';
import { type MerchantFile, loadMerchants } from '@ledger/providers';
import { type Database, createDatabase } from '../client';
import {
  accounts,
  cancellationEvents,
  cancellationPlaybooks,
  cancellationRequests,
  merchants,
  notificationPreferences,
  notificationSettings,
  paymentMethods,
  subscriptionPriceHistory,
  subscriptionShares,
  subscriptions,
  twoFactors,
  usageLogs,
  users,
} from '../schema/index';
import { type DemoDataset, buildDemoDataset } from './demo-data';
import { DEMO_USER_ID, demoUuid } from './ids';

/**
 * The pinned "today".
 *
 * The seed has to be reproducible, so it cannot read the wall clock. Anyone who wants the demo
 * anchored to the present passes `--as-of=YYYY-MM-DD`, which is an explicit choice rather than
 * an ambient one.
 */
const DEFAULT_REFERENCE_DATE = '2026-07-20';

export { buildDemoDataset } from './demo-data';

// ── merchant registry ──────────────────────────────────────────────────────────────────

/** A merchant is only as trustworthy as its most recently checked playbook. */
function lastVerifiedInstant(file: MerchantFile): Date | null {
  const dates = file.playbooks.map((playbook) => playbook.lastVerifiedAt).sort();
  const latest = dates[dates.length - 1];
  return latest === undefined ? null : toInstant(parsePlainDate(latest), 'UTC');
}

/**
 * Copies `packages/providers/data` into `merchants` + `cancellation_playbooks`.
 *
 * Returns slug → id, because merchant ids are assigned by the database (or already exist from a
 * previous run) and the demo subscriptions reference merchants by slug.
 */
async function seedMerchantRegistry(db: Database): Promise<ReadonlyMap<string, string>> {
  const files = loadMerchants();

  const rows = await db
    .insert(merchants)
    .values(
      files.map((file) => ({
        slug: file.slug,
        name: file.name,
        legalName: file.legalName ?? null,
        category: file.category,
        domains: [...file.domains],
        aliases: [...file.aliases],
        descriptorPatterns: [...file.descriptorPatterns],
        typicalIntervals: file.typicalIntervals.map((entry) => ({
          unit: entry.unit,
          count: entry.count,
        })),
        verifiedAt: lastVerifiedInstant(file),
      })),
    )
    .onConflictDoUpdate({
      target: merchants.slug,
      set: {
        name: sql`excluded.name`,
        legalName: sql`excluded.legal_name`,
        category: sql`excluded.category`,
        domains: sql`excluded.domains`,
        aliases: sql`excluded.aliases`,
        descriptorPatterns: sql`excluded.descriptor_patterns`,
        typicalIntervals: sql`excluded.typical_intervals`,
        verifiedAt: sql`excluded.verified_at`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: merchants.id, slug: merchants.slug });

  const idBySlug = new Map(rows.map((row) => [row.slug, row.id]));

  const playbookRows = files.flatMap((file) => {
    const merchantId = idBySlug.get(file.slug);
    if (merchantId === undefined) return [];
    return file.playbooks.map((playbook) => ({
      merchantId,
      channel: playbook.channel,
      method: playbook.method,
      difficulty: playbook.difficulty,
      cancelUrl: playbook.cancelUrl ?? null,
      // Rebuilt field by field rather than spread: the column's JSON type has optional
      // properties, and `exactOptionalPropertyTypes` will not accept an explicit `undefined`.
      steps: playbook.steps.map((step) => ({
        text: step.text,
        ...(step.detail === undefined ? {} : { detail: step.detail }),
        ...(step.warning === undefined ? {} : { warning: step.warning }),
      })),
      phone: playbook.phone ?? null,
      hours: playbook.hours ?? null,
      noticePeriodDays: playbook.noticePeriodDays,
      refundPolicy: playbook.refundPolicy ?? null,
      retentionOfferNotes: playbook.retentionOfferNotes ?? null,
      gotchas: [...playbook.gotchas],
      letterTemplate: playbook.letterTemplate ?? null,
      evidenceHint: playbook.evidenceHint ?? null,
      sourceUrl: playbook.sourceUrl,
      lastVerifiedAt: toInstant(parsePlainDate(playbook.lastVerifiedAt), 'UTC'),
    }));
  });

  await db
    .insert(cancellationPlaybooks)
    .values(playbookRows)
    .onConflictDoUpdate({
      target: [cancellationPlaybooks.merchantId, cancellationPlaybooks.channel],
      set: {
        method: sql`excluded.method`,
        difficulty: sql`excluded.difficulty`,
        cancelUrl: sql`excluded.cancel_url`,
        steps: sql`excluded.steps`,
        phone: sql`excluded.phone`,
        hours: sql`excluded.hours`,
        noticePeriodDays: sql`excluded.notice_period_days`,
        refundPolicy: sql`excluded.refund_policy`,
        retentionOfferNotes: sql`excluded.retention_offer_notes`,
        gotchas: sql`excluded.gotchas`,
        letterTemplate: sql`excluded.letter_template`,
        evidenceHint: sql`excluded.evidence_hint`,
        sourceUrl: sql`excluded.source_url`,
        lastVerifiedAt: sql`excluded.last_verified_at`,
        updatedAt: sql`now()`,
      },
    });

  // Succession is a second pass because a merchant can be superseded by one that is later in
  // the file order, and the target row has to exist before it can be pointed at.
  for (const file of files) {
    if (file.supersededBy === undefined) continue;
    const successorId = idBySlug.get(file.supersededBy);
    if (successorId === undefined) continue;
    await db
      .update(merchants)
      .set({ supersededBy: successorId, updatedAt: new Date() })
      .where(eq(merchants.slug, file.slug));
  }

  return idBySlug;
}

// ── the demo user's data ───────────────────────────────────────────────────────────────

async function seedDemoUser(
  db: Database,
  dataset: DemoDataset,
  merchantIdBySlug: ReadonlyMap<string, string>,
  totpSecretForStorage: string,
): Promise<void> {
  const now = new Date();

  await db
    .insert(users)
    .values({
      id: dataset.user.id,
      name: dataset.user.name,
      email: dataset.user.email,
      emailVerified: true,
      // The demo user has a `two_factor` row, so this must agree with it. `protectedProcedure`
      // reads this column and nothing else; leaving it false enrols a user who is already
      // enrolled, and every protected procedure 403s in the meantime.
      twoFactorEnabled: true,
      displayCurrency: dataset.user.displayCurrency,
      timezone: dataset.user.timezone,
      locale: dataset.user.locale,
      onboardingCompletedAt: dataset.user.onboardingCompletedAt,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        name: sql`excluded.name`,
        email: sql`excluded.email`,
        emailVerified: sql`excluded.email_verified`,
        twoFactorEnabled: sql`excluded.two_factor_enabled`,
        displayCurrency: sql`excluded.display_currency`,
        timezone: sql`excluded.timezone`,
        locale: sql`excluded.locale`,
        onboardingCompletedAt: sql`excluded.onboarding_completed_at`,
        deletedAt: null,
        updatedAt: now,
      },
    });

  await db
    .insert(accounts)
    .values({
      id: demoUuid('account:credential'),
      accountId: dataset.user.id,
      providerId: 'credential',
      userId: dataset.user.id,
      password: dataset.credentials.passwordHash,
    })
    .onConflictDoUpdate({
      target: accounts.id,
      set: { password: sql`excluded.password`, updatedAt: now },
    });

  await db
    .insert(twoFactors)
    .values({
      id: demoUuid('two-factor:totp'),
      userId: dataset.user.id,
      secret: totpSecretForStorage,
      backupCodes: dataset.credentials.backupCodes.join(','),
    })
    .onConflictDoUpdate({
      target: twoFactors.id,
      set: { secret: sql`excluded.secret`, backupCodes: sql`excluded.backup_codes` },
    });

  await db
    .insert(paymentMethods)
    .values(
      dataset.paymentMethods.map((method) => ({
        id: method.id,
        userId: dataset.user.id,
        label: method.label,
        type: 'card' as const,
        brand: method.brand,
        last4: method.last4,
        expMonth: method.expMonth,
        expYear: method.expYear,
      })),
    )
    .onConflictDoUpdate({
      target: paymentMethods.id,
      set: {
        label: sql`excluded.label`,
        brand: sql`excluded.brand`,
        last4: sql`excluded.last4`,
        expMonth: sql`excluded.exp_month`,
        expYear: sql`excluded.exp_year`,
        archivedAt: null,
        updatedAt: now,
      },
    });

  await db
    .insert(subscriptions)
    .values(
      dataset.subscriptions.map((subscription) => ({
        id: subscription.id,
        userId: dataset.user.id,
        merchantId:
          subscription.merchantSlug === null
            ? null
            : (merchantIdBySlug.get(subscription.merchantSlug) ?? null),
        displayName: subscription.displayName,
        status: subscription.status,
        amountMinor: subscription.amountMinor,
        currency: subscription.currency,
        intervalUnit: subscription.interval.unit,
        intervalCount: subscription.interval.count,
        anchorDate: subscription.anchorDate,
        nextRenewalAt: subscription.nextRenewalAt,
        lastChargedAt: subscription.lastChargedAt,
        trialEndsAt: subscription.trialEndsAt,
        billingChannel: subscription.billingChannel,
        paymentMethodId: subscription.paymentMethodId,
        category: subscription.category,
        source: subscription.source,
        confidence: subscription.confidence,
        variableAmount: subscription.variableAmount,
        autoRenew: subscription.autoRenew,
        cancelByAt: subscription.cancelByAt,
        notes: subscription.notes,
        url: subscription.url,
        tags: [...subscription.tags],
      })),
    )
    .onConflictDoUpdate({
      target: subscriptions.id,
      set: {
        merchantId: sql`excluded.merchant_id`,
        displayName: sql`excluded.display_name`,
        status: sql`excluded.status`,
        amountMinor: sql`excluded.amount_minor`,
        currency: sql`excluded.currency`,
        intervalUnit: sql`excluded.interval_unit`,
        intervalCount: sql`excluded.interval_count`,
        anchorDate: sql`excluded.anchor_date`,
        nextRenewalAt: sql`excluded.next_renewal_at`,
        lastChargedAt: sql`excluded.last_charged_at`,
        trialEndsAt: sql`excluded.trial_ends_at`,
        billingChannel: sql`excluded.billing_channel`,
        paymentMethodId: sql`excluded.payment_method_id`,
        category: sql`excluded.category`,
        source: sql`excluded.source`,
        confidence: sql`excluded.confidence`,
        variableAmount: sql`excluded.variable_amount`,
        autoRenew: sql`excluded.auto_renew`,
        cancelByAt: sql`excluded.cancel_by_at`,
        notes: sql`excluded.notes`,
        url: sql`excluded.url`,
        tags: sql`excluded.tags`,
        archivedAt: null,
        updatedAt: now,
      },
    });

  const priceRows = dataset.subscriptions.flatMap((subscription) =>
    subscription.priceHistory.map((row) => ({
      id: row.id,
      subscriptionId: subscription.id,
      amountMinor: row.amountMinor,
      currency: row.currency,
      effectiveFrom: row.effectiveFrom,
      deltaBps: row.deltaBps,
      source: row.source,
    })),
  );
  if (priceRows.length > 0) {
    await db
      .insert(subscriptionPriceHistory)
      .values(priceRows)
      .onConflictDoUpdate({
        target: subscriptionPriceHistory.id,
        set: {
          amountMinor: sql`excluded.amount_minor`,
          currency: sql`excluded.currency`,
          effectiveFrom: sql`excluded.effective_from`,
          deltaBps: sql`excluded.delta_bps`,
        },
      });
  }

  const shareRows = dataset.subscriptions.flatMap((subscription) =>
    subscription.shares.map((share) => ({
      id: share.id,
      subscriptionId: subscription.id,
      personLabel: share.personLabel,
      shareMinor: share.shareMinor,
      isSelf: share.isSelf,
    })),
  );
  if (shareRows.length > 0) {
    await db
      .insert(subscriptionShares)
      .values(shareRows)
      .onConflictDoUpdate({
        target: subscriptionShares.id,
        set: {
          personLabel: sql`excluded.person_label`,
          shareMinor: sql`excluded.share_minor`,
          isSelf: sql`excluded.is_self`,
        },
      });
  }

  const usageRows = dataset.subscriptions.flatMap((subscription) =>
    subscription.usage.map((log) => ({
      id: log.id,
      subscriptionId: subscription.id,
      occurredAt: log.occurredAt,
      note: log.note,
    })),
  );
  if (usageRows.length > 0) {
    await db
      .insert(usageLogs)
      .values(usageRows)
      .onConflictDoUpdate({
        target: usageLogs.id,
        set: { occurredAt: sql`excluded.occurred_at`, note: sql`excluded.note` },
      });
  }

  await db
    .insert(cancellationRequests)
    .values(
      dataset.cancellations.map((request) => ({
        id: request.id,
        subscriptionId: request.subscriptionId,
        userId: dataset.user.id,
        method: request.method,
        channel: request.channel,
        status: request.status,
        checklist: request.checklist.map((step) => ({
          id: step.id,
          text: step.text,
          ...(step.doneAt === undefined ? {} : { doneAt: step.doneAt }),
        })),
        deadlineAt: request.deadlineAt,
        effectiveAt: request.effectiveAt,
        expectedNextChargeAt: request.expectedNextChargeAt,
        verificationWindowEndsAt: request.verificationWindowEndsAt,
        verifiedAt: request.verifiedAt,
        confirmationReference: request.confirmationReference,
        outcomeNotes: request.outcomeNotes,
        startedAt: request.startedAt,
        resolvedAt: request.resolvedAt,
      })),
    )
    .onConflictDoUpdate({
      target: cancellationRequests.id,
      set: {
        status: sql`excluded.status`,
        checklist: sql`excluded.checklist`,
        deadlineAt: sql`excluded.deadline_at`,
        effectiveAt: sql`excluded.effective_at`,
        expectedNextChargeAt: sql`excluded.expected_next_charge_at`,
        verificationWindowEndsAt: sql`excluded.verification_window_ends_at`,
        verifiedAt: sql`excluded.verified_at`,
        confirmationReference: sql`excluded.confirmation_reference`,
        outcomeNotes: sql`excluded.outcome_notes`,
        resolvedAt: sql`excluded.resolved_at`,
        updatedAt: now,
      },
    });

  const eventRows = dataset.cancellations.flatMap((request) =>
    request.events.map((event) => ({
      id: event.id,
      requestId: request.id,
      at: event.at,
      actor: event.actor,
      type: event.type,
      payload: event.payload,
    })),
  );
  await db
    .insert(cancellationEvents)
    .values(eventRows)
    // The timeline is append-only by design (it is dispute evidence), so a re-run leaves
    // existing rows exactly as they were rather than rewriting history.
    .onConflictDoNothing({ target: cancellationEvents.id });

  await db
    .insert(notificationPreferences)
    .values(
      dataset.notificationPreferences.map((preference) => ({
        id: preference.id,
        userId: dataset.user.id,
        type: preference.type,
        channels: [...preference.channels],
        leadTimeDays: preference.leadTimeDays,
      })),
    )
    .onConflictDoUpdate({
      target: [notificationPreferences.userId, notificationPreferences.type],
      set: {
        channels: sql`excluded.channels`,
        leadTimeDays: sql`excluded.lead_time_days`,
        updatedAt: now,
      },
    });

  await db
    .insert(notificationSettings)
    .values({
      userId: dataset.user.id,
      quietHoursStartMinute: dataset.quietHoursStartMinute,
      quietHoursEndMinute: dataset.quietHoursEndMinute,
    })
    .onConflictDoUpdate({
      target: notificationSettings.userId,
      set: {
        quietHoursStartMinute: sql`excluded.quiet_hours_start_minute`,
        quietHoursEndMinute: sql`excluded.quiet_hours_end_minute`,
        updatedAt: now,
      },
    });
}

// ── TOTP storage ───────────────────────────────────────────────────────────────────────

/**
 * better-auth encrypts `two_factor.secret` with `BETTER_AUTH_SECRET` before storing it, so a
 * plaintext secret in that column is one the sign-in flow cannot read.
 *
 * @ledger/db cannot depend on better-auth — the auth library belongs to the web app, and a
 * schema package that imports it would invert the dependency. So the seed borrows better-auth's
 * *own* encryption through the web app's module graph rather than reimplementing it: a
 * reimplementation would be a second copy of a security-relevant format, silently drifting.
 *
 * Best effort on purpose. If it cannot be reached the seed still produces every subscription —
 * it just says plainly that 2FA has to be enrolled through the app.
 */
interface BetterAuthCrypto {
  readonly symmetricEncrypt?: (input: { key: string; data: string }) => Promise<unknown>;
}

async function sealTotpSecret(plaintext: string): Promise<{ value: string; sealed: boolean }> {
  const authSecret = process.env.BETTER_AUTH_SECRET;
  if (authSecret === undefined || authSecret === '') return { value: plaintext, sealed: false };

  try {
    const fromWebApp = createRequire(new URL('../../../../apps/web/package.json', import.meta.url));
    const modulePath = pathToFileURL(fromWebApp.resolve('better-auth/crypto')).href;
    const loaded: unknown = await import(modulePath);
    const encrypt = (loaded as BetterAuthCrypto).symmetricEncrypt;
    if (typeof encrypt !== 'function') return { value: plaintext, sealed: false };

    const sealedValue: unknown = await encrypt({ key: authSecret, data: plaintext });
    if (typeof sealedValue !== 'string') return { value: plaintext, sealed: false };
    return { value: sealedValue, sealed: true };
  } catch (error) {
    console.warn(
      `  ! could not reach better-auth's encryption (${describe(error)}); ` +
        'storing the TOTP secret unencrypted.',
    );
    return { value: plaintext, sealed: false };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── entrypoint ─────────────────────────────────────────────────────────────────────────

function referenceDateFromArgv(argv: readonly string[]): string {
  const flag = argv.find((argument) => argument.startsWith('--as-of='));
  return flag === undefined ? DEFAULT_REFERENCE_DATE : flag.slice('--as-of='.length);
}

function report(dataset: DemoDataset, sealed: boolean): void {
  const { credentials } = dataset;
  const rule = '─'.repeat(72);

  console.log(`\n${rule}`);
  console.log('  Demo user seeded.');
  console.log(rule);
  console.log(`  email     ${credentials.email}`);
  console.log(`  password  ${credentials.password}`);
  console.log(`  TOTP      ${credentials.totpSecretBase32}`);
  console.log(`  otpauth   ${credentials.totpUri}`);
  console.log(`  backup    ${credentials.backupCodes.slice(0, 3).join('  ')}  …`);
  console.log(rule);
  const currencies = new Set(dataset.subscriptions.map((subscription) => subscription.currency));
  const counts = [
    `${String(dataset.subscriptions.length)} subscriptions`,
    `${String(currencies.size)} currencies`,
    `${String(dataset.paymentMethods.length)} payment methods`,
  ].join(', ');

  console.log(`  ${counts}`);
  console.log(`  reference date ${formatPlainDate(dataset.referenceDate)} (${dataset.timezone})`);
  console.log(rule);

  if (!sealed) {
    console.log('  NOTE: the TOTP secret was stored unencrypted. better-auth expects this');
    console.log('  column encrypted with BETTER_AUTH_SECRET, so if sign-in rejects the code,');
    console.log('  enrol 2FA through the app instead.');
  }
  console.log('  Add the TOTP secret above to an authenticator app, or scan the otpauth URI.');
  console.log('  2FA is mandatory — there is no way past the prompt without it.');
  console.log(`${rule}\n`);
}

async function main(): Promise<void> {
  // Same reason as migrate.ts: a standalone Node entrypoint sees none of the repo's config.
  loadRootEnv();

  const url = process.env.DATABASE_URL;
  if (url === undefined || url === '') {
    console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }

  const asOf = referenceDateFromArgv(process.argv.slice(2));
  const dataset = buildDemoDataset({
    // Midday, so that a timezone offset either side of UTC cannot move the reference date.
    clock: new FixedClock(toInstant(parsePlainDate(asOf), 'UTC', 12)),
  });

  const handle = createDatabase({ url, max: 1, statementTimeoutSeconds: 120 });

  // Before any writing: if the credential path is going to degrade, say so while the output is
  // still at the top of the terminal rather than under a hundred lines of merchant upserts.
  const totp = await sealTotpSecret(dataset.credentials.totpSecret);

  try {
    console.log('Seeding the merchant registry…');
    const merchantIdBySlug = await seedMerchantRegistry(handle.db);
    console.log(`  ${String(merchantIdBySlug.size)} merchants.`);

    console.log('Seeding the demo user…');
    await seedDemoUser(handle.db, dataset, merchantIdBySlug, totp.value);

    report(dataset, totp.sealed);
  } catch (error) {
    console.error(`Seed failed: ${describe(error)}`);
    process.exitCode = 1;
  } finally {
    await handle.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await main();
}

export { DEMO_USER_ID, seedDemoUser, seedMerchantRegistry };
