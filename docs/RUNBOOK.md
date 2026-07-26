# Runbook

Operating Ledger. Written for the person on call at 2am, so it leads with the thing that is
probably broken rather than with an architecture diagram.

---

## Triage: what is broken?

| Symptom | Start here |
|---|---|
| App returns 500 on every page | [Boot failures](#boot-failures) |
| A user's bank data has stopped updating | [Sync failure](#sync-failure-triage) |
| Notifications stopped | [The scheduler and the sender](#notifications-stopped) |
| A user was told the same thing twice | [Dedupe](#a-user-was-notified-twice) |
| A user was charged after Ledger said they cancelled | [The loudest bug](#a-charge-landed-after-a-verified-cancellation) |
| Everything is slow | [Performance](#performance) |

---

## Deploy

```bash
git pull
pnpm install --frozen-lockfile
pnpm db:migrate
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Migrations run **before** the new code starts. That ordering is deliberate and it constrains what
a migration may contain: every schema change must be backwards-compatible with the currently
running version, because for the duration of the deploy both are live against the same database.
Adding a nullable column is fine. Dropping or renaming one is a two-deploy operation — add the
new, backfill, ship code that reads the new, then drop the old in a later release.

### Rollback

```bash
git checkout <previous-tag>
pnpm install --frozen-lockfile
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

**Do not roll migrations back.** `drizzle-kit` can generate a down migration, but running one
against a database the new code has already written to is how you lose rows. If a migration is
genuinely wrong, roll the *code* back (the backwards-compatibility rule above means the old code
still works against the new schema) and fix forward with a new migration.

---

## Boot failures

The app fails loudly at startup rather than at first use. Read the message — `@ledger/env`
enumerates every missing or inconsistent variable at once rather than failing on the first.

| Message | Cause |
|---|---|
| `ENCRYPTION_KEY: must decode to exactly 32 bytes` | Wrong length or not base64. `openssl rand -base64 32`. |
| `AGGREGATOR=plaid requires PLAID_CLIENT_ID` | Aggregator set to `plaid` with no credentials. Set them, or use `AGGREGATOR=fixture`. |
| `APP_URL must be https in production` | Session cookies are `Secure`-only. Fix the URL, do not relax the cookie. |
| `RESEND_API_KEY is required in production` | Without it notifications would silently not send, which is worse than not booting. |
| `No key available for key id <id>` | A KEK was rotated out before `keys:rotate` finished. See below. |

---

## Key rotation

```bash
# 1. Generate the new key.
openssl rand -base64 32

# 2. Put the CURRENT key into ENCRYPTION_KEY_RETIRED and the NEW key into ENCRYPTION_KEY.
#    Both must be present. Restart the app — it can now open old records and seals new ones
#    under the new key.

# 3. Re-wrap every existing record.
pnpm keys:rotate

# 4. Only once that reports zero remaining under the old key id, remove ENCRYPTION_KEY_RETIRED
#    and restart.
```

Rotation re-wraps data keys; it never re-encrypts payloads, which is why it is fast, interruptible,
and safe to run against a live system. It is resumable: a record already under the primary key is
skipped, so re-running after an interruption picks up where it stopped.

**If you remove the retired key too early**, reads of un-rotated rows fail with
`No key available for key id`. The fix is to put the retired key back and finish the rotation —
the data is not lost, it is just unopenable without that key. If the retired key is genuinely
gone, those aggregator connections must be re-linked by their users; there is no recovery, which
is the point of the design.

---

## Sync failure triage

1. **Look at the connection row.** `bank_connections.error` holds `{ code, message, at, retryable }`
   and `status` holds the derived health. The user sees this on `/connections`.

2. **Classify it.**
   - `reauth_required` — the user must re-authenticate with their bank. Nothing to do server-side;
     the UI already prompts them. This is normal and periodic.
   - `consent_expired` — open-banking consent lapsed. Same: user action. If users are hitting this
     *by surprise*, the 14-day warning is not reaching them — check the notification path, not the
     sync path.
   - `retryable: true` — transient upstream failure. BullMQ backs off and retries. Check the job
     queue rather than re-running by hand.
   - `retryable: false` — the item is revoked or the institution is gone. Retrying will not help.

3. **Re-run a sync by hand** only after establishing it is not one of the above:
   ```bash
   docker compose exec worker node dist/index.js --job sync --connection <id>
   ```

4. **Sync is idempotent and resumable.** Running it twice inserts zero duplicate transactions
   (`transactions.external_id` is unique, with `dedupe_hash` catching the pending→posted re-issue),
   and the cursor is persisted with each page inside the same transaction as that page's rows. A
   worker killed mid-sync resumes from the cursor with nothing lost. So: restarting the worker is
   a safe first move, not a last resort.

---

## Notifications stopped

Two processes, and they fail differently.

**The scheduler** is a repeatable BullMQ job that materializes `notifications` rows. If it stops,
no new rows appear:
```sql
select type, count(*), min(scheduled_for)
from notifications where sent_at is null group by type;
```
An empty result with users who have upcoming renewals means the scheduler is not running.

**The sender** picks up due rows. If it stops, rows accumulate with `sent_at` null and a
`scheduled_for` in the past:
```sql
select count(*) from notifications
where sent_at is null and scheduled_for < now() - interval '1 hour';
```
A non-zero count here is the alert worth paging on.

`attempts` and `last_error` on the row tell you why a specific notification is stuck. A push
endpoint returning 404/410 deletes its `push_subscriptions` row by design — a dead endpoint
retried forever is how a sender queue backs up.

### A user was notified twice

This should be impossible: `notifications.dedupe_key` is UNIQUE and the scheduler inserts with
`on conflict do nothing`. If it happened, one of these is true and each is a real bug:

- The dedupe key was derived from "now" rather than from the subject and the event date, so two
  scheduler runs produced different keys for the same fact. Check `packages/notify/src/schedule.ts`
  — every key must be reconstructible from data, never from the clock.
- The same logical notification is being scheduled under two different types.
- Someone dropped the unique index.

```sql
select dedupe_key, count(*) from notifications group by dedupe_key having count(*) > 1;
```

---

## A charge landed after a verified cancellation

This is the failure the product exists to catch, so it is worth being precise about what it means.

`cancellation_requests.status = 'verified'` means the verification job looked for the expected
charge in the window and did not find one. If a charge appears *after* that:

1. Confirm it is really the same subscription and not a separate purchase from the same merchant —
   check `transactions.normalized_key` and the amount against `subscriptions.amount_minor`.
2. If it is: the verification window was too short, or the charge posted unusually late. The job
   should have raised `charged_after_cancellation`. Check whether it ran:
   ```sql
   select * from cancellation_events where request_id = '<id>' order by at;
   ```
3. The user must be told, immediately and loudly, with the stored evidence attached. That is what
   `charged_after_cancellation` does and it is the one notification type that ignores quiet hours.
4. Widening `verificationWindowEndsAt` is usually the right fix. Narrowing it is almost never.

---

## Backup and restore

```bash
# Backup — schema and data, custom format so it can be restored selectively.
docker compose exec -T postgres pg_dump -U ledger -Fc ledger > backup-$(date +%F).dump

# Object storage (cancellation evidence) is NOT in the database dump.
docker compose exec -T minio mc mirror local/ledger-evidence /backup/evidence
```

**A backup you have not restored is a hypothesis.** Verify into a clean container, not into
production:

```bash
docker run -d --name restore-test -e POSTGRES_PASSWORD=x -p 5599:5432 postgres:16
docker exec restore-test psql -U postgres -c "create database ledger"
docker exec restore-test psql -U postgres -d ledger -c "create extension pg_trgm; create extension pgcrypto"
cat backup-YYYY-MM-DD.dump | docker exec -i restore-test pg_restore -U postgres -d ledger
docker exec restore-test psql -U postgres -d ledger -c "select count(*) from subscriptions"
docker rm -f restore-test
```

Note that a restore is useless without the matching `ENCRYPTION_KEY`. Back up the key somewhere
that is **not** next to the database dump, or you have backed up ciphertext and its key together.

---

## Performance

The two queries that matter, and the indexes they rely on:

- `/subscriptions` → `subscriptions (user_id, next_renewal_at)`
- the sender → `notifications (scheduled_for) where sent_at is null`
- detection reconciliation → `transactions (normalized_key)` and `transactions (account_id, posted_at desc)`

If `/subscriptions` is slow, it is almost always a missing join index rather than row count —
`transactions` is the table that grows, and the subscriptions list does not read it.

```sql
-- Slowest statements, if pg_stat_statements is enabled.
select calls, round(mean_exec_time::numeric, 1) as mean_ms, left(query, 120)
from pg_stat_statements order by mean_exec_time desc limit 20;
```

The app logs any tRPC procedure taking over 500ms with its path. That log line names the query
that needs an index.

### Retention

`TRANSACTION_RETENTION_MONTHS` (default 24) bounds the raw feed. The purge job removes raw
transactions only — detections, subscriptions, and price history survive it. Shortening it below
24 months degrades annual-subscription detection, which needs two occurrences in the window to
see a cadence at all.

---

## Account deletion

Deletion is real and it cascades. `users.deleted_at` is set immediately so every read path treats
the account as gone from that moment, and the cascade runs in a job. The job must also **revoke
the upstream aggregator item** — a Plaid item left live after the user deleted their account is a
data-protection problem that no amount of local deletion fixes.

Verify a deletion actually completed:

```sql
select
  (select count(*) from subscriptions where user_id = '<id>') as subs,
  (select count(*) from bank_connections where user_id = '<id>') as connections,
  (select count(*) from notifications where user_id = '<id>') as notifications,
  (select count(*) from audit_log where user_id = '<id>') as audit;
```

All zero. If `bank_connections` is zero but the upstream item was never revoked, the local rows
are gone and the consent is not — check the job's log for the revoke call.
