// begin code

/**
 * Pleiads game worker (PL-M4/PL-M5) — a 1:1 JavaScript rewrite of the
 * original Tehkan 1981 program (8085A, sources/asm/pleiades/pleiads.asm) for
 * the whole single-player game: "coin + start -> state 1 (get ready) -> state
 * 2 (init) -> state 3 with the phases 0 (planet scroll), 1 (wave 1), 2 (flight
 * between the waves), 3 (mothership), 4 (picture), 5 (wave 2 with the five
 * targets), 6 (planet), 7 (landing) -> state 6 (bonus explosion after wave 2)
 * / state 7 (landing bonus -> next round) / death (state 4, phase rollback
 * L_0BA0) / game over (state 5)". The addresses in the comments ([xxxx],
 * S_xxxx, L_xxxx) point to the original routines.
 *
 * Memory model: the worker keeps the two 4 KiB RAM/VRAM pages of the board
 * (4000h-4FFFh; the selected one is sent to the model) and the game
 * variables LIVE in that memory at their original addresses (43A4 game_state,
 * 43B8 stage_round, 4B70 enemy slots, ...), so every byte can be compared with
 * the reference emulator (tools/refemu, tools/regress.mjs). The page the
 * hardware displays (5000h bit 0) is the one sent to the model (page 0 unless
 * state 0 switches to player 2, copy_ram_page). The program ROM
 * tables are rebuilt from data/tables.json (tools/rom2tables.mjs) into a
 * sparse 16 KiB ROM image and read at their original addresses.
 *
 * Control flow: the original main loop [001A] waits for the falling edge of
 * /VBLANK in wait_vblank_read_inputs [0080] (once per frame, 61.035 Hz) and
 * some routines wait for a second frame inside (clear_screens_init [0140]).
 * The program is therefore written as a generator: every `yield` is one
 * wait_vblank_read_inputs and tick() = read the inputs + run the program to
 * the next wait. Frame numbering equals the reference emulator: frame 0 is
 * the reset, the CPU spends frames 0-3 clearing the RAM (BOOT_FRAMES), the
 * first wait ends at the VBLANK of frame 4. The default input script (coin at
 * frames 10-14, 1P start at 40-44) is the one of
 * sources/reference/input-start.txt: state 1 begins at frame 48, phase 1 at
 * frame 210 (values sampled at the start of VBLANK of frame n = state after
 * the tick of frame n-1).
 *
 * Attract mode (2026-09-12, for the boot of the remake, app/bootModel.js):
 * ported up to the counter 0x4E5 — the title texts, the planet, the PLEIADS
 * title with the morphing monsters, the copyright with the two dancing
 * pictures (attract_ship_anim); the demo game (0x4E6) is PL-M7. Not ported: the
 * 2-player game after the page switch (cocktail), ROM checksums (they add 0
 * for the original ROM). The worker stops (`stopped`) only on those paths,
 * i.e. after the game over when the attract mode reaches the counter 0x4E6.
 */

var TICK_MS = 1000/61.035;   // 45056 T-states at 2.75 MHz
var BOOT_FRAMES = 4;         // frames the original CPU spends in hw_reset_clear_ram [0050]

// ---------------------------------------------------------------- memory
var rom = new Uint8Array(0x4000);
var romKnown = new Uint8Array(0x4000);   // 1 = byte delivered by data/tables.json
var pages = [new Uint8Array(0x1000), new Uint8Array(0x1000)];   // 4000h-4FFFh, bit 0 of 5000h selects
var videoreg = 0;    // last write to 5000h: bit0 page, bits 1-2 palette
var scrollReg = 0;   // 5800h
var soundA = 0;      // 6000h latch A
var soundB = 0;      // 6800h latch B
var sod = 0;         // 8085 SOD pin (SIM), shot sound trigger
var in0 = 0xF7;      // 7000h (active low: bit0 coin, bit1 start1, bit2 start2, bit4 fire, bit5 right, bit6 left)
var dsw = 0x60;      // 7800h bits 0-6 (bit 7 = /VBLANK, not modelled)
var strictRom = false;

function loadTables(tables) {
  rom.fill(0);
  romKnown.fill(0);
  var list = tables && tables.tables ? tables.tables : tables;
  if (!Array.isArray(list)) {
    throw new Error('gameWorker: initData.tables missing (data/tables.json)');
  }
  list.forEach(function(t) {
    var addr = typeof t.addr == 'string' ? parseInt(t.addr, 16) : t.addr;
    for (var i = 0; i < t.data.length; i++) {
      rom[addr+i] = t.data[i];
      romKnown[addr+i] = 1;
    }
  });
} // loadTables

function rd(a) {
  a &= 0xFFFF;
  if (a < 0x4000) {
    if (strictRom && !romKnown[a]) {
      throw new Error('gameWorker: read of ROM byte not in tables.json: ' + a.toString(16));
    }
    return rom[a];
  }
  if (a < 0x5000) {
    return pages[videoreg & 1][a & 0xFFF];
  }
  if ((a & 0xF800) === 0x7000) {
    return in0;
  }
  if ((a & 0xF800) === 0x7800) {
    return dsw & 0x7F;
  }
  return 0xFF;
} // rd

function wr(a, v) {
  a &= 0xFFFF;
  v &= 0xFF;
  if (a < 0x4000) {
    return;
  }
  if (a < 0x5000) {
    pages[videoreg & 1][a & 0xFFF] = v;
    return;
  }
  switch (a & 0xF800) {
    case 0x5000: videoreg = v; break;
    case 0x5800: scrollReg = v; break;
    case 0x6000: soundA = v; break;
    case 0x6800: soundB = v; break;
  }
} // wr

// 8-bit helpers
function u8(v) { return v & 0xFF; }
function rlc(a) { return ((a << 1) | (a >> 7)) & 0xFF; }
function rrc(a) { return ((a >> 1) | (a << 7)) & 0xFF; }
function bcdAdd(a, b, cy) {   // one DAA step of add_bcd_score [0220] (valid BCD operands)
  var s = (a >> 4)*10 + (a & 15) + (b >> 4)*10 + (b & 15) + cy;
  return {v: (Math.floor((s % 100)/10) << 4) | (s % 10), cy: s >= 100 ? 1 : 0};
} // bcdAdd
function bcdToInt(hi, mid, lo) {
  var n = 0;
  [hi, mid, lo].forEach(function(b) { n = n*100 + (b >> 4)*10 + (b & 15); });
  return n;
} // bcdToInt

// ---------------------------------------------------------------- frame / input state
var frameNo = 0;            // number of the frame whose VBLANK the program waits for next
var inputScript = [];       // [{frame, in0}] — headless/base input (coin, start)
var controls = {left: false, right: false, fire: false};
var soundEvents = [];
var program = null;         // the generator (main program)
var stopped = false;        // unsupported code path reached / game over
var stopReason = '';
var lastStage = -1;         // 43B8 of the last posted frame (roundComplete detection)
var gameOverPosted = false;
var initData = {};
var lastTime = false, accumulator = 0, nextLoop = false, paused = false;
var speed = 1;              // {id:'speed'}: the game time runs this many times faster (the boot hurries)

function scriptIn0(frame) {
  var v = 0xF7;
  for (var i = 0; i < inputScript.length; i++) {
    if (inputScript[i].frame <= frame) {
      v = inputScript[i].in0;
    }
  }
  return v;
} // scriptIn0

function currentIn0() {
  // bits 0-2 (coin/start) come from the script, the controls clear bits 4-6, bit 3 (protection) = 0
  var v = scriptIn0(frameNo);
  if (controls.fire) { v &= ~0x10; }
  if (controls.right) { v &= ~0x20; }
  if (controls.left) { v &= ~0x40; }
  return v & 0xF7;
} // currentIn0

function unsupported(what) {
  stopped = true;
  stopReason = what;
  if (typeof console !== 'undefined') {
    console.warn('gameWorker: stopped — ' + what + ' (frame ' + frameNo + ')');
  }
} // unsupported

// ---------------------------------------------------------------- wait_vblank_read_inputs [0080]
function readInputs() {
  in0 = currentIn0();
  var prev = rd(0x43A0);
  wr(0x43A0, in0);                       // in0_cur
  wr(0x43A1, prev);                      // in0_prev
  inc16(0x439B);                         // frame_ctr lo/hi [0200]
  var credits = rd(0x438F);
  if (credits === 9) {
    return;
  }
  if (credits > 9) {                     // JNC L_0000 — reset; never happens with cleared RAM
    unsupported('credits > 9 (reset)');
    return;
  }
  if (inputEdge(0x01)) {                 // coin
    credits++;
    wr(0x438F, credits);
    wr(0x4142, credits + 0x20);
  }
} // readInputs

// input_edge [00BB]: bit B of IN0 just went 0 (active) — (~cur & B) & prev
function inputEdge(b) {
  return ((~rd(0x43A0)) & b & rd(0x43A1)) !== 0;
} // inputEdge

// inc16 [0200]: (HL) = lo, (HL-1) = hi
function inc16(lo) {
  var v = u8(rd(lo) + 1);
  wr(lo, v);
  if (v === 0) {
    wr(lo-1, rd(lo-1) + 1);
  }
} // inc16

// ---------------------------------------------------------------- VRAM helpers
function colLeft(de) { return (de + 0x20) & 0xFFFF; }    // vram_col_left [0210]
function colRight(de) { return (de - 0x20) & 0xFFFF; }   // vram_col_right [0217]

// print_bcd [00C4]: HL = lowest BCD byte, DE = right digit, B = digits
function printBcd(hl, de, b) {
  while (true) {
    wr(de, (rd(hl) & 0x0F) | 0x20);
    de = colLeft(de);
    if (--b === 0) { return; }
    wr(de, (rd(hl) >> 4) | 0x20);
    de = colLeft(de);
    hl--;
    if (--b === 0) { return; }
  }
} // printBcd

// draw_text_blocks [01D0]: C records of 32 B: [hi,lo dest][4 pad][26 tiles], drawn to the right
function drawTextBlocks(hl, c) {
  while (c-- > 0) {
    var de = (rd(hl) << 8) | rd(hl+1);
    hl = (hl & 0xFF00) | u8(hl + 6);
    for (var b = 0; b < 26; b++) {
      wr(de, rd(hl));
      hl++;
      de = colRight(de);
    }
  }
} // drawTextBlocks

// clear_fg [0380]: clears rows 3-31 of all 26 columns — the header rows 0-2 (SCORE labels, digits, COIN)
// survive (the loop writes down to L&1F == 3 and then skips 4 bytes)
function clearFg() {
  for (var col = 0; col < 26; col++) {
    for (var row = 3; row < 32; row++) {
      wr(0x4000 + (col << 5) + row, 0);
    }
  }
} // clearFg

function clearBg() {   // clear_bg [03A0]
  for (var a = 0x4800; a <= 0x4B3F; a++) { wr(a, 0); }
} // clearBg

function zeroBlock(hl, b) {   // zero_block [05D8]
  while (b-- > 0) { wr(hl++, 0); }
} // zeroBlock

function copyBlock(hl, de, b) {   // copy_block [05E0]
  while (b-- > 0) { wr(de++, rd(hl++)); }
} // copyBlock

// draw_tile_block [0AD6]: B rows x C columns from HL (column-major) to DE, next column to the right
function drawTileBlock(hl, de, b, c) {
  while (c-- > 0) {
    var d = de;
    for (var i = 0; i < b; i++) {
      wr(d++, rd(hl++));
    }
    de = colRight(de);
  }
} // drawTileBlock

// blit_2x2_from_1400 [07DC]: 4 tiles from HL: column (rows y, y+1), column to the right
function blit2x2(hl, de) {
  wr(de, rd(hl));
  wr(de+1, rd(hl+1));
  de = colRight(de);
  wr(de, rd(hl+2));
  wr(de+1, rd(hl+3));
} // blit2x2

// xy_to_vram [09BA]: object X,Y at BC -> VRAM address (hi,lo) at DE via column_vram_table 0A00h
function xyToVram(bc, de) {
  var hl = 0x0A00 + ((rd(bc) & 0xF8) >> 2);
  wr(de, rd(hl));
  wr(de+1, u8(((rd(bc+1) & 0xF8) >> 3) + rd(hl+1)));
} // xyToVram

// ---------------------------------------------------------------- sprites (S_0718)
// object record 4 B: flags (bit3 active, bit4 drawn, bits 0-2 type, bits 5-7 type copy), shape, X, Y
// shadow 4 B: old VRAM address (hi,lo), current VRAM address (hi,lo)
function spriteEraseThenDraw(bc, sh) {   // sprite_erase_then_draw [0718]
  spriteErase(bc, sh);
  spriteDraw(bc, sh);
} // spriteEraseThenDraw

function spriteErase(bc, sh) {   // sprite_erase [0720]
  var flags = rd(bc);
  if (!(flags & 0x10)) {
    return;
  }
  wr(bc, flags & 0xEF);
  var de = (rd(sh) << 8) | rd(sh+1);
  switch ((flags >> 5) & 7) {   // sprite_erase_table [0738]
    case 0:   // erase_1x1 [0763]
      wr(de, 0);
      break;
    case 1:   // erase_2x1 [0779]
      wr(de, 0);
      wr(colRight(de), 0);
      break;
    case 3:   // erase_1x2 [079E]
      wr(de, 0);
      wr(de+1, 0);
      break;
    case 4:   // erase_2x2 [07BE]
      wr(de, 0);
      wr(de+1, 0);
      de = colRight(de+1);
      wr(de, 0);
      wr(de-1, 0);
      break;
  }
} // spriteErase

function spriteDraw(bc, sh) {   // sprite_draw [0740]
  var flags = rd(bc);
  if (!(flags & 0x08)) {
    return;
  }
  var type = flags & 7;
  wr(bc, type | (type << 5) | 0x18);
  var de = (rd(sh+2) << 8) | rd(sh+3);
  var shape = rd(bc+1);
  var hl = 0x1400 + shape;
  switch (type) {   // sprite_draw_table [075B]
    case 0:   // draw_1x1 [076D]: shape = tile code
      wr(de, shape);
      break;
    case 1:   // draw_2x1 [0788]
      wr(de, rd(hl));
      wr(colRight(de), rd(hl+1));
      break;
    case 3:   // draw_1x2 [07AA]
      wr(de, rd(hl));
      wr(de+1, rd(hl+1));
      break;
    case 4:   // draw_2x2 [07D2]
      blit2x2(hl, de);
      break;
  }
} // spriteDraw

// ---------------------------------------------------------------- state machine [0400]
function dispatchState() {
  switch (rd(0x43A4)) {   // JT_040E
    case 0: state0(); break;
    case 1: state1(); break;
    case 2: state2(); break;
    case 3: state3(); break;
    case 4: state4(); break;
    case 5: state5(); break;
    case 6: state6(); break;
    case 7: state7(); break;
    default: unsupported('game state ' + rd(0x43A4) + ' (RAM corrupted)'); break;
  }
} // dispatchState

// state 0 [0430]: player switch / round start
function state0() {
  wr(0x43A4, 1);
  wr(0x43A5, 0x80);
  var a = rd(0x43A3);
  wr(0x43A3, 0);
  if (a === 2) {          // intro: first start
    return;
  }
  wr(0x43A3, a);
  if (rd(0x43A2) === 1) { // single player
    return;
  }
  if (a === 0) {          // switch_to_player2 [04A0]: player 2 plays on page 1
    wr(0x43A3, 1);
    copyRamPage(0, 1);
    return;
  }
  if (rd(0x4390) === 0) {
    return;
  }
  wr(0x43A3, 0);
  copyRamPage(1, 0);
} // state0

// copy_ram_page [0460]: page B -> page C, byte by byte through 5000h: the foreground rows 0-3 of all 26
// columns (the score header), 4380h-43B7h (scores, credits, attract counter, game mode / state) and
// 4BC0h-4BFFh. The last write to 5000h is C: the destination page stays selected, palette bits cleared.
function copyRamPage(b, c) {
  var copy = function(a) {
    wr(0x5000, b);
    var v = rd(a);
    wr(0x5000, c);
    wr(a, v);
  };
  for (var col = 0; col < 26; col++) {
    for (var row = 0; row < 4; row++) {
      copy(0x4000 + (col << 5) + row);
    }
  }
  for (var a = 0x4380; a < 0x43B8; a++) { copy(a); }
  for (a = 0x4BC0; a < 0x4C00; a++) { copy(a); }
} // copyRamPage

