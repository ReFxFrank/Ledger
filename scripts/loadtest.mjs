/**
 * `pnpm loadtest` — the Phase 10 acceptance measurement.
 *
 * The criterion is "/subscriptions p95 < 300ms with 50k transactions and 200 subscriptions", and
 * the only honest way to check it is to call the procedures the screen actually calls, over HTTP,
 * with a real session. So this does exactly that:
 *
 *  - Signs in as the load user `packages/db/src/cli/loadtest-seed.ts` created, including the
 *    mandatory TOTP step. A harness that skipped 2FA would be measuring a code path the product
 *    does not have.
 *  - Issues each procedure N times against the running server and records wall-clock latency per
 *    call, from just before `fetch` to after the body is fully read. Time-to-last-byte, not
 *    time-to-first: a procedure that streams its first byte quickly and then spends 400ms
 *    serialising 200 rows is slow, and the user experiences it as slow.
 *  - Reports p50/p95/p99 per procedure and exits non-zero if any of them misses its budget, so it
 *    can be a CI gate rather than a number somebody reads.
 *
 * Deliberately *serial* by default. The acceptance criterion is about the cost of the query, not
 * about concurrency behaviour, and interleaving requests would fold connection-pool contention
 * into a number that is supposed to be about a query plan. `--concurrency=N` exists for when the
 * question is the other one.
 *
 * Warm-up iterations are discarded. Next compiles a route on first request in dev and Postgres
 * has to fill its cache; including either in a p95 measures the first request, repeatedly.
 *
 * Usage:
 *   pnpm loadtest
 *   pnpm loadtest -- --iterations=60 --base=http://localhost:3000 --json=out.json
 *   pnpm loadtest -- --concurrency=8
 */

