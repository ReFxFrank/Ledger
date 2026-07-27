'use client';

import * as React from 'react';
import { Table2 } from 'lucide-react';
import { Button, Panel, PanelBody, PanelHeader, cn } from '@ledger/ui';

/**
 * The frame every chart on this screen sits in.
 *
 * A chart is a picture of numbers, and a picture is not readable by everyone. So every chart here
 * ships with the numbers themselves, in a real `<table>`, in the DOM, always — not built on
 * demand, not a different dataset, the same rows the marks were drawn from.
 *
 * The table is visually hidden rather than absent, and the "Show numbers" button unhides *that*
 * table rather than rendering a second one. One node means the sighted reader and the screen
 * reader cannot be shown different figures, which is the failure mode a "data table fallback"
 * usually has.
 *
 * The SVG itself is `aria-hidden`: it is decoration once the table exists, and a screen reader
 * walking a Recharts tree reads out path coordinates.
 */

export interface ChartColumn<Row> {
  readonly key: string;
  readonly label: string;
  /** Cell text. Pre-formatted by the caller so the table and the axis agree exactly. */
  readonly value: (row: Row) => string;
  readonly numeric?: boolean;
}

export interface ChartFrameProps<Row> {
  readonly eyebrow: string;
  readonly caption: React.ReactNode;
  /** One sentence naming what the chart shows and its headline figure. Becomes the SVG's label. */
  readonly summary: string;
  readonly columns: readonly ChartColumn<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  readonly actions?: React.ReactNode;
  readonly footnote?: React.ReactNode;
  readonly children: React.ReactNode;
}

export function ChartFrame<Row>({
  eyebrow,
  caption,
  summary,
  columns,
  rows,
  rowKey,
  actions,
  footnote,
  children,
}: ChartFrameProps<Row>): React.ReactNode {
  const [showNumbers, setShowNumbers] = React.useState(false);
  const tableId = React.useId();

  return (
    <Panel className="flex min-w-0 flex-col">
      <PanelHeader
        eyebrow={eyebrow}
        actions={
          <div className="flex items-center gap-[var(--gap-tight)]">
            {actions}
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={showNumbers}
              aria-controls={tableId}
              onClick={() => {
                setShowNumbers((current) => !current);
              }}
            >
              <Table2 className="size-3.5" aria-hidden />
              {showNumbers ? 'Hide numbers' : 'Show numbers'}
            </Button>
          </div>
        }
      >
        {caption}
      </PanelHeader>

      <PanelBody className="flex min-w-0 flex-col gap-[var(--gap-loose)]">
        {/*
          `tabIndex={0}` so a keyboard user can reach the chart region and scroll it, and so the
          label is announced when they land on it. The label is the summary sentence, which is the
          same fact the caption states — a chart nobody can see should still say what it said.
        */}
        <figure
          role="img"
          tabIndex={0}
          aria-label={summary}
          className={cn(
            'm-0 min-w-0 rounded-sm outline-none',
            'focus-visible:[box-shadow:var(--focus-ring)]',
          )}
        >
          <div aria-hidden className="min-w-0">
            {children}
          </div>
          <figcaption className="sr-only">{summary}</figcaption>
        </figure>

        <div id={tableId} className={showNumbers ? 'min-w-0 overflow-x-auto' : 'sr-only'}>
          <table className="w-full min-w-[20rem] text-left text-xs">
            <caption className="sr-only">{summary}</caption>
            <thead>
              <tr className="border-b border-line">
                {columns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={cn('eyebrow py-1.5 pr-3 font-medium', column.numeric === true && 'text-right pr-0')}
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={rowKey(row)} className="border-b border-line last:border-b-0">
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={cn(
                        'py-1.5 pr-3 text-text-2',
                        column.numeric === true && 'pr-0 text-right font-mono tabular-nums',
                      )}
                    >
                      {column.value(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {footnote === undefined ? null : <div className="text-xs text-text-3">{footnote}</div>}
      </PanelBody>
    </Panel>
  );
}
