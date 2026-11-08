const { AbstractModel } = await import('./svision/js/abstractModel.js?ver='+window.srcVersion);
const { BorderEntity } = await import('./borderEntity.js?ver='+window.srcVersion);
const { TextEntity } = await import('./svision/js/platform/canvas2D/textEntity.js?ver='+window.srcVersion);
const { PauseGameEntity } = await import('./pauseGameEntity.js?ver='+window.srcVersion);
const { TileMapEntity } = await import('./tileMapEntity.js?ver='+window.srcVersion);
const { MockWorker } = await import('./mockWorker.js?ver='+window.srcVersion);
const { ZXColor } = await import('./svision/js/platform/canvas2D/zx/zxColor.js?ver='+window.srcVersion);
const { Tool } = await import('./svision/js/tool.js?ver='+window.srcVersion);
// begin code

/**
 * The game screen (PL-M4). The worker (app/gameWorker.js, WORKER-PROTOCOL.md)
 * runs the original program at its fixed tick and sends a 'frame' (VRAM page,
 * palette bank, scroll, sounds) after every tick; this model shows the last
 * received frame in the TileMapEntity (no interpolation, no separate HUD: score,
 * lives and credits are part of the VRAM as in the original), routes the
 * controls (keyboard, mouse, gamepad, touch — the SI/MM wiring) to the worker
 * as a full {left, right, fire} state, hands every frame's latch writes to
 * AudioManager.playFrame (sound board + melody) and reacts to gameOver / roundComplete.
 *
 * Worker selection: the real Worker created by GameApp, or the in-thread
 * MockWorker (app/mockWorker.js) when useMockWorker() says so — the developer
 * parameter ?devMock=1 (`Tool.devParam`, R-058; or window.mockWorker = true),
 * or automatically when data/tables.json
 * did not arrive with appData (the real worker cannot run without the tables).
 */
export class MainModel extends AbstractModel {

  constructor(app, attract) {
    super(app);
    this.id = 'MainModel';

    this.attract = attract;
    this.gameOver = false;
    this.roundComplete = false;
    this.frame = null;
    this.framesReceived = 0;
    this.controlsState = {left: false, right: false, fire: false};
    this.worker = null;
    this.tileMapEntity = null;
    this.fpsEntity = null;
    this.fps = {frames: 0, workerFrames: 0, ticks: 0, since: false, lastFrame: false};
  } // constructor

  newBorderEntity() {
    return new BorderEntity(true, this.app.controls.touchscreen.supported);
  } // newBorderEntity

  /**
   * True when the game should run against the MockWorker instead of app.worker.
   */
  static useMockWorker(app, tables) {
    if (typeof window !== 'undefined') {
      if (window.mockWorker === true) {
        return true;
      }
      var asked = String(Tool.devParam('devMock', '0'));
      if (asked !== '0' && asked !== 'false' && asked !== '') {
        return true;
      }
    }
    return !tables;
  } // useMockWorker

  init() {
    super.init();

    this.borderEntity.bkColor = '#000000';
    this.desktopEntity.bkColor = '#000000';

    this.tileMapEntity = new TileMapEntity(this.desktopEntity, 0, 0);
    this.desktopEntity.addEntity(this.tileMapEntity);

    // the data files: at once from localStorage, or from the server when they
    // are missing there (R-062)
    this.loadDataFiles(['tiles', 'screens', 'tables'], (files, error) => this.initData(files, error));
  } // init

