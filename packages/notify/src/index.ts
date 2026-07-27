/**
 * @ledger/notify — deciding what to tell a user, when, and through which channel.
 *
 * The package splits in two along a line worth keeping: `schedule.ts`, `digest.ts`,
 * `quiet-hours.ts` and `local-time.ts` are pure functions over a `Clock`, and everything under
 * `channels/` is IO. Nothing in the pure half imports the database, and nothing in it reads the
 * system clock — which is why "the trial alert fires three days early, at 09:00 local, deferred
 * out of quiet hours, exactly once" is a test rather than a hope.
 *
 * Templates are exported separately (`@ledger/notify/templates`) so a worker that only schedules
 * never pulls React into its bundle.
 */

export * from './types';
export * from './local-time';
export * from './quiet-hours';
export * from './schedule';
export * from './digest';
export * from './channels/index';
export { renderNotification } from './templates/index';
