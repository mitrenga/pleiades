#!/usr/bin/env node
/**
 * render-screen — headless render of a screens.json screen through
 * app/tileMapRender.js renderVramToRgba() into a PNG (regression / visual check).
 *
 * usage: node tools/render-screen.mjs data/screens.json phase1Start out.png [--scale N] [--tiles data/tiles.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import {encodePNG} from './lib/png.mjs';
import os from 'node:os';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// app/*.js are ES modules without a package.json "type"; Node would treat them as
// CommonJS, so the renderer is imported through a temporary .mjs copy.
const renderCopy = path.join(fs.mkdtempSync(path.join(process.env.SCRATCHPAD || os.tmpdir(), 'pleiades-')), 'tileMapRender.mjs');
fs.copyFileSync(path.join(root, 'app/tileMapRender.js'), renderCopy);
const {TileMapRender} = await import(renderCopy);
const {SCREEN_WIDTH, SCREEN_HEIGHT} = TileMapRender;

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i+1] : def;
};
const positional = args.filter((a, i) => !a.startsWith('--') && (i == 0 || !args[i-1].startsWith('--')));
if (positional.length < 3) {
  console.error('usage: render-screen <screens.json> <screenName> <out.png> [--scale N] [--tiles tiles.json]');
  process.exit(1);
}
const screens = JSON.parse(fs.readFileSync(path.resolve(positional[0]), 'utf8'));
const screen = screens[positional[1]];
if (!screen) {
  console.error('screen not found: '+positional[1]);
  process.exit(1);
}
const tiles = JSON.parse(fs.readFileSync(path.resolve(opt('--tiles', path.join(root, 'data/tiles.json'))), 'utf8'));
const rgba = TileMapRender.renderVramToRgba(tiles, TileMapRender.hexToBytes(screen.page), screen.paletteBank, screen.scroll);
fs.writeFileSync(path.resolve(positional[2]), encodePNG(SCREEN_WIDTH, SCREEN_HEIGHT, rgba, parseInt(opt('--scale', '3'), 10)));
console.log('written '+positional[2]+' ('+positional[1]+', bank '+screen.paletteBank+', scroll '+screen.scroll+')');
