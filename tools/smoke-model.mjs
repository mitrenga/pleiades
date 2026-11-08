#!/usr/bin/env node
/**
 * smoke-model — headless (Node vm) check of the worker side of the PL-M4
 * model/worker protocol (app/WORKER-PROTOCOL.md): sends 'init' (headless) and
 * N 'tick' messages, validates every 'frame' message the way MainModel consumes
 * it (page Uint8Array 4096, paletteBank 0-3, scroll 0-255, numeric score /
 * hiScore / lives, known state, sounds array) and exercises 'controls', 'pause',
 * 'continue' and 'reset'. Runs against app/gameWorker.js when it is the real
 * worker (data/tables.json exists and the file is not the PL-M2 stub), otherwise
 * against app/mockWorker.js; --mock / --real force the choice.
 *
 * MainModel itself needs a DOM (canvas in TileMapEntity), so the model's drawing
 * path is verified in the browser (see the PL-M4 report), not here.
 *
 * usage: node tools/smoke-model.mjs [ticks=600] [--mock|--real]
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const ticks = parseInt(args.find((a) => /^\d+$/.test(a)) || '600');
const readJSON = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));

const workerSrc = fs.readFileSync(path.join(root, 'app/gameWorker.js'), 'utf8');
const hasTables = fs.existsSync(path.join(root, 'data/tables.json'));
const isStub = /PL-M2 stub/.test(workerSrc) || !/postMessage\(/.test(workerSrc);
let useMock = !hasTables || isStub;
if (args.includes('--mock')) useMock = true;
if (args.includes('--real')) useMock = false;

const messages = [];
let worker;
if (useMock) {
  // the module has no imports below '// begin code'; load that part as an ES module
  const src = fs.readFileSync(path.join(root, 'app/mockWorker.js'), 'utf8');
  const code = src.substring(src.indexOf('// begin code'));
  const {MockWorker} = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  worker = new MockWorker(readJSON('data/screens.json'));
  worker.onmessage = (e) => messages.push(e.data);
} else {
  const sandbox = {postMessage: (m) => messages.push(structuredClone(m)), setTimeout: () => 0, clearTimeout: () => {}, console, performance};
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(workerSrc, sandbox, {filename: 'gameWorker.js'});
  worker = {postMessage: (m) => sandbox.onmessage({data: m})};
}
console.log(`worker: ${useMock ? 'app/mockWorker.js (mock)' : 'app/gameWorker.js (real)'}, ticks: ${ticks}`);

const tables = hasTables ? readJSON('data/tables.json') : null;
worker.postMessage({id: 'init', initData: {headless: true, dip: {lives: 3, bonus: 3}, tables, hiScore: 0, attract: false}});

const STATES = ['intro', 'wave', 'flight', 'mothership', 'landing', 'bonus', 'dying', 'gameOver', 'roundEnd'];
let errors = 0, frames = 0, sounds = 0, gameOver = 0, roundComplete = 0;
const states = new Set();
const fail = (msg) => { errors++; if (errors <= 15) console.log('FAIL: ' + msg); };

function checkFrame(f, i) {
  if (!ArrayBuffer.isView(f.page) || f.page.BYTES_PER_ELEMENT !== 1 || f.page.length !== 0x1000) fail(`tick ${i}: page is not Uint8Array(4096)`);
  if (!Number.isInteger(f.paletteBank) || f.paletteBank < 0 || f.paletteBank > 3) fail(`tick ${i}: paletteBank ${f.paletteBank}`);
  if (!Number.isInteger(f.scroll) || f.scroll < 0 || f.scroll > 255) fail(`tick ${i}: scroll ${f.scroll}`);
  for (const k of ['score', 'hiScore', 'lives', 'frame']) {
    if (typeof f[k] !== 'number') fail(`tick ${i}: ${k} is ${typeof f[k]}`);
  }
  if (!STATES.includes(f.state)) fail(`tick ${i}: unknown state '${f.state}'`);
  if (!Array.isArray(f.sounds)) fail(`tick ${i}: sounds is not an array`);
  else sounds += f.sounds.length;
  states.add(f.state);
}

// MainModel.setControl sends the whole state; tap fire every 30 ticks, hold right for a while
let controls = {left: false, right: false, fire: false};
const send = (c) => { controls = {...controls, ...c}; worker.postMessage({id: 'controls', ...controls}); };

for (let i = 0; i < ticks; i++) {
  if (i === 100) send({right: true});
  if (i === 200) send({right: false, left: true});
  if (i === 260) send({left: false});
  if (i % 30 === 0) send({fire: true});
  if (i % 30 === 5) send({fire: false});
  if (i === 300) { worker.postMessage({id: 'pause'}); worker.postMessage({id: 'continue'}); }
  const before = messages.length;
  worker.postMessage({id: 'tick'});
  const news = messages.slice(before);
  const frame = news.filter((m) => m.id === 'frame');
  if (frame.length !== 1) fail(`tick ${i}: expected exactly 1 frame message, got ${frame.length}`);
  frame.forEach((f) => { frames++; checkFrame(f, i); });
  news.forEach((m) => {
    if (m.id === 'gameOver') { gameOver++; if (typeof m.score !== 'number') fail(`gameOver without numeric score`); }
    else if (m.id === 'roundComplete') roundComplete++;
    else if (m.id !== 'frame') fail(`tick ${i}: unknown message id '${m.id}'`);
  });
}
// VRAM must not stay frozen (mock: scroll/ship; real: the game runs)
const first = messages.find((m) => m.id === 'frame'), last = [...messages].reverse().find((m) => m.id === 'frame');
const changed = first && last && (first.scroll !== last.scroll || first.page.some((b, i) => b !== last.page[i]));
if (!changed) fail('VRAM/scroll did not change over the run');

worker.postMessage({id: 'reset'});
const afterReset = messages.length;
worker.postMessage({id: 'tick'});
if (messages.length !== afterReset) fail('worker still sends frames after reset');

console.log(`frames ${frames}, sound events ${sounds}, states ${[...states].join(',')}, gameOver ${gameOver}, roundComplete ${roundComplete}, last score ${last ? last.score : '-'}, VRAM changed: ${!!changed}`);
console.log(errors ? `${errors} error(s)` : 'OK');
process.exit(errors ? 1 : 0);
