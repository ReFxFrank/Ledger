'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, Laptop, ShieldCheck, Smartphone } from 'lucide-react';
import { Badge, Button, Panel, PanelBody, PanelHeader, Skeleton, cn, toast } from '@ledger/ui';
import { api } from '~/lib/trpc';
import { formatInstant } from '~/lib/format';
import { PASSKEY_ENABLED, authClient } from '~/lib/auth-client';
import { LoadError } from '../dashboard/states';

/**
 * Security.
 *
 * Sessions are read from better-auth rather than through tRPC, because better-auth owns the
 * session table and a second reader would eventually disagree with it about what is still valid.
 *
 * The shape that comes back is narrowed at the boundary rather than trusted: this is the one
 * screen where showing a stale or wrong row has a real cost — someone deciding whether a session
 * in another country is theirs — so a row that does not parse is dropped rather than rendered
 * with blanks where the facts should be.
 */

interface SessionRow {
  readonly id: string;
  readonly token: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function readDate(source: Record<string, unknown>, key: string): Date | null {
  const value = source[key];
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function parseSessions(payload: unknown): readonly SessionRow[] {
  if (!Array.isArray(payload)) return [];
  const rows: SessionRow[] = [];

  for (const entry of payload as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = readString(record, 'id');
    const token = readString(record, 'token');
    const createdAt = readDate(record, 'createdAt');
    const expiresAt = readDate(record, 'expiresAt');
    if (id === null || token === null || createdAt === null || expiresAt === null) continue;

    rows.push({
      id,
      token,
      createdAt,
      expiresAt,
      ipAddress: readString(record, 'ipAddress'),
      userAgent: readString(record, 'userAgent'),
    });
  }

  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export function SecuritySettings(): React.ReactNode {
  const me = api.me.current.useQuery();
  /**
   * The current session comes from `me.current`, not from better-auth's `useSession()`.
   *
   * That hook is not SSR-safe here — React's dispatcher is null when it renders on the server,
   * so this component threw and /settings returned a 500 behind the error boundary. The server
   * already knows which session is making the request, so it sends the id and no client auth
   * hook is needed.
   */
  const currentSessionId = me.data?.currentSessionId ?? null;
  const [revoking, setRevoking] = React.useState<string | null>(null);

  const sessions = useQuery({
    queryKey: ['auth', 'sessions'],
    queryFn: async (): Promise<readonly SessionRow[]> => {
      const response = await authClient.listSessions();
      if (response.error !== null) {
        throw new Error(response.error.message ?? 'Could not read your sessions.');
      }
      return parseSessions(response.data);
    },
  });

  async function revoke(row: SessionRow): Promise<void> {
    setRevoking(row.id);
    try {
      const response = await authClient.revokeSession({ token: row.token });
      if (response.error !== null) {
        toast.error('Could not sign that device out.', {
          description: response.error.message ?? '',
        });
        return;
      }
      toast.success('Signed out on that device.');
      await sessions.refetch();
    } finally {
      setRevoking(null);
    }
  }

  const locale = me.data?.locale ?? 'en-GB';
  const timezone = me.data?.timezone ?? 'UTC';

  return (
    <div className="flex flex-col gap-[var(--gap-loose)]">
      <Panel>
        <PanelHeader
          eyebrow="Two-factor authentication"
          actions={
            <Badge tone={me.data?.twoFactorEnabled === true ? 'control' : 'alert'}>
              {me.data?.twoFactorEnabled === true ? 'On' : 'Not set up'}
            </Badge>
          }
        >
          Required on every account, not offered.
        </PanelHeader>
        <PanelBody className="flex items-start gap-2.5 text-[0.8125rem] text-text-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-control-2" aria-hidden />
          <div>
            <p>
              This account guards a map of your finances, so a password on its own is not enough.
              A time-based code from your authenticator app is checked at every sign-in.
            </p>
            <p className="mt-2">
              Keep your backup codes somewhere that is not the phone with the authenticator on it.
              Losing both locks you out of the only record you may have of what is charging your
              card.
            </p>
          </div>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          eyebrow="Active sessions"
          actions={
            <Button
              size="sm"
              variant="ghost"
              loading={sessions.isFetching}
              onClick={() => {
                void sessions.refetch();
              }}
            >
              Refresh
            </Button>
          }
        >
          Every device signed in to this account. Revoking one signs it out immediately.
        </PanelHeader>

        {sessions.error !== null ? (
          <PanelBody>
            <LoadError
              what="your active sessions"
              error={sessions.error}
              retrying={sessions.isFetching}
              onRetry={() => {
                void sessions.refetch();
              }}
            />
          </PanelBody>
        ) : sessions.isPending ? (
          <PanelBody className="flex flex-col gap-1.5">
            {[0, 1].map((row) => (
              <Skeleton key={row} className="h-14 w-full" />
            ))}
          </PanelBody>
        ) : sessions.data.length === 0 ? (
          <PanelBody>
            <p className="text-sm text-text-2">
              No sessions listed. That is unusual — you are signed in right now, so try refreshing.
            </p>
          </PanelBody>
        ) : (
          <PanelBody className="flex flex-col gap-1.5">
            {sessions.data.map((row) => {
              const isCurrent = currentSessionId !== null && row.id === currentSessionId;
              return (
                <div
                  key={row.id}
                  className={cn(
                    'flex flex-wrap items-center justify-between gap-[var(--gap)] rounded-md border bg-ink-700 px-[var(--pad-card)] py-2.5',
                    isCurrent ? 'border-control/35' : 'border-line',
                  )}
                >
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span aria-hidden className="mt-0.5 shrink-0 text-text-3">
                      {looksMobile(row.userAgent) ? (
                        <Smartphone className="size-4" />
                      ) : (
                        <Laptop className="size-4" />
                      )}
                    </span>
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-1.5 text-[0.8125rem] text-text">
                        <span className="truncate">{describeAgent(row.userAgent)}</span>
                        {isCurrent ? <Badge tone="control">This device</Badge> : null}
                      </p>
                      <p className="text-[0.6875rem] text-text-3">
                        <span className="font-mono">{row.ipAddress ?? 'unknown address'}</span> ·
                        signed in {formatInstant(row.createdAt, locale, timezone)} · expires{' '}
                        {formatInstant(row.expiresAt, locale, timezone)}
                      </p>
                    </div>
                  </div>

                  <Button
                    size="sm"
                    variant={isCurrent ? 'ghost' : 'secondary'}
                    loading={revoking === row.id}
                    onClick={() => {
                      void revoke(row);
                    }}
                  >
                    {isCurrent ? 'Sign out here' : 'Revoke'}
                  </Button>
                </div>
              );
            })}
          </PanelBody>
        )}
      </Panel>

      <Panel>
        <PanelHeader
          eyebrow="Passkeys"
          actions={<Badge tone="neutral">{PASSKEY_ENABLED ? 'Available' : 'Not in this build'}</Badge>}
        >
          Sign in with your device instead of a password.
        </PanelHeader>
        <PanelBody className="flex items-start gap-2.5 text-[0.8125rem] text-text-2">
          <KeyRound className="mt-0.5 size-4 shrink-0 text-text-3" aria-hidden />
          {PASSKEY_ENABLED ? (
            <p>
              Passkeys are enabled for this account. Register one from the sign-in screen on the
              device you want to use.
            </p>
          ) : (
            // Stated plainly rather than shown as a disabled button: an affordance that throws is
            // worse than one that is absent, because the user tries it and concludes their
            // account is the problem.
            <p>
              Passkeys are not switched on in this build. The plugin moved out of better-auth core
              and is not in this lockfile, so there is nothing to register against — two-factor
              authentication is doing the work in the meantime.
            </p>
          )}
        </PanelBody>
      </Panel>
    </div>
  );
}

/** A rough device read from the user agent. Enough to recognise your own phone in a list. */
function looksMobile(userAgent: string | null): boolean {
  if (userAgent === null) return false;
  return /android|iphone|ipad|mobile/i.test(userAgent);
}

function describeAgent(userAgent: string | null): string {
  if (userAgent === null) return 'Unknown device';

  const browser =
    /edg\//i.test(userAgent) ? 'Edge'
    : /opr\//i.test(userAgent) ? 'Opera'
    : /chrome\//i.test(userAgent) ? 'Chrome'
    : /safari\//i.test(userAgent) ? 'Safari'
    : /firefox\//i.test(userAgent) ? 'Firefox'
    : 'Browser';

  const platform =
    /windows/i.test(userAgent) ? 'Windows'
    : /iphone|ipad/i.test(userAgent) ? 'iOS'
    : /mac os/i.test(userAgent) ? 'macOS'
    : /android/i.test(userAgent) ? 'Android'
    : /linux/i.test(userAgent) ? 'Linux'
    : 'Unknown platform';

  return `${browser} on ${platform}`;
}
