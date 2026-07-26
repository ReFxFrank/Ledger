import 'server-only';

import { asc, desc, eq, inArray } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  type BillingChannel,
  BILLING_CHANNEL_LABELS,
  type CancellationMethod,
  type CancellationStatus,
  CANCELLATION_STATUS_LABELS,
  type Clock,
  type CommitmentInput,
  type Money,
  addDays,
  aggregateCommitments,
  daysBetween,
  formatMoney,
  formatPlainDate,
  fromInstant,
  interval,
  intervalLabel,
  isLedgerError,
  money,
  nextOccurrenceAfter,
  parsePlainDate,
  staticRateTable,
  toInstant,
} from '@ledger/core';
import {
  type CancellationTrigger,
  type Database,
  type Scope,
  OPEN_CANCELLATION_STATUSES,
  attachments,
  cancellationEvents,
  cancellationRequests,
  resolveTransition,
  subscriptions,
  transitionCancellation,
} from '@ledger/db';
import { recordAudit } from '~/server/audit';
import { protectedProcedure, router } from '~/server/trpc/init';

/**
 * Cancellation — the tracked workflow from brief §3.
 *
 * Ledger never cancels anything. What it does is know the right exit, hold the deadline, keep
 * the evidence, and check afterwards whether the charge actually stopped. Every status change in
 * this file goes through `transitionCancellation`, and every one of them appends an event, so
 * the timeline a user shows their bank in a dispute is complete by construction rather than by
 * remembering to write to it.
 */

/** How long to keep watching for the charge that should not arrive. Charges post late. */
const VERIFICATION_TAIL_DAYS = 12;

/** See the dashboard router: FX rates are an empty table until there is a rate source. */
const RATES = staticRateTable([]);

// ── the playbook seam ────────────────────────────────────────────────────────────────────

export interface PlaybookStep {
  readonly id: string;
  readonly text: string;
  readonly detail?: string;
  readonly warning?: string;
}

export interface ResolvedPlaybook {
  readonly method: CancellationMethod;
  /** 1–5, brief §3.2. Generic playbooks claim 2: honest for "we do not know this provider". */
  readonly difficulty: number;
  readonly steps: readonly PlaybookStep[];
  readonly noticePeriodDays: number;
  readonly evidenceHint: string;
  readonly cancelUrl: string | null;
}

/**
 * Where a store-billed subscription actually lives.
 *
 * This map is brief §3.1 step 1, and it is the single most important thing in this file. A
 * subscription billed through the App Store cannot be cancelled on the provider's website — the
 * provider genuinely cannot stop it — so pointing the user at a provider cancel page costs them
 * an afternoon *and* the next renewal. Every entry here says the same two things: who takes the
 * money, and which settings screen ends it.
 */
const STORE_EXITS: Partial<Record<BillingChannel, { readonly store: string; readonly where: string }>> = {
  apple: {
    store: 'the Apple App Store',
    where:
      'Settings → your name → Subscriptions on an iPhone or iPad, or App Store → your account → Subscriptions on a Mac',
  },
  google: {
    store: 'Google Play',
    where: 'the Play Store app → your profile → Payments & subscriptions → Subscriptions',
  },
  amazon: {
    store: 'Amazon',
    where: 'Amazon → Account & Lists → Memberships & Subscriptions',
  },
  roku: {
    store: 'Roku',
    where:
      'the Roku home screen → highlight the channel → ★ → Manage subscription, or my.roku.com → Manage your subscriptions',
  },
  microsoft: {
    store: 'the Microsoft Store',
    where: 'account.microsoft.com → Services & subscriptions',
  },
  carrier: {
    store: 'your mobile carrier',
    where: "your carrier's account page or app, under subscriptions, add-ons, or third-party charges",
  },
};

/**
 * Resolves the steps for a subscription's billing channel.
 *
 * TODO(frank): replace with findPlaybook() from @ledger/providers once workstream B lands. The
 * provider dataset carries the real deep link, notice period, difficulty, retention-offer notes,
 * and gotchas per (merchant, channel); this returns the channel-generic version, which is
 * correct but unspecific. The signature is the one `findPlaybook` will satisfy, so swapping the
 * body is the whole change — the callers already snapshot whatever comes back.
 */