import { createHash, createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';

// ── configuration ──────────────────────────────────────────────────────────────────────

/** Must match `LOAD_EMAIL` / `LOAD_PASSWORD` in packages/db/src/cli/loadtest-seed.ts. */
const LOAD_EMAIL = 'loadtest@ledger.local';
const LOAD_PASSWORD = 'loadtest-ledger-2026';

/**
 * The budget, in milliseconds, per procedure.
 *
 * 300ms is the brief's number and it applies to the /subscriptions screen, which is
 * `subscriptions.list` plus the three dashboard procedures it renders alongside. The analytics
 * procedures are held to the same bar because they are on a screen a user navigates to and waits
 * for; `spendOverTime` is the only one that reads the 50k-row table and gets the same budget on
 * purpose — if it needs a looser one, that is a finding, not a configuration.
 */
const BUDGET_MS = 300;

const PROCEDURES = [
  { path: 'subscriptions.list', input: { limit: 200, sort: 'nextRenewal', direction: 'asc' } },
  { path: 'dashboard.horizon', input: { days: 60 } },
  { path: 'dashboard.totals', input: undefined },
  { path: 'dashboard.attention', input: undefined },
  { path: 'analytics.spendByCategory', input: undefined },
  // Not named in the acceptance criterion, but it is the only procedure on a user-facing screen
  // that reads `transactions`, so leaving it out would mean the 50,000 rows were never measured.
  { path: 'analytics.spendOverTime', input: { months: 12, subscriptionsOnly: false } },
];

// ── argument parsing ───────────────────────────────────────────────────────────────────

function flag(name, fallback) {
  const found = process.argv.slice(2).find((argument) => argument.startsWith(`--${name}=`));
  return found === undefined ? fallback : found.slice(name.length + 3);
}

const BASE_URL = flag('base', process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const ITERATIONS = Number(flag('iterations', '40'));
const WARMUP = Number(flag('warmup', '5'));
const CONCURRENCY = Math.max(1, Number(flag('concurrency', '1')));
const JSON_OUT = flag('json', null);

// ── TOTP ───────────────────────────────────────────────────────────────────────────────

/**
 * RFC 6238, thirty lines of HMAC.
 *
 * A copy of `apps/web/e2e/support/totp.ts` rather than an import: that file is TypeScript inside
 * the web app's project, and this is a plain `.mjs` run by `node` with no build step in front of
 * it. The e2e copy has the RFC's published test vectors asserted against it, so the algorithm is
 * verified there; if this one were wrong, sign-in below would fail immediately and loudly.
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input) {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const output = [];
  for (const character of clean) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new Error(`Not a base32 character: ${character}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function generateTotp(secretBase32, forSeconds = Math.floor(Date.now() / 1000)) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(forSeconds / 30)));
  const digest = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

/**
 * The load user's TOTP secret, derived exactly as `packages/db/src/seed/credentials.ts` derives
 * it — SHA-256 rejection sampling over better-auth's alphabet, then base32 of the ASCII bytes.
 *
 * Derived rather than passed on the command line so the harness cannot drift out of step with
 * the seed: change the seed's email and this follows, or fails at sign-in rather than silently
 * measuring a different user.
 */
function loadUserTotpSecret(email) {
  const SECRET_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  // Rejection sampling, not a modulus: the seed's derivation does the same, and a different
  // sampling rule here would produce a different secret and an unexplainable "invalid code".
  const limit = Math.floor(256 / SECRET_ALPHABET.length) * SECRET_ALPHABET.length;

  let secret = '';
  let counter = 0;
  while (secret.length < 32) {
    const block = createHash('sha256').update(`totp:${email}#${counter}`).digest();
    for (const byte of block) {
      if (secret.length >= 32) break;
      if (byte >= limit) continue;
      secret += SECRET_ALPHABET[byte % SECRET_ALPHABET.length];
    }
    counter += 1;
  }

  // Base32 of the secret's ASCII bytes, unpadded — the encoding an `otpauth://` URI carries.
  const bytes = Buffer.from(secret, 'utf8');
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

// ── a cookie jar ───────────────────────────────────────────────────────────────────────

/**
 * The smallest thing that can hold better-auth's cookies across requests.
 *
 * `fetch` has no jar. better-auth issues a session cookie on sign-in and a *second*, short-lived
 * one for the pending-2FA state, and both have to be echoed back on the next request or the TOTP
 * step has nothing to verify against.
 */
class CookieJar {
  #jar = new Map();

  absorb(response) {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      if (index === -1) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      // An expiry in the past is a deletion; keeping it would send a dead session forever.
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line)) this.#jar.delete(name);
      else this.#jar.set(name, value);
    }
  }

  header() {
    return [...this.#jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

// ── sign-in ────────────────────────────────────────────────────────────────────────────

async function authPost(jar, path, body) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // better-auth refuses cross-origin POSTs; the Origin has to be the server's own.
      Origin: BASE_URL,
      cookie: jar.header(),
    },
    body: JSON.stringify(body),
  });
  jar.absorb(response);
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} responded ${response.status}: ${text.slice(0, 400)}`);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function signIn(jar) {
  const secret = loadUserTotpSecret(LOAD_EMAIL);

  await authPost(jar, '/api/auth/sign-in/email', { email: LOAD_EMAIL, password: LOAD_PASSWORD });

  // A code typed with half a second left on the 30-second window fails intermittently and looks
  // like a broken harness. Waiting out the rollover costs at most three seconds, once.
  const remaining = 30 - (Math.floor(Date.now() / 1000) % 30);
  if (remaining < 4) await new Promise((resolve) => setTimeout(resolve, (remaining + 1) * 1000));

  await authPost(jar, '/api/auth/two-factor/verify-totp', { code: generateTotp(secret) });
}

// ── the measurement ────────────────────────────────────────────────────────────────────

function trpcUrl(path, input) {
  const url = new URL(`${BASE_URL}/api/trpc/${path}`);
  // superjson on the wire, matching the client transformer. `undefined` input is an absent
  // `input` parameter, not `input={}` — tRPC treats those differently for optional inputs.
  if (input !== undefined) url.searchParams.set('input', JSON.stringify({ json: input }));
  return url.toString();
}

async function callOnce(jar, procedure) {
  const started = performance.now();
  const response = await fetch(trpcUrl(procedure.path, procedure.input), {
    headers: { cookie: jar.header(), 'content-type': 'application/json' },
  });
  const text = await response.text();
  const durationMs = performance.now() - started;

  if (!response.ok) {
    throw new Error(`${procedure.path} responded ${response.status}: ${text.slice(0, 400)}`);
  }
  // A tRPC error is a 200 with an `error` member. Measuring the latency of an error response and
  // calling it a p95 is the classic way a load test reports a green number for a broken screen.
  const parsed = JSON.parse(text);
  if (parsed?.error !== undefined) {
    throw new Error(`${procedure.path} returned a tRPC error: ${JSON.stringify(parsed.error).slice(0, 400)}`);
  }

  return { durationMs, bytes: text.length };
}

/**
 * Nearest-rank percentile on the sorted sample.
 *
 * Not interpolated: with 40 samples an interpolated p95 invents a number that was never measured,
 * and for a latency budget the honest answer is "the 38th slowest call took this long".
 */
function percentile(sortedMs, fraction) {
  if (sortedMs.length === 0) return Number.NaN;
  const rank = Math.max(1, Math.ceil(fraction * sortedMs.length));
  return sortedMs[rank - 1];
}

async function measure(jar, procedure) {
  for (let index = 0; index < WARMUP; index += 1) await callOnce(jar, procedure);

  const samples = [];
  let bytes = 0;

  if (CONCURRENCY === 1) {
    for (let index = 0; index < ITERATIONS; index += 1) {
      const result = await callOnce(jar, procedure);
      samples.push(result.durationMs);
      bytes = result.bytes;
    }
  } else {
    let issued = 0;
    const worker = async () => {
      for (;;) {
        if (issued >= ITERATIONS) return;
        issued += 1;
        const result = await callOnce(jar, procedure);
        samples.push(result.durationMs);
        bytes = result.bytes;
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  const sorted = [...samples].sort((a, b) => a - b);
  return {
    path: procedure.path,
    n: sorted.length,
    responseBytes: bytes,
    minMs: sorted[0],
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1],
    meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
  };
}

// ── reporting ──────────────────────────────────────────────────────────────────────────

function ms(value) {
  return value.toFixed(1).padStart(8);
}

function report(results) {
  const rule = '─'.repeat(88);
  console.log(`\n${rule}`);
  console.log(
    `  procedure`.padEnd(34) +
      'n'.padStart(5) +
      'p50'.padStart(9) +
      'p95'.padStart(9) +
      'p99'.padStart(9) +
      'max'.padStart(9) +
      'bytes'.padStart(10) +
      '   ',
  );
  console.log(rule);

  let failed = 0;
  for (const result of results) {
    const over = result.p95Ms > BUDGET_MS;
    if (over) failed += 1;
    console.log(
      `  ${result.path}`.padEnd(34) +
        String(result.n).padStart(5) +
        ms(result.p50Ms) +
        ms(result.p95Ms) +
        ms(result.p99Ms) +
        ms(result.maxMs) +
        String(result.responseBytes).padStart(10) +
        (over ? '  OVER' : '  ok'),
    );
  }

  console.log(rule);
  console.log(
    `  budget ${BUDGET_MS}ms p95 · ${ITERATIONS} iterations after ${WARMUP} warm-up · ` +
      `concurrency ${CONCURRENCY} · ${BASE_URL}`,
  );
  console.log(`${rule}\n`);
  return failed;
}

// ── entrypoint ─────────────────────────────────────────────────────────────────────────

async function main() {
  const health = await fetch(`${BASE_URL}/api/health`).catch(() => null);
  if (health === null || !health.ok) {
    console.error(
      `No healthy server at ${BASE_URL}. Start one with \`pnpm --filter @ledger/web dev\` ` +
        '(or `build` + `start` for production-shaped numbers) and try again.',
    );
    process.exit(1);
  }

  const jar = new CookieJar();
  await signIn(jar);

  // Prove the session is the load user's before measuring anything. Measuring a signed-out
  // session would report a very fast p95 for a screen that renders nothing.
  const sanity = await callOnce(jar, { path: 'subscriptions.list', input: { limit: 500 } });
  console.log(`Signed in as ${LOAD_EMAIL} · first call ${sanity.durationMs.toFixed(0)}ms`);

  const results = [];
  for (const procedure of PROCEDURES) {
    process.stdout.write(`  measuring ${procedure.path}…\r`);
    results.push(await measure(jar, procedure));
  }

  const failed = report(results);

  if (JSON_OUT !== null) {
    writeFileSync(
      JSON_OUT,
      `${JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          baseUrl: BASE_URL,
          iterations: ITERATIONS,
          warmup: WARMUP,
          concurrency: CONCURRENCY,
          budgetMs: BUDGET_MS,
          node: process.version,
          results,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`  wrote ${JSON_OUT}`);
  }

  if (failed > 0) {
    console.error(`${failed} procedure(s) over the ${BUDGET_MS}ms p95 budget.`);
    process.exit(1);
  }
}

await main();
