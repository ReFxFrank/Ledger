'use client';

import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Panel, PanelBody, PanelHeader } from '@ledger/ui';
import type { CancellationDetail } from '~/lib/api-types';

type PlaybookSnapshot = NonNullable<CancellationDetail['playbook']>;

/**
 * What this provider does when you try to leave — the playbook's gotchas and its note about the
 * retention offer, snapshotted when the cancellation started.
 *
 * Rendered above the checklist because these are the traps a user walks into *during* the steps,
 * not after them. Styled `--outflow`, not `--alert`, for the same reason the checklist warnings
 * are: a dark pattern is a caution about money, and the one genuinely red thing on this screen —
 * a charge that arrived after cancelling — has to keep its colour to itself.
 */
export function PlaybookNotes({
  playbook,
}: {
  readonly playbook: PlaybookSnapshot;
}): React.ReactNode {
  const hasGotchas = playbook.gotchas.length > 0;
  const hasOfferNote = playbook.retentionOfferNotes !== null;
  if (!hasGotchas && !hasOfferNote) return null;

  return (
    <Panel>
      <PanelHeader eyebrow="Watch out">
        What this provider does when you try to leave.
      </PanelHeader>
      <PanelBody className="flex flex-col gap-[var(--gap-tight)]">
        {hasGotchas ? (
          <ul className="flex flex-col gap-[var(--gap-tight)]">
            {playbook.gotchas.map((gotcha) => (
              <li
                key={gotcha}
                className="flex items-start gap-1.5 rounded-sm border border-outflow/30 bg-outflow-dim p-2 text-xs text-outflow"
              >
                <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
                <span>{gotcha}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {playbook.retentionOfferNotes === null ? null : (
          <div className="rounded-md border border-line bg-ink-700 p-[var(--pad-card)]">
            <p className="eyebrow">If they offer you a deal</p>
            <p className="mt-1.5 text-[0.8125rem] text-text-2">{playbook.retentionOfferNotes}</p>
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}
