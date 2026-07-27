'use client';

import * as React from 'react';
import { Check, Copy, FileText } from 'lucide-react';
import type { CancellationMethod } from '@ledger/core';
import { Button, Panel, PanelBody, PanelHeader, toast } from '@ledger/ui';
import { api } from '~/lib/trpc';

/**
 * The cancellation letter.
 *
 * Three rules hold this component together:
 *
 *  1. **The user sends it.** Ledger has no outbound mail path for this and never will — the panel
 *     says so in the header, above the text, not in a footnote underneath it.
 *  2. **No legal claims.** The draft asks, in the first person, for the subscription to stop and
 *     for written confirmation. It asserts no rights and guarantees no outcome; the server
 *     renders it that way and this component shows it verbatim (docs/legal-notes.md).
 *  3. **Copyable, not editable-in-place.** The body is a `<pre>` so the line breaks the user
 *     pastes are the line breaks they saw.
 */

/** The methods where a written record is the point. Elsewhere the letter is noise. */
export function needsLetter(method: CancellationMethod): boolean {
  return method === 'email' || method === 'post';
}

export interface CancellationLetterProps {
  readonly requestId: string;
  readonly method: CancellationMethod;
  /** The body already stored on the request, when one has been generated before. */
  readonly stored: string | null;
}

export function CancellationLetter({
  requestId,
  method,
  stored,
}: CancellationLetterProps): React.ReactNode {
  const utils = api.useUtils();
  const [letter, setLetter] = React.useState<{
    readonly subject: string;
    readonly body: string;
    readonly howToSend: string;
  } | null>(null);

  const generate = api.cancellations.generateLetter.useMutation({
    onSuccess: async (result) => {
      setLetter(result);
      await utils.cancellations.byId.invalidate({ id: requestId });
    },
    onError: (error) => {
      toast.error('Could not draft the letter.', { description: error.message });
    },
  });

  const body = letter?.body ?? stored;
  const posted = method === 'post';

  return (
    <Panel>
      <PanelHeader
        eyebrow="Letter for you to send"
        actions={
          <Button
            size="sm"
            variant={body === null ? 'primary' : 'secondary'}
            loading={generate.isPending}
            onClick={() => {
              generate.mutate({ requestId });
            }}
          >
            <FileText className="size-3.5" aria-hidden />
            {body === null ? 'Draft it' : 'Redraft'}
          </Button>
        }
      >
        Ledger does not send anything on your behalf. Copy this and send it yourself
        {posted ? ', by post, from your own address.' : ', by email, from your own address.'}
      </PanelHeader>

      <PanelBody className="flex flex-col gap-[var(--gap-loose)]">
        {body === null ? (
          <p className="text-sm text-text-2">
            {posted
              ? 'This provider takes cancellations in writing. Draft a letter and post it yourself — keep a copy and the proof of posting.'
              : 'This provider takes cancellations by email. Draft one and send it from the address on your account, so the reply is tied to you.'}
          </p>
        ) : (
          <>
            {letter === null ? null : (
              <CopyBlock label="Subject" value={letter.subject} mono={false} />
            )}
            <CopyBlock label="Message" value={body} mono />
            <p className="text-xs text-text-2">
              {letter?.howToSend ??
                'Copy this into an email and send it from your own address. Keep the reply — it is the evidence if a charge appears anyway.'}
            </p>
          </>
        )}
      </PanelBody>
    </Panel>
  );
}

/**
 * A copyable block.
 *
 * The clipboard write can be refused — an insecure origin, a browser that gates it behind a user
 * gesture it did not see — and the failure has to be visible, because a user who thinks they
 * copied a letter and pastes an empty message loses the thread with the provider.
 */
function CopyBlock({
  label,
  value,
  mono,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono: boolean;
}): React.ReactNode {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => {
      setCopied(false);
    }, 1600);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);

  function copy(): void {
    navigator.clipboard.writeText(value).then(
      () => {
        setCopied(true);
      },
      () => {
        toast.error('Your browser would not let us copy that. Select the text and copy it manually.');
      },
    );
  }

  return (
    <div className="rounded-md border border-line bg-ink-900">
      <div className="flex items-center justify-between gap-[var(--gap)] border-b border-line px-[var(--pad-card)] py-2">
        <p className="eyebrow">{label}</p>
        <Button size="sm" variant="ghost" onClick={copy}>
          {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre
        className={
          mono
            ? 'max-h-80 overflow-auto whitespace-pre-wrap break-words p-[var(--pad-card)] font-mono text-xs leading-relaxed text-text-2'
            : 'overflow-x-auto whitespace-pre-wrap break-words p-[var(--pad-card)] font-sans text-[0.8125rem] text-text'
        }
      >
        {value}
      </pre>
    </div>
  );
}
