#!/usr/bin/env node
/**
 * render-frame — runs app/gameWorker.js headless with an input script up to frame N
 * and renders the VRAM of that frame to a PNG (same renderer as the browser).
 * usage: node tools/render-frame.mjs <frame> <out.png> [--script sources/reference/input-round1.txt] [--scale 2]
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import { encodePNG } from './lib/png.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i+1] : def; };
const frame = parseInt(args[0]); const out = args[1];
const scriptFile = opt('--script', path.join(root, 'sources/reference/input-start.txt'));
const scale = parseInt(opt('--scale', '1'));
if (!frame || !out) { console.error('usage: render-frame.mjs <frame> <out.png> [--script f] [--scale n]'); process.exit(2); }

const tiles = JSON.parse(fs.readFileSync(path.join(root, 'data/tiles.json'), 'utf8'));
const tables = JSON.parse(fs.readFileSync(path.join(root, 'data/tables.json'), 'utf8'));
// app/tileMapRender.js is an ES module with a .js extension: import a temporary .mjs copy (as render-screen.mjs does)
const renderCopy = path.join(fs.mkdtempSync(path.join(process.env.SCRATCHPAD || os.tmpdir(), 'pleiades-')), 'tileMapRender.mjs');
fs.copyFileSync(path.join(root, 'app/tileMapRender.js'), renderCopy);
const { TileMapRender } = await import(renderCopy);
const inputScript = fs.readFileSync(scriptFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith(';'))
  .map((l) => { const [f, v] = l.split(/\s+/); return {frame: parseInt(f), in0: parseInt(v, 16)}; });

let last = null;
const sandbox = {postMessage: (m) => { if (m.id === 'frame') last = structuredClone(m); }, setTimeout: () => 0, clearTimeout: () => {}, performance, console};
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'app/gameWorker.js'), 'utf8'), sandbox, {filename: 'gameWorker.js'});
sandbox.onmessage({data: {id: 'init', initData: {headless: true, tables, inputScript}}});
while (!last || last.frame < frame) {
  sandbox.onmessage({data: {id: 'tick'}});
  if (last && last.stopped) break;
}
const rgba = TileMapRender.renderVramToRgba(tiles, last.page, last.paletteBank, last.scroll);
fs.writeFileSync(out, encodePNG(TileMapRender.SCREEN_WIDTH, TileMapRender.SCREEN_HEIGHT, rgba, scale));
console.log(`written ${out} (frame ${last.frame}, state ${last.state}, round ${last.round}, phase ${last.phase}, score ${last.score})`);
