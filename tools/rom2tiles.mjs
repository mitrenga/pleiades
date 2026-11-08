#!/usr/bin/env node
/**
 * rom2tiles — converts the Pleiads tile ROMs and color PROMs into data/tiles.json
 * (used by app/tileMapEntity.js / app/tileMapRender.js).
 *
 * usage: node tools/rom2tiles.mjs [spec.json] [--preview [out.png]]
 *
 * --preview prints the ASCII art of the tiles listed in the spec (previewTiles)
 * and writes a PNG sheet of both tile sets (16x16 tiles each, palette bank 0,
 * 4x upscaled) for a visual check (default: scratchpad/tmp file, see the
 * printed path).
 *
 * TILE FORMAT (MAME phoenix.cpp `charlayout`, verified 2026-08-30):
 *   8x8 pixels, 2 bitplanes, 256 tiles per layer, 8 consecutive bytes per tile
 *   and plane (charincrement 8*8 bits). planeoffset = {256*8*8, 0}: MAME decodes
 *   plane list entry 0 as the MSB of the pixel value, so the plane at file
 *   offset 0x800 (the SECOND 2 KiB ROM: ic24 / ic40) holds bit 1 and the first
 *   ROM (ic23 / ic39) holds bit 0. yoffs = row*8, xoffs = {7,6,...,0}; MAME bit
 *   offsets are counted from the MSB (gfx decode readbit: 0x80 >> (bitnum % 8)),
 *   so hardware pixel x is bit x (counted from the LSB) of byte row y.
 *
 *   The cabinet is ROT90 (MAME: rotate 90 degrees clockwise): hardware (hx, hy)
 *   -> player (px, py) = (207-hy, hx) on the screen; inside one tile
 *   px = 7-hy, py = hx. tiles.json stores tiles ALREADY ROTATED into the player
 *   orientation, so the renderer never rotates anything.
 *
 * tiles.json:
 *   { "bg": [256 strings], "fg": [256 strings], "palette": [256 "#rrggbb"], "meta": {...} }
 *   Each tile string has 64 characters '0'..'3' (pixel values), row-major in
 *   player orientation: character index = py*8+px.
 *   Palette index of a pixel = colorCode*4 + pixelValue, where
 *   colorCode = (tileCode >> 5) | (fg ? 8 : 0) | (paletteBank << 4)  (0..63),
 *   see MAME get_fg_tile_info / get_bg_tile_info and GFXDECODE (64 color codes x 4).
 *   Foreground pixel value 0 is transparent (MAME set_transparent_pen(0)).
 *
 * PALETTE (MAME phoenix_v.cpp pleiads_palette, resnet.cpp compute_res_net; ported 1:1):
 *   1. compute_res_net_all(prom, phoenix_decode_info, pleiads_net_info):
 *      for i in 0..255, with p26 = prom[i] (low bits), p33 = prom[256+i] (high bits):
 *        R = (p26 >> 0) & 1 | (p33 << 1) & 2
 *        G = (p26 >> 2) & 1 | (p33 >> 1) & 2
 *        B = (p26 >> 1) & 1 | (p33 >> 0) & 2
 *      each 2-bit channel -> voltage via compute_res_net (see resNet() below):
 *      options RES_NET_VCC_5V | RES_NET_VBIAS_5V | RES_NET_VIN_OPEN_COL,
 *      channel {AMP_NONE, rBias 100, rGnd 270, 2 inputs, R = {270, 1}}.
 *   2. "native order": pen[i] = rgb[bitswap<8>(i, 7,6,5,1,0,4,3,2)]
 *   3. palette.normalize_range(0, 255) (lum_min 0, lum_max 255, palette.cpp).
 *   The resulting pens are what MAME displays; the exact intermediate values
 *   are kept in meta.paletteAudit for the PL-M8 audit.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {encodePNG} from './lib/png.mjs';

const args = process.argv.slice(2);
const preview = args.includes('--preview');
const positional = args.filter((a) => !a.startsWith('--'));
const specFile = positional[0] || path.join(path.dirname(new URL(import.meta.url).pathname), 'rom2tiles.spec.json');
const specDir = path.dirname(path.resolve(specFile));
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const num = (v) => (typeof v === 'string') ? parseInt(v, 16) : v;

function readRom(name) {
  return fs.readFileSync(path.join(specDir, spec.romDir, name));
}
function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

// ---------------------------------------------------------------- tiles

/**
 * Decodes 256 tiles of one layer into player-oriented strings of '0'..'3'.
 * @param {Buffer} plane0 - LSB plane ROM (2 KiB)
 * @param {Buffer} plane1 - MSB plane ROM (2 KiB)
 */
