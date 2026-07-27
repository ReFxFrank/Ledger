/**
 * Cross-user access (brief §9.3). Non-optional, and deliberately generic.
 *
 * The failure this exists to prevent is not a clever attack. It is a procedure added in Phase 6
 * on `publicProcedure` because that was the shortest line to type, shipped, and never noticed —
 * and now anyone who can guess a UUID reads somebody else's financial life.
 *
 * So this suite does not contain a list of procedures. It walks `appRouter._def.procedures` at
 * runtime and asserts that everything it finds is built on `protectedProcedure` or
 * `sensitiveProcedure`, with a two-entry allowlist that has its expected size hardcoded. A
 * procedure added later is covered the moment it exists; an allowlist that grows turns the
 * suite red. That is the whole design.
 *
 * The middleware check is by *identity*, not by name: `.use()` returns a new builder whose
 * `middlewares` array is the old one plus the new entry, so a procedure built from
 * `protectedProcedure` necessarily carries that builder's exact middleware functions as a
 * prefix. Nothing else can fake that.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { protectedProcedure, publicProcedure, sensitiveProcedure, sessionProcedure } from './init';
import { appRouter } from './routers/_app';

// ── the allowlist ──────────────────────────────────────────────────────────────────────

/**
 * Procedures allowed to run without the 2FA gate, and why.
 *
 * Both are still behind `sessionProcedure` — signed in, second factor possibly still pending.
 * There is no procedure in this app that an anonymous caller may reach.
 *
 *  - `me.current`   the app shell reads it *before* 2FA enrolment to decide where to send the
 *                   user. Putting it behind the 2FA gate makes enrolment unreachable.
 *  - `me.currencies` the static ISO-4217 table from @ledger/core. It contains no user data at
 *                   all; it is on a session procedure only so it is not an anonymous endpoint.
 */
const TWO_FACTOR_EXEMPT: ReadonlyMap<string, string> = new Map([
  ['me.current', 'session bootstrap — must be readable before 2FA enrolment'],
  ['me.currencies', 'static currency table, no user data'],
]);

/** Hardcoded so the allowlist cannot grow without somebody editing this number on purpose. */
const EXPECTED_EXEMPT_COUNT = 2;

// ── runtime introspection ──────────────────────────────────────────────────────────────

/**
 * tRPC does not publish `middlewares` on its procedure types — they are an implementation
 * detail — but they are present at runtime on both the builder and the built procedure. These
 * two shapes are the entire contract this suite depends on, declared here so a tRPC upgrade
 * that moves them fails as a type error rather than as a silently vacuous test.
 */
interface MiddlewareCarrier {
  readonly _def: { readonly middlewares?: readonly unknown[] };
}

interface ProcedureLike extends MiddlewareCarrier {
  readonly _def: {
    readonly middlewares?: readonly unknown[];
    readonly type?: string;
  };
}

function middlewaresOf(value: unknown): readonly unknown[] {
  const middlewares = (value as MiddlewareCarrier)._def.middlewares;
  if (middlewares === undefined) {
    throw new Error(
      'tRPC no longer exposes `_def.middlewares`. This suite cannot verify authorization ' +
        'without it — fix the introspection rather than deleting the assertion.',
    );
  }
  return middlewares;
}

/** True when `chain` begins with exactly the middleware functions of `builder`. */
function builtOn(chain: readonly unknown[], builder: unknown): boolean {
  const required = middlewaresOf(builder);
  if (chain.length < required.length) return false;
  return required.every((middleware, index) => chain[index] === middleware);
}

/**
 * `_def.procedures` is a flat record keyed by dotted path at runtime, even though its published
 * type describes the nested record. Casting is the only way to read it, and reading it is the
 * point of the suite.
 */
function allProcedures(): readonly (readonly [string, ProcedureLike])[] {
  const procedures = appRouter._def.procedures as unknown as Record<string, ProcedureLike>;
  return Object.entries(procedures).sort(([a], [b]) => (a < b ? -1 : 1));
}

// ── the suite ──────────────────────────────────────────────────────────────────────────

