'use client';

import * as React from 'react';
import { ArrowRight } from 'lucide-react';
import { cn, focusRing } from './lib/cn';

/**
 * The descriptor decoder — brief §6.4.
 *
 * `SQ *NETFLIX.COM 8663797489 CA` becoming `NETFLIX` is the product's central trick, and a trick
 * the user cannot see is a trick they will not trust. So the normaliser hands its working out to
 * the UI as character ranges and this component paints them: what matched, what was thrown away,
 * and what was left over. A screenshot of this component is enough to debug a bad match.
 *
 * The spans index into `raw`, and this component never re-derives them. If the highlight is in
 * the wrong place, the bug is in detection, which is exactly what you want a decoder to prove.
 */

/** Half-open `[start, end)` character range. Structurally the `TextSpan` from `@ledger/detection`. */
export interface DescriptorSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * A run the normaliser removed, with its reason.
 *
 * `reason` is a plain string rather than an import from `@ledger/detection`: this package depends
 * on `@ledger/core` only, and an unknown reason has to render sensibly anyway — the strip
 * vocabulary will grow faster than this component does.
 */
export interface DescriptorStrippedSpan extends DescriptorSpan {
  readonly reason?: string;
}

const STRIP_REASON_LABELS: Readonly<Record<string, string>> = {
  processor: 'payment processor',
  channel: 'billing channel',
  phone: 'phone number',
  url: 'web address',
  location: 'location',
  date: 'date',
  reference: 'reference',
  digits: 'digits',
  filler: 'filler',
};

type SegmentKind = 'matched' | 'stripped' | 'plain';

interface Segment {
  readonly kind: SegmentKind;
  readonly text: string;
  readonly reason?: string;
}

/**
 * Paints each character with its role, then run-length encodes the result.
 *
 * A character array rather than interval arithmetic because bank descriptors are tens of
 * characters long, and the overlap cases — a merchant name sitting inside a stripped run, two
 * stripped spans touching, a span that runs off the end of a truncated descriptor — are all
 * free this way instead of being three more branches to get wrong.
 */
function buildSegments(
  raw: string,
  matchedSpan: DescriptorSpan | undefined,
  strippedSpans: readonly DescriptorStrippedSpan[],
): Segment[] {
  const kinds: SegmentKind[] = new Array<SegmentKind>(raw.length).fill('plain');
  const reasons: (string | undefined)[] = new Array<string | undefined>(raw.length).fill(undefined);

  const paint = (span: DescriptorSpan, kind: SegmentKind, reason: string | undefined): void => {
    const start = Math.max(0, Math.floor(span.start));
    const end = Math.min(raw.length, Math.floor(span.end));
    for (let index = start; index < end; index += 1) {
      kinds[index] = kind;
      reasons[index] = reason;
    }
  };

  for (const span of strippedSpans) paint(span, 'stripped', span.reason);
  // Applied last so it wins: a merchant name found inside a run the normaliser stripped is still
  // the thing that matched, and dimming it would hide the one character range that matters.
  if (matchedSpan !== undefined) paint(matchedSpan, 'matched', undefined);

  const segments: Segment[] = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const kind = kinds[cursor] ?? 'plain';
    const reason = reasons[cursor];
    let end = cursor + 1;
    while (end < raw.length && kinds[end] === kind && reasons[end] === reason) end += 1;
    segments.push({ kind, text: raw.slice(cursor, end), ...(reason === undefined ? {} : { reason }) });
    cursor = end;
  }
  return segments;
}

/** A span is usable only if it is a real forward range that overlaps the string. */
function isUsableSpan(span: DescriptorSpan | undefined, length: number): span is DescriptorSpan {
  return (
    span !== undefined &&
    Number.isFinite(span.start) &&
    Number.isFinite(span.end) &&
    span.start < span.end &&
    span.start < length &&
    span.end > 0
  );
}

export interface DescriptorDecoderProps extends Omit<React.ComponentPropsWithoutRef<'div'>, 'children'> {
  /** The descriptor exactly as the bank sent it. Rendered uppercase by CSS, never re-cased in JS. */
  readonly raw: string;
  /** The clustering key. Empty string means nothing identifying survived. */
  readonly normalized?: string;
  readonly matchedSpan?: DescriptorSpan;
  readonly strippedSpans?: readonly DescriptorStrippedSpan[];
  /** The merchant this matched, for the correction button's accessible name. */
  readonly merchantName?: string;
  /** Given, the highlighted span becomes a button: "this match is wrong" in one click. */
  readonly onCorrect?: () => void;
  readonly eyebrow?: string;
  readonly showLegend?: boolean;
}

