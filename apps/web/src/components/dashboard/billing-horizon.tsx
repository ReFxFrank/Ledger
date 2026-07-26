'use client';

import * as React from 'react';
import { AxisBottom } from '@visx/axis';
import { Group } from '@visx/group';
import { Bar, Line } from '@visx/shape';
import { scaleBand, scaleLinear } from '@visx/scale';
import { useTooltip } from '@visx/tooltip';
import {
  type PlainDate,
  addDays,
  dayOfWeek,
  daysBetween,
  formatMoney,
  money,
  parsePlainDate,
  toMajorNumber,
} from '@ledger/core';
import { Money, Panel, PanelHeader, motion, useReducedMotion } from '@ledger/ui';

/**
 * The Billing Horizon — brief §6.1, the thesis of the whole design.
 *
 * The claim the chart makes is "here is your money leaving, in the order it leaves". Three
 * decisions follow from that and none of them are negotiable:
 *
 *  1. **Today is the left edge.** A centred now-marker gives half the pixels to the past, and
 *     the past is not what a renewal chart is for. Time runs left to right from this instant.
 *  2. **Height is amount.** Not colour, not area, not a dot. A tick you can compare at a glance
 *     against the one next to it is the entire reason this is a chart and not a list.
 *  3. **Charges on the same day stack, they do not overlap.** Four renewals on the 1st is the
 *     single most common shape in real data; drawn on top of each other it becomes one fat bar
 *     that lies about the amount.
 *
 * Every charge is also a row in a visually-hidden table, and the chart itself is one tab stop
 * with arrow-key movement between markers. Neither is a fallback bolted on afterwards — a
 * timeline whose information only exists in pixel heights is a timeline half the users cannot
 * read.
 */

// ── inputs ─────────────────────────────────────────────────────────────────────────────
// Structural, not the tRPC row type: the horizon procedure returns more than the chart draws,
// and pinning this to the router's inferred output would make the component unusable from a
// story or a test without a database behind it.

export interface HorizonCharge {
  /** `YYYY-MM-DD`, already resolved into the user's timezone by the server. */
  readonly date: string;
  readonly subscriptionId: string;
  readonly displayName: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly variableAmount: boolean;
  readonly isTrialConversion: boolean;
}

/** A cancel-by date. Not a charge — a deadline, drawn as a rule rather than a tick. */
export interface HorizonDeadline {
  readonly date: string;
  readonly subscriptionId: string;
  readonly displayName: string;
  /** True once the date is behind us: a missed cancel-by is a problem, not a warning. */
  readonly missed?: boolean;
}

export interface BillingHorizonProps {
  /** Window start, `YYYY-MM-DD`. Rendered at x = 0. */
  readonly from: string;
  readonly to: string;
  readonly charges: readonly HorizonCharge[];
  readonly deadlines?: readonly HorizonDeadline[];
  readonly locale?: string;
  readonly className?: string;
}

// ── geometry ───────────────────────────────────────────────────────────────────────────

const CHART_HEIGHT = 212;
const MARGIN = { top: 24, right: 10, bottom: 22, left: 1 } as const;

/** Below this a tick stops being visible at all, so tiny charges are floored rather than lost. */
const MIN_TICK_HEIGHT = 3;
const SEGMENT_GAP = 1.5;
const MAX_TICK_WIDTH = 9;

/**
 * How much of the window fits at this width.
 *
 * Shortening the window is the honest response to a narrow viewport. The alternative — keeping
 * all 60 days and letting each tick fall below a pixel — produces a chart that is technically
 * complete and practically unreadable, and at 375px it would be a grey smear.
 */
function windowDays(width: number): number {
  if (width <= 0) return 60;
  if (width < 420) return 21;
  if (width < 620) return 30;
  if (width < 880) return 45;
  return 60;
}