  /**
   * The part of init() that needs the data files. Runs inside init() when
   * they are in localStorage, later when they had to come from the server.
   * @param {Object|null} files - The data files, or null.
   * @param {Error} [error] - Why they are missing.
   */
  initData(files, error) {
    if (this.app.model !== this) {
      return;
    }
    if (!files) {
      this.app.showErrorMessage(error ? error.message : 'Game data could not be loaded.', 'restart');
    }
    var tiles = this.loadDataFile('tiles');
    var screens = this.loadDataFile('screens');
    var tables = this.loadDataFile('tables');
    if (tiles) {
      this.tileMapEntity.setTiles(tiles);
    } else {
      this.desktopEntity.addEntity(new TextEntity(this.desktopEntity, this.app.fonts.fonts5x5, 8, 14*8, this.desktopWidth-16, 40, 'GAME DATA (TILES) NOT LOADED.', ZXColor.brightGreen, false, {align: 'center', textWrap: true}));
    }
    // ★ No first picture here. The static phase 1 dump used to be shown until
    // the first worker frame arrived, but the worker is quick enough that the
    // dump only ever reached the screen for a single display frame before being
    // replaced — a picture flashing by as the game started. Nothing is drawn
    // until the worker sends video (TileMapEntity.drawEntity). The dump itself
    // stays in data/screens.json: MockWorker plays it.

    if (this.app.devModeName !== false) {
      this.fpsEntity = new TextEntity(this.desktopEntity, this.app.fonts.fonts3x3, this.desktopWidth-40, this.desktopHeight-5, 40, 4, '', ZXColor.brightGreen, false, {align: 'right'});
      this.desktopEntity.addEntity(this.fpsEntity);
    }

    // the menu keeps the audio closed; the game opens its buses here (MM pattern)
    this.sendEvent(0, {id: 'openAudioBus', bus: 'sounds', options: {muted: this.app.muted.sounds}});
    this.sendEvent(0, {id: 'openAudioBus', bus: 'music', options: {muted: this.app.muted.music}});

    // worker: real or mock
    this.app.mockWorker = MainModel.useMockWorker(this.app, tables);
    if (this.app.mockWorker) {
      this.worker = new MockWorker(screens || {});
      this.worker.onmessage = (event) => {
        if (this.app.model === this) {
          this.handleWorkerMessage(event);
        }
      };
      if (this.fpsEntity) {
        this.fpsEntity.width = 60;
        this.fpsEntity.x = this.desktopWidth-60;
      }
    } else {
      this.worker = this.app.worker;
    }

    this.app.inputEventsManager.sendEventsActiveKeys('Press');
    this.sendWorkerMessage({
      id: 'init',
      initData: {
        headless: false,
        dip: {lives: this.app.lives || 3, bonus: 3},
        tables: tables,
        hiScore: this.app.hiScore || 0,
        attract: this.attract
      }
    });
  } // initData

  shutdown() {
    super.shutdown();
    this.sendWorkerMessage({id: 'reset'});
    if (this.worker && this.worker !== this.app.worker && this.worker.terminate) {
      this.worker.terminate();
    }
    this.sendEvent(0, {id: 'stopAllAudioBuses'});
  } // shutdown


  sendWorkerMessage(event) {
    if (this.worker) {
      this.worker.postMessage(event);
    }
  } // sendWorkerMessage

  /**
   * Sets one control (left/right/fire) and sends the whole state to the worker
   * when it changed (protocol: {id:'controls', left, right, fire}).
   */
  setControl(action, value) {
    if (!(action in this.controlsState) || this.controlsState[action] === value) {
      return;
    }
    this.controlsState[action] = value;
    this.sendWorkerMessage({id: 'controls', left: this.controlsState.left, right: this.controlsState.right, fire: this.controlsState.fire});
  } // setControl

  handleWorkerMessage(event) {
    var data = event.data;
    switch (data.id) {
      case 'frame':
        this.frame = data;
        this.framesReceived++;
        this.fps.workerFrames++;
        // ★ R-045: a tiky světa zvlášť, odečtené z čítače ve zprávě
        if (this.fps.lastFrame !== false) { this.fps.ticks += data.frame-this.fps.lastFrame; }
        this.fps.lastFrame = data.frame;
        if (data.page) {
          this.tileMapEntity.setVramBytes(data.page);
        }
        if ('paletteBank' in data) {
          this.tileMapEntity.setPaletteBank(data.paletteBank);
        }
        if ('scroll' in data) {
          this.tileMapEntity.setScroll(data.scroll);
        }
        if (typeof data.score == 'number') {
          this.app.score = data.score;
        }
        if (typeof data.hiScore == 'number' && data.hiScore > (this.app.hiScore || 0)) {
          this.app.hiScore = data.hiScore;
        }
        if (typeof data.lives == 'number') {
          this.app.lives = data.lives;
        }
        if (data.latches && this.app.audioManager && typeof this.app.audioManager.playFrame == 'function') {
          this.app.audioManager.playFrame(data);   // PL-M6: latches -> sound board, melody select
        }
        break;
      case 'gameOver':
        if (!this.gameOver && !this.roundComplete) {
          this.gameOver = true;
          if (typeof data.score == 'number') {
            this.app.score = data.score;
          }
          this.app.setModel('GameOverModel');
        }
        break;
      case 'roundComplete':
        // PL-M5: informative only (a phase / round was completed, the game goes on); the game ends
        // solely with 'gameOver'. The round-complete screen of PL-M4 is no longer shown.
        break;
    }
  } // handleWorkerMessage


