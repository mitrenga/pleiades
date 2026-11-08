// begin code

/**
 * Pleiads sound data (PL-M6).
 *
 * Effects are not scores: the board is emulated in app/pleiadsSoundProcessor.js
 * from the latches the worker writes every frame. This module provides
 *   - latch scripts for the SOUNDS volume dialog sample (createShotDemoScript):
 *     the shot (SOD), a hit tone (sound_hit_a, 3A2Ah) and a TMS "ping"
 *     (sound_ping, 3B1Bh), composed with the same formulas as the program;
 *   - the two melodies of the Epson 7910E multi-melody IC as scores for the
 *     svision AudioOscillatorHandler ('music' bus). The Epson datasheet
 *     (sources/docs/SVM7910) lists the 7910E standard melodies: tune 1 "Two
 *     Minuets" (J. S. Bach), tune 2 "Dark Eyebrows" (Russian folk song) — both
 *     public domain, own transcriptions. The ROM is undumped (MAME NO_DUMP),
 *     real-board recordings exist only as videos, so the melodies are
 *     synthesized (decision 2026-08-30, GAME-DESIGN chap. 7). On the Centuri
 *     CPU board (schematics p. 18, IC 44) the chip is driven only by MT (start)
 *     and MSL (tune select) from latch B bits 6-7 through LS14 inverters, SEL1/2
 *     open; see AudioManager.MELODIES. Tuning is the user's A/B (PL-M8).
 */

// ---------------------------------------------------------------- latch scripts (sounds bus)

var SILENT = {a: 0x0F, b: 0x0F, sod: 0};

function frames(n, a, b, sod) {
  var list = [];
  for (var i = 0; i < n; i++) {
    list.push({a: a, b: b, sod: sod});
  }
  return list;
} // frames

/** sound_hit_a [3A2A]: 4369h = FFh -> the tone 1 divider for the following frames */
function hitToneA() {
  var list = [];
  var c = 0xFF;
  while (c !== 0) {
    c = ((c & 0x3F) - 1) & 0xFF;
    var nibble = (((c >> 3) & 7) + ((c >> 1) & 3)) & 0x0F;
    list.push({a: nibble, b: 0x0F, sod: 0});
  }
  return list;
} // hitToneA

/** sound_ping [3B1B]: 4362h = 08h -> TMS note from bits 2-3 for 8 frames */
function pingTone() {
  var list = [];
  var c = 8;
  while (c !== 0) {
    c = (c - 1) & 0x3F;
    list.push({a: 0x0F, b: ((c << 1) | (c >> 7)) & 0x0C, sod: 0});
  }
  return list;
} // pingTone

/** SOUNDS volume sample: shot, hit tone, ping, ~2.2 s */
export function createShotDemoScript() {
  var script = [];
  script = script.concat(frames(2, 0x0F, 0x0F, 1));      // 4361h = 30h -> SOD high for 2 frames
  script = script.concat(frames(40, 0x0F, 0x0F, 0));
  script = script.concat(hitToneA());                      // enemy hit
  script = script.concat(frames(10, 0x0F, 0x0F, 0));
  script = script.concat(pingTone());                      // ping
  script = script.concat(frames(20, 0x0F, 0x0F, 0));
  script.push(SILENT);
  return {script: script};
} // createShotDemoScript

// ---------------------------------------------------------------- melodies (music bus)

var TICKS_PER_BEAT = 4;

/**
 * Builds a track from bars given as arrays of beat entries; an entry is a note
 * name, null (rest) or an array of note names (a chord). `dur` in ticks.
 */
function track(instrument, bars, dur) {
  return {
    instrument: instrument,
    pattern: bars.map(function(bar) {
      var notes = [];
      bar.forEach(function(entry, beat) {
        if (entry === null) {
          return;
        }
        (Array.isArray(entry) ? entry : [entry]).forEach(function(pitch) {
          notes.push({tick: beat * TICKS_PER_BEAT, pitch: pitch, dur: dur});
        });
      });
      return notes;
    })
  };
} // track

// a "doorbell" melody chip: two square voices an octave apart with a plucked decay
var MELODY_INSTRUMENTS = {
  lead: {
    class: 'OscillatorInstrument',
    osc: [{type: 'square'}, {type: 'square', detune: -1200, gain: 0.5}],
    filter: {type: 'lowpass', freq: 3200, Q: 0.7},
    env: {attack: 0.005, decay: 0.55, sustain: 0.0},
    gain: 0.28
  },
  bass: {
    class: 'OscillatorInstrument',
    osc: [{type: 'square'}],
    filter: {type: 'lowpass', freq: 1400, Q: 0.7},
    env: {attack: 0.005, decay: 0.7, sustain: 0.0},
    gain: 0.22
  }
};

