// begin code

/**
 * Pleiads sound board as an AudioWorklet processor (PL-M6).
 *
 * The original has no sample playback: the program writes two latches every
 * frame (6000h = latch A, 6800h = latch B, notes/D 3.1) and the analog board
 * turns them into sound continuously. This processor is a port of the MAME
 * model of that board (sources/mame/pleiads.cpp, GPL-2.0+, Juergen
 * Buchmueller) plus the TMS3615 note generator (sources/mame/tms36xx.cpp,
 * single-note mode, 13 notes, 4 organ voices with a 0.33 s linear decay),
 * and adds the two things MAME lacks:
 *   - the player's shot, triggered by the 8085 SOD pin (SIM, notes/D 3.1):
 *     a noisy tone falling from ~1.45 kHz to ~1.1 kHz with an exponential
 *     decay of ~0.9 s, measured from the PCB recording
 *     sources/sound/pleiads-shoot.wav (RMS/autocorrelation per 10 ms);
 *   - nothing for the Epson 7910E melody chip: the melody is a score on the
 *     'music' bus (soundEffects.js), selected by latch B bits 6-7.
 *
 * Signals (MAME names):
 *   tone1   8 kHz / (16 - n) square, n = latch A bits 0-3, 15 = off
 *   tone2/3 two 556 squares (351 / 582 Hz max), enabled by B bit 5, pitch bent
 *           by the capacitor PB4 charged by B bit 4
 *   tone4   1315 Hz max square whose pitch follows the capacitor PC4 (latch C,
 *           never written in the game) split by the noise bit, level = the
 *           slowly charged capacitor PA5 (A bit 5, 3.3 s up / 2.2 s down)
 *   noise   18-bit LFSR clocked at 1412 * 2/3 or 1/3 Hz (A bit 4); the bit
 *           gates capacitor PA6 (A bit 6: charge in 0.7 ms, discharge 0.1 s
 *           = the explosion burst) and A bit 7 directly (steady noise)
 *   tms     TMS3615 note from B bits 0-3 (15 = none, a note retriggers only
 *           when the latch value changes), octave from B bits 6-7 (3 = 2)
 * Mix after MAME's machine config: custom 0.40, TMS 0.60, the shot 0.40, tanh limiter.
 *
 * Port messages:
 *   {id:'latches', a, b, sod}   one frame of latch writes from the worker
 *   {id:'play', audioData:{script:[{a, b, sod}, ...]}}   a scripted sequence
 *                               played at the frame rate (the volume sample)
 *   {id:'stop'} silence (latches 0Fh/0Fh, SOD 0, the script dropped)
 *   {id:'pause'} / {id:'continue'} / {id:'mute'} / {id:'unmute'}
 */
var VMAX = 32767;
var PC4_MIN = Math.floor(VMAX * 7 / 50);
var FRAME_RATE = 61.035;
var TONE1_CLOCK = 8000;

// TMS3615 (Pleiads machine config: clock 247 Hz, decays 0.33/0.33/0/0.33/0/0.33)
var TMS_CLOCK = 247;
var TMS_DECAY = 0.33;
var TMS_VOICE_RATIO = [1, 2, 4, 8];   // 16', 8', 4', 2' (the 5 1/3' and 2 2/3' voices are disabled)

/** an RC capacitor: exponential charge / discharge between min and VMAX */
class Capacitor {
  constructor(chargeTime, dischargeTime, min, level) {
    this.chargeTime = chargeTime;
    this.dischargeTime = dischargeTime;
    this.min = (min === undefined) ? 0 : min;
    this.level = (level === undefined) ? this.min : level;
  } // constructor

  step(charging, dt) {
    if (charging) {
      this.level += (VMAX - this.level) * Math.min(1, dt / this.chargeTime);
    } else {
      this.level -= (this.level - this.min) * Math.min(1, dt / this.dischargeTime);
    }
    return this.level;
  } // step
} // Capacitor

class PleiadsSoundProcessor extends AudioWorkletProcessor {