  // PL-M4 ends with phase 1: show a placeholder and return to the menu on any key
  showRoundComplete() {
    this.sendEvent(0, {id: 'pauseAllAudioBuses'});
    var y = Math.floor(this.desktopHeight/2)-16;
    this.desktopEntity.addEntity(new TextEntity(this.desktopEntity, this.app.fonts.zxFonts8x8, 8, y, this.desktopWidth-16, 32, 'PHASE 2 — COMING IN PL-M5', ZXColor.brightWhite, ZXColor.blue, {align: 'center', topMargin: 4, textWrap: true}));
    this.desktopEntity.addEntity(new TextEntity(this.desktopEntity, this.app.fonts.fonts5x5, 8, y+34, this.desktopWidth-16, 7, 'PRESS ANY KEY', ZXColor.brightGreen, false, {align: 'center'}));
  } // showRoundComplete

  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }

    switch (event.id) {

      case 'exitGame':
        this.app.setModel('MenuModel');
        return true;

      case 'blurWindow':
        this.pauseGame();
        return true;

      case 'continueGame':
        this.sendWorkerMessage({id: 'continue'});
        this.sendEvent(0, {id: 'continueAllAudioBuses'});
        return true;

      case 'keyPress':
        var key = event.key;
        if (key.length == 1) {
          key = key.toUpperCase();
        }
        if (this.roundComplete && !this.desktopEntity.modalEntity) {
          if (key == 'Touch' || key.indexOf('Mouse') == 0 || !['Shift', 'Control', 'Alt', 'Meta'].includes(key)) {
            this.app.setModel('MenuModel');
            return true;
          }
        }
        switch (key) {
          case 'Escape':
          case 'P':
          case 'GamepadExit':
            this.pauseGame();
            return true;
          case 'Touch':
            if (this.borderEntity.leftControlEntity && this.borderEntity.leftControlEntity.pointOnEntity(event)) {
              this.app.inputEventsManager.touchesMap[event.identifier] = this.borderEntity.leftControlEntity;
              this.touchStart(event, 'left');
              return true;
            }
            if (this.borderEntity.rightControlEntity && this.borderEntity.rightControlEntity.pointOnEntity(event)) {
              this.app.inputEventsManager.touchesMap[event.identifier] = this.borderEntity.rightControlEntity;
              this.touchStart(event, 'right');
              return true;
            }
            break;
          case 'RetryTouch':
            this.setControl(event.action, true);
            return true;
          case this.app.controls.mouse.right:
            if (this.app.controls.mouse.enable && this.app.inputEventsManager.keysMap[this.app.controls.mouse.right] === false) {
              this.setControl('right', true);
            }
            return true;
          case this.app.controls.keyboard.right:
          case 'GamepadRight':
            this.setControl('right', true);
            return true;
          case this.app.controls.mouse.left:
            if (this.app.controls.mouse.enable && this.app.inputEventsManager.keysMap[this.app.controls.mouse.left] === false) {
              this.setControl('left', true);
            }
            return true;
          case this.app.controls.keyboard.left:
          case 'GamepadLeft':
            this.setControl('left', true);
            return true;
          case this.app.controls.mouse.fire:
            if (this.app.controls.mouse.enable && this.app.inputEventsManager.keysMap[this.app.controls.mouse.fire] === false) {
              this.setControl('fire', true);
              break;
            }
            return true;
          case this.app.controls.keyboard.fire:
          case 'GamepadJump':
            this.setControl('fire', true);
            return true;
          case this.app.controls.keyboard.sounds:
            this.app.muted.sounds = !this.app.muted.sounds;
            this.sendEvent(0, {id: 'muteAudioBus', bus: 'sounds', muted: this.app.muted.sounds});
            return true;
          case this.app.controls.keyboard.music:
            this.app.muted.music = !this.app.muted.music;
            this.sendEvent(0, {id: 'muteAudioBus', bus: 'music', muted: this.app.muted.music});
            return true;
        }
        break;

      case 'keyRelease':
        var key = event.key;
        if (key.length == 1) {
          key = key.toUpperCase();
        }
        switch (key) {
          case 'Touch':
            this.touchEnd(event);
            return true;
          case this.app.controls.mouse.right:
            if (this.app.controls.mouse.enable && this.app.inputEventsManager.keysMap[this.app.controls.mouse.right] === false) {
              this.setControl('right', false);
            }
            return true;
          case this.app.controls.keyboard.right:
          case 'GamepadRight':
            this.setControl('right', false);
            return true;
          case this.app.controls.mouse.left:
            if (this.app.controls.mouse.enable && this.app.inputEventsManager.keysMap[this.app.controls.mouse.left] === false) {
              this.setControl('left', false);
            }
            return true;
          case this.app.controls.keyboard.left:
          case 'GamepadLeft':
            this.setControl('left', false);
            return true;
          case this.app.controls.mouse.fire:
            if (this.app.controls.mouse.enable && this.app.inputEventsManager.keysMap[this.app.controls.mouse.fire] === false) {
              this.setControl('fire', false);
            }
            return true;
          case this.app.controls.keyboard.fire:
          case 'GamepadJump':
            this.setControl('fire', false);
            return true;
        }
        break;

      case 'keyMove':
        if (event.key == 'Touch') {
          this.touchMove(event);
          return true;
        }
        break;

      case 'errorAudioBus':
        this.app.showErrorMessage(event.error, 'reopen');
        return true;
    }

    return false;
  } // handleEvent

  // pause the worker and open the pause menu (RESUME / SOUNDS / MUSIC / EXIT GAME)
  pauseGame() {
    if (this.desktopEntity.modalEntity || this.gameOver || this.roundComplete) {
      return;
    }
    this.sendWorkerMessage({id: 'pause'});
    this.sendEvent(0, {id: 'pauseAllAudioBuses'});
    this.desktopEntity.addModalEntity(new PauseGameEntity(this.desktopEntity, 28, 86, 153, 85, 'PAUSE GAME', 'MenuModel'));
  } // pauseGame

  // touch controls (SI/MM pattern): the border's left/right control areas carry a
  // button or a horizontal joystick according to controlsOptions.touchscreen.types
  touchStart(event, side) {
    var ts = this.app.controlsOptions.touchscreen.types[this.app.controls.touchscreen.type][side];
    if (ts.type == 'button') {
      this.setControl(ts.action, true);
    }
    this.app.inputEventsManager.touchesGameControls[event.identifier] = {center: {x: event.x, y: event.y}, type: ts.type, control: ts.control, action: ts.action, actions: ts.actions};
  } // touchStart

  touchEnd(event) {
    var tgc = this.app.inputEventsManager.touchesGameControls;
    if (event.identifier in tgc) {
      if (tgc[event.identifier].action !== false) {
        this.setControl(tgc[event.identifier].action, false);
      }
      delete tgc[event.identifier];
    }
  } // touchEnd

  touchMove(event) {
    var tgc = this.app.inputEventsManager.touchesGameControls;
    if (!(event.identifier in tgc)) {
      return;
    }
    var control = tgc[event.identifier];
    var action = control.action;
    if (control.type == 'joystick' && control.control == 'horizontal') {
      if (event.x-control.center.x < -10) {
        action = control.actions[0];
        control.center.x = event.x;
      }
      if (event.x-control.center.x > 10) {
        action = control.actions[1];
        control.center.x = event.x;
      }
      if (control.action !== action) {
        if (control.action !== false) {
          this.setControl(control.action, false);
        }
        control.action = action;
        this.setControl(control.action, true);
      }
    }
  } // touchMove

  updateFps(timestamp) {
    if (!this.fpsEntity) {
      return;
    }
    this.fps.frames++;
    if (this.fps.since === false) {
      this.fps.since = timestamp;
      return;
    }
    var elapsed = timestamp-this.fps.since;
    if (elapsed >= 1000) {
      var draw = Math.round(this.fps.frames*1000/elapsed);
      var worker = Math.round(this.fps.workerFrames*1000/elapsed);
      var ticks = Math.round(this.fps.ticks*1000/elapsed);
      this.fpsEntity.setText((this.app.mockWorker ? 'MOCK ' : '')+draw+'/'+worker+'/'+ticks+' FPS');
      this.fps.frames = 0;
      this.fps.workerFrames = 0;
      this.fps.ticks = 0;
      this.fps.since = timestamp;
    }
  } // updateFps

  loopModel(timestamp) {
    super.loopModel(timestamp);

    if (this.desktopEntity.modalEntity) {
      this.desktopEntity.modalEntity.loopEntity(timestamp);
    }

    this.updateFps(timestamp);
    this.drawModel();
  } // loopModel

} // MainModel
