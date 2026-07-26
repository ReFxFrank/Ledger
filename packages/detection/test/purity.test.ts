/**
 * The enforceable half of the Phase 4 acceptance criterion: this package is pure.
 *
 * "No IO, no clock, no database, nothing beyond `@ledger/core`" (brief §4) is the property that
 * makes every detection bug reproducible from a JSON file, and it is exactly the kind of property
 * that decays one convenient import at a time. The repo-root ESLint config already forbids the
 * dangerous specifiers, but a lint rule can be disabled with a comment and a lint run can be
 * skipped; this reads the source and asserts the shape directly, so the guarantee survives both.
 *
 * This file uses `node:fs`, which is precisely what it forbids everywhere else. That is not a
 * contradiction — a test is a measuring instrument, not shipped code, and it lives under `test/`
 * rather than `src/` for that reason. Nothing here is reachable from the package entrypoint.
 */

// The purity check has to read the sources it is checking, which is the one thing the rule below
// exists to forbid. Suppressed here and nowhere else: see this file's header.
// eslint-disable-next-line no-restricted-imports -- test-only; not reachable from the entrypoint
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** `src/`, resolved from this file so the test does not depend on the working directory. */
const SOURCE_ROOT = new URL('../src/', import.meta.url);

interface SourceFile {
  /** Relative to `src/`, forward-slashed, so failure messages name a file you can open. */
  readonly path: string;
  readonly text: string;
}

function collect(directory: URL, prefix: string, into: SourceFile[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      collect(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`, into);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    into.push({
      path: `${prefix}${entry.name}`,
      text: readFileSync(new URL(entry.name, directory), 'utf8'),
    });
  }
}

function sourceFiles(): SourceFile[] {
  const files: SourceFile[] = [];
  collect(SOURCE_ROOT, '', files);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The file with its comment lines removed.
 *
 * Both scans below run over this rather than the raw text, because this package documents its own
 * prohibitions at length — `detect.ts` explains why there is no `Date.now()` and `confidence.ts`
 * describes a curve running `from "fixed price"` — and a checker that reads prose as code reports
 * the documentation as the violation.
 */
function codeOf(file: SourceFile): string {
  return file.text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    })
    .join('\n');
}

/**
 * Every module specifier in a file.
 *
 * A regex rather than a parse, deliberately: the day this test needs a TypeScript AST to run is
 * the day it acquires a dependency of its own. Each pattern is anchored on the keyword that
 * introduces a module reference, so a quoted string elsewhere in the file cannot be mistaken for
 * one.
 */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /\b(?:import|export)\b[^;'"]*\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
];

function importsOf(file: SourceFile): string[] {
  const code = codeOf(file);
  const found = new Set<string>();
  for (const pattern of SPECIFIER_PATTERNS) {
    const scanner = new RegExp(pattern.source, pattern.flags);
    let match = scanner.exec(code);
    while (match !== null) {
      const specifier = match[1];
      if (specifier !== undefined) found.add(specifier);
      match = scanner.exec(code);
    }
  }
  return [...found].sort();
}

const NODE_BUILTINS: readonly string[] = [
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'dns',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'readline',
  'stream',
  'timers',
  'tls',
  'url',
  'util',
  'worker_threads',
  'zlib',
];

/** Named individually so a failure says *which* forbidden dependency crept in. */
const FORBIDDEN_PACKAGES: readonly string[] = [
  'drizzle-orm',
  'postgres',
  'pg',
  'plaid',
  'ioredis',
  'undici',
  'axios',
  'node-fetch',
];

/** The one runtime dependency shipped code is allowed. */
const ALLOWED_SHIPPED = new Set(['@ledger/core']);
/** …plus the test runner, for the co-located unit tests under `src/`. */
const ALLOWED_IN_TESTS = new Set(['vitest', 'fast-check']);

function isRelative(specifier: string): boolean {
  return specifier.startsWith('.');
}

function forbiddenReason(specifier: string): string | null {
  if (specifier.startsWith('node:')) return 'node builtin';
  if (NODE_BUILTINS.includes(specifier)) return 'node builtin';
  for (const forbidden of FORBIDDEN_PACKAGES) {
    if (specifier === forbidden || specifier.startsWith(`${forbidden}/`)) {
      return `forbidden dependency ${forbidden}`;
    }
  }
  if (specifier.startsWith('@ledger/') && specifier !== '@ledger/core') {
    return 'a @ledger package other than @ledger/core';
  }
  return null;
}

describe('packages/detection is pure (brief §4, PLAN.md Phase 4 acceptance)', () => {
  const files = sourceFiles();

  it('finds the sources it is supposed to be checking', () => {
    // A purity test that silently found nothing would pass forever. Anchor it on a file that
    // must exist, so a moved directory fails loudly instead of quietly.
    expect(files.length).toBeGreaterThan(5);
    expect(files.map((file) => file.path)).toContain('detect.ts');
  });

  it('imports no node builtin, no database, no aggregator, and no other @ledger package', () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const specifier of importsOf(file)) {
        const reason = forbiddenReason(specifier);
        if (reason !== null) violations.push(`${file.path} imports ${specifier} — ${reason}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('has exactly one runtime dependency, and it is @ledger/core', () => {
    // Stronger than the blocklist above and the reason the blocklist is not enough on its own:
    // a dependency nobody thought to forbid is still a dependency, and `@ledger/detection` is
    // supposed to be runnable from a JSON file and nothing else.
    const unexpected: string[] = [];
    for (const file of files) {
      const allowed = file.path.endsWith('.test.ts')
        ? new Set([...ALLOWED_SHIPPED, ...ALLOWED_IN_TESTS])
        : ALLOWED_SHIPPED;
      for (const specifier of importsOf(file)) {
        if (isRelative(specifier) || allowed.has(specifier)) continue;
        unexpected.push(`${file.path} imports ${specifier}`);
      }
    }
    expect(unexpected).toEqual([]);
  });

  it('reads no clock and no randomness, so the same input always detects the same way', () => {
    // The other half of purity, and the half a dependency blocklist cannot see: `Date.now()` and
    // `Math.random()` are globals. Either one turns a golden-file test into a coin toss.
    const banned = ['Date.now(', 'new Date(', 'Math.random(', 'performance.now(', 'process.env'];
    const violations: string[] = [];

    for (const file of files) {
      const code = codeOf(file);
      for (const token of banned) {
        if (code.includes(token)) violations.push(`${file.path} uses ${token}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
