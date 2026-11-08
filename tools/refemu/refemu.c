/*
 * refemu — headless reference emulator of the Pleiads arcade board
 * (Tehkan 1981; Intel 8085A, 5.5 MHz clock = 2.75 MHz T-states, no interrupts,
 * the code synchronises itself by polling /VBLANK on DSW bit 7).
 * Self-contained: 8085 core included, no external dependencies.
 * Modelled after spaceinvaders/tools/refemu/refemu.c.
 *
 * usage: refemu [--rom DIR] --frames N [--script input.txt] [--dump-at FRAME:file]...
 *               [--trace out.tsv] [--watch ADDR,ADDR...] [--stop-when ADDR=VAL]
 *               [--stop-phase1 file]
 * See README.md for the file formats.
 *
 * Memory map (verified against MAME phoenix.cpp / phoenix_v.cpp):
 *   0000-3FFF ROM (8 x 2 KiB)
 *   4000-4FFF RAM/VRAM, two pages selected by bit 0 of the last write to 5000-53FF
 *   5000-53FF W video register: bit0 page, bits1-2 palette, (value & 0xFC) = protection question
 *   5800-5BFF W background scroll
 *   6000-63FF W sound latch A, 6800-6BFF W sound latch B
 *   7000-73FF R IN0: bit0 coin, bit1 start1, bit2 start2, bit3 protection answer,
 *                    bit4 fire, bit5 right, bit6 left, bit7 unused (all active low)
 *   7800-7BFF R DSW: bits0-1 lives, bits2-3 bonus, bit4 coinage, bit5=1, bit6 demo sounds,
 *                    bit7 = /VBLANK (0 during vertical blanking, lines 208-255 of 256)
 * Frame = 45056 T-states (61.035 Hz); VBLANK starts at T-state 36608 (line 208 of 256, 176 T/line).
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#define T_PER_FRAME 45056
#define T_PER_LINE  176
#define VBLANK_LINE 208
#define T_VBLANK_START (VBLANK_LINE * T_PER_LINE)  /* 36608 */

/* ------------------------------------------------------------------ board */
static uint8_t rom[0x4000];
static uint8_t ram[2][0x1000];
static uint8_t videoreg = 0;        /* last write to 5000h */
static uint8_t scroll = 0;          /* last write to 5800h */
static uint8_t sound_a = 0, sound_b = 0;
static uint8_t in0_ext = 0xF7;      /* IN0 bits 0-2,4-7 from script (bit3 computed) */
static uint8_t dsw_base = 0x60;     /* 3 lives, bonus 3K, coinage 0, bit5=1, demo sounds on */
static long t_in_frame = 0;         /* T-states elapsed in the current frame */
static int in_vblank(void) { return t_in_frame >= T_VBLANK_START; }
static int verbose = 0;
static int frame_no = 0;
static int dbg_write = -1;
struct cpu { uint8_t A, B, C, D, E, H, L, F; uint16_t PC, SP; int halted; int inte; uint8_t im; };
static struct cpu cpu;

static uint8_t protection_answer(void) {
  switch (videoreg & 0xFC) {
    case 0x00: case 0x20: return 0;
    case 0x0C: case 0x30: return 1;
    default:
      if (verbose) fprintf(stderr, "frame %d: unknown protection question %02X\n", frame_no, videoreg & 0xFC);
      return 0;
  }
}

static uint8_t mem_read(uint16_t a) {
  if (a < 0x4000) return rom[a];
  if (a < 0x5000) return ram[videoreg & 1][a & 0x0FFF];
  switch (a & 0xF800) {
    case 0x7000: return (in0_ext & 0xF7) | (protection_answer() ? 0x08 : 0);
    case 0x7800: return (dsw_base & 0x7F) | (in_vblank() ? 0x00 : 0x80);
  }
  return 0xFF;
}

static void mem_write(uint16_t a, uint8_t v) {
  if (a < 0x4000) return;
  if (a < 0x5000) { if (dbg_write >= 0 && a == dbg_write) fprintf(stderr, "frame %d: write %04X=%02X at PC=%04X BC=%02X%02X DE=%02X%02X HL=%02X%02X SP=%04X\n", frame_no, a, v, cpu.PC, cpu.B, cpu.C, cpu.D, cpu.E, cpu.H, cpu.L, cpu.SP); ram[videoreg & 1][a & 0x0FFF] = v; return; }
  switch (a & 0xF800) {
    case 0x5000: videoreg = v; break;
    case 0x5800: scroll = v; break;
    case 0x6000: sound_a = v; break;
    case 0x6800: sound_b = v; break;
  }
}

