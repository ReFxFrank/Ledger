# Ledger

**See every recurring charge you have, know what's coming out and when, and get a real,
followed-through path out of the ones you don't want.**

Ledger finds your subscriptions in your bank feed, tells you what's about to hit your card,
warns you before a free trial converts, and then walks you through cancelling — including the
part where it watches the feed afterwards and tells you, loudly, if they charged you anyway.

---

## What it does not do

Worth stating up front, because most products in this category are vague about it:

- **There is no "cancel" API.** Nothing Ledger can call cancels a Netflix account. Ledger does
  not log into anything as you, does not store your passwords for other services, and does not
  drive a browser against provider account pages.
- What it does instead is route you to the *correct* exit path — which for an App Store–billed
  subscription is Apple's settings, not the provider's website — hand you the exact steps
  including the dark patterns, generate the letter or email if that's what's required, compute
  your cancel-by deadline, chase you if you don't finish, and then verify from the bank feed
  that the charge actually stopped.
- No bill negotiation, no budgeting, no virtual cards, no contacting merchants on your behalf.

## Quick start (5 minutes)

**Prerequisites:** Node ≥ 22, pnpm 9, Docker.

```bash
git clone <this repo> ledger && cd ledger
cp .env.example .env
```

Fill in the two secrets the app refuses to boot without:

```bash
node -e "console.log('BETTER_AUTH_SECRET=' + require('crypto').randomBytes(48).toString('base64'))"
node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
```

Then:

```bash
pnpm install
docker compose up -d
pnpm db:migrate
pnpm seed:demo
pnpm dev
```

Open http://localhost:3000. The demo user is printed by `seed:demo`, along with its TOTP
secret so you can get past 2FA.

`AGGREGATOR=fixture` is the default: the whole bank-connection flow works locally against
`packages/banking/fixtures` with no Plaid credentials and no network. Set `AGGREGATOR=plaid`
plus your sandbox keys when you want the real thing.

### If pnpm isn't installed

```bash
npm install -g pnpm@9.15.4
```

`corepack enable` is the usual advice, but on Windows installs where Node lives under
`C:\Program Files` it fails with `EPERM` unless the shell is elevated.

## Layout

```
apps/web         Next.js 15 App Router — every screen, plus the tRPC route handler
apps/worker      BullMQ worker — bank sync, notification scheduler + sender, cancel verification
packages/core    money, currency, Clock, calendar-aware date math. Zero runtime dependencies.
packages/logger  pino. The only sanctioned way to write to stdout.
packages/crypto  AES-256-GCM envelope encryption + key rotation. The only module that sees keys.
packages/db      Drizzle schema, migrations, subscription state machine, scoped queries
packages/ui      design tokens + component primitives
packages/detection  transactions in → subscription candidates out. Pure, offline, no IO.
packages/providers  merchant registry + per-channel cancellation playbooks (YAML, CI-validated)
packages/banking    AggregatorAdapter + Plaid and Fixture implementations + sync
packages/notify     scheduler, channels, email templates
```

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Web + worker, watch mode |
| `pnpm verify` | typecheck → lint → test → build. What CI runs. |
| `pnpm test` | Unit and integration (Testcontainers spins up real Postgres) |
| `pnpm test:e2e` | Playwright |
| `pnpm db:generate` | Generate a migration from schema changes |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:drift` | Fail if the schema and migrations have diverged |
| `pnpm seed:demo` | A realistic demo user: 20 subscriptions, 3 currencies, an annual, a trial, a price increase, a duplicate |
| `pnpm keys:rotate` | Re-encrypt every sealed record under a new KEK, online |
| `pnpm providers:audit` | List playbooks not verified in the last 180 days |

## Security posture

- TOTP 2FA is **mandatory**, not optional. This app is a map of your financial life.
- Bank access tokens are sealed with per-record data keys under a KEK from `ENCRYPTION_KEY`
  (or KMS). A raw `psql` dump shows ciphertext.
- No card numbers. Ever. Ledger stores a brand and last-4 for labelling and nothing else.
- Every user-scoped query goes through one helper, and an integration suite enumerates the
  tRPC router at runtime and asserts every procedure rejects a foreign user id.
- Full data export (JSON + CSV) and a delete that actually cascades and revokes the upstream
  aggregator item.

## Docs

- [`docs/PLAN.md`](docs/PLAN.md) — execution plan and package dependency graph
- [`docs/PROGRESS.md`](docs/PROGRESS.md) — per-phase log and the open-decisions register
- [`docs/legal-notes.md`](docs/legal-notes.md) — why no UI copy makes a legal claim
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — deploy, rollback, key rotation, sync triage

## License

TBD.
