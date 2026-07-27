import { describe, expect, it } from 'vitest';
import { money } from '@ledger/core';
import { DEFAULT_QUIET_HOURS, DEFAULT_SEND_MINUTE, channelsFor, leadTimeDaysFor } from '@ledger/notify';

import { buildPreferences } from './preferences';

const user = { id: 'user-1', timezone: 'Europe/London', displayCurrency: 'GBP' };

describe('assembling preferences', () => {
  it('falls back to the documented defaults when the user has touched nothing', () => {
    const prefs = buildPreferences(user, null, []);

    expect(prefs.quietHours).toEqual(DEFAULT_QUIET_HOURS);
    expect(prefs.sendMinute).toBe(DEFAULT_SEND_MINUTE);
    expect(prefs.renewalAlertThreshold).toEqual(money(2000, 'GBP'));
    expect(leadTimeDaysFor(prefs, 'trial_ending')).toBe(3);
    expect(channelsFor(prefs, 'trial_ending')).toEqual(['email', 'in_app']);
  });

  it('reads quiet hours as a wall-clock window in the user’s own zone', () => {
    const prefs = buildPreferences(
      user,
      {
        quietHoursStartMinute: 1_260,
        quietHoursEndMinute: 420,
        quietHoursEnabled: 'true',
        digestDayOfWeek: 5,
        digestMinute: 600,
        renewalAlertThresholdMinor: 500,
      },
      [],
    );

    expect(prefs.timeZone).toBe('Europe/London');
    expect(prefs.quietHours).toEqual({ enabled: true, startMinute: 1_260, endMinute: 420 });
    expect(prefs.digestDayOfWeek).toBe(5);
    expect(prefs.renewalAlertThreshold).toEqual(money(500, 'GBP'));
  });

  it('treats only the literal string false as off', () => {
    const off = buildPreferences(
      user,
      {
        quietHoursStartMinute: 1_320,
        quietHoursEndMinute: 480,
        quietHoursEnabled: 'false',
        digestDayOfWeek: 0,
        digestMinute: 1_080,
        renewalAlertThresholdMinor: 2_000,
      },
      [],
    );
    expect(off.quietHours.enabled).toBe(false);
  });

  it('lets a user switch a type off entirely', () => {
    const prefs = buildPreferences(user, null, [
      { type: 'renewal_upcoming', channels: [], leadTimeDays: 2 },
    ]);
    expect(channelsFor(prefs, 'renewal_upcoming')).toEqual([]);
  });

  it('drops a channel name the column holds but the code no longer serves', () => {
    // `channels` is `text[]`, so a stale row can name something no `Channel` implements.
    const prefs = buildPreferences(user, null, [
      { type: 'trial_ending', channels: ['email', 'carrier_pigeon'], leadTimeDays: 3 },
    ]);
    expect(channelsFor(prefs, 'trial_ending')).toEqual(['email']);
  });
});
