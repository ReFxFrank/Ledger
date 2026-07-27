import type { APIRequestContext, TestInfo } from '@playwright/test';
import { generateTotp, secondsUntilRollover, secretFromOtpauthUri } from './totp';

/**
 * User factory for the e2e suite.
 *
 * Every spec creates its own user so no spec depends on another and all of them coexist with
 * whatever demo data the local database carries. The auth API is used directly rather than the
 * sign-up screen — the screen has its own spec (auth.spec.ts); the other four should not spend
 * thirty seconds each re-proving it.
 *
 * The requests go through the *browser context's* APIRequestContext, so the session cookies the
 * server sets land in the same jar the page navigates with.
 */

export interface TestUser {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  /** Base32 TOTP secret, straight out of the enrolment `otpauth://` URI. */
  readonly totpSecret: string;
}

/** Meets the 12-character floor in server/auth.ts with room to spare. */
export const E2E_PASSWORD = 'e2e-correct-horse-battery';

// `Date.now()` per worker process plus a counter: unique across runs, workers, and projects.
// (Wall-clock use is fine here — this is test tooling, not shipped logic.)
const bootStamp = Date.now();
let sequence = 0;

export function uniqueEmail(testInfo: TestInfo, tag: string): string {
  sequence += 1;
  const project = testInfo.project.name || 'default';
  return `e2e-${tag}-${project}-w${String(testInfo.workerIndex)}-${String(bootStamp)}-${String(sequence)}@ledger-e2e.test`;
}

/**
 * A TOTP code that will still be valid when the server checks it.
 *
 * A code typed with half a second left on the 30-second window fails intermittently and looks
 * like an app bug; waiting out the rollover costs at most three seconds.
 */
export async function freshTotpCode(secret: string): Promise<string> {
  if (secondsUntilRollover() < 4) {
    await new Promise((resolve) => setTimeout(resolve, (secondsUntilRollover() + 1) * 1000));
  }
  return generateTotp(secret);
}

async function authPost(
  request: APIRequestContext,
  baseURL: string,
  path: string,
  data: Record<string, unknown>,
): Promise<unknown> {
  const response = await request.post(`${baseURL}${path}`, {
    data,
    // better-auth refuses cross-origin POSTs; the Origin has to be the server's own.
    headers: { Origin: baseURL },
  });
  const body = await response.text();
  if (!response.ok()) {
    throw new Error(`${path} responded ${String(response.status())}: ${body}`);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

export function requireBaseURL(testInfo: TestInfo): string {
  const base = testInfo.project.use.baseURL;
  if (base === undefined)
    throw new Error('This suite requires a baseURL in the Playwright config.');
  return base.replace(/\/$/, '');
}

/**
 * Sign up, sign in, and complete the mandatory TOTP enrolment — the API-side equivalent of the
 * onboarding step-secure flow. Returns a user whose session in this browser context is fully
 * verified and ready for `protectedProcedure` calls.
 */
export async function createVerifiedUser(
  request: APIRequestContext,
  testInfo: TestInfo,
  tag: string,
): Promise<TestUser> {
  const baseURL = requireBaseURL(testInfo);
  const email = uniqueEmail(testInfo, tag);
  const name = `E2E ${tag}`;

  await authPost(request, baseURL, '/api/auth/sign-up/email', {
    name,
    email,
    password: E2E_PASSWORD,
  });
  await authPost(request, baseURL, '/api/auth/sign-in/email', { email, password: E2E_PASSWORD });

  const enabled = (await authPost(request, baseURL, '/api/auth/two-factor/enable', {
    password: E2E_PASSWORD,
  })) as { totpURI?: string } | null;

  if (typeof enabled?.totpURI !== 'string') {
    throw new Error('two-factor/enable returned no totpURI — cannot finish enrolment.');
  }
  const totpSecret = secretFromOtpauthUri(enabled.totpURI);

  await authPost(request, baseURL, '/api/auth/two-factor/verify-totp', {
    code: await freshTotpCode(totpSecret),
  });

  return { name, email, password: E2E_PASSWORD, totpSecret };
}
