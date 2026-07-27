'use client';

import * as React from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  GitMerge,
  Pencil,
  X,
} from 'lucide-react';
import {
  BILLING_CHANNEL_LABELS,
  CATEGORY_LABELS,
  fromInstant,
  interval,
  intervalLabel,
  parsePlainDate,
} from '@ledger/core';
import {
  Badge,
  Button,
  Checkbox,
  DescriptorDecoder,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Money,
  Skeleton,
  cn,
  focusRing,
} from '@ledger/ui';
import { api } from '~/lib/trpc';
import { decodeDescriptor, formatGapDays } from '~/lib/descriptor';
import { formatDay } from '~/lib/format';
import type { ReviewItem } from '~/lib/api-types';
import { MerchantMark } from '../merchant-mark';

/**
 * One row of the review queue.
 *
 * The card exists to answer one question — *why does the engine think this is a subscription* —
 * before it asks for a decision. So the descriptor decoder is above the buttons, not behind a
 * disclosure: the highlighted merchant name and the dimmed noise are the reasoning, and a queue
 * that asks you to confirm without showing its reasoning is asking you to guess.
 *
 * The supporting charges are the second half of the answer and they load only when the card is
 * open. Fifty candidates would otherwise mean fifty queries for evidence nobody has looked at.
 */

/** Reasons worth recording, because the engine uses them to stop re-suggesting the same key. */
const DISMISS_REASONS: readonly string[] = [
  'A one-off purchase, not a subscription',
  'I already cancelled this',
  'Not my charge',
  'Wrong merchant',
];

export interface CandidateCardProps {
  readonly item: ReviewItem;
  readonly index: number;
  readonly focused: boolean;
  readonly expanded: boolean;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly locale: string;
  readonly timezone: string;
  readonly showLegend: boolean;
  readonly onFocus: () => void;
  readonly onToggleExpanded: () => void;
  readonly onToggleSelected: (next: boolean) => void;
  readonly onConfirm: () => void;
  readonly onDismiss: (reason?: string) => void;
  readonly onEdit: () => void;
  readonly onMerge: () => void;
}

