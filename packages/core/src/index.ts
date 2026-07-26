/**
 * @ledger/core — the vocabulary every other package shares.
 *
 * Zero runtime dependencies, zero node builtins, zero IO. `packages/detection` imports from
 * here and has to remain pure, so that constraint propagates backwards into this package.
 */

export * from './errors';
export * from './currency';
export * from './money';
export * from './fx';
export * from './plain-date';
export * from './interval';
export * from './commitment';
export * from './aggregate';
export * from './clock';
export * from './ids';
export * from './domain';
