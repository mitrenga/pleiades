const { AbstractAudioManager } = await import('./svision/js/audio/abstractAudioManager.js?ver='+window.srcVersion);
const { AudioOscillatorHandler } = await import('./svision/js/audio/audioOscillatorHandler.js?ver='+window.srcVersion);
const { Tool } = await import('./svision/js/tool.js?ver='+window.srcVersion);
const { PleiadsSoundHandler } = await import('./pleiadsSoundHandler.js?ver='+window.srcVersion);
const { createShotDemoScript, createMinuetScore, createDarkEyesScore } = await import('./soundEffects.js?ver='+window.srcVersion);
// begin code

/**
 * Audio manager (PL-M6). Two buses:
 *   sounds  the Pleiads sound board (PleiadsSoundHandler -> AudioWorklet
 *           pleiadsSoundProcessor.js), fed every frame with the latch writes
 *           the worker reports (frame.latches); SOUNDS volume sample = a
 *           latch script (shot, hit, ping)
 *   music   the Epson 7910E melody as a svision score (AudioOscillatorHandler);
 *           the tune follows latch B bits 6-7 (MELODIES), MUSIC volume sample
 *           = the Minuet
 * The menu never opens a bus; the volume dialogs and the game do (MM pattern).
 */
var EFFECT_BUSES = ['sounds'];

/**
 * latch B bits 6-7 (S_3B00: 00 = phases 0/1, 01 = phase 6, 10 = the other phases) -> melody or false.
 * Centuri schematics: the 7910E gets ~bit6 and ~bit7 on MT (play while high) and MSL (L = tune 1,
 * H = tune 2); which bit is which cannot be read from the scan. Assumed here: bit 6 -> MT, bit 7 -> MSL:
 * 00 -> tune 2 (Dark Eyes), 10 -> tune 1 (Minuet), 01 -> silence. The alternative (bit 7 -> MT,
 * bit 6 -> MSL) would be {0: 'darkEyes', 1: 'minuet', 2: false} — decide by A/B against real-board videos.
 */
var MELODIES = {0: 'darkEyes', 1: false, 2: 'minuet', 3: 'minuet'};

export class AudioManager extends AbstractAudioManager {

  constructor(app) {
    super(app);
    this.id = 'AudioManager';
    this.volume = {};
    this.volume.sounds = Math.min(10, Math.max(0, Math.round(Number(Tool.readCookie('audioBusSoundsLevel', 7)))));
    this.volume.music = Math.min(10, Math.max(0, Math.round(Number(Tool.readCookie('audioBusMusicLevel', 7)))));
    this.latencyHint = 'interactive';
    this.melodyIndex = -1;
  } // constructor

  static get effectBuses() {
    return EFFECT_BUSES;
  } // effectBuses

  static get MELODIES() {
    return MELODIES;
  } // MELODIES

  // the user level a bus follows
  volumeKey(bus) {
    return (bus === 'music') ? 'music' : 'sounds';
  } // volumeKey

  createAudioHandler(bus, options) {
    if (bus === 'sounds') {
      return new PleiadsSoundHandler(this.app);
    }
    return new AudioOscillatorHandler(this.app);
  } // createAudioHandler

  volumeFactor(volume) {
    var levels = [0, 0.005, 0.01, 0.02, 0.04, 0.07, 0.1, 0.14, 0.18, 0.23, 0.29];
    return levels[volume]/levels[10];
  } // volumeFactor

  openBus(bus, options) {
    super.openBus(bus, options);
    this.refreshVolume(bus);
    this.muteBus(bus, ('muted' in options) ? options.muted : false);
    if (bus === 'music') {
      this.melodyIndex = -1;
    }
  } // openBus

  refreshVolume(bus) {
    var handler = this.buses[bus];
    if (handler === undefined) {
      return;
    }
    handler.setBusVolume(this.volumeFactor(this.volume[this.volumeKey(bus)]));
  } // refreshVolume

  // muting 'sounds' mutes every effect bus
  muteBus(bus, muted) {
    if (bus === 'sounds') {
      EFFECT_BUSES.forEach((b) => super.muteBus(b, muted));
      return;
    }
    super.muteBus(bus, muted);
  } // muteBus

  /**
   * One worker frame: the latch writes go to the sound board, latch B bits 6-7
   * select the melody (a change starts the new tune from its beginning, or
   * stops the music). Never throws.
   */
  playFrame(frame) {
    try {
      var latches = frame ? frame.latches : false;
      if (!latches) {
        return;
      }
      var board = this.buses.sounds;
      if (board !== undefined && typeof board.writeLatches == 'function') {
        board.writeLatches(latches);
      }
      this.selectMelody((latches.b >> 6) & 3);
    } catch (error) {
      console.error(error.message);
    }
  } // playFrame

  selectMelody(index) {
    if (index === this.melodyIndex || this.buses.music === undefined) {
      return;
    }
    this.melodyIndex = index;
    var melody = MELODIES[index];
    if (melody === false || melody === undefined) {
      this.stopBus('music');
      return;
    }
    this.playSound('music', melody, {repeat: true});
  } // selectMelody

  // kept for the frame.sounds event names (informative, WORKER-PROTOCOL.md); the board plays from the latches
  playEvent(name) {
    return false;
  } // playEvent

  audioData(bus, sound, options) {
    var data = super.audioData(bus, sound, options);
    if (data !== false) {
      return data;
    }
    switch (sound) {
      case 'exampleFireSound': return createShotDemoScript();
      case 'minuet': return createMinuetScore(true);
      case 'darkEyes': return createDarkEyesScore(true);
      case 'exampleMelodySound': return createMinuetScore(false);
    }
    return false;
  } // audioData

} // AudioManager
