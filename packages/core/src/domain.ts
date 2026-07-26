/**
 * Shared domain vocabulary.
 *
 * These unions live in `core` rather than in `db` so that `detection`, `providers`, and
 * `notify` can speak the same language without any of them depending on the database. The
 * Drizzle enums are generated *from* these lists, which means adding a status here and
 * forgetting the migration is a type error rather than a runtime surprise.
 */

// ── subscription status (brief §5) ──────────────────────────────────────────────────────

export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'paused',
  'cancel_scheduled',
  'canceled',
  'lapsed',
  'unknown',
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const SUBSCRIPTION_STATUS_LABELS: Readonly<Record<SubscriptionStatus, string>> = {
  trialing: 'Trial',
  active: 'Active',
  paused: 'Paused',
  cancel_scheduled: 'Cancelling',
  canceled: 'Cancelled',
  lapsed: 'Lapsed',
  unknown: 'Unknown',
};

/** Statuses that still cost money and therefore count toward committed spend. */
export const COMMITTED_STATUSES: readonly SubscriptionStatus[] = ['trialing', 'active', 'cancel_scheduled'];

export function isCommitted(status: SubscriptionStatus): boolean {
  return COMMITTED_STATUSES.includes(status);
}

// ── billing channel (brief §3.1 — the step everyone gets wrong) ─────────────────────────

/**
 * Who actually takes the money. This is not cosmetic: an App Store–billed subscription cannot
 * be cancelled on the provider's website, and showing the provider's cancel link for one is the
 * single most damaging thing this product could do.
 */
export const BILLING_CHANNELS = [
  'direct',
  'apple',
  'google',
  'amazon',
  'paypal',
  'roku',
  'carrier',
  'microsoft',
  'steam',
  'unknown',
] as const;

export type BillingChannel = (typeof BILLING_CHANNELS)[number];

export const BILLING_CHANNEL_LABELS: Readonly<Record<BillingChannel, string>> = {
  direct: 'Billed directly',
  apple: 'Apple App Store',
  google: 'Google Play',
  amazon: 'Amazon',
  paypal: 'PayPal',
  roku: 'Roku',
  carrier: 'Mobile carrier',
  microsoft: 'Microsoft Store',
  steam: 'Steam',
  unknown: 'Unknown',
};

/** Channels where the provider's own website cannot cancel the subscription. */
export const INTERMEDIATED_CHANNELS: readonly BillingChannel[] = [
  'apple',
  'google',
  'amazon',
  'roku',
  'carrier',
  'microsoft',
];

export function isIntermediated(channel: BillingChannel): boolean {
  return INTERMEDIATED_CHANNELS.includes(channel);
}

// ── cancellation ───────────────────────────────────────────────────────────────────────

export const CANCELLATION_METHODS = [
  'account_settings',
  'web_form',
  'email',
  'chat',
  'phone',
  'post',
  'in_person',
  'app_store',
] as const;

export type CancellationMethod = (typeof CANCELLATION_METHODS)[number];

export const CANCELLATION_METHOD_LABELS: Readonly<Record<CancellationMethod, string>> = {
  account_settings: 'Account settings',
  web_form: 'Web form',
  email: 'Email',
  chat: 'Live chat',
  phone: 'Phone call',
  post: 'Letter by post',
  in_person: 'In person',
  app_store: 'App store settings',
};

/** Brief §3.2. Shown to the user honestly, never softened. */
export type CancellationDifficulty = 1 | 2 | 3 | 4 | 5;

export const DIFFICULTY_LABELS: Readonly<Record<CancellationDifficulty, string>> = {
  1: 'One click in account settings',
  2: 'A few clicks — expect a retention offer',
  3: 'Requires chat or email',
  4: 'Requires a phone call',
  5: 'Requires post, notice period, or an in-person visit',
};

export const CANCELLATION_STATUSES = [
  'draft',
  'in_progress',
  'awaiting_confirmation',
  'confirmed',
  'verified',
  'failed',
  'abandoned',
] as const;

export type CancellationStatus = (typeof CANCELLATION_STATUSES)[number];

