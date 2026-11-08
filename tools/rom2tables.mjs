#!/usr/bin/env node
/**
 * rom2tables — extracts the data tables of the Pleiads program ROM into
 * data/tables.json for app/gameWorker.js (the worker rebuilds a sparse 16 KiB
 * ROM image from them and reads every table 1:1 at its original address).
 *
 * usage: node tools/rom2tables.mjs [--rom sources/rom/pleiads] [--out data/tables.json]
 *
 * The program ROM is 8 x 2 KiB (order as in MAME ROM_START(pleiads)):
 *   ic47.r1 ic48.r2 ic47.bin ic48.bin ic51.r5 ic50.bin ic53.r7 ic52.bin
 * The table list (address, length, description) follows the disassembly
 * sources/asm/pleiades/pleiads.asm and its notes (notes/B, notes/D).
 *
 * tables.json: { "rom": "pleiads", "sha1": {file: sha1}, "tables": [
 *   {"name", "addr": "0x1000", "len": 1024, "desc", "data": [bytes]} ] }
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const romDir = path.resolve(root, opt('--rom', 'sources/rom/pleiads'));
const outFile = path.resolve(root, opt('--out', 'data/tables.json'));

const ROM_FILES = ['ic47.r1', 'ic48.r2', 'ic47.bin', 'ic48.bin', 'ic51.r5', 'ic50.bin', 'ic53.r7', 'ic52.bin'];
const rom = new Uint8Array(0x4000);
const sha1 = {};
ROM_FILES.forEach((f, i) => {
  const buf = fs.readFileSync(path.join(romDir, f));
  if (buf.length !== 0x800) {
    throw new Error(`${f}: expected 2048 bytes, got ${buf.length}`);
  }
  rom.set(buf, i * 0x800);
  sha1[f] = crypto.createHash('sha1').update(buf).digest('hex');
});

// [addr, len, name, description] — see pleiads.asm labels
const TABLES = [
  [0x0420, 0x10, 'palette_table', 'set_palette 06BC: 4x4 palette bits (bits 1-2 of 5000h) by (43B8<<1)&0C | min(3, 43BA+43BB-1)'],
  [0x0538, 0x04, 'ship_init', 'init_ship 052A: 43C0..43C3 = flags, shape, X, Y'],
  [0x0598, 0x20, 'phase_param_blocks', 'init_bg_ptrs 0580: 4x8 B -> 43B0..43B7 by (43B8&6): bg dest hi/row, RLE src hi/lo, wave table ptr, stage0 timer'],
  [0x06B0, 0x0C, 'attract_ship_block', 'init_bg_planet 0688: 2x6 tile block drawn at 42F0h (attract)'],
  [0x0A00, 0x40, 'column_vram_table', 'xy_to_vram 09BA: 26 words (hi,lo) VRAM address of column X>>3 (4320h..4000h), zero padded'],
  [0x0A40, 0x11, 'target_tile_anim', 'L_0ABC: tiles 2Ch-33h animation of the phase-2 target'],
  [0x0B38, 0x10, 'player_hitbox_table', 'calc_ship_hitbox 097A: 8 x (left, right) width by X&7'],
  [0x1000, 0x400, 'attack_scripts', 'enemy movement scripts: bytes = cmd 01h-1Fh (delta 1700h, animation 16C0h), 00h = end, FFh = filler'],
  [0x1400, 0x100, 'sprite_quads', '64 x 4 tile codes of a 2x2 sprite: [x,y],[x,y+1],[x+1,y],[x+1,y+1] (draw_2x2 07D2, blit_2x2_from_1400 07DC)'],
  [0x1500, 0x100, 'explosion_gfx', 'explosion frames (offsets from 2A00h) and big images 156Ch+ (draw_big_sprite 0BB8)'],
  [0x1600, 0x40, 'tile_anim_tables', '1600 ship tile by X&7, 1608-161F/1628-163F quad indexes for enemy animation, 1620 shot tile by X&7'],
  [0x1640, 0x48, 'bg_rle_planet', 'draw_bg_row_rle 0650 source used by init_bg_planet 0688 (attract planet)'],
  [0x16C0, 0x40, 'enemy_cmd_anim', 'enemy_select_tile 0D86: per cmd [mode 01/02/04, base into 1600h]'],
  [0x1700, 0x40, 'enemy_cmd_delta', 'enemy_move_step 0D30: per cmd (dX, dY) signed per odd frame'],
  [0x176D, 0x93, 'big_image_tiles', 'tiles D0h-FFh of the big images (attract showcase, ship death sprite) referenced from 2AA0h'],
  [0x1800, 0x2C0, 'text_rows', 'draw_text_blocks 01D0 records (32 B: dest hi,lo, 4 pad, 26 tiles): header, attract texts, PUSH START, GAME OVER; 1A20 star image; 1AB0 showcase table'],
  [0x1B40, 0x40, 'bg_planet_block', 'phase4_picture 053C: 4x11 planet block; 1B70 ship tile variants for draw_player_ship_tiles 33BC'],
  [0x1B80, 0x40, 'text_rows_2', 'texts: ONCE MORE CHALLENGE, 1 OR 2PLAYERS BUTTON (draw_text_blocks records)'],
  [0x1BC0, 0x40, 'phase6_planet_picture', 'phase6_planet_scroll 2360: 2 draw_text_blocks records (SOS SOS SOS, AT ONCE RETURN TO EARTH) drawn every frame of phase 6'],
  [0x1C20, 0x340, 'bg_rle_data', 'RLE background rows for draw_bg_row_rle 0650 (phase 0 source 1DD8h from 0598h, phase 4 1B40h.., landing 1C20h)'],
  [0x1F60, 0xA0, 'landing_marker_table', 'landing_markers 24A0: 40 x [scroll, round mask, VRAM hi, lo]'],
  [0x20F8, 0x08, 'ground_hit_anim2_frames', 'ground_hit_anim2 20D4: offsets into 1500h by timer & 7'],
  [0x24EC, 0x08, 'landing_marker_tiles', 'landing_marker_check 24CD: 2 x 4 tiles (70 72 71 73 / 74 76 75 77) of the 2x2 runway markers'],
  [0x2230, 0x44, 'bg_anim_table', 'bg_anim_phase1 215C: 8 x [VRAM_BG hi, lo, base, 0] + 4 x 8 tile codes'],
  [0x2350, 0x10, 'fractional_step_masks', 'fractional_step 2326: bit masks 01..80 and probability bytes FE E0 D0 A9 D4 E0 F8 80'],
  [0x2800, 0x100, 'attack_script_ptrs', 'spawn_select_script 30DE: 128 pointers (hi,lo) to attack scripts'],
  [0x2900, 0x100, 'wave_table', 'spawn_load_wave 303F: 64 x [repeat<<4 | count, delay, X, Y]; 2900-297F phase 1, 2980-29FF phase 2'],
  [0x2A00, 0xA0, 'explosion_frames', 'explosion_draw_frame 0F95: pairs [offset in 1500h, width code 20/40/60]; 2A60.. ground hit frames'],
  [0x2AA0, 0x20, 'big_sprite_ptrs', 'draw_big_sprite 0BB8: 16 pointers (hi,lo) to tile blocks'],
  [0x2AC0, 0x20, 'shot_hitbox_table', 'check_bullet_tile 0E04: 8 x [min X&7, max X&7, X correction, FF] by enemy tile & 7'],
  [0x2B00, 0x100, 'bonus_picture_tables', 'state 7 pictures: 2B00 indexes, 2B80 table, 2BA0 tiles, 2BC0 landing pad lights'],
  [0x2C00, 0x3C0, 'attack_scripts2', 'more attack scripts (same format as 1000h)'],
  [0x3266, 0x10, 'landing_tables', 'landing_finished 31A8: 3266 precision by X&7 (01 02 03 03 03 02 01 01), 326E bonus BCD x100 (40 05 10 15 20 25 30 35)'],
  [0x33A8, 0x14, 'terrain_collision_masks', 'landing_collision_mask 334C'],
  [0x33F8, 0x08, 'target_indicator_tiles', 'draw_target_indicators 37D0'],
  [0x37BE, 0x12, 'landing_anim_table', 'landing_anim_tiles 3790: 37C0 4 x [count, step, VRAM hi, lo] by (439B>>1)&3, tiles 78h-7Bh cycle'],
  [0x3890, 0x11, 'armor_damaged_tiles', 'mothership_hit_other 38BA: new slot type by (old type - 8) | (bullet X < slot X) << 3 (slot_set_damaged 3CE0)'],
  [0x3B5D, 0xA3, 'mothership_hit_masks', 'mothership_hit_test 3800: bit masks by shot X&7 (3E00h[X&7]): 3B60+tile-90h armor (tiles 90h-CFh, mothership_hit_armor 3844), 3B90+tile-90h other parts (mothership_hit_other 38BA)'],
  [0x3C00, 0xE0, 'mothership_strips_a', 'mothership tile strips (slot_draw 34C0)'],
  [0x3D00, 0x7C, 'mothership_strips_b', 'mothership tile strips'],
  [0x3DB7, 0x29, 'ms_fire_slot_table', 'mothership_fire 3930: [count, first slot lo] by 4BD2&1E'],
  [0x3DF6, 0x12, 'bit_mask_table', '3E00h-3E07h = 1<<n (target_piece_hit 0E50, landing_collision_mask 334C)'],
  [0x3E08, 0x78, 'strip_ptr_table', 'slot_draw 34C0: 60 pointers to strips'],
  [0x3E80, 0x40, 'script_param_table', 'slot_script_params 3560: pairs [436E, 436D base]'],
  [0x3EC0, 0x10, 'strip_entry_offsets', 'entry offsets into tile_copy_unrolled 3520 by slot type'],
  [0x3ED0, 0x10, 'ms_scroll_step_table', 'mothership_move 2600: 4x4 fractional scroll steps'],
  [0x3EE0, 0x20, 'ms_speed_cap_table', 'mothership_calc_speed 2668'],
  [0x3F00, 0x80, 'script_table', 'run_script_entry 35BE: 16 x 4 words [param1, param2, routine2, routine1]'],
  [0x3F80, 0x80, 'ms_slot_init', 'init_mothership_slots 32C4: 8 x 8 B initial slots [type, VRAM hi, lo, frame, timer, X, step, stop] for 4B70-4BAF; 3F80 even round, 3FC0 odd round']
];

// the remaining ranges are program code; the game reads a few of them as data through
// out-of-range addressing (e.g. formation_trail 2454 with an enemy beyond the right edge reads
// the "background" at 08xxh), so the worker gets the complete ROM image: code ranges are added
// as `code_XXXX` tables
const covered = new Uint8Array(0x4000);
TABLES.forEach(([addr, len]) => covered.fill(1, addr, addr + len));
for (let a = 0; a < 0x4000;) {
  if (covered[a]) { a++; continue; }
  let b = a;
  while (b < 0x4000 && !covered[b]) b++;
  TABLES.push([a, b - a, 'code_' + a.toString(16).toUpperCase().padStart(4, '0'), 'program code ' + a.toString(16).toUpperCase().padStart(4, '0') + 'h-' + (b - 1).toString(16).toUpperCase().padStart(4, '0') + 'h (complete ROM image for out-of-range reads)']);
  a = b;
}
TABLES.sort((x, y) => x[0] - y[0]);

const tables = TABLES.map(([addr, len, name, desc]) => ({
  name,
  addr: '0x' + addr.toString(16).toUpperCase().padStart(4, '0'),
  len,
  desc,
  data: Array.from(rom.subarray(addr, addr + len))
}));

const out = {
  rom: 'pleiads',
  generated: 'tools/rom2tables.mjs',
  sha1,
  tables
};
fs.mkdirSync(path.dirname(outFile), {recursive: true});
fs.writeFileSync(outFile, JSON.stringify(out, (k, v) => v, 0).replace(/"data":\[/g, '\n"data":[') + '\n');
const total = tables.reduce((s, t) => s + t.len, 0);
console.log(`${tables.length} tables, ${total} bytes -> ${path.relative(root, outFile)}`);
