# Ledger — Execution Plan

> Written before any implementation code, per brief §0.1. This is the task decomposition I
> am actually working to. Phases are ordered by the dependency graph, not by how interesting
> they are. Where the brief left a fork open, the choice I made is recorded in
> `PROGRESS.md → Open decisions`, not here.

## 0. Shape of the thing

```
Ledger/
├── apps/
│   ├── web/                 Next.js 15 App Router + tRPC route handler + all screens
│   └── worker/              BullMQ worker process (sync, scheduler, sender, verify)
├── packages/
│   ├── core/                money, currency, Clock, date math, ids, errors, result
│   ├── logger/              pino wrapper; the only sanctioned way to write to stdout
│   ├── crypto/              AES-256-GCM envelope encryption + key rotation
│   ├── db/                  Drizzle schema, migrations, state machine, scoped queries
│   ├── ui/                  tokens.css + design-system primitives (shadcn, extended)
│   ├── detection/           PURE. transactions in → candidates out. No IO. (workstream A)
│   ├── providers/           merchant registry + cancellation playbooks + validator (B)
│   ├── banking/             AggregatorAdapter, PlaidAdapter, FixtureAdapter, sync (D)
│   └── notify/              scheduler, channels, react-email templates (E)
├── docs/
└── test/                    cross-package fixtures + e2e
```

**Contract layer** = `core` + `db` + `ui/tokens.css` + the tRPC router *signatures*.
Built serially, frozen, then everything else fans out against it.

### Why these package boundaries

- `detection` is pure and dependency-free because it is the single highest-value, highest-risk
  piece of logic in the product. Pure means it is exhaustively testable against fixtures with no
  database, and means a bad detection bug can be reproduced from a JSON file.
- `crypto` is its own package so the rule "tokens never appear in plaintext outside this module"
  is enforceable by an import lint rule rather than by discipline.
- `core` owns every arithmetic operation on money and every date projection. Nothing else is
  allowed to do either. This is how "no float ever touches a monetary value" stays true.

## 1. Package build order (hard dependency edges)

```
core ──┬─→ db ──┬─→ banking ──→ worker
       │        ├─→ notify  ──→ worker
       │        └─→ web
       ├─→ detection ──→ banking
       ├─→ providers ──→ web, worker
       ├─→ crypto ──→ db, banking
       └─→ logger ──→ everything
ui ──→ web
```

`detection` depends on `core` only for money/date primitives, and `core` has zero runtime
dependencies, so the "zero runtime dependencies" acceptance criterion for detection holds
transitively. Enforced by an ESLint `no-restricted-imports` boundary + a package-level test.

## 2. Phase plan

Each phase = one branch, merged to `main` when `pnpm verify` (typecheck + lint + test + build)
is green. Conventional Commits per logical unit.

