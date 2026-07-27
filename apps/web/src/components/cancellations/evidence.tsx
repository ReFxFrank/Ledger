'use client';

import * as React from 'react';
import { Camera, Mail, Paperclip, Receipt } from 'lucide-react';
import { Badge, Button, Panel, PanelBody, PanelHeader } from '@ledger/ui';
import { formatInstant } from '~/lib/format';
import type { CancellationDetail } from '~/lib/api-types';

/**
 * Evidence.
 *
 * The prompt matters more than the mechanism. What decides a chargeback is having the
 * confirmation screen, the confirmation email, and the reference number — so this panel spells
 * out those three things before it says anything about files.
 *
 * File upload is not switched on in this build: there is no procedure behind it. Rather than
 * render a drop zone that silently does nothing, the panel says so and points at the one record
 * Ledger genuinely keeps for you — the confirmation reference on the request. A dead affordance
 * is worse than an absent one, because the user finds out it was dead at the moment they needed it.
 */

const KEEP: readonly { readonly icon: React.ReactNode; readonly text: string }[] = [
  {
    icon: <Camera className="size-3.5" aria-hidden />,
    text: 'A screenshot of the screen that says the subscription is cancelled, with the date visible.',
  },
  {
    icon: <Mail className="size-3.5" aria-hidden />,
    text: 'The confirmation email, unedited, including its headers if your mail client will show them.',
  },
  {
    icon: <Receipt className="size-3.5" aria-hidden />,
    text: 'The reference number the provider gave you, and the name of anyone you spoke to.',
  },
];

export interface EvidencePanelProps {
  readonly id: string;
  readonly attachments: CancellationDetail['attachments'];
  readonly confirmationReference: string | null;
  readonly timezone: string;
  readonly locale: string;
  readonly onRecordConfirmation: () => void;
}

export function EvidencePanel({
  id,
  attachments,
  confirmationReference,
  timezone,
  locale,
  onRecordConfirmation,
}: EvidencePanelProps): React.ReactNode {
  return (
    <Panel id={id}>
      <PanelHeader
        eyebrow="Evidence"
        actions={
          <Button size="sm" variant="secondary" onClick={onRecordConfirmation}>
            Record the reference
          </Button>
        }
      >
        Keep these. They are what a dispute turns on.
      </PanelHeader>

      <PanelBody className="flex flex-col gap-[var(--gap-loose)]">
        <ul className="flex flex-col gap-[var(--gap-tight)]">
          {KEEP.map((item) => (
            <li key={item.text} className="flex items-start gap-2 text-[0.8125rem] text-text-2">
              <span className="mt-0.5 shrink-0 text-text-3">{item.icon}</span>
              <span>{item.text}</span>
            </li>
          ))}
        </ul>

        <div className="rounded-md border border-line bg-ink-700 p-[var(--pad-card)]">
          <p className="eyebrow">Reference on file</p>
          {confirmationReference === null || confirmationReference === '' ? (
            <p className="mt-1.5 text-[0.8125rem] text-text-2">
              None yet. Record it the moment the provider gives you one — it is the shortest path
              to a refund if a charge appears anyway.
            </p>
          ) : (
            <p className="mt-1.5 font-mono text-sm break-all text-text">{confirmationReference}</p>
          )}
        </div>

        {attachments.length > 0 ? (
          <div>
            <p className="eyebrow">Files on this cancellation</p>
            <ul className="mt-1.5 flex flex-col gap-1.5">
              {attachments.map((file) => (
                <li
                  key={file.id}
                  className="flex items-center justify-between gap-[var(--gap)] rounded-sm border border-line bg-ink-700 px-[var(--pad-card)] py-2"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Paperclip className="size-3.5 shrink-0 text-text-3" aria-hidden />
                    <span className="truncate text-[0.8125rem] text-text">{file.filename}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Badge tone="neutral">{file.purpose.replace(/_/g, ' ')}</Badge>
                    <time
                      dateTime={file.createdAt.toISOString()}
                      className="font-mono text-[0.6875rem] text-text-3"
                    >
                      {/* The instant, not a PlainDate: for an evidence record the time of day is
                          part of the record. */}
                      {formatInstant(file.createdAt, locale, timezone)}
                    </time>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="rounded-md border border-line bg-ink-900 p-[var(--pad-card)] text-xs text-text-2">
          <span className="eyebrow mr-1.5 inline">Uploads</span>
          Attaching files is not switched on in this build, so keep the screenshots and emails
          where they are — in your own mail and photos. What Ledger holds for you is the timeline
          below and the reference above, and both of those are enough to reconstruct the date you
          cancelled.
        </p>
      </PanelBody>
    </Panel>
  );
}
