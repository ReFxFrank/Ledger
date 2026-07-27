'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowLeft, RotateCcw, Send, StopCircle } from 'lucide-react';
import {
  CANCELLATION_STATUS_LABELS,
  type CancellationDifficulty,
  type CancellationStatus,
  DIFFICULTY_LABELS,
  interval,
  intervalLabel,
} from '@ledger/core';
import {
  Badge,
  type BadgeTone,
  Button,
  DifficultyMeter,
  Money,
  Panel,
  PanelBody,
  PanelHeader,
  cn,
  focusRing,
  toast,
} from '@ledger/ui';
import { api } from '~/lib/trpc';
import { formatInstant } from '~/lib/format';
import type { CancellationDetail } from '~/lib/api-types';
import { LoadError } from '../dashboard/states';
import { MerchantMark } from '../merchant-mark';
import { AbandonDialog, ConfirmationDialog } from './outcome-dialogs';
import { CancellationChecklist } from './checklist';
import { DeadlinePanel } from './deadline';
import { EvidencePanel } from './evidence';
import { CancellationLetter, needsLetter } from './letter';
import { RouteBanner } from './route-banner';
import { CancellationDetailSkeleton } from './skeletons';
import { VerificationPanel, verificationStateOf } from './verification';

/**
 * One cancellation, end to end.
 *
 * The order of this screen is the order of the work, and the first thing on it is *where* — the
 * routing banner. Everything below it assumes the user is already in the right place, and a
 * checklist that starts before that question is answered is a checklist for the wrong provider.
 *
 * Ledger cancels nothing. It knows the exit, holds the deadline, keeps the record, and checks
 * afterwards whether the charge actually stopped — and every sentence on this page is written so
 * that division of labour is impossible to misread.
 */

const EVIDENCE_ANCHOR = 'evidence';

const STATUS_TONES: Readonly<Record<CancellationStatus, BadgeTone>> = {
  draft: 'neutral',
  in_progress: 'control',
  awaiting_confirmation: 'control',
  confirmed: 'control',
  verified: 'control',
  // The one status that is a problem: the provider took the money after saying it would not.
  failed: 'alert',
  abandoned: 'neutral',
};

/**
 * Which actions to offer, per status.
 *
 * A restatement of the transition table in @ledger/db, deliberately narrow: it decides which
 * buttons are visible, nothing more. The server validates every move through the machine itself
 * and returns a plain-English refusal, so the worst this table can be is out of date — never
 * wrong about what actually happens.
 */
const ACTIONS: Readonly<
  Record<CancellationStatus, { submit: boolean; confirm: boolean; abandon: boolean; reopen: boolean }>
> = {
  draft: { submit: false, confirm: false, abandon: true, reopen: false },
  in_progress: { submit: true, confirm: true, abandon: true, reopen: false },
  awaiting_confirmation: { submit: false, confirm: true, abandon: true, reopen: true },
  confirmed: { submit: false, confirm: false, abandon: false, reopen: false },
  verified: { submit: false, confirm: false, abandon: false, reopen: false },
  failed: { submit: false, confirm: false, abandon: false, reopen: true },
  abandoned: { submit: false, confirm: false, abandon: false, reopen: true },
};

