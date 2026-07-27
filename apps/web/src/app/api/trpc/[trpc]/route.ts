import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import type { NextRequest } from 'next/server';
import { childLogger } from '@ledger/logger';
import { captureException } from '~/lib/observability';
import { createContext } from '~/server/trpc/init';
import { appRouter } from '~/server/trpc/routers/_app';

const log = childLogger('trpc-handler');

function handler(request: NextRequest): Promise<Response> {
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req: request,
    router: appRouter,
    createContext: () => createContext({ headers: request.headers }),
    onError({ error, path }) {
      // Client-fault codes are noise at error level; a 500 here is a real bug.
      if (error.code === 'INTERNAL_SERVER_ERROR') {
        // Routed through the observability seam rather than logged directly, so wiring Sentry
        // later is a change in one file instead of a grep for every error site.
        captureException(error.cause ?? error, {
          where: `trpc:${path ?? 'unknown'}`,
          meta: { code: error.code },
        });
      } else {
        log.debug({ path, code: error.code }, 'procedure rejected');
      }
    },
  });
}

export { handler as GET, handler as POST };
