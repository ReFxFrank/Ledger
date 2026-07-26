# Where this data came from, and what that means

**TODO(frank): the dataset needs a human verification pass before this ships to anyone.**

## What is true today

Every entry carries `sourceUrl` and `lastVerifiedAt`, and the schema refuses a playbook without
them. But the `lastVerifiedAt` dates across the initial 141 files record **when the entry was
written**, not when someone opened the provider's cancellation page and confirmed the steps.

That distinction matters more here than almost anywhere else in the product. A playbook that
sends a user to a page that has moved does not merely fail — it costs them a renewal cycle, and
it costs Ledger the only thing it is really selling, which is that the instructions are right.
The brief puts it plainly: an unverified playbook is worse than none.

## What a verification pass looks like

For each merchant, for each channel:

1. Open `sourceUrl`. Confirm it still resolves and still describes cancellation.
2. Walk the `steps` against the provider's current account UI. Navigation labels drift constantly;
   "Account → Plan → Manage" becomes "Settings → Membership" without announcement.
3. Confirm `cancelUrl` deep-links to the actual cancel page, not a redirect to a homepage or a
   login wall that drops the destination.
4. Re-check `noticePeriodDays` and `refundPolicy` against the current terms. These are the fields
   that produce a wrong `cancel_by_at`, which is the worst kind of wrong this product can be.
5. Confirm the `gotchas` still describe what the flow actually does.
6. Set `lastVerifiedAt` to the date you did this.

`pnpm providers:audit` lists everything older than 180 days, oldest first. That is the work queue.

## The channel rule

The one invariant that must never be violated, and which the schema enforces: a playbook on an
intermediated channel (`apple`, `google`, `amazon`, `roku`, `microsoft`, `carrier`) must send the
user to **that store's** subscription settings. Never the provider's website. An App Store
subscription cannot be cancelled on the provider's site, and a user who follows such an
instruction will believe they have cancelled and be charged again.

`findPlaybook()` returns `null` for a missing intermediated channel rather than falling back to
the `direct` playbook, for exactly this reason. Do not add a fallback.

## Open question

`TODO(frank):` this dataset is the real moat and the real maintenance burden. Decide whether it
is community-editable by PR — in which case the schema validation in CI is the gate and the
channel rule above is the thing a reviewer must never wave through — or curated by one person on
an audit cadence. The tooling supports either; the choice is about who is accountable when an
entry goes stale.
