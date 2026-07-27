/**
 * Assembling `UserNotificationPreferences` from the three tables that hold it.
 *
 * `@ledger/notify` deliberately does not know about the database — that is what makes every
 * scheduling decision testable on a frozen clock. The cost of that is this file: somebody has to
 * turn `user`, `notification_settings` and `notification_preferences` into the shape the pure
 * half wants, and doing it in one place is what stops the scheduler and the sender disagreeing
 * about which channels a user has switched on.
 *
 * The mapping itself is a pure function, so "a missing settings row means the documented
 * defaults, not an exception" is a test rather than a claim.
 */

import { inArray } from 'drizzle-orm';
import {
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
  type NotificationType,
  money,
} from '@ledger/core';
import {
  type Database,
  notificationPreferences,
  notificationSettings,
  users,
} from '@ledger/db';
import {
  DEFAULT_QUIET_HOURS,
  DEFAULT_SEND_MINUTE,
  type TypePreference,
  type UserNotificationPreferences,
} from '@ledger/notify';

export interface PreferenceUserRow {
  readonly id: string;
  readonly timezone: string;
  readonly displayCurrency: string;
}

export interface PreferenceSettingsRow {
  readonly quietHoursStartMinute: number;
  readonly quietHoursEndMinute: number;
  /** A text column, not a boolean — anything other than the literal `'false'` means on. */
  readonly quietHoursEnabled: string;
  readonly digestDayOfWeek: number;
  readonly digestMinute: number;
  readonly renewalAlertThresholdMinor: number;
}

export interface PreferenceTypeRow {
  readonly type: NotificationType;
  readonly channels: readonly string[];
  readonly leadTimeDays: number;
}

const VALID_CHANNELS = new Set<string>(NOTIFICATION_CHANNELS);

function toChannels(values: readonly string[]): readonly NotificationChannel[] {
  // Filtering rather than trusting the column: `channels` is `text[]`, so a stale row written
  // before a channel was renamed would otherwise reach a `Channel` lookup that cannot serve it.
  return values.filter((value): value is NotificationChannel => VALID_CHANNELS.has(value));
}

export function buildPreferences(
  user: PreferenceUserRow,
  settings: PreferenceSettingsRow | null,
  types: readonly PreferenceTypeRow[],
): UserNotificationPreferences {
  const byType: Partial<Record<NotificationType, TypePreference>> = {};
  for (const row of types) {
    byType[row.type] = { channels: toChannels(row.channels), leadTimeDays: row.leadTimeDays };
  }

  return {
    userId: user.id,
    timeZone: user.timezone,
    // There is no column for this: 09:00 local is the product's answer for every lead-time
    // notification, and making it per-user would need a migration rather than a default here.
    sendMinute: DEFAULT_SEND_MINUTE,
    quietHours:
      settings === null
        ? DEFAULT_QUIET_HOURS
        : {
            enabled: settings.quietHoursEnabled !== 'false',
            startMinute: settings.quietHoursStartMinute,
            endMinute: settings.quietHoursEndMinute,
          },
    renewalAlertThreshold: money(
      settings?.renewalAlertThresholdMinor ?? 2000,
      user.displayCurrency,
    ),
    digestDayOfWeek: settings?.digestDayOfWeek ?? 0,
    digestMinute: settings?.digestMinute ?? 1080,
    byType,
  };
}

/**
 * Loads preferences for a batch of users in three queries rather than three per user.
 *
 * The scheduler runs over every active user every hour; a per-user round trip here is the
 * difference between an hourly job that finishes in seconds and one that overlaps its own next
 * run.
 */
export async function loadPreferences(
  db: Database,
  userIds: readonly string[],
): Promise<Map<string, UserNotificationPreferences>> {
  const out = new Map<string, UserNotificationPreferences>();
  if (userIds.length === 0) return out;

  const ids = [...new Set(userIds)];

  const [userRows, settingsRows, typeRows] = await Promise.all([
    db
      .select({
        id: users.id,
        timezone: users.timezone,
        displayCurrency: users.displayCurrency,
      })
      .from(users)
      .where(inArray(users.id, ids)),
    db
      .select({
        userId: notificationSettings.userId,
        quietHoursStartMinute: notificationSettings.quietHoursStartMinute,
        quietHoursEndMinute: notificationSettings.quietHoursEndMinute,
        quietHoursEnabled: notificationSettings.quietHoursEnabled,
        digestDayOfWeek: notificationSettings.digestDayOfWeek,
        digestMinute: notificationSettings.digestMinute,
        renewalAlertThresholdMinor: notificationSettings.renewalAlertThresholdMinor,
      })
      .from(notificationSettings)
      .where(inArray(notificationSettings.userId, ids)),
    db
      .select({
        userId: notificationPreferences.userId,
        type: notificationPreferences.type,
        channels: notificationPreferences.channels,
        leadTimeDays: notificationPreferences.leadTimeDays,
      })
      .from(notificationPreferences)
      .where(inArray(notificationPreferences.userId, ids)),
  ]);

  const settingsByUser = new Map(settingsRows.map((row) => [row.userId, row]));
  const typesByUser = new Map<string, PreferenceTypeRow[]>();
  for (const row of typeRows) {
    const list = typesByUser.get(row.userId) ?? [];
    list.push({ type: row.type, channels: row.channels, leadTimeDays: row.leadTimeDays });
    typesByUser.set(row.userId, list);
  }

  for (const user of userRows) {
    out.set(
      user.id,
      buildPreferences(user, settingsByUser.get(user.id) ?? null, typesByUser.get(user.id) ?? []),
    );
  }

  return out;
}