describe('every tRPC procedure is scoped to the caller', () => {
  it('finds the router at runtime', () => {
    const paths = allProcedures().map(([path]) => path);

    // A router that failed to load would produce an empty list and a suite that passes while
    // asserting nothing. These three are the load-bearing surfaces; if they are gone the
    // enumeration is broken, not the app.
    expect(paths.length).toBeGreaterThan(20);
    expect(paths).toContain('subscriptions.list');
    expect(paths).toContain('connections.list');
    expect(paths).toContain('cancellations.start');
  });

  it('builds every non-exempt procedure on protectedProcedure or sensitiveProcedure', () => {
    const offenders: string[] = [];

    for (const [path, procedure] of allProcedures()) {
      if (TWO_FACTOR_EXEMPT.has(path)) continue;
      if (!builtOn(middlewaresOf(procedure), protectedProcedure)) offenders.push(path);
    }

    // Named in the failure, because "expected 1 to be 0" tells the next person nothing.
    expect(offenders, `unprotected procedures: ${offenders.join(', ')}`).toEqual([]);
  });

  it('leaves nothing on the bare public procedure', () => {
    const anonymous: string[] = [];

    for (const [path, procedure] of allProcedures()) {
      const chain = middlewaresOf(procedure);
      // Everything, allowlisted or not, must at minimum prove there is a session.
      if (!builtOn(chain, sessionProcedure)) anonymous.push(path);
    }

    expect(anonymous, `anonymous procedures: ${anonymous.join(', ')}`).toEqual([]);
    // Sanity: `publicProcedure` really is a shorter chain than `sessionProcedure`, so the
    // assertion above is not trivially true.
    expect(middlewaresOf(publicProcedure).length).toBeLessThan(
      middlewaresOf(sessionProcedure).length,
    );
  });

  it('keeps the allowlist at its declared size', () => {
    expect(TWO_FACTOR_EXEMPT.size).toBe(EXPECTED_EXEMPT_COUNT);
  });

  it('justifies every allowlist entry, and every entry still exists', () => {
    const paths = new Set(allProcedures().map(([path]) => path));

    for (const [path, reason] of TWO_FACTOR_EXEMPT) {
      // A stale entry is as bad as a missing one: it silently exempts nothing while making the
      // list look longer than the real exposure.
      expect(paths.has(path), `${path} is allowlisted but no longer exists`).toBe(true);
      expect(reason.length, `${path} needs a justification`).toBeGreaterThan(10);
    }
  });

  it('still requires a session for the allowlisted procedures', () => {
    for (const [path, procedure] of allProcedures()) {
      if (!TWO_FACTOR_EXEMPT.has(path)) continue;
      expect(builtOn(middlewaresOf(procedure), sessionProcedure), path).toBe(true);
      // …and they are *not* protected, or they would not need to be on the list at all.
      expect(builtOn(middlewaresOf(procedure), protectedProcedure), path).toBe(false);
    }
  });

  it('puts the irreversible connection procedures behind a recent re-auth', () => {
    // Brief §9.2. Generic where it can be, specific where the brief names the actions: removing
    // a bank and opening a link session are on the re-auth list by name.
    const mustBeSensitive = ['connections.remove', 'connections.createLinkSession', 'connections.exchangeToken'];
    const procedures = new Map(allProcedures());

    for (const path of mustBeSensitive) {
      const procedure = procedures.get(path);
      expect(procedure, `${path} is missing`).toBeDefined();
      if (procedure === undefined) continue;
      expect(builtOn(middlewaresOf(procedure), sensitiveProcedure), path).toBe(true);
    }
  });

  it('declares a type for every procedure', () => {
    for (const [path, procedure] of allProcedures()) {
      expect(['query', 'mutation', 'subscription'], path).toContain(procedure._def.type);
    }
  });
});

// ── sealed connection secrets ──────────────────────────────────────────────────────────

const ROUTERS_DIR = fileURLToPath(new URL('./routers/', import.meta.url));

/**
 * Router sources with comment lines dropped.
 *
 * The names below are *supposed* to appear in prose — `connections.ts` opens by explaining that
 * they never leave the server, and that documentation is worth keeping. Only code is scanned.
 */
function routerSources(): readonly (readonly [string, string])[] {
  return readdirSync(ROUTERS_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => {
      const code = readFileSync(`${ROUTERS_DIR}${name}`, 'utf8')
        .split('\n')
        .filter((line) => {
          const trimmed = line.trimStart();
          return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
        })
        .join('\n');
      return [name, code] as const;
    });
}

/**
 * `access_token_ciphertext` and `key_id` never leave the server.
 *
 * This is a source-level check rather than a runtime one, deliberately. The selected columns of
 * a tRPC procedure live inside its resolver closure — they are constructed when the query runs,
 * not declared on `_def` — so there is nothing to introspect without executing the procedure
 * against a live database with a real session. Reading the router source is the only static
 * answer available, and a static answer that runs in CI beats a dynamic one that needs Postgres.
 */
describe('bank connection secrets never reach a response', () => {
  const FORBIDDEN = [
    'accessTokenCiphertext',
    'keyId',
    'access_token_ciphertext',
    'key_id',
  ] as const;

  it('never names the sealed columns in any router', () => {
    for (const [name, source] of routerSources()) {
      for (const identifier of FORBIDDEN) {
        expect(source, `${name} references ${identifier}`).not.toContain(identifier);
      }
    }
  });

  it('never reads or returns a whole bank_connections row', () => {
    // Not naming the columns is not enough: `.select()` and `.returning()` with no argument list
    // produce *every* column, which is how a sealed token leaks without anyone typing its name.
    // Column-less reads of other tables are fine and common, so this is scoped to the one table
    // that carries secrets.
    const wholeRowSelect = /\.select\(\s*\)[\s\S]{0,200}?\.from\(\s*bankConnections\s*\)/;
    const wholeRowReturning =
      /\.(?:delete|update|insert)\(\s*bankConnections\s*\)[\s\S]{0,600}?\.returning\(\s*\)/;

    for (const [name, source] of routerSources()) {
      expect(source, `${name} reads whole bank_connections rows`).not.toMatch(wholeRowSelect);
      expect(source, `${name} returns whole bank_connections rows`).not.toMatch(wholeRowReturning);
    }
  });

  it('is actually reading the routers it claims to check', () => {
    const sources = new Map(routerSources());

    // Guards against the checks above passing vacuously because a file moved or the comment
    // filter ate everything.
    expect(sources.get('connections.ts') ?? '').toContain('bankConnections');
    expect(sources.get('dashboard.ts') ?? '').toContain('bankConnections');
    expect([...sources.keys()].length).toBeGreaterThan(5);
  });
});