export const DescriptorDecoder = React.forwardRef<HTMLDivElement, DescriptorDecoderProps>(
  function DescriptorDecoder(
    {
      className,
      raw,
      normalized,
      matchedSpan,
      strippedSpans = [],
      merchantName,
      onCorrect,
      eyebrow = 'Bank descriptor',
      showLegend = false,
      ...props
    },
    ref,
  ) {
    const usableMatch = isUsableSpan(matchedSpan, raw.length) ? matchedSpan : undefined;
    const usableStripped = React.useMemo(
      () => strippedSpans.filter((span) => isUsableSpan(span, raw.length)),
      [strippedSpans, raw.length],
    );

    const segments = React.useMemo(
      () => buildSegments(raw, usableMatch, usableStripped),
      [raw, usableMatch, usableStripped],
    );

    const matchedText = usableMatch === undefined ? '' : raw.slice(usableMatch.start, usableMatch.end);
    const correctLabel =
      merchantName === undefined
        ? `Matched "${matchedText}" in this descriptor. Report this match as wrong.`
        : `Matched "${matchedText}" to ${merchantName}. Report this match as wrong.`;

    return (
      <div ref={ref} className={cn('flex flex-col gap-[var(--gap-tight)]', className)} {...props}>
        <p className="eyebrow">{eyebrow}</p>

        {/*
          `whitespace-pre-wrap` keeps the descriptor's own spacing, which is evidence: a double
          space is often where a processor prefix used to be. `break-all` lets a 60-character
          reference number wrap inside a 375px column instead of widening the page.
        */}
        <p className="font-mono text-[0.8125rem] uppercase leading-relaxed tracking-[0.04em] whitespace-pre-wrap break-all text-text-2">
          {raw === '' ? (
            <span className="text-text-3">—</span>
          ) : (
            segments.map((segment, index) => {
              const key = `${String(index)}-${segment.kind}`;

              if (segment.kind === 'matched') {
                const highlight = cn(
                  // Highlighted in --control: a dim wash, control-2 text for AA contrast at this
                  // size, and the thin rule underneath from the brief's sketch.
                  'rounded-sm bg-control-dim px-0.5 pb-px text-control-2',
                  'border-b border-control',
                );
                return onCorrect === undefined ? (
                  <span key={key} className={highlight}>
                    {segment.text}
                  </span>
                ) : (
                  <button
                    key={key}
                    type="button"
                    onClick={onCorrect}
                    title="This match is wrong"
                    aria-label={correctLabel}
                    className={cn(
                      highlight,
                      'cursor-pointer transition-colors duration-[var(--duration-fast)] ease-standard',
                      'hover:bg-control/25 hover:text-text',
                      focusRing,
                    )}
                  >
                    {segment.text}
                  </button>
                );
              }

              if (segment.kind === 'stripped') {
                const reasonLabel =
                  segment.reason === undefined
                    ? 'noise'
                    : (STRIP_REASON_LABELS[segment.reason] ?? segment.reason);
                return (
                  <span
                    key={key}
                    data-reason={segment.reason}
                    title={`Removed: ${reasonLabel}`}
                    className="text-text-3"
                  >
                    {segment.text}
                  </span>
                );
              }

              return <span key={key}>{segment.text}</span>;
            })
          )}
        </p>

        {normalized === undefined ? null : (
          <p className="flex items-center gap-1.5 text-[0.8125rem]">
            <ArrowRight className="size-3.5 shrink-0 text-text-3" aria-hidden />
            <span className="eyebrow">Normalized</span>
            {normalized === '' ? (
              // Empty key: the descriptor was pure reference numbers. Detection discards these
              // rather than clustering them together, and saying so beats showing a blank.
              <span className="text-xs text-text-3">nothing identifying survived</span>
            ) : (
              <span className="font-mono uppercase tracking-[0.04em] break-all text-text">{normalized}</span>
            )}
          </p>
        )}

        {showLegend ? <DescriptorLegend /> : null}
      </div>
    );
  },
);

const LEGEND_ITEMS: readonly { readonly swatch: string; readonly label: string }[] = [
  { swatch: 'bg-control', label: 'Matched merchant' },
  { swatch: 'bg-text-3', label: 'Removed as noise' },
  { swatch: 'bg-text-2', label: 'Kept, unmatched' },
];

/**
 * What the three colours mean.
 *
 * Sits next to the decoder the first time a user meets it — in the review queue and in the
 * detection detail — rather than inside it, so a table of decoded rows is not three legends deep.
 */
export const DescriptorLegend = React.forwardRef<HTMLUListElement, React.ComponentPropsWithoutRef<'ul'>>(
  function DescriptorLegend({ className, ...props }, ref) {
    return (
      <ul
        ref={ref}
        className={cn('flex flex-wrap items-center gap-x-[var(--gap-loose)] gap-y-1', className)}
        {...props}
      >
        {LEGEND_ITEMS.map((item) => (
          <li key={item.label} className="flex items-center gap-1.5">
            <span aria-hidden className={cn('h-0.5 w-3 rounded-sm', item.swatch)} />
            <span className="eyebrow">{item.label}</span>
          </li>
        ))}
      </ul>
    );
  },
);
