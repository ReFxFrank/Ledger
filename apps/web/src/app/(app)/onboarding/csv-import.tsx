'use client';

import { useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { FileUp, Upload } from 'lucide-react';
import {
  CATEGORIES,
  type Category,
  type IntervalUnit,
  formatPlainDate,
  fromInstant,
  parseMoney,
} from '@ledger/core';
import { Button, Money, ScrollArea, toast } from '@ledger/ui';
import { FormError } from '~/components/auth/field';
import { api } from '~/lib/trpc';

/**
 * CSV import.
 *
 * Everyone arriving from a spreadsheet already has the list; asking them to retype it is the
 * fastest way to lose them. The rules are stated on screen before a file is picked, the file is
 * parsed in the browser, and every row is shown with its verdict *before* anything is written —
 * a silent partial import is the worst outcome available here.
 *
 * Rows are created one call at a time because there is no bulk endpoint, and inventing one from
 * the client by firing two hundred parallel mutations is how a rate limiter eats half an import.
 */

const COLUMN_ALIASES: Readonly<Record<string, string>> = {
  name: 'name',
  subscription: 'name',
  service: 'name',
  merchant: 'name',
  description: 'name',

  amount: 'amount',
  price: 'amount',
  cost: 'amount',

  currency: 'currency',

  period: 'period',
  interval: 'period',
  frequency: 'period',
  cycle: 'period',

  date: 'date',
  'next charge': 'date',
  'next payment': 'date',
  'start date': 'date',
  'renewal date': 'date',

  category: 'category',
};

const PERIODS: Readonly<Record<string, { unit: IntervalUnit; count: number }>> = {
  weekly: { unit: 'week', count: 1 },
  week: { unit: 'week', count: 1 },
  fortnightly: { unit: 'week', count: 2 },
  biweekly: { unit: 'week', count: 2 },
  '4-weekly': { unit: 'week', count: 4 },
  monthly: { unit: 'month', count: 1 },
  month: { unit: 'month', count: 1 },
  quarterly: { unit: 'month', count: 3 },
  quarter: { unit: 'month', count: 3 },
  'semi-annual': { unit: 'month', count: 6 },
  'half-yearly': { unit: 'month', count: 6 },
  annual: { unit: 'year', count: 1 },
  annually: { unit: 'year', count: 1 },
  yearly: { unit: 'year', count: 1 },
  year: { unit: 'year', count: 1 },
};

interface ParsedRow {
  readonly line: number;
  readonly name: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly unit: IntervalUnit;
  readonly count: number;
  readonly anchorDate: string;
  readonly category: Category;
}

interface RejectedRow {
  readonly line: number;
  readonly raw: string;
  readonly reason: string;
}

/**
 * A minimal RFC 4180 reader: quoted fields, doubled quotes inside them, CRLF or LF.
 *
 * Hand-rolled rather than split(',') because a subscription called `Adobe, Inc.` is not two
 * columns, and that is the exact row a naive split gets wrong in every real export.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char ?? '';
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      // A CRLF is one break, not two empty rows.
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char ?? '';
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((entry) => entry.some((value) => value.trim() !== ''));
}

function normalizeDate(value: string, fallback: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return fallback;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) return trimmed;
  // Slash-separated dates are ambiguous between US and everywhere else, so they are refused
  // rather than guessed — a wrong anchor date silently shifts every projected renewal.
  return null;
}

export interface CsvImportProps {
  readonly defaultCurrency: string;
  readonly timezone: string;
  readonly onImported: (count: number) => void;
}

export function CsvImport({ defaultCurrency, timezone, onImported }: CsvImportProps): ReactNode {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [rows, setRows] = useState<readonly ParsedRow[]>([]);
  const [rejected, setRejected] = useState<readonly RejectedRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  const utils = api.useUtils();
  const create = api.subscriptions.create.useMutation();

  const today = formatPlainDate(fromInstant(new Date(), timezone));

  function readFile(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    if (file === undefined) return;

    setError(null);
    setRows([]);
    setRejected([]);

    void file
      .text()
      .then((text) => {
        const parsed = parseCsv(text);
        const header = parsed[0];
        if (header === undefined) {
          setError('That file is empty.');
          return;
        }

        const columns = header.map((label) => COLUMN_ALIASES[label.trim().toLowerCase()] ?? '');
        const nameIndex = columns.indexOf('name');
        const amountIndex = columns.indexOf('amount');

        if (nameIndex < 0 || amountIndex < 0) {
          setError(
            'The first row has to name the columns, and it needs at least "name" and "amount". Rename the headers and pick the file again.',
          );
          return;
        }

        const currencyIndex = columns.indexOf('currency');
        const periodIndex = columns.indexOf('period');
        const dateIndex = columns.indexOf('date');
        const categoryIndex = columns.indexOf('category');

        const accepted: ParsedRow[] = [];
        const failed: RejectedRow[] = [];

        for (let index = 1; index < parsed.length; index += 1) {
          const cells = parsed[index] ?? [];
          const line = index + 1;
          const raw = cells.join(', ');

          const name = (cells[nameIndex] ?? '').trim();
          if (name === '') {
            failed.push({ line, raw, reason: 'No name.' });
            continue;
          }

          const currency = (currencyIndex < 0 ? '' : (cells[currencyIndex] ?? '').trim().toUpperCase()) || defaultCurrency;

          let amountMinor: number;
          try {
            amountMinor = parseMoney(cells[amountIndex] ?? '', currency).amountMinor;
          } catch {
            failed.push({ line, raw, reason: 'The amount could not be read.' });
            continue;
          }
          if (amountMinor <= 0) {
            failed.push({ line, raw, reason: 'The amount is zero or negative.' });
            continue;
          }

          const periodText = (periodIndex < 0 ? '' : (cells[periodIndex] ?? '').trim().toLowerCase());
          // Monthly is the default because it is what most of a subscription list is, and the
          // preview shows the period on every row so a wrong guess is visible before it is saved.
          const period = periodText === '' ? PERIODS.monthly : PERIODS[periodText];
          if (period === undefined) {
            failed.push({ line, raw, reason: `"${periodText}" is not a billing period we recognise.` });
            continue;
          }

          const anchorDate = normalizeDate(dateIndex < 0 ? '' : (cells[dateIndex] ?? ''), today);
          if (anchorDate === null) {
            failed.push({ line, raw, reason: 'The date has to be written as YYYY-MM-DD.' });
            continue;
          }

          const categoryText = (categoryIndex < 0 ? '' : (cells[categoryIndex] ?? '').trim().toLowerCase().replace(/[\s-]+/gu, '_'));
          const category = (CATEGORIES as readonly string[]).includes(categoryText)
            ? (categoryText as Category)
            : 'other';

          accepted.push({
            line,
            name,
            amountMinor,
            currency,
            unit: period.unit,
            count: period.count,
            anchorDate,
            category,
          });
        }

        setRows(accepted);
        setRejected(failed);
        if (accepted.length === 0 && failed.length === 0) setError('That file has a header but no rows.');
      })
      .catch(() => {
        setError('That file could not be read. Save it as CSV and try again.');
      });
  }

  async function importAll(): Promise<void> {
    setError(null);
    let done = 0;
    const failures: RejectedRow[] = [];

    for (const row of rows) {
      setProgress(done);
      try {
        await create.mutateAsync({
          displayName: row.name,
          amountMinor: row.amountMinor,
          currency: row.currency,
          intervalUnit: row.unit,
          intervalCount: row.count,
          anchorDate: row.anchorDate,
          category: row.category,
          status: 'active',
          billingChannel: 'unknown',
          autoRenew: true,
          variableAmount: false,
          tags: [],
        });
        done += 1;
      } catch (thrown) {
        // One bad row does not abandon the rest — the ones that landed are still worth having,
        // and the failures are listed so the user knows exactly what to fix.
        failures.push({
          line: row.line,
          raw: row.name,
          reason: thrown instanceof Error ? thrown.message : 'The server refused this row.',
        });
      }
    }

    setProgress(null);
    setRows([]);
    setRejected(failures);
    await utils.subscriptions.list.invalidate();
    await utils.dashboard.totals.invalidate();

    if (done > 0) {
      toast(done === 1 ? '1 subscription imported.' : `${done} subscriptions imported.`);
      onImported(done);
    }
    if (failures.length > 0) {
      setError(
        failures.length === 1
          ? '1 row could not be saved. It is listed below.'
          : `${failures.length} rows could not be saved. They are listed below.`,
      );
    }
  }

  return (
    <div className="flex flex-col gap-[var(--gap-loose)]">
      <FormError>{error}</FormError>

      <div className="rounded-md border border-line bg-ink-900 p-[var(--pad-card)]">
        <p className="eyebrow">Expected columns</p>
        <p className="mt-1.5 font-mono text-xs leading-relaxed text-text-2">
          name, amount, currency, period, date, category
        </p>
        <p className="mt-1.5 text-[0.6875rem] leading-snug text-text-3">
          Only name and amount are required. Period accepts weekly, monthly, quarterly or yearly
          and defaults to monthly; dates are YYYY-MM-DD and default to today.
        </p>
      </div>

      <div>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          onChange={readFile}
        />
        <Button
          type="button"
          onClick={() => {
            fileInput.current?.click();
          }}
        >
          <FileUp aria-hidden className="size-4" strokeWidth={1.75} />
          Choose a CSV file
        </Button>
      </div>

      {rows.length > 0 ? (
        <div className="flex flex-col gap-[var(--gap)]">
          <p className="eyebrow">
            {rows.length === 1 ? '1 row ready' : `${rows.length} rows ready`}
          </p>
          <ScrollArea className="max-h-60 rounded-md border border-line">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-ink-700">
                <tr className="border-b border-line">
                  <th scope="col" className="px-2 py-1.5 font-medium text-text-2">Name</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium text-text-2">Amount</th>
                  <th scope="col" className="px-2 py-1.5 font-medium text-text-2">Period</th>
                  <th scope="col" className="px-2 py-1.5 font-medium text-text-2">Date</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${String(row.line)}-${row.name}`} className="border-b border-line last:border-b-0">
                    <td className="max-w-40 truncate px-2 py-1.5 text-text">{row.name}</td>
                    <td className="px-2 py-1.5 text-right">
                      {/* Rendered through Money so the preview reads exactly like the table it
                          is about to become — the point of a preview is that it is the same. */}
                      <Money amountMinor={row.amountMinor} currency={row.currency} size="sm" />
                    </td>
                    <td className="px-2 py-1.5 text-text-2">
                      {row.count === 1 ? row.unit : `${String(row.count)} ${row.unit}s`}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-text-2">{row.anchorDate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>

          <Button
            type="button"
            variant="primary"
            loading={progress !== null}
            onClick={() => void importAll()}
            className="self-start"
          >
            <Upload aria-hidden className="size-4" strokeWidth={1.75} />
            {progress === null
              ? `Import ${String(rows.length)} ${rows.length === 1 ? 'subscription' : 'subscriptions'}`
              : `Importing ${String(progress + 1)} of ${String(rows.length)}`}
          </Button>
        </div>
      ) : null}

      {rejected.length > 0 ? (
        <div className="flex flex-col gap-[var(--gap-tight)]">
          <p className="eyebrow">Skipped</p>
          <ul className="flex flex-col gap-1">
            {rejected.map((row) => (
              <li key={`${String(row.line)}-${row.reason}`} className="text-xs leading-snug text-text-2">
                <span className="font-mono text-text-3">Line {row.line}</span> — {row.reason}{' '}
                <span className="text-text-3">{row.raw.slice(0, 60)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
