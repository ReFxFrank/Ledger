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