export function CandidateCard({
  item,
  index,
  focused,
  expanded,
  selected,
  busy,
  locale,
  timezone,
  showLegend,
  onFocus,
  onToggleExpanded,
  onToggleSelected,
  onConfirm,
  onDismiss,
  onEdit,
  onMerge,
}: CandidateCardProps): React.ReactNode {
  const detection = item.detection;
  const cadence = interval(detection.intervalUnit, detection.intervalCount);
  const confidence = Number(detection.confidence);
  const proposedName = item.merchantName ?? detection.normalizedKey;

  // `sampleDescriptors` is what the engine actually clustered on. Falling back to the normalised
  // key means the decoder shows the key with nothing dimmed, which is honest — there is no raw
  // descriptor on this row to decode — rather than showing an empty box.
  const rawDescriptor = detection.evidence.sampleDescriptors?.[0] ?? detection.normalizedKey;
  const decoded = React.useMemo(
    () => decodeDescriptor(rawDescriptor, item.merchantName),
    [rawDescriptor, item.merchantName],
  );

  // Above 0.05 the engine treats the amount as variable-but-regular and the figure is a median,
  // not a price. The row says so rather than presenting a median as if it were a fixed charge.
  const variable = Number(detection.amountCv) > 0.05;

  const headingId = `candidate-${detection.id}-name`;

  return (
    <li>
      <article
        data-row-index={index}
        aria-labelledby={headingId}
        tabIndex={focused ? 0 : -1}
        onFocus={onFocus}
        className={cn(
          'rounded-md border bg-ink-700 p-[var(--pad-card)] shadow-card',
          'transition-[border-color,background-color] duration-[var(--duration-fast)] ease-standard',
          focusRing,
          focused ? 'border-line-hot' : 'border-line',
          selected && 'bg-ink-600',
          busy && 'opacity-60',
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-[var(--gap)]">
          <div className="flex min-w-0 items-start gap-2.5">
            <Checkbox
              checked={selected}
              disabled={!item.canBulkConfirm}
              tabIndex={focused ? 0 : -1}
              onCheckedChange={(value) => {
                onToggleSelected(value === true);
              }}
              aria-label={
                item.canBulkConfirm
                  ? `Include ${proposedName} in bulk confirm`
                  : `${proposedName} cannot be confirmed in bulk`
              }
              className="mt-1"
            />
            <MerchantMark name={proposedName} logoUrl={item.merchantLogo} />
            <div className="min-w-0">
              <p id={headingId} className="truncate text-sm font-medium leading-tight text-text">
                {proposedName}
              </p>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-2">
                <span>{intervalLabel(cadence)}</span>
                <span aria-hidden className="text-text-3">
                  ·
                </span>
                <span>{CATEGORY_LABELS[item.merchantCategory ?? 'other']}</span>
                <span aria-hidden className="text-text-3">
                  ·
                </span>
                <span>{BILLING_CHANNEL_LABELS[detection.billingChannel]}</span>
              </p>
            </div>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <span className="flex items-baseline gap-1">
              {variable ? (
                <span className="text-[0.6875rem] text-text-3" title="Variable — this is the median charge">
                  ~
                </span>
              ) : null}
              <Money
                amountMinor={detection.medianAmountMinor}
                currency={detection.currency}
                tone="outflow"
                size="lg"
                locale={locale}
              />
            </span>
            <ConfidenceBar value={confidence} bulkEligible={item.canBulkConfirm} />
          </div>
        </div>

        <DescriptorDecoder
          className="mt-[var(--gap-loose)] rounded-sm border border-line bg-ink-800 p-[var(--pad-card)]"
          raw={decoded.raw}
          normalized={decoded.normalized}
          strippedSpans={decoded.strippedSpans}
          {...(decoded.matchedSpan === undefined ? {} : { matchedSpan: decoded.matchedSpan })}
          {...(item.merchantName === null ? {} : { merchantName: item.merchantName })}
          showLegend={showLegend}
          eyebrow={decoded.matchedMerchant ? 'Bank descriptor — matched merchant' : 'Bank descriptor'}
        />

        <div className="mt-[var(--gap-loose)] flex flex-wrap items-center gap-x-[var(--gap-loose)] gap-y-1 text-xs text-text-2">
          <span>
            <span className="eyebrow mr-1.5">Charges</span>
            <span className="font-mono">{detection.occurrences}</span>
          </span>
          <span>
            <span className="eyebrow mr-1.5">Since</span>
            <span className="font-mono">{formatDay(parsePlainDate(detection.firstSeen), locale)}</span>
          </span>
          <span>
            <span className="eyebrow mr-1.5">Last</span>
            <span className="font-mono">{formatDay(parsePlainDate(detection.lastSeen), locale)}</span>
          </span>
          {detection.nextExpectedAt === null ? null : (
            <span>
              <span className="eyebrow mr-1.5">Next expected</span>
              <span className="font-mono">
                {formatDay(parsePlainDate(detection.nextExpectedAt), locale)}
              </span>
            </span>
          )}
        </div>

        <button
          type="button"
          tabIndex={focused ? 0 : -1}
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          className={cn(
            'eyebrow mt-[var(--gap-loose)] inline-flex items-center gap-1 rounded-sm px-0.5 py-0.5',
            'transition-colors duration-[var(--duration-fast)] ease-standard hover:text-text',
            focusRing,
          )}
        >
          {expanded ? (
            <ChevronDown className="size-3" aria-hidden />
          ) : (
            <ChevronRight className="size-3" aria-hidden />
          )}
          {expanded ? 'Hide the charges behind this' : 'Show the charges behind this'}
        </button>

        {expanded ? (
          <SupportingCharges
            detectionId={detection.id}
            locale={locale}
            timezone={timezone}
            item={item}
          />
        ) : null}

        <div className="mt-[var(--gap-loose)] flex flex-wrap items-center gap-[var(--gap-tight)] border-t border-line pt-[var(--gap-loose)]">
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            tabIndex={focused ? 0 : -1}
            onClick={onConfirm}
          >
            <Check className="size-3.5" aria-hidden />
            Confirm
            <Shortcut>Y</Shortcut>
          </Button>

          <Button size="sm" variant="secondary" disabled={busy} tabIndex={focused ? 0 : -1} onClick={onEdit}>
            <Pencil className="size-3.5" aria-hidden />
            Edit &amp; confirm
            <Shortcut>E</Shortcut>
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" disabled={busy} tabIndex={focused ? 0 : -1}>
                <X className="size-3.5" aria-hidden />
                Not a subscription
                <Shortcut>N</Shortcut>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-64">
              <DropdownMenuLabel>Why not? It stops us suggesting it again.</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {DISMISS_REASONS.map((reason) => (
                <DropdownMenuItem
                  key={reason}
                  onSelect={() => {
                    onDismiss(reason);
                  }}
                >
                  {reason}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  onDismiss();
                }}
              >
                Dismiss without a reason
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button size="sm" variant="ghost" disabled={busy} tabIndex={focused ? 0 : -1} onClick={onMerge}>
            <GitMerge className="size-3.5" aria-hidden />
            Merge with existing
            <Shortcut>M</Shortcut>
          </Button>
        </div>
      </article>
    </li>
  );
}

/** The key hint on a button. `aria-hidden` — the shortcut is announced in the list's help text. */
function Shortcut({ children }: { readonly children: string }): React.ReactNode {
  return (
    <kbd
      aria-hidden
      className="ml-0.5 hidden rounded-sm border border-line px-1 font-mono text-[0.625rem] leading-4 text-text-3 sm:inline"
    >
      {children}
    </kbd>
  );
}

/**
 * Confidence, as a bar and a number.
 *
 * `--control` rather than a red-to-green ramp: low confidence is not an error, it is the engine
 * saying it wants a human. Colouring it as a fault would train the user to distrust the queue
 * rather than to read it.
 */
function ConfidenceBar({
  value,
  bulkEligible,
}: {
  readonly value: number;
  readonly bulkEligible: boolean;
}): React.ReactNode {
  const percent = Math.round(value * 100);

  return (
    <span className="flex items-center gap-1.5">
      <span
        role="img"
        aria-label={`Confidence ${percent} per cent`}
        className="relative block h-1 w-16 overflow-hidden rounded-sm bg-ink-600"
      >
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 rounded-sm bg-control"
          style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
        />
      </span>
      <Badge tone={bulkEligible ? 'control' : 'neutral'} mono>
        {percent}%
      </Badge>
    </span>
  );
}

/**
 * The charges the detection was built from.
 *
 * Read through the router rather than from the evidence blob, so a stale id shows up as a
 * missing row instead of as somebody else's transaction. The gap sequence sits underneath
 * because "30, 31, 30, 31" *is* the cadence argument — the dates alone leave the user counting.
 */
function SupportingCharges({
  detectionId,
  locale,
  timezone,
  item,
}: {
  readonly detectionId: string;
  readonly locale: string;
  readonly timezone: string;
  readonly item: ReviewItem;
}): React.ReactNode {
  const charges = api.review.supportingTransactions.useQuery({ detectionId });
  const gaps = formatGapDays(item.detection.evidence.gapDays);
  const factors = item.detection.evidence.confidenceFactors;

  return (
    <div className="mt-[var(--gap-loose)] rounded-sm border border-line bg-ink-800 p-[var(--pad-card)]">
      <p className="eyebrow">Supporting charges</p>

      {charges.isPending ? (
        <div className="mt-[var(--gap-tight)] flex flex-col gap-1.5">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-5 w-full" />
          ))}
        </div>
      ) : charges.error !== null ? (
        <p role="alert" className="mt-[var(--gap-tight)] text-xs text-text-2">
          Could not load the charges. {charges.error.message}{' '}
          <button
            type="button"
            onClick={() => {
              void charges.refetch();
            }}
            className={cn('rounded-sm underline underline-offset-2 hover:text-text', focusRing)}
          >
            Try again
          </button>
        </p>
      ) : charges.data.length === 0 ? (
        <p className="mt-[var(--gap-tight)] text-xs text-text-2">
          The charges behind this suggestion are no longer in your transaction history.
        </p>
      ) : (
        <div className="mt-[var(--gap-tight)] overflow-x-auto">
          <table className="w-full min-w-[26rem] text-left text-xs">
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className="eyebrow py-1 pr-3 font-medium">
                  Posted
                </th>
                <th scope="col" className="eyebrow py-1 pr-3 font-medium">
                  Descriptor
                </th>
                <th scope="col" className="eyebrow py-1 text-right font-medium">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {charges.data.map((charge) => (
                <tr key={charge.id} className="border-b border-line last:border-b-0">
                  <td className="whitespace-nowrap py-1.5 pr-3 font-mono text-text-2">
                    {/* Converted in the user's zone, not UTC: a late-evening charge must not
                        appear on the following day just because the server stored an instant. */}
                    {formatDay(fromInstant(charge.postedAt, timezone), locale)}
                    {charge.pending ? (
                      <Badge tone="neutral" className="ml-1.5">
                        Pending
                      </Badge>
                    ) : null}
                  </td>
                  <td className="max-w-[18rem] truncate py-1.5 pr-3 font-mono uppercase text-text-3">
                    {charge.rawDescriptor}
                  </td>
                  <td className="py-1.5 text-right">
                    <Money
                      amountMinor={charge.amountMinor}
                      currency={charge.currency}
                      tone="outflow"
                      size="sm"
                      locale={locale}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {gaps === '' ? null : (
        <p className="mt-[var(--gap-loose)] text-xs text-text-2">
          <span className="eyebrow mr-1.5">Days between charges</span>
          <span className="font-mono">{gaps}</span>
        </p>
      )}

      {factors === undefined ? null : (
        <dl className="mt-[var(--gap-tight)] flex flex-wrap gap-x-[var(--gap-loose)] gap-y-1 text-xs">
          {Object.entries(factors).map(([name, score]) => (
            <div key={name} className="flex items-center gap-1.5">
              <dt className="eyebrow">{name.replace(/[_-]/g, ' ')}</dt>
              <dd className="font-mono text-text-2">{score.toFixed(2)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
