// begin code

/**
 * Pure (DOM-free) rendering of the Pleiads video hardware state: two 2-bpp
 * tile layers (background with a vertical hardware scroll, foreground with
 * pixel 0 transparent) on a 208x256 portrait screen (26 columns x 32 rows of
 * 8x8 tiles, GAME-DESIGN chap. 2). Used by TileMapEntity (browser) and by
 * tools/render-screen.mjs (Node, headless tests). Everything lives in the
 * single TileMapRender object, so the bundle gains one global name only.
 *
 * Tile data: data/tiles.json produced by tools/rom2tiles.mjs — tiles are stored
 * already rotated into the player orientation as 64-char strings of '0'..'3';
 * palette[colorCode*4+pixel] = '#rrggbb', colorCode = (code>>5) | (fg ? 8 : 0)
 * | (paletteBank<<4).
 *
 * VRAM page (4 KiB, the original's 4000h-4FFFh): fg = 0x000-0x33F, bg =
 * 0x800-0xB3F; byte offset a (within a layer): row = a & 31, column =
 * 25-(a>>5) (4000h is the top-right corner, +1 = one row down, +0x20 = one
 * column to the LEFT). Verified against the refemu dumps (score header on top,
 * text left to right).
 *
 * SCROLL (register 5800h): MAME set_scrollx(value) on the hardware-oriented
 * tilemap; tilemap.cpp effective_rowscroll computes `m_dx - rowscroll`, so the
 * tilemap pixel tx lands at hardware screen x = tx - scroll (mod 256). ROT90
 * maps hardware x to the player's y, hence background tile row r is drawn at
 * player y = r*8 - scroll (mod 256): a DECREASING scroll value moves the
 * background DOWN and the row entering at the top is row (scroll>>3) — exactly
 * how the program feeds new rows (notes/D: 43B9h-- while flying, S_0650 writes
 * row 43B1h-- at the top). SCROLL_SIGN is the single place to flip this should
 * the MAME comparison (PL-M8) disagree.
 */
export const TileMapRender = {
  SCREEN_WIDTH: 208,
  SCREEN_HEIGHT: 256,
  COLUMNS: 26,
  ROWS: 32,
  FG_OFFSET: 0x000,
  BG_OFFSET: 0x800,
  LAYER_SIZE: 0x340,
  SCROLL_SIGN: -1,   // player y of bg row r = r*8 + SCROLL_SIGN*scroll

  /**
   * Parses a '#rrggbb' color into [r, g, b].
   * @param {string} color
   * @returns {number[]}
   */
  parseColor(color) {
    return [parseInt(color.substr(1, 2), 16), parseInt(color.substr(3, 2), 16), parseInt(color.substr(5, 2), 16)];
  }, // parseColor

  /**
   * Converts the tiles.json palette into a flat Uint8Array [r,g,b]*256.
   * @param {Object} tiles - tiles.json content
   * @returns {Uint8Array}
   */
  paletteRGB(tiles) {
    var rgb = new Uint8Array(256*3);
    for (var i = 0; i < 256; i++) {
      var c = this.parseColor(tiles.palette[i]);
      rgb[i*3] = c[0]; rgb[i*3+1] = c[1]; rgb[i*3+2] = c[2];
    }
    return rgb;
  }, // paletteRGB

  /**
   * Decodes one tile string into 64 pixel values.
   * @param {string} tile - 64 chars '0'..'3'
   * @returns {Uint8Array}
   */
  tilePixels(tile) {
    var pixels = new Uint8Array(64);
    for (var i = 0; i < 64; i++) {
      pixels[i] = tile.charCodeAt(i)-48;
    }
    return pixels;
  }, // tilePixels

  /**
   * Color code of a tile (palette entry base = colorCode*4).
   * @param {number} code - tile code 0..255
   * @param {boolean} fg - foreground layer
   * @param {number} paletteBank - 0..3
   * @returns {number} 0..63
   */
  colorCode(code, fg, paletteBank) {
    return (code >> 5) | (fg ? 8 : 0) | ((paletteBank & 3) << 4);
  }, // colorCode

  /**
   * Blits one tile into an RGBA buffer at (x0, y0) with vertical wrap,
   * optionally skipping pixel 0 (foreground transparency).
   */
  blitTile(rgba, width, height, pixels, rgb, base, x0, y0, transparent) {
    for (var y = 0; y < 8; y++) {
      var py = (y0+y) & (height-1);
      for (var x = 0; x < 8; x++) {
        var pix = pixels[y*8+x];
        if (transparent && pix == 0) {
          continue;
        }
        var di = (py*width+x0+x)*4;
        var ci = (base+pix)*3;
        rgba[di] = rgb[ci]; rgba[di+1] = rgb[ci+1]; rgba[di+2] = rgb[ci+2]; rgba[di+3] = 255;
      }
    }
  }, // blitTile

  /**
   * Renders a VRAM page to RGBA pixels (208*256*4): background first (scrolled),
   * then the foreground with pixel 0 transparent — MAME screen_update_phoenix.
   * @param {Object} tiles - tiles.json content ({bg, fg, palette})
   * @param {Uint8Array} page - 4096 bytes (4000h-4FFFh of the selected page)
   * @param {number} paletteBank - 0..3 (bits 1-2 of register 5000h)
   * @param {number} scroll - 0..255 (register 5800h)
   * @returns {Uint8ClampedArray}
   */
  renderVramToRgba(tiles, page, paletteBank, scroll) {
    var width = this.SCREEN_WIDTH, height = this.SCREEN_HEIGHT;
    var rgba = new Uint8ClampedArray(width*height*4);
    var rgb = this.paletteRGB(tiles);
    var s = ((this.SCROLL_SIGN*(scroll & 255)) % height+height) % height;
    var a, code, col, row;
    for (a = 0; a < this.LAYER_SIZE; a++) {
      code = page[this.BG_OFFSET+a];
      col = this.COLUMNS-1-(a >> 5);
      row = a & 31;
      this.blitTile(rgba, width, height, this.tilePixels(tiles.bg[code]), rgb, this.colorCode(code, false, paletteBank)*4, col*8, (row*8+s) & 255, false);
    }
    for (a = 0; a < this.LAYER_SIZE; a++) {
      code = page[this.FG_OFFSET+a];
      col = this.COLUMNS-1-(a >> 5);
      row = a & 31;
      this.blitTile(rgba, width, height, this.tilePixels(tiles.fg[code]), rgb, this.colorCode(code, true, paletteBank)*4, col*8, row*8, true);
    }
    return rgba;
  }, // renderVramToRgba

  /**
   * Decodes a hex string into bytes (screens.json pages).
   * @param {string} hex
   * @returns {Uint8Array}
   */
  hexToBytes(hex) {
    var bytes = new Uint8Array(hex.length/2);
    for (var i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substr(i*2, 2), 16);
    }
    return bytes;
  } // hexToBytes

}; // TileMapRender
