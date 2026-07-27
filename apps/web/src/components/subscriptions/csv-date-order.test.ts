import { describe, expect, it } from 'vitest';
import {
  DATE_ORDER_OPTIONS,
  dateOrderNote,
  detectDateOrder,
  parseDelimited,
  parseImportedDate,
  planAnalysis,
} from './csv-import';

/**
 * The date-order control.
 *
 * The options used to be labelled `2026-08-14`, `14/08/2026` and `08/14/2026` and nothing else.
 * Closed, the select therefore showed what looked like a date, not a setting — and a user with a
 * `MM/DD/YYYY` Chase export left it on the default and lost 749 rows to "Could not read
 * 07/25/2026 as a date". Two fixes, both tested here: the options say what they mean in words,
 * and the order is detected from the file when the file can prove it.
 *
 * The proof is arithmetic. `25` cannot be a month, so `07/25/2026` proves month-first. `14/08`
 * proves day-first. `03/04/2026` proves nothing, and that case keeps the choice with the user
 * rather than guessing — because a wrong guess here does not error, it moves a renewal by a
 * month.
 */

describe('the option labels', () => {
  it('names each order in words, with the example after it', () => {
    expect(DATE_ORDER_OPTIONS.map((option) => option.label)).toEqual([
      'Year first (2026-08-14)',
      'Day first (14/08/2026)',
      'Month first (08/14/2026)',
    ]);
  });
});

describe('detecting the order from the file', () => {
  it('proves month-first from a Chase export', () => {
    // Chase writes MM/DD/YYYY. `07/25` and `07/31` cannot be day-first.
    const guess = detectDateOrder(['07/25/2026', '07/24/2026', '07/20/2026', '07/31/2026']);
    expect(guess.order).toBe('mdy');
    expect(guess.reason).toBe('month-first');
    expect(guess.scanned).toBe(4);
  });

  it('proves day-first from a UK export', () => {
    const guess = detectDateOrder(['14/08/2026', '01/08/2026', '28/07/2026']);
    expect(guess.order).toBe('dmy');
    expect(guess.reason).toBe('day-first');
  });

  it('recognises an all-ISO column', () => {
    const guess = detectDateOrder(['2026-08-14', '2026-07-25', '2026-06-30']);
    expect(guess.order).toBe('iso');
    expect(guess.reason).toBe('iso');
  });

  it('keeps the choice with the user when every date reads both ways', () => {
    // The case the control exists for. 03/04, 05/06, 11/12 are all valid either way.
    const guess = detectDateOrder(['03/04/2026', '05/06/2026', '11/12/2026', '01/02/2026']);
    expect(guess.order).toBeNull();
    expect(guess.reason).toBe('ambiguous');
    expect(guess.scanned).toBe(4);
  });

  it('refuses to pick when the file proves both, because then the file is wrong', () => {
    const guess = detectDateOrder(['07/25/2026', '25/07/2026']);
    expect(guess.order).toBeNull();
    expect(guess.reason).toBe('conflicting');
  });

  it('reports nothing readable when the column is not dates at all', () => {
    const guess = detectDateOrder(['DEBIT', 'DEBIT', '', 'CREDIT']);
    expect(guess.order).toBeNull();
    expect(guess.reason).toBe('none');
    expect(guess.scanned).toBe(0);
  });

  it('still finds the proof in a column that mixes ISO and slashed dates', () => {
    const guess = detectDateOrder(['2026-08-14', '07/25/2026', '2026-06-30']);
    expect(guess.order).toBe('mdy');
  });

  it('needs only one unambiguous row out of a thousand', () => {
    const values = Array.from({ length: 999 }, () => '03/04/2026');
    values.push('03/25/2026');
    expect(detectDateOrder(values).order).toBe('mdy');
  });

  it('handles dotted and hyphenated separators', () => {
    expect(detectDateOrder(['25.07.2026', '14.08.2026']).order).toBe('dmy');
    expect(detectDateOrder(['07-25-2026', '08-14-2026']).order).toBe('mdy');
  });
});

