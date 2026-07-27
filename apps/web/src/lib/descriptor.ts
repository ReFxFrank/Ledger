/**
 * Descriptor decoding for the review queue.
 *
 * `DescriptorDecoder` paints character ranges it is handed and never re-derives them, which is
 * what makes a screenshot of it enough to debug a bad match. The ranges have to come from
 * somewhere, though, and the `detections` row does not carry them: the evidence blob stores the
 * normalised key and the match method, not the spans. So they are recomputed here from the same
 * pure function the engine used — `normalizeDescriptor` in @ledger/detection, which takes a
 * string and returns spans with no clock, no IO and no registry.
 *
 * Recomputing is safe precisely because that function is pure: given the descriptor the engine
 * saw, it produces the spans the engine produced. If the highlight lands in the wrong place, the
 * bug is in the normaliser, and the decoder has done its job by showing it.
 *
 * The one thing that cannot be recomputed cheaply is the merchant match — `matchMerchant` needs
 * the whole provider registry, which is a dataset the browser has no business downloading to
 * draw one highlight. So the matched span is located the way the alias matcher locates it: find
 * the merchant's own tokens as a contiguous run inside the descriptor's tokens, and take the
 * character range those tokens came from.
 */

import { type NormalizedDescriptor, type StrippedSpan, type TextSpan, normalizeDescriptor } from '@ledger/detection';

export interface DecodedDescriptor {
  readonly raw: string;
  /** The clustering key. Empty when nothing identifying survived the strip passes. */
  readonly normalized: string;
  readonly strippedSpans: readonly StrippedSpan[];
  /** Absent when the descriptor had no tokens left to point at. */
  readonly matchedSpan: TextSpan | undefined;
  /** True when the highlight is the merchant's name rather than the whole surviving key. */
  readonly matchedMerchant: boolean;
}

/**
 * Where the merchant's tokens sit inside the descriptor's tokens.
 *
 * Mirrors `indexOfTokenRun` in the matcher: a contiguous run, not a subset, because
 * `AMAZON … PRIME` and `AMAZON PRIME` are different descriptors and treating them as the same
 * match is how the wrong cancellation playbook gets attached.
 */
function indexOfTokenRun(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;

  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return -1;
}

/** The character range covered by `tokenSpans[start .. start + length - 1]`. */
function spanOfTokenRun(
  descriptor: NormalizedDescriptor,
  start: number,
  length: number,
): TextSpan | undefined {
  const first = descriptor.tokenSpans[start];
  const last = descriptor.tokenSpans[start + length - 1];
  if (first === undefined || last === undefined) return undefined;
  return { start: first.start, end: last.end };
}

/**
 * Decodes one raw bank descriptor for display.
 *
 * `merchantName` is the merchant the engine attached, or null when it recognised nothing. With a
 * merchant, the highlight is that merchant's name. Without one, the highlight is the full run of
 * surviving tokens — which is the clustering key, and is the honest answer to "what did you match
 * on": not a merchant, but this text.
 */
export function decodeDescriptor(raw: string, merchantName: string | null): DecodedDescriptor {
  const descriptor = normalizeDescriptor(raw);

  const fullSpan = spanOfTokenRun(descriptor, 0, descriptor.tokenSpans.length);
  const base = {
    raw,
    normalized: descriptor.normalized,
    strippedSpans: descriptor.strippedSpans,
  } as const;

  if (merchantName === null || merchantName.trim() === '') {
    return { ...base, matchedSpan: fullSpan, matchedMerchant: false };
  }

  const merchantTokens = normalizeDescriptor(merchantName).tokens;
  const start = indexOfTokenRun(descriptor.tokens, merchantTokens);
  if (start < 0) {
    // The merchant was matched by trigram similarity rather than by an alias appearing verbatim,
    // so there is no substring to point at. Highlighting the whole key is the truthful fallback:
    // it says "this text resembled the merchant" instead of inventing a range.
    return { ...base, matchedSpan: fullSpan, matchedMerchant: false };
  }

  const span = spanOfTokenRun(descriptor, start, merchantTokens.length);
  return { ...base, matchedSpan: span ?? fullSpan, matchedMerchant: span !== undefined };
}

/** "30, 31, 30" — the day gaps the cadence was read from, capped so a long history stays legible. */
export function formatGapDays(gaps: readonly number[], limit = 8): string {
  if (gaps.length === 0) return '';
  const shown = gaps.slice(-limit);
  const prefix = gaps.length > shown.length ? '… ' : '';
  return `${prefix}${shown.join(', ')}`;
}