/**
 * The number a tick's height is drawn from.
 *
 * Major units, not minor: ¥1000 and $10.00 are 1000 and 1000 in minor units and nothing alike.
 * `toMajorNumber` is core's one sanctioned display float and this is a display projection — no
 * monetary arithmetic happens on the result, it only picks a pixel height.
 *
 * Currencies are still not converted (there is no rate table yet, see the TODO in the dashboard
 * router), so a mixed-currency window compares figures that are not comparable. The panel says
 * so out loud rather than pretending the bars line up.
 */
function magnitude(amountMinor: number, currency: string): number {
  try {
    return Math.abs(toMajorNumber(money(amountMinor, currency)));
  } catch {
    // An unknown currency code from a bank feed. Draw it at the floor height and let the
    // amount render as an em dash — visible as a problem beats silently absent.
    return 0;
  }
}

function describeAmount(amountMinor: number, currency: string, locale: string): string {
  try {
    return formatMoney(money(amountMinor, currency), { locale });
  } catch {
    return 'Amount unavailable';
  }
}

/**
 * Formats a plain date for display.
 *
 * The `Date` is built at UTC midnight and formatted in UTC, so it is only ever a carrier for
 * three integers — no timezone can shift it onto the day before.
 */
function formatDay(date: PlainDate, locale: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(
    new Date(Date.UTC(date.year, date.month - 1, date.day)),
  );
}

// ── placement ──────────────────────────────────────────────────────────────────────────

type MarkerKind = 'charge' | 'deadline';

interface PlacedMarker {
  readonly key: string;
  readonly kind: MarkerKind;
  readonly dayIndex: number;
  readonly date: PlainDate;
  readonly label: string;
  readonly subscriptionId: string;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly variableAmount: boolean;
  readonly isTrialConversion: boolean;
  readonly missed: boolean;
  /** Drawn geometry, relative to the plot group. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface DayRule {
  readonly index: number;
  readonly x: number;
  readonly weight: 'day' | 'week' | 'month';
}

export function BillingHorizon({
  from,
  to,
  charges,
  deadlines = [],
  locale = 'en-US',
  className,
}: BillingHorizonProps): React.ReactNode {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = React.useState(0);
  const [activeIndex, setActiveIndex] = React.useState<number | null>(null);
  const reducedMotion = useReducedMotion();
  const titleId = React.useId();
  const hintId = React.useId();

  React.useEffect(() => {
    const node = containerRef.current;
    if (node === null) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  const start = React.useMemo(() => parsePlainDate(from), [from]);
  const totalDays = React.useMemo(() => daysBetween(start, parsePlainDate(to)) + 1, [start, to]);
  const slotCount = Math.max(1, Math.min(totalDays, windowDays(width)));
  const truncated = slotCount < totalDays;

  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;

  const xScale = React.useMemo(
    () =>
      scaleBand<number>({
        domain: Array.from({ length: slotCount }, (_unused, index) => index),
        range: [0, innerWidth],
        padding: 0.22,
      }),
    [slotCount, innerWidth],
  );

  const { markers, rules, monthTicks, windowTotal } = React.useMemo(
    () => layout({ charges, deadlines, start, slotCount, xScale, plotHeight }),
    [charges, deadlines, start, slotCount, xScale, plotHeight],
  );

  const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<PlacedMarker>();

  const reveal = React.useCallback(
    (marker: PlacedMarker) => {
      showTooltip({
        tooltipData: marker,
        tooltipLeft: MARGIN.left + marker.x + marker.width / 2,
        tooltipTop: MARGIN.top + marker.y,
      });
    },
    [showTooltip],
  );

  /** Moves the roving selection and brings the tooltip with it, so keyboard sees what hover sees. */
  const focusMarker = React.useCallback(
    (index: number) => {
      const marker = markers[index];
      if (marker === undefined) return;
      setActiveIndex(index);
      reveal(marker);
    },
    [markers, reveal],
  );

  // A window resize re-lays-out every marker; an index that pointed at day 58 must not survive
  // into a 21-day window and address nothing.
  React.useEffect(() => {
    setActiveIndex(null);
    hideTooltip();
  }, [slotCount, hideTooltip]);