  constructor(...args) {
    super(...args);
    this.rate = sampleRate;
    this.dt = 1 / this.rate;
    this.paused = false;
    this.muted = false;

    // latches
    this.latchA = 0x0F;
    this.latchB = 0x0F;
    this.latchC = 0;
    this.sod = 0;

    // tone 1
    this.t1Counter = 0;
    this.t1Max = 0;
    this.t1Out = 0;
    // tones 2/3
    this.pb4 = new Capacitor(0.1, 0.1);
    this.t2Phase = 0;
    this.t3Phase = 0;
    this.t2Out = 0;
    this.t3Out = 0;
    // tone 4
    this.pc4 = new Capacitor(0.066, 0.022, PC4_MIN, PC4_MIN);
    this.pc5 = new Capacitor(0.0033, 0.1);
    this.pa5 = new Capacitor(3.3, 2.2);
    this.t4Phase = 0;
    this.t4Out = 0;
    // noise
    this.pa6 = new Capacitor(0.000726, 0.1);
    this.shiftReg = 0;
    this.polyBit = 0;
    this.noiseCounter = 0;

    // TMS3615: 4 voices, each {freq, phase, out, vol}
    this.tms = TMS_VOICE_RATIO.map(() => ({freq: 0, phase: 0, out: 0, vol: 0}));
    this.tmsOctave = 0;

    // shot (SOD)
    this.shot = {active: false, t: 0, phase: 0, lfsr: 0x2A5F, noise: 1, noiseCounter: 0};

    // scripted sequence (volume sample)
    this.script = false;
    this.scriptPos = 0;
    this.frameAcc = 0;

    this.port.onmessage = (event) => {
      var d = event.data;
      switch (d.id) {
        case 'latches':
          this.writeLatches(d.a, d.b, d.sod);
          break;
        case 'play':
          this.script = (d.audioData && Array.isArray(d.audioData.script)) ? d.audioData.script : false;
          this.scriptPos = 0;
          this.frameAcc = 0;
          this.paused = false;
          if (this.script === false) {
            this.writeLatches(0x0F, 0x0F, 0);
          }
          break;
        case 'stop':
          this.script = false;
          this.writeLatches(0x0F, 0x0F, 0);
          this.shot.active = false;
          break;
        case 'pause': this.paused = true; break;
        case 'continue': this.paused = false; break;
        case 'mute': this.muted = true; break;
        case 'unmute': this.muted = false; break;
      }
    }; // onmessage
  } // constructor

  /** one frame of the program's writes: 6000h, 6800h and the SOD pin */
  writeLatches(a, b, sod) {
    if (typeof a == 'number') {
      this.latchA = a & 0xFF;
    }
    if (typeof b == 'number' && (b & 0xFF) !== this.latchB) {
      // control_b_w: the TMS3615 gets the note only when the latch changes
      this.latchB = b & 0xFF;
      var pitch = (this.latchB >> 6) & 3;
      this.tmsNote(pitch === 3 ? 2 : pitch, this.latchB & 0x0F);
    }
    if (typeof sod == 'number') {
      if (sod && !this.sod) {
        this.startShot();
      }
      this.sod = sod ? 1 : 0;
    }
  } // writeLatches

  /** tms36xx_note_w: notes 0-12 restart the four voices at full volume */
  tmsNote(octave, note) {
    if (note > 12) {
      return;
    }
    this.tmsOctave = octave;
    var base = Math.pow(2, (note + 2) / 12) * (TMS_CLOCK << octave);   // note 0 = B
    this.tms.forEach((v, i) => {
      v.freq = base * TMS_VOICE_RATIO[i];
      v.vol = 1;
      v.phase = 0;
    });
  } // tmsNote

  startShot() {
    this.shot.active = true;
    this.shot.t = 0;
    this.shot.phase = 0;
  } // startShot

  // ---------------------------------------------------------------- per-sample signals (MAME order)

  tone1() {
    if ((this.latchA & 15) !== 15) {
      this.t1Counter -= TONE1_CLOCK;
      while (this.t1Counter <= 0) {
        this.t1Counter += this.rate;
        if (++this.t1Max >= 16) {
          this.t1Max = this.latchA & 15;
          this.t1Out ^= 1;
        }
      }
    }
    if ((this.latchA & 15) === 15) {
      return 0;   // MAME keeps the last level (DC); silence here
    }
    return this.t1Out ? 1 : -1;
  } // tone1

  tone23() {
    var level = VMAX - this.pb4.step(this.latchB & 0x10, this.dt);
    if ((this.latchB & 0x20) === 0) {
      return 0;
    }
    if (level >= VMAX) {
      return 0;   // timers stalled (MAME: DC)
    }
    {
      this.t2Phase += 351 * level / VMAX * this.dt;
      if (this.t2Phase >= 1) { this.t2Phase -= Math.floor(this.t2Phase); this.t2Out ^= 1; }
      this.t3Phase += (582 / 3 + 582 * 2 / 3 * level / VMAX) * this.dt;
      if (this.t3Phase >= 1) { this.t3Phase -= Math.floor(this.t3Phase); this.t3Out ^= 1; }
    }
    return ((this.t2Out ? 1 : -1) + (this.t3Out ? 1 : -1)) / 2;
  } // tone23

  tone4() {
    var level = this.pc4.step(this.latchC & 0x10, this.dt);
    var vpc5 = this.pc5.step(this.latchC & 0x20, this.dt);
    var vpa5 = this.pa5.step(this.latchA & 0x20, this.dt);
    // the op-amp output divided by the polynomial bit (47k / 20k)
    if (this.polyBit) {
      level = level + (VMAX - level) * 20 / 67;
    } else {
      level = level * 47 / 67;
    }
    this.t4Phase += 1315 * level / VMAX * this.dt;
    if (this.t4Phase >= 1) { this.t4Phase -= Math.floor(this.t4Phase); this.t4Out ^= 1; }
    var sum = (vpc5 * 33 / 80 + vpa5 * 47 / 80) / VMAX;
    return this.t4Out ? sum : -sum;
  } // tone4