function decodeLayer(plane0, plane1) {
  const tiles = [];
  for (let code = 0; code < 256; code++) {
    const chars = new Array(64);
    for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px++) {
        const hx = py, hy = 7-px;                    // ROT90 (clockwise), see header
        const bit = hx;                              // xoffs {7,6,...,0}: MAME bit offsets count from the MSB
                                                     // (readbit: 0x80 >> (bitnum % 8)), so offset 7-x is bit x from the LSB
        const b0 = (plane0[code*8+hy] >> bit) & 1;
        const b1 = (plane1[code*8+hy] >> bit) & 1;
        chars[py*8+px] = String(b0 | (b1 << 1));
      }
    }
    tiles.push(chars.join(''));
  }
  return tiles;
}

// ---------------------------------------------------------------- palette (MAME resnet.cpp port)

const TTL_VOL = 0.05;
const TTL_VOH = 4.0;

/**
 * compute_res_net(inputs, channel, di) for the phoenix/pleiads network
 * (options = RES_NET_VCC_5V | RES_NET_VBIAS_5V | RES_NET_VIN_OPEN_COL, global
 * amp = USE_GLOBAL, per channel AMP_NONE, rBias 100, rGnd 270, R = {270, 1}).
 * Only the code paths reached by these options are ported; each step keeps
 * the MAME statement it mirrors.
 * @param {number} inputs - 2-bit channel value from the PROMs
 * @returns {number} 0..255
 */
function resNet(inputs, net) {
  const vcc = 5.0;              // RES_NET_VCC_5V
  const vBias = 5.0;            // RES_NET_VBIAS_5V (global; channel VBIAS_USE_GLOBAL)
  const vOL = TTL_VOL;          // RES_NET_VIN_OPEN_COL -> OpenCol = 1, vOL = TTL_VOL
  const openCol = true;
  const minout = 0.0, cut = 0.0;  // channel RES_NET_AMP_NONE
  const rGnd = net.rGnd;        // no RES_NET_MONITOR option -> unchanged
  let rTotal = 0.0, v = 0.0;

  // first pass - low inputs (transistor conducting to ground)
  for (let i = 0; i < net.num; i++) {
    const level = (inputs >> i) & 1;
    if (net.R[i] !== 0 && !level) {
      rTotal += 1.0/net.R[i];
      v += vOL/net.R[i];
    }
  }
  // mix in rbias and rgnd
  if (net.rBias !== 0) {
    rTotal += 1.0/net.rBias;
    v += vBias/net.rBias;
  }
  if (rGnd !== 0) {
    rTotal += 1.0/rGnd;
  }
  // second pass - high inputs: open collector = high impedance, adds nothing
  for (let i = 0; i < net.num; i++) {
    const level = (inputs >> i) & 1;
    if (net.R[i] !== 0 && level && !openCol) {
      rTotal += 1.0/net.R[i];
      v += vcc/net.R[i];   // (never reached with OPEN_COL)
    }
  }
  rTotal = 1.0/rTotal;
  v *= rTotal;
  v = Math.max(minout, v-cut);
  return Math.trunc(v*255/vcc+0.4);   // int(v * 255 / vcc + 0.4)
}