/* -------------------------------------------------------------- 8085 core */
#define FS 0x80
#define FZ 0x40
#define FA 0x10
#define FP 0x04
#define FC 0x01

static uint8_t parity_tab[256];
static void init_tables(void) {
  for (int i = 0; i < 256; i++) { int p = 0; for (int b = 0; b < 8; b++) p ^= (i >> b) & 1; parity_tab[i] = p ? 0 : FP; }
}
static void set_szp(uint8_t r) { cpu.F = (cpu.F & (FC | FA)) | (r & FS) | (r == 0 ? FZ : 0) | parity_tab[r]; }
static uint16_t rd16(uint16_t a) { return mem_read(a) | (mem_read(a + 1) << 8); }
static void wr16(uint16_t a, uint16_t v) { mem_write(a, v & 0xFF); mem_write(a + 1, v >> 8); }
static uint8_t fetch8(void) { return mem_read(cpu.PC++); }
static uint16_t fetch16(void) { uint16_t v = rd16(cpu.PC); cpu.PC += 2; return v; }
static uint16_t HL(void) { return (cpu.H << 8) | cpu.L; }
static uint16_t BC(void) { return (cpu.B << 8) | cpu.C; }
static uint16_t DE(void) { return (cpu.D << 8) | cpu.E; }
static void push(uint16_t v) { cpu.SP -= 2; wr16(cpu.SP, v); }
static uint16_t pop(void) { uint16_t v = rd16(cpu.SP); cpu.SP += 2; return v; }

static uint8_t get_r(int r) {
  switch (r) { case 0: return cpu.B; case 1: return cpu.C; case 2: return cpu.D; case 3: return cpu.E;
    case 4: return cpu.H; case 5: return cpu.L; case 6: return mem_read(HL()); default: return cpu.A; }
}
static void set_r(int r, uint8_t v) {
  switch (r) { case 0: cpu.B = v; break; case 1: cpu.C = v; break; case 2: cpu.D = v; break; case 3: cpu.E = v; break;
    case 4: cpu.H = v; break; case 5: cpu.L = v; break; case 6: mem_write(HL(), v); break; default: cpu.A = v; }
}
static uint16_t get_rp(int p) { switch (p) { case 0: return BC(); case 1: return DE(); case 2: return HL(); default: return cpu.SP; } }
static void set_rp(int p, uint16_t v) {
  switch (p) { case 0: cpu.B = v >> 8; cpu.C = v; break; case 1: cpu.D = v >> 8; cpu.E = v; break;
    case 2: cpu.H = v >> 8; cpu.L = v; break; default: cpu.SP = v; }
}

static void alu_add(uint8_t v, int carry) {
  int r = cpu.A + v + carry;
  int ac = ((cpu.A & 0x0F) + (v & 0x0F) + carry) > 0x0F;
  cpu.F = (r > 0xFF ? FC : 0) | (ac ? FA : 0);
  cpu.A = r; set_szp(cpu.A);
}
static void alu_sub(uint8_t v, int borrow, int store) {
  int r = cpu.A - v - borrow;
  int ac = ((cpu.A & 0x0F) - (v & 0x0F) - borrow) >= 0;  /* 8085: AC set when no half-borrow */
  uint8_t res = r;
  cpu.F = (r < 0 ? FC : 0) | (ac ? FA : 0);
  uint8_t sa = cpu.A; cpu.A = res; set_szp(res); if (!store) cpu.A = sa;
}
static void alu_logic(int op, uint8_t v) {
  switch (op) {
    case 0: cpu.A &= v; cpu.F = FA; break;      /* ANA: AC = 1 on 8085 */
    case 1: cpu.A ^= v; cpu.F = 0; break;
    case 2: cpu.A |= v; cpu.F = 0; break;
  }
  set_szp(cpu.A);
}
static int cond(int c) {
  switch (c) { case 0: return !(cpu.F & FZ); case 1: return cpu.F & FZ; case 2: return !(cpu.F & FC); case 3: return cpu.F & FC;
    case 4: return !(cpu.F & FP); case 5: return cpu.F & FP; case 6: return !(cpu.F & FS); default: return cpu.F & FS; }
}