export function resolvePlaybook(channel: BillingChannel, displayName: string): ResolvedPlaybook {
  const store = STORE_EXITS[channel];

  if (store !== undefined) {
    return {
      // A store-billed subscription ends in the store's settings, whatever the provider's own
      // cancel page claims.
      method: channel === 'carrier' ? 'account_settings' : 'app_store',
      difficulty: 2,
      noticePeriodDays: 0,
      cancelUrl: null,
      evidenceHint: `Screenshot the subscription showing as cancelled in ${store.store}, and keep the confirmation email.`,
      steps: [
        {
          id: 'channel',
          text: `${displayName} is billed through ${store.store}, so it has to be cancelled there.`,
          detail: `${BILLING_CHANNEL_LABELS[channel]} takes the payment, not ${displayName}.`,
          warning: `Cancelling in your ${displayName} account will not stop this charge.`,
        },
        { id: 'open', text: `Open ${store.where}.` },
        { id: 'find', text: `Find ${displayName} in the list and cancel it.` },
        {
          id: 'confirm',
          text: 'Screenshot the screen that says it is cancelled.',
          detail: 'Stores confirm on screen and usually by email. Keep both.',
        },
        {
          id: 'access',
          text: 'Check the date access ends.',
          detail: 'Most stores let you keep access until the end of the period you already paid for.',
        },
      ],
    };
  }

  if (channel === 'paypal') {
    return {
      method: 'account_settings',
      difficulty: 2,
      noticePeriodDays: 0,
      cancelUrl: null,
      evidenceHint: 'Keep the provider’s cancellation email and a screenshot of the cancelled PayPal agreement.',
      steps: [
        {
          id: 'provider',
          text: `Cancel the subscription in your ${displayName} account first.`,
          detail: 'PayPal is the payment route; the subscription itself belongs to the provider.',
        },
        {
          id: 'agreement',
          text: 'Then cancel the automatic payment in PayPal → Settings → Payments → Automatic payments.',
          warning: 'An automatic payment left active can be charged again even after the provider cancels.',
        },
        { id: 'confirm', text: 'Screenshot both confirmations.' },
      ],
    };
  }

  if (channel === 'unknown') {
    return {
      method: 'account_settings',
      difficulty: 3,
      noticePeriodDays: 0,
      cancelUrl: null,
      evidenceHint: 'Keep the confirmation email and a screenshot of the cancelled subscription.',
      steps: [
        {
          id: 'identify',
          text: 'Check the bank descriptor to see who takes the money.',
          detail:
            'A descriptor that names a store — APPLE.COM/BILL, GOOGLE *, AMZN — means the subscription has to be cancelled in that store, not with the provider.',
        },
        { id: 'account', text: `Sign in to ${displayName} and open your account or billing settings.` },
        { id: 'cancel', text: 'Cancel the subscription and read what it says about the end date.' },
        { id: 'confirm', text: 'Screenshot the confirmation and keep the email.' },
      ],
    };
  }

  return {
    method: 'account_settings',
    difficulty: 2,
    noticePeriodDays: 0,
    cancelUrl: null,
    evidenceHint: 'Keep the confirmation email and a screenshot of the cancelled subscription.',
    steps: [
      { id: 'account', text: `Sign in to ${displayName} and open your account or billing settings.` },
      { id: 'find', text: 'Find the subscription and start the cancellation.' },
      {
        id: 'offers',
        text: 'Decline any retention offer you do not want.',
        warning: 'Accepting a discount usually restarts the billing period.',
      },
      { id: 'cancel', text: 'Finish the cancellation and note the reference number.' },
      { id: 'confirm', text: 'Screenshot the confirmation and keep the email.' },
    ],
  };
}

// ── deadline ─────────────────────────────────────────────────────────────────────────────

interface Deadline {
  readonly nextRenewalDate: string;
  readonly nextRenewalAt: Date;
  readonly deadlineDate: string;
  readonly deadlineAt: Date;
  readonly verificationWindowEndsAt: Date;
  readonly noticePeriodDays: number;
  /** Negative once the cancel-by date has passed. */
  readonly daysRemaining: number;
}

/**
 * cancel-by = next renewal − notice period.
 *
 * Projected from the anchor rather than read from `next_renewal_at`, for the same reason the
 * subscriptions router does it: a stored renewal date that has been stepped forward carries
 * every clamping error it ever made, and a cancel-by date that is two days late is worthless.
 */
