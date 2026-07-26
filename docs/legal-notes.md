# Legal notes

**This file is reference material for the people building and maintaining Ledger. Nothing in it
is legal advice, and nothing in it is rendered into the product UI.** Brief §9.8.

## Why this file exists

Regulation of auto-renewal, free-trial conversion, and cancellation methods varies by
jurisdiction and is actively changing. A product in this category is under permanent temptation
to write UI copy like "the law requires them to let you cancel online" — which is true in some
places, for some contract types, some of the time, and false often enough to be a liability.

So: **no legal claim is ever hardcoded into UI copy.** Not in a playbook, not in a letter
template, not in a tooltip. Where a statute genuinely matters to a user's exit path, the
playbook records it as a dated, sourced note that the UI presents as *information about that
provider*, attributed and timestamped — never as advice about the user's rights.

## Rules for anyone editing product copy or the provider dataset

1. No sentence in the UI may begin "you have the right to…", "they are legally required to…",
   or "the law says…".
2. No guarantee of outcome. Not "we'll cancel it", not "cancellation guaranteed", not
   "you will get a refund". Ledger tells the user what to do and tracks whether it worked.
3. Provider-specific claims (notice periods, refund windows) live in the playbook with a
   `source_url` and a `last_verified_at`, and the UI shows how old the information is.
4. Letter templates are drafted as a customer's own request, in the first person, and are sent
   **by the user**. They do not cite statutes.
5. If something genuinely needs a statutory reference, it goes here, with a date and a source,
   and is discussed with a lawyer before it goes anywhere near a screen.

## Reference log

Entries are dated on the day they were recorded and are **not** kept automatically current.
Anything without a `verified` date newer than 180 days should be treated as unknown.

| Recorded | Jurisdiction | Topic | Note | Source |
|---|---|---|---|---|
| _(none yet)_ | | | | |

Add rows as the provider dataset raises questions. Do not delete rows — supersede them, so the
history of what we believed and when stays legible.

## Open items requiring a lawyer, not an agent

- Terms of Service and Privacy Policy, if this ships publicly.
- Whether storing cancellation evidence (screenshots, confirmation emails) on the user's behalf
  creates any retention obligation.
- Data-processing posture for bank transaction data in each target market.
