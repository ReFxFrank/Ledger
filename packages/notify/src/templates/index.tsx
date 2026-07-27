/**
 * Rendering: a `NotificationRequest` in, a `RenderedNotification` out.
 *
 * The switch below is exhaustive over the discriminated union, so adding a notification type
 * without a template is a compile error rather than an email with a blank body. Both the HTML and
 * the plain-text part come from the same component — a text alternative maintained separately is
 * a text alternative that drifts, and the plain part is what a watch and a screen reader show.
 */

import type { ReactElement } from 'react';
import { render } from '@react-email/components';
import type { NotificationRequest, RenderContext, RenderedNotification } from '../types';
import { cancellationUrl, connectionUrl, reviewUrl, subscriptionUrl } from './links';
import * as cancelByDeadline from './cancel-by-deadline';
import * as cancellationUnconfirmed from './cancellation-unconfirmed';
import * as chargedAfterCancellation from './charged-after-cancellation';
import * as consentExpiring from './consent-expiring';
import * as duplicateDetected from './duplicate-detected';
import * as newDetections from './new-detections';
import * as priceChanged from './price-changed';
import * as renewalUpcoming from './renewal-upcoming';
import * as syncFailed from './sync-failed';
import * as trialEnding from './trial-ending';

async function finish(
  subject: string,
  url: string,
  element: ReactElement,
): Promise<RenderedNotification> {
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { subject, html, text, url };
}

export async function renderNotification(
  request: NotificationRequest,
  ctx: RenderContext,
): Promise<RenderedNotification> {
  switch (request.type) {
    case 'trial_ending': {
      const url = subscriptionUrl(ctx.appUrl, request.payload.subscription.subscriptionId);
      return finish(
        trialEnding.subject(request.payload, ctx),
        url,
        <trialEnding.TrialEndingEmail payload={request.payload} ctx={ctx} url={url} />,
      );
    }

    case 'renewal_upcoming': {
      const url = subscriptionUrl(ctx.appUrl, request.payload.subscription.subscriptionId);
      return finish(
        renewalUpcoming.subject(request.payload, ctx),
        url,
        <renewalUpcoming.RenewalUpcomingEmail payload={request.payload} ctx={ctx} url={url} />,
      );
    }

    case 'price_changed': {
      const url = subscriptionUrl(ctx.appUrl, request.payload.subscription.subscriptionId);
      return finish(
        priceChanged.subject(request.payload, ctx),
        url,
        <priceChanged.PriceChangedEmail payload={request.payload} ctx={ctx} url={url} />,
      );
    }

    case 'cancel_by_deadline': {
      const url = cancellationUrl(
        ctx.appUrl,
        request.payload.cancellationRequestId,
        request.payload.subscription.subscriptionId,
      );
      return finish(
        cancelByDeadline.subject(request.payload, ctx),
        url,
        <cancelByDeadline.CancelByDeadlineEmail payload={request.payload} ctx={ctx} url={url} />,
      );
    }

    case 'cancellation_unconfirmed': {
      const url = cancellationUrl(
        ctx.appUrl,
        request.payload.cancellationRequestId,
        request.payload.subscription.subscriptionId,
      );
      return finish(
        cancellationUnconfirmed.subject(request.payload, ctx),
        url,
        <cancellationUnconfirmed.CancellationUnconfirmedEmail
          payload={request.payload}
          ctx={ctx}
          url={url}
        />,
      );
    }

    case 'charged_after_cancellation': {
      const url = cancellationUrl(
        ctx.appUrl,
        request.payload.cancellationRequestId,
        request.payload.subscription.subscriptionId,
      );
      return finish(
        chargedAfterCancellation.subject(request.payload, ctx),
        url,
        <chargedAfterCancellation.ChargedAfterCancellationEmail
          payload={request.payload}
          ctx={ctx}
          url={url}
        />,
      );
    }

    case 'new_detections': {
      const url = reviewUrl(ctx.appUrl);
      return finish(
        newDetections.subject(request.payload, ctx),
        url,
        <newDetections.NewDetectionsEmail payload={request.payload} ctx={ctx} url={url} />,
      );
    }

    case 'sync_failed': {
      const url = connectionUrl(ctx.appUrl, request.payload.connectionId);
      return finish(
        syncFailed.subject(request.payload, ctx),
        url,
        <syncFailed.SyncFailedEmail payload={request.payload} ctx={ctx} url={url} />,
      );
    }

    case 'consent_expiring': {
      const url = connectionUrl(ctx.appUrl, request.payload.connectionId);
      return finish(
        consentExpiring.subject(request.payload, ctx),
        url,
        <consentExpiring.ConsentExpiringEmail payload={request.payload} ctx={ctx} url={url} />,
      );
    }

    case 'duplicate_detected': {
      const first = request.payload.subscriptions[0];
      const url =
        first === undefined ? reviewUrl(ctx.appUrl) : subscriptionUrl(ctx.appUrl, first.subscriptionId);
      return finish(
        duplicateDetected.subject(request.payload, ctx),
        url,
        <duplicateDetected.DuplicateDetectedEmail payload={request.payload} ctx={ctx} url={url} />,
      );
    }
  }
}

export * from './layout';
export * from './theme';
export * from './links';
export * from './format';