function computeDeadlineFor(
  subscription: Pick<
    typeof subscriptions.$inferSelect,
    'anchorDate' | 'intervalUnit' | 'intervalCount'
  >,
  noticePeriodDays: number,
  timezone: string,
  now: Date,
): Deadline {
  const anchor = parsePlainDate(subscription.anchorDate);
  const today = fromInstant(now, timezone);
  const nextRenewal = nextOccurrenceAfter(
    anchor,
    interval(subscription.intervalUnit, subscription.intervalCount),
    today,
  );
  const cancelBy = addDays(nextRenewal, -noticePeriodDays);

  return {
    nextRenewalDate: formatPlainDate(nextRenewal),
    nextRenewalAt: toInstant(nextRenewal, timezone, 9),
    deadlineDate: formatPlainDate(cancelBy),
    // 23:00 local: the cancel-by date is a whole day the user still has, not a morning.
    deadlineAt: toInstant(cancelBy, timezone, 23),
    verificationWindowEndsAt: toInstant(addDays(nextRenewal, VERIFICATION_TAIL_DAYS), timezone, 23),
    noticePeriodDays,
    daysRemaining: daysBetween(today, cancelBy),
  };
}

// ── router ───────────────────────────────────────────────────────────────────────────────

/**
 * The board columns.
 *
 * `confirmed` is on the board even though it is not an open status, because a provider saying
 * "cancelled" is a claim and `verified` is the fact. A request that drops off the board the
 * moment the provider claims success is a request nobody checks.
 */
const BOARD_STATUSES: readonly CancellationStatus[] = [...OPEN_CANCELLATION_STATUSES, 'confirmed'];