/** a bar of 3/4 from "pitch:durTicks" tokens (rest "-:n"), placed sequentially */
function bar(tokens) {
  var notes = [], tick = 0;
  tokens.split(' ').forEach(function(tok) {
    var parts = tok.split(':');
    var dur = parseInt(parts[1] || '4', 10);
    if (parts[0] !== '-') {
      notes.push({tick: tick, pitch: parts[0], dur: dur});
    }
    tick += dur;
  });
  return notes;
} // bar

function melodyScore(tempo, lead, bass, repeat) {
  return {
    tempo: tempo, beatsPerBar: 3, volume: 0.5, defaultDuration: TICKS_PER_BEAT,
    instruments: MELODY_INSTRUMENTS,
    tracks: [
      {instrument: 'lead', pattern: lead.map(bar)},
      {instrument: 'bass', pattern: bass.map(bar)}
    ],
    repeat: (repeat === undefined) ? true : repeat
  };
} // melodyScore

/**
 * 7910E tune 1 "Two Minuets" (J. S. Bach, Notebook for Anna Magdalena): the
 * Minuet in G major BWV Anh. 114, first 16 bars (the second minuet, G minor
 * Anh. 115, is not transcribed yet). 3/4, quarter = 4 ticks.
 */
export function createMinuetScore(repeat) {
  var lead = [
    'D5:4 G4:2 A4:2 B4:2 C5:2', 'D5:4 G4:4 G4:4', 'E5:4 C5:2 D5:2 E5:2 F#5:2', 'G5:4 G4:4 G4:4',
    'C5:4 D5:2 C5:2 B4:2 A4:2', 'B4:4 C5:2 B4:2 A4:2 G4:2', 'F#4:4 G4:2 A4:2 B4:2 G4:2', 'B4:4 A4:8',
    'D5:4 G4:2 A4:2 B4:2 C5:2', 'D5:4 G4:4 G4:4', 'E5:4 C5:2 D5:2 E5:2 F#5:2', 'G5:4 G4:4 G4:4',
    'C5:4 D5:2 C5:2 B4:2 A4:2', 'B4:4 C5:2 B4:2 A4:2 G4:2', 'A4:4 B4:2 A4:2 G4:2 F#4:2', 'G4:12'
  ];
  var bass = [
    'G3:4 B3:4 D4:4', 'G3:4 B3:4 D4:4', 'C3:4 E3:4 G3:4', 'G3:4 B3:4 D4:4',
    'A3:4 F#3:4 D3:4', 'G3:4 B3:4 D4:4', 'D3:4 F#3:4 A3:4', 'G3:4 D3:4 D3:4',
    'G3:4 B3:4 D4:4', 'G3:4 B3:4 D4:4', 'C3:4 E3:4 G3:4', 'G3:4 B3:4 D4:4',
    'A3:4 F#3:4 D3:4', 'G3:4 B3:4 D4:4', 'D3:4 F#3:4 A3:4', 'G3:4 B3:4 G3:4'
  ];
  return melodyScore(120, lead, bass, repeat);
} // createMinuetScore

/**
 * 7910E tune 2 "Dark Eyebrows" = "Ochi chornye" (Dark Eyes, Russian folk song,
 * F. Hermann's waltz), D minor, 3/4 — approximate transcription of the first
 * period, to be tuned by ear against real-board videos (PL-M8).
 */
export function createDarkEyesScore(repeat) {
  var lead = [
    'A4:4 D5:4 D5:4', 'F5:8 E5:4', 'D5:8 C#5:4', 'A4:12',
    'A4:4 Bb4:4 Bb4:4', 'D5:8 C5:4', 'Bb4:8 A4:4', 'G4:12',
    'G4:4 A4:4 Bb4:4', 'D5:8 C5:4', 'Bb4:8 A4:4', 'F4:12',
    'F4:4 E4:4 F4:4', 'A4:8 G4:4', 'F4:8 E4:4', 'D4:12'
  ];
  var bass = [
    'D3:4 F3:4 A3:4', 'D3:4 F3:4 A3:4', 'A2:4 E3:4 G3:4', 'A2:4 C#3:4 E3:4',
    'G2:4 Bb2:4 D3:4', 'G2:4 Bb2:4 D3:4', 'D3:4 F3:4 A3:4', 'G2:4 Bb2:4 D3:4',
    'G2:4 Bb2:4 D3:4', 'G2:4 Bb2:4 D3:4', 'D3:4 F3:4 A3:4', 'F2:4 A2:4 C3:4',
    'Bb2:4 D3:4 F3:4', 'A2:4 C#3:4 E3:4', 'A2:4 C#3:4 E3:4', 'D3:4 F3:4 A3:4'
  ];
  return melodyScore(100, lead, bass, repeat);
} // createDarkEyesScore
