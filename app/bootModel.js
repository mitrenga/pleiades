const { AbstractModel } = await import('./svision/js/abstractModel.js?ver='+window.srcVersion);
const { BorderEntity } = await import('./borderEntity.js?ver='+window.srcVersion);
const { AttractTitle } = await import('./attractTitle.js?ver='+window.srcVersion);
// begin code

/**
 * Boot model of the remake — the counterpart of svision's ZXResetModel on the
 * 208x256 monitor of the game (the Space Invaders pattern, app/bootModel.js
 * there). Pleiads has no power-on sequence to show either (the reset clears
 * the RAM and goes straight to the attract mode), so the boot plays the part
 * of the attract everybody remembers: the title, from the attract counter
 * 01B1h (right after the score table screen is cleared and the copyright rows
 * drawn) through the planet, the PLEIADS letters with the morphing monsters,
 * the copyright and the dance of the two pictures, to 04B0h, where the
 * original goes on with the demo game (PL-M7). AttractTitle plays it (the game
 * worker runs the original program, the picture is its own); the finished
 * title holds for a second, then the menu, which keeps a shorter stretch of
 * the same title looping as its backdrop.
 *
 * Any key, mouse button or touch ends the boot at once; the menu then waits
 * for the application data, should they still be on their way.
 */
export class BootModel extends AbstractModel {

  /**
   * @param {Object} app - The application instance.
   */
  constructor(app) {
    super(app);
    this.id = 'BootModel';

    this.title = null;         // the AttractTitle playing the worker into the screen
    this.dataRequested = false; // the title's files asked from the server (R-062)
    this.finished = false;     // the menu handover is under way
    this.attempts = 0;         // waits for the ROM data of appData.db
  } // constructor

  /**
   * the attract counter where the boot begins: 01B0h clears the score table
   * screen (L_01E1, two frames with the table still on), 01B1h is the first
   * frame of the cleared screen with the copyright rows — so nothing of the
   * score table flashes by
   */
  static get START_COUNTER() { return 0x1B1; }
  /** ... and where it ends: the dance of the two pictures is over (04AFh), the demo game would follow */
  static get END_COUNTER() { return 0x4B0; }
  /** how long the finished title stays before the menu */
  static get HOLD_MS() { return 1000; }

  newBorderEntity() {
    return new BorderEntity(false, false);
  } // newBorderEntity

  init() {
    super.init();

    this.borderEntity.bkColor = '#000000';
    this.desktopEntity.bkColor = '#000000';

    this.title = new AttractTitle(this, {
      start: BootModel.START_COUNTER,
      end: BootModel.END_COUNTER,
      loop: false,
      clearTexts: false,
      onEnd: () => this.sendEvent(BootModel.HOLD_MS, {id: 'finishBoot'})   // the finished title stays a moment
    });
    this.sendEvent(0, {id: 'startBoot'});
  } // init

  shutdown() {
    super.shutdown();
    this.title.stop();
  } // shutdown

  /** the frames of the worker (GameApp routes them to the current model) */
  handleWorkerMessage(event) {
    this.title.handleWorkerMessage(event.data);
  } // handleWorkerMessage

  handleEvent(event) {
    if (super.handleEvent(event)) {
      return true;
    }

    switch (event.id) {
      case 'startBoot':
        // on the first visit the data may still be on their way (the fetch
        // gives up after 2 s): a few retries before the title is skipped
        if (this.title.start()) {
          // safety net: the title is about 13 s long
          this.sendEvent(30000, {id: 'finishBoot'});
          return true;
        }
        if (!this.app.appDataPending() && !this.dataRequested) {
          // the application data have come, but the title's files are not
          // in localStorage (full or cleared): the model gets them from the
          // server and the title starts on them (R-062)
          this.dataRequested = true;
          this.loadDataFiles(['tiles', 'tables'], (files) => {
            if (files && this.app.model === this && !this.finished) {
              this.sendEvent(0, {id: 'startBoot'});
            }
          });
        }
        if (++this.attempts < 6) {
          this.sendEvent(400, {id: 'startBoot'});
        } else {
          this.sendEvent(0, {id: 'finishBoot'});
        }
        return true;
      case 'finishBoot':
        // the title is over (or could not be played): the menu
        if (this.finished) {
          return true;
        }
        this.finished = true;
        this.cancelEvent('finishBoot');
        this.cancelEvent('startBoot');
        this.title.stop();
        this.sendEvent(0, {id: 'menuWhenReady'});
        return true;
      case 'setMenuModel':
        // not before the application data has come or failed
        // (AbstractApp.appDataPending): on a slow line the boot stays
        if (this.app.appDataPending()) {
          this.sendEvent(100, {id: 'setMenuModel'});
          return true;
        }
        this.app.setModel('MenuModel');
        return true;
      case 'keyPress':
        // any key, mouse button or touch ends the boot at once
        if (this.desktopEntity.modalEntity) {
          break;
        }
        this.sendEvent(0, {id: 'finishBoot'});
        return true;
      case 'menuWhenReady':
        // a key can end the boot before the application data have arrived:
        // the menu waits for the request to be over (AbstractApp.appDataPending,
        // however long a slow line takes), then comes up at once
        if (this.app.appDataPending()) {
          this.sendEvent(100, {id: 'menuWhenReady'});
        } else {
          this.app.setModel('MenuModel');
        }
        return true;
      case 'retryLoadAppData':
        // sent by the error panel's RETRY button: reload the application data
        // and retry the menu handover once the request is over (setMenuModel
        // waits for it; offline there is none and the app falls back to
        // storage at once)
        this.app.loadAppData();
        this.sendEvent(0, {id: 'setMenuModel'});
        return true;
    }

    return false;
  } // handleEvent

  loopModel(timestamp) {
    super.loopModel(timestamp);
    this.drawModel();
  } // loopModel

} // BootModel