export const cancellationsRouter = router({
  board: protectedProcedure.query(async ({ ctx }) => {
    const now = ctx.clock.now();

    const rows = await ctx.db
      .select({
        request: cancellationRequests,
        subscriptionName: subscriptions.displayName,
        amountMinor: subscriptions.amountMinor,
        currency: subscriptions.currency,
        intervalUnit: subscriptions.intervalUnit,
        intervalCount: subscriptions.intervalCount,
      })
      .from(cancellationRequests)
      .innerJoin(subscriptions, eq(cancellationRequests.subscriptionId, subscriptions.id))
      .where(
        ctx.scope.where(
          cancellationRequests,
          inArray(cancellationRequests.status, [...BOARD_STATUSES]),
        ),
      )
      .orderBy(asc(cancellationRequests.deadlineAt));

    const items = rows.map((row) => ({
      ...row,
      // A missed cancel-by is the one thing on this screen that is genuinely a problem.
      overdue:
        row.request.deadlineAt !== null &&
        row.request.deadlineAt.getTime() < now.getTime() &&
        row.request.status !== 'confirmed',
      daysUntilDeadline:
        row.request.deadlineAt === null
          ? null
          : daysBetween(
              fromInstant(now, ctx.user.timezone ?? 'UTC'),
              fromInstant(row.request.deadlineAt, ctx.user.timezone ?? 'UTC'),
            ),
    }));

    return {
      columns: BOARD_STATUSES.map((status) => ({
        status,
        label: CANCELLATION_STATUS_LABELS[status],
        items: items.filter((item) => item.request.status === status),
      })),
      overdueCount: items.filter((item) => item.overdue).length,
    };
  }),

  byId: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .select({ request: cancellationRequests, subscription: subscriptions })
        .from(cancellationRequests)
        .innerJoin(subscriptions, eq(cancellationRequests.subscriptionId, subscriptions.id))
        .where(ctx.scope.whereId(cancellationRequests, input.id))
        .limit(1);

      if (row === undefined) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That cancellation does not exist.' });
      }

      const [events, files] = await Promise.all([
        ctx.db
          .select()
          .from(cancellationEvents)
          .where(ctx.scope.cancellationEvents(eq(cancellationEvents.requestId, input.id)))
          .orderBy(asc(cancellationEvents.at)),
        ctx.db
          .select()
          .from(attachments)
          .where(ctx.scope.where(attachments, eq(attachments.requestId, input.id)))
          .orderBy(desc(attachments.createdAt)),
      ]);

      return { ...row, events, attachments: files };
    }),

  /**
   * Starts a cancellation.
   *
   * Routes by billing channel before anything else — the checklist is chosen from
   * `subscription.billingChannel`, not from the merchant — and snapshots the steps onto the
   * request so a playbook update mid-flight cannot renumber them under a user who is halfway
   * through.
   */
  start: protectedProcedure
    .input(z.object({ subscriptionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const timezone = ctx.user.timezone ?? 'UTC';
      const now = ctx.clock.now();

      const [subscription] = await ctx.db
        .select()
        .from(subscriptions)
        .where(ctx.scope.whereId(subscriptions, input.subscriptionId))
        .limit(1);

      if (subscription === undefined) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That subscription does not exist.' });
      }

      const [existing] = await ctx.db
        .select({ id: cancellationRequests.id })
        .from(cancellationRequests)
        .where(
          ctx.scope.where(
            cancellationRequests,
            eq(cancellationRequests.subscriptionId, input.subscriptionId),
            inArray(cancellationRequests.status, [...OPEN_CANCELLATION_STATUSES]),
          ),
        )
        .limit(1);

      if (existing !== undefined) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'You already have a cancellation open for this subscription.',
        });
      }

      const playbook = resolvePlaybook(subscription.billingChannel, subscription.displayName);
      const deadline = computeDeadlineFor(subscription, playbook.noticePeriodDays, timezone, now);

      // Validated through the machine even though this is an insert, so `draft → in_progress`
      // stays one declared transition rather than a status literal typed in here.
      const opened = transitionCancellation('draft', 'user_started', 'in_progress');

      const created = await ctx.db.transaction(async (tx) => {
        const scope = ctx.scope.withExecutor(tx);

        const [request] = await tx
          .insert(cancellationRequests)
          .values(
            scope.own({
              subscriptionId: subscription.id,
              method: playbook.method,
              channel: subscription.billingChannel,
              status: opened.to,
              checklist: playbook.steps.map((step) => ({ ...step })),
              deadlineAt: deadline.deadlineAt,
              expectedNextChargeAt: deadline.nextRenewalAt,
              verificationWindowEndsAt: deadline.verificationWindowEndsAt,
              startedAt: now,
            }),
          )
          .returning();

        if (request === undefined) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Could not start that.' });
        }

        await tx.insert(cancellationEvents).values({
          requestId: request.id,
          at: now,
          actor: 'user',
          type: 'started',
          payload: {
            describe: opened.describe,
            channel: subscription.billingChannel,
            method: playbook.method,
            difficulty: playbook.difficulty,
            deadlineDate: deadline.deadlineDate,
          },
        });

        // The subscription itself moves to `cancel_scheduled` — it is still charging, and the
        // horizon must keep showing it until the cancellation is actually verified.
        const move = resolveTransition(subscription.status, 'cancellation_started');
        if (move !== null) {
          await tx
            .update(subscriptions)
            .set({ status: move.to, cancelByAt: deadline.deadlineAt, updatedAt: new Date() })
            .where(scope.whereId(subscriptions, subscription.id));
        }

        return request;
      });

      await writeAudit(ctx, 'cancellation.started', created.id, {
        after: {
          subscription: subscription.displayName,
          channel: subscription.billingChannel,
          method: playbook.method,
          deadlineDate: deadline.deadlineDate,
        },
      });

      return { request: created, playbook, deadline };
    }),

  /** Ticks a checklist step. `in_progress → in_progress`, which is a declared transition. */
  progressStep: protectedProcedure
    .input(z.object({ requestId: z.string().uuid(), stepId: z.string().min(1), done: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const now = ctx.clock.now();

      const request = await loadRequest(ctx, input.requestId);
      const moved = applyTransition(request.status, 'user_progressed', 'in_progress');

      if (!request.checklist.some((step) => step.id === input.stepId)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That step is not on this checklist.' });
      }

      const checklist = request.checklist.map((step) =>
        step.id === input.stepId
          ? applyDone(step, input.done ? now.toISOString() : undefined)
          : step,
      );

      const updated = await ctx.db.transaction(async (tx) => {
        const scope = ctx.scope.withExecutor(tx);
        const [row] = await tx
          .update(cancellationRequests)
          .set({ checklist, status: moved.to, updatedAt: new Date() })
          .where(scope.whereId(cancellationRequests, input.requestId))
          .returning();

        await tx.insert(cancellationEvents).values({
          requestId: input.requestId,
          at: now,
          actor: 'user',
          type: 'step_completed',
          payload: { stepId: input.stepId, done: input.done },
        });

        return row;
      });

      if (updated === undefined) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That cancellation does not exist.' });
      }
      return updated;
    }),

  /** "I've sent it." Moves to awaiting_confirmation so the follow-up job starts chasing. */
  markSubmitted: protectedProcedure
    .input(z.object({ requestId: z.string().uuid(), note: z.string().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      const request = await loadRequest(ctx, input.requestId);
      const moved = applyTransition(request.status, 'user_submitted', 'awaiting_confirmation');

      return changeStatus(ctx, request.id, moved.to, moved.describe, 'status_changed', {
        note: input.note ?? null,
      });
    }),

  /**
   * The provider said it is cancelled.
   *
   * `confirmed`, not `verified`: this records a claim. Verification is the job that watches the
   * bank feed for the charge that should not arrive, and conflating the two is exactly how a
   * tracker tells someone they are safe while a payment is in flight.
   */
  recordConfirmation: protectedProcedure
    .input(
      z.object({
        requestId: z.string().uuid(),
        confirmationReference: z.string().max(200).optional(),
        effectiveAt: z.date().optional(),
        refundExpectedMinor: z.number().int().optional(),
        refundCurrency: z.string().length(3).optional(),
        notes: z.string().max(2000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = ctx.clock.now();
      const request = await loadRequest(ctx, input.requestId);
      const moved = applyTransition(request.status, 'user_recorded_confirmation', 'confirmed');

      const updated = await ctx.db.transaction(async (tx) => {
        const scope = ctx.scope.withExecutor(tx);

        const [row] = await tx
          .update(cancellationRequests)
          .set({
            status: moved.to,
            confirmationReference: input.confirmationReference ?? null,
            effectiveAt: input.effectiveAt ?? null,
            refundExpectedMinor: input.refundExpectedMinor ?? null,
            refundCurrency: input.refundCurrency?.toUpperCase() ?? null,
            outcomeNotes: input.notes ?? null,
            updatedAt: new Date(),
          })
          .where(scope.whereId(cancellationRequests, input.requestId))
          .returning();

        await tx.insert(cancellationEvents).values({
          requestId: input.requestId,
          at: now,
          actor: 'user',
          type: 'status_changed',
          payload: {
            describe: moved.describe,
            to: moved.to,
            confirmationReference: input.confirmationReference ?? null,
          },
        });

        // The subscription follows the provider's claim, but the request stays on the board
        // until the verification window closes without a charge.
        const [subscription] = await tx
          .select({ id: subscriptions.id, status: subscriptions.status })
          .from(subscriptions)
          .where(scope.whereId(subscriptions, request.subscriptionId))
          .limit(1);

        if (subscription !== undefined) {
          const move = resolveTransition(subscription.status, 'cancellation_confirmed');
          if (move !== null) {
            await tx
              .update(subscriptions)
              .set({ status: move.to, updatedAt: new Date() })
              .where(scope.whereId(subscriptions, subscription.id));
          }
        }

        return row;
      });

      if (updated === undefined) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That cancellation does not exist.' });
      }

      await writeAudit(ctx, 'cancellation.confirmed', updated.id, {
        after: { reference: input.confirmationReference ?? null },
      });
      return updated;
    }),

  /**
   * Stops the workflow. A retention offer that was accepted is recorded as one, because
   * "abandoned" and "they offered me three months half price and I took it" are different
   * facts and only the second one explains why the charges continue.
   */
  abandon: protectedProcedure
    .input(
      z.object({
        requestId: z.string().uuid(),
        reason: z.string().max(500).optional(),
        retentionOffer: z
          .object({
            describedAs: z.string().min(1).max(300),
            valueMinor: z.number().int().optional(),
            currency: z.string().length(3).optional(),
            resetsRenewalDate: z.boolean().default(false),
          })
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = ctx.clock.now();
      const request = await loadRequest(ctx, input.requestId);

      const trigger: CancellationTrigger =
        input.retentionOffer === undefined ? 'user_abandoned' : 'user_accepted_retention_offer';
      const moved = applyTransition(request.status, trigger, 'abandoned');

      const offer = input.retentionOffer;
      const updated = await ctx.db.transaction(async (tx) => {
        const scope = ctx.scope.withExecutor(tx);

        const [row] = await tx
          .update(cancellationRequests)
          .set({
            status: moved.to,
            resolvedAt: now,
            outcomeNotes: input.reason ?? null,
            retentionOffer:
              offer === undefined
                ? null
                : {
                    describedAs: offer.describedAs,
                    ...(offer.valueMinor === undefined ? {} : { valueMinor: offer.valueMinor }),
                    ...(offer.currency === undefined
                      ? {}
                      : { currency: offer.currency.toUpperCase() }),
                    offeredAt: now.toISOString(),
                    accepted: true,
                    resetsRenewalDate: offer.resetsRenewalDate,
                  },
            updatedAt: new Date(),
          })
          .where(scope.whereId(cancellationRequests, input.requestId))
          .returning();

        await tx.insert(cancellationEvents).values({
          requestId: input.requestId,
          at: now,
          actor: 'user',
          type: offer === undefined ? 'status_changed' : 'retention_offered',
          payload: { describe: moved.describe, to: moved.to, reason: input.reason ?? null },
        });

        // The subscription is still live, so it goes back to charging in the UI rather than
        // sitting in `cancel_scheduled` forever.
        const [subscription] = await tx
          .select({ id: subscriptions.id, status: subscriptions.status })
          .from(subscriptions)
          .where(scope.whereId(subscriptions, request.subscriptionId))
          .limit(1);

        if (subscription !== undefined) {
          const move = resolveTransition(subscription.status, 'cancellation_abandoned');
          if (move !== null) {
            await tx
              .update(subscriptions)
              .set({ status: move.to, cancelByAt: null, updatedAt: new Date() })
              .where(scope.whereId(subscriptions, subscription.id));
          }
        }

        return row;
      });

      if (updated === undefined) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That cancellation does not exist.' });
      }

      await writeAudit(ctx, 'cancellation.abandoned', updated.id, {
        reason: input.reason ?? null,
        retentionOffer: offer?.describedAs ?? null,
      });
      return updated;
    }),

  /** Picks it back up — after a failed cancellation, or after changing your mind again. */
  reopen: protectedProcedure
    .input(z.object({ requestId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const now = ctx.clock.now();
      const request = await loadRequest(ctx, input.requestId);
      const moved = applyTransition(request.status, 'user_reopened', 'in_progress');

      const updated = await ctx.db.transaction(async (tx) => {
        const scope = ctx.scope.withExecutor(tx);

        const [row] = await tx
          .update(cancellationRequests)
          .set({ status: moved.to, resolvedAt: null, updatedAt: new Date() })
          .where(scope.whereId(cancellationRequests, input.requestId))
          .returning();

        await tx.insert(cancellationEvents).values({
          requestId: input.requestId,
          at: now,
          actor: 'user',
          type: 'status_changed',
          payload: { describe: moved.describe, to: moved.to },
        });

        const [subscription] = await tx
          .select({ id: subscriptions.id, status: subscriptions.status })
          .from(subscriptions)
          .where(scope.whereId(subscriptions, request.subscriptionId))
          .limit(1);

        if (subscription !== undefined) {
          const move = resolveTransition(subscription.status, 'cancellation_started');
          if (move !== null) {
            await tx
              .update(subscriptions)
              .set({ status: move.to, updatedAt: new Date() })
              .where(scope.whereId(subscriptions, subscription.id));
          }
        }

        return row;
      });

      if (updated === undefined) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That cancellation does not exist.' });
      }
      return updated;
    }),

  /** The cancel-by date, on demand — the subscription page shows it before anything is started. */
  computeDeadline: protectedProcedure
    .input(
      z.object({
        subscriptionId: z.string().uuid(),
        /** Overrides the playbook's notice period, for a provider the user knows better than us. */
        noticePeriodDays: z.number().int().min(0).max(365).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const [subscription] = await ctx.db
        .select()
        .from(subscriptions)
        .where(ctx.scope.whereId(subscriptions, input.subscriptionId))
        .limit(1);

      if (subscription === undefined) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That subscription does not exist.' });
      }

      const playbook = resolvePlaybook(subscription.billingChannel, subscription.displayName);
      const noticePeriodDays = input.noticePeriodDays ?? playbook.noticePeriodDays;

      return computeDeadlineFor(
        subscription,
        noticePeriodDays,
        ctx.user.timezone ?? 'UTC',
        ctx.clock.now(),
      );
    }),

  /**
   * Drafts the cancellation letter.
   *
   * The response is text for the user to copy and send themselves. Nothing in this codebase
   * sends it, and the draft makes no claim about anyone's rights or obligations — it is a
   * customer asking, in the first person, for their subscription to stop (docs/legal-notes.md).
   */
  generateLetter: protectedProcedure
    .input(z.object({ requestId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const now = ctx.clock.now();
      const timezone = ctx.user.timezone ?? 'UTC';

      const [row] = await ctx.db
        .select({ request: cancellationRequests, subscription: subscriptions })
        .from(cancellationRequests)
        .innerJoin(subscriptions, eq(cancellationRequests.subscriptionId, subscriptions.id))
        .where(ctx.scope.whereId(cancellationRequests, input.requestId))
        .limit(1);

      if (row === undefined) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That cancellation does not exist.' });
      }

      const letter = renderLetter({
        userName: ctx.user.name,
        userEmail: ctx.user.email,
        displayName: row.subscription.displayName,
        amount: money(row.subscription.amountMinor, row.subscription.currency),
        cadence: intervalLabel(
          interval(row.subscription.intervalUnit, row.subscription.intervalCount),
        ),
        lastChargedOn:
          row.subscription.lastChargedAt === null
            ? null
            : formatPlainDate(fromInstant(row.subscription.lastChargedAt, timezone)),
        locale: ctx.user.locale ?? 'en-US',
        today: formatPlainDate(fromInstant(now, timezone)),
      });

      await ctx.db.transaction(async (tx) => {
        const scope = ctx.scope.withExecutor(tx);
        await tx
          .update(cancellationRequests)
          .set({ generatedLetter: letter.body, updatedAt: new Date() })
          .where(scope.whereId(cancellationRequests, input.requestId));

        await tx.insert(cancellationEvents).values({
          requestId: input.requestId,
          at: now,
          actor: 'user',
          type: 'letter_generated',
          payload: { subject: letter.subject },
        });
      });

      return letter;
    }),

  /**
   * The reclaimed counter (brief §6): what cancelling has actually saved.
   *
   * Counts only subscriptions whose cancellation reached `verified` — the expected charge did
   * not arrive. A counter that credited `confirmed` would be counting promises, and this is the
   * one number in the product that is allowed to be green.
   */
  reclaimed: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: subscriptions.id,
        amountMinor: subscriptions.amountMinor,
        currency: subscriptions.currency,
        intervalUnit: subscriptions.intervalUnit,
        intervalCount: subscriptions.intervalCount,
        status: subscriptions.status,
        category: subscriptions.category,
        displayName: subscriptions.displayName,
        verifiedAt: cancellationRequests.verifiedAt,
      })
      .from(cancellationRequests)
      .innerJoin(subscriptions, eq(cancellationRequests.subscriptionId, subscriptions.id))
      .where(
        ctx.scope.where(cancellationRequests, eq(cancellationRequests.status, 'verified')),
      )
      .orderBy(desc(cancellationRequests.verifiedAt));

    const inputs: CommitmentInput[] = rows.map((row) => ({
      id: row.id,
      amountMinor: row.amountMinor,
      currency: row.currency,
      interval: interval(row.intervalUnit, row.intervalCount),
      status: row.status,
      category: row.category,
    }));

    // `includeStatus` is overridden because these are, by definition, no longer committed —
    // the default filter would exclude every row and report a saving of zero.
    const totals = aggregateCommitments(inputs, {
      displayCurrency: ctx.user.displayCurrency ?? 'USD',
      rates: RATES,
      asOf: formatPlainDate(fromInstant(ctx.clock.now(), ctx.user.timezone ?? 'UTC')),
      includeStatus: () => true,
    });

    return {
      monthlyMinor: totals.monthly.amountMinor,
      annualMinor: totals.annual.amountMinor,
      currency: totals.monthly.currency,
      count: totals.count,
      unconvertibleIds: totals.unconvertible,
      items: rows.map((row) => ({
        id: row.id,
        displayName: row.displayName,
        amountMinor: row.amountMinor,
        currency: row.currency,
        verifiedAt: row.verifiedAt,
      })),
    };
  }),
});

