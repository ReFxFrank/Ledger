import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SignUpForm } from './sign-up-form';

export const metadata: Metadata = { title: 'Create account' };

export default function SignUpPage(): ReactNode {
  return <SignUpForm />;
}