const PLEIADS_NET = {rBias: 100, rGnd: 270, num: 2, R: [270, 1]};   // pleiads_net_info (one entry per R,G,B; identical)

// phoenix_decode_info: 2 proms, offsets {0,0,0,256,256,256}, shifts {0,2,1,-1,1,0}, masks {1,1,1,2,2,2}
const DECODE = {
  numcomp: 2,
  offset: [0, 0, 0, 256, 256, 256],
  shift: [0, 2, 1, -1, 1, 0],
  mask: [0x01, 0x01, 0x01, 0x02, 0x02, 0x02]
};

/** compute_res_net_all: PROM (512 bytes) -> 256 [r,g,b] */
function computeResNetAll(prom) {
  const rgb = [];
  for (let i = 0; i < 256; i++) {
    const t = [0, 0, 0];
    for (let j = 0; j < DECODE.numcomp; j++) {
      for (let k = 0; k < 3; k++) {
        const s = DECODE.shift[3*j+k];
        const p = prom[i+DECODE.offset[3*j+k]];
        t[k] |= (s > 0) ? ((p >> s) & DECODE.mask[3*j+k]) : ((p << (0-s)) & DECODE.mask[3*j+k]);
      }
    }
    rgb.push([resNet(t[0], PLEIADS_NET), resNet(t[1], PLEIADS_NET), resNet(t[2], PLEIADS_NET)]);
  }
  return rgb;
}

/** bitswap<8>(val, 7,6,5,1,0,4,3,2): result bit 7..0 takes val bits 7,6,5,1,0,4,3,2 */
function bitswapNative(i) {
  const bit = (n) => (i >> n) & 1;
  return (bit(7) << 7) | (bit(6) << 6) | (bit(5) << 5) | (bit(1) << 4) | (bit(0) << 3) | (bit(4) << 2) | (bit(3) << 1) | bit(2);
}

/** palette_t::normalize_range(0, 255, lum_min = 0, lum_max = 255) — integer math as in palette.cpp */
function normalizeRange(pens) {
  const clamp = (x) => Math.max(0, Math.min(255, x));
  const idiv = (a, b) => Math.trunc(a/b);   // C++ integer division truncates toward zero
  let ymin = 1000*255, ymax = 0;
  pens.forEach(([r, g, b]) => {
    const y = 299*r+587*g+114*b;
    ymin = Math.min(ymin, y);
    ymax = Math.max(ymax, y);
  });
  const tmin = 0, tmax = 255;
  return pens.map(([r, g, b]) => {
    const y = 299*r+587*g+114*b;
    const u = idiv((b-idiv(y, 1000))*492, 1000);
    const v = idiv((r-idiv(y, 1000))*877, 1000);
    const target = tmin+idiv((y-ymin)*(tmax-tmin+1), (ymax-ymin));
    return [
      clamp(target+idiv(1140*v, 1000)),
      clamp(target-idiv(395*u, 1000)-idiv(581*v, 1000)),
      clamp(target+idiv(2032*u, 1000))
    ];
  });
}

