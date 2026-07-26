import { getAuth } from '~/server/auth';

/**
 * `toNextJsHandler` is not used here only because it would force the better-auth instance to be
 * built at module scope, which `next build` evaluates while collecting route config. Resolving
 * the instance per request is the same handler, one import later.
 */
function handler(request: Request): Promise<Response> {
  return getAuth().handler(request);
}

export { handler as GET, handler as POST };
