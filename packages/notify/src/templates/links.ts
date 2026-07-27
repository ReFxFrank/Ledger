/**
 * Deep links.
 *
 * Every email links straight to the screen the email is about — never to a dashboard the reader
 * then has to search. Routes live in one file so a rename in `apps/web` is one edit here rather
 * than ten string literals scattered through the templates.
 */

function join(appUrl: string, path: string): string {
  return `${appUrl.replace(/\/+$/, '')}${path}`;
}

export function subscriptionUrl(appUrl: string, subscriptionId: string): string {
  return join(appUrl, `/subscriptions/${subscriptionId}`);
}

/**
 * The cancellation record, or the subscription it belongs to when no request has been opened yet.
 * A link to a cancellation that does not exist is worse than one extra click.
 */
export function cancellationUrl(
  appUrl: string,
  requestId: string | null,
  subscriptionId: string,
): string {
  return requestId === null
    ? join(appUrl, `/subscriptions/${subscriptionId}`)
    : join(appUrl, `/cancellations/${requestId}`);
}

export function reviewUrl(appUrl: string): string {
  return join(appUrl, '/review');
}

export function connectionUrl(appUrl: string, connectionId: string): string {
  return join(appUrl, `/settings/connections/${connectionId}`);
}
