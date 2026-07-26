/**
 * Postgres enums, generated from the unions in `@ledger/core/domain`.
 *
 * Deriving them rather than restating them means adding a status to the domain union without a
 * migration is a compile-time mismatch, not a runtime `invalid input value for enum` at 3am.
 */

import { pgEnum } from 'drizzle-orm/pg-core';
import {
  BILLING_CHANNELS,
  CANCELLATION_METHODS,
  CANCELLATION_STATUSES,
  CATEGORIES,
  CONNECTION_STATUSES,
  DETECTION_STATUSES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  SUBSCRIPTION_SOURCES,
  SUBSCRIPTION_STATUSES,
} from '@ledger/core';

export const subscriptionStatusEnum = pgEnum('subscription_status', SUBSCRIPTION_STATUSES);
export const billingChannelEnum = pgEnum('billing_channel', BILLING_CHANNELS);
export const cancellationMethodEnum = pgEnum('cancellation_method', CANCELLATION_METHODS);
export const cancellationStatusEnum = pgEnum('cancellation_status', CANCELLATION_STATUSES);
export const categoryEnum = pgEnum('category', CATEGORIES);
export const subscriptionSourceEnum = pgEnum('subscription_source', SUBSCRIPTION_SOURCES);
export const detectionStatusEnum = pgEnum('detection_status', DETECTION_STATUSES);
export const notificationTypeEnum = pgEnum('notification_type', NOTIFICATION_TYPES);
export const notificationChannelEnum = pgEnum('notification_channel', NOTIFICATION_CHANNELS);
export const connectionStatusEnum = pgEnum('connection_status', CONNECTION_STATUSES);

/** Billing cadence unit. Paired with `interval_count`; see `@ledger/core` RecurrenceInterval. */
export const intervalUnitEnum = pgEnum('interval_unit', ['day', 'week', 'month', 'year']);

/** Who performed an action, for the audit log and the cancellation timeline. */
export const actorEnum = pgEnum('actor', ['user', 'system', 'provider', 'import']);

/** What an uploaded file is for, so the UI can label evidence correctly. */
export const attachmentPurposeEnum = pgEnum('attachment_purpose', [
  'cancellation_confirmation',
  'screenshot',
  'correspondence',
  'invoice',
  'other',
]);

export const paymentMethodTypeEnum = pgEnum('payment_method_type', [
  'card',
  'bank_account',
  'paypal',
  'wallet',
  'other',
]);
