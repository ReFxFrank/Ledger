import { describe, expect, it } from 'vitest';
import { parseDelimited, parseImportedDate } from './csv-import';

/**
 * Chase exports, specifically.
 *
 * Written because a user asked whether their Chase CSV would work, and checking rather than
 * assuming turned up a real defect: Chase writes a debit as `-15.49`, Ledger stores what you pay
 * as a positive number, and importing verbatim produced subscriptions worth minus fifteen
 * dollars. Nothing threw — the dashboard's monthly commitment simply went *down* for every
 * subscription imported.
 *
 * Chase has two formats and they are not the same shape, so both are here as real rows rather
 * than as a tidied-up approximation:
 *
 *  - Checking/savings: `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #`,
 *    with descriptions carrying runs of internal whitespace and, occasionally, commas.
 *  - Credit card: `Transaction Date,Post Date,Description,Category,Type,Amount,Memo` — two date
 *    columns, so the mapping has to pick one.
 */

const CHASE_CHECKING = `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
DEBIT,07/25/2026,"NETFLIX.COM          NETFLIX.COM CA",-15.49,DEBIT_CARD,4821.33,
DEBIT,07/24/2026,"SPOTIFY USA          NEW YORK NY",-11.99,DEBIT_CARD,4836.82,
DEBIT,07/20/2026,"PLANET FIT CLUB FEES 800-4283558 FL",-24.99,ACH_DEBIT,4848.81,
CREDIT,07/18/2026,"PAYROLL DIRECT DEP",2841.00,ACH_CREDIT,4873.80,
`;

const CHASE_CREDIT_CARD = `Transaction Date,Post Date,Description,Category,Type,Amount,Memo
07/25/2026,07/26/2026,NETFLIX.COM,Entertainment,Sale,-15.49,
07/22/2026,07/23/2026,"ADOBE  *CREATIVE CLOUD",Shopping,Sale,-59.99,
07/15/2026,07/16/2026,AUTOMATIC PAYMENT - THANK YOU,,Payment,412.88,
`;

describe('Chase checking export', () => {
  const rows = parseDelimited(CHASE_CHECKING, ',');

  it('parses the header and every data row', () => {
    expect(rows[0]).toEqual([
      'Details',
      'Posting Date',
      'Description',
      'Amount',
      'Type',
      'Balance',
      'Check or Slip #',
    ]);
    // Four transactions; the trailing newline must not become a fifth, empty row.
    expect(rows).toHaveLength(5);
  });

  it('keeps a quoted description intact, including its internal spacing', () => {
    expect(rows[1]?.[2]).toBe('NETFLIX.COM          NETFLIX.COM CA');
  });

  it('preserves the trailing empty column rather than dropping it', () => {
    // `Check or Slip #` is empty on a card transaction. A parser that trims trailing empties
    // shifts every subsequent mapping by one column.
    expect(rows[1]).toHaveLength(7);
    expect(rows[1]?.[6]).toBe('');
  });

  it('reads Chase MM/DD/YYYY dates when the order is mdy', () => {
    const date = parseImportedDate('07/25/2026', 'mdy');
    expect(date).toEqual({ year: 2026, month: 7, day: 25 });
  });

  it('would misread the same date as dmy — which is why the order is a setting', () => {
    // 07/25 in dmy is day 7 of month 25, which does not exist. Rejecting is correct; silently
    // inventing a date would be worse.
    expect(parseImportedDate('07/25/2026', 'dmy')).toBeNull();
  });
});

describe('Chase credit card export', () => {
  const rows = parseDelimited(CHASE_CREDIT_CARD, ',');

  it('handles the two-date-column layout', () => {
    expect(rows[0]?.[0]).toBe('Transaction Date');
    expect(rows[0]?.[1]).toBe('Post Date');
    expect(rows[1]?.[0]).toBe('07/25/2026');
  });

  it('keeps a description containing a quoted asterisk and double spaces', () => {
    expect(rows[2]?.[2]).toBe('ADOBE  *CREATIVE CLOUD');
  });

  it('handles an empty Category cell between two populated ones', () => {
    const payment = rows[3];
    expect(payment?.[2]).toBe('AUTOMATIC PAYMENT - THANK YOU');
    expect(payment?.[3]).toBe('');
    expect(payment?.[4]).toBe('Payment');
  });
});

describe('the sign convention', () => {
  /**
   * The defect this file was written to catch. Chase debits are negative; a subscription's
   * amount is what you pay, and is positive. `Math.abs` in the importer is what reconciles
   * them — without it, importing a Chase export reduces your reported monthly spend.
   */
  it('is documented: Chase writes money leaving as a negative amount', () => {
    const netflix = parseDelimited(CHASE_CHECKING, ',')[1];
    expect(netflix?.[3]).toBe('-15.49');
    expect(Number(netflix?.[3])).toBeLessThan(0);
  });

  it('is documented: inflows are positive, and are not subscriptions', () => {
    const payroll = parseDelimited(CHASE_CHECKING, ',')[4];
    expect(payroll?.[3]).toBe('2841.00');
    expect(Number(payroll?.[3])).toBeGreaterThan(0);
  });
});
