'use client';

/**
 * CSV import.
 *
 * Two paths, and choosing between them is the first thing the screen asks.
 *
 *  - **Find recurring charges** (the default). A bank export is not a list of subscriptions; it
 *    is a list of everything that moved. Twelve months of a Chase current account is a few
 *    hundred Uber Eats orders, some Zelle payments to friends, a paycheque a fortnight, and —
 *    somewhere in there — eleven things that actually repeat. This path sends the rows to
 *    `@ledger/detection`, the engine that exists for exactly this, and lands the survivors in the
 *    review queue. It is the default because the file people arrive with is a bank export.
 *  - **Create these as subscriptions**. The original behaviour, one subscription per row, no
 *    analysis. Correct for a hand-written list of six things you already know you pay for, and
 *    catastrophic for a bank export — pointed at one it offers to create 553 subscriptions, one
 *    per transaction. So it is still here, and it is no longer the default, and it says on the
 *    tab what it does.
 *
 * The parser is hand-written and lives in this file. That is deliberate: a CSV parser is fifty
 * lines and the failure modes that matter — a quoted field containing a comma, a quoted field
 * containing a newline, a doubled quote, a stray BOM from Excel — are all in those fifty lines
 * and all testable. Pulling in a dependency to do it hides them.
 *
 * Two rules both paths are built around:
 *
 *  - **Amounts go through `parseMoney`.** "12.99", "12,99", "£1,299.00" all land on exact minor
 *    units, and a cell that cannot be read becomes a reported row rather than a wrong number.
 *  - **A bad row never costs a good one.** Every row is validated independently; the import
 *    creates — or analyses — the ones that parsed and reports the ones that did not, by line
 *    number.
 */

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowLeft, Check, FileUp, ListChecks, Search, Upload } from 'lucide-react';
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  cn,
  toast,
} from '@ledger/ui';
import type { ImportAnalysis } from '~/lib/api-types';
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

// ── the two paths ────────────────────────────────────────────────────────────────────────

export type ImportMode = 'analyse' | 'create';

// ── field mapping ────────────────────────────────────────────────────────────────────────

/**
 * One row of the mapping form.
 *
 * The same column means different things in the two paths, so each field carries both names.
 * `analyseLabel: null` means the field has no meaning for a bank export — a bank export does not
 * carry a cadence or a category, and asking for them would suggest the engine needs them.
 */
interface FieldSpec {
  readonly id: FieldId;
  readonly label: string;
  readonly analyseLabel: string | null;
  readonly required: boolean;
  readonly analyseRequired: boolean;
  readonly hints: readonly string[];
}

const FIELDS: readonly FieldSpec[] = [
  {
    id: 'name',
    label: 'Name',
    analyseLabel: 'Description',
    required: true,
    analyseRequired: true,
    hints: ['name', 'subscription', 'service', 'merchant', 'description'],
  },
  {
    id: 'amount',
    label: 'Amount',
    analyseLabel: 'Amount',
    required: true,
    analyseRequired: true,
    hints: ['amount', 'price', 'cost', 'charge', 'value'],
  },
  {
    id: 'currency',
    label: 'Currency',
    analyseLabel: 'Currency',
    required: false,
    analyseRequired: false,
    hints: ['currency', 'ccy'],
  },
  {
    id: 'cadence',
    label: 'Cadence',
    analyseLabel: null,
    required: false,
    analyseRequired: false,
    hints: ['cadence', 'interval', 'frequency', 'billing', 'period'],
  },
  {
    id: 'nextDate',
    label: 'Next date',
    // Required here and optional in the other path: cadence is inferred from the gaps between
    // charges, so a file with no dates has nothing for the engine to read.
    analyseLabel: 'Posted date',
    required: false,
    analyseRequired: true,
    hints: ['next', 'renew', 'date', 'due', 'start'],
  },
  {
    id: 'category',
    label: 'Category',
    analyseLabel: null,
    required: false,
    analyseRequired: false,
    hints: ['category', 'type', 'group'],
  },
];

