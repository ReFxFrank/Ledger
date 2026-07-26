import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Class composer for every component in this package.
 *
 * `clsx` handles the conditionals, `twMerge` resolves the conflicts — so a caller passing
 * `className="px-4"` beats the component's own `px-3` instead of both landing in the DOM and the
 * winner being decided by stylesheet order.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * The focus treatment, in one place.
 *
 * `tokens.css` already gives every `:focus-visible` element the ring, but components that set
 * their own outline or live inside a portal are exactly the ones where a global rule quietly
 * stops applying. Repeating it here costs nothing and means the ring cannot go missing.
 */
export const focusRing = 'outline-none focus-visible:[box-shadow:var(--focus-ring)]';

/** Hover on a raised surface: lift and brighten the border. Never a colour change. §6.5. */
export const hoverLift =
  'transition-[transform,border-color,background-color,color] duration-[var(--duration-fast)] ease-standard hover:-translate-y-px hover:border-line-hot';