/* 8085 T-state table (base; conditional ops add on taken branch) */
static const uint8_t cyc[256] = {
 4,10, 7, 6, 4, 4, 7, 4, 10,10, 7, 6, 4, 4, 7, 4,
 7,10, 7, 6, 4, 4, 7, 4, 10,10, 7, 6, 4, 4, 7, 4,
 7,10,16, 6, 4, 4, 7, 4, 10,10,16, 6, 4, 4, 7, 4,
 7,10,13, 6,10,10,10, 4, 10,10,13, 6, 4, 4, 7, 4,
 4, 4, 4, 4, 4, 4, 7, 4,  4, 4, 4, 4, 4, 4, 7, 4,
 4, 4, 4, 4, 4, 4, 7, 4,  4, 4, 4, 4, 4, 4, 7, 4,
 4, 4, 4, 4, 4, 4, 7, 4,  4, 4, 4, 4, 4, 4, 7, 4,
 7, 7, 7, 7, 7, 7, 5, 7,  4, 4, 4, 4, 4, 4, 7, 4,
 4, 4, 4, 4, 4, 4, 7, 4,  4, 4, 4, 4, 4, 4, 7, 4,
 4, 4, 4, 4, 4, 4, 7, 4,  4, 4, 4, 4, 4, 4, 7, 4,
 4, 4, 4, 4, 4, 4, 7, 4,  4, 4, 4, 4, 4, 4, 7, 4,
 4, 4, 4, 4, 4, 4, 7, 4,  4, 4, 4, 4, 4, 4, 7, 4,
 6,10, 7,10, 9,12, 7,12,  6,10, 7,10, 9,17, 7,12,
 6,10, 7,10, 9,12, 7,12,  6,10, 7,10, 9,17, 7,12,
 6,10, 7,16, 9,12, 7,12,  6,10, 7, 4, 9,17, 7,12,
 6,10, 7, 4, 9,12, 7,12,  6,10, 7, 4, 9,17, 7,12 };