  const handleKeyDown = (event: React.KeyboardEvent<SVGSVGElement>): void => {
    if (markers.length === 0) return;
    const current = activeIndex ?? -1;
    const last = markers.length - 1;

    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        focusMarker(Math.min(last, current + 1));
        return;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        focusMarker(Math.max(0, current <= 0 ? 0 : current - 1));
        return;
      case 'Home':
        event.preventDefault();
        focusMarker(0);
        return;
      case 'End':
        event.preventDefault();
        focusMarker(last);
        return;
      case 'Escape':
        setActiveIndex(null);
        hideTooltip();
        return;
      default:
        return;
    }
  };

  const active = activeIndex === null ? undefined : markers[activeIndex];
  const currencies = new Set(charges.map((charge) => charge.currency));
  const singleCurrency = currencies.size === 1 ? [...currencies][0] : undefined;

  const windowLabel =
    slotCount === 1
      ? 'Today'
      : `Next ${String(slotCount)} days · ${formatDay(start, locale, { month: 'short', day: 'numeric' })} to ${formatDay(addDays(start, slotCount - 1), locale, { month: 'short', day: 'numeric' })}`;

  return (
    <Panel className={className}>
      <PanelHeader
        eyebrow="Billing horizon"
        actions={
          singleCurrency === undefined ? (
            <span className="font-mono text-xs text-text-2">
              {String(markers.filter((marker) => marker.kind === 'charge').length)} charges
            </span>
          ) : (
            <span className="flex items-baseline gap-1.5">
              <span className="eyebrow">Due in window</span>
              <Money amountMinor={windowTotal} currency={singleCurrency} tone="outflow" size="lg" />
            </span>
          )
        }
      >
        {windowLabel}
      </PanelHeader>

      <div className="px-[var(--pad-panel)] pb-[var(--pad-panel)] pt-[var(--gap-loose)]">
        <div ref={containerRef} className="relative w-full">
          {width > 0 ? (
            <svg
              width={width}
              height={CHART_HEIGHT}
              role="group"
              tabIndex={0}
              aria-labelledby={titleId}
              aria-describedby={hintId}
              className="block outline-none focus-visible:[box-shadow:var(--focus-ring)]"
              onKeyDown={handleKeyDown}
              onFocus={() => {
                if (activeIndex === null && markers.length > 0) focusMarker(0);
              }}
              onBlur={() => {
                setActiveIndex(null);
                hideTooltip();
              }}
            >
              <title id={titleId}>
                Billing horizon: {String(markers.filter((m) => m.kind === 'charge').length)} charges
                over {String(slotCount)} days
              </title>

              <Group left={MARGIN.left} top={MARGIN.top}>
                {/* Gridlines first, so a tick never sits under one. */}
                {rules.map((rule) => (
                  <Line
                    key={`rule-${String(rule.index)}`}
                    from={{ x: rule.x, y: 0 }}
                    to={{ x: rule.x, y: plotHeight }}
                    stroke={rule.weight === 'day' ? 'var(--line)' : 'var(--line-strong)'}
                    strokeOpacity={rule.weight === 'day' ? 0.5 : rule.weight === 'week' ? 0.7 : 1}
                    strokeWidth={1}
                    shapeRendering="crispEdges"
                  />
                ))}

                <Line
                  from={{ x: 0, y: plotHeight }}
                  to={{ x: innerWidth, y: plotHeight }}
                  stroke="var(--line-strong)"
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />

                {/* Today. The left edge is a fact about the chart, so it gets a rule of its own. */}
                <Line
                  from={{ x: 0, y: -MARGIN.top + 8 }}
                  to={{ x: 0, y: plotHeight }}
                  stroke="var(--control)"
                  strokeOpacity={0.55}
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />

                {markers.map((marker, index) => (
                  <MarkerShape
                    key={marker.key}
                    marker={marker}
                    index={index}
                    total={markers.length}
                    plotHeight={plotHeight}
                    reducedMotion={reducedMotion === true}
                    selected={activeIndex === index}
                    onPoint={() => {
                      setActiveIndex(index);
                      reveal(marker);
                    }}
                    onLeave={() => {
                      hideTooltip();
                    }}
                    hitWidth={Math.max(marker.width, xScale.step())}
                  />
                ))}

                <AxisBottom
                  scale={xScale}
                  top={plotHeight}
                  tickValues={monthTicks}
                  hideAxisLine
                  hideTicks
                  tickFormat={(value) =>
                    value === 0
                      ? 'Today'
                      : formatDay(addDays(start, value), locale, { month: 'short' })
                  }
                  tickLabelProps={() => ({
                    fill: 'var(--text-3)',
                    fontSize: 10,
                    fontFamily: 'var(--font-mono)',
                    letterSpacing: '0.06em',
                    textAnchor: 'start',
                    dy: '0.9em',
                  })}
                />
              </Group>
            </svg>
          ) : (
            <div style={{ height: CHART_HEIGHT }} />
          )}

          {tooltipOpen && tooltipData !== undefined ? (
            <MarkerTooltip
              marker={tooltipData}
              locale={locale}
              left={Math.min(Math.max(tooltipLeft ?? 0, 76), Math.max(76, width - 76))}
              top={Math.max(0, (tooltipTop ?? 0) - 10)}
            />
          ) : null}
        </div>

        <p id={hintId} className="mt-[var(--gap-loose)] text-xs text-text-3">
          Bar height is the amount. Focus the chart and use the arrow keys to step through each
          charge.
          {truncated
            ? ` Showing the first ${String(slotCount)} of ${String(totalDays)} days at this width.`
            : ''}
          {currencies.size > 1
            ? ' Heights are not currency-converted, so bars in different currencies are not comparable.'
            : ''}
        </p>

        <Legend hasTrial={charges.some((charge) => charge.isTrialConversion)} hasDeadline={deadlines.length > 0} />

        {/* What the keyboard is doing, for a screen reader that cannot see the tooltip. */}
        <p aria-live="polite" className="sr-only">
          {active === undefined
            ? ''
            : `${active.label}, ${
                active.kind === 'deadline'
                  ? 'cancel by'
                  : describeAmount(active.amountMinor ?? 0, active.currency ?? 'USD', locale)
              }, ${formatDay(active.date, locale, { weekday: 'long', month: 'long', day: 'numeric' })}`}
        </p>

        <ChargeTable charges={charges} deadlines={deadlines} locale={locale} totalDays={totalDays} />
      </div>
    </Panel>
  );
}

