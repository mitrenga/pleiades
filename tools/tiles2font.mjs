#!/usr/bin/env node
/**
 * tiles2font — builds the glyph table of app/pleiadesFonts8x8.js.
 *
 * A ZXFonts8x8 table (96 glyphs in the order of ZXFonts8x8.fontsChars, 16 hex
 * digits each: 8 rows, one byte a row, bit 7 the left pixel) filled from:
 *
 *   1. the character tiles of the Pleiads graphics ROM (data/tiles.json, the
 *      foreground set of tools/rom2tiles.mjs): A-Z = tiles 01h-1Ah, 0-9 = 20h-29h,
 *      '-' = 2Bh, '*' = 1Fh, '©' = 2Ch (the (c) of the copyright row). Any pixel
 *      other than 0 is ink; the glyphs sit in the rows 1-6 of the tile, the
 *      baseline of the ZX fonts, so no row shift is needed.
 *   2. the ZX Spectrum ROM font — the default table of svision's ZXFonts8x8,
 *      read out of app/svision/js/platform/canvas2D/zx/zxFonts8x8.js —
 *      for everything else (punctuation, lowercase). No font of ~/sw/zx-fonts
 *      has the Pleiads letters (the closest differs in 103 of the 288 rows of
 *      A-Z 0-9), so unlike Space Invaders there is no sister font to borrow from.
 *
 * Usage: node tools/tiles2font.mjs [--show] [--width TEXT]
 *   --width TEXT prints the width of TEXT in the proportional variant (trimmed
 *   glyph + 2 px spacing, ' ' = 5 px, '␣' = 3 px), to fit a line on the 208 px screen.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CH = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_£abcdefghijklmnopqrstuvwxyz{|}~©';
const ROM_TILES = {'-': 0x2B, '*': 0x1F, '©': 0x2C};
for (let i = 0; i < 26; i++) ROM_TILES[String.fromCharCode(65+i)] = 0x01+i;
for (let i = 0; i < 10; i++) ROM_TILES[String(i)] = 0x20+i;

const tiles = JSON.parse(fs.readFileSync(path.join(root, 'data/tiles.json'), 'utf8'));
const zxSource = fs.readFileSync(path.join(root, 'app/svision/js/platform/canvas2D/zx/zxFonts8x8.js'), 'utf8');
const zxHex = zxSource.match(/this\.fontsData = '([0-9A-Fa-f]+)'/)[1];
if (zxHex.length !== 96*16) throw new Error('ZXFonts8x8 default table not found');

const tileRows = (code) => {
  const t = tiles.fg[code], rows = [];
  for (let y = 0; y < 8; y++) {
    let b = 0;
    for (let x = 0; x < 8; x++) if (t[y*8+x] !== '0') b |= 0x80 >> x;
    rows.push(b);
  }
  return rows;
};
const zxRows = (c) => { const i = CH.indexOf(c)*16; const h = zxHex.substr(i, 16); return [...Array(8)].map((_, y) => parseInt(h.substr(y*2, 2), 16)); };

const glyphs = [], sources = {};
for (const c of CH) {
  const rom = c in ROM_TILES;
  glyphs.push(rom ? tileRows(ROM_TILES[c]) : zxRows(c));
  (sources[rom ? 'ROM tiles' : 'ZX ROM font'] ||= []).push(c);
}
const hex = glyphs.map((rows) => rows.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('')).join('');
console.log(hex);
for (const src in sources) console.error(`${src.padEnd(12)} ${sources[src].join('')}`);

const args = process.argv.slice(2);
if (args.includes('--show')) {
  for (const text of ['PLEIADES 0123456789', '-*©', 'abcdefghijklmnopqrstuvwxyz']) {
    for (let y = 0; y < 8; y++) console.error(text.split('').map((c) => [...Array(8)].map((_, x) => glyphs[CH.indexOf(c)][y] & (0x80 >> x) ? '#' : '.').join('')).join(' '));
    console.error('');
  }
}
const wi = args.indexOf('--width');
if (wi >= 0) {
  const text = args[wi+1];
  let width = 0;
  for (const c of text) {
    if (c === ' ') { width += 5; continue; }
    if (c === '␣') { width += 3; continue; }
    const g = glyphs[CH.indexOf(c)] || glyphs[CH.indexOf('?')];
    let left = 8, right = -1;
    g.forEach((b) => { for (let x = 0; x < 8; x++) if (b & (0x80 >> x)) { left = Math.min(left, x); right = Math.max(right, x); } });
    width += (right < 0 ? 0 : right-left+1) + 2;
  }
  console.error(`width of "${text}": ${width} px (proportional)`);
}