// state 1 [04AC]: "get ready" — blinking score, timer 43A5 80h -> 0
function state1() {
  var a = u8(rd(0x43A5) - 1);
  wr(0x43A5, a);
  wr(0x43A4, 2);
  if (a === 0) {
    return;
  }
  wr(0x43A4, 1);
  if (a === 0x7F) {       // L_07F0
    wr(0x5800, rd(0x43B9));
    clearFg();
    initShip();
    return;
  }
  wr(0x439A, 0);
  wr(0x439B, 0);
  var de = rd(0x43A3) ? 0x4021 : 0x4261;
  if (a & 0x08) {         // L_04E6: score erased (blink)
    for (var b = 0; b < 6; b++) {   // clear_tiles_row [04FB]
      wr(de, 0);
      de = colLeft(de);
    }
    return;
  }
  drawTextBlocks(0x1800, 1);   // draw_score_label [0508]
  printBcd(rd(0x43A3) ? 0x4387 : 0x4383, de, 6);
} // state1

function initShip() {   // init_ship [052A]: 43C0..43C3 = 0C,10,64,D8
  copyBlock(0x0538, 0x43C0, 4);
  calcPlayerVram();
} // initShip

// state 2 [0510]: round/phase initialisation
function state2() {
  wr(0x43A4, 3);
  // clear_game_ram [05EA]
  zeroBlock(0x43C4, 0x3C);
  zeroBlock(0x4350, 0x30);
  zeroBlock(0x4392, 6);
  zeroBlock(0x439A, 4);
  zeroBlock(0x4B50, 0x9C);
  // init_bg_ptrs [0580]: 8 B from 0598h + 4*(43B8&6) -> 43B0..43B7
  copyBlock(0x0598 + ((rd(0x43B8) & 6) << 2), 0x43B0, 8);
  if (rd(0x43A2)) {       // wave_ptr_score_offset [0570]
    wr(0x43B5, rd(0x43B5) + (rd(0x4383) & 0x70));
  }
  // init_enemy_slots [05B8]
  for (var i = 0; i < 8; i++) {
    wr(0x4B70 + 4*i, 0x04);
    wr(0x4B71 + 4*i, 0x08);
    wr(0x4B72 + 4*i, 0x80);
    wr(0x4B73 + 4*i, 0x80);
  }
  if (rd(0x43BB)) {
    initMothershipSlots();
  }
} // state2

// init_mothership_slots [32C4]: 4B70-4BEF cleared, 8*43BB bytes of the initial slots 3F80h (even round)
// or 3FC0h (odd round) -> 4B70 (used by phase 3; runs already in the phase 2 init because 43BB = 8)
function initMothershipSlots() {
  var c = rlc(rlc(rlc(rd(0x43BB))));
  zeroBlock(0x4B70, 0x80);
  var e = u8(0x40 - c + 0x70);
  var hl = 0x3F00 | u8(e + 0x10);
  if (rd(0x43B8) & 0x10) {
    hl = 0x3F00 | u8((hl & 0xFF) + 0x40);
  }
  copyBlock(hl, 0x4B00 | e, c);
} // initMothershipSlots

// state 3 [0078]: the game — dispatch_stage [0800] + set_palette [06BC]
function state3() {
  switch (rd(0x43B8) & 0x0F) {   // JT_0814
    case 0: phaseIntroWait(); break;
    case 1:
    case 5: stageWave(); break;
    case 2: phase2ScrollDown(); break;
    case 3: phase3Mothership(); break;
    case 4: phase4Picture(); break;
    case 6: phase6PlanetScroll(); break;
    case 7: phase7Landing(); break;
  }
  setPalette();
} // state3

function setPalette() {   // set_palette [06BC]
  var b = rlc(rd(0x43B8)) & 0x0C;
  var a;
  if (b === 0x0C) {       // L_06EA
    b |= (rd(0x43B8) & 0x10) >> 3;
    if (rd(0x43A4) === 7) {
      b++;
    }
    a = b;
  } else {
    a = u8(rd(0x43BA) + rd(0x43BB) - 1);
    if (a >= 3) {
      a = 3;
    }
    a |= b;
  }
  wr(0x5000, rd(0x0420 + a) | (rd(0x43A3) & 1));
} // setPalette

// phase 0 [0614]: one background row per frame, scroll 0, 43B6 countdown -> state 2, phase+1
function phaseIntroWait() {
  drawBgRowRle();
  phaseIntroCommon();
} // phaseIntroWait

// phase 4 [053C]: the picture 1B40h (4 rows x 11 columns) at 43B0/43B1, then like phase 0
function phase4Picture() {
  drawTileBlock(0x1B40, (rd(0x43B0) << 8) | rd(0x43B1), 4, 11);
  phaseIntroCommon();
} // phase4Picture

// phase_intro_common [0617]: scroll 0, 43B6 countdown -> state 2, phase+1 (phase 0: clear the BG block)
function phaseIntroCommon() {
  wr(0x5800, 0);
  wr(0x43B9, 0);
  var t = u8(rd(0x43B6) - 1);
  wr(0x43B6, t);
  if (t !== 0) {
    return;
  }
  wr(0x43A4, 2);
  var a = rd(0x43B8);
  wr(0x43B8, a + 1);
  if (a & 0x0F) {
    return;
  }
  clearBgBlock();
} // phaseIntroCommon

// clear_bg_block [062E]: 10 columns x 5 rows from 4A3Bh (LXI B,050Ah: B = rows, C = columns)
function clearBgBlock() {
  var de = 0x4A3B;
  for (var c = 0; c < 10; c++) {
    for (var b = 0; b < 5; b++) {
      wr(de + b, 0);
    }
    de = colRight(de);
  }
} // clearBgBlock

// draw_bg_row_rle [0650]: one row of 26 background tiles from RLE data (43B2/43B3) to (43B0/43B1)
function drawBgRowRle() {
  var de = (rd(0x43B0) << 8) | rd(0x43B1);
  var hl = (rd(0x43B2) << 8) | rd(0x43B3);
  do {
    var a = rd(hl), b = 1;
    if (a === 0) {          // 00, n = n empty tiles
      hl++;
      b = rd(hl);
    }
    if (a === 0x3F) {       // 3F, n = n times tile 3Fh
      hl++;
      b = rd(hl);
    }
    hl++;
    do {
      wr(de, a);
      de = colRight(de);
    } while (--b !== 0);
  } while ((de >> 8) !== 0x47);
  wr(0x43B1, rd(0x43B1) - 1);
  wr(0x43B2, hl >> 8);
  wr(0x43B3, hl & 0xFF);
} // drawBgRowRle

// phase 2 [2280]: flight between the waves — clear one BG row, scroll down, then phase 3
function phase2ScrollDown() {
  var de = 0x4B00 | (((rd(0x43B9) >> 3) & 0x1F) + 0x20);
  do {
    wr(de, 0);
    de = colRight(de);
  } while ((de >> 8) !== 0x47);
  updatePlayer();             // S_2060
  drawPlayerShipTiles();
  if (rd(0x439B) & 1) {
    return;
  }
  var s = u8(rd(0x43B9) - 1);
  wr(0x43B9, s);
  wr(0x5800, s);
  if (s !== 0) {
    return;
  }
  wr(0x43B8, rd(0x43B8) + 1);
  clearFg();
} // phase2ScrollDown

// draw_player_ship_tiles [33BC]: ship tiles from 1B70h+(43C2&6)+(439B bit) at 43E2/43E3 + 2
function drawPlayerShipTiles() {
  var de = (((rd(0x43E2) << 8) | rd(0x43E3)) + 2) & 0xFFFF;
  var hl = 0x1B70 + (rd(0x43C2) & 6) + (rlc(rd(0x439B)) & 8);
  wr(de, rd(hl));
  de = colRight(de);
  wr(de, rd(hl+1));
  if ((rd(0x43B8) & 0x0F) !== 2) {
    return;
  }
  // phase 2: the same two tiles once more one row lower (DCR L, INR E, vram_col_left, S_33E6)
  de = colLeft(de+1);
  wr(de, rd(hl));
  de = colRight(de);
  wr(de, rd(hl+1));
} // drawPlayerShipTiles

// ---------------------------------------------------------------- phase 1/2 wave [0834]
function stageWave() {
  updatePlayer();                       // S_0876
  if (checkBulletHits()) {              // S_0DF0 (all 5 targets hit -> goto_bonus_state pops 2 levels)
    return;
  }
  sideTaskDispatch();                   // S_23AB
  var b = rd(0x4392);                   // frame_ctr_play (old value in B)
  wr(0x4392, b + 1);
  var left = rd(0x43BA);
  if (left === 0) {
    waveCleared(b);
    return;
  }
  if (left < 2 && lastEnemySpeedup(b)) {
    return;
  }
  if (b & 1) {                          // phase12_odd_half [0864]
    enemiesMoveAll();
    enemiesAnimAll();
    enemiesUpdateVram();
    updateExplosions();                 // phase12_odd_tail [086D]
    groundEffectsUpdate();
  } else {
    enemiesDrawAll();
    spawnFsm();
    checkShipCollision();
    enemyFireCheck();                   // phase12_even_tail [085C]
    updateEnemyBullets();
  }
} // stageWave

// last_enemy_speedup [0D58]: on rounds >= 1 the last enemy runs both halves per frame
function lastEnemySpeedup(b) {
  if (!(b & 1)) {
    wr(0x4394, 1);
  }
  if (rd(0x4394) === 0) {
    return false;
  }
  if ((rd(0x43B8) & 0xF0) === 0) {
    return false;
  }
  // phase12_double_step [08C0]
  enemiesDrawAll();
  spawnFsm();
  checkShipCollision();
  enemiesMoveAll();
  enemiesAnimAll();
  enemiesUpdateVram();
  if (rd(0x4392) & 1) {
    enemyFireCheck();
    updateEnemyBullets();
  } else {
    updateExplosions();
    groundEffectsUpdate();
  }
  return true;
} // lastEnemySpeedup

// wave_cleared [21F6] / wave_end_countdown [2204]: 43BA == 0
function waveCleared(b) {
  if (b & 1) {
    updateEnemyBullets();
    updateExplosions();
    groundEffectsUpdate();
  }
  waveEndCountdown();
} // waveCleared

// wave_end_countdown [2204]: 4394 up to 60h, then state 2 and the next phase (also after the mothership)
function waveEndCountdown() {
  var ctr = u8(rd(0x4394) + 1);
  wr(0x4394, ctr);
  if (ctr < 0x60) {
    return;
  }
  wr(0x43A4, 2);
  wr(0x4360, 0xFF);
  if ((rd(0x43B8) & 0x0E) === 4) {   // after phase 2 -> start_state6_explosion [0CF0]
    wr(0x4BDC, 0x49);
    wr(0x4BDD, 0xA9);
    gotoBonusState();
    return;
  }
  var old = rd(0x43B8);
  wr(0x43B8, old + 1);
  if ((old & 0x0E) === 0) {          // after phase 1: init_mothership_hp [2274]
    wr(0x43BB, 8);
    wr(0x43BC, 0);
    clearFg();
    return;
  }
  wr(0x43BA, 0x10);
  clearFg();
} // waveEndCountdown

function gotoBonusState() {   // goto_bonus_state [0CF8]
  wr(0x439D, rd(0x4BDE));
  wr(0x43A4, 6);
  wr(0x43A5, 0x60);
  wr(0x4363, 0xFF);
  wr(0x43B8, rd(0x43B8) + 1);
} // gotoBonusState

// ---------------------------------------------------------------- player [0876]
function updatePlayer() {
  playerObjsDraw();
  // player_shadows_shift [0886]: current VRAM address -> old, 3 records
  shadowShiftLoop(0x43EB, 3);
  updateBullets();              // S_08A0
  calcPlayerVram();             // S_09A0
  calcShipHitbox();             // S_097A
} // updatePlayer

function playerObjsDraw() {   // player_objs_draw [0700]: ship, bullet 1, bullet 2
  for (var i = 0; i < 3; i++) {
    spriteEraseThenDraw(0x43C0 + 4*i, 0x43E0 + 4*i);
  }
} // playerObjsDraw

// shadow_shift_loop [088B]: HL = last byte of the last shadow, B records backwards
function shadowShiftLoop(hl, b) {
  while (b-- > 0) {
    var d = rd(hl), e = rd(hl-1);
    wr(hl-2, d);
    wr(hl-3, e);
    hl -= 4;
  }
} // shadowShiftLoop

function updateBullets() {   // update_bullets [08A0]
  moveShip();
  fireOrMoveBullet(0x43C4);
  if ((rd(0x43B8) & 0x0F) === 5) {
    fireOrMoveBullet(0x43C8);
  } else if (rd(0x43C8) & 0x08) {
    moveBulletUp(0x43C8);
  }
} // updateBullets

function moveShip() {   // move_ship [08E0]
  if ((rd(0x43B8) & 0x0F) >= 6) {
    landingControls();
    return;
  }
  // move_ship_joystick [08F8]: 1 px/frame, X in 8..C0h, left has priority
  var a = (~rd(0x43A0)) & 0x60;
  if (a) {
    var x = rd(0x43C2);
    if (a & 0x40) {
      if (x >= 9) { wr(0x43C2, x - 1); }
    } else if (x < 0xC0) {
      wr(0x43C2, x + 1);
    }
  }
  setShapeByX(0x43C2, 0x1600);
} // moveShip

// set_shape_by_x [0926]: [rec+1] = table[X & 7]
function setShapeByX(hlX, table) {
  wr(hlX - 1, rd(table + (rd(hlX) & 7)));
} // setShapeByX

function fireOrMoveBullet(hl) {   // fire_or_move_bullet [0930]
  if (rd(hl) & 0x08) {
    moveBulletUp(hl);
    return;
  }
  if (!inputEdge(0x10)) {
    return;
  }
  wr(0x43A1, rd(0x43A1) & 0xEF);   // consume the edge (in0_prev bit 4)
  wr(hl, rd(hl) | 0x08);
  wr(hl+2, rd(0x43C2) + 4);
  wr(hl+3, rd(0x43C3) - 8);
  setShapeByX(hl+2, 0x1620);
  wr(0x4361, 0x30);                // bullet_sound
  soundEvents.push('playerShot');
} // fireOrMoveBullet

function moveBulletUp(hl) {   // move_bullet_up [0964]: Y -= 8, gone below 1Fh
  var y = u8(rd(hl+3) - 8);
  wr(hl+3, y);
  if (y < 0x1F) {
    wr(hl, rd(hl) & 0xF7);   // L_096E
  }
} // moveBulletUp

function calcShipHitbox() {   // calc_ship_hitbox [097A]
  var x = rd(0x43C2);
  var hl = 0x0B38 + ((x & 7) << 1);
  wr(0x439E, x - rd(hl));
  wr(0x439F, x + rd(hl+1));
} // calcShipHitbox

function calcPlayerVram() {   // calc_player_vram [09A0]
  xyToVram(0x43C2, 0x43E2);
  xyToVram(0x43C6, 0x43E6);
  xyToVram(0x43CA, 0x43EA);
} // calcPlayerVram

// ---------------------------------------------------------------- bullet hits [0DF0]
function checkBulletHits() {
  if (checkBulletTile(0x43C4, 0x43E6)) {
    return true;
  }
  return checkBulletTile(0x43C8, 0x43EA);
} // checkBulletHits

// check_bullet_tile [0E04]: BG tile under the shot: 3Eh trail -> erase, 2Ch-3Dh scenery -> ground hit,
// otherwise FG tile 60h-CFh = enemy (hitbox 2AC0h) -> find the slot; returns true when the fifth target
// was hit (goto_bonus_state [0CF8] pops two return addresses = the rest of stage_wave is skipped)
function checkBulletTile(bc, hl) {
  if (!(rd(bc) & 0x08)) {
    return false;
  }
  var d = u8(rd(hl) + 8), e = rd(hl+1);
  var de = (d << 8) | e;
  var k = u8(rd(de) - 0x2C);
  if (k === 0x12) {              // shot_erase_trail [0E3C]
    wr(de, 0);
    shotHitScenery(bc, hl, e);
    return false;
  }
  if (k < 0x12) {                // target_piece_hit [0E50]
    if (k === 3) {
      var mask = rd(0x3E00 + rlc(rlc(rlc(u8(e - 0x69)))));
      var hit = rd(0x43BC) | mask;
      wr(0x43BC, hit);
      if (hit === 0x1F) {
        gotoBonusState();
        return true;
      }
    }
    shotHitScenery(bc, hl, e);
    return false;
  }
  var tile = rd((rd(hl) << 8) | e);
  if (tile < 0x60 || tile >= 0xD0) {
    return false;
  }
  var hb = 0x2AC0 + ((tile & 7) << 2);
  var x7 = rd(bc+2) & 7;
  if (x7 >= rd(hb)) { return false; }
  if (x7 < rd(hb+1)) { return false; }
  // shot_find_enemy [0E70]
  var sx = u8((rd(bc+2) & 0xF8) + rd(hb+2));
  var sy = rd(bc+3) & 0xF8;
  for (var slot = 0x4B70; slot < 0x4B90; slot += 4) {
    if ((rd(slot) & 0x08) && checkBulletVsEnemy(slot, sx, sy, bc)) {
      return false;
    }
  }
  return false;
} // checkBulletTile

