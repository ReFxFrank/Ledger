/**
 * Where the key-encryption key comes from.
 *
 * The KEK is the one secret whose compromise unlocks every bank token in the database, so how
 * it is supplied is deliberately a seam: an env var for self-hosting, a KMS call for anyone who
 * wants the key never to sit in a process environment.
 */

import { LedgerError } from '@ledger/core';
import { Keyring, type KeyMaterial, keyFromBase64 } from './envelope';

export interface KekProvider {
  readonly name: string;
  /** The key that seals new records, plus any older keys still needed to open existing ones. */
  load(): Promise<{ primary: KeyMaterial; retired: KeyMaterial[] }>;
}

/**
 * Reads the KEK from `ENCRYPTION_KEY`.
 *
 * `ENCRYPTION_KEY_RETIRED` optionally holds a comma-separated list of previous keys. During a
 * rotation you put the old key there, promote the new one, and the app keeps serving reads of
 * rows the rotation has not reached yet.
 */
export function envKekProvider(env: NodeJS.ProcessEnv = process.env): KekProvider {
  return {
    name: 'env',
    load() {
      const primaryRaw = env['ENCRYPTION_KEY'];
      if (primaryRaw === undefined || primaryRaw.trim() === '') {
        throw new LedgerError(
          'CONFIGURATION_ERROR',
          'ENCRYPTION_KEY is not set. Bank access tokens cannot be stored without it. ' +
            'Generate one with: openssl rand -base64 32',
        );
      }

      const retiredRaw = env['ENCRYPTION_KEY_RETIRED'] ?? '';
      const retired = retiredRaw
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value !== '')
        .map(keyFromBase64);

      return Promise.resolve({ primary: keyFromBase64(primaryRaw), retired });
    },
  };
}

let cached: Keyring | null = null;

/**
 * The process-wide keyring.
 *
 * Cached because deriving key ids hashes the key material, and this is on the path of every
 * token read during a sync. `resetKeyringCache()` exists for tests and for `keys:rotate`, which
 * promotes a new primary mid-process.
 */
export async function getKeyring(provider: KekProvider = envKekProvider()): Promise<Keyring> {
  if (cached !== null) return cached;
  const { primary, retired } = await provider.load();
  cached = new Keyring(primary, retired);
  return cached;
}

export function resetKeyringCache(): void {
  cached = null;
}

/**
 * TODO(frank): a KMS-backed provider goes here — `KMS_KEY_ARN` is already reserved in
 * `.env.example` and read by the env schema. It is a ~40-line implementation against
 * `@aws-sdk/client-kms` (GenerateDataKey on seal, Decrypt on open), but pulling the AWS SDK
 * into the dependency tree for a self-hosted default felt like the wrong trade to make
 * unprompted. Say the word and it drops in behind this same interface with no call-site changes.
 */
export function kmsKekProvider(): KekProvider {
  return {
    name: 'kms',
    load() {
      return Promise.reject(
        new LedgerError(
          'CONFIGURATION_ERROR',
          'KMS_KEY_ARN is set but the KMS provider is not built into this deployment. ' +
            'Unset KMS_KEY_ARN to use ENCRYPTION_KEY, or implement kmsKekProvider().',
        ),
      );
    },
  };
}

export function selectKekProvider(env: NodeJS.ProcessEnv = process.env): KekProvider {
  const arn = env['KMS_KEY_ARN'];
  return arn !== undefined && arn.trim() !== '' ? kmsKekProvider() : envKekProvider(env);
}