// ── internals ────────────────────────────────────────────────────────────────────────────

type RequestRow = typeof cancellationRequests.$inferSelect;
type ChecklistStep = RequestRow['checklist'][number];

/**
 * What the helpers below actually need. Narrower than the tRPC context on purpose: it makes it
 * obvious at a glance that none of them reach for the session or the request headers.
 */
interface CancellationContext {
  readonly db: Database;
  readonly scope: Scope;
  readonly clock: Clock;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/** `exactOptionalPropertyTypes` forbids writing `doneAt: undefined`, so the key is spread in. */
function applyDone(step: ChecklistStep, doneAt: string | undefined): ChecklistStep {
  const { doneAt: _previous, ...rest } = step;
  return doneAt === undefined ? rest : { ...rest, doneAt };
}

/**
 * Turns a refused transition into a message rather than a 500.
 *
 * The machine throws a `LedgerError`; a user who double-clicked "Confirm" deserves "that has
 * already been confirmed", not an internal error.
 */
function applyTransition(
  from: CancellationStatus,
  trigger: CancellationTrigger,
  to: CancellationStatus,
): { to: CancellationStatus; describe: string } {
  try {
    const moved = transitionCancellation(from, trigger, to);
    return { to: moved.to, describe: moved.describe };
  } catch (error) {
    if (isLedgerError(error)) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: `This cancellation is ${CANCELLATION_STATUS_LABELS[from].toLowerCase()} — that step no longer applies.`,
        cause: error,
      });
    }
    throw error;
  }
}