// ── the drawn marker ───────────────────────────────────────────────────────────────────

interface MarkerShapeProps {
  readonly marker: PlacedMarker;
  readonly index: number;
  readonly total: number;
  readonly plotHeight: number;
  readonly reducedMotion: boolean;
  readonly selected: boolean;
  readonly hitWidth: number;
  readonly onPoint: () => void;
  readonly onLeave: () => void;
}

/**
 * The whole page's motion budget, spent here.
 *
 * §6.5 allows one orchestrated entrance and nothing else, so the ticks rise from the baseline
 * over ~200ms with the stagger spread across a fixed 240ms window rather than a per-item delay —
 * a per-item delay makes a 40-charge month take four seconds to finish drawing.
 *
 * Under reduced motion the stagger is dropped entirely and the duration collapses to match what
 * `tokens.css` does to every CSS transition. The bars are simply there.
 */
function MarkerShape({
  marker,
  index,
  total,
  plotHeight,
  reducedMotion,
  selected,
  hitWidth,
  onPoint,
  onLeave,
}: MarkerShapeProps): React.ReactNode {
  const delay = reducedMotion || total === 0 ? 0 : (index / total) * 0.24;
  const transition = {
    duration: reducedMotion ? 0.001 : 0.2,
    delay,
    ease: [0.2, 0, 0.1, 1] as const,
  };

  const centre = marker.x + marker.width / 2;

  return (
    <g>
      {marker.kind === 'deadline' ? (
        <>
          <motion.line
            x1={centre}
            x2={centre}
            y1={0}
            y2={plotHeight}
            stroke="var(--alert)"
            strokeWidth={1}
            strokeDasharray="3 3"
            strokeOpacity={marker.missed ? 0.95 : 0.7}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={transition}
          />
          <motion.rect
            x={centre - 3.5}
            y={-7}
            width={7}
            height={7}
            transform={`rotate(45 ${String(centre)} ${String(-3.5)})`}
            fill={marker.missed ? 'var(--alert)' : 'var(--ink-900)'}
            stroke="var(--alert)"
            strokeWidth={1.25}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={transition}
          />
        </>
      ) : (
        <>
          <motion.rect
            x={marker.x}
            y={marker.y}
            width={marker.width}
            height={marker.height}
            rx={1.5}
            fill="var(--outflow)"
            fillOpacity={marker.variableAmount ? 0.55 : 1}
            stroke={marker.variableAmount ? 'var(--outflow)' : 'none'}
            strokeWidth={marker.variableAmount ? 1 : 0}
            strokeDasharray={marker.variableAmount ? '2 2' : undefined}
            style={{ transformBox: 'fill-box', transformOrigin: 'bottom' }}
            initial={{ scaleY: 0 }}
            animate={{ scaleY: 1 }}
            transition={transition}
          />
          {marker.isTrialConversion ? (
            // A trial converting is the one upcoming charge the user did not choose today, so it
            // is flagged in --alert. The glyph differs from the cancel-by diamond on purpose:
            // same colour means "problem", the shape says which problem.
            <motion.path
              d={`M ${String(centre - 4)} ${String(marker.y - 3)} L ${String(centre + 4)} ${String(marker.y - 3)} L ${String(centre)} ${String(marker.y - 10)} Z`}
              fill="var(--alert)"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={transition}
            />
          ) : null}
        </>
      )}

      {/* Pointer target, always at least a full day column wide so 3px bars stay hoverable. */}
      <Bar
        x={centre - hitWidth / 2}
        y={0}
        width={hitWidth}
        height={plotHeight}
        fill="transparent"
        onMouseEnter={onPoint}
        onMouseMove={onPoint}
        onMouseLeave={onLeave}
        aria-hidden
      />

      {selected ? (
        <rect
          x={centre - Math.max(marker.width, 8) / 2 - 2}
          y={(marker.kind === 'deadline' ? 0 : marker.y) - 3}
          width={Math.max(marker.width, 8) + 4}
          height={(marker.kind === 'deadline' ? plotHeight : marker.height) + 6}
          rx={2}
          fill="none"
          stroke="var(--control)"
          strokeWidth={1.5}
          pointerEvents="none"
        />
      ) : null}
    </g>
  );
}