describe('the note under the control', () => {
  it('says what was detected, so the preselection is visible rather than magic', () => {
    expect(dateOrderNote(detectDateOrder(['07/25/2026']), 'mdy')).toBe(
      'Month first, detected from your file — some rows have a month above 12.',
    );
    expect(dateOrderNote(detectDateOrder(['25/07/2026']), 'dmy')).toBe(
      'Day first, detected from your file — some rows have a day above 12.',
    );
  });

  it('admits it when the file cannot settle it, and names what it is falling back on', () => {
    const note = dateOrderNote(detectDateOrder(['03/04/2026', '05/06/2026']), 'iso');
    expect(note).toContain('reads the same either way');
    expect(note).toContain('year first');
  });

  it('falls back to explaining the setting when there is no date column mapped', () => {
    expect(dateOrderNote(detectDateOrder([]), 'iso')).toContain('two different days');
  });
});

// ── the whole reason it matters ──────────────────────────────────────────────────────────

const CHASE_CHECKING = `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
DEBIT,07/25/2026,"NETFLIX.COM          NETFLIX.COM CA",-15.49,DEBIT_CARD,4821.33,
DEBIT,07/24/2026,"SPOTIFY USA          NEW YORK NY",-11.99,DEBIT_CARD,4836.82,
DEBIT,07/20/2026,"PLANET FIT CLUB FEES 800-4283558 FL",-24.99,ACH_DEBIT,4848.81,
CREDIT,07/18/2026,"Zelle payment from JOSEPHINE BARBARA 29962245370",40.00,ACH_CREDIT,4888.80,
`;

const CHASE_ROWS = parseDelimited(CHASE_CHECKING, ',');

const CHASE_MAPPING = {
  name: 2,
  amount: 3,
  currency: -1,
  cadence: -1,
  nextDate: 1,
  category: 4,
} as const;

describe('a Chase export against the default order', () => {
  it('is unreadable on the year-first default — the 749-row failure', () => {
    const plan = planAnalysis({
      rows: CHASE_ROWS,
      mapping: CHASE_MAPPING,
      hasHeader: true,
      defaultCurrency: 'USD',
      dateOrder: 'iso',
    });
    expect(plan.rows).toHaveLength(0);
    expect(plan.rejected).toHaveLength(4);
    expect(plan.rejected[0]?.reason).toContain('Could not read "07/25/2026" as a date.');
  });

  it('reads cleanly once the detected order is applied', () => {
    const detected = detectDateOrder(CHASE_ROWS.slice(1).map((cells) => cells[1] ?? ''));
    expect(detected.order).toBe('mdy');

    const plan = planAnalysis({
      rows: CHASE_ROWS,
      mapping: CHASE_MAPPING,
      hasHeader: true,
      defaultCurrency: 'USD',
      dateOrder: detected.order ?? 'iso',
    });
    expect(plan.rejected).toHaveLength(0);
    expect(plan.rows).toHaveLength(4);
    expect(plan.rows[0]?.postedAt).toBe('2026-07-25');
  });

  it('sends the sign the file wrote, so the server can tell a charge from a receipt', () => {
    const plan = planAnalysis({
      rows: CHASE_ROWS,
      mapping: CHASE_MAPPING,
      hasHeader: true,
      defaultCurrency: 'USD',
      dateOrder: 'mdy',
    });
    // Netflix debit stays negative; the Zelle receipt stays positive. Taking the magnitude here
    // is what made `Zelle payment from JOSEPHINE BARBARA` a $40/month subscription.
    expect(plan.rows[0]?.amountMinor).toBe(-1549);
    expect(plan.rows[3]?.amountMinor).toBe(4000);
  });
});

describe('parseImportedDate, for the record', () => {
  it('reads a Chase date under mdy and refuses it under dmy', () => {
    expect(parseImportedDate('07/25/2026', 'mdy')).toEqual({ year: 2026, month: 7, day: 25 });
    expect(parseImportedDate('07/25/2026', 'dmy')).toBeNull();
  });

  it('reads ISO whatever the order says, because ISO is unambiguous', () => {
    for (const order of ['iso', 'dmy', 'mdy'] as const) {
      expect(parseImportedDate('2026-08-14', order)).toEqual({ year: 2026, month: 8, day: 14 });
    }
  });
});