static int step(void) {
  if (cpu.halted) return 4;
  uint8_t op = fetch8();
  int t = cyc[op];
  int r = (op >> 3) & 7, r2 = op & 7, rp = (op >> 4) & 3;
  switch (op >> 6) {
  case 1: /* MOV / HLT */
    if (op == 0x76) { cpu.halted = 1; if (verbose) fprintf(stderr, "HLT at %04X\n", cpu.PC - 1); return 5; }
    set_r(r, get_r(r2)); return t;
  case 2: { /* ALU r */
    uint8_t v = get_r(r2);
    switch (r) { case 0: alu_add(v, 0); break; case 1: alu_add(v, cpu.F & FC); break;
      case 2: alu_sub(v, 0, 1); break; case 3: alu_sub(v, cpu.F & FC, 1); break;
      case 4: alu_logic(0, v); break; case 5: alu_logic(1, v); break; case 6: alu_logic(2, v); break;
      default: alu_sub(v, 0, 0); }
    return t; }
  case 0:
    switch (r2) {
    case 0:
      if (op == 0x00) return t;
      if (op == 0x20) { /* RIM */ cpu.A = (cpu.im & 0x0F) | (cpu.inte ? 0x08 : 0); return t; }
      if (op == 0x30) { /* SIM */ if (cpu.A & 0x08) cpu.im = (cpu.im & ~7) | (cpu.A & 7);
        if (cpu.A & 0x40) { if (verbose) fprintf(stderr, "SIM SOD=%d at %04X\n", (cpu.A >> 7) & 1, cpu.PC - 1); } return t; }
      return t; /* undocumented 08/10/18/28/38: treat as NOP */
    case 1: if (op & 8) { /* DAD */ uint32_t s = HL() + get_rp(rp); cpu.F = (cpu.F & ~FC) | (s > 0xFFFF ? FC : 0); set_rp(2, s); }
            else set_rp(rp, fetch16());
            return t;
    case 2:
      switch (op) {
      case 0x02: mem_write(BC(), cpu.A); break; case 0x12: mem_write(DE(), cpu.A); break;
      case 0x0A: cpu.A = mem_read(BC()); break; case 0x1A: cpu.A = mem_read(DE()); break;
      case 0x22: wr16(fetch16(), HL()); break; case 0x2A: set_rp(2, rd16(fetch16())); break;
      case 0x32: mem_write(fetch16(), cpu.A); break; case 0x3A: cpu.A = mem_read(fetch16()); break;
      } return t;
    case 3: set_rp(rp, get_rp(rp) + ((op & 8) ? -1 : 1)); return t;
    case 4: { uint8_t v = get_r(r) + 1; set_r(r, v); cpu.F = (cpu.F & FC) | ((v & 0x0F) == 0 ? FA : 0); set_szp(v); return t; }
    case 5: { uint8_t v = get_r(r) - 1; set_r(r, v); cpu.F = (cpu.F & FC) | ((v & 0x0F) != 0x0F ? FA : 0); set_szp(v); return t; }
    case 6: set_r(r, fetch8()); return t;
    case 7:
      switch (r) {
      case 0: cpu.F = (cpu.F & ~FC) | (cpu.A >> 7); cpu.A = (cpu.A << 1) | (cpu.A >> 7); break;
      case 1: cpu.F = (cpu.F & ~FC) | (cpu.A & 1); cpu.A = (cpu.A >> 1) | (cpu.A << 7); break;
      case 2: { int c = cpu.F & FC; cpu.F = (cpu.F & ~FC) | (cpu.A >> 7); cpu.A = (cpu.A << 1) | c; break; }
      case 3: { int c = cpu.F & FC; cpu.F = (cpu.F & ~FC) | (cpu.A & 1); cpu.A = (cpu.A >> 1) | (c << 7); break; }
      case 4: { /* DAA */ int add = 0, c = cpu.F & FC;
        if ((cpu.A & 0x0F) > 9 || (cpu.F & FA)) add = 6;
        if (cpu.A > 0x99 || c) { add |= 0x60; c = FC; }
        alu_add(add, 0); cpu.F |= c; break; }
      case 5: cpu.A = ~cpu.A; break;
      case 6: cpu.F |= FC; break;
      case 7: cpu.F ^= FC; break;
      } return t;
    }
    return t;
  case 3:
    switch (r2) {
    case 0: if (cond(r)) { cpu.PC = pop(); return 12; } return 6;
    case 1: if (op & 8) { switch (rp) { case 0: cpu.PC = pop(); break; case 1: break; /* D9: undocumented SHLX, ignored */
                          case 2: cpu.PC = HL(); break; default: cpu.SP = HL(); } }
            else { if (rp == 3) { uint16_t v = pop(); cpu.A = v >> 8; cpu.F = v & 0xFF; } else set_rp(rp, pop()); } return t;
    case 2: { uint16_t a = fetch16(); if (cond(r)) { cpu.PC = a; return 10; } return 7; }
    case 3:
      switch (op) {
      case 0xC3: cpu.PC = fetch16(); break;
      case 0xCB: cpu.PC = fetch16(); break;            /* undocumented RSTV; treat as JMP */
      case 0xD3: fetch8(); break;                       /* OUT: no ports on this board */
      case 0xDB: fetch8(); cpu.A = 0xFF; break;         /* IN */
      case 0xE3: { uint16_t v = rd16(cpu.SP); wr16(cpu.SP, HL()); set_rp(2, v); break; }
      case 0xEB: { uint8_t x = cpu.H; cpu.H = cpu.D; cpu.D = x; x = cpu.L; cpu.L = cpu.E; cpu.E = x; break; }
      case 0xF3: cpu.inte = 0; break;
      case 0xFB: cpu.inte = 1; break;
      } return t;
    case 4: { uint16_t a = fetch16(); if (cond(r)) { push(cpu.PC); cpu.PC = a; return 18; } return 9; }
    case 5: if (op & 8) { if (op == 0xCD) { uint16_t a = fetch16(); push(cpu.PC); cpu.PC = a; } else cpu.PC = fetch16(); /* undocumented DD/ED/FD ~ JMP */ }
            else { if (rp == 3) push((cpu.A << 8) | cpu.F); else push(get_rp(rp)); } return t;
    case 6: { uint8_t v = fetch8();
      switch (r) { case 0: alu_add(v, 0); break; case 1: alu_add(v, cpu.F & FC); break;
        case 2: alu_sub(v, 0, 1); break; case 3: alu_sub(v, cpu.F & FC, 1); break;
        case 4: alu_logic(0, v); break; case 5: alu_logic(1, v); break; case 6: alu_logic(2, v); break;
        default: alu_sub(v, 0, 0); } return t; }
    case 7: push(cpu.PC); cpu.PC = r * 8; return t;
    }
  }
  return t;
}

