'use client';

import * as React from 'react';
import { CalendarClock } from 'lucide-react';
import { daysBetween, fromInstant } from '@ledger/core';
import { Badge, Panel, PanelBody, PanelHeader, cn } from '@ledger/ui';
import { formatDay, todayIn } from '~/lib/format';

/**
 * The cancel-by date, with its working shown.
 *
 * "Cancel by 15 July" on its own is a number the user has to trust. "Renews 14 Aug, 30 days
 * notice, so cancel by 15 Jul" is a number they can check — and checking it is exactly what
 * someone does when the date is a fortnight earlier than they expected.
 *
 * The notice period is derived from the two stored instants rather than passed in separately, so
 * the sentence and the deadline cannot disagree: if they ever did, the sentence would be lying
 * about the number printed directly above it.
 */
export interface DeadlinePanelProps {
  readonly deadlineAt: Date | null;
  readonly expectedNextChargeAt: Date | null;
  readonly verificationWindowEndsAt: Date | null;
  readonly locale: string;
  readonly timezone: string;
  /** Once the provider has confirmed, a passed deadline is history rather than a problem. */
  readonly stillOpen: boolean;
}

export function DeadlinePanel({
  deadlineAt,
  expectedNextChargeAt,
  verificationWindowEndsAt,
  locale,
  timezone,
  stillOpen,
}: DeadlinePanelProps): React.ReactNode {
  const today = todayIn(timezone);

  if (deadlineAt === null) {
    return (
      <Panel>
        <PanelHeader eyebrow="Cancel by" />
        <PanelBody>
          <p className="text-sm text-text-2">
            No cancel-by date. We could not project the next renewal for this subscription, so
            treat it as due now.
          </p>
        </PanelBody>
      </Panel>
    );
  }

  const deadline = fromInstant(deadlineAt, timezone);
  const daysRemaining = daysBetween(today, deadline);
  const overdue = daysRemaining < 0 && stillOpen;

  const renewal = expectedNextChargeAt === null ? null : fromInstant(expectedNextChargeAt, timezone);
  const noticeDays = renewal === null ? null : daysBetween(deadline, renewal);

  return (
    <Panel className={overdue ? 'border-alert/35' : undefined}>
      <PanelHeader
        eyebrow="Cancel by"
        actions={
          <Badge tone={overdue ? 'alert' : daysRemaining <= 3 ? 'outflow' : 'neutral'} mono>
            {overdue
              ? `${Math.abs(daysRemaining)} days late`
              : daysRemaining === 0
                ? 'today'
                : `${daysRemaining} days left`}
          </Badge>
        }
      />
      <PanelBody className="flex flex-col gap-[var(--gap-loose)]">
        <p className="flex items-center gap-2">
          <CalendarClock
            aria-hidden
            className={cn('size-4 shrink-0', overdue ? 'text-alert' : 'text-text-3')}
          />
          <time
            dateTime={deadlineAt.toISOString()}
            className={cn(
              'font-mono text-xl tabular-nums tracking-tight',
              overdue ? 'text-alert' : 'text-text',
            )}
          >
            {formatDay(deadline, locale)}
          </time>
        </p>

        {/* The arithmetic, in words. This is the sentence the user checks the date against. */}
        <p className="text-[0.8125rem] leading-relaxed text-text-2">
          {renewal === null || noticeDays === null ? (
            <>We do not have a next renewal date for this one, so the deadline is a best effort.</>
          ) : noticeDays === 0 ? (
            <>
              Renews <Fact>{formatDay(renewal, locale)}</Fact>, no notice period, so cancel by{' '}
              <Fact>{formatDay(deadline, locale)}</Fact>.
            </>
          ) : (
            <>
              Renews <Fact>{formatDay(renewal, locale)}</Fact>,{' '}
              <Fact>
                {noticeDays} {noticeDays === 1 ? 'day' : 'days'} notice
              </Fact>
              , so cancel by <Fact>{formatDay(deadline, locale)}</Fact>.
            </>
          )}
        </p>

        {overdue ? (
          <p role="alert" className="text-[0.8125rem] text-alert">
            That date has passed. The next charge is likely to go through — finish the cancellation
            anyway and keep everything the provider sends you.
          </p>
        ) : null}

        {verificationWindowEndsAt === null ? null : (
          <p className="text-xs text-text-3">
            We will keep watching your bank feed until{' '}
            <span className="font-mono">
              {formatDay(fromInstant(verificationWindowEndsAt, timezone), locale)}
            </span>{' '}
            for a charge that should not arrive. Charges post late; that tail is deliberate.
          </p>
        )}
      </PanelBody>
    </Panel>
  );
}

/** A number in the sentence, in mono so it reads as a value rather than as prose. */
function Fact({ children }: { readonly children: React.ReactNode }): React.ReactNode {
  return <span className="font-mono tabular-nums text-text">{children}</span>;
}
