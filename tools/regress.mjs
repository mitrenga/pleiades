#!/usr/bin/env node
/**
 * regress — runs app/gameWorker.js headless (Node) and compares it frame by frame with the
 * reference emulator tools/refemu (see tools/refemu/README.md).
 *
 * usage: node tools/regress.mjs [--frames N] [--script sources/reference/input-start.txt]
 *                               [--random SEED [--period P]] [--autopilot [--autopilot-until HEX43B8]]
 *                               [--save-script FILE] [--dump-at F1,F2,...] [--keep] [--verbose]
 *
 * PL-M5 reference scenarios (0 differences expected):
 *   node tools/regress.mjs --script sources/reference/input-round1.txt --frames 13000
 *     coin+start, round 1 complete (wave 1, mothership, picture, wave 2 + targets, bonus, planet, landing,
 *     landing bonus), round 2 up to phase 3 (deaths there without input).
 *   node tools/regress.mjs --script sources/reference/input-gameover.txt --frames 6000
 *     the same up to the start of phase 3, then no input: 3 deaths in phase 3, game over, attract (the worker
 *     stops at the attract counter 0x4E6 — the demo game is PL-M7).
 *   node tools/regress.mjs --script sources/reference/input-attract.txt --frames 1300 --dump-at 300,440,460,500,560,640,720,800,880,960,975,1000,1050,1100,1150,1200,1250
 *     no coin: the attract mode from the reset to the counter 0x4E6 (the boot of the remake, app/bootModel.js,
 *     plays 0x1B1-0x4AF of it). From the counter 0x1C0 the program runs on RAM/VRAM page 1 (state 0 switches
 *     to "player 2"), so the page 1 of every dump is compared as well.
 * The scripts were produced in parts: --autopilot --frames 7300 --save-script part1; --autopilot --script part1
 * --frames 9400 --save-script part2 (landing); --autopilot --script part2 --autopilot-until 13 --frames 12400
 * (--script + --autopilot replays the script and lets the autopilot continue after its last entry).
 *
 * Alignment: both runs start at the reset (frame 0) with the same input script (FRAME IN0_HEX
 * lines, the default is sources/reference/input-start.txt: coin at frames 10-14, 1P start at
 * 40-44). The reference samples the RAM at the start of VBLANK of frame n, i.e. after the
 * program processed the inputs of frame n-1; the worker's state after tick n-1 is compared with
 * the trace row n. With the default script state 1 starts at frame 48, phase 1 at frame 210,
 * the ship dies at frame 581 (no joystick input), the next life starts at 678, game over
 * (state 5) at 1927.
 *
 * --random SEED generates the input script instead: coin/start as input-start.txt, then from frame
 * 220 a new random joystick/fire combination every P frames (default 6, fire is edge triggered) —
 * an easy way to get kills, collisions, enemy shots hitting the ship.
 * --autopilot lets the worker play (aims at the lowest enemy, fires when aligned) and records the
 * inputs as a script; the reference then replays it — this reaches the end of wave 1 (L_2204,
 * roundComplete, phase 2 scroll) and is the way to verify the wave end.
 *
 * Compared every frame (refemu --watch): 43A4 43B8 43A5 43B9 43BA 439A 439B 43BB 43BC 43B2 439C 439D 4394 4395
 * 43C0-43C3 (ship), 43CC-43DF (enemy bullets/bombs), 4B70-4BAF (enemies / mothership slots), 4B50-4B5F
 * (script pointers), 4381-4383 (score), 4370-437F (explosion slots), 4BD0-4BDD (spawn/mothership state).
 * At the --dump-at frames and at the start of every phase and round (43B8 change, state 3 entered) the whole
 * page 0 is compared (FG 4000-433F, variables 4340-47FF, BG 4800-4B3F, 4B40-4BEA; 4BEB-4BFF is the CPU stack) plus the palette and
 * scroll registers. The reference files are generated into $SCRATCHPAD or a temp dir (--keep: tmp/regress).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes(name);
const frames = parseInt(opt('--frames', '820'));
let scriptFile = path.resolve(root, opt('--script', 'sources/reference/input-start.txt'));
const dumpAt = opt('--dump-at', '210,300,400,500,581,600,650,700,810').split(',').map((s) => parseInt(s)).filter((n) => n < frames);
const saveScript = opt('--save-script', null);   // write the (autopilot) input script here
const verbose = flag('--verbose');
const autopilot = flag('--autopilot');
const tmp = flag('--keep') ? path.join(root, 'tmp/regress') : (process.env.SCRATCHPAD || fs.mkdtempSync('/tmp/pl-regress-'));
fs.mkdirSync(tmp, {recursive: true});
const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');
const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

const WATCH = [];
const range = (a, b) => { for (let x = a; x <= b; x++) WATCH.push(x); };
[0x43A4, 0x43B8, 0x43A5, 0x43B9, 0x43BA, 0x439A, 0x439B].forEach((a) => WATCH.push(a));
[0x43BB, 0x43BC, 0x43B2, 0x439C, 0x439D, 0x4394, 0x4395].forEach((a) => WATCH.push(a));
range(0x43C0, 0x43C3); range(0x43CC, 0x43DF); range(0x4B70, 0x4BAF); range(0x4B50, 0x4B5F);
range(0x4381, 0x4383); range(0x4370, 0x437F); range(0x4BD0, 0x4BDD);

// ---------------------------------------------------------------- input script
const START_SCRIPT = [{frame: 10, in0: 0xF6}, {frame: 15, in0: 0xF7}, {frame: 40, in0: 0xF5}, {frame: 45, in0: 0xF7}];
let inputScript, autopilotFrom = 200;
if (opt('--random', null) !== null) {
  let seed = parseInt(opt('--random', '1')) >>> 0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) & 0xFFFF; };
  const period = parseInt(opt('--period', '6'));
  inputScript = START_SCRIPT.slice();
  for (let f = 220; f < frames; f += period) {
    const r = rnd();
    let v = 0xF7;
    if (r & 1) v &= ~0x10;                       // fire
    const dir = (r >> 1) % 3;
    if (dir === 1) v &= ~0x20; else if (dir === 2) v &= ~0x40;
    inputScript.push({frame: f, in0: v});
  }
  scriptFile = path.join(tmp, 'script-random.txt');
} else if (autopilot && opt('--script', null) === null) {
  inputScript = START_SCRIPT.slice();
  scriptFile = path.join(tmp, 'script-autopilot.txt');
} else {
  inputScript = fs.readFileSync(scriptFile, 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => { const [f, v] = l.split(/\s+/); return {frame: parseInt(f), in0: parseInt(v, 16)}; });
  if (autopilot) {   // --script + --autopilot: replay the script, the autopilot takes over after its last entry
    autopilotFrom = inputScript[inputScript.length - 1].frame + 1;
    scriptFile = path.join(tmp, 'script-autopilot.txt');
  }
}

// ---------------------------------------------------------------- the worker run
const tables = JSON.parse(fs.readFileSync(path.join(root, 'data/tables.json'), 'utf8'));
const messages = [];
const sandbox = {postMessage: (m) => messages.push(structuredClone(m)), setTimeout: () => 0, clearTimeout: () => {}, console, performance};
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'app/gameWorker.js'), 'utf8'), sandbox, {filename: 'gameWorker.js'});
sandbox.onmessage({data: {id: 'init', initData: {headless: true, tables, inputScript, stopAtRoundEnd: false}}});
const pl = sandbox.__pl;
const page = pl.page;

// ---------------------------------------------------------------- autopilot
// The autopilot plays through the whole game: waves (phases 1/5: aim at the lowest enemy, fire when
// aligned, dodge shots and diving enemies), the mothership (phase 3: stand under a ship tile whose hit mask
// 3B60h/3B90h accepts the shot's X&7 and fire, dodge bombs), the landing (phase 7: no input unless the
// lookahead sees the terrain). Every decision is verified by simulating the greedy policy H frames ahead
// on a snapshot; when it dies, the alternatives (hold left / right / nothing for a while, then greedy) are
// tried and the one surviving longest (or killing most) wins.
const autopilotUntil = opt('--autopilot-until', null) === null ? null : parseInt(opt('--autopilot-until'), 16);
let lastIn0 = 0xF7;
const inGame = () => page[0x3A2] !== 0 && page[0x3A4] === 3;
const phase = () => page[0x3B8] & 0x0F;

function dodgeThreat(sx, enemies) {
  let threat = 0;
  for (let i = 0; i < 5; i++) {
    const rec = 0x3CC + 4*i;
    if ((page[rec] & 8) && page[rec+3] > 0x98 && page[rec+3] < 0xE8) {
      const dx = page[rec+2] - (sx + 4);
      if (Math.abs(dx) < 14) threat = dx >= 0 ? -1 : 1;
    }
  }
  if (enemies) {
    for (let i = 0; i < 8; i++) {
      const rec = 0x0B70 + 4*i;
      if ((page[rec] & 8) && page[rec+3] > 0xA8) {
        const dx = page[rec+2] + 8 - (sx + 4);
        if (Math.abs(dx) < 24) threat = dx >= 0 ? -1 : 1;
      }
    }
  }
  return threat;
}

function waveIn0() {
  let target = -1, ty = -1;
  for (let i = 0; i < 8; i++) {
    const rec = 0x0B70 + 4*i;
    if ((page[rec] & 8) && page[rec+3] > ty && page[rec+3] < 0xD0) {
      ty = page[rec+3];
      target = page[rec+2];
    }
  }
  let v = 0xF7;
  const sx = page[0x3C2];
  const threat = dodgeThreat(sx, true);
  if (threat) {
    if (threat > 0 && sx < 0xB8) v &= ~0x20; else if (sx > 0x10) v &= ~0x40; else v &= ~0x20;
    if (!(page[0x3C4] & 8) && (lastIn0 & 0x10)) v &= ~0x10;
  } else if (target >= 0) {
    const dx = target - sx;
    if (dx > 2) v &= ~0x20; else if (dx < -2) v &= ~0x40;
    const bulletFree = !(page[0x3C4] & 8);
    if (Math.abs(dx) <= 6 && bulletFree && (lastIn0 & 0x10)) {
      v &= ~0x10;
    }
  }
  return v;
}

// mothership: BG tiles >= 90h; per column the lowest one on the screen (row + 4BD2) decides the hit mask
function mothershipIn0() {
  const sx = page[0x3C2], row = page[0xBD2];
  let best = -1, bestD = 999;
  const lowest = new Map();   // column X>>3 -> {screenRow, tile}
  for (let a = 0x800; a < 0xB40; a++) {
    const t = page[a];
    if (t < 0x90) continue;
    const col = (0xB20 - (a & 0x3E0)) >> 5;
    const sr = ((a & 0x1F) + row) & 0x1F;
    const cur = lowest.get(col);
    if (!cur || sr > cur.sr) lowest.set(col, {sr, tile: t});
  }
  for (const [col, {tile}] of lowest) {
    const b = tile - 0x90;
    let mask = b < 0x40 ? pl.rd(0x3B60 + b) : 0;
    if (b >= 0x10) mask |= pl.rd(0x3B90 + b);
    for (let k = 0; k < 8; k++) {
      if (!(mask & (1 << k))) continue;
      const x = col*8 + k - 4;
      if (x < 8 || x > 0xC0) continue;
      const d = Math.abs(x - sx);
      if (d < bestD) { bestD = d; best = x; }
    }
  }
  let v = 0xF7;
  const threat = dodgeThreat(sx, false);
  if (threat) {
    if (threat > 0 && sx < 0xB8) v &= ~0x20; else if (sx > 0x10) v &= ~0x40; else v &= ~0x20;
  } else if (best >= 0) {
    const dx = best - sx;
    if (dx > 0) v &= ~0x20; else if (dx < 0) v &= ~0x40;
  }
  if (!(page[0x3C4] & 8) && (lastIn0 & 0x10) && (best < 0 || Math.abs(best - sx) <= 1)) v &= ~0x10;
  return v;
}

// landing: the terrain (RLE rows 1C20h..) is a funnel of tiles 78h-7Bh narrowing to the two middle
// columns (X>>3 = 12, 13) just above the ground; the ship (2 columns wide) must be at X 60h-67h there.
// Steer to the funnel centre with the inertia in mind (439C = velocity, +1/-1 per frame while pressed).
function landingIn0() {
  const x = page[0x3C2], v = page[0x39C] << 24 >> 24;
  const dx = 0x63 - x;
  if (Math.abs(dx) <= 1 && Math.abs(v) <= 2) return 0xF7;
  if (dx > 0) return v < Math.min(0x40, dx * 3) ? (0xF7 & ~0x20) : (v > dx * 3 + 8 ? (0xF7 & ~0x40) : 0xF7);
  return v > -Math.min(0x40, -dx * 3) ? (0xF7 & ~0x40) : (v < dx * 3 - 8 ? (0xF7 & ~0x20) : 0xF7);
}

function greedyIn0() {
  if (!inGame()) return 0xF7;
  let v;
  switch (phase()) {
    case 1: case 5: v = waveIn0(); break;
    case 3: v = mothershipIn0(); break;
    case 7: v = landingIn0(); break;
    default: v = 0xF7;
  }
  lastIn0 = v;
  return v;
}

function simulate(firstIn0, holdFrames, horizon) {
  const snap = pl.snapshot();
  const savedScript = inputScript.slice(), savedLast = lastIn0;
  let deathAt = -1;
  const left0 = page[0x3BA], hp0 = page[0x3BB], scroll0 = page[0x3B9], ph0 = phase();
  for (let k = 0; k < horizon; k++) {
    const v = (firstIn0 !== null && k < holdFrames) ? firstIn0 : greedyIn0();
    inputScript.push({frame: pl.frame(), in0: v});
    pl.setScript(inputScript);
    pl.tick();
    if (page[0x3A4] === 4) { deathAt = k; break; }
    if (page[0x3A4] === 7 || phase() !== ph0) break;   // phase done: fine
  }
  // progress: kills (waves), damage (mothership), descent (landing)
  let progress = 0;
  if (ph0 === 3) progress = (hp0 - page[0x3BB]) * 4;
  else if (ph0 === 7) progress = (scroll0 - page[0x3B9]) >> 3;
  else progress = left0 - page[0x3BA];
  pl.restore(snap);
  inputScript = savedScript;
  pl.setScript(inputScript);
  lastIn0 = savedLast;
  return {deathAt, progress};
}

let holdUntil = -1, holdValue = 0xF7;   // an alternative chosen by the lookahead is held for N frames
function autopilotDecide(f) {
  if (f < holdUntil) return holdValue === null ? greedyIn0() : holdValue;
  const ph = phase();
  const landing = ph === 7;
  const horizon = landing ? 300 : 48;
  const greedy = greedyIn0();
  const base = simulate(greedy, 1, horizon);
  if (base.deathAt < 0) {
    lastIn0 = greedy;
    if (landing) { holdUntil = f + 4; holdValue = null; }   // greedy again for 4 frames
    return greedy;
  }
  let best = greedy, bestScore = base.deathAt, bestHold = 1;
  const holds = landing ? [24, 64] : [12];
  for (const hold of holds) {
    for (const alt of [0xF7 & ~0x40, 0xF7 & ~0x20, 0xF7, 0xE7, 0xF7 & ~0x50, 0xF7 & ~0x30]) {
      const r = simulate(alt, hold, horizon);
      const score = r.deathAt < 0 ? 1000 + r.progress : r.deathAt;
      if (score > bestScore) { bestScore = score; best = alt; bestHold = hold; }
    }
  }
  lastIn0 = best;
  if (landing) { holdUntil = f + Math.min(bestHold, 16); holdValue = best; }
  if (process.env.APDBG && f >= +process.env.APDBG) console.log('ap', f, 'x', hex2(page[0x3C2]), 'greedy', hex2(greedy), 'dies', base.deathAt, 'best', hex2(best), bestHold, bestScore);
  return best;
}

const workerWatch = [];      // per frame: the watched bytes before tick f (= trace row f)
const workerDumps = new Map();
const stateLog = [];
let lastState = -1, lastStage = -1, stoppedAt = -1;
for (let f = 0; f < frames; f++) {
  if (autopilot && f >= autopilotFrom && (autopilotUntil === null || page[0x3B8] < autopilotUntil)) {
    const v = inGame() && [1, 3, 5, 7].includes(phase()) ? autopilotDecide(f) : 0xF7;
    if (v !== inputScript[inputScript.length - 1].in0) {
      inputScript.push({frame: f, in0: v});
      pl.setScript(inputScript);
    }
  }
  // a dump at the start of every phase / round (43B8 changed or the game state (re)entered 3)
  if (page[0x3A2] && (page[0x3B8] !== lastStage || (page[0x3A4] === 3 && lastState !== 3)) && !dumpAt.includes(f)) {
    dumpAt.push(f);
  }
  lastStage = page[0x3B8];
  workerWatch.push(Uint8Array.from(WATCH, (a) => page[a - 0x4000]));
  if (page[0x3A4] !== lastState) {
    lastState = page[0x3A4];
    stateLog.push(`${f}:${lastState}/${hex2(page[0x3B8])}`);
  }
  if (dumpAt.includes(f)) {
    workerDumps.set(f, {page: page.slice(0), page1: pl.pages[1].slice(0), regs: pl.regs()});
  }
  pl.tick();
  if (pl.stopped()) {
    stoppedAt = pl.frame();
    console.log(`worker stopped at frame ${stoppedAt}: ${pl.stopped()}`);
    break;
  }
}
if (scriptFile.startsWith(tmp) || saveScript) {
  const text = '# generated by tools/regress.mjs' + (autopilot ? ' --autopilot' + (autopilotUntil !== null ? ' --autopilot-until ' + hex2(autopilotUntil) : '') : '') + '\n' +
    inputScript.map((e) => `${e.frame} ${hex2(e.in0)}`).join('\n') + '\n';
  fs.writeFileSync(scriptFile, text);
  if (saveScript) fs.writeFileSync(path.resolve(root, saveScript), text);
}
const roundComplete = messages.some((m) => m.id === 'roundComplete');

// ---------------------------------------------------------------- reference
const refemu = path.join(root, 'tools/refemu/refemu');
if (!fs.existsSync(refemu)) {
  execFileSync(path.join(root, 'tools/refemu/build.sh'), {stdio: 'inherit'});
}
const refFrames = stoppedAt >= 0 ? Math.min(frames, stoppedAt) : frames;
// refemu accepts at most 64 --watch addresses: one run per chunk of 64 (dumps with the first)
const traceRows = new Map();   // frame -> Map(addr -> value)
for (let chunk = 0; chunk * 64 < WATCH.length; chunk++) {
  const watch = WATCH.slice(chunk * 64, chunk * 64 + 64);
  const traceFile = path.join(tmp, `trace-${chunk}.tsv`);
  const refArgs = ['--rom', 'sources/rom/pleiads', '--frames', String(refFrames + 1), '--script', scriptFile,
    '--trace', traceFile, '--watch', watch.map(hex4).join(',')];
  if (chunk === 0) {
    dumpAt.filter((f) => f < refFrames).forEach((f) => refArgs.push('--dump-at', `${f}:${path.join(tmp, `dump-${f}.bin`)}`));
  }
  execFileSync(refemu, refArgs, {cwd: root, stdio: verbose ? 'inherit' : 'ignore'});
  const rows = fs.readFileSync(traceFile, 'utf8').trim().split('\n');
  const head = rows.shift().split('\t');
  rows.forEach((line) => {
    const f = line.split('\t');
    const frame = +f[0];
    if (!traceRows.has(frame)) {
      traceRows.set(frame, new Map());
    }
    const m = traceRows.get(frame);
    for (let i = 3; i < head.length; i++) {
      m.set(parseInt(head[i], 16), parseInt(f[i], 16));
    }
  });
}

// ---------------------------------------------------------------- compare
let mismatchFrames = 0, firstMismatch = -1, shown = 0, pageMismatches = 0;
for (const [frame, m] of traceRows) {
  const w = workerWatch[frame];
  if (!w) {
    continue;
  }
  const diffs = [];
  WATCH.forEach((addr, i) => {
    const r = m.get(addr);
    if (r !== w[i]) {
      diffs.push(`${hex4(addr)} ref=${hex2(r)} worker=${hex2(w[i])}`);
    }
  });
  if (diffs.length) {
    mismatchFrames++;
    if (firstMismatch < 0) {
      firstMismatch = frame;
    }
    if (shown < 20 || verbose) {
      console.log(`frame ${frame}: ${diffs.length} byte(s) differ: ` + diffs.slice(0, 12).join(', ') + (diffs.length > 12 ? ' ...' : ''));
      shown++;
    }
  }
}
for (const [f, w] of workerDumps) {
  const file = path.join(tmp, `dump-${f}.bin`);
  if (!fs.existsSync(file)) {
    continue;
  }
  const dump = fs.readFileSync(file);
  const regions = [['FG 4000-433F', 0, 0x340], ['vars 4340-47FF', 0x340, 0x800], ['BG 4800-4B3F', 0x800, 0xB40], ['4B40-4BEA', 0xB40, 0xBEB]]   // 4BEB-4BFF = CPU stack
  const parts = [];
  // both pages: page 1 carries the attract demo (and player 2 of a cocktail game)
  [['', dump.subarray(8, 8 + 4096), w.page], ['page 1 ', dump.subarray(8 + 4096, 8 + 8192), w.page1]].forEach(([label, refPage, wPage]) => {
    regions.forEach(([name, a, b]) => {
      let n = 0, first = -1;
      for (let i = a; i < b; i++) {
        if (refPage[i] !== wPage[i]) {
          n++;
          if (first < 0) first = i;
        }
      }
      if (n) {
        parts.push(`${label}${name}: ${n} bytes (first ${hex4(0x4000 + first)} ref=${hex2(refPage[first])} worker=${hex2(wPage[first])})`);
        pageMismatches += n;
      }
    });
  });
  if (dump[8200] !== w.regs.videoreg) parts.push(`5000h ref=${hex2(dump[8200])} worker=${hex2(w.regs.videoreg)}`);
  if (dump[8201] !== w.regs.scroll) parts.push(`scroll ref=${hex2(dump[8201])} worker=${hex2(w.regs.scroll)}`);
  console.log(`dump ${f}: ` + (parts.length ? parts.join('; ') : 'pages 0 and 1, palette and scroll identical'));
}

console.log(`state changes (frame:43A4/43B8): ${stateLog.join(' ')}` + (roundComplete ? ' — roundComplete posted' : ''));
console.log(`checked ${refFrames} frames, ${WATCH.length} watched bytes: ${mismatchFrames} frame(s) with differences` +
  (firstMismatch >= 0 ? ` (first at frame ${firstMismatch})` : '') + `, ${pageMismatches} differing page bytes in ${workerDumps.size} dumps`);
if (!flag('--keep') && !process.env.SCRATCHPAD) {
  fs.rmSync(tmp, {recursive: true, force: true});
}
process.exit(mismatchFrames || pageMismatches ? 1 : 0);