// ── tooltip ────────────────────────────────────────────────────────────────────────────

function MarkerTooltip({
  marker,
  locale,
  left,
  top,
}: {
  readonly marker: PlacedMarker;
  readonly locale: string;
  readonly left: number;
  readonly top: number;
}): React.ReactNode {
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-line-strong bg-ink-700 px-2.5 py-2 shadow-overlay"
      style={{ left, top }}
    >
      <p className="whitespace-nowrap text-[0.8125rem] font-medium leading-tight text-text">
        {marker.label}
      </p>
      <p className="mt-1 flex items-baseline gap-2 whitespace-nowrap">
        {marker.kind === 'deadline' || marker.amountMinor === null || marker.currency === null ? (
          <span className="text-xs font-medium text-alert">
            {marker.missed ? 'Cancel-by date passed' : 'Cancel by this date'}
          </span>
        ) : (
          <Money
            amountMinor={marker.amountMinor}
            currency={marker.currency}
            tone="outflow"
            size="md"
          />
        )}
        <span className="font-mono text-[0.6875rem] text-text-3">
          {formatDay(marker.date, locale, { weekday: 'short', month: 'short', day: 'numeric' })}
        </span>
      </p>
      {marker.isTrialConversion ? (
        <p className="mt-1 text-[0.6875rem] text-alert">Trial converts to a paid plan</p>
      ) : null}
      {marker.variableAmount ? (
        <p className="mt-1 text-[0.6875rem] text-text-3">Amount varies — shown as the median</p>
      ) : null}
    </div>
  );
}

