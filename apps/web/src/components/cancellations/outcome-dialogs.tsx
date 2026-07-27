'use client';

import * as React from 'react';
import { parseMoney } from '@ledger/core';
import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Money,
  Textarea,
} from '@ledger/ui';

/**
 * The two ways a cancellation ends, as far as the user is concerned.
 *
 * Both dialogs record facts rather than triggering anything. "They confirmed it" writes down what
 * the provider said — it does not mark the subscription safe, because only the bank feed can do
 * that. "Stop this" records that the charges continue and, if a retention offer is why, records
 * the offer: "abandoned" and "they gave me three months half price and I took it" are different
 * facts, and only the second one explains the charges that follow.
 */

export interface ConfirmationValues {
  readonly confirmationReference?: string;
  readonly effectiveAt?: Date;
  readonly refundExpectedMinor?: number;
  readonly refundCurrency?: string;
  readonly notes?: string;
}

export function ConfirmationDialog({
  open,
  currency,
  pending,
  onOpenChange,
  onSubmit,
}: {
  readonly open: boolean;
  readonly currency: string;
  readonly pending: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (values: ConfirmationValues) => void;
}): React.ReactNode {
  const [reference, setReference] = React.useState('');
  const [effective, setEffective] = React.useState('');
  const [refund, setRefund] = React.useState('');
  const [notes, setNotes] = React.useState('');

  React.useEffect(() => {
    if (open) return;
    setReference('');
    setEffective('');
    setRefund('');
    setNotes('');
  }, [open]);

  const refundMinor = React.useMemo(() => tryParseMinor(refund, currency), [refund, currency]);
  const refundInvalid = refund.trim() !== '' && refundMinor === null;

  function submit(): void {
    const trimmedReference = reference.trim();
    const trimmedNotes = notes.trim();
    onSubmit({
      ...(trimmedReference === '' ? {} : { confirmationReference: trimmedReference }),
      // `<input type="date">` yields YYYY-MM-DD. Parsed at midday UTC so no timezone offset can
      // push the date the user picked onto the day before it.
      ...(effective === '' ? {} : { effectiveAt: new Date(`${effective}T12:00:00Z`) }),
      ...(refundMinor === null
        ? {}
        : { refundExpectedMinor: refundMinor, refundCurrency: currency }),
      ...(trimmedNotes === '' ? {} : { notes: trimmedNotes }),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Record what the provider said</DialogTitle>
          <DialogDescription>
            This records their claim. We will still watch your bank feed for the charge that should
            not arrive before calling it done.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-[var(--gap-loose)]">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confirm-reference">Reference number</Label>
            <Input
              id="confirm-reference"
              mono
              value={reference}
              placeholder="The code they gave you"
              onChange={(event) => {
                setReference(event.target.value);
              }}
            />
            <p className="text-[0.6875rem] text-text-3">
              The single most useful thing to have if a charge appears anyway.
            </p>
          </div>

          <div className="grid gap-[var(--gap-loose)] sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="confirm-effective">Access ends</Label>
              <Input
                id="confirm-effective"
                type="date"
                mono
                value={effective}
                onChange={(event) => {
                  setEffective(event.target.value);
                }}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="confirm-refund">Refund promised ({currency})</Label>
              <Input
                id="confirm-refund"
                mono
                inputMode="decimal"
                value={refund}
                aria-invalid={refundInvalid}
                onChange={(event) => {
                  setRefund(event.target.value);
                }}
              />
              {refundInvalid ? (
                <p className="text-[0.6875rem] text-alert">Enter an amount like 9.99.</p>
              ) : refundMinor === null ? null : (
                <p className="text-[0.6875rem] text-text-3">
                  <Money amountMinor={refundMinor} currency={currency} size="sm" />
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confirm-notes">Notes</Label>
            <Textarea
              id="confirm-notes"
              rows={3}
              value={notes}
              placeholder="Who you spoke to, what they said"
              onChange={(event) => {
                setNotes(event.target.value);
              }}
            />
          </div>
        </DialogBody>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button variant="primary" loading={pending} disabled={refundInvalid} onClick={submit}>
            Record it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface AbandonValues {
  readonly reason?: string;
  readonly retentionOffer?: {
    readonly describedAs: string;
    readonly valueMinor?: number;
    readonly currency?: string;
    readonly resetsRenewalDate: boolean;
  };
}

export function AbandonDialog({
  open,
  currency,
  pending,
  onOpenChange,
  onSubmit,
}: {
  readonly open: boolean;
  readonly currency: string;
  readonly pending: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (values: AbandonValues) => void;
}): React.ReactNode {
  const [reason, setReason] = React.useState('');
  const [tookOffer, setTookOffer] = React.useState(false);
  const [offerText, setOfferText] = React.useState('');
  const [offerValue, setOfferValue] = React.useState('');
  const [resetsRenewal, setResetsRenewal] = React.useState(true);

  React.useEffect(() => {
    if (open) return;
    setReason('');
    setTookOffer(false);
    setOfferText('');
    setOfferValue('');
    setResetsRenewal(true);
  }, [open]);

  const offerMinor = React.useMemo(() => tryParseMinor(offerValue, currency), [offerValue, currency]);
  const offerDescribed = offerText.trim();
  const valid = !tookOffer || offerDescribed !== '';

  function submit(): void {
    const trimmedReason = reason.trim();
    onSubmit({
      ...(trimmedReason === '' ? {} : { reason: trimmedReason }),
      ...(tookOffer && offerDescribed !== ''
        ? {
            retentionOffer: {
              describedAs: offerDescribed,
              resetsRenewalDate: resetsRenewal,
              ...(offerMinor === null ? {} : { valueMinor: offerMinor, currency }),
            },
          }
        : {}),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Stop this cancellation</DialogTitle>
          <DialogDescription>
            The subscription goes back to charging you, and it leaves the board. Nothing about the
            record is deleted.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-[var(--gap-loose)]">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="abandon-reason">Why</Label>
            <Textarea
              id="abandon-reason"
              rows={2}
              value={reason}
              placeholder="Changed my mind"
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          </div>

          <label className="flex items-start gap-2.5 rounded-md border border-line bg-ink-700 p-[var(--pad-card)]">
            <Checkbox
              checked={tookOffer}
              onCheckedChange={(value) => {
                setTookOffer(value === true);
              }}
              aria-label="They offered me something to stay"
            />
            <span className="min-w-0">
              <span className="block text-[0.8125rem] text-text">
                They offered me something to stay
              </span>
              <span className="block text-xs text-text-2">
                Worth recording separately — it is the reason the charges continue.
              </span>
            </span>
          </label>

          {tookOffer ? (
            <div className="flex flex-col gap-[var(--gap-loose)] rounded-md border border-line bg-ink-900 p-[var(--pad-card)]">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="offer-text" required>
                  What they offered
                </Label>
                <Input
                  id="offer-text"
                  value={offerText}
                  placeholder="Three months at half price"
                  onChange={(event) => {
                    setOfferText(event.target.value);
                  }}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="offer-value">What it is worth ({currency})</Label>
                <Input
                  id="offer-value"
                  mono
                  inputMode="decimal"
                  value={offerValue}
                  onChange={(event) => {
                    setOfferValue(event.target.value);
                  }}
                />
              </div>

              <label className="flex items-start gap-2.5">
                <Checkbox
                  checked={resetsRenewal}
                  onCheckedChange={(value) => {
                    setResetsRenewal(value === true);
                  }}
                  aria-label="This restarted the billing period"
                />
                <span className="text-xs text-text-2">
                  This restarted the billing period. Most retention offers do, which moves the next
                  renewal — and the next cancel-by date with it.
                </span>
              </label>
            </div>
          ) : null}
        </DialogBody>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Keep going
          </Button>
          <Button variant="danger" loading={pending} disabled={!valid} onClick={submit}>
            Stop this
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Minor units, or null when the text is not an amount. Never a float, never `parseFloat`. */
function tryParseMinor(raw: string, currency: string): number | null {
  if (raw.trim() === '') return null;
  try {
    return parseMoney(raw, currency).amountMinor;
  } catch {
    return null;
  }
}
