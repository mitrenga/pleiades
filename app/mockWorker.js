// begin code

/**
 * Mock game worker (PL-M4 UI development). Same postMessage/onmessage surface
 * and the same messages as app/gameWorker.js (WORKER-PROTOCOL.md), but it runs
 * in the main thread and only simulates a game: it starts from the phase 1
 * VRAM dump in data/screens.json (initData.screens.phase1Start), animates the
 * hardware scroll, blinks the palette bank, moves a "ship" tile under the
 * left/right controls, and turns fire into score, a 'fire' sound event and
 * eventually roundComplete; holding LEFT+RIGHT+FIRE together loses a life so
 * the game over path can be exercised. Selected by MainModel.useMockWorker().
 *
 * Headless use (tools/smoke-model.mjs): initData.headless = true and 'tick'
 * messages, exactly as with the real worker.
 */
var TICK_MS = 1000/61.035;
var FG_COLS = 26, ROWS = 32;

export class MockWorker {

  constructor(screens) {
    this.screens = screens || {};
    this.onmessage = null;
    this.timer = 0;
    this.reset();
  } // constructor

  reset() {
    clearTimeout(this.timer);
    this.timer = 0;
    this.running = false;
    this.paused = false;
    this.headless = false;
    this.controls = {left: false, right: false, fire: false};
    this.page = new Uint8Array(0x1000);
    this.paletteBank = 0;
    this.scroll = 0;
    this.frame = 0;
    this.score = 0;
    this.hiScore = 0;
    this.lives = 3;
    this.state = 'intro';
    this.sounds = [];
    this.shipCol = 12;
    this.shipTile = 0;
    this.fireLatch = false;
    this.deathLatch = false;
    this.lastTime = false;
    this.accumulator = 0;
    this.gameOverPosted = false;
    this.roundCompletePosted = false;
  } // reset

  // the model side calls this like Worker.postMessage
  postMessage(msg) {
    switch (msg.id) {
      case 'init':
        this.reset();
        var initData = msg.initData || {};
        this.headless = !!initData.headless;
        this.hiScore = initData.hiScore || 0;
        this.lives = (initData.dip && initData.dip.lives) || 3;
        var screen = this.screens.phase1Start;
        if (screen) {
          this.page.set(MockWorker.hexToBytes(screen.page).subarray(0, 0x1000));
          this.paletteBank = screen.paletteBank || 0;
          this.scroll = screen.scroll || 0;
        }
        this.shipTile = this.findShipTile();
        this.drawShip(this.shipCol, this.shipTile);
        this.running = true;
        if (!this.headless) {
          this.loop();
        }
        break;
      case 'controls':
        this.controls.left = !!msg.left;
        this.controls.right = !!msg.right;
        this.controls.fire = !!msg.fire;
        break;
      case 'pause':
        this.paused = true;
        clearTimeout(this.timer);
        break;
      case 'continue':
        if (this.running) {
          this.paused = false;
          this.lastTime = false;
          clearTimeout(this.timer);
          if (!this.headless) {
            this.loop();
          }
        }
        break;
      case 'tick':
        if (this.running) {
          this.tick();
          this.postFrame();
        }
        break;
      case 'reset':
        this.reset();
        break;
    }
  } // postMessage

  send(msg) {
    if (this.onmessage) {
      this.onmessage({data: msg});
    }
  } // send

  // the highest fg tile code found in the lowest rows: a plausible "ship" tile
  findShipTile() {
    for (var row = ROWS-1; row >= 3; row--) {
      for (var col = 0; col < FG_COLS; col++) {
        var code = this.page[col*ROWS+row];
        if (code) {
          return code;
        }
      }
    }
    return 0x41;
  } // findShipTile

  drawShip(col, code) {
    this.page[col*ROWS+ROWS-3] = code;
  } // drawShip

  tick() {
    this.frame++;
    if (this.state == 'intro') {
      if (this.frame > 60) {
        this.state = 'wave';
      }
      return;
    }
    if (this.state == 'dying') {
      if ((this.frame & 3) == 0) {
        this.paletteBank = (this.paletteBank+1) & 3;
      }
      if (this.frame % 120 == 0) {
        this.paletteBank = 0;
        this.state = this.lives > 0 ? 'wave' : 'gameOver';
      }
      return;
    }
    if (this.state == 'gameOver' || this.state == 'roundEnd') {
      return;
    }
    // scroll the stars one pixel every other frame (sign = TileMapRender.SCROLL_SIGN)
    if (this.frame & 1) {
      this.scroll = (this.scroll+1) & 255;
    }
    // ship
    var col = this.shipCol;
    if (this.controls.left && (this.frame & 3) == 0) {
      col = Math.max(0, col-1);
    }
    if (this.controls.right && (this.frame & 3) == 0) {
      col = Math.min(FG_COLS-1, col+1);
    }
    if (col != this.shipCol) {
      this.drawShip(this.shipCol, 0);
      this.shipCol = col;
      this.drawShip(col, this.shipTile);
    }
    // death: hold left+right+fire
    if (this.controls.left && this.controls.right && this.controls.fire) {
      if (!this.deathLatch) {
        this.deathLatch = true;
        this.lives--;
        this.sounds.push('death');
        this.state = 'dying';
        this.frame = 0;
        return;
      }
    } else {
      this.deathLatch = false;
    }
    // fire: edge triggered
    if (this.controls.fire && !this.fireLatch) {
      this.sounds.push('fire');
      this.score += 10;
      if (this.score > this.hiScore) {
        this.hiScore = this.score;
      }
      // a bg tile "explodes": clear the next non-empty bg tile
      var bg = this.page.subarray(0x800, 0xB40);
      for (var i = 0; i < bg.length; i++) {
        if (bg[i]) {
          bg[i] = 0;
          this.sounds.push('hit');
          break;
        }
      }
      if (this.score >= 300) {
        this.state = 'roundEnd';
      }
    }
    this.fireLatch = this.controls.fire;
  } // tick

  postFrame() {
    this.send({
      id: 'frame',
      frame: this.frame,
      page: this.page.slice(0),
      paletteBank: this.paletteBank,
      scroll: this.scroll,
      score: this.score,
      hiScore: this.hiScore,
      lives: this.lives,
      state: this.state,
      sounds: this.sounds
    });
    this.sounds = [];
    if (this.state == 'gameOver' && !this.gameOverPosted) {
      this.gameOverPosted = true;
      this.send({id: 'gameOver', score: this.score});
    }
    if (this.state == 'roundEnd' && !this.roundCompletePosted) {
      this.roundCompletePosted = true;
      this.send({id: 'roundComplete'});
    }
  } // postFrame

  loop() {
    var now = Date.now();
    if (this.lastTime === false) {
      this.lastTime = now;
    }
    this.accumulator = Math.min(250, this.accumulator+now-this.lastTime);
    this.lastTime = now;
    var ticked = false;
    while (this.accumulator >= TICK_MS) {
      this.tick();
      this.accumulator -= TICK_MS;
      ticked = true;
    }
    if (ticked) {
      this.postFrame();
    }
    if (this.running && !this.paused) {
      this.timer = setTimeout(() => this.loop(), Math.max(1, TICK_MS-this.accumulator));
    }
  } // loop

  terminate() {
    this.reset();
  } // terminate

  static hexToBytes(hex) {
    var bytes = new Uint8Array(hex.length/2);
    for (var i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substr(i*2, 2), 16);
    }
    return bytes;
  } // hexToBytes

} // MockWorker
