import 'server-only';

import { z } from 'zod';
import { analyseImportedRows } from '~/server/import/analyse';
import { recordAudit } from '~/server/audit';
import { protectedProcedure, router } from '~/server/trpc/init';

/**
 * File import.
 *
 * One procedure, and it is the analysing one. Creating a subscription per row is still available
 * — it is `subscriptions.create`, called row by row from the import screen — because a
 * hand-written list of six known subscriptions needs no engine. What needed a procedure is the
 * other case: twelve months of a current account, where the answer is a handful of recurring
 * series buried in several hundred one-off purchases, and only `@ledger/detection` can tell them
 * apart.
 *
 * The rows arrive already parsed. Parsing stays in the browser (see the note on the import page):
 * uploading a spreadsheet of someone's finances to discover it had the wrong delimiter is a bad
 * trade. What crosses the wire is a descriptor, an amount, and a date — no balances, no account
 * numbers, no memo column.
 */

/** 12 months of a busy current account is 1,500–2,500 rows; 20,000 is several years of one. */
const MAX_ROWS = 20_000;

const rowInput = z.object({
  // Not `.min(1)`: a blank descriptor is one bad row, and one bad row must not cost the other
  // 1,299. It is counted as unreadable by `toDetectionInput` and reported in the summary.
  descriptor: z.string().max(500),
  /** Minor units, signed exactly as the file wrote it. The server decides what the sign means. */
  amountMinor: z.number().int(),
  postedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be resolved to YYYY-MM-DD.'),
  currency: z.string().max(8).optional(),
});

export const importRouter = router({
  /**
   * Run the detection engine over a parsed file and fold the candidates into `/review`.
   *
   * A mutation rather than a query because it writes: the point is that the suggestions are in
   * the review queue when the user gets there, not that a preview was rendered.
   */
  analyse: protectedProcedure
    .input(z.object({ rows: z.array(rowInput).min(1).max(MAX_ROWS) }))
    .mutation(async ({ ctx, input }) => {
      const analysis = await analyseImportedRows(
        { db: ctx.db, scope: ctx.scope, clock: ctx.clock },
        { rows: input.rows, fallbackCurrency: ctx.user.displayCurrency },
      );

      await recordAudit(
        ctx.db,
        ctx.scope,
        { ip: ctx.ip, userAgent: ctx.userAgent },
        'import.analysed',
        'detection',
        null,
        {
          rows: input.rows.length,
          analysed: analysis.summary.analysed,
          candidates: analysis.summary.candidates,
          signConvention: analysis.summary.signConvention,
        },
      );

      return analysis;
    }),
});