// shot_hit_scenery [0E3E]: the shot is gone, ground explosion 88h at the FG address
function shotHitScenery(bc, hl, e) {
  wr(bc, rd(bc) & 0xF7);
  wr(0x4366, 0xFF);   // tile_hit_flag
  soundEvents.push('tileHit');
  groundHitAlloc(0x88, rd(hl), e);
} // shotHitScenery

// check_bullet_vs_enemy [0C00]: shot in (X-3, X+2] x (Y-8, Y+8] -> score by shape index, enemy_killed
function checkBulletVsEnemy(slot, sx, sy, bc) {
  var x = rd(slot+2), y = rd(slot+3);
  if (u8(x - 3) >= sx) { return false; }
  if (u8(x + 2) < sx) { return false; }
  if (u8(y - 8) >= sy) { return false; }
  if (u8(y + 8) < sy) { return false; }
  var idx = rd(slot+1);
  var d, e;
  if (idx < 0x30) { d = 0x39; e = 0x08; }        // formation: 80 points
  else if (idx < 0xC0) { d = 0x53; e = 0x03; }   // attack: 30 points
  else { d = 0x1F; e = 0x15; }                   // diagonal: 150 points
  // enemy_kill_score_select [0C2A]: last enemy of the wave — bonus by round
  if (rd(0x43BA) < 2) {
    e = u8((rd(0x43B8) & 0x70) + 0x10 + e);
    d = 0x1A;
  }
  // enemy_killed [0EA4]
  wr(bc, rd(bc) & 0xF7);
  spawnExplosionSlot(slot, d, e);
  return true;
} // checkBulletVsEnemy

// spawn_explosion_slot [0EAD]: deactivate the enemy, explosion slot 4370/74/78/7C = [D, E, VRAM hi, lo], 43BA--
function spawnExplosionSlot(slot, d, e) {
  wr(slot, rd(slot) & 0xF7);
  var sh = (slot & 0xFF00) | u8(slot + 0x42);
  var b = rd(sh), c = rd(sh+1);
  var hl = 0x4370;
  if (rd(hl) & 0x1F) {
    hl = 0x4374;
    if (rd(hl) & 0x1F) {
      hl = 0x4378;
      if (rd(hl) & 0x1F) {
        hl = 0x437C;
      }
    }
  }
  wr(hl, d);
  wr(hl+1, e);
  wr(hl+2, b);
  wr(hl+3, c);
  // set_hit_sound [0EF0]
  if (e < 0x10) {
    wr(0x4364, 0xFF);
    soundEvents.push('enemyHit');
  } else {
    wr(0x4369, 0xFF);
    soundEvents.push('enemyHitBig');
  }
  wr(0x43BA, rd(0x43BA) - 1);
} // spawnExplosionSlot

// ---------------------------------------------------------------- enemy vs ship [0F08]
function checkShipCollision() {
  var de = (rd(0x43E2) << 8) | rd(0x43E3);
  // scan_tiles_range [0F56]: 2x2 tiles at the ship for 60h-CFh
  var found = false;
  for (var c = 0; c < 2 && !found; c++) {
    for (var b = 0; b < 2; b++) {
      var t = rd(de + b);
      if (t >= 0x60 && t < 0xD0) {
        found = true;
        break;
      }
    }
    de = colRight(de);
  }
  if (!found) {
    return;
  }
  var lo = u8(rd(0x439E) - 0x0A), hi = rd(0x439F);
  for (var slot = 0x4B70; slot < 0x4B90; slot += 4) {
    if ((rd(slot) & 0x08) && shipVsEnemySlot(slot, lo, hi)) {
      return;
    }
  }
} // checkShipCollision

// ship_vs_enemy_slot [0F38]: Y in [D4h, E7h), X in [439E-0A, 439F) -> kill_player, 50 points
function shipVsEnemySlot(slot, lo, hi) {
  var y = rd(slot+3);
  if (y < 0xD4 || y >= 0xE7) { return false; }
  var x = rd(slot+2);
  if (x >= hi) { return false; }
  if (x < lo) { return false; }
  killPlayer();
  spawnExplosionSlot(slot, 0x39, 0x05);
  return true;
} // shipVsEnemySlot

function killPlayer() {   // kill_player [0CC4]
  wr(0x43A4, 4);
  wr(0x43A5, 0x60);
  wr(0x4363, 0xFF);
  soundEvents.push('shipExplosion');
} // killPlayer

// ---------------------------------------------------------------- side tasks [23AB]
function sideTaskDispatch() {
  switch ((rd(0x43B8) & 4) | (rd(0x4392) & 3)) {   // JT_23C4
    case 0: bgAnimPhase1(); break;
    case 1: formationTrail(0x4B70); formationTrail(0x4B74); break;
    case 2: formationTrail(0x4B78); formationTrail(0x4B7C); break;
    case 3: formationTrail(0x4B80); formationTrail(0x4B84); break;
    case 4: targetSpawn(); break;             // L_0A9C (phase 5)
    case 5: targetAnim(); break;              // L_0ABC
    case 6: drawTargetBonus(); break;         // L_09D4
    case 7: drawTargetIndicators(); break;    // L_37D0
  }
} // sideTaskDispatch

// bg_anim_phase1 [215C]: animated background tiles from bg_anim_table 2230h
function bgAnimPhase1() {
  var a = rd(0x4392);
  var c = rrc(rrc(rrc(a)));
  var hl, de;
  if (a < 0xC0) {
    hl = 0x2200 + u8((c & 0x18) + 0x30 + (a & 4));
    de = (rd(hl) << 8) | rd(hl+1);
    wr(de, rd(0x2200 + u8((c & 7) + rd(hl+2))));
    return;
  }
  // L_2184: entries 6/7 — when the 2x2 block at the address holds tiles 4xh, redraw it from 22xxh
  hl = 0x2200 + ((a & 4) + 0x48);
  de = (rd(hl) << 8) | rd(hl+1);
  var l = rd(0x2200 + u8((c & 7) + rd(hl+2)));
  var src = 0x2200 | l;
  var t = rd(de) & rd(de+1) & rd(de - 0x20) & rd(de - 0x1F);
  if ((t & 0xF0) !== 0x40) {
    return;
  }
  wr(0x4362, 0x08);   // sound_ctr
  soundEvents.push('ping');
  // S_21C0: tile 70h and the ship on the left -> second player object 43C8 (tile 57h)
  if (l === 0x70 && rd(0x43C2) < 0x50 && !(rd(0x43C8) & 0x08)) {
    wr(0x43C8, rd(0x43C8) | 0x08);
    wr(0x43C9, 0x57);
    if ((de & 0xFF) === 0xD8) {
      wr(0x43CA, 0x1F);
      wr(0x43CB, 0xB8);
    } else {
      wr(0x43CA, 0x2F);
      wr(0x43CB, 0xC0);
    }
    wr(0x43EA, 0);
    wr(0x43EB, 0);
  }
  blit2x2(src, de);
} // bgAnimPhase1

// formation_trail [2454]: formation enemy (shape < 28h) leaves tile 3Eh in the BG two rows below
function formationTrail(hl) {
  if (!(rd(hl) & 0x08)) { return; }
  if (rd(hl+1) >= 0x28) { return; }
  var sh = (hl & 0xFF00) | u8(hl + 0x42);
  var de = (u8(rd(sh) + 8) << 8) | u8(rd(sh+1) + 2);
  if (rd(de) !== 0) { return; }
  wr(de, 0x3E);
} // formationTrail

// ---------------------------------------------------------------- enemies
function enemiesDrawAll() {   // enemies_draw_all [0A50]
  for (var i = 0; i < 8; i++) {
    spriteEraseThenDraw(0x4B70 + 4*i, 0x4BB0 + 4*i);
  }
} // enemiesDrawAll

function enemiesMoveAll() {   // enemies_move_all [0D1C]
  for (var i = 0; i < 8; i++) {
    enemyMoveStep(0x4B70 + 4*i, 0x4B50 + 2*i);
  }
} // enemiesMoveAll

// enemy_move_step [0D30]: cmd = [script ptr]; X += 1700h[2*cmd], Y += 1700h[2*cmd+1];
// both coordinates on a tile boundary -> next command
function enemyMoveStep(rec, ptr) {
  if (!(rd(rec) & 0x08)) {
    return;
  }
  var script = (rd(ptr) << 8) | rd(ptr+1);
  var hl = 0x1700 + rlc(rd(script));
  var x = u8(rd(rec+2) + rd(hl));
  var y = u8(rd(rec+3) + rd(hl+1));
  wr(rec+2, x);
  wr(rec+3, y);
  if ((x | y) & 7) {
    return;
  }
  var lo = u8(rd(ptr+1) + 1);
  wr(ptr+1, lo);
  if (lo === 0) {
    wr(ptr, rd(ptr) + 1);
  }
} // enemyMoveStep

function enemiesAnimAll() {   // enemies_anim_all [0D70]
  for (var i = 0; i < 8; i++) {
    enemySelectTile(0x4B70 + 4*i, 0x4B50 + 2*i);
  }
} // enemiesAnimAll

// enemy_select_tile [0D86]: shape = 1600h[base + phase], mode/base from 16C0h[cmd]; cmd 0 = script end
function enemySelectTile(rec, ptr) {
  if (!(rd(rec) & 0x08)) {
    return;
  }
  var cmd = rd((rd(ptr) << 8) | rd(ptr+1));
  if (cmd === 0) {                     // enemy_script_end [0DD8]
    wr(rec, rd(rec) & 0xF7);
    return;
  }
  var hl = 0x1600 | u8(rlc(cmd) + 0xC0);
  var mode = rd(hl), base = rd(hl+1);
  var x = rd(rec+2), y = rd(rec+3), a;
  if (mode & 1) {                      // anim_mode_xy16 [0DB4]
    a = u8(u8((rrc(y) & 3) + base) + (rlc(x) & 0x0C));
  } else if (mode & 2) {               // anim_mode_x [0DC6]
    a = u8((rrc(x) & 3) + base);
  } else {                             // Y phase
    a = u8((rrc(y) & 3) + base);
  }
  wr(rec+1, rd(0x1600 | a));           // anim_store_tile [0DCC]
} // enemySelectTile

// enemies_update_vram [0A6C]: active or drawn enemies: current address -> old, X,Y -> current
function enemiesUpdateVram() {
  for (var i = 0; i < 8; i++) {
    var rec = 0x4B70 + 4*i, sh = 0x4BB0 + 4*i;
    if (!(rd(rec) & 0x18)) {
      continue;
    }
    wr(sh, rd(sh+2));
    wr(sh+1, rd(sh+3));
    xyToVram(rec+2, sh+2);
  }
} // enemiesUpdateVram

// ---------------------------------------------------------------- spawn automaton [3000]
// 4393 counts up every even frame and selects the sub-state routine to try; each routine
// runs only when 4BD0 equals its number (so the automaton advances at most one state per 8 frames)
function spawnFsm() {
  var a = rd(0x4393);
  wr(0x4393, a + 1);
  switch (a & 3) {   // JT_3016
    case 0: spawnSt0Wait(); break;
    case 1: spawnSt1Count(); break;
    case 2: spawnSt2(); break;
    case 3: spawnSt3Place(); break;
  }
} // spawnFsm

function spawnSt0Wait() {   // spawn_st0_wait [3020]
  if (rd(0x4BD0) !== 0) {
    return;
  }
  var delay = rd(0x4BD2);
  if (delay === 0) {
    spawnLoadWave();
    return;
  }
  delay = u8(delay - 1);
  wr(0x4BD2, delay);
  if (delay & 3) {
    return;
  }
  if ((rd(0x4BD1) & 0xF0) === 0) {
    return;
  }
  wr(0x4BD1, rd(0x4BD1) - 0x10);
  wr(0x4BD0, 1);
} // spawnSt0Wait

// spawn_load_wave [303F]: 4 B from the wave table [43B4:43B5] -> 4BD1..4BD4, pointer wraps in its 128 B half
function spawnLoadWave() {
  wr(0x4BD9, 0xFF);
  var hl = (rd(0x43B4) << 8) | rd(0x43B5);
  copyBlock(hl, 0x4BD1, 4);
  var l = (hl + 4) & 0xFF;
  if ((l & 0x7F) === 0) {
    l = u8(l + 0x80);
  }
  wr(0x43B5, l);
  var c = (difficultyCalc() >> 1) & 0x3F;
  var a = u8(rd(0x4BD2) - c);
  var borrow = rd(0x4BD2) < c;
  wr(0x4BD2, 3);
  if (borrow || a < 4) {
    return;
  }
  wr(0x4BD2, a);
} // spawnLoadWave

// difficulty_calc [3078]: C = ((43B8>>2)&1C) + (10h - 43BA) + min(1Fh, (439A>>1)&7F)
function difficultyCalc() {
  var c = rrc(rrc(rd(0x43B8))) & 0x1C;
  c = u8(0x10 - rd(0x43BA) + c);
  var a = rrc(rd(0x439A)) & 0x7F;
  if (a >= 0x20) {
    a = 0x1F;
  }
  return u8(a + c);
} // difficultyCalc

function spawnSt1Count() {   // spawn_st1_count [30A0]: 4BE4 = active enemies
  if (rd(0x4BD0) !== 1) {
    return;
  }
  var b = 0;
  for (var i = 0; i < 8; i++) {
    if (rd(0x4B70 + 4*i) & 0x08) {
      b++;
    }
  }
  wr(0x4BE4, b);
  wr(0x4BD0, 0);
  var a = u8(rd(0x43BA) - b);
  if (a === 0) {
    return;
  }
  wr(0x4BD0, 2);
  var n = rd(0x4BD1) & 0x0F;
  wr(0x4BD7, n);
  if (n < a) {
    return;
  }
  wr(0x4BD7, a);
} // spawnSt1Count

function spawnSt2() {   // spawn_st2 [3194]
  if (rd(0x4BD0) !== 2) {
    return;
  }
  wr(0x4BD0, 3);
  var f = u8(rd(0x4BD9) + 1);
  wr(0x4BD9, f);
  if (f !== 0) {
    return;
  }
  spawnSelectScript();
} // spawnSt2

// spawn_select_script [30DE]: index into attack_script_ptrs 2800h -> 4BD5:4BD6
function spawnSelectScript() {
  var a = u8(rd(0x43C2) - rd(0x4BD3));
  var d = 0;
  if (rd(0x43C2) < rd(0x4BD3)) {
    a = u8(-a);
    d = 0x20;
  }
  var b = a;
  var e = rrc(rrc(rrc(a))) & 0x1F;
  var c = (difficultyCalc() >> 1) & 0x3F;
  a = (b & 0x0F) - c;
  if (a < 0) {
    a = 0;
  }
  a = u8(a + e);
  if (a >= 0x20) {
    a = 0x1F;
  }
  b = (a & 0x1E) | d;
  b |= rd(0x4BD4) < 0x40 ? 0x40 : 0;
  b |= (rd(0x43B8) & 0x0F) === 1 ? 0 : 0x80;
  wr(0x4BD5, rd(0x2800 + b));
  wr(0x4BD6, rd(0x2800 + u8(b + 1)));
} // spawnSelectScript

