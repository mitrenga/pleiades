const { TileMapEntity } = await import('./tileMapEntity.js?ver='+window.srcVersion);
// begin code

/**
 * The title of the attract mode played by the game worker into a TileMapEntity
 * of a model — the boot (BootModel, once; the options allow a looping stretch
 * with the texts or the whole foreground taken out). Nothing is composed here: the
 * picture is the original program's. The worker (app/gameWorker.js) runs the
 * attract without a coin, fast-forwarded silently to the attract counter
 * `start` (initData.fastForwardAttract) and paused at `end`
 * (initData.pauseAtAttract); every frame arrives as in the game
 * (GameApp routes them to the current model, which hands them over here).
 *
 * The attract of the original (attract_sequence 00E3h): 01B0h clears the score
 * table screen and draws the copyright rows (L_01E1), 01C0h-01E0h the demo
 * start (the planet of phase 0 rises at the bottom), 0200h-03C0h the enemy
 * showcase (1AD0h: seven times 64 frames, a monster morphing through its
 * sixteen pictures while a letter of PLEIADS is laid into the background out
 * of the star tiles), 03BFh attract_reinit (the runway goes, the copyright
 * rows come back, the palette switches), 0400h-04AFh two little pictures
 * dancing under the title (attract_ship_anim), 04E6h the demo game (PL-M7).
 *
 * Touches of the remake's own (2026-09-12), all on the display side, the
 * worker stays the original's: the lights of the landing runway at the bottom
 * run as in the landing phase (animateLandingLights), the palette stays the
 * title's from 03BFh on (PALETTE_FREEZE_COUNTER; attract_reinit recolours the
 * whole picture), and, when asked, the letters of PLEIADS and the copyright
 * rows of the original are taken out of every frame (`clearTexts`,
 * clearTitleTexts) or the whole foreground below the score header goes
 * (`clearForeground`: the morphing monsters, the dancing pictures, the texts;
 * the sky, the planet and the runway are background).
 *
 * No audio bus is opened (R-024: the boot and the menu are the screens
 * reachable without a user gesture), so the sound latches are ignored.
 */
export class AttractTitle {

  /**
   * @param {AbstractModel} model - The owner; its desktopEntity gets the TileMapEntity.
   * @param {Object} options - {start, end: attract counters; loop: start again at the end;
   *   clearTexts: no PLEIADS letters and no copyright rows; clearForeground: no foreground below the
   *   score header at all; onEnd: called at the end (not looping)}
   */
  constructor(model, options) {
    this.model = model;
    this.app = model.app;
    this.options = options;
    this.tileMapEntity = null;
    this.tables = null;
    this.lightRuns = [];       // landing_anim_table 37C0h: the runs of runway lights, {n, step, offset}
    this.running = false;      // the worker plays for us
    this.complete = false;     // the end counter has been reached
    this.paletteBank = false;  // the bank frozen at PALETTE_FREEZE_COUNTER
  } // constructor

  /** from here on the palette bank of the frames is ignored: attract_reinit (03BFh) recolours the picture */
  static get PALETTE_FREEZE_COUNTER() { return 0x3BF; }

  /**
   * Creates the TileMapEntity and starts the worker. False when the ROM
   * conversions (data/tiles.json, data/tables.json, delivered by appData.db
   * and cached in localStorage) are not there yet — nothing is added then.
   */
  start() {
    var tiles = this.model.loadDataFile('tiles');
    var tables = this.model.loadDataFile('tables');
    if (!tiles || !tables || !this.app.worker) {
      return false;
    }
    if (this.tileMapEntity === null) {
      this.tileMapEntity = new TileMapEntity(this.model.desktopEntity, 0, 0);
      this.tileMapEntity.setTiles(tiles);
      this.model.desktopEntity.addEntity(this.tileMapEntity);
    }
    this.tables = tables;
    this.lightRuns = AttractTitle.landingLightRuns(tables);
    this.restart();
    return true;
  } // start

  /** (re)starts the worker at the start counter */
  restart() {
    this.running = true;
    this.complete = false;
    this.paletteBank = false;
    this.app.worker.postMessage({
      id: 'init',
      initData: {
        headless: false,
        tables: this.tables,
        inputScript: [],                          // no coin: the attract mode
        fastForwardAttract: this.options.start,
        pauseAtAttract: this.options.end,
        attract: true
      }
    });
  } // restart

  /** stops the worker (it is idle until the next 'init') */
  stop() {
    if (this.running) {
      this.running = false;
      this.app.worker.postMessage({id: 'reset'});
    }
  } // stop

  /** the worker runs `factor` times faster from now on */
  hurry(factor) {
    if (this.running) {
      this.app.worker.postMessage({id: 'speed', factor: factor});
    }
  } // hurry