interface LetterInput {
  readonly userName: string;
  readonly userEmail: string;
  readonly displayName: string;
  readonly amount: Money;
  readonly cadence: string;
  readonly lastChargedOn: string | null;
  readonly locale: string;
  readonly today: string;
}

/**
 * The letter body.
 *
 * First person, no statutes, no assertion of rights, no guarantee of outcome — it asks for the
 * subscription to stop and for written confirmation, which is what makes it useful later. The
 * account identifiers are the ones Ledger actually holds: a name, an email, and the amount that
 * has been leaving the account.
 */
function renderLetter(input: LetterInput): {
  subject: string;
  body: string;
  howToSend: string;
} {
  const amount = formatMoney(input.amount, { locale: input.locale });
  const lastCharge =
    input.lastChargedOn === null ? '' : `\nMost recent payment: ${input.lastChargedOn}`;

  return {
    subject: `Cancellation of my ${input.displayName} subscription`,
    body: [
      input.today,
      '',
      `To whom it may concern,`,
      '',
      `I am writing to cancel my ${input.displayName} subscription. Please treat this email as my cancellation request and stop taking payments from the end of my current billing period.`,
      '',
      `Account name: ${input.userName}`,
      `Account email: ${input.userEmail}`,
      `Amount charged: ${amount}, ${input.cadence.toLowerCase()}${lastCharge}`,
      '',
      `Please reply to confirm the cancellation, the date it takes effect, and a reference number I can quote. Please also confirm that no further payments will be taken.`,
      '',
      `Thank you,`,
      input.userName,
    ].join('\n'),
    howToSend:
      'Copy this into an email and send it from your own address. Ledger does not send anything on your behalf. Keep the reply — it is the evidence if a charge appears anyway.',
  };
}

