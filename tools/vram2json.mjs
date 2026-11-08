#!/usr/bin/env node
/**
 * vram2json — builds data/screens.json ({name: {page: hex 4096 bytes,
 * paletteBank, scroll, note}}) for the static screen test (PL-M3).
 *
 * usage: node tools/vram2json.mjs [--out data/screens.json]
 *
 * Source of the "phase1Start" screen, in this order:
 *  1. sources/reference/phase1-start.bin — PLEIDUMP dump produced by tools/refemu
 *     (format: tools/refemu/README.md); the active page, palette bank and scroll
 *     are taken from the dump. attract-title.bin is added as 'attractTitle' when present.
 *  2. Fallback (no dump yet): a synthetic page built from the ROM the way the
 *     program does it — header rows from the S_01D0 text records at 1800h
 *     (SCORE1 / HI-SCORE / SCORE2, zeros, credit line), the player's ship
 *     (2x2 tiles 70 72 / 71 73 from 24ECh) at the bottom, and the background
 *     rows decoded from the RLE block 1640h with the S_0650 algorithm (start
 *     4B3Ah, one row of 26 columns left to right, then one row up).
 *     Palette bank 0 (set_palette table row 0, column 3 -> 00h), scroll 0.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outFile = path.resolve(root, outIdx >= 0 ? args[outIdx+1] : 'data/screens.json');

const ROM_FILES = ['ic47.r1', 'ic48.r2', 'ic47.bin', 'ic48.bin', 'ic51.r5', 'ic50.bin', 'ic53.r7', 'ic52.bin'];   // MAME ROM_START(pleiads) order
const rom = Buffer.concat(ROM_FILES.map((f) => fs.readFileSync(path.join(root, 'sources/rom/pleiads', f))));

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// VRAM address (4000h-4FFFh) -> page offset
const vram = (address) => address-0x4000;

/**
 * Reads a refemu dump (tools/refemu/README.md, 8216 bytes): magic 'PLEIDUMP',
 * page 0 at 8, page 1 at 4104, byte 8200 = last write to 5000h (bit 0 active
 * page, bits 1-2 palette bank), byte 8201 = scroll (5800h), 8204 = frame (LE).
 * @returns {Object|null}
 */
function readDump(name) {
  const binFile = path.join(root, 'sources/reference', name+'.bin');
  if (!fs.existsSync(binFile)) {
    return null;
  }
  const bin = fs.readFileSync(binFile);
  if (bin.length != 8216 || bin.toString('latin1', 0, 8) != 'PLEIDUMP') {
    throw new Error(binFile+': not a PLEIDUMP dump (8216 bytes expected)');
  }
  const control = bin[8200];
  const activePage = control & 1;
  const page = new Uint8Array(bin.subarray(8+activePage*4096, 8+activePage*4096+4096));
  const frame = bin.readUInt32LE(8204);
  return {page, paletteBank: (control >> 1) & 3, scroll: bin[8201], note: 'refemu dump sources/reference/'+name+'.bin, frame '+frame+', page '+activePage+', 5000h='+control.toString(16)};
}

/** S_01D0: one 32-byte record = [hi, lo][4 unused][26 tile codes], written left to right (column 25 -> 0). */
function drawTextRecord(page, address) {
  let target = (rom[address] << 8) | rom[address+1];
  for (let i = 0; i < 26; i++) {
    page[vram(target)] = rom[address+6+i];
    target -= 0x20;   // S_0217: one column to the right
  }
}

/** S_0650: RLE rows (00 n = n zeros, 3F n = n x 3Fh, else 1 tile), 26 columns per row, start 4B3Ah, then one row up. */
function drawBackgroundRLE(page, source, target, rows) {
  let src = source;
  for (let r = 0; r < rows; r++) {
    let address = target;
    let count = 0;
    while (count < 26) {
      let code = rom[src++], repeat = 1;
      if (code == 0x00 || code == 0x3F) {
        repeat = rom[src++];
      }
      for (let k = 0; k < repeat && count < 26; k++, count++) {
        page[vram(address)] = code;
        address -= 0x20;
      }
    }
    target -= 1;   // 43B1h--: next row up
  }
  return src;
}

function synthetic() {
  const page = new Uint8Array(0x1000);
  [0x1800, 0x1820, 0x1840].forEach((a) => drawTextRecord(page, a));   // reset: 1800h x3 (rows 0-2)
  page[vram(0x4142)] = 0x20+1;   // credits digit '1' (438Fh -> 4142h)
  // lives P1 (4390h -> 42A2h): 3 lives shown as digit
  page[vram(0x42A2)] = 0x20+3;
  // player's ship 2x2 (24ECh: 70 72 / 71 73): left column top/bottom, right column top/bottom; bottom rows 29-30, columns 12-13
  const ship = [0x70, 0x72, 0x71, 0x73];
  const shipAddress = 0x4000+((25-12) << 5)+29;   // column 12, row 29
  page[vram(shipAddress)] = ship[0];
  page[vram(shipAddress+1)] = ship[1];
  page[vram(shipAddress-0x20)] = ship[2];
  page[vram(shipAddress-0x20+1)] = ship[3];
  // background planet/surface: RLE 1640h, 10 rows from row 26 (4B3Ah) upwards
  drawBackgroundRLE(page, 0x1640, 0x4B3A, 10);
  return {page, paletteBank: 0, scroll: 0, note: 'SYNTHETIC stand-in (no refemu dump yet): 1800h header, ship 70-73, RLE background 1640h'};
}

const out = {
  format: {page: 'hex, 4096 bytes = 4000h-4FFFh of the active page (fg 000-33F, bg 800-B3F)', paletteBank: 'bits 1-2 of 5000h', scroll: '5800h'}
};
const add = (name, screen) => {
  out[name] = {page: toHex(screen.page), paletteBank: screen.paletteBank, scroll: screen.scroll, note: screen.note};
  console.log(name+': '+screen.note);
};
add('phase1Start', readDump('phase1-start') || synthetic());
const attract = readDump('attract-title');
if (attract) {
  add('attractTitle', attract);
}
fs.writeFileSync(outFile, JSON.stringify(out, null, 1)+'\n');
console.log('written '+outFile);
