import 'server-only';

import { auditLog, type Database, type Scope } from '@ledger/db';
import { childLogger } from '@ledger/logger';

const log = childLogger('audit');

export type AuditEntity =
  | 'subscription'
  | 'connection'
  | 'cancellation'
  | 'detection'
  | 'payment_method'
  | 'account'
  | 'data';

export interface AuditActor {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/**
 * Writes an audit entry.
 *
 * Brief §9.5 makes this user-visible, so it is written for a person: a stable verb for `action`,
 * and `meta` holding a readable before/after rather than a serialized diff.
 *
 * Failures are logged and swallowed *here specifically*, and nowhere else in the codebase. The
 * alternative is that a full audit table or a bad JSON value rolls back the user's actual
 * change, which trades a complete audit trail for a broken product. The log line is the
 * compensating control.
 */
export async function recordAudit(
  db: Database,
  scope: Scope,
  actor: AuditActor,
  action: string,
  entity: AuditEntity,
  entityId: string | null,
  meta: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      userId: scope.userId,
      actor: 'user',
      action,
      entity,
      entityId,
      ip: actor.ip,
      ua: actor.userAgent,
      meta,
    });
  } catch (error) {
    log.error(
      { action, entity, entityId, err: error instanceof Error ? error.message : String(error) },
      'failed to write audit entry',
    );
  }
}

/** Same, for something a job did rather than a person. */
export async function recordSystemAudit(
  db: Database,
  userId: string,
  action: string,
  entity: AuditEntity,
  entityId: string | null,
  meta: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      userId,
      actor: 'system',
      action,
      entity,
      entityId,
      ip: null,
      ua: null,
      meta,
    });
  } catch (error) {
    log.error(
      { action, entity, entityId, err: error instanceof Error ? error.message : String(error) },
      'failed to write system audit entry',
    );
  }
}