// ── legend ─────────────────────────────────────────────────────────────────────────────

function Legend({
  hasTrial,
  hasDeadline,
}: {
  readonly hasTrial: boolean;
  readonly hasDeadline: boolean;
}): React.ReactNode {
  if (!hasTrial && !hasDeadline) return null;
  return (
    <ul className="mt-[var(--gap-tight)] flex flex-wrap items-center gap-x-[var(--gap-loose)] gap-y-1">
      {hasTrial ? (
        <li className="eyebrow flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-0 border-x-4 border-b-[6px] border-x-transparent border-b-alert" />
          Trial converts
        </li>
      ) : null}
      {hasDeadline ? (
        <li className="eyebrow flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-3 w-px bg-alert" />
          Cancel by
        </li>
      ) : null}
    </ul>
  );
}

// ── screen-reader table ────────────────────────────────────────────────────────────────

/**
 * Every charge in the window, including the ones the narrow-viewport chart had to drop.
 *
 * This is the chart's real content in a form a screen reader can navigate cell by cell. It is
 * not a summary — a summary would be a different, smaller claim than the one the picture makes.
 */
function ChargeTable({
  charges,
  deadlines,
  locale,
  totalDays,
}: {
  readonly charges: readonly HorizonCharge[];
  readonly deadlines: readonly HorizonDeadline[];
  readonly locale: string;
  readonly totalDays: number;
}): React.ReactNode {
  return (
    <div className="sr-only">
      <table>
        <caption>Every charge in the next {totalDays} days</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Subscription</th>
            <th scope="col">Amount</th>
            <th scope="col">Note</th>
          </tr>
        </thead>
        <tbody>
          {charges.length === 0 ? (
            <tr>
              <td colSpan={4}>No charges in this window.</td>
            </tr>
          ) : (
            charges.map((charge, index) => (
              <tr key={`${charge.subscriptionId}-${charge.date}-${String(index)}`}>
                <td>
                  {formatDay(parsePlainDate(charge.date), locale, {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric',
                  })}
                </td>
                <td>{charge.displayName}</td>
                <td>{describeAmount(charge.amountMinor, charge.currency, locale)}</td>
                <td>
                  {[
                    charge.isTrialConversion ? 'Trial converts to a paid plan' : '',
                    charge.variableAmount ? 'Amount varies' : '',
                  ]
                    .filter((note) => note !== '')
                    .join('. ')}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {deadlines.length > 0 ? (
        <>
          <h3>Cancel-by dates</h3>
          <ul>
            {deadlines.map((deadline) => (
              <li key={`${deadline.subscriptionId}-${deadline.date}`}>
                {deadline.displayName} —{' '}
                {deadline.missed === true ? 'cancel-by date passed on ' : 'cancel by '}
                {formatDay(parsePlainDate(deadline.date), locale, {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                })}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

// ── layout ─────────────────────────────────────────────────────────────────────────────

interface LayoutArgs {
  readonly charges: readonly HorizonCharge[];
  readonly deadlines: readonly HorizonDeadline[];
  readonly start: PlainDate;
  readonly slotCount: number;
  readonly xScale: ReturnType<typeof scaleBand<number>>;
  readonly plotHeight: number;
}

interface LayoutResult {
  readonly markers: readonly PlacedMarker[];
  readonly rules: readonly DayRule[];
  /** Mutable by necessity — `AxisBottom.tickValues` will not take a readonly array. */
  readonly monthTicks: number[];
  readonly windowTotal: number;
}

/**
 * Turns dates and amounts into pixels.
 *
 * The height scale's domain is the largest *day total*, not the largest single charge: the
 * stack has to fit, and scaling to the biggest single charge means a day with six of them runs
 * off the top of the plot. 88% of the plot height is used so the trial triangle and the floors
 * applied to sub-pixel charges have somewhere to go.
 */
function layout({
  charges,
  deadlines,
  start,
  slotCount,
  xScale,
  plotHeight,
}: LayoutArgs): LayoutResult {
  const dayIndex = (iso: string): number => {
    try {
      return daysBetween(start, parsePlainDate(iso));
    } catch {
      return -1;
    }
  };

  const byDay = new Map<number, HorizonCharge[]>();
  let windowTotal = 0;
  for (const charge of charges) {
    const index = dayIndex(charge.date);
    if (index < 0 || index >= slotCount) continue;
    windowTotal += charge.amountMinor;
    const bucket = byDay.get(index);
    if (bucket === undefined) byDay.set(index, [charge]);
    else bucket.push(charge);
  }

  let peak = 0;
  for (const bucket of byDay.values()) {
    const total = bucket.reduce((sum, charge) => sum + magnitude(charge.amountMinor, charge.currency), 0);
    if (total > peak) peak = total;
  }

  const yScale = scaleLinear<number>({
    domain: [0, peak === 0 ? 1 : peak],
    range: [0, plotHeight * 0.88],
  });

  const bandWidth = xScale.bandwidth();
  const tickWidth = Math.max(2, Math.min(MAX_TICK_WIDTH, bandWidth));
  const bandX = (index: number): number => xScale(index) ?? index * xScale.step();

  const markers: PlacedMarker[] = [];

  for (const [index, bucket] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    const centre = bandX(index) + bandWidth / 2;
    let stacked = 0;
    // Largest first, so the biggest charge of the day sits on the baseline where it is easiest
    // to compare against its neighbours.
    const ordered = [...bucket].sort((a, b) => b.amountMinor - a.amountMinor);

    for (const [position, charge] of ordered.entries()) {
      const remaining = plotHeight - stacked;
      const raw = Math.max(MIN_TICK_HEIGHT, yScale(magnitude(charge.amountMinor, charge.currency)));
      const height = Math.max(1, Math.min(raw, remaining));
      markers.push({
        key: `c-${charge.subscriptionId}-${charge.date}-${String(position)}`,
        kind: 'charge',
        dayIndex: index,
        date: addDays(start, index),
        label: charge.displayName,
        subscriptionId: charge.subscriptionId,
        amountMinor: charge.amountMinor,
        currency: charge.currency,
        variableAmount: charge.variableAmount,
        isTrialConversion: charge.isTrialConversion,
        missed: false,
        x: centre - tickWidth / 2,
        y: plotHeight - stacked - height,
        width: tickWidth,
        height,
      });
      stacked += height + SEGMENT_GAP;
      if (stacked >= plotHeight) break;
    }
  }

  for (const deadline of deadlines) {
    const index = dayIndex(deadline.date);
    if (index < 0 || index >= slotCount) continue;
    markers.push({
      key: `d-${deadline.subscriptionId}-${deadline.date}`,
      kind: 'deadline',
      dayIndex: index,
      date: addDays(start, index),
      label: deadline.displayName,
      subscriptionId: deadline.subscriptionId,
      amountMinor: null,
      currency: null,
      variableAmount: false,
      isTrialConversion: false,
      missed: deadline.missed === true,
      x: bandX(index) + bandWidth / 2 - 0.5,
      y: 0,
      width: 1,
      height: plotHeight,
    });
  }

  // Reading order, which is also arrow-key order: left to right, deadline after the day's
  // charges so the amounts come first and the deadline reads as a note on the day.
  markers.sort(
    (a, b) =>
      a.dayIndex - b.dayIndex ||
      (a.kind === b.kind ? b.height - a.height : a.kind === 'charge' ? -1 : 1),
  );

  const rules: DayRule[] = [];
  const monthTicks: number[] = [0];
  for (let index = 0; index < slotCount; index += 1) {
    const date = addDays(start, index);
    const weight = date.day === 1 ? 'month' : dayOfWeek(date) === 1 ? 'week' : 'day';
    rules.push({ index, x: index * xScale.step(), weight });
    if (date.day === 1 && index > 0) monthTicks.push(index);
  }

  return { markers, rules, monthTicks, windowTotal };
}
