import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { CsvImport } from '~/components/subscriptions/csv-import';

export const metadata: Metadata = {
  title: 'Import subscriptions',
  description: 'Bring a CSV in, one column at a time.',
};

/**
 * CSV import.
 *
 * Entirely client side, and deliberately so: the file never leaves the browser until the user has
 * seen exactly what will be created. Parsing on the server would mean uploading a spreadsheet of
 * someone's finances to find out it had the wrong delimiter.
 */
export default function ImportPage(): ReactNode {
  return (
    <div className="flex flex-col gap-[var(--gap-loose)] p-[var(--pad-panel)]">
      <header className="min-w-0">
        <p className="eyebrow">Subscriptions</p>
        <h1 className="mt-1 text-lg font-medium leading-tight text-text">Import from a CSV</h1>
      </header>

      <CsvImport />
    </div>
  );
}