// spawn_st3_place [3140]: free slots 4B70h: flags |= 0Ch, X = 4BD8 (+10h each), Y = 4BD4, script = 4BD5:4BD6
function spawnSt3Place() {
  if (rd(0x4BD0) !== 3) {
    return;
  }
  wr(0x4BD0, 0);
  wr(0x4BD8, rd(0x4BD3));
  var de = 0x4B70, bc = 0x4B50;
  while ((de & 0xFF) !== 0x90) {
    if (rd(de) & 0x08) {
      de += 4;
      bc += 2;
      continue;
    }
    wr(de, (rd(de) & 0xF0) | 0x0C);
    wr(de+2, rd(0x4BD8));
    wr(0x4BD8, rd(0x4BD8) + 0x10);
    wr(de+3, rd(0x4BD4));
    wr(bc, rd(0x4BD5));
    wr(bc+1, rd(0x4BD6));
    de += 4;
    bc += 2;
    var n = u8(rd(0x4BD7) - 1);
    wr(0x4BD7, n);
    if (n === 0) {
      return;
    }
  }
} // spawnSt3Place

// ---------------------------------------------------------------- enemy fire [2550]
function enemyFireCheck() {
  var d = rrc(u8(0x20 - rd(0x43BA))) & 0x0F;
  var c = u8(rd(0x439F) + d);
  var a = u8(rd(0x439E) - 0x0A - d);
  if (a >= 0xE0) {
    a = 0;
  }
  var b = a;
  a = u8(rd(0x439A) + d);
  if (a >= 0x40) {
    a = 0x40;
  }
  d = u8(a + 0x88);
  var hl = 0x4B70 + ((rd(0x4392) & 6) << 1);
  if (enemyFireCandidate(hl, b, c, d)) {
    return;
  }
  enemyFireCandidate(hl + 0x10, b, c, d);
} // enemyFireCheck

// enemy_fire_check (candidate) [2594]: active, X in [B, C), Y <= threshold (+20h for formation shape)
// -> enemy_bullet_spawn; returns true when the outer routine must return (spawned or no free slot)
function enemyFireCandidate(hl, b, c, d) {
  if (!(rd(hl) & 0x08)) { return false; }
  var x = rd(hl+2);
  if (x < b) { return false; }
  if (x >= c) { return false; }
  var a = d;
  if (rd(hl+1) < 0x30) {
    a = u8(a + 0x20);
  }
  var y = rd(hl+3);
  if (a < y) { return false; }
  enemyBulletSpawn(x, y);
  return true;
} // enemyFireCandidate

// enemy_bullet_spawn [25B7]: first free of 3/4/5 slots 43CCh (by round): [08, tile 58h+, X+4, Y+0Ch]
function enemyBulletSpawn(bx, cy) {
  var round = rd(0x43B8);
  var d = round < 0x10 ? 3 : (round < 0x20 ? 4 : 5);
  var hl = 0x43CC;
  while (d-- > 0) {
    if (!(rd(hl) & 0x08)) {
      var b = u8(bx + 4), c = u8(cy + 0x0C);
      wr(hl, 0x08);
      wr(hl+1, u8((rrc(b) & 3) + (c & 4) + 0x58));
      wr(hl+2, b);
      wr(hl+3, c);
      soundEvents.push('enemyFire');
      return;
    }
    hl += 4;
  }
} // enemyBulletSpawn

// ---------------------------------------------------------------- enemy bullets [0C40]
function updateEnemyBullets() {
  shadowShiftLoop(0x43FF, 5);
  for (var i = 0; i < 5; i++) {           // move_enemy_bullets [0C56]
    moveEnemyBullet(0x43CC + 4*i);
  }
  for (i = 0; i < 5; i++) {               // enemy_bullets_to_vram [0C6B]
    xyToVram(0x43CE + 4*i, 0x43EE + 4*i);
  }
  for (i = 0; i < 5; i++) {               // enemy_bullets_draw [0CD8]
    spriteEraseThenDraw(0x43CC + 4*i, 0x43EC + 4*i);
  }
} // updateEnemyBullets

// move_enemy_bullet [0C84]: tile ^= 4, Y += 4; Y >= F9h gone; hits the ship; Y >= B0h hits the ground
function moveEnemyBullet(hl) {
  if (!(rd(hl) & 0x08)) {
    return;
  }
  wr(hl+1, rd(hl+1) ^ 4);
  var y = u8(rd(hl+3) + 4);
  wr(hl+3, y);
  if (y >= 0xF9) {
    wr(hl, rd(hl) & 0xF7);   // L_096E
    return;
  }
  // enemy_bullet_hits_ship [0CB4]: Y in [DCh, E9h), 439E < X <= 439F
  if (y >= 0xDC && y < 0xE9) {
    var x = rd(hl+2);
    if (rd(0x439F) >= x && rd(0x439E) < x) {
      killPlayer();
    }
  }
  if (y < 0xB0) {
    return;
  }
  bulletHitsGround(hl+2);
} // moveEnemyBullet

// bullet_hits_ground [2000]: X bit 1 set, BG tile 40h-6Eh under the shot: shot gone, ground explosion
function bulletHitsGround(hlX) {
  var x = rd(hlX);
  if (!(x & 2)) {
    return;
  }
  var sh = (hlX & 0xFF00) | u8(hlX + 0x20);
  var b = u8(rd(sh) + 8), c = rd(sh+1);
  var bc = (b << 8) | c;
  var tile = rd(bc);
  if (tile < 0x40 || tile >= 0x6F) {
    return;
  }
  var d = u8(b - 8), e = c;
  wr(hlX - 2, rd(hlX - 2) & 0xF7);
  if (tile < 0x50) {             // ground_hit_alloc2 [2040]
    if ((tile & 3) === 2) {
      var hl = findFreeSlot4(0x4BA0, 0xFF);
      wr(hl, 0x80);
      wr(hl+2, b);
      wr(hl+3, e);
      soundEvents.push('groundHit');
      return;
    }
    wr(bc, 0);                   // L_2058
    groundHitAlloc(0x6B, d, e);
    return;
  }
  wr(bc, 0);
  groundHitAlloc(0x88, d, e);
} // bulletHitsGround

// ground_hit_alloc [202D]: slot 4B90/94/98 with ([+0] & 0F) == 0, else 4B9C: [B, -, D, E]
function groundHitAlloc(b, d, e) {
  var hl = findFreeSlot4(0x4B90, 0x0F);
  wr(hl, b);
  wr(hl+2, d);
  wr(hl+3, e);
  soundEvents.push('groundHit');
} // groundHitAlloc

function findFreeSlot4(hl, mask) {   // find_free_slot_4 [2068]
  for (var i = 0; i < 3; i++) {
    if ((rd(hl) & mask) === 0) {
      return hl;
    }
    hl += 4;
  }
  return hl;
} // findFreeSlot4

// ground_effects_update [2080]: odd frames; bit 1 of 4392 selects the slot group
function groundEffectsUpdate() {
  var i;
  if (rd(0x4392) & 2) {
    for (i = 0; i < 4; i++) {
      groundHitAnim2(0x4BA0 + 4*i);
    }
  } else {
    for (i = 0; i < 4; i++) {
      groundHitAnim(0x4B90 + 4*i);
    }
  }
} // groundEffectsUpdate

// ground_hit_anim [20B0]: frame from 2A00h[timer] -> 1500h, 3x3 tiles at VRAM + 1Eh, clipped at the left edge
function groundHitAnim(slot) {
  if (!(rd(slot) & 0x0F)) {
    return;
  }
  var a = u8(rd(slot) - 1);
  wr(slot, a);
  var de = 0x1500 | rd(0x2A00 | a);
  var hl = ((rd(slot+2) << 8) | rd(slot+3)) + 0x1E;
  // L_2126
  var cols = 3;
  if ((hl >> 8) === 0x43 && (hl & 0xFF) >= 0x40) {
    hl = (hl & 0xFF00) | u8((hl & 0xFF) - 0x20);
    de = (de & 0xFF00) | u8(de + 3);
    cols = 2;
    if ((hl & 0xFF) >= 0x40) {
      hl = (hl & 0xFF00) | u8((hl & 0xFF) - 0x20);
      de = (de & 0xFF00) | u8(de + 3);
      cols = 1;
    }
  }
  copyColumns3(de, hl, cols);
} // groundHitAnim

// ground_hit_anim2 [20D4]: 4BA0 slots (80h countdown): frame 20F8h[timer & 7] -> 1500h, 2x3 tiles at VRAM - 2
function groundHitAnim2(slot) {
  if (rd(slot) === 0) {
    return;
  }
  var a = u8(rd(slot) - 1);
  wr(slot, a);
  var de = 0x1500 | rd(0x20F8 + (a & 7));
  var hl = (((rd(slot+2) << 8) | rd(slot+3)) - 2) & 0xFFFF;
  copyColumns3(de, hl, 2);
} // groundHitAnim2

// L_2100/L_210C/L_2118: `cols` columns of 3 tiles from DE to HL, next column HL += -22h (right, 2 rows up)
function copyColumns3(de, hl, cols) {
  for (var c = 0; c < cols; c++) {
    wr(hl, rd(de++));
    wr(hl+1, rd(de++));
    wr(hl+2, rd(de++));
    hl = (hl + 2 - 0x22) & 0xFFFF;
  }
} // copyColumns3

// ---------------------------------------------------------------- explosions / score popups [0F78]
function updateExplosions() {
  animateExplosionSlot(0x4370);
  animateExplosionSlot(0x4374);
  animateExplosionSlot(0x4378);
  animateExplosionSlot(0x437C);
} // updateExplosions

// animate_explosion_slot [2FC0]: [timer | type bits 5-7, BCD points/10, VRAM hi, lo]
function animateExplosionSlot(hl) {
  if (!(rd(hl) & 0x1F)) {
    return;
  }
  var a = u8(rd(hl) - 1);
  wr(hl, a);
  if (a === 0) {                 // explosion_slot_finish [2FEC]
    var lo = rd(hl+3);
    if ((lo & 0x1F) < 4) {
      return;
    }
    wr(hl+3, lo - 1);
    explosionDrawFrame(hl, 0);
    return;
  }
  if (a & 0xE7) {
    explosionDrawFrame(hl, a);
    return;
  }
  // timer 18h/10h/08h of a type-0 slot: the points (2 BCD digits + "0") one row up
  var b = rd(hl+1);
  var de = (rd(hl+2) << 8) | rd(hl+3);
  if ((de & 0x1F) < 4) {
    return;
  }
  de--;
  wr((de - 0x20) & 0xFFFF, 0x20);
  wr(0x4BE2, b);
  printBcd(0x4BE2, de, 2);
} // animateExplosionSlot

// explosion_draw_frame [0F95]/L_0F96: frame a = timer & FEh: 2A00h[a] = offset in 1500h, 2A00h[a+1] = width
// code (20/40/60 -> 3/5/7 columns of 2 tiles + a zero column), drawn from VRAM + width leftwards to the
// right through tile_copy_unrolled 3520h; columns beyond the left edge are skipped (blit_clip_and_jump)
function explosionDrawFrame(hl, a) {
  a &= 0xFE;
  var de = (rd(hl+2) << 8) | rd(hl+3);
  var off = rd(0x2A00 | a), c = rd(0x2A01 | a);
  var src = 0x1500 | off;
  var dst = (de + c) & 0xFFFF;
  var entry = rrc(u8(0xA0 - c));
  var units = (0x58 - entry) >> 3;
  var skip = 0;
  if ((dst >> 8) === 0x43) {
    while ((dst & 0xFF) >= 0x40 && skip < 3) {
      dst = (dst & 0xFF00) | u8((dst & 0xFF) - 0x20);
      src = (src & 0xFF00) | u8((src & 0xFF) + 2);
      skip++;
    }
  }
  tileCopyUnrolled(src, dst, units - skip);
} // explosionDrawFrame

// tile_copy_unrolled [3520]: `units` columns of 2 tiles (HL += -21h between them), then a zero column
function tileCopyUnrolled(src, dst, units) {
  for (var i = 0; i < units; i++) {
    wr(dst, rd(src++));
    wr(dst+1, rd(src++));
    dst = (dst + 1 - 0x21) & 0xFFFF;
  }
  wr(dst, 0);
  wr(dst+1, 0);
} // tileCopyUnrolled

// ---------------------------------------------------------------- phase 5 side tasks (JT_23C4 4-7)
// target_spawn [0A9C]: when the wave Y (4BD4) is 48h the target gets its BG address 4BDC/4BDD (49xxh)
function targetSpawn() {
  if (rd(0x4BD4) !== 0x48) {
    wr(0x4BDB, 0);               // clear_flag_ret [0EE6]
    return;
  }
  wr(0x4BDB, 4);
  xyToVram(0x4BD3, 0x4BDC);
  wr(0x4BDC, 0x49);              // DCX D after xy_to_vram left DE = 4BDDh -> the high byte
  wr(0x4362, rd(0x4BD2));
  if (rd(0x4BD2)) {
    soundEvents.push('ping');
  }
} // targetSpawn

// target_anim [0ABC]: the BG tile at 4BDC/4BDD steps through 0A00h[tile + 14h + 4BDB] (2Ch -> 2Dh -> 2Eh -> 2Fh)
function targetAnim() {
  var de = (rd(0x4BDC) << 8) | rd(0x4BDD);
  var l = u8(u8(rd(de) + 0x14) + rd(0x4BDB));
  wr(de, rd(0x0A00 | l));
  if (rd(0x4BDB) !== 0) {        // L_0E90: animated tile at 49A6h from 0A48h+
    wr(0x49A6, rd(0x0A00 | u8(((rd(0x4392) & 0x0C) >> 2) + 0x48)));
  }
} // targetAnim

// draw_target_bonus [09D4]: 4BDE = BCD sum (round+1 doubled per hit target bit of 43BC), printed at 4165h
function drawTargetBonus() {
  var b = ((rd(0x43B8) >> 4) & 7) + 1, c = 0;
  var a = rd(0x43BC);
  for (var i = 0; i < 5; i++) {
    var cy = a & 1;
    a = rrc(a);
    if (cy) {
      var s = bcdAdd(b, c, 0).v;   // ADD C; DAA; B = C = A
      b = s;
      c = s;
    }
  }
  wr(0x4BDE, c);
  wr(0x4BDF, 0);
  printBcd(0x4BDF, 0x4165, 4);   // L_0998
} // drawTargetBonus

// draw_target_indicators [37D0]: tiles 33F8h[(4392&0C)>>1] to BG 49E7/4967, 5 indicators at 416Ah+20h*k
// (a hit target = blank)
function drawTargetIndicators() {
  var p = 0x3300 | u8(rrc(rd(0x4392) & 0x0C) + 0xF8);
  var a = rd(p);
  wr(0x49E7, a);
  wr(0x4967, a);
  var d = rd(p+1);
  var hl = 0x416A, mask = rd(0x43BC);
  for (var i = 0; i < 5; i++) {
    wr(hl, 0);
    var cy = mask & 1;
    mask = rrc(mask);
    if (!cy) {
      wr(hl, d);
    }
    hl += 0x20;
  }
} // drawTargetIndicators

// ---------------------------------------------------------------- phase 3: the mothership [3400]
function phase3Mothership() {
  updatePlayer();                // S_0876
  mothershipHitTest();           // S_3800
  mothershipMove();              // S_2600
  mothershipHitTest();
  mothershipBeamAttack();        // S_3980
  var hp = rd(0x43BB);
  if (hp === 0) {                // mothership_destroyed [3462]
    if (rd(0x439B) & 1) {
      return;
    }
    updateEnemyBullets();
    updateExplosions();
    waveEndCountdown();
    return;
  }
  if (hp < 4) {                  // heavily damaged: both slot groups every frame
    slotsDrawGroup(0x4B70);
    slotsDrawGroup(0x4B90);
    slotScriptParams();
    slotsScriptGroup(0x4B70);
    slotsScriptGroup(0x4B90);
    if (rd(0x439B) & 1) {
      updateExplosions();
      return;
    }
    mothershipFire();
    updateEnemyBullets();
    return;
  }
  if (rd(0x439B) & 1) {          // L_3452
    slotsDrawGroup(0x4B90);
    slotScriptParams();
    slotsScriptGroup(0x4B90);
    updateExplosions();
    return;
  }
  slotsDrawGroup(0x4B70);        // L_3438
  slotScriptParams();
  slotsScriptGroup(0x4B70);
  mothershipFire();
  updateEnemyBullets();
} // phase3Mothership

// slots_draw_group_a/b [3474/3486]: 4 slots of 8 B
function slotsDrawGroup(base) {
  for (var i = 0; i < 4; i++) {
    slotDraw(base + 8*i);
  }
} // slotsDrawGroup

function slotsScriptGroup(base) {   // slots_script_group_a/b [3498/34AA]
  for (var i = 0; i < 4; i++) {
    slotRunScript(base + 8*i);
  }
} // slotsScriptGroup

