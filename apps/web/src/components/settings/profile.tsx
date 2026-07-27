'use client';

import * as React from 'react';
import { Globe2 } from 'lucide-react';
import {
  Button,
  Input,
  Label,
  Panel,
  PanelBody,
  PanelHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  toast,
} from '@ledger/ui';
import { api } from '~/lib/trpc';
import { LoadError } from '../dashboard/states';

/**
 * Profile.
 *
 * The three settings under the name are not cosmetic. Display currency decides what every total
 * on the dashboard is denominated in; timezone decides which calendar day a renewal falls on, and
 * is why someone travelling still sees the right date; locale decides how amounts and dates are
 * written. All three are read by the server on every scheduling decision, so they are saved
 * together and the form says what each one actually changes.
 */

/** Enough to cover the common cases without shipping a locale database to the browser. */
const COMMON_LOCALES: readonly string[] = [
  'en-GB',
  'en-US',
  'en-AU',
  'en-CA',
  'en-IE',
  'de-DE',
  'fr-FR',
  'es-ES',
  'it-IT',
  'nl-NL',
  'pt-BR',
  'pt-PT',
  'sv-SE',
  'da-DK',
  'nb-NO',
  'fi-FI',
  'pl-PL',
  'ja-JP',
  'ko-KR',
  'zh-CN',
];

const FALLBACK_TIMEZONES: readonly string[] = [
  'UTC',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Amsterdam',
  'Europe/Stockholm',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Sao_Paulo',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Australia/Sydney',
  'Pacific/Auckland',
];

/**
 * The runtime's own zone list when it has one.
 *
 * `Intl.supportedValuesOf` is not in the TypeScript lib for this target, so it is probed through
 * a narrow structural type rather than an `any` cast. The fallback list exists because an older
 * engine should still be able to set a timezone — just from a shorter menu.
 */
function timezoneOptions(): readonly string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf?.('timeZone') ?? FALLBACK_TIMEZONES;
  } catch {
    return FALLBACK_TIMEZONES;
  }
}

export function ProfileSettings(): React.ReactNode {
  const utils = api.useUtils();
  const me = api.me.current.useQuery();
  const currencies = api.me.currencies.useQuery();

  const [name, setName] = React.useState('');
  const [currency, setCurrency] = React.useState('');
  const [timezone, setTimezone] = React.useState('');
  const [locale, setLocale] = React.useState('');
  const [dirty, setDirty] = React.useState(false);

  const loaded = me.data;

  // Seeded once the query lands, and never again while the user is mid-edit: a background
  // refetch that reset a half-typed timezone would be maddening and hard to explain.
  React.useEffect(() => {
    if (loaded === undefined || dirty) return;
    setName(loaded.name);
    setCurrency(loaded.displayCurrency);
    setTimezone(loaded.timezone);
    setLocale(loaded.locale);
  }, [loaded, dirty]);

  const save = api.me.updatePreferences.useMutation({
    onSuccess: async () => {
      toast.success('Saved.');
      setDirty(false);
      await utils.me.current.invalidate();
    },
    onError: (error) => {
      toast.error('Could not save that.', { description: error.message });
    },
  });

  const zones = React.useMemo(timezoneOptions, []);
  const listId = React.useId();
  const localeListId = React.useId();

  if (me.error !== null) {
    return (
      <LoadError
        what="your profile"
        error={me.error}
        retrying={me.isFetching}
        onRetry={() => {
          void me.refetch();
        }}
      />
    );
  }

  if (me.isPending) {
    return (
      <Panel>
        <PanelHeader eyebrow="Profile" />
        <PanelBody className="flex flex-col gap-[var(--gap-loose)]">
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} className="h-14 w-full" />
          ))}
        </PanelBody>
      </Panel>
    );
  }

  const changed =
    name !== me.data.name ||
    currency !== me.data.displayCurrency ||
    timezone !== me.data.timezone ||
    locale !== me.data.locale;

  return (
    <Panel>
      <PanelHeader eyebrow="Profile">
        Your name, and the three settings every date and amount in the product is rendered against.
      </PanelHeader>

      <PanelBody className="flex flex-col gap-[var(--gap-loose)]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="profile-name" required>
            Name
          </Label>
          <Input
            id="profile-name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setDirty(true);
            }}
          />
          <p className="text-[0.6875rem] text-text-3">
            Used in the cancellation letters you send, so it should match the name on the account
            you are cancelling.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="profile-email">Email</Label>
          <Input id="profile-email" value={me.data.email} readOnly mono aria-describedby="email-help" />
          <p id="email-help" className="text-[0.6875rem] text-text-3">
            Changing the address on the account is not something this screen does — it is the
            identity everything else hangs off.
          </p>
        </div>

        <div className="grid gap-[var(--gap-loose)] sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="profile-currency">Display currency</Label>
            <Select
              value={currency}
              onValueChange={(value) => {
                setCurrency(value);
                setDirty(true);
              }}
            >
              <SelectTrigger id="profile-currency" aria-label="Display currency">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {(currencies.data ?? []).map((definition) => (
                  <SelectItem key={definition.code} value={definition.code}>
                    {definition.code} — {definition.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[0.6875rem] text-text-3">
              Totals are shown in this currency. Charges in other currencies are left out of
              totals rather than converted — there is no exchange-rate table yet.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="profile-locale">Locale</Label>
            <Input
              id="profile-locale"
              list={localeListId}
              value={locale}
              onChange={(event) => {
                setLocale(event.target.value);
                setDirty(true);
              }}
            />
            <datalist id={localeListId}>
              {COMMON_LOCALES.map((code) => (
                <option key={code} value={code} />
              ))}
            </datalist>
            <p className="text-[0.6875rem] text-text-3">
              How dates and amounts are written. £9.99 and 9,99 £ are the same number.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="profile-timezone">Timezone</Label>
          <div className="flex flex-wrap items-center gap-[var(--gap-tight)]">
            <Input
              id="profile-timezone"
              className="min-w-0 flex-1"
              list={listId}
              value={timezone}
              onChange={(event) => {
                setTimezone(event.target.value);
                setDirty(true);
              }}
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
                setDirty(true);
              }}
            >
              <Globe2 className="size-3.5" aria-hidden />
              Use this device&rsquo;s
            </Button>
          </div>
          <datalist id={listId}>
            {zones.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
          <p className="text-[0.6875rem] text-text-3">
            Decides which calendar day a renewal lands on, and when a reminder is sent. Every
            deadline in the product is computed against this, not against your browser.
          </p>
        </div>

        <div className="flex items-center gap-[var(--gap-tight)]">
          <Button
            variant="primary"
            size="sm"
            disabled={!changed || name.trim() === ''}
            loading={save.isPending}
            onClick={() => {
              save.mutate({
                name: name.trim(),
                displayCurrency: currency,
                timezone,
                locale,
              });
            }}
          >
            Save
          </Button>
          {changed ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setName(me.data.name);
                setCurrency(me.data.displayCurrency);
                setTimezone(me.data.timezone);
                setLocale(me.data.locale);
                setDirty(false);
              }}
            >
              Discard
            </Button>
          ) : null}
        </div>
      </PanelBody>
    </Panel>
  );
}
