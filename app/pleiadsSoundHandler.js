const { AbstractAudioHandler } = await import('./svision/js/audio/abstractAudioHandler.js?ver='+window.srcVersion);
// begin code

/**
 * Audio handler for the 'sounds' bus (PL-M6): the Pleiads sound board runs in
 * the AudioWorklet app/pleiadsSoundProcessor.js and is driven by the latch
 * writes the worker reports in every frame (frame.latches = {a, b, sod},
 * WORKER-PROTOCOL.md) through writeLatches(). A `playSound` audioData is a
 * latch script ({script: [{a, b, sod}, ...]}, one entry per frame) — that is
 * how the SOUNDS volume dialog plays its sample. Modelled on the svision
 * AudioWorkletHandler (module via fetch + blob URL so the service worker can
 * serve it offline; one registration per context); the user/bus volume is a
 * gain node between the worklet node and the destination.
 */
export class PleiadsSoundHandler extends AbstractAudioHandler {

  constructor(app) {
    super(app);
    this.id = 'PleiadsSoundHandler';
    this.node = null;
    this.gain = null;
    this.busFactor = 1.0;
    this.muted = false;
    this.busy = false;
  } // constructor

  openBus(bus, options, ctx) {
    super.openBus(bus, options, ctx);
    if (this.error === false && this.ctx != null) {
      this.muted = ('muted' in options) ? !!options.muted : false;
      this.openProcessor(options);
    } else {
      this.busy = false;
    }
  } // openBus

  loadProcessorModule() {
    if (!this.ctx.pleiadsSoundModule) {
      this.ctx.pleiadsSoundModule = (async () => {
        const url = this.app.importPath+'/pleiadsSoundProcessor.js?ver='+window.srcVersion;
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error('pleiadsSoundProcessor '+response.status);
        }
        const blobURL = URL.createObjectURL(await response.blob());
        try {
          await this.ctx.audioWorklet.addModule(blobURL);
        } finally {
          URL.revokeObjectURL(blobURL);
        }
      })().catch((error) => {
        this.ctx.pleiadsSoundModule = null;
        throw error;
      });
    }
    return this.ctx.pleiadsSoundModule;
  } // loadProcessorModule

  async openProcessor(options) {
    try {
      await this.loadProcessorModule();
      this.node = new AudioWorkletNode(this.ctx, 'PleiadsSoundProcessor', {numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1]});
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.muted ? 0.0 : this.busFactor;
      this.node.connect(this.gain);
      this.gain.connect(this.ctx.destination);
      this.node.port.onmessage = (event) => {
        this.app.model.sendEvent(1, {id: event.data.id, data: event.data});
      };
    } catch (error) {
      console.error('PleiadsSoundHandler: '+error.message);
      this.node = null;
      this.app.model.sendEvent(1, {id: 'unsupportedAudioBus', bus: this.bus});
    } finally {
      this.busy = false;
    }
  } // openProcessor

  closeBus() {
    if (this.waitForBusy('closeAudioBus')) {
      return false;
    }
    if (this.node) {
      this.node.port.postMessage({id: 'stop'});
      this.node.disconnect();
      this.node = null;
    }
    if (this.gain) {
      this.gain.disconnect();
      this.gain = null;
    }
    return super.closeBus();
  } // closeBus

  post(message) {
    if (this.node != null) {
      this.node.port.postMessage(message);
    }
  } // post

  /** one frame of the program's latch writes (frame.latches) */
  writeLatches(latches) {
    if (this.node != null && latches) {
      this.node.port.postMessage({id: 'latches', a: latches.a, b: latches.b, sod: latches.sod});
    }
  } // writeLatches

  stopBus() {
    this.post({id: 'stop'});
  } // stopBus

  pauseBus() {
    this.post({id: 'pause'});
  } // pauseBus

  continueBus() {
    this.post({id: 'continue'});
  } // continueBus

  muteBus(muted) {
    this.muted = !!muted;
    if (this.gain) {
      this.gain.gain.value = this.muted ? 0.0 : this.busFactor;
    }
  } // muteBus

  setBusVolume(factor) {
    this.busFactor = factor;
    if (this.gain && !this.muted) {
      this.gain.gain.value = factor;
    }
  } // setBusVolume

  busIsReady() {
    return this.node != null;
  } // busIsReady

  playSound(audioData, options) {
    if (audioData === false || !audioData) {
      this.post({id: 'stop'});
      return;
    }
    this.post({id: 'play', audioData: {script: audioData.script || []}, options: options});
  } // playSound

} // PleiadsSoundHandler
