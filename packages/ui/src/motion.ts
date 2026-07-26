'use client';

/**
 * The animation primitive, exposed through the design system rather than imported directly.
 *
 * Two reasons it lives here instead of in each app's dependency list. One: `motion` is a design
 * decision — §6.5 allows 120–200ms hover lift and border-brighten and one orchestrated entrance
 * per screen, and routing every animation through the package that owns the motion tokens is
 * what keeps a second version of the library (with a second set of defaults) from appearing.
 * Two: `useReducedMotion` has to be reachable everywhere, because `tokens.css` can collapse a
 * CSS duration but cannot collapse a JS-driven stagger — that has to be branched on in code.
 */

export { motion, useReducedMotion } from 'motion/react';
export type { MotionProps, Transition } from 'motion/react';
