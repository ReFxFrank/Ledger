#!/usr/bin/env node
/**
 * Draws the PWA icons that `apps/web/public/manifest.webmanifest` points at.
 *
 * The mark is the one the app shell already wears next to the word "Ledger": an amber dot on the
 * page surface. `--outflow` on `--ink-900`, both read out of `packages/ui/src/tokens.css` at the
 * top of this file rather than eyeballed, because an icon is the one surface where a colour tends
 * to get retyped from memory and then quietly diverge from the palette it is supposed to belong to.
 *
 * Rasterised here rather than shipped as binaries or produced by an image library:
 *
 *  - A committed PNG nobody can regenerate is a dead end the first time the palette moves.
 *  - `sharp`/`resvg` would be a native dependency added to a repo that has none, for four circles.
 *
 * So this writes the PNG bytes directly — zlib is in Node, a PNG is a header plus one deflated
 * IDAT, and a filled circle is analytic. 4x4 supersampling gives the edge the same softness a real
 * renderer would; at 192px and up the difference is invisible, which is the point.
 *
 * Run:  node scripts/generate-icons.mjs
 * The output is committed, so this only needs re-running when the mark or the tokens change.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tokensPath = join(root, 'packages', 'ui', 'src', 'tokens.css');
const outDir = join(root, 'apps', 'web', 'public', 'icons');

/** Reads a hex token straight out of the frozen stylesheet. Throws rather than guessing. */
function token(css, name) {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (match === null) throw new Error(`tokens.css has no --${name} hex value`);
  const hex = match[1];
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

// ── PNG encoding ─────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** 8-bit truecolour, no alpha: the mark is opaque and a background is always drawn. */
function encodePng(size, rgb) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  // Filter byte 0 on every scanline. Deflate finds the run-lengths on its own here, and a real
  // filter selection loop would be a lot of code to save a few hundred bytes on a flat image.
  const stride = size * 3;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y += 1) {
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── the mark ─────────────────────────────────────────────────────────────────────────────

const SAMPLES = 4;

function drawMark(size, radiusRatio, background, foreground) {
  const rgb = Buffer.alloc(size * size * 3);
  const centre = size / 2;
  const radiusSquared = (size * radiusRatio) ** 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let inside = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const dx = x + (sx + 0.5) / SAMPLES - centre;
          const dy = y + (sy + 0.5) / SAMPLES - centre;
          if (dx * dx + dy * dy <= radiusSquared) inside += 1;
        }
      }
      const coverage = inside / (SAMPLES * SAMPLES);
      const offset = (y * size + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        rgb[offset + channel] = Math.round(
          background[channel] + (foreground[channel] - background[channel]) * coverage,
        );
      }
    }
  }
  return rgb;
}

/**
 * `any` icons are shown as drawn; `maskable` ones get cropped to whatever shape the platform
 * prefers, and only the middle 80% is guaranteed to survive. Hence the smaller radius on those —
 * same mark, more room around it, rather than a second design.
 */
const ICONS = [
  { file: 'icon-192.png', size: 192, radiusRatio: 0.22 },
  { file: 'icon-512.png', size: 512, radiusRatio: 0.22 },
  { file: 'icon-maskable-192.png', size: 192, radiusRatio: 0.17 },
  { file: 'icon-maskable-512.png', size: 512, radiusRatio: 0.17 },
  // iOS applies its own rounding and never composites onto a page background, so this one is
  // full-bleed like the `any` icons and sized to what Safari asks for.
  { file: 'apple-touch-icon.png', size: 180, radiusRatio: 0.22 },
];

const css = readFileSync(tokensPath, 'utf8');
const ink900 = token(css, 'ink-900');
const outflow = token(css, 'outflow');

mkdirSync(outDir, { recursive: true });

for (const { file, size, radiusRatio } of ICONS) {
  const png = encodePng(size, drawMark(size, radiusRatio, ink900, outflow));
  writeFileSync(join(outDir, file), png);
  console.log(`  ${file}  ${String(size)}x${String(size)}  ${String(png.length)} bytes`);
}

// The same geometry as a vector, for anything that would rather scale than resample — and as the
// human-readable record of what the raster above is a picture of.
const hex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
writeFileSync(
  join(outDir, 'mark.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">\n` +
    `  <title>Ledger</title>\n` +
    `  <rect width="512" height="512" fill="${hex(ink900)}"/>\n` +
    `  <circle cx="256" cy="256" r="${String(512 * 0.22)}" fill="${hex(outflow)}"/>\n` +
    `</svg>\n`,
);
console.log(`  mark.svg`);
console.log(`Icons written to ${outDir.slice(root.length + 1)}`);
