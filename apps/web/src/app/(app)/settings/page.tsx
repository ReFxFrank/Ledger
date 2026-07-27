import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SettingsScreen } from '~/components/settings/screen';

export const metadata: Metadata = {
  title: 'Settings',
  description: 'Profile, security, notifications, and your data.',
};

export default function SettingsPage(): ReactNode {
  return <SettingsScreen />;
}