// slot_draw [34C0]: slot [type, VRAM hi, lo, frame, timer, X, p6, p7]; strip pointer 3E08h[(type*8+frame)&7E],
// entry offset 3EC0h[type] into tile_copy_unrolled (= number of 2-tile columns)
function slotDraw(hl) {
  var type = rd(hl);
  if (type === 0) {
    return;
  }
  var c = rd(0x3E00 | u8(type + 0xC0));
  var de = (rd(hl+1) << 8) | rd(hl+2);
  var p = 0x3E00 | (u8(rlc(rlc(rlc(type))) + rd(hl+3)) & 0x7E);
  drawStripColumns(de, (rd(p) << 8) | rd(p+1), c);
} // slotDraw

// draw_strip_columns [34DE]: strip HL (2 tiles per column) at DE, columns to the right; a start beyond the
// left edge (4B50h+) skips 1-3 columns (C += 8/10h/18h); draw_strip_enter [350C]: a zero column, then
// tile_copy_unrolled from DE - 20h
function drawStripColumns(de, hl, c) {
  var d = de >> 8, e = de & 0xFF;
  if (d === 0x4B && e >= 0x50) {
    var b = 0x08;
    hl += 2;
    e = u8(e - 0x20);
    if (e >= 0x50) {
      b = 0x10;
      hl += 2;
      e = u8(e - 0x20);
      if (e >= 0x50) {
        b = 0x18;
        hl += 2;
        e = u8(e - 0x20);
      }
    }
    c = u8(c + b);
  }
  var dst = (d << 8) | e;
  wr(dst, 0);
  wr(dst+1, 0);
  tileCopyUnrolled(hl, (dst - 0x20) & 0xFFFF, (0x58 - c) >> 3);
} // drawStripColumns

// slot_script_params [3560]: 436F = rng * 11h; 436E/436D from script_param_table 3E80h by round, HP, 439A bit 3
function slotScriptParams() {
  var r = rngFromFrameX();
  var c = rlc(rlc(r));
  wr(0x436F, rlc(rlc(c)) | r);
  var a = rd(0x43B8);
  if (a >= 0x40) {
    a = 0x30;
  }
  var b = rrc(a & 0x30);
  a = u8(rd(0x43BB) - 1);
  if (a >= 4) {
    a = 3;
  }
  b |= rlc(a);
  b |= rlc(rlc(rd(0x439A))) & 0x20;
  var l = 0x3E00 | u8(b + 0x80);
  wr(0x436E, rd(l));
  wr(0x436D, u8(rd(l+1) + c) & 0xF8);
} // slotScriptParams

function rngFromFrameX() {   // rng_from_frame_x [3758]: ((439B<<3)&7 + 43C2) & 0F
  return u8((rlc(rlc(rlc(rd(0x439B)))) & 7) + rd(0x43C2)) & 0x0F;
} // rngFromFrameX

// slot_run_script [35B0]: active slot: timer-- (when != 0), then the script row 3F00h+8*type:
// [param1 hi,lo][param2 hi,lo][routine2][routine1] — routine1 runs with HL = slot+4, B = type, then routine2
// with the parameters (the original pushes the 4 words and RETs through them)
function slotRunScript(hl) {
  var type = rd(hl);
  if (type === 0) {
    return;
  }
  var hl4 = hl + 4;
  if (rd(hl4) !== 0) {
    wr(hl4, rd(hl4) - 1);
  }
  var p = 0x3F00 | u8(rlc(rlc(rlc(type))));
  var r1 = (rd(p+6) << 8) | rd(p+7), r2 = (rd(p+4) << 8) | rd(p+5);
  switch (r1) {
    case 0x35E0: scriptStep35E0(hl4, type); break;
    case 0x36C0: scriptStep36C0(hl4); break;
    default: throw new Error('gameWorker: script routine1 ' + r1.toString(16));
  }
  var B = rd(p), C = rd(p+1), D = rd(p+2), E = rd(p+3);
  switch (r2) {
    case 0x36D2: scriptStep36D2(hl4, B, D); break;
    case 0x36EA: scriptStep36EA(hl4, B, D); break;
    case 0x370A: scriptStep370A(hl4, B, C, D, E); break;
    case 0x376A: scriptStep376A(hl4, B, C, D, E); break;
    default: throw new Error('gameWorker: script routine2 ' + r2.toString(16));
  }
} // slotRunScript

// script_step_35e0: the slot walks by [slot+6] (step < 10h: left/up, >= 10h: right/down) with the
// animation frame [slot+3] and the X [slot+5]; at the end of a column the step is recomputed from the
// distance to [slot+7] and 436E; [slot+7] is the next stop derived from the ship X and 436D
function scriptStep35E0(hl4, b) {
  var s = hl4 - 4;
  var a = rd(s+6);
  if (a >= 0x10) {
    scriptStep3628(s, a);
    return;
  }
  b = a;
  wr(s+5, u8(rd(s+5) + a));
  a = u8(b + rd(s+3));
  wr(s+3, a);
  if (a < 8) {                   // L_366A
    if (b !== 0) {
      return;
    }
    wr(s+6, u8(rd(s+6) + 1));
    return;
  }
  wr(s+3, a & 7);
  var lo = rd(s+2) - 0x20;
  wr(s+2, u8(lo));
  if (lo < 0) {
    wr(s+1, u8(rd(s+1) - 1));
  }
  // L_3604
  var c = rd(s+5);
  a = rd(s+7);
  wr(s+6, 0x10);
  a = u8(a - c);
  if (a === 0) {                 // L_3672
    var bb = rd(s+5);
    var sx = rd(0x43C2) & 0xF8;
    if (sx < bb) {
      bb = sx;
    }
    var cc = rd(0x436D);
    wr(0x436D, u8(cc + 8));
    wr(s+7, 8);
    if (bb < cc) {
      return;
    }
    a = u8(bb - cc);
    if (a < 8) {
      return;
    }
    wr(s+7, a);
    return;
  }
  a = rrc(rrc(rrc(u8(a - 1)))) & 0x1F;
  var cy = a < b;
  wr(s+6, u8(a + 1));
  if (cy) {
    return;
  }
  a = rd(0x436E);
  wr(s+6, a);
  if (a === b) {
    return;
  }
  wr(s+6, u8(b + 1));
} // scriptStep35E0

// L_3628: step >= 10h (the low nibble = amount, 0 = L_3744 turn)
function scriptStep3628(s, a) {
  a &= 0x0F;
  if (a === 0) {                 // L_3744
    wr(s+6, 0x11);
    wr(s+5, u8(rd(s+5) - 1));
    wr(s+3, 7);
    var v = rd(s+2) + 0x20;
    wr(s+2, u8(v));
    if (v >= 0x100) {
      wr(s+1, u8(rd(s+1) + 1));
    }
    return;
  }
  var b = a;
  wr(s+5, u8(rd(s+5) - b));
  var t = rd(s+3) - b;
  wr(s+3, u8(t));
  if (t >= 0) {                  // L_3695
    var bb = rd(s+5);
    if (rd(s+7) !== bb) {
      return;
    }
    wr(s+6, 0);
    var sx = rd(0x43C2) & 0xF8;
    if (sx >= bb) {
      bb = sx;
    }
    var base = u8(rd(0x436D) + 8);
    wr(0x436D, base);
    var sum = base + bb;
    wr(s+7, 0xC8);
    if (sum >= 0x100 || sum >= 0xC8) {
      return;
    }
    wr(s+7, sum);
    return;
  }
  wr(s+3, u8(t) & 7);
  var v2 = rd(s+2) + 0x20;
  wr(s+2, u8(v2));
  if (v2 >= 0x100) {
    wr(s+1, u8(rd(s+1) + 1));
  }
  // L_3648
  var d = rrc(rrc(rrc(u8(rd(s+5) - rd(s+7))))) & 0x1F;
  var cy = d < b;
  d = u8(d + 1);
  if (!cy) {
    var pc = rd(0x436E);
    d = pc === b ? pc : u8(b + 1);
  }
  wr(s+6, d | 0x10);
} // scriptStep3628

function scriptStep36C0(hl4) {   // script_step_36c0: even timer -> frame = (frame+1) & 7
  if (rd(hl4) & 1) {
    return;
  }
  wr(hl4 - 1, (rd(hl4 - 1) + 1) & 7);
} // scriptStep36C0

function scriptStep36D2(hl4, B, D) {   // timer expired -> timer = B, type = D
  if (rd(hl4)) {
    return;
  }
  wr(hl4, B);
  wr(hl4 - 4, D);
  wr(0x4368, rd(0x4368) | 1);
} // scriptStep36D2

function scriptStep36EA(hl4, B, D) {   // like 36D2, only when the step low nibble is 0
  if (rd(hl4)) {
    return;
  }
  if (rd(hl4 + 2) & 0x0F) {
    return;
  }
  wr(hl4, B);
  wr(hl4 - 4, D);
  wr(0x4368, rd(0x4368) | 2);
} // scriptStep36EA

function scriptStep370A(hl4, B, C, D, E) {   // 36EA + random alternative (E, C) by 436F
  if (rd(hl4)) {
    return;
  }
  if (rd(hl4 + 2) & 0x0F) {
    return;
  }
  wr(hl4, B);
  wr(hl4 - 4, D);
  wr(0x4368, rd(0x4368) | 4);
  if (rd(0x436F) & E & 0xF0) {
    return;
  }
  wr(hl4 - 4, E & 0x0F);
  wr(hl4, C);
  wr(0x4368, rd(0x4368) | 8);
} // scriptStep370A

function scriptStep376A(hl4, B, C, D, E) {   // by the direction bit of the step: (B, D) or (C, E & 0F)
  if (rd(hl4)) {
    return;
  }
  if (rd(hl4 + 2) & 0x10) {      // L_3783
    wr(hl4, C);
    wr(hl4 - 4, E & 0x0F);
    return;
  }
  wr(hl4, B);
  wr(hl4 - 4, D);
} // scriptStep376A

// mothership_move [2600]: the ship is drawn in the BG and moves by the scroll; 4BD2 = row = (~43B9>>3)&1F;
// 4BD1 < 4BD3 -> scroll += 3ED0h[..], else scroll -= 3ED0h[..] + speed 4BD5>>2
function mothershipMove() {
  wr(0x4BD2, rrc(rrc(rrc(u8(~rd(0x43B9))))) & 0x1F);
  var f = rlc(rlc(rd(0x439B))) & 0x0C;
  var a;
  if (rd(0x4BD1) < rd(0x4BD3)) {   // L_2650
    a = u8(rd(0x43B9) + rd(0x3E00 | u8(f + rd(0x4BD4) + 0xD0)));
  } else {
    var d = rd(0x4BD5);
    d = u8((rrc(rrc(d)) & 7) + rd(0x3E00 | u8(f + (d & 3) + 0xD0)));
    a = u8(rd(0x43B9) - d);
  }
  wr(0x43B9, a);                 // L_2639
  wr(0x5800, a);
  if (rd(0x439B) & 1) {
    mothershipCalcSpeed();
    mothershipRetarget();
  } else {
    mothershipScanSlots();
  }
} // mothershipMove

function mothershipCalcSpeed() {   // mothership_calc_speed [2668]: 4BD5 from 436E, 439A, 43BB, cap 3EE0h[4BD6]
  var b = u8(rd(0x436E) + 2);
  var d = rd(0x439A);
  b = u8(b + (rrc(rrc(d)) & 0x0F));
  var hp = rd(0x43BB);
  b = u8(b + (rrc(u8(8 - hp)) & 3));
  var cap = rd(0x3E00 | u8(rd(0x4BD6) + 0xE0));
  if (b >= cap) {
    b = cap;
  }
  b = u8(b + (d & 0xF8));
  if (hp < 4) {
    b = u8(b + ((~hp) & 3));
  }
  wr(0x4BD5, b);
} // mothershipCalcSpeed

function mothershipRetarget() {   // mothership_retarget [26AA]: timer 4BD3, new target when 8 <= 4BD6 < 0C
  var a = rd(0x4BD3);
  wr(0x4BD3, u8(a - 1));
  if (a !== 0) {
    return;
  }
  wr(0x4BD3, u8(rd(0x4BD3) + 1));
  a = rd(0x4BD6);
  if (a >= 0x0C || a < 8) {
    return;
  }
  var b = rlc(u8(a - rd(0x4BD7)));
  a = rd(0x436F) & 3;
  wr(0x4BD4, a);
  mothershipSetTarget(b, ((~a) & 3) + 1);
} // mothershipRetarget

function mothershipSetTarget(b, c) {   // mothership_set_target [2476] + mul_add_c [2495]
  var a = u8(b + c);
  var done = false;
  for (var i = 0; i < 3; i++) {
    a = u8(a + b);
    if (--c === 0) {
      done = true;
      break;
    }
  }
  if (!done) {
    a = u8(a + a);
  }
  wr(0x4BD3, a);
  var t = rlc(u8(8 - rd(0x43BB)));
  t = rlc(u8(t + rd(0x439A)));
  wr(0x4BD1, u8((rd(0x436F) & 0x1E) + t));
} // mothershipSetTarget

// mothership_scan_slots [26D0]: slots 4BA8..4B70 (step -8): D = first, E = last active index (D = 80h none)
function mothershipScanSlots() {
  var d = 0x80, e = 0, c = 0;
  for (var l = 0xA8; l !== 0x68; l = u8(l - 8)) {
    if (rd(0x4B00 | l) !== 0) {
      if (d & 0x80) {
        d = c;
      }
      e = c;
    }
    c++;
  }
  wr(0x4BD6, u8(rd(0x4BD2) + d + e) & 0x1F);
  wr(0x4BD7, u8(e - d));
} // mothershipScanSlots

// mothership_hit_test [3800]: the player shot over a BG tile 90h+ of the ship (row corrected by 4BD2):
// bit mask 3E00h[X&7] against 3B60h[tile-90h] (armor, tile < D0h) / 3B90h[tile-90h] (other parts)
function mothershipHitTest() {
  if (!(rd(0x43C4) & 8)) {
    return;
  }
  var d = u8(rd(0x43E6) + 8);
  var e = (rd(0x43E7) & 0xE0) | ((rd(0x43E7) - rd(0x4BD2)) & 0x1F);
  var tile = rd((d << 8) | e);
  if (tile < 0x90) {
    return;
  }
  var b = tile - 0x90;
  var c = rd(0x3E00 | (rd(0x43C6) & 7));
  var slot = 0x4B00 | u8(0xA8 - ((e & 0x0E) << 2));
  if (b < 0x40 && mothershipHitArmor(b, c, slot)) {
    return;
  }
  mothershipHitOther(b, c, slot);
} // mothershipHitTest

// mothership_hit_armor [3844]: the tile is replaced (S_38A1), the slot cleared, 43BB--; the score object by
// the slot type: < 8 -> 50 points (3905h, hit_sound), 8-0C 100, 0D/0E 200, 0F 400 (1Fxxh, bonus_hit_sound)
function mothershipHitArmor(b, c, slot) {
  if (!(rd(0x3B00 | u8(b + 0x60)) & c)) {
    return false;
  }
  mothershipReplaceTile(slot);
  var type = rd(slot);
  wr(slot, 0);
  wr(0x43BB, u8(rd(0x43BB) - 1));
  var B, C;
  if (type < 8) {                // L_3880
    B = 0x39;
    C = 0x05;
    wr(0x4364, 0xFF);
    soundEvents.push('enemyHit');
  } else {
    wr(0x4369, 0xFF);
    soundEvents.push('enemyHitBig');
    B = 0x1F;
    C = type < 0x0D ? 0x10 : (type !== 0x0F ? 0x20 : 0x40);
  }
  spawnHitObject(B, C);
  return true;
} // mothershipHitArmor

// mothership_replace_tile [38A1]: the strip 17xxh (1787h + ROM[1987h]... = EBh + ROM[1987h]) at the slot's VRAM
function mothershipReplaceTile(slot) {
  var src = 0x1700 | u8(rd(0x1987) + 0xEB);
  drawStripColumns((rd(slot+1) << 8) | rd(slot+2), src, 0x20);
} // mothershipReplaceTile

