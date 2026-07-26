'use client';

/**
 * CSV import.
 *
 * The parser is hand-written and lives in this file. That is deliberate: a CSV parser is fifty
 * lines and the failure modes that matter — a quoted field containing a comma, a quoted field
 * containing a newline, a doubled quote, a stray BOM from Excel — are all in those fifty lines
 * and all testable. Pulling in a dependency to do it hides them.
 *
 * Two rules the flow is built around:
 *
 *  - **Amounts go through `parseMoney`.** "12.99", "12,99", "£1,299.00" all land on exact minor
 *    units, and a cell that cannot be read becomes a reported row rather than a wrong number.
 *  - **A bad row never costs a good one.** Every row is validated independently; the import
 *    creates the ones that parsed and reports the ones that did not, by line number.
 */

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowLeft, Check, FileUp, Upload } from 'lucide-react';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  type Category,
  type PlainDate,
  type RecurrenceInterval,
  formatPlainDate,
  interval,
  intervalLabel,
  isCurrencyCode,
  parseMoney,
  plainDate,
} from '@ledger/core';
import {
  Badge,
  Button,
  Input,
  Label,
  Money,
  Panel,
  PanelBody,
  PanelHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  cn,
  toast,
} from '@ledger/ui';
import { api } from '~/lib/trpc';
import { formatDay, todayIn } from '~/lib/format';

// ── the parser ───────────────────────────────────────────────────────────────────────────

/**
 * RFC 4180-shaped delimited text.
 *
 * State is just "inside quotes or not". A doubled quote inside a quoted field is a literal
 * quote; a newline inside a quoted field is data, not a row break. Both CRLF and LF end a row.
 */
