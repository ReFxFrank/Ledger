import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

/**
 * The axe-core harness.
 *
 * Two rules govern what this file is allowed to do, and they are the whole reason it exists as a
 * shared helper rather than a line in each spec:
 *
 *  1. **Nothing is excluded.** There is no `exclude()`, no `disableRules()`, no allowlist. An
 *     exclusion is a decision to ship an inaccessible thing, and it belongs in a code review with
 *     a named owner — not inside a test helper where it silently outlives the reason for it. If a
 *     violation cannot be fixed, this suite goes red and stays red until somebody decides.
 *  2. **Severity decides the verdict, not the count.** `serious` and `critical` fail: those are
 *     the impacts that stop somebody using the screen. `moderate` and `minor` are recorded as
 *     test annotations, so they show up in the report and in `--reporter=html` without turning
 *     the suite into a wall of red that nobody reads. A quality gate people route around is worse
 *     than no gate.
 *
 * The rule set is WCAG 2.0/2.1/2.2 A and AA plus axe's own best-practice pack. Best practice is
 * in deliberately: `region`, `heading-order` and `landmark-unique` catch structural problems that
 * no WCAG success criterion names but that a screen-reader user feels immediately — and they land
 * in the annotate bucket, so they inform without blocking.
 */

const RULE_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
  'best-practice',
] as const;

/** Impacts that fail the run. Everything below this is reported and kept visible. */
const BLOCKING_IMPACTS: ReadonlySet<string> = new Set(['serious', 'critical']);

type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;
type Violation = AxeResults['violations'][number];

export interface ScanOptions {
  /**
   * Something that must be on screen before axe runs. Scanning a skeleton measures the skeleton:
   * every one of these screens paints placeholder rows first, and their contrast, their headings
   * and their landmarks are not the ones a user reads.
   */
  readonly ready?: Locator;
  /** Extra wait for the ready locator. Connect-backed screens can be slow behind a backfill. */
  readonly readyTimeout?: number;
}

function describeNode(node: Violation['nodes'][number]): string {
  const target = node.target.map((part) => (typeof part === 'string' ? part : part.join(' '))).join(' , ');
  // axe's own summary already names which of the rule's checks failed and by how much — for
  // colour-contrast it carries the measured ratio, which is the number a fix is judged against.
  const summary = (node.failureSummary ?? '').replace(/\s*\n\s*/gu, ' ').trim();
  const html = node.html.length > 160 ? `${node.html.slice(0, 160)}…` : node.html;
  return `      at ${target}\n        ${html}\n        ${summary}`;
}

function describeViolation(violation: Violation): string {
  const nodes = violation.nodes.map(describeNode).join('\n');
  return [
    `  [${violation.impact ?? 'unknown'}] ${violation.id} — ${violation.help}`,
    `      ${violation.helpUrl}`,
    nodes,
  ].join('\n');
}

/**
 * Run axe over the current page and assert the serious/critical set is empty.
 *
 * `screen` names what was scanned — a route alone is not enough, because the same route with a
 * dialog open is a different tree with different failures, and a report that says only
 * "/subscriptions" sends the next person looking in the wrong place.
 */
export async function scan(
  page: Page,
  testInfo: TestInfo,
  screen: string,
  options: ScanOptions = {},
): Promise<void> {
  if (options.ready !== undefined) {
    await expect(options.ready.first()).toBeVisible({ timeout: options.readyTimeout ?? 30_000 });
  }

  const results = await new AxeBuilder({ page }).withTags([...RULE_TAGS]).analyze();

  const blocking = results.violations.filter((violation) =>
    BLOCKING_IMPACTS.has(violation.impact ?? ''),
  );
  const advisory = results.violations.filter(
    (violation) => !BLOCKING_IMPACTS.has(violation.impact ?? ''),
  );

  for (const violation of advisory) {
    testInfo.annotations.push({
      type: `a11y-${violation.impact ?? 'unknown'}`,
      description: `${screen} — ${violation.id}: ${violation.help} (${String(violation.nodes.length)} node${violation.nodes.length === 1 ? '' : 's'}) ${violation.helpUrl}`,
    });
  }

  // The passing case is worth printing: "0 serious, 3 minor" says the gate held *and* how close
  // it came, which is the part that predicts the next regression. Same argument the detection
  // golden test makes for its own numbers.
  const label = `${testInfo.project.name} ${screen}`;
  if (blocking.length === 0) {
    // eslint-disable-next-line no-console -- test output; the run's headline number.
    console.log(
      `axe ✓ ${label}: 0 serious/critical, ${String(advisory.length)} advisory, ${String(results.passes.length)} checks passed`,
    );
    return;
  }

  const report = blocking.map(describeViolation).join('\n\n');
  expect(
    blocking,
    `${String(blocking.length)} serious/critical accessibility violation(s) on ${label}:\n\n${report}\n`,
  ).toHaveLength(0);
}

/**
 * Every interactive element on the page must show a focus indicator when focused from the
 * keyboard.
 *
 * `tokens.css` gives `:focus-visible` a two-ring box-shadow and every component in `@ledger/ui`
 * repeats it, but a component that sets `outline: none` and forgets the shadow looks fine in
 * review and is unusable with a keyboard. This walks the real tab order in the real browser and
 * reads the computed style, so a class that never made it into the bundle is caught by the same
 * check as one that was never written.
 *
 * Returns the accessible-ish labels of the elements it visited, in tab order, so a caller can
 * assert the *order* as well as the indicator.
 */
export async function walkFocusOrder(
  page: Page,
  steps: number,
): Promise<readonly { readonly label: string; readonly indicator: boolean }[]> {
  const visited: { label: string; indicator: boolean }[] = [];

  for (let index = 0; index < steps; index += 1) {
    await page.keyboard.press('Tab');
    const entry = await page.evaluate(() => {
      const element = document.activeElement;
      if (element === null || element === document.body) return null;

      const style = getComputedStyle(element);
      const outline =
        style.outlineStyle !== 'none' && style.outlineWidth !== '0px' && style.outlineWidth !== '';
      const shadow = style.boxShadow !== 'none' && style.boxShadow !== '';
      // A ring drawn by a ::before/::after pseudo-element counts too — Radix and cmdk both do
      // this, and reading only the element's own box would call a visible ring invisible.
      const pseudo = (['::before', '::after'] as const).some((which) => {
        const pseudoStyle = getComputedStyle(element, which);
        return (
          pseudoStyle.content !== 'none' &&
          (pseudoStyle.boxShadow !== 'none' ||
            (pseudoStyle.outlineStyle !== 'none' && pseudoStyle.outlineWidth !== '0px'))
        );
      });

      const label =
        element.getAttribute('aria-label') ??
        element.textContent?.trim().slice(0, 40) ??
        element.tagName.toLowerCase();

      return {
        label: `${element.tagName.toLowerCase()}${label === '' ? '' : `:${label}`}`,
        indicator: outline || shadow || pseudo,
      };
    });

    if (entry === null) break;
    visited.push(entry);
  }

  return visited;
}
