'use client';

/**
 * One subscription, in full.
 *
 * The header answers the three questions someone opens this screen with — what does it cost, when
 * does it next charge, and how do I get out — and the primary action is the way out. Everything
 * below is evidence: the charges, the prices it has been, where it came from, who it is split
 * with, and what the user has written down about it.
 */

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Archive, ArrowLeft, ArrowUpRight, Pencil, ScissorsLineDashed, Undo2 } from 'lucide-react';
import {
  BILLING_CHANNEL_LABELS,
  CATEGORY_LABELS,
  type SubscriptionSource,
  formatPlainDate,
  fromInstant,
  interval,
  intervalLabel,
  isIntermediated,
} from '@ledger/core';
import {
  Badge,
  Button,
  DescriptorDecoder,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Money,
  Panel,
  PanelBody,
  PanelHeader,
  Skeleton,
  StatusPill,
  cn,
  toast,
} from '@ledger/ui';
import { api } from '~/lib/trpc';
import { annualCostLabel, daysUntil, formatDay, formatRelativeDay, todayIn } from '~/lib/format';
import { ChargeTimeline, PriceHistory } from './detail-history';
import { SharesEditor } from './detail-shares';
import { AttachmentsPanel, NotesPanel, UsagePanel } from './detail-usage';
import { SubscriptionEditor } from './editor';

const SOURCE_LABELS: Readonly<Record<SubscriptionSource, string>> = {
  manual: 'Added by you',
  detected: 'Found in your bank feed',
  csv_import: 'Imported from a CSV',
  email_receipt: 'Read from an email receipt',
};

