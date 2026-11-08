const { RasterEntity } = await import('./svision/js/platform/canvas2D/rasterEntity.js?ver='+window.srcVersion);
const { TileMapRender } = await import('./tileMapRender.js?ver='+window.srcVersion);
// begin code

/**
 * Shows the Pleiads video state: background tile layer (26x32, hardware
 * vertical scroll 0..255, wraps) under the foreground tile layer (no scroll,
 * pixel 0 transparent — MAME set_transparent_pen(0), screen_update_phoenix draws
 * bg then fg). Each tile is rendered once per (layer, code, palette bank) as an
 * decoded pixel array kept in a tile cache; the whole picture is composed into
 * {@link RasterEntity}'s frame (logical 208x256) only when the VRAM/scroll/bank
 * changed, and blitted scaled by the layout ratio.
 * Orientation, VRAM mapping and the scroll sign are documented in
 * tileMapRender.js (SCROLL_SIGN).
 */
export class TileMapEntity extends RasterEntity {

  constructor(parentEntity, x, y) {
    super(parentEntity, x, y, TileMapRender.SCREEN_WIDTH, TileMapRender.SCREEN_HEIGHT, false, false);
    this.id = 'TileMapEntity';

    this.tiles = null;
    this.rgb = null;
    this.paletteBank = 0;
    this.scroll = 0;
    this.page = new Uint8Array(0x1000);
    this.tileCache = {};      // key (layer<<8 | code) -> Uint8Array(64) pixel values
    this.fgBlank = true;
    /** false until the first page of video memory has arrived */
    this.vramReady = false;
  } // constructor

  /**
   * Loads the tile set and palette (data/tiles.json content).
   */
  setTiles(data) {
    this.tiles = data;
    this.rgb = TileMapRender.paletteRGB(data);
    this.fgBlank = /^0+$/.test(data.fg[0]);
    this.tileCache = {};
    this.invalidate();
  } // setTiles

  setPaletteBank(bank) {
    bank &= 3;
    if (bank != this.paletteBank) {
      this.paletteBank = bank;
      this.invalidate();
    }
  } // setPaletteBank

  setScroll(px) {
    px &= 255;
    if (px != this.scroll) {
      this.scroll = px;
      this.invalidate();
    }
  } // setScroll

  /**
   * Sets the whole VRAM page (Uint8Array 4096 = 4000h-4FFFh of the selected page;
   * fg 0x000-0x33F, bg 0x800-0xB3F, other bytes ignored).
   */
  setVramBytes(page) {
    this.page.set(page.subarray(0, 0x1000));
    this.vramReady = true;
    this.invalidate();
  } // setVramBytes

  /**
   * Convenience: sets the layers from two 832-byte arrays in VRAM order.
   */
  setVram(fgArray, bgArray) {
    this.page.set(fgArray.subarray ? fgArray.subarray(0, 0x340) : fgArray.slice(0, 0x340), TileMapRender.FG_OFFSET);
    this.page.set(bgArray.subarray ? bgArray.subarray(0, 0x340) : bgArray.slice(0, 0x340), TileMapRender.BG_OFFSET);
    this.vramReady = true;
    this.invalidate();
  } // setVram

  /**
   * Composes bg (scrolled, wrapped) and fg into the whole logical screen in one
   * pass. RasterEntity calls it only when the cache is dirty.
   * Uses the same pixel routine as the headless renderer (TileMapRender.blitTile),
   * so the browser picture is by construction identical to tools/render-screen.mjs.
   * Per-tile canvases and repeated drawImage() calls were avoided on purpose:
   * WebKit (Safari macOS/iOS) rendered wrong tiles with that approach.
   */
  paintRaster(rgba) {
    var width = this.width, height = this.height;
    var cols = TileMapRender.COLUMNS;
    var s = ((TileMapRender.SCROLL_SIGN*this.scroll) % height+height) % height;
    var a, code, col, row;
    for (a = 0; a < TileMapRender.LAYER_SIZE; a++) {
      code = this.page[TileMapRender.BG_OFFSET+a];
      col = cols-1-(a >> 5);
      row = a & 31;
      TileMapRender.blitTile(rgba, width, height, this.tilePixels(0, code), this.rgb, TileMapRender.colorCode(code, false, this.paletteBank)*4, col*8, (row*8+s) & 255, false);
    }
    for (a = 0; a < TileMapRender.LAYER_SIZE; a++) {
      code = this.page[TileMapRender.FG_OFFSET+a];
      if (code == 0 && this.fgBlank) {
        continue;   // fg tile 0 is fully transparent
      }
      col = cols-1-(a >> 5);
      row = a & 31;
      TileMapRender.blitTile(rgba, width, height, this.tilePixels(1, code), this.rgb, TileMapRender.colorCode(code, true, this.paletteBank)*4, col*8, row*8, true);
    }
  } // paintRaster

  /**
   * Decoded pixels (Uint8Array 64) of a tile, cached per (layer, code).
   */
  tilePixels(layer, code) {
    var key = (layer << 8) | code;
    var pixels = this.tileCache[key];
    if (!pixels) {
      pixels = this.tileCache[key] = TileMapRender.tilePixels(layer ? this.tiles.fg[code] : this.tiles.bg[code]);
    }
    return pixels;
  } // tilePixels

  /**
   * Nothing is drawn before the tile set **and** the first page of video memory
   * have arrived. Without the tiles there are no pixels to compose at all;
   * without the video memory the page is still all zeroes, which composes into
   * a screenful of tile 0.
   */
  drawEntity() {
    if (this.tiles === null || !this.vramReady) {
      return;
    }
    super.drawEntity();
  } // drawEntity

} // TileMapEntity
