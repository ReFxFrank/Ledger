import 'server-only';

import { desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  DEFAULT_LEAD_TIME_DAYS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  type NotificationChannel,
} from '@ledger/core';
import {
  notificationPreferences,
  notificationSettings,
  notifications,
  pushSubscriptions,
  subscriptions,
} from '@ledger/db';
import { protectedProcedure, router } from '~/server/trpc/init';

/**
 * Notifications (brief §8).
 *
 * The scheduler and the sender live in the worker; this router is the user's side of it — the
 * in-app inbox, what they want to be told about, and which devices are registered for push.
 *
 * Nothing here writes a `notifications` row. Scheduling goes through the job that owns the
 * `dedupe_key` uniqueness, and a route that inserted one directly would be the first way a user
 * gets told the same thing twice.
 */

const channelSchema = z.enum(NOTIFICATION_CHANNELS);
const typeSchema = z.enum(NOTIFICATION_TYPES);

export const notificationsRouter = router({
  /**
   * The in-app inbox.
   *
   * Unread first, then newest — an inbox sorted purely by date buries the one thing that still
   * needs a decision under a fortnight of things that do not.
   */
  inbox: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).default(30),
          cursor: z.number().int().min(0).default(0),
          unreadOnly: z.boolean().default(false),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select({
          notification: notifications,
          subscriptionName: subscriptions.displayName,
        })
        .from(notifications)
        .leftJoin(subscriptions, eq(notifications.subscriptionId, subscriptions.id))
        .where(
          ctx.scope.where(
            notifications,
            eq(notifications.channel, 'in_app'),
            input.unreadOnly ? isNull(notifications.readAt) : undefined,
          ),
        )
        .orderBy(
          // `nulls first` is the whole ordering: an unread row has no `read_at`.
          sql`${notifications.readAt} asc nulls first`,
          desc(notifications.createdAt),
        )
        .limit(input.limit)
        .offset(input.cursor);

      return {
        items: rows,
        nextCursor: rows.length === input.limit ? input.cursor + input.limit : null,
      };
    }),

  unreadCount: protectedProcedure.query(async ({ ctx }) => {
    const [row] = await ctx.db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(
        ctx.scope.where(
          notifications,
          eq(notifications.channel, 'in_app'),
          isNull(notifications.readAt),
        ),
      );

    return row?.count ?? 0;
  }),

  markRead: protectedProcedure
    .input(z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.scope.assertOwnsAll(notifications, input.ids);

      const updated = await ctx.db
        .update(notifications)
        .set({ readAt: ctx.clock.now() })
        .where(
          ctx.scope.where(
            notifications,
            inArray(notifications.id, input.ids),
            // Already-read rows keep their original timestamp: "when did I first see this"
            // is the useful fact, and re-stamping it loses it.
            isNull(notifications.readAt),
          ),
        )
        .returning({ id: notifications.id });

      return { count: updated.length };
    }),

  markAllRead: protectedProcedure.mutation(async ({ ctx }) => {
    const updated = await ctx.db
      .update(notifications)
      .set({ readAt: ctx.clock.now() })
      .where(
        ctx.scope.where(
          notifications,
          eq(notifications.channel, 'in_app'),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });

    return { count: updated.length };
  }),

  /**
   * What the user wants to be told about, and when.
   *
   * Every type is returned, whether or not a row exists — a preferences screen that only lists
   * the types someone has already touched is a screen where the defaults are invisible. Missing
   * rows fall back to `DEFAULT_LEAD_TIME_DAYS` from @ledger/core, which is the same table the
   * scheduler reads, so the UI cannot show a default the worker does not honour.
   */
  preferences: protectedProcedure.query(async ({ ctx }) => {
    const [rows, [settings]] = await Promise.all([
      ctx.db
        .select()
        .from(notificationPreferences)
        .where(ctx.scope.where(notificationPreferences)),
      ctx.db
        .select()
        .from(notificationSettings)
        .where(eq(notificationSettings.userId, ctx.user.id))
        .limit(1),
    ]);

    const byType = new Map(rows.map((row) => [row.type, row]));

    return {
      types: NOTIFICATION_TYPES.map((type) => {
        const stored = byType.get(type);
        return {
          type,
          channels: (stored?.channels ?? ['email', 'in_app']) as NotificationChannel[],
          leadTimeDays: stored?.leadTimeDays ?? DEFAULT_LEAD_TIME_DAYS[type],
          isDefault: stored === undefined,
        };
      }),
      settings: {
        quietHoursEnabled: settings?.quietHoursEnabled !== 'false',
        quietHoursStartMinute: settings?.quietHoursStartMinute ?? 1320,
        quietHoursEndMinute: settings?.quietHoursEndMinute ?? 480,
        digestDayOfWeek: settings?.digestDayOfWeek ?? 0,
        digestMinute: settings?.digestMinute ?? 1080,
        renewalAlertThresholdMinor: settings?.renewalAlertThresholdMinor ?? 2000,
      },
    };
  }),

  updatePreferences: protectedProcedure
    .input(
      z.object({
        types: z
          .array(
            z.object({
              type: typeSchema,
              /** Empty means "never tell me about this". A valid choice, so it is not rejected. */
              channels: z.array(channelSchema).max(NOTIFICATION_CHANNELS.length),
              leadTimeDays: z.number().int().min(0).max(90),
            }),
          )
          .max(NOTIFICATION_TYPES.length)
          .default([]),
        settings: z
          .object({
            quietHoursEnabled: z.boolean(),
            /** Minutes from local midnight — a wall-clock statement that survives travel and DST. */
            quietHoursStartMinute: z.number().int().min(0).max(1439),
            quietHoursEndMinute: z.number().int().min(0).max(1439),
            digestDayOfWeek: z.number().int().min(0).max(6),
            digestMinute: z.number().int().min(0).max(1439),
            renewalAlertThresholdMinor: z.number().int().min(0),
          })
          .partial()
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();

      await ctx.db.transaction(async (tx) => {
        const scope = ctx.scope.withExecutor(tx);

        for (const preference of input.types) {
          await tx
            .insert(notificationPreferences)
            .values(
              scope.own({
                type: preference.type,
                channels: preference.channels,
                leadTimeDays: preference.leadTimeDays,
              }),
            )
            // The unique index is (user_id, type), so this is an upsert rather than a
            // read-modify-write that two open settings tabs could race.
            .onConflictDoUpdate({
              target: [notificationPreferences.userId, notificationPreferences.type],
              set: {
                channels: preference.channels,
                leadTimeDays: preference.leadTimeDays,
                updatedAt: now,
              },
            });
        }

        const settings = input.settings;
        if (settings !== undefined) {
          await tx
            .insert(notificationSettings)
            .values({
              userId: ctx.user.id,
              ...(settings.quietHoursEnabled === undefined
                ? {}
                : // The column is text, not boolean (frozen schema); normalise at the boundary
                  // so nothing downstream has to guess what 'TRUE' or '1' would mean.
                  { quietHoursEnabled: settings.quietHoursEnabled ? 'true' : 'false' }),
              ...(settings.quietHoursStartMinute === undefined
                ? {}
                : { quietHoursStartMinute: settings.quietHoursStartMinute }),
              ...(settings.quietHoursEndMinute === undefined
                ? {}
                : { quietHoursEndMinute: settings.quietHoursEndMinute }),
              ...(settings.digestDayOfWeek === undefined
                ? {}
                : { digestDayOfWeek: settings.digestDayOfWeek }),
              ...(settings.digestMinute === undefined ? {} : { digestMinute: settings.digestMinute }),
              ...(settings.renewalAlertThresholdMinor === undefined
                ? {}
                : { renewalAlertThresholdMinor: settings.renewalAlertThresholdMinor }),
            })
            .onConflictDoUpdate({
              target: notificationSettings.userId,
              set: {
                ...(settings.quietHoursEnabled === undefined
                  ? {}
                  : { quietHoursEnabled: settings.quietHoursEnabled ? 'true' : 'false' }),
                ...(settings.quietHoursStartMinute === undefined
                  ? {}
                  : { quietHoursStartMinute: settings.quietHoursStartMinute }),
                ...(settings.quietHoursEndMinute === undefined
                  ? {}
                  : { quietHoursEndMinute: settings.quietHoursEndMinute }),
                ...(settings.digestDayOfWeek === undefined
                  ? {}
                  : { digestDayOfWeek: settings.digestDayOfWeek }),
                ...(settings.digestMinute === undefined
                  ? {}
                  : { digestMinute: settings.digestMinute }),
                ...(settings.renewalAlertThresholdMinor === undefined
                  ? {}
                  : { renewalAlertThresholdMinor: settings.renewalAlertThresholdMinor }),
                updatedAt: now,
              },
            });
        }
      });

      return { ok: true };
    }),

  /**
   * Registers a Web Push endpoint.
   *
   * The endpoint is unique across the whole table, so a device that re-subscribes after a
   * browser restart updates its keys rather than accumulating a second row that fails to send.
   */
  registerPush: protectedProcedure
    .input(
      z.object({
        endpoint: z.string().url().max(2000),
        p256dh: z.string().min(1).max(500),
        auth: z.string().min(1).max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .insert(pushSubscriptions)
        .values(
          ctx.scope.own({
            endpoint: input.endpoint,
            p256dh: input.p256dh,
            auth: input.auth,
            userAgent: ctx.userAgent,
            lastUsedAt: ctx.clock.now(),
          }),
        )
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: {
            p256dh: input.p256dh,
            auth: input.auth,
            userAgent: ctx.userAgent,
            lastUsedAt: ctx.clock.now(),
          },
          // Scoped: an endpoint already registered to a different account is not this user's to
          // overwrite, and without this the upsert would silently move it.
          setWhere: eq(pushSubscriptions.userId, ctx.user.id),
        })
        .returning({ id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint });

      if (row === undefined) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'That device is already registered to another account.',
        });
      }
      return row;
    }),

  unregisterPush: protectedProcedure
    .input(z.object({ endpoint: z.string().url().max(2000) }))
    .mutation(async ({ ctx, input }) => {
      const removed = await ctx.db
        .delete(pushSubscriptions)
        .where(ctx.scope.where(pushSubscriptions, eq(pushSubscriptions.endpoint, input.endpoint)))
        .returning({ id: pushSubscriptions.id });

      return { count: removed.length };
    }),

  /** The registered devices, so someone can see what they have signed up and turn one off. */
  devices: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select({
        id: pushSubscriptions.id,
        endpoint: pushSubscriptions.endpoint,
        userAgent: pushSubscriptions.userAgent,
        createdAt: pushSubscriptions.createdAt,
        lastUsedAt: pushSubscriptions.lastUsedAt,
      })
      .from(pushSubscriptions)
      .where(ctx.scope.where(pushSubscriptions))
      .orderBy(desc(pushSubscriptions.createdAt));
  }),
});
