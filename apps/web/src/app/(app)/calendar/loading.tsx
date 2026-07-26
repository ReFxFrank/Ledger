import * as React from 'react';
import { CalendarSkeleton } from '~/components/calendar/calendar-skeleton';

/**
 * Route-level placeholder, shown while the page chunk streams in.
 *
 * It renders the same skeleton the page uses for its own data fetch, so the transition from
 * "route loading" to "data loading" is invisible rather than a second flash of a different shape.
 */
export default function CalendarLoading(): React.ReactNode {
  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-[var(--gap-loose)] p-[var(--pad-panel)]">
      <CalendarSkeleton />
    </div>
  );
}
