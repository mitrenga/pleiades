# tools/refemu — referenční headless emulátor Pleiads (8085A)

Vývojový nástroj podle vzoru `spaceinvaders/tools/refemu`. Jediný soubor `refemu.c` v C bez závislostí
(vlastní jádro 8085: 8080 + RIM/SIM; SIM zapisuje SOD jen do logu při `--verbose`; nedokumentované
instrukce se chovají jako NOP/JMP a nikdy nespadnou). Slouží k výrobě referenčních dat pro remake:
snímky RAM/VRAM a per-frame trace proměnných.

## Sestavení

    tools/refemu/build.sh          # gcc -O2 -Wall -Wextra -o tools/refemu/refemu refemu.c

## Emulovaný hardware (viz sources/asm/pleiades/notes/CONTEXT.md, sources/mame/phoenix*.cpp)

- ROM 0000–3FFF z 8 souborů `sources/rom/pleiads/` v pořadí ic47.r1, ic48.r2, ic47.bin, ic48.bin, ic51.r5,
  ic50.bin, ic53.r7, ic52.bin (SHA1 viz sources/rom/README.md).
- RAM/VRAM 4000–4FFF ve dvou stránkách; aktivní stránku určuje bit 0 posledního zápisu na 5000–53FF
  (čtení i zápis jdou do aktivní stránky). Zápis na 5000h: bit0 stránka, bity1–2 paleta, `hodnota & 0xFC`
  = „otázka" ochrany.
- 5800–5BFF W scroll pozadí, 6000–63FF W zvukový latch A, 6800–6BFF W latch B (jen se ukládají).
- 7000–73FF R IN0: bit0 coin, bit1 start1, bit2 start2, bit4 fire, bit5 vpravo, bit6 vlevo (aktivní v 0,
  klid 0xF7 resp. 0xFF); bit3 = odpověď ochrany dle MAME `pleiads_protection_r`: otázka 00/20 → 0,
  0C/30 → 1, jinak 0 (neznámá otázka se loguje při `--verbose`).
- 7800–7BFF R DSW: výchozí 0x60 (3 životy, bonus 3000, mince 0, bit5=1, demo zvuky zapnuty); bit7 = /VBLANK.
  Lze změnit `--dsw HEX` (bit7 se ignoruje).
- Časování: 8085 s hodinami 5,5 MHz = 2,75 MHz T-stavů; snímek 352×256 pixelových hodin = 45 056 T-stavů
  (61,035 Hz), řádek 176 T. /VBLANK = 0 od řádku 208 (T-stav 36 608) do konce snímku. Žádná přerušení —
  kód čeká na sestupnou hranu bitu 7 v `wait_vblank_read_inputs` (0080h).
- Reset: PC=0. Ochrana funguje → `protection_check` (0552h) skočí na 0050h a smaže obě stránky RAM.

## Použití

    refemu [--rom DIR] --frames N [--script input.txt] [--dump-at FRAME:file]... [--trace out.tsv]
           [--watch ADDR,ADDR,...] [--stop-when ADDR=VAL] [--stop-phase1 file] [--stop-extra N]
           [--dsw HEX] [--dbg-write ADDR] [--verbose]

- `--rom DIR` adresář s ROM (výchozí `sources/rom/pleiades`, tj. spouštět z kořene projektu).
- `--frames N` počet snímků (výchozí 600).
- `--script input.txt` skript vstupů: řádky `FRAME IN0_HEX`; od daného snímku (včetně) drží IN0 bity
  0–2,4–7 na uvedené hodnotě (bit 3 se dopočítává z ochrany). Řádky začínající `#` se ignorují.
  Kapacita 16 384 řádků (do 2026-08-30 jen 1 024 — přebývající řádky se tiše zahazovaly a poslední hodnota
  zůstala držena; projevilo se odchylkou 439Ch od 1 025. řádku skriptu `input-round1.txt`). `--dump-at` až 256×.
- `--dump-at FRAME:file` uloží dump stavu na daném snímku (lze víckrát).
- `--trace out.tsv` per-frame TSV trace (viz níže).
- `--watch 43A4,43B8,...` adresy (hex) sledované v trace; výchozí sada:
  43A4 game_state, 43B8 stage_round (fáze = &0F), 43A2 game_mode (0 = attract/bez kreditu),
  43BA enemies_left, 43B9 scroll_pos (stín scrollu), 43C2 ship_x, 4381/4382/4383 skóre P1 BCD
  (4383 = nejnižší bajt), 439A/439B frame_ctr hi/lo, 438F credits, 4390 lives_p1 (názvy dle RAMUse.md).
- `--stop-when ADDR=VAL` (hex) skončí na snímku, kdy adresa (čtená přes sběrnici, tj. aktivní stránka)
  má hodnotu VAL (+ `--stop-extra N` snímků navíc).
