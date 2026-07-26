'use client';

/**
 * The three panels that hold what the user knows and the product does not: how often they use
 * it, what they want to remember about it, and the files they collected along the way.
 */

import * as React from 'react';
import { Check, Paperclip, Plus, X } from 'lucide-react';
import {
  type IntervalUnit,
  costPerUse,
  formatMoney,
  interval,
  monthlyEquivalent,
  money,
} from '@ledger/core';
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Panel,
  PanelBody,
  PanelHeader,
  Textarea,
  cn,
  focusRing,
  toast,
} from '@ledger/ui';
import { api } from '~/lib/trpc';
import { formatInstant } from '~/lib/format';

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;
const USAGE_WINDOW_DAYS = 30;

export interface UsageEntry {
  readonly id: string;
  readonly occurredAt: Date;
  readonly note: string | null;
}

export interface UsagePanelProps {
  readonly subscriptionId: string;
  readonly usage: readonly UsageEntry[];
  readonly amountMinor: number;
  readonly currency: string;
  readonly intervalUnit: IntervalUnit;
  readonly intervalCount: number;
  readonly locale: string;
  readonly timezone: string;
}

export function UsagePanel({
  subscriptionId,
  usage,
  amountMinor,
  currency,
  intervalUnit,
  intervalCount,
  locale,
  timezone,
}: UsagePanelProps): React.ReactElement {
  const utils = api.useUtils();

  const logUsage = api.subscriptions.logUsage.useMutation({
    onSuccess: async () => {
      await utils.subscriptions.byId.invalidate({ id: subscriptionId });
      toast.success('Logged.');
    },
    onError: (error) => {
      toast.error('Could not log that.', { description: error.message });
    },
  });

  const perUse = React.useMemo(
    () => buildCostPerUse({ usage, amountMinor, currency, intervalUnit, intervalCount, locale }),
    [amountMinor, currency, intervalCount, intervalUnit, locale, usage],
  );

  return (
    <Panel>
      <PanelHeader
        eyebrow="Usage"
        actions={
          <Button
            size="sm"
            variant="secondary"
            loading={logUsage.isPending}
            onClick={() => {
              logUsage.mutate({ id: subscriptionId });
            }}
          >
            <Check className="size-3.5" aria-hidden />
            Used it
          </Button>
        }
      >
        {perUse}
      </PanelHeader>

      {usage.length === 0 ? (
        <EmptyState>
          Tap &ldquo;Used it&rdquo; when you use this. A month of taps turns the price into a cost per use.
        </EmptyState>
      ) : (
        <ul className="max-h-56 divide-y divide-line overflow-y-auto">
          {usage.map((entry) => (
            <li
              key={entry.id}
              className="flex items-baseline justify-between gap-[var(--gap-tight)] px-[var(--pad-panel)] py-1.5"
            >
              <time dateTime={entry.occurredAt.toISOString()} className="font-mono text-xs text-text-2">
                {formatInstant(entry.occurredAt, locale, timezone)}
              </time>
              {entry.note === null ? null : <span className="truncate text-xs text-text-3">{entry.note}</span>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

interface CostPerUseInput {
  readonly usage: readonly UsageEntry[];
  readonly amountMinor: number;
  readonly currency: string;
  readonly intervalUnit: IntervalUnit;
  readonly intervalCount: number;
  readonly locale: string;
}

/**
 * "£17.99 a month, used twice — £9.00 a use."
 *
 * The number that makes someone cancel. Zero uses returns null rather than infinity, and the
 * panel says nothing rather than showing a division artefact.
 */
function buildCostPerUse(input: CostPerUseInput): string | null {
  const recent = input.usage.filter(
    (entry) => Date.now() - entry.occurredAt.getTime() <= USAGE_WINDOW_DAYS * MILLIS_PER_DAY,
  );
  if (recent.length === 0) return null;

  try {
    const monthly = monthlyEquivalent(
      money(input.amountMinor, input.currency),
      interval(input.intervalUnit, input.intervalCount),
    );
    const each = costPerUse(monthly, recent.length);
    if (each === null) return null;
    return `${formatMoney(monthly, { locale: input.locale })} a month, used ${String(recent.length)} times in ${String(USAGE_WINDOW_DAYS)} days — ${formatMoney(each, { locale: input.locale })} a use.`;
  } catch {
    return null;
  }
}

export interface NotesPanelProps {
  readonly subscriptionId: string;
  readonly notes: string | null;
  readonly tags: readonly string[];
}

export function NotesPanel({ subscriptionId, notes, tags }: NotesPanelProps): React.ReactElement {
  const utils = api.useUtils();
  const [draft, setDraft] = React.useState(notes ?? '');
  const [tagDraft, setTagDraft] = React.useState('');

  React.useEffect(() => {
    setDraft(notes ?? '');
  }, [notes]);

  const update = api.subscriptions.update.useMutation({
    onSuccess: async () => {
      await utils.subscriptions.byId.invalidate({ id: subscriptionId });
      await utils.subscriptions.list.invalidate();
    },
    onError: (error) => {
      toast.error('Could not save that.', { description: error.message });
    },
  });

  function saveTags(next: readonly string[]): void {
    update.mutate({ id: subscriptionId, patch: { tags: [...next].slice(0, 20) } });
  }

  function addTag(): void {
    const tag = tagDraft.trim();
    if (tag === '' || tags.includes(tag)) {
      setTagDraft('');
      return;
    }
    setTagDraft('');
    saveTags([...tags, tag]);
  }

  const dirty = draft !== (notes ?? '');

  return (
    <Panel>
      <PanelHeader eyebrow="Notes and tags" />
      <PanelBody className="flex flex-col gap-[var(--gap-loose)]">
        <div className="flex flex-wrap items-center gap-1.5">
          {tags.map((tag) => (
            <Badge key={tag} tone="neutral" className="gap-1 pr-1">
              {tag}
              <button
                type="button"
                aria-label={`Remove tag ${tag}`}
                onClick={() => {
                  saveTags(tags.filter((item) => item !== tag));
                }}
                className={cn('grid size-4 place-items-center rounded-sm hover:text-alert', focusRing)}
              >
                <X className="size-3" aria-hidden />
              </button>
            </Badge>
          ))}
          <div className="flex items-center gap-1">
            <Input
              value={tagDraft}
              placeholder="Add a tag"
              aria-label="Add a tag"
              className="h-7 w-32"
              onChange={(event) => {
                setTagDraft(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addTag();
                }
              }}
            />
            <Button size="sm" variant="ghost" iconOnly aria-label="Add tag" onClick={addTag}>
              <Plus className="size-3.5" aria-hidden />
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-[var(--gap-tight)]">
          <Textarea
            value={draft}
            rows={4}
            aria-label="Notes"
            placeholder="Shared with Sam. Cancel before the trip."
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
          {dirty ? (
            <div className="flex items-center justify-end gap-[var(--gap-tight)]">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(notes ?? '');
                }}
              >
                Discard
              </Button>
              <Button
                size="sm"
                variant="primary"
                loading={update.isPending}
                onClick={() => {
                  update.mutate({ id: subscriptionId, patch: { notes: draft.trim() === '' ? null : draft } });
                }}
              >
                Save notes
              </Button>
            </div>
          ) : null}
        </div>
      </PanelBody>
    </Panel>
  );
}

export interface AttachmentRow {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly createdAt: Date;
}

export interface AttachmentsPanelProps {
  readonly attachments: readonly AttachmentRow[];
  readonly locale: string;
  readonly timezone: string;
}

/**
 * Attachments.
 *
 * Read-only by design here: files are attached during a cancellation, where the upload has a
 * purpose attached to it ("confirmation email", "chat transcript") that a generic uploader on
 * this screen would lose. This panel is the place they end up.
 */
export function AttachmentsPanel({
  attachments,
  locale,
  timezone,
}: AttachmentsPanelProps): React.ReactElement {
  return (
    <Panel>
      <PanelHeader eyebrow="Attachments" />
      {attachments.length === 0 ? (
        <EmptyState icon={<Paperclip />}>
          Nothing attached. Evidence you upload while cancelling — confirmation emails, chat
          transcripts — collects here.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {attachments.map((file) => (
            <li
              key={file.id}
              className="flex items-center justify-between gap-[var(--gap-tight)] px-[var(--pad-panel)] py-2"
            >
              <span className="truncate text-[0.8125rem] text-text">{file.filename}</span>
              <span className="shrink-0 font-mono text-xs text-text-3">
                {formatInstant(file.createdAt, locale, timezone)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