/* ------------------------------------------------------------------ tools */
static int load_rom(const char *dir) {
  const char *names[8] = {"ic47.r1", "ic48.r2", "ic47.bin", "ic48.bin", "ic51.r5", "ic50.bin", "ic53.r7", "ic52.bin"};
  char path[1024];
  for (int i = 0; i < 8; i++) {
    snprintf(path, sizeof(path), "%s/%s", dir, names[i]);
    FILE *f = fopen(path, "rb");
    if (!f) { fprintf(stderr, "cannot open %s\n", path); return 0; }
    if (fread(rom + i * 0x800, 1, 0x800, f) != 0x800) { fprintf(stderr, "short read %s\n", path); fclose(f); return 0; }
    fclose(f);
  }
  return 1;
}

/* dump format: see README.md */
static void write_dump(const char *file, int frame) {
  FILE *f = fopen(file, "wb");
  if (!f) { fprintf(stderr, "cannot write %s\n", file); return; }
  fwrite("PLEIDUMP", 1, 8, f);
  fwrite(ram[0], 1, 0x1000, f);
  fwrite(ram[1], 1, 0x1000, f);
  uint8_t tail[16] = {0};
  tail[0] = videoreg; tail[1] = scroll; tail[2] = sound_a; tail[3] = sound_b;
  tail[4] = frame & 0xFF; tail[5] = (frame >> 8) & 0xFF; tail[6] = (frame >> 16) & 0xFF; tail[7] = (frame >> 24) & 0xFF;
  tail[8] = cpu.PC & 0xFF; tail[9] = cpu.PC >> 8; tail[10] = cpu.SP & 0xFF; tail[11] = cpu.SP >> 8;
  fwrite(tail, 1, 16, f);
  fclose(f);
  fprintf(stderr, "dump frame %d -> %s\n", frame, file);
}

struct script_entry { int frame; uint8_t in0; };