export function SubscriptionDetail({ id }: { readonly id: string }): React.ReactElement {
  const router = useRouter();
  const utils = api.useUtils();
  const [editing, setEditing] = React.useState(false);
  const [confirmArchive, setConfirmArchive] = React.useState(false);

  const me = api.me.current.useQuery();
  const detail = api.subscriptions.byId.useQuery({ id });

  /**
   * Where this came from.
   *
   * There is no `subscriptions.provenance` procedure, so the confirmed detections are read and
   * matched on `subscriptionId`. That is one page of detections rather than a targeted lookup —
   * fine at the sizes this runs at, and it means the decoder and the charge timeline show real
   * data instead of a placeholder. A dedicated procedure would replace both queries with one.
   */
  const confirmedDetections = api.review.list.useQuery({ status: 'confirmed', limit: 200 });
  const detection =
    confirmedDetections.data?.items.find((item) => item.detection.subscriptionId === id) ?? null;

  const charges = api.review.supportingTransactions.useQuery(
    { detectionId: detection?.detection.id ?? '' },
    { enabled: detection !== null },
  );

  const locale = me.data?.locale ?? 'en-GB';
  const timezone = me.data?.timezone ?? 'UTC';
  const today = todayIn(timezone);

  const startCancellation = api.cancellations.start.useMutation({
    onSuccess: async (result) => {
      await utils.subscriptions.byId.invalidate({ id });
      await utils.subscriptions.list.invalidate();
      toast.success('Cancellation started.');
      router.push(`/cancellations/${result.request.id}`);
    },
    onError: (error) => {
      toast.error('Could not start that.', { description: error.message });
    },
  });

  const archive = api.subscriptions.archive.useMutation({
    onSuccess: async (_result, variables) => {
      await utils.subscriptions.byId.invalidate({ id });
      await utils.subscriptions.list.invalidate();
      setConfirmArchive(false);
      toast.success(variables.archived ? 'Archived.' : 'Restored.');
    },
    onError: (error) => {
      toast.error('Could not do that.', { description: error.message });
    },
  });

  if (detail.isPending) {
    return (
      <div className="flex flex-col gap-[var(--gap-loose)]">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (detail.error !== null || detail.data === undefined) {
    return (
      <Panel>
        <EmptyState
          actions={
            <Button size="sm" variant="secondary" asChild>
              <Link href="/subscriptions">
                <ArrowLeft className="size-3.5" aria-hidden />
                Back to subscriptions
              </Link>
            </Button>
          }
        >
          That subscription is not here. It may have been deleted from another device.
        </EmptyState>
      </Panel>
    );
  }

  const row = detail.data.subscription;
  const merchant = detail.data.merchant;
  const cadence = interval(row.intervalUnit, row.intervalCount);
  const annual = annualCostLabel(row.amountMinor, row.currency, cadence, locale);
  const nextDate = row.nextRenewalAt === null ? null : fromInstant(row.nextRenewalAt, timezone);
  const trialClosing =
    row.status === 'trialing' &&
    row.trialEndsAt !== null &&
    daysUntil(fromInstant(row.trialEndsAt, timezone), today) <= 3;
  const cancelByMissed =
    row.cancelByAt !== null && daysUntil(fromInstant(row.cancelByAt, timezone), today) < 0;

  const exitable = row.status !== 'canceled' && row.status !== 'cancel_scheduled';
  const rawDescriptor = charges.data?.[0]?.rawDescriptor ?? null;

  return (
    <div className="flex flex-col gap-[var(--gap-loose)]">
      {/* ── header ─────────────────────────────────────────────────────────────────── */}
      <Panel>
        <PanelBody className="flex flex-col gap-[var(--gap-loose)]">
          <div className="flex flex-wrap items-start justify-between gap-[var(--gap)]">
            <div className="flex min-w-0 items-center gap-[var(--gap-tight)]">
              <span
                aria-hidden
                className="grid size-9 shrink-0 place-items-center rounded-md border border-line bg-ink-700 text-sm font-medium text-text-2"
              >
                {(merchant?.name ?? row.displayName).trim().charAt(0).toUpperCase()}
              </span>
              <div className="min-w-0">
                <h1 className="truncate text-lg font-medium leading-tight text-text">{row.displayName}</h1>
                <p className="truncate text-xs text-text-2">
                  {merchant === null ? 'No merchant matched' : merchant.name}
                  <span className="text-text-3"> · </span>
                  {BILLING_CHANNEL_LABELS[row.billingChannel]}
                  <span className="text-text-3"> · </span>
                  {CATEGORY_LABELS[row.category]}
                </p>
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-[var(--gap-tight)]">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditing(true);
                }}
              >
                <Pencil className="size-3.5" aria-hidden />
                Edit
              </Button>
              {row.url === null ? null : (
                <Button size="sm" variant="ghost" asChild>
                  <a href={row.url} target="_blank" rel="noreferrer noopener">
                    <ArrowUpRight className="size-3.5" aria-hidden />
                    Open account
                  </a>
                </Button>
              )}
              {exitable ? (
                <Button
                  size="sm"
                  variant="primary"
                  loading={startCancellation.isPending}
                  onClick={() => {
                    startCancellation.mutate({ subscriptionId: id });
                  }}
                >
                  <ScissorsLineDashed className="size-3.5" aria-hidden />
                  Start cancellation
                </Button>
              ) : (
                <Button size="sm" variant="secondary" asChild>
                  <Link href="/cancellations">Open cancellation</Link>
                </Button>
              )}
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-[var(--gap)] sm:grid-cols-4">
            <Stat label="Charge">
              <Money
                amountMinor={row.amountMinor}
                currency={row.currency}
                tone="outflow"
                size="xl"
                locale={locale}
              />
            </Stat>
            <Stat label="Cadence">
              <span className="text-sm text-text">{intervalLabel(cadence)}</span>
              {annual === null ? null : (
                <span className="block font-mono text-xs text-text-3">{annual}</span>
              )}
            </Stat>
            <Stat label="Next charge">
              {nextDate === null ? (
                <span className="text-sm text-text-3">Not scheduled</span>
              ) : (
                <>
                  <span className="text-sm text-text">{formatRelativeDay(nextDate, today, locale)}</span>
                  <time dateTime={formatPlainDate(nextDate)} className="block font-mono text-xs text-text-3">
                    {formatDay(nextDate, locale)}
                  </time>
                </>
              )}
            </Stat>
            <Stat label="Status">
              <StatusPill status={row.status} problem={trialClosing || cancelByMissed} />
              {row.archivedAt === null ? null : (
                <Badge tone="neutral" className="ml-1.5">
                  Archived
                </Badge>
              )}
            </Stat>
          </dl>

          {/*
            An intermediated channel is the single most damaging thing to get wrong: the
            provider's own website cannot cancel an App Store subscription, and sending someone
            there wastes their afternoon and their next renewal.
          */}
          {isIntermediated(row.billingChannel) ? (
            <p className="rounded-md border border-line bg-ink-700 px-[var(--pad-card)] py-2 text-xs text-text-2">
              {BILLING_CHANNEL_LABELS[row.billingChannel]} takes this payment, so it is cancelled there
              rather than on the provider&rsquo;s website.
            </p>
          ) : null}
        </PanelBody>
      </Panel>

      <div className="grid gap-[var(--gap-loose)] lg:grid-cols-[1.35fr_1fr]">
        <div className="flex min-w-0 flex-col gap-[var(--gap-loose)]">
          <ChargeTimeline
            charges={(charges.data ?? []).map((charge) => ({
              id: charge.id,
              postedAt: charge.postedAt,
              amountMinor: charge.amountMinor,
              currency: charge.currency,
              rawDescriptor: charge.rawDescriptor,
              pending: charge.pending,
            }))}
            loading={detection !== null && charges.isPending}
            locale={locale}
            timezone={timezone}
          />

          <PriceHistory history={detail.data.priceHistory} locale={locale} />

          <SharesEditor
            subscriptionId={id}
            amountMinor={row.amountMinor}
            currency={row.currency}
            locale={locale}
            shares={detail.data.shares}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-[var(--gap-loose)]">
          {/* ── provenance ──────────────────────────────────────────────────────────── */}
          <Panel>
            <PanelHeader eyebrow="Where this came from">
              {SOURCE_LABELS[row.source]}
              {row.source === 'detected' ? (
                <span className="text-text-3"> · {confidenceLabel(row.confidence)} confident</span>
              ) : null}
            </PanelHeader>
            <PanelBody>
              {rawDescriptor === null ? (
                <p className="text-xs text-text-2">
                  {row.source === 'detected'
                    ? 'The charges behind this match are no longer available to show.'
                    : 'Added by hand, so there is no bank descriptor to decode.'}
                </p>
              ) : (
                /*
                  The decoder is handed the descriptor and the clustering key and nothing else.
                  It never re-derives its own highlight, and neither does this screen: the
                  matched/stripped spans belong to detection, and until the API returns them a
                  missing highlight is honest where a guessed one would not be.
                */
                <DescriptorDecoder
                  raw={rawDescriptor}
                  normalized={detection?.detection.normalizedKey ?? ''}
                  {...(merchant === null ? {} : { merchantName: merchant.name })}
                  showLegend
                />
              )}
            </PanelBody>
          </Panel>

          <UsagePanel
            subscriptionId={id}
            usage={detail.data.usage}
            amountMinor={row.amountMinor}
            currency={row.currency}
            intervalUnit={row.intervalUnit}
            intervalCount={row.intervalCount}
            locale={locale}
            timezone={timezone}
          />

          <NotesPanel subscriptionId={id} notes={row.notes} tags={row.tags} />

          {/* No procedure returns attachments for a subscription yet, so this stays empty until
              a cancellation puts something in it. See the note in the handover. */}
          <AttachmentsPanel attachments={[]} locale={locale} timezone={timezone} />

          {/* ── danger zone ─────────────────────────────────────────────────────────── */}
          <Panel className="border-alert/25">
            <PanelHeader eyebrow="Danger zone" />
            <PanelBody className="flex flex-col gap-[var(--gap-loose)]">
              <div className="flex flex-wrap items-start justify-between gap-[var(--gap-tight)]">
                <p className="min-w-0 max-w-prose text-xs text-text-2">
                  {row.archivedAt === null
                    ? 'Archiving hides this from the table and stops its reminders. It keeps every charge and price it has recorded, and you can restore it whenever you want.'
                    : 'This is archived. Restoring puts it back in the table and starts its reminders again.'}
                </p>
                {row.archivedAt === null ? (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      setConfirmArchive(true);
                    }}
                  >
                    <Archive className="size-3.5" aria-hidden />
                    Archive
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={archive.isPending}
                    onClick={() => {
                      archive.mutate({ ids: [id], archived: false });
                    }}
                  >
                    <Undo2 className="size-3.5" aria-hidden />
                    Restore
                  </Button>
                )}
              </div>

              <div className="flex flex-wrap items-start justify-between gap-[var(--gap-tight)] border-t border-line pt-[var(--gap-loose)]">
                <p className="min-w-0 max-w-prose text-xs text-text-2">
                  Deleting a subscription would take its charge history with it, so Ledger archives
                  instead. To remove this data entirely, export or delete your account data in
                  settings.
                </p>
                <Button size="sm" variant="ghost" asChild>
                  <Link href="/settings/data">Account data</Link>
                </Button>
              </div>
            </PanelBody>
          </Panel>
        </div>
      </div>

      <Dialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Archive {row.displayName}?</DialogTitle>
            <DialogDescription>
              It leaves the table and stops sending reminders. Nothing is deleted, and you can
              restore it from the archived view.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="hidden" />
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setConfirmArchive(false);
              }}
            >
              Keep it
            </Button>
            <Button
              size="sm"
              variant="danger"
              loading={archive.isPending}
              onClick={() => {
                archive.mutate({ ids: [id], archived: true });
              }}
            >
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {editing ? (
        <SubscriptionEditor
          open
          subscriptionId={id}
          onOpenChange={(next) => {
            if (!next) setEditing(false);
          }}
        />
      ) : null}
    </div>
  );
}

function Stat({ label, children }: { readonly label: string; readonly children: React.ReactNode }): React.ReactElement {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className={cn('mt-1 min-w-0')}>{children}</dd>
    </div>
  );
}

/** `confidence` arrives as a numeric string like "0.940". Rendered as whole percent. */
function confidenceLabel(confidence: string): string {
  const parsed = Number(confidence);
  if (!Number.isFinite(parsed)) return 'unknown';
  return `${String(Math.round(parsed * 100))}%`;
}