type FieldId = 'name' | 'amount' | 'currency' | 'cadence' | 'nextDate' | 'category';

type Mapping = Readonly<Record<FieldId, number>>;

const UNMAPPED = -1;

function fieldsFor(mode: ImportMode): readonly FieldSpec[] {
  return mode === 'create' ? FIELDS : FIELDS.filter((field) => field.analyseLabel !== null);
}

function labelFor(field: FieldSpec, mode: ImportMode): string {
  return mode === 'analyse' ? (field.analyseLabel ?? field.label) : field.label;
}

function requiredIn(field: FieldSpec, mode: ImportMode): boolean {
  return mode === 'analyse' ? field.analyseRequired : field.required;
}

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

export type DateOrder = 'iso' | 'dmy' | 'mdy';

/**
 * The date-order options, labelled in words.
 *
 * They used to read `2026-08-14` / `14/08/2026` / `08/14/2026` and nothing else, so the closed
 * select showed what looked like a date rather than a setting, and there was no way to tell what
 * picking one would do. One user lost 749 rows to that: their file was `MM/DD/YYYY`, the control
 * said `2026-08-14`, and every American date came back unreadable.
 */
export const DATE_ORDER_OPTIONS: readonly { readonly id: DateOrder; readonly label: string }[] = [
  { id: 'iso', label: 'Year first (2026-08-14)' },
  { id: 'dmy', label: 'Day first (14/08/2026)' },
  { id: 'mdy', label: 'Month first (08/14/2026)' },
];

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
 * guessing wrong moves someone's renewal reminder by a month. `detectDateOrder` below can often
 * *prove* the order from the file, and when it can it preselects one — but it never invents an
 * answer for a file that reads both ways.
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

/** Why `detectDateOrder` decided what it decided. Rendered under the control, verbatim. */
export type DateOrderReason = 'iso' | 'day-first' | 'month-first' | 'ambiguous' | 'conflicting' | 'none';

export interface DateOrderGuess {
  /** `null` when the file cannot prove an order. The choice then stays with the user. */
  readonly order: DateOrder | null;
  readonly reason: DateOrderReason;
  /** How many values the scan could read at all. Zero means the column is not dates. */
  readonly scanned: number;
}

/**
 * Reads the order off the file when the file can prove it.
 *
 * The proof is arithmetic, not statistics. A first component above 12 cannot be a month, so the
 * file is day-first; a second component above 12 cannot be a month either, so the file is
 * month-first. One such row settles it for the whole column.
 *
 * A file where every date is 12/12 or lower proves nothing, and this says so rather than picking
 * the more likely answer — the whole reason the control exists is that a wrong guess here moves
 * someone's renewal by a month, silently. A file containing proof of *both* is inconsistent, and
 * that is worth surfacing too.
 */
export function detectDateOrder(values: readonly string[]): DateOrderGuess {
  let scanned = 0;
  let isoRows = 0;
  let dayFirstProof = 0;
  let monthFirstProof = 0;

  for (const raw of values) {
    const value = raw.trim();
    if (value === '') continue;

    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(value)) {
      scanned += 1;
      isoRows += 1;
      continue;
    }

    const parts = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(value);
    if (parts === null) continue;

    scanned += 1;
    if (Number(parts[1] ?? '0') > 12) dayFirstProof += 1;
    if (Number(parts[2] ?? '0') > 12) monthFirstProof += 1;
  }

  if (scanned === 0) return { order: null, reason: 'none', scanned };
  if (isoRows === scanned) return { order: 'iso', reason: 'iso', scanned };
  if (dayFirstProof > 0 && monthFirstProof > 0) return { order: null, reason: 'conflicting', scanned };
  if (dayFirstProof > 0) return { order: 'dmy', reason: 'day-first', scanned };
  if (monthFirstProof > 0) return { order: 'mdy', reason: 'month-first', scanned };
  return { order: null, reason: 'ambiguous', scanned };
}