export function CancellationDetailView({ requestId }: { readonly requestId: string }): React.ReactNode {
  const utils = api.useUtils();
  const detail = api.cancellations.byId.useQuery({ id: requestId });
  const me = api.me.current.useQuery();

  const [pendingStepId, setPendingStepId] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<'none' | 'confirmation' | 'abandon'>('none');

  const locale = me.data?.locale ?? 'en-GB';
  const timezone = me.data?.timezone ?? 'UTC';

  const refresh = React.useCallback(async (): Promise<void> => {
    await Promise.all([
      utils.cancellations.byId.invalidate({ id: requestId }),
      utils.cancellations.board.invalidate(),
      utils.cancellations.reclaimed.invalidate(),
      utils.subscriptions.list.invalidate(),
      utils.dashboard.attention.invalidate(),
    ]);
  }, [requestId, utils]);

  const progressStep = api.cancellations.progressStep.useMutation({
    onError: (error) => {
      toast.error('Could not save that step.', { description: error.message });
    },
    onSettled: async () => {
      setPendingStepId(null);
      await refresh();
    },
  });

  const markSubmitted = api.cancellations.markSubmitted.useMutation({
    onSuccess: () => {
      toast.success('Marked as sent. We will start watching for the charge that should not arrive.');
    },
    onError: (error) => {
      toast.error('Could not update that.', { description: error.message });
    },
    onSettled: async () => {
      await refresh();
    },
  });

  const recordConfirmation = api.cancellations.recordConfirmation.useMutation({
    onSuccess: () => {
      toast.success('Recorded. This is the provider’s claim — we will check it against your bank feed.');
      setDialog('none');
    },
    onError: (error) => {
      toast.error('Could not record that.', { description: error.message });
    },
    onSettled: async () => {
      await refresh();
    },
  });

  const abandon = api.cancellations.abandon.useMutation({
    onSuccess: () => {
      toast.success('Stopped. The subscription goes back to charging you.');
      setDialog('none');
    },
    onError: (error) => {
      toast.error('Could not stop that.', { description: error.message });
    },
    onSettled: async () => {
      await refresh();
    },
  });

  const reopen = api.cancellations.reopen.useMutation({
    onSuccess: () => {
      toast.success('Reopened.');
    },
    onError: (error) => {
      toast.error('Could not reopen that.', { description: error.message });
    },
    onSettled: async () => {
      await refresh();
    },
  });

  if (detail.error !== null) {
    return (
      <LoadError
        what="this cancellation"
        error={detail.error}
        retrying={detail.isFetching}
        onRetry={() => {
          void detail.refetch();
        }}
      />
    );
  }

  if (detail.isPending) return <CancellationDetailSkeleton />;

  const { request, subscription, events, attachments } = detail.data;
  const status = request.status;
  const actions = ACTIONS[status];
  const difficulty = difficultyFromEvents(events);
  const routing = routingStep(request.checklist);
  const stillOpen = status === 'draft' || status === 'in_progress' || status === 'awaiting_confirmation';

  const verification = verificationStateOf(
    status,
    request.verifiedAt,
    request.chargedAfterCancellationTxId,
  );

  const busy =
    progressStep.isPending ||
    markSubmitted.isPending ||
    recordConfirmation.isPending ||
    abandon.isPending ||
    reopen.isPending;

  return (
    <div className="flex flex-col gap-[var(--gap-loose)]">
      <Link
        href="/cancellations"
        className={cn(
          'inline-flex w-fit items-center gap-1.5 rounded-sm text-xs text-text-2',
          'transition-colors duration-[var(--duration-fast)] ease-standard hover:text-text',
          focusRing,
        )}
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        All cancellations
      </Link>

      <Panel>
        <PanelHeader
          eyebrow="Cancellation"
          actions={<Badge tone={STATUS_TONES[status]}>{CANCELLATION_STATUS_LABELS[status]}</Badge>}
        >
          <span className="flex flex-wrap items-center gap-2.5">
            <MerchantMark name={subscription.displayName} />
            <span className="text-base font-medium leading-tight text-text">
              {subscription.displayName}
            </span>
            <Money
              amountMinor={subscription.amountMinor}
              currency={subscription.currency}
              tone="outflow"
              size="md"
              locale={locale}
            />
            <span className="text-xs text-text-2">
              {intervalLabel(interval(subscription.intervalUnit, subscription.intervalCount))}
            </span>
          </span>
        </PanelHeader>

        <PanelBody className="flex flex-col gap-[var(--gap-loose)]">
          <RouteBanner
            method={request.method}
            channel={request.channel}
            subscriptionName={subscription.displayName}
            providerUrl={subscription.url}
            routingNote={routing.detail}
            routingWarning={routing.warning}
          />

          <div className="flex flex-wrap items-center justify-between gap-[var(--gap)] rounded-md border border-line bg-ink-700 p-[var(--pad-card)]">
            <div className="min-w-0">
              <p className="eyebrow">How hard this is</p>
              {difficulty === null ? (
                <p className="mt-1.5 text-[0.8125rem] text-text-2">
                  We have no difficulty rating for this provider. Assume it is straightforward until
                  it is not.
                </p>
              ) : (
                <DifficultyMeter className="mt-1.5" level={difficulty} />
              )}
            </div>
            {difficulty === null ? null : (
              <p className="max-w-prose text-xs text-text-3">
                {DIFFICULTY_LABELS[difficulty]} — rated when this cancellation started, and not
                softened.
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-[var(--gap-tight)]">
            {actions.submit ? (
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() => {
                  markSubmitted.mutate({ requestId });
                }}
              >
                <Send className="size-3.5" aria-hidden />
                I&rsquo;ve sent it
              </Button>
            ) : null}

            {actions.confirm ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setDialog('confirmation');
                }}
              >
                They confirmed it
              </Button>
            ) : null}

            {actions.reopen ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  reopen.mutate({ requestId });
                }}
              >
                <RotateCcw className="size-3.5" aria-hidden />
                Reopen
              </Button>
            ) : null}

            {actions.abandon ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setDialog('abandon');
                }}
              >
                <StopCircle className="size-3.5" aria-hidden />
                Stop this
              </Button>
            ) : null}
          </div>
        </PanelBody>
      </Panel>

      <div className="grid gap-[var(--gap-loose)] lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-[var(--gap-loose)]">
          <Panel>
            <PanelHeader eyebrow="Checklist">What you do, in order.</PanelHeader>
            <PanelBody>
              <CancellationChecklist
                steps={request.checklist}
                disabled={busy || !stillOpen}
                pendingStepId={pendingStepId}
                onToggle={(stepId, done) => {
                  setPendingStepId(stepId);
                  progressStep.mutate({ requestId, stepId, done });
                }}
              />
            </PanelBody>
          </Panel>

          {needsLetter(request.method) ? (
            <CancellationLetter
              requestId={requestId}
              method={request.method}
              stored={request.generatedLetter}
            />
          ) : null}

          <EvidencePanel
            id={EVIDENCE_ANCHOR}
            attachments={attachments}
            confirmationReference={request.confirmationReference}
            locale={locale}
            timezone={timezone}
            onRecordConfirmation={() => {
              setDialog('confirmation');
            }}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-[var(--gap-loose)]">
          <DeadlinePanel
            deadlineAt={request.deadlineAt}
            expectedNextChargeAt={request.expectedNextChargeAt}
            verificationWindowEndsAt={request.verificationWindowEndsAt}
            locale={locale}
            timezone={timezone}
            stillOpen={stillOpen}
          />

          <VerificationPanel
            state={verification}
            verifiedAt={request.verifiedAt}
            chargedTxId={request.chargedAfterCancellationTxId}
            expectedNextChargeAt={request.expectedNextChargeAt}
            verificationWindowEndsAt={request.verificationWindowEndsAt}
            locale={locale}
            timezone={timezone}
            evidenceHref={`#${EVIDENCE_ANCHOR}`}
          />

          {request.retentionOffer === null ? null : (
            <Panel>
              <PanelHeader eyebrow="Retention offer">You took an offer to stay.</PanelHeader>
              <PanelBody className="text-[0.8125rem] text-text-2">
                <p>{request.retentionOffer.describedAs}</p>
                {request.retentionOffer.resetsRenewalDate === true ? (
                  <p className="mt-2 rounded-sm border border-outflow/30 bg-outflow-dim p-2 text-xs text-outflow">
                    This reset the billing period, so the next renewal is later than it was.
                  </p>
                ) : null}
              </PanelBody>
            </Panel>
          )}

          <Panel>
            <PanelHeader eyebrow="Timeline">
              The record, appended and never edited.
            </PanelHeader>
            <PanelBody>
              {events.length === 0 ? (
                <p className="text-xs text-text-3">Nothing has happened yet.</p>
              ) : (
                <ol className="flex flex-col gap-[var(--gap-tight)]">
                  {events.map((event) => (
                    <li key={event.id} className="flex gap-2.5">
                      <span
                        aria-hidden
                        className="mt-1.5 size-1.5 shrink-0 rounded-sm bg-text-3"
                      />
                      <div className="min-w-0">
                        <p className="text-[0.8125rem] leading-tight text-text">
                          {describeEvent(event.type, event.payload)}
                        </p>
                        <time
                          dateTime={event.at.toISOString()}
                          className="mt-0.5 block font-mono text-[0.6875rem] text-text-3"
                        >
                          {formatInstant(event.at, locale, timezone)}
                        </time>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </PanelBody>
          </Panel>
        </div>
      </div>

      <ConfirmationDialog
        open={dialog === 'confirmation'}
        currency={subscription.currency}
        pending={recordConfirmation.isPending}
        onOpenChange={(next) => {
          if (!next) setDialog('none');
        }}
        onSubmit={(values) => {
          recordConfirmation.mutate({ requestId, ...values });
        }}
      />

      <AbandonDialog
        open={dialog === 'abandon'}
        currency={subscription.currency}
        pending={abandon.isPending}
        onOpenChange={(next) => {
          if (!next) setDialog('none');
        }}
        onSubmit={(values) => {
          abandon.mutate({ requestId, ...values });
        }}
      />
    </div>
  );
}

// ── reading the snapshot ─────────────────────────────────────────────────────────────────

type ChecklistStep = CancellationDetail['request']['checklist'][number];

/**
 * The routing prose, taken from the snapshotted checklist.
 *
 * The playbook writes a `channel` step for store-billed subscriptions saying who takes the money
 * and that the provider's own account page cannot stop it. Lifting that text into the banner
 * keeps one wording rather than two that drift — the alternative is restating the store map in
 * the UI, which is how "cancel in the App Store" and "cancel at netflix.com" end up on the same
 * screen.
 */
function routingStep(checklist: readonly ChecklistStep[]): {
  detail: string | undefined;
  warning: string | undefined;
} {
  const step = checklist.find((entry) => entry.id === 'channel' || entry.id === 'provider');
  return { detail: step?.detail ?? step?.text, warning: step?.warning };
}

/**
 * The difficulty rating, read back from the `started` event.
 *
 * It is not a column on the request — it was snapshotted into the event payload when the
 * cancellation opened, which is the right place for it: difficulty is a fact about the playbook
 * at that moment, and a later rating change should not silently rewrite what the user was told.
 */
function difficultyFromEvents(
  events: CancellationDetail['events'],
): CancellationDifficulty | null {
  for (const event of events) {
    if (event.type !== 'started') continue;
    const value = readField(event.payload, 'difficulty');
    if (typeof value !== 'number') continue;
    const level = Math.round(value);
    if (level >= 1 && level <= 5) return level as CancellationDifficulty;
  }
  return null;
}

/** `payload` is untyped jsonb. Narrowed here rather than cast at each call site. */
function readField(payload: unknown, key: string): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined;
  return (payload as Record<string, unknown>)[key];
}

const EVENT_LABELS: Readonly<Record<string, string>> = {
  started: 'Cancellation started',
  step_completed: 'Checklist step updated',
  letter_generated: 'Letter drafted',
  evidence_added: 'Evidence added',
  status_changed: 'Status changed',
  retention_offered: 'Retention offer recorded',
  nudged: 'We reminded you',
  verified: 'Verified against your bank feed',
  charge_detected: 'A charge arrived after cancelling',
};

/**
 * The server writes a `describe` string into most payloads — it comes from the state machine and
 * is the exact sentence the transition carries. Preferred over a label looked up here, because
 * the machine's own words are what the audit trail should say.
 */
function describeEvent(type: string, payload: unknown): string {
  const describe = readField(payload, 'describe');
  if (typeof describe === 'string' && describe !== '') return describe;
  return EVENT_LABELS[type] ?? type.replace(/_/g, ' ');
}
