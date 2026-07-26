/**
 * Validates the `?next=` parameter the shell adds when it bounces someone to sign-in.
 *
 * An unchecked redirect target is an open redirect, and a sign-in page is exactly where one is
 * worth having: the user has just proven they will follow a link. Only a same-origin absolute
 * path survives — no scheme, no host, and no `//host` shorthand, which browsers treat as
 * protocol-relative and would happily send off-site.
 */
export function safeNextPath(value: string | null | undefined, fallback = '/'): string {
  if (value === null || value === undefined || value === '') return fallback;
  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback;
  // A signed-in user sent back to an auth screen would bounce straight out again.
  if (value.startsWith('/sign-in') || value.startsWith('/sign-up')) return fallback;
  return value;
}
