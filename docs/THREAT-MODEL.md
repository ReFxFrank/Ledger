# Threat model

What Ledger holds, who would want it, and what actually stops them.

Written to be argued with. If a control below is weaker than it claims, that is a bug worth
filing against this document as much as against the code.

---

## What is at stake

Ledger holds a **map of a person's financial life**: every recurring charge, the card each lands
on, the institutions they bank with, and a live token that can read their transaction history.
That combination is more sensitive than any single element of it. A transaction feed reveals
where someone lives, what they subscribe to, their health and dating and political affiliations,
and when they are away from home.

The asset ranking, highest first:

1. **Aggregator access tokens.** One token reads a full transaction history. Compromise is
   ongoing, not a snapshot, and the user cannot tell it is happening.
2. **Transaction history.** A behavioural profile that cannot be rotated after a breach.
3. **Session tokens and credentials.** The route to everything above.
4. **Cancellation evidence.** Uploaded screenshots and emails, often containing account numbers.
5. **Subscription inventory.** Lower sensitivity alone, still a profile in aggregate.

Explicitly **not** held: full card numbers (there is no column for one), bank passwords (token
exchange only), and third-party service credentials (see the boundary below).

---

## The product boundary that is also a security boundary

Brief §0.3 forbids logging into a third party as the user, storing a third-party password, or
driving a headless browser against a provider's account pages. That is written as a product rule.
It is also the single largest reduction in attack surface in the design.

An automated-cancellation product must hold, for every user, a working credential for every
service they subscribe to. That store is worth more than the bank tokens — it is a
ready-made credential-stuffing corpus with the pairings already resolved — and it cannot be
protected by a second factor, because the automation has to bypass the second factor to work.

Ledger's answer is that the credential store does not exist. There is nothing to steal because
the app never holds it, and no amount of implementation quality elsewhere buys as much as that.

**This is not a preference. Any future feature that requires holding third-party credentials
should be treated as a redesign of the threat model, not as a feature.**

---

## Adversaries

| Adversary | Wants | Realistic capability |
|---|---|---|
| Credential stuffer | Account access at scale | Breach corpora, automation. Not targeting anyone in particular. |
| Opportunistic attacker | A misconfigured instance | Scanning for exposed Postgres, default secrets, missing auth |
| Insider or operator | Everything | Database access, application logs, backups |
| Malicious user of the app | Other users' data | An authenticated session and a UUID guess |
| Compromised dependency | Exfiltration from the build or runtime | Supply chain, postinstall scripts |
| Someone with the user's laptop | A logged-in session | Physical access |

---

## Controls, and what each actually buys

### Aggregator tokens at rest

**Control.** AES-256-GCM envelope encryption. A fresh 256-bit data key per record; the KEK from
`ENCRYPTION_KEY` or KMS wraps the DEK. AAD binds every ciphertext to `table:row:column`.

**Buys.** A stolen database dump yields ciphertext. A dump *plus* the KEK yields everything — so
the honest statement is that this defends against backup theft, log leakage, and a read-only
database compromise, and **not** against a full host compromise where the KEK is in the process
environment.

**The AAD is doing real work.** An attacker with database write access but no key cannot move a
valid token ciphertext from another user's connection row into their own — it fails
authentication rather than decrypting into a working token.

**Weakness.** `ENCRYPTION_KEY` sits in the environment of a running process. Moving to KMS makes
the key never resident and turns unwrapping into an auditable, revocable API call.
`kmsKekProvider()` is the seam; it is not implemented.

### Cross-user access

**Control.** Every user-scoped read goes through `Scope`, which is constructed from the
authenticated session and cannot be widened. `own()` takes values *without* a `userId` field so a
caller cannot pass someone else's. Tables scoped indirectly get explicit `EXISTS` predicates
rather than a join a caller might forget to constrain.

**Buys.** The common bug — one query written in a hurry that filters by row id and forgets the
user — is not expressible at a call site.