/** The line under the control. Sentence case, and it never claims more than the scan proved. */
export function dateOrderNote(guess: DateOrderGuess, order: DateOrder): string {
  const chosen = DATE_ORDER_OPTIONS.find((option) => option.id === order)?.label ?? '';
  const name = chosen.split(' (')[0] ?? chosen;

  switch (guess.reason) {
    case 'iso':
      return 'Year first, detected from your file.';
    case 'day-first':
      return 'Day first, detected from your file — some rows have a day above 12.';
    case 'month-first':
      return 'Month first, detected from your file — some rows have a month above 12.';
    case 'conflicting':
      return `Your file has rows that read both ways, so we cannot tell. Reading it as ${name.toLowerCase()}.`;
    case 'ambiguous':
      return `Every date in this file reads the same either way, so this stays your choice. Reading it as ${name.toLowerCase()}.`;
    case 'none':
      return '03/04/2026 is two different days depending on who wrote the file, so this is a choice rather than a guess.';
  }
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

interface RowSource {
  readonly rows: readonly (readonly string[])[];
  readonly mapping: Mapping;
  readonly hasHeader: boolean;
  readonly defaultCurrency: string;
  readonly dateOrder: DateOrder;
}

interface ValidateOptions extends RowSource {
  readonly defaultCadence: RecurrenceInterval;
  readonly today: PlainDate;
}

/** Walks the body rows, handing each one its line number and a cell reader. */
function eachRow(
  source: RowSource,
  visit: (line: number, cell: (field: FieldId) => string, preview: string) => void,
): void {
  const body = source.hasHeader ? source.rows.slice(1) : source.rows;
  const offset = source.hasHeader ? 2 : 1;

  body.forEach((cells, index) => {
    const cell = (field: FieldId): string => {
      const position = source.mapping[field];
      return position === UNMAPPED ? '' : (cells[position] ?? '');
    };
    visit(index + offset, cell, cells.slice(0, 4).join(' · '));
  });
}

function validate(options: ValidateOptions): Validation {
  const ready: ReadyRow[] = [];
  const rejected: RejectedRow[] = [];

  eachRow(options, (line, cell, preview) => {
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
      const parsed = parseMoney(amountCell, currency).amountMinor;

      /**
       * Bank exports sign the other way round.
       *
       * Chase, and most US bank CSVs, write a debit as `-15.49` — money leaving is negative.
       * Ledger's convention is the opposite: a subscription's amount is positive, because it is
       * what you pay. Imported verbatim, a Chase export produces subscriptions worth minus
       * fifteen dollars, and the dashboard's monthly commitment goes *down* for every
       * subscription you add. Nothing errors; the totals are just quietly wrong, which is the
       * failure mode this product least deserves.
       *
       * Taking the magnitude is right for both shapes here, where every row is a subscription
       * the user is asserting. The analysing path cannot do this — see `planAnalysis`, where the
       * sign is the only thing separating a Netflix charge from a Zelle payment received.
       */
      if (parsed === 0) {
        rejected.push({ line, reason: 'Amount is zero — not a subscription.', preview });
        return;
      }
      amountMinor = Math.abs(parsed);
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

// ── rows bound for the detection engine ──────────────────────────────────────────────────

interface AnalysisRow {
  readonly descriptor: string;
  /** Minor units, **signed exactly as the file wrote it**. The server decides what the sign means. */
  readonly amountMinor: number;
  readonly postedAt: string;
  readonly currency?: string;
}

interface AnalysisPlan {
  readonly rows: readonly AnalysisRow[];
  readonly rejected: readonly RejectedRow[];
}

/**
 * Rows for the engine, with the sign left alone.
 *
 * This is the one place in this file that does not take the magnitude of an amount. The sign is
 * the entire difference between `UBER * EATS` at -51.72 and `Zelle payment from JOSEPHINE
 * BARBARA` at +40.00, and throwing it away here is how the second one becomes a $40/month
 * subscription. The server infers the file's convention from the majority sign and drops the
 * inflows; it can only do that if the client sends what the file said.
 */
export function planAnalysis(source: RowSource): AnalysisPlan {
  const rows: AnalysisRow[] = [];
  const rejected: RejectedRow[] = [];

  eachRow(source, (line, cell, preview) => {
    const descriptor = cell('name').trim();
    if (descriptor === '') {
      rejected.push({ line, reason: 'No description in the mapped column.', preview });
      return;
    }

    const currencyCell = cell('currency').trim().toUpperCase();
    if (currencyCell !== '' && !isCurrencyCode(currencyCell)) {
      rejected.push({ line, reason: `"${currencyCell}" is not a currency code we know.`, preview });
      return;
    }
    const currency = currencyCell === '' ? source.defaultCurrency : currencyCell;

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
    if (amountMinor === 0) {
      rejected.push({ line, reason: 'Amount is zero — nothing moved.', preview });
      return;
    }

    const dateCell = cell('nextDate').trim();
    const postedAt = dateCell === '' ? null : parseImportedDate(dateCell, source.dateOrder);
    if (postedAt === null) {
      rejected.push({
        line,
        reason:
          dateCell === ''
            ? 'No date in the mapped column — the engine reads cadence from the dates.'
            : `Could not read "${dateCell}" as a date.`,
        preview,
      });
      return;
    }

    rows.push({
      descriptor,
      amountMinor,
      postedAt: formatPlainDate(postedAt),
      ...(currencyCell === '' ? {} : { currency: currencyCell }),
    });
  });

  return { rows, rejected };
}

/** Every value in the mapped date column, capped — enough to prove an order, cheap to scan. */
const DATE_SCAN_LIMIT = 500;

function dateColumnSample(source: Pick<RowSource, 'rows' | 'mapping' | 'hasHeader'>): string[] {
  const position = source.mapping.nextDate;
  if (position === UNMAPPED) return [];
  const body = source.hasHeader ? source.rows.slice(1) : source.rows;
  return body.slice(0, DATE_SCAN_LIMIT).map((cells) => cells[position] ?? '');
}

// ── the screen ───────────────────────────────────────────────────────────────────────────

interface ImportOutcome {
  readonly created: number;
  readonly failures: readonly RejectedRow[];
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? '' : 's'}`;
}

export function CsvImport(): React.ReactElement {
  const utils = api.useUtils();
  const me = api.me.current.useQuery();

  const [mode, setMode] = React.useState<ImportMode>('analyse');
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
  const [analysis, setAnalysis] = React.useState<ImportAnalysis | null>(null);

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

  const dateSample = React.useMemo(
    () => dateColumnSample({ rows, mapping, hasHeader }),
    [rows, mapping, hasHeader],
  );
  const dateGuess = React.useMemo(() => detectDateOrder(dateSample), [dateSample]);

  /**
   * Preselect the order the file proved, once per file-and-column.
   *
   * Keyed on the sample rather than on a render count so that changing the mapped column
   * re-detects, while an order the user picked afterwards survives every unrelated re-render.
   */
  const detectedFor = React.useRef('');
  React.useEffect(() => {
    const signature = dateSample.join('|');
    if (signature === detectedFor.current) return;
    detectedFor.current = signature;

    if (dateGuess.order !== null) {
      setDateOrder(dateGuess.order);
      return;
    }

    /**
     * An ambiguous slash-date file cannot honestly show "Year first": the parser reads slash
     * dates under `iso` day-first, so the control would name an order the parse demonstrably is
     * not in. Snapping to "Day first" changes nothing about how the dates are read — it makes
     * the label match the behaviour, and the note beneath still says the choice is the user's.
     */
    if (
      (dateGuess.reason === 'ambiguous' || dateGuess.reason === 'conflicting') &&
      dateGuess.scanned > 0 &&
      dateOrder === 'iso'
    ) {
      setDateOrder('dmy');
    }
  }, [dateGuess, dateSample, dateOrder]);

  const defaultCadence = React.useMemo(() => {
    const [unit, count] = defaultCadenceKey.split(':');
    if (unit === 'day' || unit === 'week' || unit === 'month' || unit === 'year') {
      return interval(unit, Number(count ?? '1'));
    }
    return interval('month', 1);
  }, [defaultCadenceKey]);

  const source = React.useMemo(
    () => ({ rows, mapping, hasHeader, defaultCurrency, dateOrder }),
    [rows, mapping, hasHeader, defaultCurrency, dateOrder],
  );

  const result = React.useMemo(
    () => validate({ ...source, defaultCadence, today }),
    [source, defaultCadence, today],
  );
  const plan = React.useMemo(() => planAnalysis(source), [source]);

  const rejected = mode === 'analyse' ? plan.rejected : result.rejected;
  const readyCount = mode === 'analyse' ? plan.rows.length : result.ready.length;

  const create = api.subscriptions.create.useMutation();
  const analyse = api.import.analyse.useMutation();

  function loadFile(file: File): void {
    void file.text().then(
      (text) => {
        setOutcome(null);
        setAnalysis(null);
        setDelimiter(detectDelimiter(text));
        setRaw(text);
      },
      () => {
        toast.error('Could not read that file.');
      },
    );
  }

  async function runAnalysis(): Promise<void> {
    try {
      const found = await analyse.mutateAsync({ rows: [...plan.rows] });
      setAnalysis(found);
      await utils.review.list.invalidate();
      toast.success(
        found.summary.candidates === 0
          ? 'Nothing in that file repeats.'
          : `${plural(found.summary.candidates, 'recurring charge')} found.`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The analysis failed.');
    }
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
                setAnalysis(null);
                setRaw(event.target.value);
              }}
            />
          </div>
        </PanelBody>
      </Panel>

      <Tabs
        value={mode}
        onValueChange={(value) => {
          setMode(value === 'create' ? 'create' : 'analyse');
          setAnalysis(null);
          setOutcome(null);
        }}
      >
        <TabsList>
          <TabsTrigger value="analyse">
            <Search className="size-3.5" aria-hidden />
            Find recurring charges
          </TabsTrigger>
          <TabsTrigger value="create">
            <ListChecks className="size-3.5" aria-hidden />
            Create these as subscriptions
          </TabsTrigger>
        </TabsList>
        <TabsContent value="analyse" className="mt-[var(--gap-tight)]">
          <p className="text-[0.8125rem] leading-snug text-text-2">
            For a bank export. Every row is read, the charges that repeat become suggestions in
            your review queue, and the rest are reported rather than created. Nothing is added to
            your subscriptions until you confirm it there.
          </p>
        </TabsContent>
        <TabsContent value="create" className="mt-[var(--gap-tight)]">
          <p className="text-[0.8125rem] leading-snug text-text-2">
            One subscription per row, no analysis. Right for a list you wrote yourself. Pointed at
            a bank export it will create one subscription per transaction.
          </p>
        </TabsContent>
      </Tabs>

      {rows.length === 0 ? null : (
        <>
          <Panel>
            <PanelHeader eyebrow="Columns">
              {mode === 'analyse'
                ? 'Point the engine at the description, the amount, and the date.'
                : 'Point each field at a column. Name and amount are the two that matter.'}
            </PanelHeader>
            <PanelBody className="grid gap-[var(--gap)] sm:grid-cols-2 lg:grid-cols-3">
              {fieldsFor(mode).map((field) => (
                <div key={field.id} className="flex flex-col gap-1">
                  <Label required={requiredIn(field, mode)}>{labelFor(field, mode)}</Label>
                  <Select
                    value={String(mapping[field.id])}
                    onValueChange={(value) => {
                      setMapping((current) => ({ ...current, [field.id]: Number(value) }));
                    }}
                  >
                    <SelectTrigger aria-label={`Column for ${labelFor(field, mode)}`}>
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

              {mode === 'create' ? (
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
              ) : null}

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
                    {DATE_ORDER_OPTIONS.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[0.6875rem] leading-tight text-text-3">
                  {dateOrderNote(dateGuess, dateOrder)}
                </p>
              </div>
            </PanelBody>
          </Panel>

          {mode === 'create' ? (
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
          ) : (
            <AnalysisPreview analysis={analysis} readyCount={plan.rows.length} locale={locale} />
          )}

          {rejected.length === 0 ? null : (
            <Panel className="border-alert/25">
              <PanelHeader eyebrow="Rows that will be skipped">
                These are reported by line number and left out. Everything else still{' '}
                {mode === 'analyse' ? 'gets analysed' : 'imports'}.
              </PanelHeader>
              <ul className="divide-y divide-line">
                {rejected.slice(0, 40).map((row) => (
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
              {rejected.length > 40 ? (
                <p className="border-t border-line px-[var(--pad-panel)] py-1.5 text-xs text-text-3">
                  and {rejected.length - 40} more, all skipped for the same kinds of reason
                </p>
              ) : null}
            </Panel>
          )}

          <div className="flex flex-wrap items-center justify-end gap-[var(--gap-tight)]">
            {running ? (
              <span className="font-mono text-xs text-text-2" aria-live="polite">
                {progress} / {result.ready.length}
              </span>
            ) : null}
            {mode === 'analyse' ? (
              <>
                {analysis === null ? null : (
                  <Button size="md" variant="primary" asChild>
                    <Link href="/review">
                      <ListChecks className="size-3.5" aria-hidden />
                      Review {plural(analysis.summary.candidates, 'suggestion')}
                    </Link>
                  </Button>
                )}
                <Button
                  size="md"
                  variant={analysis === null ? 'primary' : 'secondary'}
                  loading={analyse.isPending}
                  disabled={readyCount === 0}
                  onClick={() => {
                    void runAnalysis();
                  }}
                >
                  <Search className="size-3.5" aria-hidden />
                  {analysis === null ? 'Analyse' : 'Analyse again'} {plural(readyCount, 'row')}
                </Button>
              </>
            ) : (
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
                Import {plural(result.ready.length, 'subscription')}
              </Button>
            )}
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

// ── the analysing path's preview ─────────────────────────────────────────────────────────

interface AnalysisPreviewProps {
  readonly analysis: ImportAnalysis | null;
  readonly readyCount: number;
  readonly locale: string;
}

/**
 * What the engine found, and what it left out.
 *
 * Candidates, not rows. Showing the raw rows here would be the same lie the old screen told: the
 * point of this path is that most of the file is not a subscription, and a preview of 553 rows
 * says the opposite.
 */
function AnalysisPreview({ analysis, readyCount, locale }: AnalysisPreviewProps): React.ReactElement {
  if (analysis === null) {
    return (
      <Panel>
        <PanelHeader
          eyebrow="What the engine will read"
          actions={
            <Badge tone="control" mono>
              {readyCount} rows
            </Badge>
          }
        >
          Nothing has been written yet. Analysing groups the rows into recurring series and reports
          what did not fit.
        </PanelHeader>
      </Panel>
    );
  }

  const { summary, candidates } = analysis;
  const signedRows = summary.negativeRows + summary.positiveRows;

  return (
    <>
      <Panel>
        <PanelHeader
          eyebrow="Recurring charges found"
          actions={
            <div className="flex items-center gap-1.5">
              <Badge tone="control" mono>
                {summary.candidates} found
              </Badge>
              {summary.preserved > 0 ? (
                <Badge tone="neutral" mono>
                  {summary.preserved} already answered
                </Badge>
              ) : null}
            </div>
          }
        />
        {candidates.length === 0 ? (
          <PanelBody>
            <p className="text-[0.8125rem] text-text-2">
              Nothing in this file repeats on a cadence the engine can stand behind. That is a real
              answer, not a failure — a file of one-off spending has no subscriptions in it.
            </p>
          </PanelBody>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] text-[0.8125rem]">
              <thead>
                <tr className="border-b border-line text-left">
                  <th className="eyebrow px-[var(--pad-panel)] py-1.5">Merchant</th>
                  <th className="eyebrow px-[var(--pad-panel)] py-1.5 text-right">Amount</th>
                  <th className="eyebrow px-[var(--pad-panel)] py-1.5">Cadence</th>
                  <th className="eyebrow px-[var(--pad-panel)] py-1.5 text-right">Charges</th>
                  <th className="eyebrow px-[var(--pad-panel)] py-1.5 text-right">Confidence</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {candidates.slice(0, 20).map((candidate) => (
                  <tr key={`${candidate.normalizedKey}-${candidate.currency}`}>
                    <td className="max-w-[18rem] px-[var(--pad-panel)] py-1.5">
                      <span className="block truncate text-text">{candidate.displayName}</span>
                      <span className="block truncate font-mono text-[0.6875rem] text-text-3">
                        {candidate.sampleDescriptor}
                      </span>
                    </td>
                    <td className="px-[var(--pad-panel)] py-1.5 text-right">
                      <Money
                        amountMinor={candidate.medianAmountMinor}
                        currency={candidate.currency}
                        tone="outflow"
                        locale={locale}
                      />
                    </td>
                    <td className="px-[var(--pad-panel)] py-1.5 text-text-2">
                      {intervalLabel(interval(candidate.intervalUnit, candidate.intervalCount))}
                    </td>
                    <td className="px-[var(--pad-panel)] py-1.5 text-right font-mono tabular-nums text-text-2">
                      {candidate.occurrences}
                    </td>
                    <td className="px-[var(--pad-panel)] py-1.5 text-right font-mono tabular-nums text-text-2">
                      {Math.round(candidate.confidence * 100)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {candidates.length > 20 ? (
          <p className="border-t border-line px-[var(--pad-panel)] py-1.5 text-xs text-text-3">
            and {candidates.length - 20} more, all waiting in the review queue
          </p>
        ) : null}
      </Panel>

      <Panel>
        <PanelHeader eyebrow="What was left out">
          {plural(summary.analysed, 'row')} reached the engine. Here is where the rest went.
        </PanelHeader>
        <PanelBody>
          <ul className="flex flex-col gap-1 text-[0.8125rem] text-text-2">
            <li>
              <span className="font-mono tabular-nums text-text">{summary.droppedOneOff}</span> rows
              were one-off purchases.
            </li>
            {summary.droppedInflow > 0 ? (
              <li>
                <span className="font-mono tabular-nums text-text">{summary.droppedInflow}</span>{' '}
                rows were money coming in.
              </li>
            ) : null}
            {summary.droppedUnreadable > 0 ? (
              <li>
                <span className="font-mono tabular-nums text-text">
                  {summary.droppedUnreadable}
                </span>{' '}
                rows had no description, no readable date, or no amount.
              </li>
            ) : null}
            <li className="mt-1 text-text-3">
              {summary.signConvention === 'debits_negative'
                ? `Your file writes money leaving as a negative amount — ${String(summary.negativeRows)} of ${String(signedRows)} rows. We read it that way.`
                : `Your file writes money leaving as a positive amount — ${String(summary.positiveRows)} of ${String(signedRows)} rows. We read it that way.`}
            </li>
          </ul>
        </PanelBody>
      </Panel>
    </>
  );
}