  noise() {
    // PA6: charged by A bit 6 (0.7 ms), otherwise discharged only while the polynomial bit is set (0.1 s)
    if (this.latchA & 0x40) {
      this.pa6.step(true, this.dt);
    } else if (this.polyBit) {
      this.pa6.step(false, this.dt);
    }
    var pa6 = this.pa6.level / VMAX;
    // the 18-bit polynomial counter, clocked by the lower 556 (1412 Hz * 2/3 or 1/3)
    this.noiseCounter -= (this.latchA & 0x10) ? 1412 * 2 / 3 : 1412 / 3;
    while (this.noiseCounter <= 0) {
      this.noiseCounter += this.rate;
      this.polyBit = this.shiftReg & 1;
      if (((this.shiftReg >> 16) & 1) === ((this.shiftReg >> 17) & 1)) {
        this.shiftReg = ((this.shiftReg << 1) | 1) & 0x3FFFF;
      } else {
        this.shiftReg = (this.shiftReg << 1) & 0x3FFFF;
      }
    }
    var sum = pa6 + ((this.latchA & 0x80) ? 1 : 0);
    return (this.polyBit ? sum : -sum) / 2;
  } // noise

  tmsSample() {
    var sum = 0;
    var decay = this.dt / TMS_DECAY;
    for (var i = 0; i < this.tms.length; i++) {
      var v = this.tms[i];
      if (v.vol <= 0 || v.freq <= 0) {
        continue;
      }
      v.vol -= decay;
      if (v.vol <= 0) { v.vol = 0; v.freq = 0; continue; }
      v.phase += v.freq * this.dt;
      if (v.phase >= 1) { v.phase -= Math.floor(v.phase); v.out ^= 1; }
      sum += v.out ? v.vol : -v.vol;
    }
    return sum / this.tms.length;
  } // tmsSample

  /** the SOD shot: square 1450 -> 1100 Hz (tau 0.35 s), gated by fast noise, envelope tau 0.28 s */
  shotSample() {
    var s = this.shot;
    if (!s.active) {
      return 0;
    }
    s.t += this.dt;
    if (s.t > 0.95) {
      s.active = false;
      return 0;
    }
    var freq = 1100 + 350 * Math.exp(-s.t / 0.35);
    s.phase += freq * this.dt;
    if (s.phase >= 1) { s.phase -= Math.floor(s.phase); }
    s.noiseCounter -= 6000;
    while (s.noiseCounter <= 0) {
      s.noiseCounter += this.rate;
      var bit = ((s.lfsr >> 0) ^ (s.lfsr >> 2) ^ (s.lfsr >> 3) ^ (s.lfsr >> 5)) & 1;
      s.lfsr = (s.lfsr >> 1) | (bit << 15);
      s.noise = s.lfsr & 1;
    }
    var env = Math.exp(-s.t / 0.28);
    var tone = (s.phase < 0.5) ? 1 : -1;
    return tone * (0.55 + 0.45 * (s.noise ? 1 : -1)) * env;
  } // shotSample

  /** the scripted sequence: one entry per frame at 61.035 Hz */
  stepScript() {
    if (this.script === false) {
      return;
    }
    this.frameAcc += this.dt * FRAME_RATE;
    while (this.frameAcc >= 1) {
      this.frameAcc -= 1;
      if (this.scriptPos < this.script.length) {
        var e = this.script[this.scriptPos++];
        this.writeLatches(e.a, e.b, e.sod);
      } else {
        this.script = false;
        this.writeLatches(0x0F, 0x0F, 0);
        return;
      }
    }
  } // stepScript

  process(inputs, outputs, parameters) {
    var out = outputs[0];
    var n = out[0].length;
    if (this.paused) {
      for (var c = 0; c < out.length; c++) { out[c].fill(0); }
      return true;
    }
    for (var i = 0; i < n; i++) {
      this.stepScript();
      var custom = this.tone1() / 2 + this.tone23() / 2 + this.tone4() + this.noise();
      if (custom > 1) { custom = 1; } else if (custom < -1) { custom = -1; }
      var sample = custom * 0.40 + this.tmsSample() * 0.60 + this.shotSample() * 0.40;
      sample = Math.tanh(sample);   // soft limiter: the three sources can add up above 1
      if (this.muted) {
        sample = 0;
      }
      out[0][i] = sample;
    }
    for (var c2 = 1; c2 < out.length; c2++) {
      out[c2].set(out[0]);
    }
    return true;
  } // process

} // PleiadsSoundProcessor

registerProcessor('PleiadsSoundProcessor', PleiadsSoundProcessor);
