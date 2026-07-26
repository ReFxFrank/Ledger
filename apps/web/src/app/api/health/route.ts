import { sql } from 'drizzle-orm';
import { getDatabase } from '@ledger/db';
import { childLogger } from '@ledger/logger';

const log = childLogger('health');

/**
 * Liveness and readiness in one endpoint, referenced by the container healthcheck.
 *
 * It actually touches the database rather than returning a constant. A web container that is
 * accepting connections but cannot reach Postgres is exactly the state a healthcheck exists to
 * catch, and `return { ok: true }` catches nothing.
 *
 * The response deliberately carries no version, no hostname, and no error detail — it is
 * reachable unauthenticated, and a health endpoint is a free reconnaissance surface if you let
 * it be one. The reason for a failure goes to the log, where it is useful and not public.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const started = Date.now();

  try {
    await getDatabase().db.execute(sql`select 1`);
  } catch (error) {
    log.error(
      { err: error instanceof Error ? error.message : String(error) },
      'health check failed: database unreachable',
    );
    return Response.json({ status: 'unhealthy' }, { status: 503 });
  }

  return Response.json(
    { status: 'ok', databaseLatencyMs: Date.now() - started },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
