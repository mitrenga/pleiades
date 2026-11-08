#!/usr/bin/env node
/**
 * render-sound — headless check of the PL-M6 sound board: runs app/gameWorker.js in Node (vm) with an
 * input script, feeds the latch writes of every frame (frame.latches) into app/pleiadsSoundProcessor.js
 * (loaded with stubs for the AudioWorklet globals) and writes the result as a 16-bit mono WAV.
 * Prints the latch statistics (distinct values, TMS notes, SOD shots) and the RMS per second; fails on
 * NaN / clipping.
 *
 * usage: node tools/render-sound.mjs [--script sources/reference/input-round1.txt] [--from F] [--frames N]
 *                                    [--out FILE.wav] [--rate 44100]
 *        node tools/render-sound.mjs --demo [--out FILE.wav]      the SOUNDS volume sample (latch script)
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes(name);
const rate = parseInt(opt('--rate', '44100'));
const scratch = process.env.SCRATCHPAD || fs.mkdtempSync('/tmp/pl-sound-');
const outFile = opt('--out', path.join(scratch, flag('--demo') ? 'demo.wav' : 'game.wav'));
const FRAME_RATE = 61.035;

// ---- the processor with AudioWorklet stubs
const procSrc = fs.readFileSync(path.join(root, 'app/pleiadsSoundProcessor.js'), 'utf8');
let ProcessorClass = null;
const procSandbox = {
  sampleRate: rate,
  console,
  AudioWorkletProcessor: class { constructor() { this.port = {onmessage: null, postMessage() {}}; } },
  registerProcessor: (name, cls) => { ProcessorClass = cls; }
};
vm.createContext(procSandbox);
vm.runInContext(procSrc.substring(procSrc.indexOf('// begin code')), procSandbox, {filename: 'pleiadsSoundProcessor.js'});
const proc = new ProcessorClass();
const post = (m) => proc.port.onmessage({data: m});

// ---- the latch sequence: from the worker or the demo script
let latchFrames = [];   // [{a, b, sod}] per frame
if (flag('--demo')) {
  const src = fs.readFileSync(path.join(root, 'app/soundEffects.js'), 'utf8');
  const code = src.substring(src.indexOf('// begin code'));
  const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  latchFrames = mod.createShotDemoScript().script;
  console.log(`demo script: ${latchFrames.length} frames`);
} else {
  const scriptFile = path.resolve(root, opt('--script', 'sources/reference/input-round1.txt'));
  const from = parseInt(opt('--from', '150'));
  const frames = parseInt(opt('--frames', '2400'));
  const inputScript = fs.readFileSync(scriptFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => { const [f, v] = l.split(/\s+/); return {frame: parseInt(f), in0: parseInt(v, 16)}; });
  const workerSrc = fs.readFileSync(path.join(root, 'app/gameWorker.js'), 'utf8');
  const messages = [];
  const sandbox = {postMessage: (m) => messages.push(structuredClone(m)), setTimeout: () => 0, clearTimeout: () => {}, console, performance};
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(workerSrc, sandbox, {filename: 'gameWorker.js'});
  const tables = JSON.parse(fs.readFileSync(path.join(root, 'data/tables.json'), 'utf8'));
  sandbox.onmessage({data: {id: 'init', initData: {headless: true, dip: {lives: 3, bonus: 3}, tables, hiScore: 0, inputScript}}});
  for (let i = 0; i < from + frames; i++) {
    const before = messages.length;
    sandbox.onmessage({data: {id: 'tick'}});
    const fr = messages.slice(before).find((m) => m.id === 'frame');
    if (!fr) { console.log(`worker stopped at frame ${i}`); break; }
    if (i >= from) latchFrames.push(fr.latches);
  }
  console.log(`worker frames ${from}..${from + latchFrames.length - 1} from ${path.relative(root, scriptFile)}`);
}

// ---- statistics of the latches
const distinctA = new Set(), distinctB = new Set();
let shots = 0, notes = 0, prevB = -1, prevSod = 0;
latchFrames.forEach((l) => {
  distinctA.add(l.a); distinctB.add(l.b);
  if (l.sod && !prevSod) shots++;
  if (l.b !== prevB && (l.b & 0x0F) <= 12) notes++;
  prevB = l.b; prevSod = l.sod;
});
const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0');
console.log(`latch A values: ${[...distinctA].sort((x, y) => x - y).map(hex).join(' ')}`);
console.log(`latch B values: ${[...distinctB].sort((x, y) => x - y).map(hex).join(' ')}`);
console.log(`SOD shots: ${shots}, TMS note triggers: ${notes}`);

// ---- render
const samplesPerFrame = rate / FRAME_RATE;
const total = Math.ceil((latchFrames.length + 30) * samplesPerFrame);
const pcm = new Float32Array(total);
let frame = 0, acc = 0, pos = 0;
const quantum = 128;
const buf = [[new Float32Array(quantum)]];
let nan = 0, clip = 0, peak = 0;
while (pos < total) {
  while (acc <= pos && frame < latchFrames.length) {
    post({id: 'latches', ...latchFrames[frame++]});
    acc += samplesPerFrame;
  }
  if (frame >= latchFrames.length && acc <= pos) acc = Infinity;
  proc.process([], buf, {});
  const n = Math.min(quantum, total - pos);
  for (let i = 0; i < n; i++) {
    const v = buf[0][0][i];
    if (Number.isNaN(v)) nan++;
    else { if (Math.abs(v) > 1) clip++; peak = Math.max(peak, Math.abs(v)); }
    pcm[pos + i] = v;
  }
  pos += n;
}
// RMS per second
const perSec = [];
for (let s = 0; s * rate < total; s++) {
  let e = 0, n = 0;
  for (let i = s * rate; i < Math.min(total, (s + 1) * rate); i++) { e += pcm[i] * pcm[i]; n++; }
  perSec.push(Math.sqrt(e / n));
}
console.log(`rendered ${(total / rate).toFixed(2)} s, peak ${peak.toFixed(3)}, NaN ${nan}, clipped ${clip}`);
console.log('RMS/s: ' + perSec.map((v) => v.toFixed(3)).join(' '));

// ---- WAV
const wav = Buffer.alloc(44 + total * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + total * 2, 4); wav.write('WAVE', 8);
wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(total * 2, 40);
for (let i = 0; i < total; i++) wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767))), 44 + i * 2);
fs.writeFileSync(outFile, wav);
console.log(`wrote ${outFile}`);
if (nan > 0 || clip > 0) { console.log('FAIL'); process.exit(1); }
console.log('OK');
