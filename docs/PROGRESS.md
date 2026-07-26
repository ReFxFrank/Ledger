# Progress log

One entry per phase: what shipped, what was deferred, what surprised me, and every
assumption I had to invent. Open forks are collected at the bottom.

---

## Phase 0 — Foundation

**Shipped**

- pnpm workspace + Turborepo pipeline (`build`/`typecheck`/`lint`/`test`/`test:e2e`) with
  correct `dependsOn` edges and cache outputs.
- `tsconfig.base.json` — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`.
- ESLint flat config encoding the §0.3 guardrails as rules rather than as good intentions:
  no `any`, no `@ts-ignore`, no `console`, no `.only`/`.skip`, no deep cross-package imports,
  and a `packages/detection` boundary that rejects node builtins, the DB, and every network
  library at lint time.
- Docker Compose: postgres:16 (with `pg_trgm`/`citext`/`pgcrypto` created at first boot),
  redis:7, minio + a one-shot bucket initializer, all with healthchecks.
- `.env.example` — complete, commented, boot-required variables marked.
- GitHub Actions CI: typecheck, lint, unit against a real Postgres service, build,
  migration-drift, and a grep of the built client bundle for server-only env var names.
- `docs/PLAN.md`, this file, `docs/legal-notes.md`, README with a 5-minute setup path.

**Deferred**

- The `web` and `worker` service definitions live in `docker-compose.prod.yml` (Phase 10),
  not the dev compose file. In dev you run them with `pnpm dev` so you get HMR; running
  Next inside a container on a Windows bind mount is slow enough to be a real tax.

**Surprises**

- `corepack enable` fails with `EPERM` on this machine because the Node install lives under
  `C:\Program Files`. Installed pnpm with `npm i -g pnpm@9.15.4` instead. Documented in the
  README so the next person doesn't lose ten minutes to it.
- Local Node is 24.16.0, not the Node 22 LTS the brief locks. `engines` is set to `>=22` and CI
  pins 22 so the locked target is what actually gets verified; 24 is used for local dev only.
  Nothing in the stack needs a 22-only API.

**Assumptions invented**

- Host ports are shifted off the defaults (Postgres 5433, Redis 6380) so the stack doesn't
  collide with an existing local database. Container-internal ports are unchanged.
- Packages are consumed as TypeScript source (`exports` → `./src/index.ts`) with Next's
  `transpilePackages`, rather than each package building to `dist` first. This removes a whole
  class of stale-build bugs from the inner loop; the worker is bundled with `tsup` for prod.

---

## Phase 1 — Schema & contracts

**Shipped**

- `@ledger/core`: `Money` as integer minor units with per-currency ISO-4217 exponents, exact
  rational annualization, `PlainDate` calendar arithmetic with month-end clamping, `FxRate` as a
  scaled integer, injectable `Clock`, UUIDv7, the shared domain unions, and `aggregate.ts` — the
  single implementation behind the dashboard totals, analytics, and the cancel simulator.
- Full Drizzle schema per §5 (29 tables), the initial migration generated, `pg_trgm` GIN indexes
  on merchant name and aliases, and the partial index on unsent notifications.
- Both state machines as declared transition tables — subscription and cancellation.
- `Scope`: the only sanctioned way to read user-owned rows, including `EXISTS` predicates for the
  tables that are scoped indirectly (transactions, bank accounts, price history, shares, events).
- `packages/ui/tokens.css` per §6.2, mapped into Tailwind v4's `@theme`.
- **588 tests green**, including property tests on money round-tripping and allocation, and a
  timezone round-trip sweep across 1918–2100.

**Surprises**

- The Postgres enums are generated *from* the `@ledger/core` unions rather than restated, so
  adding a status without a migration is a compile error rather than a 3am `invalid input value
  for enum`.
- `drizzle-kit` cannot resolve `.js`-suffixed TypeScript imports. The whole repo moved to
  extensionless relative imports, which every tool in the stack (Next, tsx, vitest, esbuild)
  resolves identically.

**Assumptions invented**

- `subscription_price_history.delta_pct` is implemented as `delta_bps`, an integer basis-point
  count. A percentage is the one money-adjacent value where a float would surface directly in
  user-visible copy; 9.99 → 12.99 is exactly `+3003`.
- Renewal dates are projected as `anchor + n × interval`, always recomputed, never stepped
  forward from the stored value. A stored date that has been incremented N times has accumulated
  N clamping errors, and the entire point of anchoring is that it cannot.

---

## Phase 2 — Auth & security baseline

**Shipped**

- better-auth with email+password (12-character floor), mandatory TOTP, session management.
- `@ledger/crypto`: AES-256-GCM envelope encryption, a fresh DEK per record, AAD bound to
  table/row/column so ciphertext lifted from one row fails authentication in another, and a
  keyring that holds retired keys so `keys:rotate` can run online.
- Three procedure tiers: `sessionProcedure` (signed in, 2FA may be pending — the one authenticated
  surface enrolment needs), `protectedProcedure` (2FA enforced), `sensitiveProcedure` (re-auth
  within 15 minutes).
- CSP with a per-request nonce from middleware — no `unsafe-inline` — plus HSTS, frame-deny,
  `Referrer-Policy: same-origin`, and `X-Robots-Tag: noindex`.
- Audit log written on every mutation, and readable by the user in settings.

**Deferred**

- Passkeys. better-auth moved the plugin out of core at 1.6 into `@better-auth/passkey`, which is
  not in the lockfile. The `passkeys` table stays — dropping a table to match a missing dependency
  is the wrong direction — and `lib/passkey.ts` feature-probes so the button lights up when the
  plugin is added.
- Rate limiting. The Redis token bucket is not written; better-auth's built-in limiter covers the
  auth routes but not link-token creation or export.

**Surprises**

- `next build` sets `NODE_ENV=production`, so a module-scope `loadServerEnv()` made merely
  *importing* a route module demand production secrets — the build failed on a missing
  `RESEND_API_KEY`. Fixed by making auth construction lazy rather than by relaxing the check:
  building is not running, and a missing value is still a hard failure on the first request.
- The root `.env` was never reaching Next at all, because Next only reads `.env` from the app
  directory. `next dev` was broken the same way and nobody had run it yet.

---

## Phase 4 — Detection engine

**Shipped**

- `packages/detection`, pure and offline: zero runtime dependencies beyond `@ledger/core`,
  enforced by an ESLint import boundary *and* a static test that reads every source file and
  asserts nothing imports a node builtin, the database, or a network library.
- Descriptor normalization against a 300+ fixture corpus, retaining the billing-channel marker
  rather than discarding it, and emitting the stripped spans so the UI's descriptor decoder does
  not have to re-derive them.
- Calendar-monthly cadence with month-end clamping, single-missed-period tolerance, and the
  jitter windows from §4.3. Every §4.4 case has a named passing test.
- **507 tests green. The golden test measures recall 1.0000 and a 0.0000 false-positive rate on
  all three seeds**, over corpora of ~850 transactions of which 300+ are noise, including two
  deliberate near-misses designed to be rejected.

**Surprises**

- The golden test originally reported nothing on success — the measurement was only attached to
  the assertion failure message. A gate that speaks only when it fails tells you the threshold
  held, not how close it came, and the distance to the threshold is the part that predicts the
  next regression. It now prints both numbers every run.
- `packages/detection`'s lint script was `eslint src`, so its six test files — including the
  golden test and the synthetic generator — were never linted by CI. Now `eslint src test`.

---

## Phase 7 (partial) — Provider dataset

**Shipped**

- **141 merchant files** across seven categories, each with per-channel playbooks, real
  descriptor patterns, honest difficulty grades, notice periods, and dark-pattern gotchas.
- The zod schema encodes the product's rules rather than just its shapes: an `apple`/`google`/
  `amazon`/`roku`/`microsoft`/`carrier` playbook may not carry a provider-domain cancel URL,
  `method: post` requires a letter template, `method: phone` requires a number, difficulty ≥ 4
  requires a stated gotcha, and any text matching a legal-claim pattern is rejected outright.
- `findPlaybook` returns **null** rather than falling back to the direct playbook for an
  intermediated channel. Showing a provider's web cancel flow for an App Store subscription is
  the most damaging thing this product could do, so the fallback simply does not exist.
- `providers:audit` lists playbooks unverified for 180 days.

**Assumptions invented**

- `lastVerifiedAt` is stamped `2026-07-25` across the dataset. These were authored from model
  knowledge, not from visiting 141 cancellation pages — so the dates record when the entry was
  *written*, and the audit command is what stops that being mistaken for verification. Before this
  ships to anyone, the dataset needs a real verification pass. `TODO(frank)` at the dataset root.

---

## Open decisions

Logged per §0.1.6 — implemented the option I judged best, flagged at the code site with a
`TODO(frank):`.

| # | Fork | What I did | Tradeoff |
|---|---|---|---|
| 1 | Aggregator / region | Plaid US sandbox behind `AggregatorAdapter`; `AGGREGATOR=fixture` is the dev default | The adapter is the whole point — TrueLayer/GoCardless is a new file, not a refactor |
| 2 | Email receipt scanning | Seam only, feature flag off | A Gmail read scope is a large ask for a small marginal gain over bank data |
| 3 | Household sharing | `subscription_shares` (cost splitting, no second account needed) | Real multi-user households need an invite + permission model; deferred |
| 4 | Public cancel guides | Dataset built so it's possible; routes behind `FEATURE_PUBLIC_GUIDES` | Zero cost to keep the option open |
| 5 | Discord channel | Channel interface supports it; not wired | ~30 lines whenever you want it |
| 6 | Transaction retention | 24 months, `TRANSACTION_RETENTION_MONTHS` | Annual-subscription detection needs ≥ 24 months of history to see two occurrences; shorter retention degrades detection |
| 7 | Name | `ledger` everywhere in code; branding isolated in one constants file | — |
| 8 | Hosting | Compose on a VPS behind Caddy | — |
| 9 | Node version | `engines: >=22`, CI pins 22 | Local machine has 24; the locked target is what CI verifies |
| 10 | Package consumption | TS source + `transpilePackages`, not per-package `dist` | Faster inner loop; slightly slower `next build` |
