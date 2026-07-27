import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SignUpForm } from './sign-up-form';

export const metadata: Metadata = { title: 'Create account' };

/**
 * Forced dynamic because the CSP forbids `unsafe-inline`: middleware mints a nonce per request
 * and Next stamps it on the bootstrap scripts *of pages it renders per request*. This page has
 * no cookies, params or fetches, so the build prerendered it static — HTML with un-nonced
 * inline scripts that the production CSP then blocks wholesale. The result was a sign-up form
 * that rendered but never hydrated: nothing typed validated, and the button did nothing.
 * Found by e2e/auth.spec.ts against the production build.
 */
export const dynamic = 'force-dynamic';

export default function SignUpPage(): ReactNode {
  return <SignUpForm />;
}