async function loadRequest(ctx: CancellationContext, id: string): Promise<RequestRow> {
  const [row] = await ctx.db
    .select()
    .from(cancellationRequests)
    .where(ctx.scope.whereId(cancellationRequests, id))
    .limit(1);

  if (row === undefined) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'That cancellation does not exist.' });
  }
  return row;
}

/** A status change with its event, for the transitions that carry no other payload. */
async function changeStatus(
  ctx: CancellationContext,
  requestId: string,
  status: CancellationStatus,
  describe: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<RequestRow> {
  const now = ctx.clock.now();

  const updated = await ctx.db.transaction(async (tx) => {
    const scope = ctx.scope.withExecutor(tx);
    const [row] = await tx
      .update(cancellationRequests)
      .set({ status, updatedAt: new Date() })
      .where(scope.whereId(cancellationRequests, requestId))
      .returning();

    await tx.insert(cancellationEvents).values({
      requestId,
      at: now,
      actor: 'user',
      type,
      payload: { ...payload, describe, to: status },
    });

    return row;
  });

  if (updated === undefined) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'That cancellation does not exist.' });
  }
  return updated;
}

function writeAudit(
  ctx: CancellationContext,
  action: string,
  entityId: string | null,
  meta: Record<string, unknown>,
): Promise<void> {
  return recordAudit(
    ctx.db,
    ctx.scope,
    { ip: ctx.ip, userAgent: ctx.userAgent },
    action,
    'cancellation',
    entityId,
    meta,
  );
}