export function parseDelimited(input: string, delimiter: string): string[][] {
  // Excel writes a BOM. Left in place it becomes part of the first header and every mapping
  // guess misses.
  const text = input.replace(/^\uFEFF/, '');

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;

  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (index < text.length) {
    const char = text[index] ?? '';

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field === '') {
      quoted = true;
      index += 1;
      continue;
    }
    if (char === delimiter) {
      pushField();
      index += 1;
      continue;
    }
    if (char === '\r') {
      // Swallow the LF of a CRLF pair rather than emitting an empty row for it.
      if (text[index + 1] === '\n') index += 1;
      pushRow();
      index += 1;
      continue;
    }
    if (char === '\n') {
      pushRow();
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  // A file that does not end in a newline still has a last row.
  if (field !== '' || row.length > 0) pushRow();

  // Excel likes to leave a trailing blank line; a row of one empty cell is not a row.
  return rows.filter((entry) => entry.some((cell) => cell.trim() !== ''));
}

const DELIMITERS = [',', ';', '\t', '|'] as const;

/** Picks whichever candidate appears most often outside quotes on the first line. */
export function detectDelimiter(input: string): string {
  const firstLine = input.replace(/^\uFEFF/, '').split(/\r?\n/)[0] ?? '';
  let best = ',';
  let bestCount = 0;
  for (const candidate of DELIMITERS) {
    const count = parseDelimited(firstLine, candidate)[0]?.length ?? 0;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

// ── field mapping ────────────────────────────────────────────────────────────────────────

const FIELDS = [
  { id: 'name', label: 'Name', required: true, hints: ['name', 'subscription', 'service', 'merchant', 'description'] },
  { id: 'amount', label: 'Amount', required: true, hints: ['amount', 'price', 'cost', 'charge', 'value'] },
  { id: 'currency', label: 'Currency', required: false, hints: ['currency', 'ccy'] },
  { id: 'cadence', label: 'Cadence', required: false, hints: ['cadence', 'interval', 'frequency', 'billing', 'period'] },
  { id: 'nextDate', label: 'Next date', required: false, hints: ['next', 'renew', 'date', 'due', 'start'] },
  { id: 'category', label: 'Category', required: false, hints: ['category', 'type', 'group'] },
] as const;

type FieldId = (typeof FIELDS)[number]['id'];

type Mapping = Readonly<Record<FieldId, number>>;

const UNMAPPED = -1;

/** First header whose text contains one of the field's hints. Beats making the user map six. */
function guessMapping(headers: readonly string[]): Mapping {
  const lowered = headers.map((header) => header.trim().toLowerCase());
  const used = new Set<number>();
  const mapping: Record<FieldId, number> = {
    name: UNMAPPED,
    amount: UNMAPPED,
    currency: UNMAPPED,
    cadence: UNMAPPED,
    nextDate: UNMAPPED,
    category: UNMAPPED,
  };

  for (const field of FIELDS) {
    const index = lowered.findIndex(
      (header, position) => !used.has(position) && field.hints.some((hint) => header.includes(hint)),
    );
    if (index >= 0) {
      mapping[field.id] = index;
      used.add(index);
    }
  }
  return mapping;
}

// ── value parsing ────────────────────────────────────────────────────────────────────────

type DateOrder = 'iso' | 'dmy' | 'mdy';

const CADENCE_WORDS: Readonly<Record<string, RecurrenceInterval>> = {
  daily: interval('day', 1),
  weekly: interval('week', 1),
  fortnightly: interval('week', 2),
  biweekly: interval('week', 2),
  monthly: interval('month', 1),
  quarterly: interval('month', 3),
  'semi-annual': interval('month', 6),
  semiannual: interval('month', 6),
  yearly: interval('year', 1),
  annual: interval('year', 1),
  annually: interval('year', 1),
};

export function parseCadence(raw: string): RecurrenceInterval | null {
  const value = raw.trim().toLowerCase();
  if (value === '') return null;

  const word = CADENCE_WORDS[value];
  if (word !== undefined) return word;

  // "every 3 months", "4-weekly", "2 week", "1 yr"
  const match = /(\d+)\s*[-\s]?\s*(day|week|month|year|yr|mo|wk)/.exec(value);
  if (match !== null) {
    const count = Number(match[1]);
    const unit = match[2];
    if (Number.isInteger(count) && count >= 1 && unit !== undefined) {
      const normalised = unit === 'yr' ? 'year' : unit === 'mo' ? 'month' : unit === 'wk' ? 'week' : unit;
      if (normalised === 'day' || normalised === 'week' || normalised === 'month' || normalised === 'year') {
        return interval(normalised, count);
      }
    }
  }

  for (const [key, value_] of Object.entries(CADENCE_WORDS)) {
    if (value.includes(key)) return value_;
  }
  if (/\bmonth\b/.test(value)) return interval('month', 1);
  if (/\byear\b/.test(value)) return interval('year', 1);
  if (/\bweek\b/.test(value)) return interval('week', 1);
  return null;
}

/**
 * Dates are parsed against an order the user picks, never guessed.
 *
 * 03/04/2026 is two different days depending on which side of the Atlantic wrote it, and
 * guessing wrong moves someone's renewal reminder by a month.
 */
export function parseImportedDate(raw: string, order: DateOrder): PlainDate | null {
  const value = raw.trim();
  if (value === '') return null;

  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(value);
  if (iso !== null) return build(iso[1], iso[2], iso[3]);

  const parts = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(value);
  if (parts === null) return null;

  const year = expandYear(parts[3]);
  return order === 'mdy' ? build(year, parts[1], parts[2]) : build(year, parts[2], parts[1]);
}

function build(year: string | undefined, month: string | undefined, day: string | undefined): PlainDate | null {
  if (year === undefined || month === undefined || day === undefined) return null;
  try {
    return plainDate(Number(year), Number(month), Number(day));
  } catch {
    return null;
  }
}

function expandYear(raw: string | undefined): string {
  if (raw === undefined) return '';
  return raw.length === 2 ? `20${raw}` : raw;
}

export function parseCategory(raw: string): Category | null {
  const value = raw.trim().toLowerCase();
  if (value === '') return null;
  const direct = CATEGORIES.find((category) => category === value);
  if (direct !== undefined) return direct;
  const byLabel = CATEGORIES.find((category) => CATEGORY_LABELS[category].toLowerCase() === value);
  return byLabel ?? null;
}

// ── row validation ───────────────────────────────────────────────────────────────────────

interface ReadyRow {
  readonly line: number;
  readonly displayName: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly cadence: RecurrenceInterval;
  readonly anchorDate: PlainDate;
  readonly category: Category;
}

interface RejectedRow {
  readonly line: number;
  readonly reason: string;
  readonly preview: string;
}

interface Validation {
  readonly ready: readonly ReadyRow[];
  readonly rejected: readonly RejectedRow[];
}

interface ValidateOptions {
  readonly rows: readonly (readonly string[])[];
  readonly mapping: Mapping;
  readonly hasHeader: boolean;
  readonly defaultCurrency: string;
  readonly defaultCadence: RecurrenceInterval;
  readonly dateOrder: DateOrder;
  readonly today: PlainDate;
}

function validate(options: ValidateOptions): Validation {
  const ready: ReadyRow[] = [];
  const rejected: RejectedRow[] = [];
  const body = options.hasHeader ? options.rows.slice(1) : options.rows;
  const offset = options.hasHeader ? 2 : 1;

  body.forEach((cells, index) => {
    const line = index + offset;
    const preview = cells.slice(0, 4).join(' · ');
    const cell = (field: FieldId): string => {
      const position = options.mapping[field];
      return position === UNMAPPED ? '' : (cells[position] ?? '');
    };

    const displayName = cell('name').trim();
    if (displayName === '') {
      rejected.push({ line, reason: 'No name in the mapped column.', preview });
      return;
    }

    const currencyCell = cell('currency').trim().toUpperCase();
    const currency = currencyCell !== '' && isCurrencyCode(currencyCell) ? currencyCell : options.defaultCurrency;
    if (currencyCell !== '' && !isCurrencyCode(currencyCell)) {
      rejected.push({ line, reason: `"${currencyCell}" is not a currency code we know.`, preview });
      return;
    }

    const amountCell = cell('amount').trim();
    if (amountCell === '') {
      rejected.push({ line, reason: 'No amount in the mapped column.', preview });
      return;
    }

    let amountMinor: number;
    try {
      amountMinor = parseMoney(amountCell, currency).amountMinor;
    } catch {
      rejected.push({ line, reason: `Could not read "${amountCell}" as an amount.`, preview });
      return;
    }

    const cadenceCell = cell('cadence').trim();
    const cadence = cadenceCell === '' ? options.defaultCadence : parseCadence(cadenceCell);
    if (cadence === null) {
      rejected.push({ line, reason: `Could not read "${cadenceCell}" as a cadence.`, preview });
      return;
    }

    const dateCell = cell('nextDate').trim();
    const parsedDate = dateCell === '' ? options.today : parseImportedDate(dateCell, options.dateOrder);
    if (parsedDate === null) {
      rejected.push({ line, reason: `Could not read "${dateCell}" as a date.`, preview });
      return;
    }

    // An unrecognised category is not worth losing a row over — it lands in "Other", which is
    // one bulk edit away, rather than in the rejected list.
    const category = parseCategory(cell('category')) ?? 'other';

    ready.push({ line, displayName, amountMinor, currency, cadence, anchorDate: parsedDate, category });
  });

  return { ready, rejected };
}

// ── the screen ───────────────────────────────────────────────────────────────────────────

interface ImportOutcome {
  readonly created: number;
  readonly failures: readonly RejectedRow[];
}

export function CsvImport(): React.ReactElement {
  const utils = api.useUtils();
  const me = api.me.current.useQuery();

  const [raw, setRaw] = React.useState('');
  const [delimiter, setDelimiter] = React.useState(',');
  const [hasHeader, setHasHeader] = React.useState(true);
  const [dateOrder, setDateOrder] = React.useState<DateOrder>('iso');
  const [defaultCurrency, setDefaultCurrency] = React.useState('GBP');
  const [defaultCadenceKey, setDefaultCadenceKey] = React.useState('month:1');
  const [mapping, setMapping] = React.useState<Mapping>(() => guessMapping([]));
  const [running, setRunning] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [outcome, setOutcome] = React.useState<ImportOutcome | null>(null);

  const locale = me.data?.locale ?? 'en-GB';
  const timezone = me.data?.timezone ?? 'UTC';
  const today = React.useMemo(() => todayIn(timezone), [timezone]);

  React.useEffect(() => {
    if (me.data?.displayCurrency !== undefined) setDefaultCurrency(me.data.displayCurrency);
  }, [me.data?.displayCurrency]);

  const rows = React.useMemo(
    () => (raw.trim() === '' ? [] : parseDelimited(raw, delimiter)),
    [raw, delimiter],
  );
  const headers = React.useMemo(
    () => (hasHeader ? (rows[0] ?? []) : (rows[0] ?? []).map((_cell, index) => `Column ${String(index + 1)}`)),
    [rows, hasHeader],
  );

  // Re-guess whenever a new file lands, but never overwrite a mapping the user has adjusted for
  // the file they are already looking at.
  const guessedFor = React.useRef('');
  React.useEffect(() => {
    const signature = headers.join('|');
    if (signature === guessedFor.current || headers.length === 0) return;
    guessedFor.current = signature;
    setMapping(guessMapping(hasHeader ? headers : []));
  }, [headers, hasHeader]);

  const defaultCadence = React.useMemo(() => {
    const [unit, count] = defaultCadenceKey.split(':');
    if (unit === 'day' || unit === 'week' || unit === 'month' || unit === 'year') {
      return interval(unit, Number(count ?? '1'));
    }
    return interval('month', 1);
  }, [defaultCadenceKey]);

  const result = React.useMemo(
    () => validate({ rows, mapping, hasHeader, defaultCurrency, defaultCadence, dateOrder, today }),
    [rows, mapping, hasHeader, defaultCurrency, defaultCadence, dateOrder, today],
  );

  const create = api.subscriptions.create.useMutation();

  function loadFile(file: File): void {
    void file.text().then(
      (text) => {
        setOutcome(null);
        setDelimiter(detectDelimiter(text));
        setRaw(text);
      },
      () => {
        toast.error('Could not read that file.');
      },
    );
  }

  async function runImport(): Promise<void> {
    setRunning(true);
    setProgress(0);
    const failures: RejectedRow[] = [];
    let created = 0;

    // Sequential on purpose. There is no bulk-create procedure, and firing 200 mutations at once
    // would trip rate limiting and lose the row-level error reporting that makes this usable.
    for (const row of result.ready) {
      try {
        await create.mutateAsync({
          displayName: row.displayName,
          amountMinor: row.amountMinor,
          currency: row.currency,
          intervalUnit: row.cadence.unit,
          intervalCount: row.cadence.count,
          // The anchor is the date the cadence is measured from, so an imported "next date" is
          // exactly that — the server projects every future renewal forward from here.
          anchorDate: formatPlainDate(row.anchorDate),
          category: row.category,
        });
        created += 1;
      } catch (error) {
        failures.push({
          line: row.line,
          reason: error instanceof Error ? error.message : 'The server refused that row.',
          preview: row.displayName,
        });
      }
      setProgress((current) => current + 1);
    }

    await utils.subscriptions.list.invalidate();
    await utils.dashboard.totals.invalidate();
    setRunning(false);
    setOutcome({ created, failures: [...failures] });
    toast.success(`${String(created)} imported.`);
  }

  return (
    <div className="flex flex-col gap-[var(--gap-loose)]">
      <Panel>
        <PanelHeader
          eyebrow="Source"
          actions={
            <Button size="sm" variant="ghost" asChild>
              <Link href="/subscriptions">
                <ArrowLeft className="size-3.5" aria-hidden />
                Back
              </Link>
            </Button>
          }
        >
          Upload a CSV, or paste one. Nothing is created until you confirm.
        </PanelHeader>
        <PanelBody className="flex flex-col gap-[var(--gap-loose)]">
          <div className="flex flex-wrap items-end gap-[var(--gap-tight)]">
            <div className="flex min-w-0 grow flex-col gap-1">
              <Label htmlFor="csv-file">File</Label>
              <Input
                id="csv-file"
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/plain"
                className="h-9 py-1.5 file:mr-2 file:rounded-sm file:border-0 file:bg-ink-600 file:px-2 file:py-1 file:text-xs file:text-text"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined) loadFile(file);
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="csv-delimiter">Delimiter</Label>
              <Select
                value={delimiter}
                onValueChange={(value) => {
                  setDelimiter(value);
                }}
              >
                <SelectTrigger id="csv-delimiter" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value=",">Comma</SelectItem>
                  <SelectItem value=";">Semicolon</SelectItem>
                  <SelectItem value={'\t'}>Tab</SelectItem>
                  <SelectItem value="|">Pipe</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-1.5 pb-2">
              <Switch id="csv-header" checked={hasHeader} onCheckedChange={setHasHeader} />
              <Label htmlFor="csv-header">First row is a header</Label>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="csv-paste">Or paste it</Label>
            <Textarea
              id="csv-paste"
              rows={4}
              value={raw}
              placeholder={'Name,Amount,Cadence,Next date\nNetflix,12.99,monthly,2026-08-14'}
              className="font-mono text-xs"
              onChange={(event) => {
                setOutcome(null);
                setRaw(event.target.value);
              }}
            />
          </div>
        </PanelBody>
      </Panel>

      {rows.length === 0 ? null : (
        <>
          <Panel>
            <PanelHeader eyebrow="Columns">
              Point each field at a column. Name and amount are the two that matter.
            </PanelHeader>
            <PanelBody className="grid gap-[var(--gap)] sm:grid-cols-2 lg:grid-cols-3">
              {FIELDS.map((field) => (
                <div key={field.id} className="flex flex-col gap-1">
                  <Label required={field.required}>{field.label}</Label>
                  <Select
                    value={String(mapping[field.id])}
                    onValueChange={(value) => {
                      setMapping((current) => ({ ...current, [field.id]: Number(value) }));
                    }}
                  >
                    <SelectTrigger aria-label={`Column for ${field.label}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={String(UNMAPPED)}>Not in this file</SelectItem>
                      {headers.map((header, index) => (
                        <SelectItem key={`${header}-${String(index)}`} value={String(index)}>
                          {header.trim() === '' ? `Column ${String(index + 1)}` : header}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}

              <div className="flex flex-col gap-1">
                <Label htmlFor="csv-currency">Currency when the file has none</Label>
                <Input
                  id="csv-currency"
                  mono
                  maxLength={3}
                  className="uppercase"
                  value={defaultCurrency}
                  onChange={(event) => {
                    setDefaultCurrency(event.target.value.toUpperCase());
                  }}
                />
              </div>

              <div className="flex flex-col gap-1">
                <Label htmlFor="csv-cadence">Cadence when the file has none</Label>
                <Select value={defaultCadenceKey} onValueChange={setDefaultCadenceKey}>
                  <SelectTrigger id="csv-cadence">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="week:1">Weekly</SelectItem>
                    <SelectItem value="month:1">Monthly</SelectItem>
                    <SelectItem value="month:3">Quarterly</SelectItem>
                    <SelectItem value="year:1">Annually</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1">
                <Label htmlFor="csv-dates">Date order</Label>
                <Select
                  value={dateOrder}
                  onValueChange={(value) => {
                    setDateOrder(value === 'dmy' || value === 'mdy' ? value : 'iso');
                  }}
                >
                  <SelectTrigger id="csv-dates">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="iso">2026-08-14</SelectItem>
                    <SelectItem value="dmy">14/08/2026</SelectItem>
                    <SelectItem value="mdy">08/14/2026</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[0.6875rem] leading-tight text-text-3">
                  03/04/2026 is two different days depending on who wrote the file, so this is a
                  choice rather than a guess.
                </p>
              </div>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader
              eyebrow="What will be created"
              actions={
                <div className="flex items-center gap-1.5">
                  <Badge tone="control" mono>
                    {result.ready.length} ready
                  </Badge>
                  {result.rejected.length > 0 ? (
                    <Badge tone="alert" mono>
                      {result.rejected.length} skipped
                    </Badge>
                  ) : null}
                </div>
              }
            />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-[0.8125rem]">
                <thead>
                  <tr className="border-b border-line text-left">
                    <th className="eyebrow px-[var(--pad-panel)] py-1.5">Name</th>
                    <th className="eyebrow px-[var(--pad-panel)] py-1.5 text-right">Amount</th>
                    <th className="eyebrow px-[var(--pad-panel)] py-1.5">Cadence</th>
                    <th className="eyebrow px-[var(--pad-panel)] py-1.5">Anchor date</th>
                    <th className="eyebrow px-[var(--pad-panel)] py-1.5">Category</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {result.ready.slice(0, 8).map((row) => (
                    <tr key={row.line}>
                      <td className="truncate px-[var(--pad-panel)] py-1.5 text-text">{row.displayName}</td>
                      <td className="px-[var(--pad-panel)] py-1.5 text-right">
                        <Money
                          amountMinor={row.amountMinor}
                          currency={row.currency}
                          tone="outflow"
                          locale={locale}
                        />
                      </td>
                      <td className="px-[var(--pad-panel)] py-1.5 text-text-2">{intervalLabel(row.cadence)}</td>
                      <td className="px-[var(--pad-panel)] py-1.5 font-mono text-xs text-text-2">
                        {formatDay(row.anchorDate, locale)}
                      </td>
                      <td className="px-[var(--pad-panel)] py-1.5 text-text-2">
                        {CATEGORY_LABELS[row.category]}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {result.ready.length > 8 ? (
              <p className="border-t border-line px-[var(--pad-panel)] py-1.5 text-xs text-text-3">
                and {result.ready.length - 8} more
              </p>
            ) : null}
          </Panel>

          {result.rejected.length === 0 ? null : (
            <Panel className="border-alert/25">
              <PanelHeader eyebrow="Rows that will be skipped">
                These are reported by line number and left out. Everything else still imports.
              </PanelHeader>
              <ul className="divide-y divide-line">
                {result.rejected.map((row) => (
                  <li
                    key={`${String(row.line)}-${row.reason}`}
                    className="flex items-start gap-2 px-[var(--pad-panel)] py-2"
                  >
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-alert" aria-hidden />
                    <div className="min-w-0">
                      <p className="text-[0.8125rem] text-text">
                        <span className="font-mono text-text-3">Line {row.line}</span> — {row.reason}
                      </p>
                      <p className="truncate font-mono text-[0.6875rem] text-text-3">{row.preview}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <div className="flex flex-wrap items-center justify-end gap-[var(--gap-tight)]">
            {running ? (
              <span className="font-mono text-xs text-text-2" aria-live="polite">
                {progress} / {result.ready.length}
              </span>
            ) : null}
            <Button
              size="md"
              variant="primary"
              loading={running}
              disabled={result.ready.length === 0}
              onClick={() => {
                void runImport();
              }}
            >
              <Upload className="size-3.5" aria-hidden />
              Import {result.ready.length} subscription{result.ready.length === 1 ? '' : 's'}
            </Button>
          </div>
        </>
      )}

      {outcome === null ? null : (
        <Panel className={cn(outcome.failures.length > 0 && 'border-alert/25')}>
          <PanelHeader eyebrow="Result" />
          <PanelBody className="flex flex-col gap-[var(--gap-tight)]">
            <p className="flex items-center gap-1.5 text-[0.8125rem] text-text">
              <Check className="size-3.5 text-control-2" aria-hidden />
              {outcome.created} created.
            </p>
            {outcome.failures.map((failure) => (
              <p key={`${String(failure.line)}-${failure.reason}`} className="text-xs text-alert">
                Line {failure.line} — {failure.reason}
              </p>
            ))}
            <div className="mt-1 flex gap-[var(--gap-tight)]">
              <Button size="sm" variant="secondary" asChild>
                <Link href="/subscriptions">
                  <FileUp className="size-3.5" aria-hidden />
                  See them in the table
                </Link>
              </Button>
            </div>
          </PanelBody>
        </Panel>
      )}
    </div>
  );
}
