'use client';

import { useState, type ReactNode } from 'react';
import { Bell, Check } from 'lucide-react';
import type { NotificationType } from '@ledger/core';
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
  Skeleton,
  cn,
  toast,
} from '@ledger/ui';
import { api } from '~/lib/trpc';

/**
 * The bell.
 *
 * There is no notifications *page* in the navigation, so this popover is the inbox: unread
 * first, newest next, and the read ones fade rather than disappear — "what did it tell me
 * yesterday" is a question people ask after a charge they did not expect.
 *
 * The count is `--control`, never `--alert`. Ten renewal reminders are not ten problems, and a
 * permanently red bell is a bell nobody reads.
 */

/**
 * What each notification type says, in one line.
 *
 * The rows carry a `type` and a payload blob, not a rendered sentence — the templates live in
 * @ledger/notify for email, and the in-app inbox has always needed its own shorter register.
 * When that package grows a shared renderer this map is what it replaces.
 */
const TYPE_LABELS: Readonly<Record<NotificationType, string>> = {
  trial_ending: 'Trial ends soon',
  renewal_upcoming: 'Renews soon',
  price_changed: 'The price changed',
  cancel_by_deadline: 'Cancel-by date is close',
  cancellation_unconfirmed: 'Cancellation still unconfirmed',
  charged_after_cancellation: 'Charged after you cancelled',
  new_detections: 'New subscriptions to review',
  sync_failed: 'A bank sync failed',
  consent_expiring: 'Bank access expires soon',
  duplicate_detected: 'Possible duplicate',
};

/**
 * The four types that are genuinely a problem, per the palette rules: a price rise, a trial
 * about to convert, a cancel-by date running out, and a charge that arrived after cancelling.
 * Everything else is information, and information is not red.
 */
const PROBLEM_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>([
  'trial_ending',
  'price_changed',
  'cancel_by_deadline',
  'charged_after_cancellation',
]);

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** Coarse and honest: nobody needs "3 minutes ago" precision on a renewal reminder. */
function relativeTime(from: Date, now: number): string {
  const seconds = Math.round((from.getTime() - now) / 1000);
  const absolute = Math.abs(seconds);
  if (absolute < 3600) return RELATIVE.format(Math.round(seconds / 60), 'minute');
  if (absolute < 86_400) return RELATIVE.format(Math.round(seconds / 3600), 'hour');
  return RELATIVE.format(Math.round(seconds / 86_400), 'day');
}

export function NotificationBell(): ReactNode {
  const [open, setOpen] = useState(false);
  const utils = api.useUtils();

  const unread = api.notifications.unreadCount.useQuery();
  // Only fetched once the popover has been opened: the count is what the closed bell needs, and
  // the list is thirty rows nobody has asked for yet.
  const inbox = api.notifications.inbox.useQuery({ limit: 12 }, { enabled: open });

  const markAllRead = api.notifications.markAllRead.useMutation({
    onSuccess: async (result) => {
      await Promise.all([utils.notifications.unreadCount.invalidate(), utils.notifications.inbox.invalidate()]);
      toast(result.count === 1 ? '1 notification marked read.' : `${result.count} notifications marked read.`);
    },
    onError: () => {
      toast.error('Could not mark those read. Try again.');
    },
  });

  const count = unread.data ?? 0;
  const now = Date.now();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          className="relative"
          aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
        >
          <Bell aria-hidden className="size-4" strokeWidth={1.75} />
          {count > 0 ? (
            <span
              aria-hidden
              className={cn(
                'absolute -right-0.5 -top-0.5 grid min-w-3.5 place-items-center rounded-sm',
                'border border-control/40 bg-control px-0.5 font-mono text-[0.5625rem] leading-3 text-ink-900',
              )}
            >
              {count > 9 ? '9+' : count}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" sideOffset={8} className="w-[22rem] max-w-[calc(100vw-1.5rem)] p-0">
        <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
          <p className="eyebrow">Notifications</p>
          {count > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              loading={markAllRead.isPending}
              onClick={() => {
                markAllRead.mutate();
              }}
            >
              <Check aria-hidden className="size-3.5" strokeWidth={1.75} />
              Mark all read
            </Button>
          ) : null}
        </div>

        {inbox.isPending ? (
          <div className="flex flex-col gap-2 p-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : inbox.data === undefined || inbox.data.items.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-text-2">
            Nothing yet. Alerts about trials, renewals and price changes land here.
          </p>
        ) : (
          <ScrollArea className="max-h-80">
            <ul className="flex flex-col">
              {inbox.data.items.map(({ notification, subscriptionName }) => {
                const isUnread = notification.readAt === null;
                const isProblem = PROBLEM_TYPES.has(notification.type);
                // What the user cares about is when they were told, which is when it was sent.
                // `createdAt` is when the scheduler wrote the row, and quiet hours can put days
                // between the two.
                const at = notification.sentAt ?? notification.createdAt;
                return (
                  <li
                    key={notification.id}
                    className={cn(
                      'flex gap-2 border-b border-line px-3 py-2 last:border-b-0',
                      isUnread && 'bg-ink-700/50',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'mt-1.5 size-1.5 shrink-0 rounded-sm',
                        !isUnread ? 'bg-transparent' : isProblem ? 'bg-alert' : 'bg-control',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className={cn('text-[0.8125rem] leading-tight', isUnread ? 'text-text' : 'text-text-2')}>
                        {TYPE_LABELS[notification.type]}
                      </p>
                      {subscriptionName === null ? null : (
                        <p className="mt-0.5 truncate text-xs leading-snug text-text-2">{subscriptionName}</p>
                      )}
                      <p className="mt-1 font-mono text-[0.6875rem] text-text-3">{relativeTime(at, now)}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        )}
      </PopoverContent>
    </Popover>
  );
}