export const CANCELLATION_STATUS_LABELS: Readonly<Record<CancellationStatus, string>> = {
  draft: 'Not started',
  in_progress: 'In progress',
  awaiting_confirmation: 'Waiting for confirmation',
  confirmed: 'Confirmed by provider',
  verified: 'Verified — no further charges',
  failed: 'Charged again after cancelling',
  abandoned: 'Abandoned',
};

// ── categories ─────────────────────────────────────────────────────────────────────────

export const CATEGORIES = [
  'streaming_video',
  'music_audio',
  'gaming',
  'software',
  'ai',
  'design',
  'cloud_storage',
  'security_vpn',
  'news_publishing',
  'fitness',
  'food_delivery',
  'dating',
  'telecom',
  'insurance',
  'utilities',
  'education',
  'creator_support',
  'storage_unit',
  'pets',
  'finance',
  'health',
  'transport',
  'charity',
  'other',
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Readonly<Record<Category, string>> = {
  streaming_video: 'Streaming video',
  music_audio: 'Music & audio',
  gaming: 'Gaming',
  software: 'Software',
  ai: 'AI',
  design: 'Design',
  cloud_storage: 'Cloud storage',
  security_vpn: 'Security & VPN',
  news_publishing: 'News & publishing',
  fitness: 'Fitness',
  food_delivery: 'Food & delivery',
  dating: 'Dating',
  telecom: 'Telecom',
  insurance: 'Insurance',
  utilities: 'Utilities',
  education: 'Education',
  creator_support: 'Creator support',
  storage_unit: 'Storage',
  pets: 'Pets',
  finance: 'Finance',
  health: 'Health',
  transport: 'Transport',
  charity: 'Charity',
  other: 'Other',
};

// ── provenance ─────────────────────────────────────────────────────────────────────────

export const SUBSCRIPTION_SOURCES = ['manual', 'detected', 'csv_import', 'email_receipt'] as const;
export type SubscriptionSource = (typeof SUBSCRIPTION_SOURCES)[number];

export const DETECTION_STATUSES = ['pending', 'confirmed', 'dismissed', 'merged'] as const;
export type DetectionStatus = (typeof DETECTION_STATUSES)[number];

// ── notifications (brief §8) ───────────────────────────────────────────────────────────

export const NOTIFICATION_TYPES = [
  'trial_ending',
  'renewal_upcoming',
  'price_changed',
  'cancel_by_deadline',
  'cancellation_unconfirmed',
  'charged_after_cancellation',
  'new_detections',
  'sync_failed',
  'consent_expiring',
  'duplicate_detected',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_CHANNELS = ['email', 'push', 'in_app'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * The one notification that ignores quiet hours (brief §8). Being charged after you cancelled
 * is time-sensitive in a way "your trial ends in three days" is not — dispute windows are short.
 */
export const URGENT_NOTIFICATION_TYPES: readonly NotificationType[] = ['charged_after_cancellation'];

export function ignoresQuietHours(type: NotificationType): boolean {
  return URGENT_NOTIFICATION_TYPES.includes(type);
}

export const DEFAULT_LEAD_TIME_DAYS: Readonly<Record<NotificationType, number>> = {
  trial_ending: 3,
  renewal_upcoming: 2,
  price_changed: 0,
  cancel_by_deadline: 7,
  cancellation_unconfirmed: 3,
  charged_after_cancellation: 0,
  new_detections: 0,
  sync_failed: 0,
  consent_expiring: 14,
  duplicate_detected: 0,
};

// ── connections ────────────────────────────────────────────────────────────────────────

export const CONNECTION_STATUSES = [
  'active',
  'reauth_required',
  'consent_expiring',
  'consent_expired',
  'error',
  'disconnected',
] as const;

export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const CONNECTION_STATUS_LABELS: Readonly<Record<ConnectionStatus, string>> = {
  active: 'Connected',
  reauth_required: 'Needs sign-in',
  consent_expiring: 'Consent expiring',
  consent_expired: 'Consent expired',
  error: 'Sync failed',
  disconnected: 'Disconnected',
};
