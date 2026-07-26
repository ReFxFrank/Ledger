'use client';

import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Button, Panel, PanelBody, PanelHeader, cn, toast } from '@ledger/ui';
import { usePageTitle } from '~/components/nav/page-title';
import { api } from '~/lib/trpc';
import { StepAlerts } from './step-alerts';
import { StepSecure, StepSecureDone } from './step-secure';
import { StepSubscriptions } from './step-subscriptions';

/**
 * Onboarding.
 *
 * Three steps, and only the first is compulsory — the second factor is a requirement of the
 * account, the other two are work the user can do at their own pace. Everything here works with
 * no bank connected: that is an acceptance criterion, not a fallback, and it is why step two
 * puts manual entry and CSV import on the same row as the bank.
 *
 * Steps already done are not re-run. Someone who enrolled and then closed the tab comes back to
 * step two, not to a password prompt for a key they already have.
 */
const STEPS = [
  { number: 1, label: 'Secure the account' },
  { number: 2, label: 'Add subscriptions' },
  { number: 3, label: 'Choose alerts' },
] as const;

export interface OnboardingFlowProps {
  readonly twoFactorEnabled: boolean;
  readonly displayCurrency: string;
  readonly timezone: string;
}

export function OnboardingFlow({
  twoFactorEnabled,
  displayCurrency,
  timezone,
}: OnboardingFlowProps): ReactNode {
  usePageTitle('Setup');
  const router = useRouter();
  const [step, setStep] = useState(twoFactorEnabled ? 2 : 1);

  const complete = api.me.completeOnboarding.useMutation();

  function leave(): void {
    // Fire-and-forget: the flag is a "do not show this again" hint, and a failed write must not
    // strand someone on a setup screen they have finished with.
    complete.mutate(undefined, {
      onError: () => {
        toast.error('Setup finished, but we could not save that you had seen it.');
      },
    });
    router.push('/');
    router.refresh();
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-[var(--gap-loose)] px-4 py-8 sm:py-12">
      <div className="flex items-center gap-2">
        <span aria-hidden className="size-2 rounded-sm bg-outflow" />
        <span className="text-sm font-medium tracking-tight text-text">Ledger</span>
      </div>

      {/* The stepper is an ordered list, so it reads as "step 2 of 3" rather than as three
          decorative circles a screen reader has to guess at. */}
      <ol className="flex flex-wrap items-center gap-x-[var(--gap-loose)] gap-y-1">
        {STEPS.map((entry) => {
          const done = entry.number < step;
          const current = entry.number === step;
          return (
            <li key={entry.number} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className={cn(
                  'grid size-4 place-items-center rounded-sm border font-mono text-[0.625rem] leading-none',
                  done && 'border-control/40 bg-control-dim text-control-2',
                  current && 'border-control bg-control text-ink-900',
                  !done && !current && 'border-line bg-ink-700 text-text-3',
                )}
              >
                {done ? <Check className="size-2.5" strokeWidth={3} /> : entry.number}
              </span>
              <span
                className={cn(
                  'text-[0.6875rem] uppercase tracking-[var(--tracking-eyebrow)]',
                  current ? 'text-text' : 'text-text-3',
                )}
              >
                {entry.label}
                {current ? <span className="sr-only"> (current step)</span> : null}
              </span>
            </li>
          );
        })}
      </ol>

      {step === 1 ? (
        <Panel>
          <PanelHeader eyebrow="Step 1 of 3">Secure the account.</PanelHeader>
          <PanelBody>
            {twoFactorEnabled ? (
              <StepSecureDone
                onDone={() => {
                  setStep(2);
                }}
              />
            ) : (
              <StepSecure
                onDone={() => {
                  setStep(2);
                  // The verification issued a fresh session cookie. Without this the server
                  // components above still believe two-factor is off and keep the nav hidden.
                  router.refresh();
                }}
              />
            )}
          </PanelBody>
        </Panel>
      ) : null}

      {step === 2 ? (
        <Panel>
          <PanelHeader eyebrow="Step 2 of 3">Add what is charging you.</PanelHeader>
          <PanelBody>
            <StepSubscriptions
              defaultCurrency={displayCurrency}
              timezone={timezone}
              onContinue={() => {
                setStep(3);
              }}
            />
          </PanelBody>
        </Panel>
      ) : null}

      {step === 3 ? (
        <Panel>
          <PanelHeader eyebrow="Step 3 of 3">Choose what to be told about.</PanelHeader>
          <PanelBody>
            <StepAlerts onFinish={leave} />
          </PanelBody>
        </Panel>
      ) : null}

      {step > 1 ? (
        <div className="flex flex-wrap items-center gap-[var(--gap-tight)]">
          <Button type="button" variant="ghost" size="sm" onClick={leave}>
            Skip the rest and open the dashboard
          </Button>
        </div>
      ) : null}
    </div>
  );
}
