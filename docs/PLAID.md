# Turning Plaid on

Ledger runs against a fixture bank by default (`AGGREGATOR=fixture`). To run against Plaid:

1. Create API keys at [dashboard.plaid.com](https://dashboard.plaid.com) (a free account includes
   unlimited Sandbox use).
2. Set the following in `.env`:

   ```dotenv
   AGGREGATOR=plaid
   PLAID_CLIENT_ID=<your client id>
   PLAID_SECRET=<your sandbox secret>
   PLAID_ENV=sandbox
   ```

3. Restart the dev server. The "Connect a bank" button now opens Plaid Link; everything after the
   token exchange — sealing, cursors, backfill, detection — is the same code path the fixture runs.

## Sandbox sign-in

**The phone screen comes first, and a real phone number will never work.** Link opens with
Plaid's "remember me" prompt, and sandbox does not send real SMS — a genuine number just waits
forever for a text that is not coming. Use Plaid's test values, or the skip link on that screen
("continue as guest"); the phone step is Plaid's returning-user feature, not part of linking a
bank.

- phone number: `415-555-0011`
- SMS code: `123456`

Then pick any institution and sign in with Plaid's test credentials:

- username: `user_good`
- password: `pass_good`

## Webhooks in local dev

Plaid can only deliver webhooks to a public URL. For local development you need a tunnel
(`ngrok http 3000`, `cloudflared tunnel`, etc.) and the tunnel URL set as the webhook URL so
`PLAID_WEBHOOK_URL` reaches this machine. Without one, connecting and syncing still work — you
just won't get the push that new data is available and have to press Sync yourself.

## What sandbox will and will not show you

Plaid's default sandbox accounts carry a small, static set of test transactions. Subscription
detection needs months of recurring history to stand behind a candidate, so it will find far less
against sandbox than against the fixture's 24 months of generated data.

In short: **the fixture is the demo path, sandbox is the integration path.** Use sandbox to prove
the Link handoff, the token exchange, and webhook verification end to end; use the fixture to see
the product working.