// mothership_hit_other [38BA]: tile-90h >= 10h with the mask 3B90h: replace the tile, the slot (type >= 8)
// gets the damaged type from 3890h (slot_set_damaged), tile_hit_flag, 20 points (5302h)
function mothershipHitOther(b, c, slot) {
  if (b < 0x10) {
    return;
  }
  if (!(rd(0x3B00 | u8(b + 0x90)) & c)) {
    return;
  }
  mothershipReplaceTile(slot);
  var a = rd(slot) - 8;
  if (a >= 0) {
    var cy = rd(0x43C6) < rd(slot+5) ? 8 : 0;
    slotSetDamaged(slot, rd(0x3800 | u8((a | cy) + 0x90)));
  }
  wr(0x4366, 0xFF);              // L_38EA
  soundEvents.push('tileHit');
  spawnHitObject(0x53, 0x02);
} // mothershipHitOther

function slotSetDamaged(slot, type) {   // slot_set_damaged [3CE0]
  if ((rd(slot+5) & 0xF8) === rd(slot+7)) {
    return;
  }
  wr(slot+6, rd(slot+6) & 0xF0);
  wr(slot+5, rd(slot+5) & 0xF8);
  wr(slot+4, 0x80);
  wr(slot+3, 0);
  wr(slot, type);
} // slotSetDamaged

// spawn_hit_object [38FA]: explosion/score slot 4370+4k = [B, C, 43E6, 43E7], the shot is gone
function spawnHitObject(b, c) {
  var hl = findFreeSlot4(0x4370, 0x1F);   // find_free_obj_slot [3914]
  wr(hl, b);
  wr(hl+1, c);
  wr(hl+2, rd(0x43E6));
  wr(hl+3, rd(0x43E7));
  wr(0x43C4, rd(0x43C4) & 0xF7);
} // spawnHitObject

// mothership_fire [3930]: only when 439B bit 1; ms_fire_slot_table 3DC0h[4BD2&1E] = [count, first slot lo];
// a slot of type >= 5 with X in [439E-D, 439F+D), D = 0Ch - 43BB, drops a bomb (then the routine ends)
function mothershipFire() {
  var p = 0x3D00 | u8((rd(0x4BD2) & 0x1E) + 0xC0);
  var e = rd(p), hl = 0x4B00 | rd(p+1);
  var d = u8(0x0C - rd(0x43BB));   // bomb_window_width [3A00]
  if (!(rd(0x439B) & 2)) {
    return;
  }
  var c = u8(rd(0x439F) + d), b = u8(rd(0x439E) - d);
  do {
    if (slotTryBomb(hl, b, c)) {
      return;
    }
    hl = (hl & 0xFF00) | u8(hl + 8);
  } while (--e !== 0);
} // mothershipFire

function slotTryBomb(hl, b, c) {   // slot_try_bomb [395C]: true = enemy_bullet_spawn reached (pops 2 levels)
  if (rd(hl) < 5) {
    return false;
  }
  var x = rd(hl+5);
  if (x < b || x >= c) {
    return false;
  }
  var y = u8(rlc(rlc(rlc(u8(rd(0x4BD2) + rd(hl+2)) & 0x1F))) + 8);
  enemyBulletSpawn(u8(x - 4), y);
  return true;
} // slotTryBomb

// mothership_beam_attack [3980]: ship low (row 0Ch-1Bh): a fake player shot in the column of the ship's
// hitbox edge (439E on odd frames, 439F one column right on even ones) is run through mothership_hit_test
// over 1Dh rows; when it hits a part of the ship the player is killed (43A6 counter < C0h always)
function mothershipBeamAttack() {
  var a = rd(0x4BD2) - 0x0C;
  if (a < 0 || a >= 0x10) {
    return;
  }
  copyBlock(0x43C4, 0x4BC0, 4);
  copyBlock(0x43E6, 0x4BC4, 2);
  copyBlock(0x43E2, 0x43E6, 2);
  wr(0x43C4, 0x08);
  var de = 0x439E;
  if (!(rd(0x439B) & 1)) {
    de = 0x439F;
    var lo = rd(0x43E7) - 0x20;
    wr(0x43E7, u8(lo));
    wr(0x43E6, u8(rd(0x43E6) - (lo < 0 ? 1 : 0)));
  }
  wr(0x43C6, rd(de));
  while (true) {                 // L_39C3
    mothershipHitTest();
    if (!(rd(0x43C4) & 8)) {     // L_39F0
      var v = rd(0x43A6);
      if (v < 0xC0) {
        killPlayer();
        return;                  // JC kill_player: the backup is not restored
      }
      wr(0x43A6, u8(v - 1));
      break;
    }
    var l = u8(rd(0x43E7) + 1);
    wr(0x43E7, l);
    if ((l & 0x1F) >= 0x1D) {
      break;
    }
  }
  copyBlock(0x4BC0, 0x43C4, 4);  // L_39DB
  copyBlock(0x4BC4, 0x43E6, 2);
} // mothershipBeamAttack

// ---------------------------------------------------------------- phase 6 [2360]: the planet scrolls in
function phase6PlanetScroll() {
  drawTextBlocks(0x1BC0, 2);
  updatePlayer();
  wr(0x43B9, 0xFF);
  wr(0x5800, 0xFF);
  var a = u8(rd(0x4394) + 1);
  wr(0x4394, a);
  if (a === 1) {
    wr(0x4367, 0xFF);
  }
  if (a !== 0xC0) {
    return;
  }
  wr(0x43B8, rd(0x43B8) + 1);
  clearFg();
} // phase6PlanetScroll

// ---------------------------------------------------------------- phase 7 [2390]: the landing
function phase7Landing() {
  landingDescend();              // S_24F8
  landingMarkers();              // S_24A0
  updatePlayer();                // S_2060
  drawPlayerShipTiles();
  updateExplosions();            // S_0F78
  landingTerrainCollision();     // S_32F0
  landingFinished();             // S_31A8
  landingPadLights();            // L_3276
} // phase7Landing

// landing_controls [22B0] (move_ship with phase >= 6): inertia
function landingControls() {
  shipInertia();
  moveShipInertia();
  setShapeByX(0x43C2, 0x1600);
} // landingControls

function shipInertia() {   // ship_inertia [22C0]: 439C +1 right / -1 left (both = left), damping on odd frames
  var a = (~rd(0x43A0)) & 0x60;
  var v = rd(0x439C);
  if (a) {
    v = u8(v + 1);
    if (a & 0x40) {
      v = u8(v - 2);
    }
    wr(0x439C, v);
    return;
  }
  if (!(rd(0x439B) & 1)) {       // L_22D6
    return;
  }
  wr(0x439C, u8(v - 1));
  if (!(v & 0x80)) {
    return;
  }
  wr(0x439C, u8(v + 1));
} // shipInertia

function moveShipInertia() {   // move_ship_inertia [22E6]: X += fractional_step(|v|), |v| <= 7Ch, X in 08h..C0h
  var v = rd(0x439C), a, c, x;
  if (v & 0x80) {
    a = u8(-v);
    if (a >= 0x7C) {
      a = 0x7C;
      wr(0x439C, 0x84);
    }
    c = fractionalStep(a);       // L_22F9
    x = u8(rd(0x43C2) - c);
    wr(0x43C2, x);
    if (x >= 8) {
      return;
    }
    wr(0x43C2, 8);
    wr(0x439C, 0);               // L_2321
    return;
  }
  a = v;                         // L_230B
  if (a >= 0x7C) {
    a = 0x7C;
    wr(0x439C, 0x7C);
  }
  c = fractionalStep(a);
  x = u8(rd(0x43C2) + c);
  wr(0x43C2, x);
  if (x < 0xC1) {
    return;
  }
  wr(0x43C2, 0xC0);
  wr(0x439C, 0);
} // moveShipInertia

// fractional_step [2326]: C = bit 6 of A + (2350h[(A>>3)&7] & 2358h[439B&7] ? 1 : 0)
function fractionalStep(a) {
  var r = rrc(rrc(rrc(a)));
  var b = rd(0x2350 + (r & 7));
  var c = rrc(rrc(rrc(r))) & 1;
  if (rd(0x2358 + (rd(0x439B) & 7)) & b) {
    c++;
  }
  return c;
} // fractionalStep

function landingDescend() {   // landing_descend [24F8]: scroll -= step, a new BG row every 8 scroll steps
  var c = landingDescentStep();
  if (c === 0) {
    return;
  }
  var a = u8(rd(0x43B9) - c);
  wr(0x43B9, a);
  wr(0x5800, a);
  if (a & 7) {
    return;
  }
  drawBgRowRle();
  if (rd(0x43B1) === 0x1F) {
    wr(0x43B1, 0x3F);
  }
} // landingDescend

function landingDescentStep() {   // landing_descent_step [251A]: from ~4395 bit 2 and 43B9 bits 6-7
  var c = (~rd(0x4395)) & 4;
  var a = u8(rlc(rlc(rd(0x43B9) & 0xC0)) + c);
  return fractionalStep(rlc(rlc(rlc(a))));
} // landingDescentStep

// landing_markers [24A0]: scroll 0 -> 4395 = FF (landed); records 1F60h [scroll, round mask, VRAM hi, lo]
// matching the scroll and round draw a 2x2 marker (24ECh/24F0h); BC counts the drawn markers (INX B)
function landingMarkers() {
  if (rd(0x4395)) {
    return;
  }
  var b = rd(0x43B9);
  if (b === 0) {
    wr(0x4395, 0xFF);
  }
  var bc = (b << 8) | (rd(0x43B8) & 0xF0);
  for (var hl = 0x1F60; ; hl += 4) {
    bc = landingMarkerCheck(hl, bc);
    if (((hl + 4) & 0xFF) === 0) {
      break;
    }
  }
} // landingMarkers

function landingMarkerCheck(hl, bc) {   // landing_marker_check [24CD]
  var b = bc >> 8, c = bc & 0xFF;
  if (rd(hl) !== b) {
    return bc;
  }
  var m = rd(hl+1);
  if ((m ^ c) & 0x10) {
    return bc;
  }
  if (c < m) {
    return bc;
  }
  var de = (rd(hl+2) << 8) | rd(hl+3);
  blit2x2(0x2400 | u8((((hl + 3) & 0xFF) & 4) + 0xEC), de);
  return (bc + 1) & 0xFFFF;
} // landingMarkerCheck

// landing_terrain_collision [32F0]: the 2x2 BG tiles under the ship (row corrected by the scroll):
// 6Fh = touchdown, 70h-7Bh = terrain masks 33A8h/33ACh -> kill_player; then landing_anim_tiles
function landingTerrainCollision() {
  var d = rd(0x43E2), e = rd(0x43E3);
  var b = u8(rrc(rrc(rrc(u8(rd(0x43B9) + 4)))) + e) & 0x1F;
  e = (e & 0xE0) | b;
  d = u8(d + 8);
  var rows = 2, cols = 2;
  while (true) {                 // L_330E
    if (landingTileCheck((d << 8) | e, rows, cols)) {
      return;
    }
    e = (e & 0xE0) | ((e + 1) & 0x1F);           // vram_step_right [339B]
    if (--rows !== 0) {
      continue;
    }
    e = (e & 0xE0) | ((e - 2) & 0x1F);           // vram_step_left2 [33F0] + vram_col_right
    var de = (((d << 8) | e) - 0x20) & 0xFFFF;
    d = de >> 8;
    e = de & 0xFF;
    rows = 2;
    if (--cols === 0) {
      break;
    }
  }
  landingAnimTiles();
} // landingTerrainCollision

function landingTileCheck(de, b, c) {   // landing_tile_check [332A]: true = the collision routine ends
  var t = rd(de);
  if (t < 0x6F) {
    return false;
  }
  var d = 0xA8;
  if (t === 0x6F) {
    return landingTouchdown(b, c, d);
  }
  if (t >= 0x7C) {
    return false;
  }
  if (t < 0x78) {
    d = u8(((t & 3) << 2) + 0xAC);
  }
  if (landingCollisionMask(b, c, d) === 0) {   // L_3342
    return false;
  }
  killPlayer();
  return true;
} // landingTileCheck

function landingCollisionMask(b, c, d) {   // landing_collision_mask [334C]
  var i = (b & 1) | ((c & 1) << 1) | (rd(0x43B9) & 4);
  var mask = rd(0x3E00 | i);
  return rd(0x3300 | u8((rrc(rd(0x43C2)) & 3) + d)) & mask;
} // landingCollisionMask

// landing_touchdown [3370]: the ship over the pad tile 6Fh: bonus_hit_sound, object 4370 = [1Ah, points
// ((~43B9>>1)&70)+10h, 43E2, 43E3-2] (the MOV M,A after the pops writes into the ROM = no effect)
function landingTouchdown(b, c, d) {
  if (landingCollisionMask(b, c, d) === 0) {
    return false;
  }
  wr(0x4369, 0xFF);
  soundEvents.push('landed');
  wr(0x4370, 0x1A);
  wr(0x4371, u8((rrc(u8(~rd(0x43B9))) & 0x70) + 0x10));
  wr(0x4372, rd(0x43E2));
  wr(0x4373, u8(rd(0x43E3) - 2));
  return true;
} // landingTouchdown

// landing_anim_tiles [3790]: even frames: 37C0h[((439B>>1)&3)*4] = [count, step, VRAM hi, lo]: tiles 78h-7Bh
// cycle; then draw_player_ship_tiles
function landingAnimTiles() {
  var f = rd(0x439B);
  if (f & 1) {
    return;
  }
  var p = 0x3700 | u8(((rrc(f) & 3) << 2) + 0xC0);   // RRC first: entry = (439B >> 1) & 3
  var n = rd(p), step = rd(p+1), hl = (rd(p+2) << 8) | rd(p+3);
  for (; n > 0; n--) {
    var t = rd(hl);
    if ((t & 0xFC) === 0x78) {
      wr(hl, (t + 1) & 0xFB);
    }
    hl = (hl + step) & 0xFFFF;
  }
  drawPlayerShipTiles();
} // landingAnimTiles

// landing_finished [31A8]: scroll 0 and 43B2 == 1Fh: index = 3266h[X&7] + round (>= 8 -> 0): state 7,
// 43A5 = index*32, 439D = 326Eh[index] (BCD hundreds), printed as 4 digits at 4179h
function landingFinished() {
  if (rd(0x43B9) !== 0 || rd(0x43B2) !== 0x1F) {
    return;
  }
  var a = u8(((rd(0x43B8) >> 4) & 0x0F) + rd(0x3266 + (rd(0x43C2) & 7)));
  if (a >= 8) {
    a = 0;
  }
  wr(0x43A5, rrc(rrc(rrc(a))));
  wr(0x43A4, 7);
  wr(0x439D, rd(0x326E + a));
  wr(0x439E, 0);
  printBcd(0x439E, 0x4179, 4);
  playerObjsDraw();
} // landingFinished

// landing_pad_lights [3276]: until landed: 2BC0h/2BE0h (round bit 4) records [scroll, mask, VRAM hi, lo]:
// scroll match and (4383 ^ mask) & ((~43B8>>1)&30) == 0 -> pad tile 6Fh
function landingPadLights() {
  if (rd(0x4395)) {
    return;
  }
  var b = rd(0x43B9), r = rd(0x43B8);
  var c = rrc(u8(~r)) & 0x30;
  var l = u8(((r & 0x10) << 1) + 0xC0);
  for (var i = 0; i < 8; i++) {
    var hl = 0x2B00 | l;
    if (rd(hl) === b && ((rd(0x4383) ^ rd(hl+1)) & c) === 0) {
      wr((rd(hl+2) << 8) | rd(hl+3), 0x6F);
    }
    l = u8(l + 4);
    if ((l & 0x1F) === 0) {
      break;
    }
  }
} // landingPadLights

// ---------------------------------------------------------------- state 6 [2400]: explosion after wave 2
function state6() {
  var d = u8(rd(0x4BDC) - 8), e = rd(0x4BDD);
  wr(0x43BA, 0x10);
  wr(0x43A4, 2);
  var a = u8(rd(0x43A5) - 1);
  wr(0x43A5, a);
  if (a === 0) {
    return;                      // state 2 -> phase 6
  }
  wr(0x43A4, 6);
  if (a < 0x1E) {
    return;
  }
  if (a === 0x1E) {
    clearFg();
    return;
  }
  if (a === 0x1F) {
    clearBg();
    return;
  }
  drawBigSprite(a - 0x20, (d << 8) | e);
  drawTargetBonus();
} // state6

// ---------------------------------------------------------------- state 7 [05D0 -> 32B4]: landing bonus
function state7() {
  if (!(rd(0x439B) & 1)) {       // state7_body [32B4]: even frames only
    var a = u8(rd(0x43A5) - 1);  // bonus_display_tick [31F7]
    wr(0x43A5, a);
    if (a === 0) {
      nextRound();
    } else if ((a & 0x1F) === 0) {
      clearFg();
    } else {
      if ((a & 0x1F) === 0x1F) {
        wr(0x4363, 0x10);
        soundEvents.push('bonusCount');
      }
      drawBonusPicture(a);
    }
  }
  setPalette();
} // state7