**The enforcement that matters** is the runtime-enumerated authz suite: it walks the tRPC router,
finds every procedure, and asserts each is built on a protected tier with a small explicit
allowlist. A procedure added later is covered by default or the suite goes red. A hand-written
list of procedures to check would rot in a week.

### Authentication

**Control.** Mandatory TOTP. 12-character password floor. Sessions individually revocable.
Sensitive actions — connecting a bank, exporting, deleting, changing 2FA — require re-auth within
15 minutes.

**Buys.** Mandatory 2FA is what makes the credential-stuffing adversary largely irrelevant: a
correct password alone is not access. This is the highest-value control in the system and the
reason it is not optional.

**Weakness.** TOTP is phishable in real time. Passkeys are the fix and are currently unregistered
(the better-auth plugin moved out of core at 1.6). Until then, a convincing phishing page can
relay a code within its window.

### Secrets reaching the client

**Control.** Only `NEXT_PUBLIC_*` values are permitted in the browser bundle, and CI greps the
built client for every other name in `.env.example` and fails the build on a hit.

**Buys.** The specific failure this catches is a server-only value pulled into a client component
through an innocent re-export — which is invisible in review and obvious to anyone reading the
bundle.

### Logs

**Control.** One logger, with a redaction denylist covering every field name that has plausibly
held a secret. `console` is a lint error outside `cli/`, `scripts/`, `seed/`, and tests.

**Buys.** Defence in depth only. The real control is that plaintext tokens never leave
`@ledger/crypto`. Redaction is what catches the case where that is violated by accident.

### Browser

**Control.** CSP with a per-request nonce and `strict-dynamic`; no `unsafe-inline` for scripts.
HSTS, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `X-Robots-Tag: noindex`.

**Weakness, stated plainly.** `style-src` still allows `'unsafe-inline'`, because Tailwind v4
injects a style element at runtime with no nonce hook. That materially weakens CSP against CSS
injection — data exfiltration via attribute selectors is a real technique. It is a known gap, not
an oversight.

### Supply chain

**Control.** Frozen lockfile in CI and in the Docker build.

**Weakness.** No dependency pinning by digest, no provenance verification, no automated advisory
scan. `postinstall` scripts run. This is the least-defended surface in the system and it is worth
saying so rather than leaving it implied.

---

## Known gaps

Ranked by what should be fixed first.

1. **No rate limiting on link-token creation or export.** The Redis token bucket is designed but
   not written. Export is expensive and unbounded per user; link-token creation costs money at
   the aggregator.
2. **Passkeys unregistered**, leaving TOTP as the only second factor and phishing relay open.
3. **`style-src 'unsafe-inline'`** — see above.
4. **KEK resident in the process environment.** KMS provider is a seam, not an implementation.
5. **No automated dependency advisory scanning.**
6. **Aggregator webhook verification is only as good as the shared secret handling.** A leaked
   `PLAID_WEBHOOK_SECRET` lets an attacker enqueue syncs. Impact is bounded — the sync engine is
   idempotent and a replayed delivery is a no-op by unique constraint — but it is a free DoS.
7. **Evidence uploads are not scanned or content-sniffed.** They are served from object storage,
   not from the app origin, which bounds the damage, but an uploaded HTML file is still a file.
8. **Account deletion depends on the upstream revoke succeeding.** If the aggregator call fails,
   local rows are gone and the consent is not. The job must retry and surface a failure loudly;
   verify with the query in the runbook.

---

## What is deliberately out of scope

- **A malicious host operator.** Ledger is self-hosted; whoever runs it can read the KEK. Nothing
  in the design pretends otherwise.
- **A compromised user device.** A logged-in session on a stolen unlocked laptop is game over,
  mitigated only by session revocation after the fact.
- **Traffic analysis against the aggregator.**
- **Denial of service.** Assumed to be handled at the edge, not in the app.
