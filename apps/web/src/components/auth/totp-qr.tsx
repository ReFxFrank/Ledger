'use client';

import { useMemo, type ReactNode } from 'react';
import { encode } from 'uqr';

/**
 * The enrolment QR code.
 *
 * ## Why the encoder is in the bundle
 *
 * The obvious cheap version of this component is an `<img>` pointed at a QR service. That would
 * put the TOTP secret — the entire second factor for an account that maps someone's finances — in
 * a URL sent to a third party, logged by them, and cached by whatever sits between. There is no
 * threshold of convenience that makes that acceptable, so the encoder ships instead: `uqr` is a
 * few kilobytes, has no dependencies, and never leaves the tab.
 *
 * ## Why inline SVG elements rather than a string
 *
 * `uqr` also offers `renderSVG`, which returns markup — but painting markup means
 * `dangerouslySetInnerHTML`, and the app's CSP is nonce-based specifically so that no HTML string
 * anywhere becomes a place where injected markup could execute. `encode` hands back a boolean
 * matrix; turning that into elements React owns costs one function and keeps the rule intact. It
 * also rules out the data-URI round trip, which would only re-encode the same secret into an
 * `img[src]` that extensions and screenshots can read as a URL.
 *
 * ## Accessibility
 *
 * A QR code is an image of a string, and the string is on screen already. So the SVG is
 * `role="img"` with a label that says what it is and where the machine-readable version of it
 * lives — the setup key below — rather than a label that pretends to transcribe it. The key is
 * the text alternative, and it is selectable, copyable and typable, which the QR is not.
 */

/**
 * Error correction M rather than uqr's default L. A phone camera reads this off a screen at an
 * angle, through glare, at whatever brightness the laptop happens to be on; 15% recoverable loss
 * is worth the extra modules.
 *
 * Border 4 is the quiet zone the QR spec asks for. It is part of the matrix, so the light
 * background below covers it and the code stays readable against a dark panel.
 */
const QR_OPTIONS = { ecc: 'M', border: 4 } as const;

/**
 * One `<path>` for every dark module, with horizontal runs merged.
 *
 * A rect per module is ~1,200 elements for a URI this length; merged runs cut that to a single
 * element and a string, which matters because this renders on the slowest screen in the flow.
 */
function darkModulePath(matrix: readonly (readonly boolean[])[]): string {
  const parts: string[] = [];
  for (const [row, cells] of matrix.entries()) {
    let runStart: number | null = null;
    // Deliberately one past the end: the extra iteration closes a run that reaches the edge.
    for (let column = 0; column <= cells.length; column += 1) {
      const isDark = cells[column] === true;
      if (isDark && runStart === null) {
        runStart = column;
      } else if (!isDark && runStart !== null) {
        const width = column - runStart;
        parts.push(`M${String(runStart)} ${String(row)}h${String(width)}v1h-${String(width)}z`);
        runStart = null;
      }
    }
  }
  return parts.join('');
}

export function TotpQr({
  uri,
  className,
}: {
  readonly uri: string;
  readonly className?: string;
}): ReactNode {
  const qr = useMemo(() => {
    const encoded = encode(uri, QR_OPTIONS);
    return { size: encoded.size, path: darkModulePath(encoded.data) };
  }, [uri]);

  return (
    <svg
      viewBox={`0 0 ${String(qr.size)} ${String(qr.size)}`}
      role="img"
      aria-label="QR code for your authenticator app. It carries the same setup key printed below, which you can type instead."
      // Modules are ~4 device pixels wide here; without this the browser antialiases the edges
      // and a phone camera has a measurably harder time.
      shapeRendering="crispEdges"
      className={className}
    >
      {/*
        Dark modules on a light field, not the other way round. The panel around this is
        `--ink-900`, and an inverted QR is a coin flip on whether a given scanner reads it at all.
        Both fills are tokens: `--text` is the lightest surface the palette has.
      */}
      <rect width={qr.size} height={qr.size} fill="var(--text)" />
      <path d={qr.path} fill="var(--ink-900)" />
    </svg>
  );
}