// draw_bonus_picture [320B]: 2B80h[(43A5>>5)*4] = [tile offset, VRAM hi, lo, index row 2Bxx]; the tile
// offset is animated by (43A5>>2)&7
function drawBonusPicture(a) {
  var c = rrc(rrc(a)) & 7;
  var p = 0x2B00 | u8(rrc(rrc(rrc(a & 0xE0))) + 0x80);
  c = u8(rd(p) + c);
  var de = (rd(p+1) << 8) | rd(p+2);
  drawIndirect8x8(0x2B00 | rd(p+3), de, c);
} // drawBonusPicture

// draw_indirect_8x8 [3240]: 8x8 tiles: index list HL (FF = blank), tile = 2Bxxh[C + index], columns to the right
function drawIndirect8x8(hl, de, c) {
  do {
    var d0 = de;
    for (var i = 0; i < 8; i++) {
      wr(d0, 0);
      var idx = rd(hl);
      if (idx !== 0xFF) {
        wr(d0, rd(0x2B00 | u8(idx + c)));
      }
      d0++;
      hl++;
    }
    de = colRight(de);
  } while ((hl & 0x3F) !== 0);
} // drawIndirect8x8

function nextRound() {   // next_round [3230]: state 2, round+1, phase 0
  wr(0x43A4, 2);
  wr(0x43B8, u8((rd(0x43B8) & 0xF0) + 0x10));
  clearFg();
} // nextRound

// ---------------------------------------------------------------- death [0AEA] and game over [0B60]
function state4() {
  var de = (rd(0x43E2) << 8) | rd(0x43E3);
  var a = u8(rd(0x43A5) - 1);
  wr(0x43A5, a);
  if (a === 0) {
    deathLivesCheck();
    return;
  }
  if (a < 0x1F) {
    clearFg();
    return;
  }
  if (a === 0x1F) {
    deathStageRollback();
    return;
  }
  drawBigSprite(a - 0x20, de);
} // state4

// death_lives_check [0B15]: state 5; lives of the player - 1; 0 -> game over, else state 0
function deathLivesCheck() {
  wr(0x43A4, 5);
  var hl = 0x4390 + rd(0x43A3);
  var lives = rd(hl);
  if (lives === 0) {
    return;
  }
  wr(hl, --lives);
  drawLives();
  if (lives === 0) {
    return;
  }
  wr(0x43A4, 0);
} // deathLivesCheck

// death_stage_rollback [0BA0]: phase >= 4 -> phase - 1, scroll 0, clear BG (nothing in phase 0/1)
function deathStageRollback() {
  var a = rd(0x43B8) & 0x0E;
  if (a === 0) {
    return;
  }
  if (a >= 4) {
    wr(0x43B8, rd(0x43B8) - 1);
  }
  wr(0x43B9, 0);
  wr(0x5800, 0);
  clearBg();
} // deathStageRollback

// draw_big_sprite [0BB8]: odd index -> update_explosions; even: block from big_sprite_ptrs 2AA0h
function drawBigSprite(a, de) {
  if (a & 1) {
    updateExplosions();
    return;
  }
  var hl = 0x2AA0 + (rrc(a) & 0x7E);
  var ptr = (rd(hl) << 8) | rd(hl+1);
  if ((ptr >> 8) === 0x17) {   // L_0BDC: 6 rows x 8 columns (LXI B,0608h)
    de = (de + 0x5D) & 0xFFFF;
    var c = 8;
    for (var i = 0; i < 2; i++) {   // wrap_big_picture [0BEE]: column beyond the left edge -> skip it
      if ((de >> 8) === 0x43 && (de & 0xFF) >= 0x40) {
        de = (de & 0xFF00) | u8((de & 0xFF) - 0x20);
        ptr = (ptr & 0xFF00) | u8((ptr & 0xFF) + 6);
        c--;
      }
    }
    drawTileBlock(ptr, de, 6, c);
    return;
  }
  drawTileBlock(ptr, (de + 0x1F) & 0xFFFF, 3, 4);
} // drawBigSprite

function drawLives() {   // draw_lives [0367]
  wr(0x42A2, rd(0x4390) | 0x20);
  wr(0x4062, rd(0x4391) | 0x20);
} // drawLives

function state5() {   // state 5 [0B60]: GAME OVER
  var a = u8(rd(0x43A5) + 1);
  wr(0x43A5, a);
  if (a === 0x40) {
    clearBg();
    return;
  }
  if (a !== 0x80) {              // draw_game_over [0B95]
    drawTextBlocks(0x1A00, 1);
    drawTextBlocks(0x1960, 3);   // draw_copyright_rows [01E4]
    // rom_checksum_credits [1688] adds 0 for the original ROM — omitted
    return;
  }
  wr(0x43A4, 0);
  if (rd(0x4390) | rd(0x4391)) {
    return;
  }
  wr(0x4398, 0);
  wr(0x4399, 0);
  wr(0x43A2, 0);
  if (rd(0x43A3)) {
    wr(0x43A3, 0);
    unsupported('copy_ram_page after a 2-player game not ported');
  }
} // state5

// ---------------------------------------------------------------- score [2700]
function updateScore() {
  if (rd(0x43A2) === 0) {
    return;
  }
  var hl = 0x4383 + ((rd(0x43A3) & 1) << 2);
  wr(0x4397, 0xFF);
  for (var de = 0x4370; de < 0x4380; de += 4) {
    collectSlotScore(de, hl);
  }
  if (rd(0x43A4) >= 6) {
    addBcdScore(hl, rd(0x439D), 0);
    wr(0x439D, 0);
    wr(0x4397, 0);
  }
  if (rd(0x4397) === 0) {
    redrawScoreBonusLife(hl);
  }
  soundFrame();
} // updateScore

// collect_slot_score [2748]: slot with (timer & 1F) == 1 and points != 0: points x 10 -> score
function collectSlotScore(de, hl) {
  if ((rd(de) & 0x1F) !== 1) {
    return;
  }
  var a = rd(de+1);
  if (a === 0) {
    return;
  }
  addBcdScore(hl, (a >> 4) & 0x0F, (a << 4) & 0xF0);
  wr(de+1, 0);
  wr(0x4397, 0);
} // collectSlotScore

// add_bcd_score [0220]: 3-byte BCD score (HL = lowest byte) += BC
function addBcdScore(hl, b, c) {
  var r = bcdAdd(rd(hl), c, 0);
  wr(hl, r.v);
  r = bcdAdd(rd(hl-1), b, r.cy);
  wr(hl-1, r.v);
  r = bcdAdd(rd(hl-2), 0, r.cy);
  wr(hl-2, r.v);
} // addBcdScore

// redraw_score_bonus_life [2768]: redraw the score of the active player, bonus life at the threshold 43BD-43BF
function redrawScoreBonusLife(hl) {
  printBcd(hl, rd(0x43A3) ? 0x4021 : 0x4261, 6);
  if ((rd(0x43BD) | rd(0x43BE)) === 0) {
    return;
  }
  // cmp_bcd3 [0314]: threshold - score, carry when the score is higher
  var t = (rd(0x43BD) << 16) | (rd(0x43BE) << 8) | rd(0x43BF);
  var s = (rd(hl-2) << 16) | (rd(hl-1) << 8) | rd(hl);
  if (t >= s) {
    return;
  }
  var lp = 0x4390 + rd(0x43A3);
  wr(lp, rd(lp) + 1);
  drawLives();
  wr(0x436A, 0xFF);
  soundEvents.push('bonusLife');
  var mid = rd(0x43BE);
  wr(0x43BE, 0);
  wr(0x43BD, rrc(rrc(rrc(rrc(mid)))));
} // redrawScoreBonusLife

// ---------------------------------------------------------------- sound [2740]
function soundFrame() {
  // sound_regs_write [27A8]: shadows -> latches, shadows = 0Fh (silence)
  wr(0x6000, rd(0x438C));
  wr(0x6800, rd(0x438D));
  wr(0x438D, 0x0F);
  wr(0x438C, 0x0F);
  soundEngine();
} // soundFrame

// sound_engine [3B43]: compose 438C/438D for the next frame
function soundEngine() {
  // dispatch_3a70
  if (rd(0x43A4) !== 3) {
    // sound_player_explosion [27BD]: 4363 != 0 -> 8Fh and nothing else this frame
    var x = rd(0x4363);
    if (x !== 0) {
      if (x >= 0x40) {
        x = 0x40;
      }
      wr(0x4363, x - 1);
      wr(0x438C, 0x8F);
      return;
    }
  } else {
    switch (rd(0x43B8) & 7) {   // JT_3A8A
      case 1:
      case 5: soundWave(); break;
      case 2: soundPhase2(); break;
      case 3: soundPhase3(); break;
      case 6: soundPhase6(); break;
      case 7: soundPhase7(); break;
    }
  }
  soundBonusLife();
  soundPing();
  soundHitFlags();
  soundShotSod();
  // sound_flags_by_phase [3B00]: bits 6-7 of latch B by 43B8 & 0E
  var p = rd(0x43B8) & 0x0E;
  var b = p === 0 ? 0 : (p === 6 ? 0x40 : 0x80);
  wr(0x438D, (rd(0x438D) & 0x3F) | b);
} // soundEngine

// sound_wave [27E6]: dive (4BE3) or tone by the live enemies
function soundWave() {
  // sound_ms_state [3D7C]
  if (rd(0x4BD0) === 3) {
    wr(0x4BE3, 0x10);
  }
  var a = rd(0x4BE3);
  if (a !== 0) {
    wr(0x4BE3, a - 1);
    wr(0x438D, ((~a) & 0x0F) | 0x10);
    if (a === 0x10) {
      soundEvents.push('enemyDive');
    }
    return;
  }
  // sound_slots_scan [3D98]: B = live enemies, C = lowest formation shape index (< 30h)
  var b = 0, c = 0;
  for (var i = 0; i < 8; i++) {
    var rec = 0x4B70 + 4*i;
    if (rd(rec) & 0x08) {
      b++;
      if (rd(rec+1) < 0x30) {
        c = rd(rec+1);
      }
    }
  }
  if (b === 0) {
    return;
  }
  wr(0x438D, 0x2F);
  if (c === 0) {
    return;
  }
  wr(0x438D, (rrc(c) & 6) | 0x20);
} // soundWave

function soundPhase2() {   // sound_phase2 [3A9A]: engine hum by the scroll
  var s = rd(0x43B9);
  wr(0x438C, 0xAF);
  if (s >= 0xFD) { return; }
  wr(0x438C, 0xBF);
  if ((s & 7) === 0) { return; }
  wr(0x438C, 0x7F);
  if ((s & 1) === 0) { return; }
  wr(0x438C, 0x3F);
} // soundPhase2

function soundPhase3() {   // sound_phase3 [3AD0]
  if (rd(0x43BB) === 0) { return; }
  wr(0x438C, 0x3F);
  var s = rd(0x43B9);
  if (s < 0xF0) { return; }
  if (s & 7) { return; }
  wr(0x438C, 0x2F);
} // soundPhase3

// sound_phase6 [3AB4] (phases 6 and 7): 439A < 2: bit 0 of ROM[(439A&F)<<8 | 439B&FC] -> 438C = 0Dh
function soundPhase6() {
  var a = rd(0x439A);
  if (a >= 2) { return; }
  if (rd(((a & 0x0F) << 8) | (rd(0x439B) & 0xFC)) & 1) {
    wr(0x438C, 0x0D);
  }
} // soundPhase6

function soundPhase7() {   // sound_phase7 [3AE8]: descent tone (3DE0) or the velocity as tone B
  soundPhase6();
  if (rd(0x4395) === 0) {        // sound_landing_descent [3DE0]
    wr(0x438D, 0x3F);
    var s = rd(0x43B9);
    if (s >= 0xFC) { return; }
    wr(0x438D, 0x2F);
    if (!(s & 1)) { return; }
    wr(0x438C, rd(0x438C) | 0x40);
    return;
  }
  var v = rd(0x439C) & 0x7C;
  if (v === 0) { return; }
  wr(0x438D, rrc(rrc(v)));
} // soundPhase7

function soundBonusLife() {   // sound_bonus_life [3B33]
  var a = rd(0x436A);
  if (a === 0) { return; }
  wr(0x436A, a - 1);
  wr(0x438D, (a & 8) | 7);
} // soundBonusLife

function soundPing() {   // sound_ping [3B1B]
  var a = rd(0x4362);
  if (a === 0) { return; }
  a = (a - 1) & 0x3F;
  wr(0x4362, a);
  wr(0x438D, (rd(0x438D) & 0xF0) | (rlc(a) & 0x0C));
} // soundPing

function soundHitFlags() {   // sound_hit_flags [3A12]
  var a = rd(0x4369), b;
  if (a !== 0) {           // sound_hit_a [3A2A]
    a = u8((a & 0x3F) - 1);
    wr(0x4369, a);
    b = u8((rrc(rrc(rrc(a))) & 7) + (rrc(a) & 3));
    wr(0x438C, (rd(0x438C) & 0xF0) | b);
  }
  a = rd(0x4364);
  if (a !== 0) {           // sound_hit_b [3A48]
    a = u8((a & 0x1F) - 1);
    wr(0x4364, a);
    b = u8(((~rrc(rrc(a))) & 7) + (rlc(a) & 6));
    wr(0x438C, (rd(0x438C) & 0xF0) | b);
  }
  if (rd(0x4366) !== 0) {
    wr(0x4366, 0);
    wr(0x438C, rd(0x438C) | 0x40);
  }
} // soundHitFlags

function soundShotSod() {   // sound_shot_sod [27D2]: SOD = 1 while 4361 != 0
  var a = rd(0x4361);
  if (a === 0) {
    sod = 0;
    return;
  }
  wr(0x4361, (a - 1) & 2);
  sod = 1;
} // soundShotSod

// ---------------------------------------------------------------- attract / start (before the game)
function* clearScreensInit() {   // clear_screens_init [0140]
  clearBg();
  yield;
  yield* initGameVars();
} // clearScreensInit

function* initGameVars() {   // init_game_vars [0146]
  clearFg();
  wr(0x43A3, 2);
  wr(0x43A4, 0);
  zeroBlock(0x43B8, 8);
  wr(0x43BA, 0x10);
  wr(0x43BE, ((dsw & 0x0C) << 2) + 0x30);   // bonus life threshold 3000/4000/5000/6000
  wr(0x5800, 0);
  yield;
} // initGameVars

function getPlays() {   // get_plays [1760]
  var c = rd(0x438F);
  return (dsw & 0x10) ? (c >> 1) & 0x0F : c;
} // getPlays

function* pushStartScreen() {   // push_start_screen [0288]
  yield* clearScreensInit();
  drawTextBlocks(0x19C0, 2);
  var c = 2;
  if (getPlays() >= 2) {
    drawTextBlocks(0x1BA0, 1);
    c = 6;
  }
  var a = (~in0) & c;
  if (a === 0) {
    return;
  }
  // start_game_credits [02CB]
  var players = a === 2 ? 1 : 2;
  wr(0x43A2, players);
  var cost = (dsw & 0x10) ? players << 1 : players;
  var credits = u8(rd(0x438F) - cost);
  wr(0x438F, credits);
  wr(0x4142, credits + 0x20);
  updateHiScore();
  // clear_scores [032E]
  zeroBlock(0x4380, 8);
  printBcd(0x4383, 0x4261, 6);
  printBcd(0x4387, 0x4021, 6);
  // init_lives [0350]
  var lives = (dsw & 3) + 3;
  wr(0x4390, lives);
  if (rd(0x43A2) !== 1) {
    wr(0x4391, lives);
  }
  drawLives();
  yield* clearScreensInit();
  wr(0x5000, 1);
  yield* clearScreensInit();
  wr(0x5000, 0);
} // pushStartScreen

// update_hi_score [02F0]: P1 (and P2 against 43FD-43FF — original quirk) -> HI-SCORE, printed at 4141h
function updateHiScore() {
  cmpCopy3(0x4383, 0x438B);
  cmpCopy3(0x4387, 0x43FF);
  printBcd(0x438B, 0x4141, 6);
} // updateHiScore