function hex(rgb) {
  return '#'+rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- main

const romBg0 = readRom(spec.layers.bg.plane0), romBg1 = readRom(spec.layers.bg.plane1);
const romFg0 = readRom(spec.layers.fg.plane0), romFg1 = readRom(spec.layers.fg.plane1);
const promLow = readRom(spec.proms.low), promHigh = readRom(spec.proms.high);
const prom = Buffer.concat([promLow, promHigh]);

const bg = decodeLayer(romBg0, romBg1);
const fg = decodeLayer(romFg0, romFg1);
const rgbRaw = computeResNetAll(prom);
const pensNative = [];
for (let i = 0; i < 256; i++) {
  pensNative.push(rgbRaw[bitswapNative(i)]);
}
const pens = normalizeRange(pensNative);
const palette = pens.map(hex);

const files = {};
[spec.layers.bg.plane0, spec.layers.bg.plane1, spec.layers.fg.plane0, spec.layers.fg.plane1, spec.proms.low, spec.proms.high].forEach((f) => {
  files[f] = sha1(readRom(f));
});

const out = {
  format: {
    tile: '64 chars 0-3, row-major, player orientation (ROT90 applied), index = y*8+x',
    palette: 'index = colorCode*4 + pixel; colorCode = (code>>5) | (fg ? 8 : 0) | (paletteBank<<4)',
    fgTransparentPixel: 0
  },
  bg, fg, palette,
  meta: {
    source: 'MAME set pleiads (Tehkan), tools/rom2tiles.mjs, spec '+path.basename(specFile),
    files,
    generated: new Date().toISOString(),
    paletteAudit: {
      resNetLevels: [0, 1, 2, 3].map((v) => resNet(v, PLEIADS_NET)),
      note: 'resNetLevels = compute_res_net(0..3) for the 2-bit channel; pensBeforeNormalize = after bitswap, before normalize_range',
      pensBeforeNormalize: pensNative.map(hex)
    }
  }
};

const outFile = path.resolve(specDir, spec.output);
fs.writeFileSync(outFile, JSON.stringify(out, null, 0).replace(/"bg":\[/, '\n"bg":[\n').replace(/\],"fg":\[/, '\n],\n"fg":[\n').replace(/\],"palette":/, '\n],\n"palette":').replace(/,"meta":/, ',\n"meta":')+'\n');
console.log('written '+outFile+' ('+fs.statSync(outFile).size+' bytes)');

if (preview) {
  const paletteBank = 0;
  const ascii = (layer, tiles, code) => {
    const t = tiles[code];
    console.log(layer+' tile 0x'+code.toString(16).padStart(2, '0'));
    for (let y = 0; y < 8; y++) {
      console.log('  '+t.substr(y*8, 8).replace(/0/g, '.').replace(/1/g, '+').replace(/2/g, '*').replace(/3/g, '#'));
    }
  };
  Object.keys(spec.previewTiles || {}).forEach((layer) => {
    spec.previewTiles[layer].forEach((c) => ascii(layer, out[layer], num(c)));
  });

  // sheet: fg set on top (16x16 tiles), bg set below, black background, 4x scale
  const sheetW = 16*8, sheetH = 2*16*8+8;
  const rgba = new Uint8ClampedArray(sheetW*sheetH*4);
  for (let i = 3; i < rgba.length; i += 4) {
    rgba[i] = 255;
  }
  const drawSet = (tiles, isFg, oy) => {
    for (let code = 0; code < 256; code++) {
      const colorCode = (code >> 5) | (isFg ? 8 : 0) | (paletteBank << 4);
      const t = tiles[code];
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const pix = t.charCodeAt(y*8+x)-48;
          const [r, g, b] = pens[colorCode*4+pix];
          const di = ((oy+(code >> 4)*8+y)*sheetW+(code & 15)*8+x)*4;
          rgba[di] = r; rgba[di+1] = g; rgba[di+2] = b;
        }
      }
    }
  };
  drawSet(fg, true, 0);
  drawSet(bg, false, 16*8+8);
  for (let x = 0; x < sheetW; x++) {   // separator
    const di = ((16*8+4)*sheetW+x)*4;
    rgba[di] = 128; rgba[di+1] = 128; rgba[di+2] = 128;
  }
  const pngFile = positional[1] || path.join(process.env.SCRATCHPAD || os.tmpdir(), 'pleiads-tiles.png');
  fs.writeFileSync(pngFile, encodePNG(sheetW, sheetH, rgba, 4));
  console.log('preview PNG: '+pngFile+' (top: fg 0x00-0xFF, bottom: bg 0x00-0xFF, 16 per row, palette bank '+paletteBank+')');
}