- `--stop-phase1 file` uloží dump na prvním snímku, kdy při vstupu do VBLANK platí `43A4==3 &&
  (43B8&0x0F)==1` (stránka 0), a po `--stop-extra N` dalších snímcích skončí.
- `--dbg-write ADDR` vypíše na stderr každý zápis na adresu (PC, registry) — ladění.

Vzorkování: všechny hodnoty (trace, dumpy, stop podmínky) se berou v okamžiku, kdy T-stav snímku
dosáhne 36 608 (začátek VBLANK). Kód hry v tu chvíli typicky čeká v S_0080 (PC 0088–008B), takže
zapsané hodnoty jsou stav po dokončení zpracování předchozího snímku. Sloupec `PC` v trace je PC
v tomto okamžiku; `IN0` je hodnota čtená z 7000h (včetně bitu 3).

## Formát trace (TSV)

Hlavička `frame  PC  IN0  <ADDR>...`, pak řádek na snímek: číslo snímku (od 0), PC (4 hex), IN0 (2 hex),
hodnoty sledovaných adres ze stránky 0 (2 hex).

## Formát dumpu (`*.bin`, 8216 B)

| Offset | Délka | Obsah |
|---|---|---|
| 0 | 8 | magic `PLEIDUMP` |
| 8 | 4096 | stránka 0, 4000–4FFF |
| 4104 | 4096 | stránka 1, 4000–4FFF |
| 8200 | 1 | poslední zápis na 5000h (bit0 aktivní stránka, bity1–2 paleta) |
| 8201 | 1 | scroll (poslední zápis 5800h) |
| 8202 | 1 | zvukový latch A (6000h) |
| 8203 | 1 | zvukový latch B (6800h) |
| 8204 | 4 | číslo snímku, little-endian |
| 8208 | 2 | PC, LE |
| 8210 | 2 | SP, LE |
| 8212 | 4 | rezerva (0) |

VRAM popředí = 4000–433F (26 sloupců × 32 řádků; adresa = 4000h + sloupec*32 + řádek, sloupec 0 je
vpravo z pohledu hráče), proměnné 4340–47FF, VRAM pozadí 4800–4B3F, zásobník 4B40–4BFF.

## Referenční data (`sources/reference/`)

Vytvořeno příkazy (z kořene projektu):

    tools/refemu/refemu --frames 600 --trace sources/reference/trace-attract.tsv \
        --dump-at 300:sources/reference/attract-title.bin
    tools/refemu/refemu --frames 3000 --script sources/reference/input-start.txt \
        --trace sources/reference/trace-start.tsv \
        --stop-phase1 sources/reference/phase1-start.bin --stop-extra 600

- `input-start.txt`: skript vstupů — mince stisknuta ve snímcích 10–14 (IN0=F6), start 1P ve snímcích
  40–44 (IN0=F5), jinak F7. Nalezeno experimentálně: kód detekuje sestupnou hranu bitu (`input_edge`
  00BBh) mezi 43A0h/43A1h, stačí tedy krátký stisk; kredit se připíše na snímku 11, start je přijat na
  snímku 43 (43A2=1, 4390=3 životy), stav 1 (úvod „PLAYER 1") snímky 48–175, stav 2 snímek 176,
  stav 3 od 177 s fází 0 (43B8=00, nájezd na planetu), fáze 1 (43B8=01) poprvé při vstupu do VBLANK
  **na snímku 210**.
- `phase1-start.bin`: dump snímku 210 (první snímek s 43A4==3 && (43B8&0F)==1 při vstupu do VBLANK).
- `trace-start.tsv`: snímky 0–810 (do fáze 1 + 600 snímků). Bez dalších vstupů loď zahyne na snímku 581
  (stav 4), životy 3→2, další kolo od 678.
- `trace-attract.tsv`: 600 snímků bez vstupů. Hra prošla resetem a ochranou (od snímku 4 čeká v S_0080,
  43A2=0), attract se mění (titul s texty, tabulka skóre kolem snímku 300, demo od ~456).
- `attract-title.bin`: dump snímku 300 bez vstupů (titulní obrazovka s tabulkou „SCORE ADVANCE TABLE").

Ověření časování: 439B (frame_ctr_lo) roste přesně o 1 za snímek (v attractu; v herním stavu 1 ho kód
04BDh sám nuluje každý snímek, ve stavu 3 opět roste o 1). Kontrolní součet ROM (L_1688) = 0.

### Scénáře PL-M5 (`tools/regress.mjs`, 2026-08-30)

- `input-round1.txt`: skript autopilota (mince+start, celé první kolo včetně mateřské lodi, vlny 2, přistání a
  bonusu, druhé kolo do fáze 3; 13 000 snímků). `input-gameover.txt`: totéž do začátku fáze 3 (snímek 2473),
  pak bez vstupu → 3 smrti ve fázi 3, game over (snímek 4931), attract. Oba proti workeru s 0 odchylkami.