function cmpCopy3(de, hl) {   // cmp_bcd3 [0314] + CNC copy3 [0320]: (DE) >= (HL) -> copy 3 bytes
  // the bytes are compared from the low byte (DE, HL) upwards with borrow = a 24-bit compare
  var a = (rd(de-2) << 16) | (rd(de-1) << 8) | rd(de);
  var b = (rd(hl-2) << 16) | (rd(hl-1) << 8) | rd(hl);
  if (a >= b) {
    copyBlock(de-2, hl-2, 3);
  }
} // cmpCopy3

function* attractSequence() {   // attract_sequence [00E3]
  inc16(0x4399);
  var ctr = (rd(0x4398) << 8) | rd(0x4399);
  if (ctr === 1) {                     // L_01E1
    yield* clearScreensInit();
    drawTextBlocks(0x1960, 3);         // draw_copyright_rows
    return;
  }
  if (ctr >= 2 && ctr < 0x120) {
    attractTypeText();
    return;
  }
  if (ctr === 0x120) {                 // init_bg_planet [0688]
    drawTileBlock(0x06B0, 0x42F0, 2, 6);
    wr(0x43B0, 0x4B);
    wr(0x43B1, 0x3A);
    wr(0x43B2, 0x16);
    wr(0x43B3, 0x40);
    for (var i = 0; i < 9; i++) {
      drawBgRowRle();
    }
    return;
  }
  if (ctr === 0x1B0) {                 // L_01E1 again: the title screen is cleared, the copyright rows
    yield* clearScreensInit();
    drawTextBlocks(0x1960, 3);
    return;
  }
  // cmp16_range [0260] takes both bounds inclusive (as 0002h-011Fh above)
  if (ctr >= 0x1C0 && ctr <= 0x1E0) {
    attractDemoStart();
    return;
  }
  if (ctr >= 0x200 && ctr <= 0x3C0) {   // LXI B,0200h (the listing shows the value as the label inc16)
    yield* attractEnemyShowcase();
    return;
  }
  if (ctr >= 0x400 && ctr <= 0x4AF) {
    attractShipAnim();
    return;
  }
  if (ctr >= 0x4E6) {                  // demo_play [03B0]: simulated controls + dispatch_state
    unsupported('attract mode beyond the counter 0x4E6 not ported (demo game: PL-M7)');
  }
} // attractSequence

// attract_ship_anim [03C0], counter 0400h-04AFh: two 2x2 pictures of 1400h under the title (4252h and 4132h),
// the picture from the counter's low byte: ((lo >> 1) & 1Ch), mirrored above 10h (CMA, ANI 0Ch), | 20h — the
// pictures 20h, 24h, 28h, 2Ch and back, 8 frames each. (The original reads the byte at HL, which inc16 leaves
// at 4398h when the low byte wrapped to 0 — at 0400h that byte is 04h and gives the same picture 20h.)
function attractShipAnim() {
  var a = rrc(rd(0x4399)) & 0x1C;
  if (a >= 0x10) {
    a = u8(~a) & 0x0C;
  }
  var hl = 0x1400 | (a | 0x20);
  blit2x2(hl, 0x4252);
  blit2x2(hl, 0x4132);
} // attractShipAnim

// attract_demo_start [1B0C], counter 01C0h-01E0h: the state machine runs (state 0 -> 1, then forced to 2:
// the planet of phase 0 rises at the bottom of the screen for the rest of the range), 4BE8h/4BE9h are
// primed for the showcase (64 frames, table entry 1AB0h) and the state is forced to 2 with 43BA = 1
// until state 3 is reached. 43A3h is 2 (init_game_vars), so state 0 does not switch the page.
function attractDemoStart() {
  dispatchState();
  wr(0x4BE8, 0x40);
  wr(0x4BE9, 0xB0);
  if (rd(0x43A4) === 3) {
    return;
  }
  wr(0x43A4, 2);
  wr(0x43BA, 1);
} // attractDemoStart

// attract_enemy_showcase [1AD0], counter 0200h-03C0h: the title. Table 1AB0h, 4 bytes an entry [dest hi,
// dest lo, letter data lo, columns], one entry per letter of PLEIADS, 64 frames each (4BE8h counts down,
// 4BE9h = entry offset from B0h). On an even count draw_big_sprite paints the monster picture
// 2AA0h[(count >> 1) & 7E] at the entry's foreground address (16 pictures, 4 frames each = the morphing
// monster), on an odd count it animates the explosion slots; at the count 20h the letter is laid into the
// BACKGROUND (dest + 081Eh: one column left, two rows up) as a 7-row block of the star tiles 65h/6Ah/6Dh
// from 1A00h + data lo (L_1AE8). At 0: the next entry and clear_fg; past the last entry (offset C8h,
// reached exactly at the counter 03C0h) attract_reinit.
function* attractEnemyShowcase() {
  var count = u8(rd(0x4BE8) - 1);
  wr(0x4BE8, count);
  if (count === 0) {                   // L_1AF8
    wr(0x4BE8, 1);
    var offset = rd(0x4BE9);
    if (offset === 0xC8) {
      yield* attractReinit();
      return;
    }
    wr(0x4BE9, u8(offset + 4));
    wr(0x4BE8, 0x40);
    clearFg();
    return;
  }
  var entry = 0x1A00 | rd(0x4BE9);
  var de = (rd(entry) << 8) | rd(entry+1);
  if (count !== 0x20) {
    drawBigSprite(count, de);
    return;
  }
  drawTileBlock(0x1A00 | rd(entry+2), (de + 0x081E) & 0xFFFF, 7, rd(entry+3));
} // attractEnemyShowcase

// attract_reinit [1C00], once at the counter 03C0h (the end of the showcase): init_game_vars (with its
// wait), palette + clear_bg_block (S_1B27), the copyright rows, and a hidden checksum of the
// copyright row just drawn: A = 7Bh + the 26 tiles of row 1Dh (401Dh + 20h*i; HL = 19C0h after
// draw_text_blocks, + 265Dh), added to 4381h (score P1, high byte). The original text sums to 200h, so
// it adds 0; an altered copyright would corrupt the score.
function* attractReinit() {
  yield* initGameVars();
  setPalette();                        // S_1B27
  clearBgBlock();
  drawTextBlocks(0x1960, 3);
  var hl = 0x19C0 + 0x265D, a = 0x7B;
  for (var i = 0; i < 26; i++) {
    a = u8(a + rd(hl));
    hl = (hl + 0x20) & 0xFFFF;
  }
  hl = (hl + 0x24) & 0xFFFF;
  wr(hl, u8(a + rd(hl)));
} // attractReinit

// the attract counter 4398h/4399h, or -1 in a game (43A2h != 0)
function attractCounter() {
  return rd(0x43A2) ? -1 : ((rd(0x4398) << 8) | rd(0x4399));
} // attractCounter

// attract_type_text [0196]: one character per frame of the text rows 1860h+ (row = counter / 32)
function attractTypeText() {
  var a = rd(0x4399) & 0x1F;
  if (a < 6) {
    return;
  }
  var row = 0x1860 + (((rd(0x4398) << 8) | rd(0x4399)) & 0xFFE0);
  wr(0x43A8, row >> 8);
  wr(0x43A9, row & 0xFF);
  var de = (rd(row) << 8) | rd(row+1);
  var hl = (row & 0xFF00) | u8((row & 0xFF) + a);
  for (var c = a - 6; c > 0; c--) {
    de = colRight(de);
  }
  wr(de, rd(hl));
  // coin_text_by_dip [1740]: only with DSW bit 4 (2 coins per play) — not modelled
} // attractTypeText

// ---------------------------------------------------------------- the main program [0008]
function* mainProgram() {
  // reset: SP, 5000h = 0, protection_check -> hw_reset_clear_ram [0050]
  wr(0x5000, 0);
  wr(0x6800, 0);
  wr(0x6000, 0);
  wr(0x5800, 0);
  pages[0].fill(0, 0, 0xBF9);
  pages[1].fill(0, 0, 0xBF9);
  drawTextBlocks(0x1800, 3);
  while (true) {                       // main_loop [001A]
    yield;                             // wait_vblank_read_inputs
    if (stopped) {
      return;
    }
    if (rd(0x43A2)) {
      dispatchState();
      updateScore();                   // S_2700 (+ sound_frame)
      continue;
    }
    // attract / credits
    if (dsw & 0x40) {
      soundFrame();
    } else {                           // sound_off [03E0]
      wr(0x438C, 0x0F);
      wr(0x6000, 0x0F);
      wr(0x438D, 0x8F);
      wr(0x6800, 0x8F);
      sod = 0;
    }
    if (getPlays()) {
      yield* pushStartScreen();
    } else {
      yield* attractSequence();
    }
  }
} // mainProgram

// ---------------------------------------------------------------- the frame
function tick() {
  if (stopped) {
    frameNo++;
    return;
  }
  if (frameNo >= BOOT_FRAMES) {
    readInputs();
    program.next();
  }
  frameNo++;
} // tick

var PHASE_NAMES = ['intro', 'wave', 'flight', 'mothership', 'intro', 'wave', 'landing', 'landing'];

function gameStateName() {
  var st = rd(0x43A4), phase = rd(0x43B8) & 0x0F;
  if (rd(0x43A2) === 0) {
    return gameOverPosted ? 'gameOver' : 'intro';
  }
  switch (st) {
    case 4: return 'dying';
    case 5: return 'gameOver';
    case 6:
    case 7: return 'bonus';
    case 2:
    case 3: return PHASE_NAMES[phase];
    default: return 'intro';
  }
} // gameStateName

function frameMessage() {
  var msg = {
    id: 'frame',
    frame: frameNo,
    page: pages[videoreg & 1],   // the page the hardware displays (5000h bit 0)
    paletteBank: (videoreg >> 1) & 3,
    scroll: scrollReg,
    score: bcdToInt(rd(0x4381), rd(0x4382), rd(0x4383)),
    hiScore: bcdToInt(rd(0x4389), rd(0x438A), rd(0x438B)),
    lives: rd(0x4390),
    state: gameStateName(),
    round: rd(0x43B8) >> 4,
    phase: rd(0x43B8) & 0x0F,
    sounds: soundEvents,
    latches: {a: soundA, b: soundB, sod: sod},
    attract: rd(0x43A2) ? false : attractCounter(),   // the attract counter (BootModel), false in a game
    stopped: stopped ? stopReason : false
  };
  soundEvents = [];
  return msg;
} // frameMessage

function postFrame() {
  var msg = frameMessage();
  postMessage(msg);
  // informative: 43B8 (round<<4 | phase) went up = a phase or a round was completed; the game goes on
  var stage = rd(0x43B8);
  if (rd(0x43A2) && lastStage >= 0 && stage > lastStage) {
    postMessage({id: 'roundComplete', round: stage >> 4, phase: stage & 0x0F, completed: lastStage});
  }
  lastStage = rd(0x43A2) ? stage : -1;
  if (!gameOverPosted && rd(0x43A4) === 5 && rd(0x43A5) >= 0x80) {
    gameOverPosted = true;
    postMessage({id: 'gameOver', score: msg.score, hiScore: msg.hiScore});
    paused = true;
  }
} // postFrame

function now() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
} // now

function gameLoop() {
  var t = now();
  if (lastTime === false) {
    lastTime = t;
  }
  accumulator += (t - lastTime)*speed;
  lastTime = t;
  if (accumulator > 250) {
    accumulator = 250;   // never catch up more than a quarter of a second
  }
  var ticked = false;
  while (accumulator >= TICK_MS && !paused) {
    tick();
    accumulator -= TICK_MS;
    ticked = true;
    if (typeof initData.pauseAtAttract == 'number' && attractCounter() >= initData.pauseAtAttract) {
      paused = true;   // the boot has seen what it came for (BootModel resets the worker)
    }
  }
  if (ticked) {
    postFrame();
  }
  if (!paused && !stopped) {
    nextLoop = setTimeout(gameLoop, Math.max(1, TICK_MS - accumulator));
  } else if (stopped) {
    postFrame();
  }
} // gameLoop

function resetMachine(data) {
  initData = data || {};
  strictRom = !!initData.headless;
  loadTables(initData.tables);
  pages[0].fill(0);
  pages[1].fill(0);
  videoreg = 0;
  scrollReg = 0;
  soundA = 0;
  soundB = 0;
  sod = 0;
  frameNo = 0;
  stopped = false;
  stopReason = '';
  lastStage = -1;
  gameOverPosted = false;
  soundEvents = [];
  paused = false;
  lastTime = false;
  accumulator = 0;
  speed = 1;
  controls.left = controls.right = controls.fire = false;
  var dip = initData.dip || {};
  var lives = Math.min(6, Math.max(3, dip.lives || 3)) - 3;
  var bonus = Math.min(6, Math.max(3, dip.bonus || 3)) - 3;
  dsw = lives | (bonus << 2) | 0x60;   // 1 coin/play, demo sounds on
  if (initData.dsw !== undefined) {
    dsw = initData.dsw & 0x7F;
  }
  // input script: sources/reference/input-start.txt (coin at 10-14, 1P start at 40-44)
  inputScript = initData.inputScript || [{frame: 10, in0: 0xF6}, {frame: 15, in0: 0xF7}, {frame: 40, in0: 0xF5}, {frame: 45, in0: 0xF7}];
  program = mainProgram();
  program.next();   // reset code up to the first wait
} // resetMachine

// headless access for the regression test (tools/regress.mjs)
if (typeof self !== 'undefined') {
  self.__pl = {
    tick: tick,
    frame: function() { return frameNo; },
    rd: rd,
    pages: pages,
    page: pages[0],
    regs: function() { return {videoreg: videoreg, scroll: scrollReg, soundA: soundA, soundB: soundB, sod: sod, in0: in0}; },
    controls: controls,
    stopped: function() { return stopped ? stopReason : false; },
    attract: attractCounter,
    message: frameMessage,
    setScript: function(script) { inputScript = script; },
    // snapshot/restore of the machine state — valid while the program waits in the main loop
    // (game mode, no nested wait inside clear_screens_init), used by the autopilot of regress.mjs
    snapshot: function() {
      return {p0: pages[0].slice(0), p1: pages[1].slice(0), videoreg: videoreg, scroll: scrollReg, soundA: soundA, soundB: soundB,
        sod: sod, in0: in0, frameNo: frameNo, stopped: stopped, sounds: soundEvents.slice(0)};
    },
    restore: function(s) {
      pages[0].set(s.p0);
      pages[1].set(s.p1);
      videoreg = s.videoreg; scrollReg = s.scroll; soundA = s.soundA; soundB = s.soundB;
      sod = s.sod; in0 = s.in0; frameNo = s.frameNo; stopped = s.stopped; soundEvents = s.sounds.slice(0);
    }
  };
}

var resetDone = false; // set by 'reset', cleared by 'init'

onmessage = function(event) {
  var msg = event.data;
  switch (msg.id) {
    case 'init':
      clearTimeout(nextLoop);
      resetDone = false;
      resetMachine(msg.initData);
      if (!initData.headless) {
        if (typeof initData.fastForwardAttract == 'number') {
          // the boot (BootModel, no coin): run silently to the given attract counter
          while (attractCounter() < initData.fastForwardAttract && frameNo < 4000 && !stopped) {
            tick();
          }
          soundEvents = [];
        } else if (initData.fastForward !== false) {
          // fast forward to state 1 (frame 48 with the default script): the model starts at "get ready"
          while (rd(0x43A4) !== 1 && frameNo < 400 && !stopped) {
            tick();
          }
          soundEvents = [];
        }
        postFrame();
        gameLoop();
      }
      break;

    case 'controls':
      if ('action' in msg) {
        controls[msg.action] = !!msg.value;
      } else {
        controls.left = !!msg.left;
        controls.right = !!msg.right;
        controls.fire = !!msg.fire;
      }
      break;

    case 'tick':
      if (resetDone) {
        break; // after 'reset' the worker is idle until the next 'init' (WORKER-PROTOCOL.md)
      }
      tick();
      postFrame();
      break;

    case 'pause':
      paused = true;
      clearTimeout(nextLoop);
      break;

    case 'speed':
      speed = Math.max(1, msg.factor || 1);
      break;

    case 'continue':
      clearTimeout(nextLoop);
      if (!stopped && !gameOverPosted) {
        paused = false;
        lastTime = false;
        gameLoop();
      }
      break;

    case 'reset':
      clearTimeout(nextLoop);
      nextLoop = false;
      paused = true;
      resetDone = true;
      controls.left = controls.right = controls.fire = false;
      break;
  }
}; // onmessage