### Phase 0 — Foundation *(serial, me)*
1. pnpm workspace + Turborepo pipeline with correct `dependsOn` and cache outputs.
2. `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
   `noImplicitOverride`, `verbatimModuleSyntax`.
3. ESLint flat config: typescript-eslint strict-type-checked, `eslint-plugin-drizzle`,
   plus the local guardrails — no `any`, no `@ts-ignore`, no `console`, no cross-package
   deep imports, no node builtins inside `packages/detection`.
4. Docker Compose: postgres:16, redis:7, minio, caddy. Named volumes, healthchecks,
   the web/worker services wired but only enabled in the prod compose overlay.
5. `.env.example` — every variable, commented, with the ones that are required to boot
   marked as such. `packages/core/src/env.ts` parses it with zod and fails loudly at boot.
6. CI: typecheck, lint, unit (Testcontainers Postgres), build, migration-drift, client-bundle
   secret grep.
7. README with a 5-minute path from clone to a running page.

**Done when:** `pnpm i && docker compose up -d && pnpm dev` serves a page that has read a row
from Postgres. CI green.

### Phase 1 — Schema & contracts *(serial, me — FREEZE POINT)*
1. `packages/core`: `Money` (minor units, branded), `Currency`, `Clock` interface +
   `SystemClock`/`FixedClock`, calendar-monthly date projection with month-end clamping,
   `Interval` type, FX conversion, error taxonomy, id generation.
   Property tests (fast-check) land here, not later — the money invariants are the foundation.
2. `packages/db`: every table in §5, enums, indexes (incl. `pg_trgm` GIN), relations.
3. `packages/db/src/state/subscription.ts`: the status state machine. Transition table as data,
   guard functions, exhaustive tests → 100% branch coverage.
4. `packages/db/src/scope.ts`: `scoped(db, userId)` — the *only* sanctioned way to read
   user-owned rows. Everything else is a lint error.
5. `packages/ui/tokens.css` + Tailwind v4 `@theme` mapping + typography setup with
   `tabular-nums` applied globally to numerals.
6. `pnpm seed:demo`.

**Freeze.** After this, schema changes are serial-only and go through me.

### Phase 2 — Auth & security baseline *(serial-ish, me)*
better-auth (email+password, passkey, mandatory TOTP), session list/revoke, re-auth gate for
sensitive actions, `packages/crypto` envelope encryption + `keys:rotate`, audit log writer,
rate limiter (Redis token bucket), CSP with nonces + HSTS + frame-deny.
The cross-user access test harness is built here and is *generic*: it enumerates the tRPC
router at runtime and asserts every user-scoped procedure rejects a foreign id. New procedures
added in later phases are covered automatically or they fail the suite.

### Phase 3 — Manual subscriptions & app shell *(workstream C opens)*
App shell, command-palette-ready nav, subscriptions table (TanStack + virtualization),
CRUD, detail page, categories/tags, payment methods, multi-currency totals, renewal
projection, CSV import with column mapping. Full product value with zero bank connection.

### Phase 4 — Detection engine *(workstream A)*
Normalization → clustering → cadence → confidence, then each §4.4 case as a named test.
Fixtures first: the 300-descriptor file and the 24-month synthetic transaction generator are
written *before* the algorithm, and they are the spec.

### Phase 5 — Bank connection & sync *(workstream D)*
Adapter interface, Plaid + Fixture implementations, Link flow, webhook handler with replay
safety, cursor sync with resumability, backfill, reconciliation into `detections`,
`/review` queue, connection health and consent expiry.

### Phase 6 — Renewal intelligence & notifications *(workstream E + C)*
Billing Horizon (visx), calendar, attention queue, trial/price/duplicate detectors wired to
the scheduler, notification materialization with `dedupe_key`, email/push/in-app senders,
preferences, quiet hours, weekly digest. All scheduling tests run on a `FixedClock`.

### Phase 7 — Cancellation engine *(workstream B feeds it)*
The provider dataset (120+ YAML entries, schema-validated in CI), channel routing, the guided
workflow, letter generation, deadline math, evidence upload to S3, **post-cancellation charge
verification**, reclaimed-savings counter.
Order within the phase: routing → workflow → deadlines → evidence → verification. Verification
last because it depends on all of them, but it is the reason the phase exists.

### Phase 8 — Analytics
Every figure derives from one shared aggregation module that the subscriptions table also uses,
so "the numbers reconcile" is structural rather than a coincidence I then test for.

### Phase 9 — Polish
Onboarding, states, optimistic updates, ⌘K, PWA, a11y and Lighthouse passes, motion pass.

### Phase 10 — Hardening & ship
Backup/restore, export/delete, runbook, threat model, 50k-transaction load test, Sentry,
production compose + Caddy TLS.

## 3. Fan-out protocol

Sub-agents are spawned per workstream, one per directory, with these standing rules:

- You own exactly one directory. You do not edit `packages/db/src/schema/**` or
  `packages/ui/tokens.css`. If you need a schema change, stop and report it.
- You import from `@ledger/core` and `@ledger/db` types only — never reach into another
  workstream's internals.
- You ship with your own tests green. "Green" means the package's own `pnpm test`, not mine.
- No `any`, no `@ts-ignore`, no `console.log`, no `.only`, no `.skip`.

Integration happens on `main` after each workstream is green, serially, by me.

## 4. Risk register

| Risk | Mitigation |
|---|---|
| Detection quality is the product; a subtle cadence bug is invisible | Golden-file test over synthetic 24-month data with planted subscriptions; recall/FP measured as a number, not a vibe |
| Calendar-monthly ≠ 30 days; getting this wrong breaks every projection | Date math isolated in `core`, 100% covered, month-end clamping tested against Feb/leap years explicitly |
| Playbook dataset rots and starts lying to users | `last_verified_at` mandatory, `providers:audit` surfaces staleness, UI shows the verification date |
| Cross-user data leak | Generic runtime-enumerated authz suite; new procedures are covered by default |
| Token leak via logs | `crypto` package boundary + pino redaction list + no raw token ever crosses a package boundary |
| "Cancel" implying automation we don't do | Copy review pass in Phase 7; the workflow UI always names who performs each step |

## 5. Definition of done (restated as a test list)

The §13 paragraph maps to these executable checks:

1. `e2e/auth.spec.ts` — sign up → forced TOTP → session listed.
2. `e2e/connect-review.spec.ts` — fixture bank → 12 planted subs found → confirm from review.
3. `e2e/horizon.spec.ts` — next 14 days of charges render with correct totals.
4. `notify/trial.test.ts` — alert fires exactly 3 days before conversion on a frozen clock.
5. `e2e/cancel.spec.ts` — start cancellation → correct routed method → checklist → evidence.
6. `notify/followup.test.ts` — unresolved request nags on schedule.
7. `cancel/verify.test.ts` — expected charge absent → `canceled`, user told.
8. `cancel/verify.test.ts` — expected charge present → `charged_after_cancellation`, loud.
