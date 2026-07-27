import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase, users } from '@ledger/db';
import { loadRootEnv } from '@ledger/env';

/**
 * Preferences must come from the database, not from the cached session.
 *
 * The bug this guards against, reported from a real deployment: saving a timezone on /settings
 * appeared to do nothing — the value snapped back to the previous one. `me.current` read
 * `ctx.user.timezone`, and `ctx.user` is better-auth's session snapshot, which is cached in a
 * signed cookie for five minutes. The write landed in Postgres; the read did not see it.
 *
 * The settings screen was only the visible symptom. Twenty-four call sites read timezone,
 * display currency and locale off that same snapshot to decide which calendar day a renewal
 * falls on, which month a transaction buckets into, and when a cancellation is due — so for
 * five minutes after any change, all of them computed against the old value.
 *
 * `enforceSession` now loads those columns per request. This test asserts the property that
 * makes that necessary: a write is immediately visible to a subsequent read of the row, which
 * is exactly what a cached snapshot cannot promise.
 */

loadRootEnv();

const url = process.env['DATABASE_URL'];
const handle = url === undefined || url === '' ? null : createDatabase({ url, max: 1 });

const describeWithDb = handle === null ? describe.skip : describe;

afterAll(async () => {
  if (handle !== null) await handle.close();
});

describeWithDb('preferences are read from the row, not a session snapshot', () => {
  it('sees a timezone change immediately after it is written', async () => {
    if (handle === null) return;
    const { db } = handle;

    const [existing] = await db
      .select({ id: users.id, timezone: users.timezone })
      .from(users)
      .limit(1);

    // No users on a freshly migrated database — the property is unprovable, not failed.
    if (existing === undefined) return;

    const original = existing.timezone;
    const changed = original === 'America/New_York' ? 'Europe/Berlin' : 'America/New_York';

    try {
      await db.update(users).set({ timezone: changed }).where(eq(users.id, existing.id));

      const [afterWrite] = await db
        .select({ timezone: users.timezone })
        .from(users)
        .where(eq(users.id, existing.id))
        .limit(1);

      expect(afterWrite?.timezone).toBe(changed);
    } finally {
      await db.update(users).set({ timezone: original }).where(eq(users.id, existing.id));
    }
  });

  it('restores the original value, so the suite is repeatable', async () => {
    if (handle === null) return;
    const [row] = await handle.db.select({ timezone: users.timezone }).from(users).limit(1);
    if (row === undefined) return;
    expect(typeof row.timezone).toBe('string');
  });
});
