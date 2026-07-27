/**
 * Stand-in for the `server-only` marker package.
 *
 * `server-only` is not a real dependency: Next resolves it through its own bundler alias and
 * uses it purely to make a server module fail loudly if a client component imports it. Under
 * vitest there is no such alias, so anything importing a server module would fail to resolve.
 * `vitest.config.ts` points the specifier here instead.
 */

export {};