  /** a message of the worker (the model hands them over) */
  handleWorkerMessage(data) {
    if (data.id != 'frame' || !this.running || this.tileMapEntity === null) {
      return;
    }
    if (data.page) {
      this.animateLandingLights(data.page, data.frame || 0);
      if (this.options.clearTexts) {
        AttractTitle.clearTitleTexts(data.page, this.tables);
      }
      if (this.options.clearForeground) {
        AttractTitle.clearForeground(data.page);
      }
      this.tileMapEntity.setVramBytes(data.page);
    }
    if ('paletteBank' in data) {
      if (this.paletteBank === false && typeof data.attract == 'number' && data.attract >= AttractTitle.PALETTE_FREEZE_COUNTER) {
        this.paletteBank = this.tileMapEntity.paletteBank;
      }
      this.tileMapEntity.setPaletteBank(this.paletteBank === false ? data.paletteBank : this.paletteBank);
    }
    if ('scroll' in data) {
      this.tileMapEntity.setScroll(data.scroll);
    }
    if (this.complete) {
      return;
    }
    if (data.stopped || (typeof data.attract == 'number' && data.attract >= this.options.end)) {
      this.complete = true;
      if (this.options.loop && !data.stopped) {
        this.restart();
      } else if (this.options.onEnd) {
        this.options.onEnd(this);
      }
    }
  } // handleWorkerMessage

  /**
   * A reader of the program ROM image kept in data/tables.json (the tables the
   * worker rebuilds the ROM from): returns a function of an address.
   */
  static romReader(tables) {
    var list = tables && tables.tables ? tables.tables : tables;
    return function(addr) {
      for (var i = 0; i < list.length; i++) {
        var start = typeof list[i].addr == 'string' ? parseInt(list[i].addr, 16) : list[i].addr;
        if (addr >= start && addr < start+list[i].data.length) {
          return list[i].data[addr-start];
        }
      }
      return 0;
    };
  } // romReader

  /**
   * The four runs of landing_anim_table (37C0h, 4 bytes an entry: count, step,
   * VRAM address) as page offsets.
   */
  static landingLightRuns(tables) {
    var byte = AttractTitle.romReader(tables);
    var runs = [];
    for (var e = 0; e < 4; e++) {
      var p = 0x37C0+e*4;
      runs.push({n: byte(p), step: byte(p+1), offset: ((byte(p+2) << 8) | byte(p+3)) & 0xFFF});
    }
    return runs;
  } // landingLightRuns

  /**
   * The lights of the landing runway at the bottom of the title run as they do
   * in the landing phase (landing_anim_tiles 3400h: every other frame one of
   * the four runs of 37C0h advances its background tiles 78h-7Bh by one, run =
   * (frame >> 1) & 3). The original leaves them still during the title.
   * Stateless: the page of every frame is shifted by the number of steps its
   * run has had up to that frame, so nothing depends on frames lost or hurried.
   */
  animateLandingLights(page, frame) {
    var ticks = frame >> 1;                       // one anim tick every other frame
    this.lightRuns.forEach((run, e) => {
      var phase = ticks < e ? 0 : (Math.floor((ticks-e)/4)+1) & 3;
      if (phase === 0) {
        return;
      }
      var a = run.offset;
      for (var i = 0; i < run.n; i++) {
        var t = page[a];
        if ((t & 0xFC) === 0x78) {
          page[a] = 0x78 | ((t+phase) & 3);
        }
        a = (a+run.step) & 0xFFF;
      }
    });
  } // animateLandingLights

  /**
   * Clears the foreground below the score header (rows 3-31 of all 26
   * columns, as clear_fg 0380h does): the monsters of the showcase, the
   * dancing pictures and the texts go, the score header stays.
   * @param {Uint8Array} page - The VRAM page (4096 bytes), changed in place.
   */
  static clearForeground(page) {
    for (var col = 0; col < 26; col++) {
      page.fill(0, (col << 5)+3, (col << 5)+32);
    }
  } // clearForeground

  /**
   * Takes the texts out of the title picture: the seven letters of PLEIADS
   * (the blocks of the showcase table 1AB0h — 4 bytes an entry [dest hi, dest
   * lo, data lo, columns], 7 rows each, laid at dest + 081Eh into the
   * background) and the copyright rows 28-29 of the foreground ("© 1981",
   * "TEHKAN INTERNATIONAL CORP.", text rows 1960h/1980h).
   * @param {Uint8Array} page - The VRAM page (4096 bytes), changed in place.
   * @param {Object} tables - data/tables.json (the ROM image the blocks are read from).
   */
  static clearTitleTexts(page, tables) {
    var byte = AttractTitle.romReader(tables);
    for (var e = 0; e < 7; e++) {
      var entry = 0x1AB0+e*4;
      var dest = (((byte(entry) << 8) | byte(entry+1))+0x081E) & 0xFFF;
      var columns = byte(entry+3);
      for (var c = 0; c < columns; c++) {
        for (var r = 0; r < 7; r++) {
          page[(dest+r-c*0x20) & 0xFFF] = 0;
        }
      }
    }
    for (var col = 0; col < 26; col++) {
      page[(col << 5)+28] = 0;
      page[(col << 5)+29] = 0;
    }
  } // clearTitleTexts

} // AttractTitle
