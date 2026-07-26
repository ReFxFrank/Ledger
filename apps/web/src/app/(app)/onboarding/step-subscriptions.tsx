'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { Building2, Check, FileSpreadsheet, PencilLine } from 'lucide-react';
import { Button, cn } from '@ledger/ui';
import { CsvImport } from './csv-import';
import { ManualSubscriptionForm } from './manual-subscription-form';

/**
 * Step two: get some subscriptions in.
 *
 * Three routes, presented as three equal cards. The bank connection is *not* the primary path
 * with two consolation prizes underneath it — someone who will never link an account has to
 * finish this step with a working product, and a layout that ranks the options tells them
 * otherwise before they have read a word.
 */
type Route = 'bank' | 'manual' | 'csv';

interface RouteCardProps {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

function RouteCard({ icon, title, description, selected, onSelect }: RouteCardProps): ReactNode {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'flex flex-col items-start gap-1.5 rounded-md border p-[var(--pad-card)] text-left',
        'transition-[background-color,border-color,transform] duration-[var(--duration-fast)] ease-standard',
        'outline-none hover:-translate-y-px focus-visible:[box-shadow:var(--focus-ring)]',
        selected
          ? 'border-line-hot bg-ink-600'
          : 'border-line bg-ink-700 hover:border-line-hot hover:bg-ink-600',
      )}
    >
      <span aria-hidden className={cn('[&_svg]:size-4', selected ? 'text-control-2' : 'text-text-3')}>
        {icon}
      </span>
      <span className="text-sm font-medium leading-tight text-text">{title}</span>
      <span className="text-xs leading-snug text-text-2">{description}</span>
    </button>
  );
}

export interface StepSubscriptionsProps {
  readonly defaultCurrency: string;
  readonly timezone: string;
  readonly onContinue: () => void;
}

export function StepSubscriptions({
  defaultCurrency,
  timezone,
  onContinue,
}: StepSubscriptionsProps): ReactNode {
  const [route, setRoute] = useState<Route | null>(null);
  const [added, setAdded] = useState<readonly string[]>([]);

  return (
    <div className="flex flex-col gap-[var(--pad-card)]">
      <p className="text-sm leading-relaxed text-text-2">
        Three ways in. Pick whichever is least work — you can use the others later, and nothing
        here is one-time-only.
      </p>

      <div className="grid gap-[var(--gap-tight)] sm:grid-cols-3">
        <RouteCard
          icon={<Building2 strokeWidth={1.75} />}
          title="Connect a bank"
          description="Ledger reads the charges and proposes what looks recurring. You confirm each one."
          selected={route === 'bank'}
          onSelect={() => {
            setRoute('bank');
          }}
        />
        <RouteCard
          icon={<PencilLine strokeWidth={1.75} />}
          title="Add manually"
          description="Type what you know. Six fields, and the renewal dates are worked out for you."
          selected={route === 'manual'}
          onSelect={() => {
            setRoute('manual');
          }}
        />
        <RouteCard
          icon={<FileSpreadsheet strokeWidth={1.75} />}
          title="Import a CSV"
          description="Already have a spreadsheet? Bring it across and check every row before it saves."
          selected={route === 'csv'}
          onSelect={() => {
            setRoute('csv');
          }}
        />
      </div>

      {route === 'bank' ? (
        <div className="flex flex-col gap-[var(--gap-loose)] rounded-md border border-line bg-ink-900 p-[var(--pad-card)]">
          <p className="text-sm leading-relaxed text-text-2">
            Connecting a bank happens on the Connections screen, which needs your password again
            first. You can come back to onboarding afterwards — nothing here is lost.
          </p>
          <Button asChild variant="primary" className="self-start">
            <Link href="/connections">Go to connections</Link>
          </Button>
        </div>
      ) : null}

      {route === 'manual' ? (
        <div className="rounded-md border border-line bg-ink-900 p-[var(--pad-card)]">
          <ManualSubscriptionForm
            defaultCurrency={defaultCurrency}
            timezone={timezone}
            onAdded={(name) => {
              setAdded((current) => [...current, name]);
            }}
          />
        </div>
      ) : null}

      {route === 'csv' ? (
        <div className="rounded-md border border-line bg-ink-900 p-[var(--pad-card)]">
          <CsvImport
            defaultCurrency={defaultCurrency}
            timezone={timezone}
            onImported={(count) => {
              setAdded((current) => [...current, `${String(count)} from CSV`]);
            }}
          />
        </div>
      ) : null}

      {added.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {added.map((name, index) => (
            <li
              key={`${name}-${String(index)}`}
              className="inline-flex items-center gap-1 rounded-sm border border-line-strong bg-ink-600 px-1.5 py-0.5 text-[0.6875rem] leading-4 text-text-2"
            >
              <Check aria-hidden className="size-3 shrink-0 text-control-2" strokeWidth={2.5} />
              {name}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-[var(--gap-tight)]">
        <Button type="button" variant="primary" onClick={onContinue}>
          Continue
        </Button>
        {added.length === 0 ? (
          <span className="text-xs text-text-2">
            You can skip this and add subscriptions whenever you like.
          </span>
        ) : null}
      </div>
    </div>
  );
}