int main(int argc, char **argv) {
  const char *rom_dir = "sources/rom/pleiads", *script_file = NULL, *trace_file = NULL, *phase1_file = NULL;
  int frames = 600, dump_n = 0, dump_at[256]; const char *dump_file[256];
  int watch[64], watch_n = 0, stop_addr = -1, stop_val = 0, stop_extra = 0;
  int default_watch[] = {0x43A4, 0x43B8, 0x43A2, 0x43BA, 0x43B9, 0x43C2, 0x4381, 0x4382, 0x4383, 0x439A, 0x439B, 0x438F, 0x4390};
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--rom") && i + 1 < argc) rom_dir = argv[++i];
    else if (!strcmp(argv[i], "--frames") && i + 1 < argc) frames = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--script") && i + 1 < argc) script_file = argv[++i];
    else if (!strcmp(argv[i], "--trace") && i + 1 < argc) trace_file = argv[++i];
    else if (!strcmp(argv[i], "--dsw") && i + 1 < argc) dsw_base = strtol(argv[++i], NULL, 16);
    else if (!strcmp(argv[i], "--verbose")) verbose = 1;
    else if (!strcmp(argv[i], "--dbg-write") && i + 1 < argc) dbg_write = strtol(argv[++i], NULL, 16);
    else if (!strcmp(argv[i], "--stop-phase1") && i + 1 < argc) phase1_file = argv[++i];
    else if (!strcmp(argv[i], "--stop-extra") && i + 1 < argc) stop_extra = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--dump-at") && i + 1 < argc && dump_n < 256) {
      char *s = argv[++i], *colon = strchr(s, ':');
      if (!colon) { fprintf(stderr, "--dump-at expects FRAME:file\n"); return 1; }
      *colon = 0; dump_at[dump_n] = atoi(s); dump_file[dump_n++] = colon + 1;
    }
    else if (!strcmp(argv[i], "--watch") && i + 1 < argc) {
      char *s = argv[++i];
      for (char *tok = strtok(s, ","); tok && watch_n < 64; tok = strtok(NULL, ",")) watch[watch_n++] = strtol(tok, NULL, 16);
    }
    else if (!strcmp(argv[i], "--stop-when") && i + 1 < argc) {
      char *s = argv[++i], *eq = strchr(s, '=');
      if (!eq) { fprintf(stderr, "--stop-when expects ADDR=VAL (hex)\n"); return 1; }
      *eq = 0; stop_addr = strtol(s, NULL, 16); stop_val = strtol(eq + 1, NULL, 16);
    }
    else { fprintf(stderr, "unknown option %s\n", argv[i]); return 1; }
  }
  if (!watch_n) { watch_n = sizeof(default_watch) / sizeof(int); memcpy(watch, default_watch, sizeof(default_watch)); }
  if (!load_rom(rom_dir)) return 1;
  init_tables();

  struct script_entry script[16384]; int script_n = 0;
  if (script_file) {
    FILE *f = fopen(script_file, "r");
    if (!f) { fprintf(stderr, "cannot open %s\n", script_file); return 1; }
    char line[256];
    while (fgets(line, sizeof(line), f) && script_n < 16384) {
      int fr; unsigned v;
      if (line[0] == '#' || sscanf(line, "%d %x", &fr, &v) != 2) continue;
      script[script_n].frame = fr; script[script_n++].in0 = v;
    }
    fclose(f);
  }

  FILE *trace = trace_file ? fopen(trace_file, "w") : NULL;
  if (trace) {
    fprintf(trace, "frame\tPC\tIN0");
    for (int k = 0; k < watch_n; k++) fprintf(trace, "\t%04X", watch[k]);
    fprintf(trace, "\n");
  }

  memset(&cpu, 0, sizeof(cpu)); cpu.PC = 0; cpu.F = 0x02;
  int phase1_frame = -1, stop_frame = -1;
  for (frame_no = 0; frame_no < frames; frame_no++) {
    for (int k = 0; k < script_n; k++) if (script[k].frame <= frame_no) in0_ext = script[k].in0;
    /* run the visible part, then the blanking part; sample state at VBLANK entry */
    t_in_frame = 0;
    while (t_in_frame < T_VBLANK_START) t_in_frame += step();
    uint16_t pc_at_vblank = cpu.PC;
    uint8_t *r0 = ram[0];
    /* the game's frame handler runs after it sees the 1->0 edge; the values we log are the
       state as left by the previous frame's handler (stable while the code waits in S_0080). */
    if (trace) {
      fprintf(trace, "%d\t%04X\t%02X", frame_no, pc_at_vblank, mem_read(0x7000));
      for (int k = 0; k < watch_n; k++) fprintf(trace, "\t%02X", r0[watch[k] & 0x0FFF]);
      fprintf(trace, "\n");
    }
    for (int k = 0; k < dump_n; k++) if (dump_at[k] == frame_no) write_dump(dump_file[k], frame_no);
    if (phase1_file && phase1_frame < 0 && r0[0x3A4] == 3 && (r0[0x3B8] & 0x0F) == 1) {
      phase1_frame = frame_no; write_dump(phase1_file, frame_no);
      fprintf(stderr, "phase 1 reached at frame %d\n", frame_no);
      if (stop_frame < 0) stop_frame = frame_no + stop_extra;
    }
    if (stop_addr >= 0 && stop_frame < 0 && mem_read(stop_addr) == stop_val) {
      fprintf(stderr, "stop condition %04X=%02X met at frame %d\n", stop_addr, stop_val, frame_no);
      stop_frame = frame_no + stop_extra;
    }
    if (stop_frame >= 0 && frame_no >= stop_frame) { frame_no++; break; }
    while (t_in_frame < T_PER_FRAME) t_in_frame += step();
  }
  if (trace) fclose(trace);
  if (phase1_file && phase1_frame < 0) fprintf(stderr, "warning: phase 1 never reached\n");
  fprintf(stderr, "done: %d frames, PC=%04X page=%d videoreg=%02X scroll=%02X sndA=%02X sndB=%02X\n",
          frame_no, cpu.PC, videoreg & 1, videoreg, scroll, sound_a, sound_b);
  return 0;
}
