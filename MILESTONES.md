# Pleiads — milníky

Stav k 2026-08-30. Milníky navazují na kap. 10 „Postup" v `GAME-DESIGN.md`; každý má výstup a
kritérium **hotovo když**. Termíny se doplní po odhadu. Stav: ☐ nezačato · ◐ rozpracováno · ☑ hotovo.

## Závislosti mezi projekty

Tři projekty běží paralelně, ale sdílené části svision vznikají jednou:

| Sdílená část svision | Vytváří | Přebírá |
|---|---|---|
| `ArcadePlatform` + `ArcadeLayout` (**svision `canvas2D/arcade/`**, přesun z `app/` 2026-08-30) | SI (SI-M3 ☑) | Pleiads, Stinger (jen `appPlatform.js`) |
| Pevný tick ve workeru, deterministický RNG, headless regresní test | SI (SI-M5, SI-M9) | Pleiads, BZ |
| Syntetizátor efektů (šum+filtr+obálka, sweep, LFO) | SI (SI-M7) | BZ (BZ-M7); Pleiads (PL-M6) jej používá jen pro melodii — efekty = emulace desky ve vlastním AudioWorkletu (`app/pleiadsSoundProcessor.js`) |
| `TileMapEntity`, 2 bpp kodek, `rom2tiles` (**v `app/`/`tools/` Pleiads, ne ve svision** — 2026-08-30) | Pleiads (PL-M3) | — |
| `VectorPlatform`, `VectorEntity`, `VectorTextEntity`, `rom2vectors` | BZ (BZ-M3) | — |
| POKEY-like a „engine" instrument | BZ (BZ-M7) | — |
| Skelet arkádového projektu (menu bez audia, attract mode per hra, HoF jako MM) | SI (SI-M2, SI-M8) | Pleiads, BZ (vzor) |

Co na nikoho nečeká a může začít hned ve všech třech: **M1 podklady** a u BZ/Pleiads i **M2 skelet**.

## Milníky

### PL-M1 Podklady a disassemblace — ☑ 2026-08-30
- Výstup: `sources/` (MAME, Phoenix disassemblace, manuály, datasheety 7910, výstřel z PCB, **ROM set dodán
  a ověřen SHA1**), vlastní disassemblace v `sources/asm/pleiades/` (`dis8085.py`, generovaný `pleiads.asm`
  s 314 návěštími/270 komentáři, `RAMUse.md`, `notes/A–D` — hlavní smyčka, 8 stavů, 8 fází kola, hráč, nepřátelé
  a formáty tabulek pohybu/morphingu, mateřská loď, přistání, bonusy, skóre, RNG, video, texty, zvukové latche,
  ochrana), kap. 2 GAME-DESIGN bez [ověřit]/[ROM].
- Hotovo když: disassemblace pokrývá herní smyčku a všechny 4 fáze, kap. 2 bez [ověřit] — **splněno**.
- Otevřené drobnosti (nebrání M2–M4) jsou vyjmenovány na konci každého `notes/*.md`; ověří se v MAME
  debuggeru při PL-M4/M5 (regresní porovnání pozic).

### PL-M2 Skelet projektu — ☑ 2026-08-30
- Výstup: kopie kostry **SI** (SI-M2/M3, původně z MM), `menuModel` bez otevírání audia (`needEventForAudio()`
  jen před startem), `.gitignore` (+ `sources/rom/pleiads/`, `*.zip`); **vlastní platforma v `app/`**
  (`arcadeRasterPlatform.js`, `arcadeRasterLayout.js` = kopie ze SI, `appPlatform.js` 208×256, bez overlay —
  rozhodnuto 2026-08-30: nic do svision). Placeholdery: `mainModel.js` (hra až PL-M4), `gameWorker.js` stub,
  ikony/poster z MM/SI (PL-M7), zvuky (PL-M6). Lokální DB `pleiades` (`rg_pl_hallOfFame`) vytvořena.
- Hotovo když: `svtool build/verify` projdou (☑ bundle + es-check), menu se zobrazí
  (☑ HTTP 200 na `https://willy2.shipard.pro:34444/pleiades/`; vizuálně zkontrolovat v prohlížeči).
- Poznámka: projekt zatím není git repozitář; `testFlightPage.php` až v PL-M7.

### PL-M3 `TileMapEntity` + data z ROM — ☑ 2026-08-30
- Výstup (vše **v projektu**, svision se nemění): `app/tileMapRender.js` (čistý render bez DOM, `renderVramToRgba`)
  + `app/tileMapEntity.js` (2 vrstvy 26×32, 2 bpp, 4 banky palet, scroll pozadí, cache dlaždic per (vrstva, kód,
  banka)); `tools/rom2tiles.mjs` + `.spec.json` → `data/tiles.json` (dlaždice otočené do orientace hráče, 256 barev
  z PROM přes 1:1 port MAME `resnet` + `normalize_range`, audit mezihodnot v `meta`); `tools/refemu/` (headless
  emulátor 8085 + HW Pleiads, dumpy VRAM a trasy RAM → `sources/reference/`: `phase1-start.bin` snímek 210,
  `attract-title.bin` snímek 300, `trace-*.tsv`, skript vstupů); `tools/vram2json.mjs` → `data/screens.json`;
  `tools/render-screen.mjs` (PNG); `mainModel.js` zobrazuje start fáze 1 (attract: titul).
- Ověřeno: fg pixel 0 průhledný, bg neprůhledné (MAME `set_transparent_pen(0)`); orientace a bitový formát
  potvrzeny čitelným textem; scroll: klesající 43B9h = pozadí dolů (`SCROLL_SIGN`), zatím bez dumpu se scroll≠0.
  Render titulu i startu kola vizuálně odpovídá známým screenshotům; `svtool verify` OK.
- Hotovo když: screenshot startu fáze 1 shodný s referencí — **splněno proti refemu** (stejná ROM, stejný výpočet
  palety jako MAME). **Zbývá:** pixelové porovnání s reálným MAME screenshotem, až bude MAME k dispozici
  (případná korekce jen `SCROLL_SIGN`/`normalizeRange`) — přesunuto do PL-M8.

### PL-M4 Fáze 1 hratelná — ☑ 2026-08-30
- Přístup: worker (`app/gameWorker.js`, ~2 200 ř.) drží stav hry jako originál ve virtuální stránce RAM/VRAM
  (4000h–4FFFh, proměnné na původních offsetech) a logiku přepisuje 1:1 z disassemblace (komentáře s adresami ROM);
  hlavní smyčka jako generátor, `yield` = čekání na VBLANK (0080h) → číslování snímků shodné s refemu. Model
  (`app/mainModel.js`) jen kreslí poslední přijatou VRAM přes `TileMapEntity`; protokol `app/WORKER-PROTOCOL.md`.
  Tabulky z ROM: `tools/rom2tables.mjs` → `data/tables.json` (46 tabulek + výplně, worker má celý 16 KiB obraz).
- Portováno: reset, vstupy/kredity, start, stavy 0–5, fáze 0 (RLE pozadí) a **celá fáze 1** (loď, střela, spawn
  automat vln, skripty pohybu, morphing, střelba nepřátel, zásahy země, kolize, exploze a body, BCD skóre, bonus
  život, smrt, game over), konec vlny → scroll fáze 2 → `roundComplete` (fáze 3+ = PL-M5). Zvuk: názvy událostí
  + surové latche ve `frame.sounds`/`latches` (syntéza PL-M6). Ovládání klávesnice/gamepad/myš/dotyk jako MM,
  pauza, game over → hall of fame; `?devMock=1` přepne na `app/mockWorker.js` pro ladění UI.
- Hotovo když: fáze 1 dohratelná — ☑ autopilot (`sources/reference/input-autopilot.txt`) vlnu 1 dohrál
  (snímek 2472, skóre 940); pozice nepřátel po N ticích shodné — ☑ `tools/regress.mjs` proti `tools/refemu`:
  98 sledovaných bajtů každý snímek + celá stránka 0 v dumpech, **0 odchylek** bez vstupu (2 100 snímků, přes
  smrt, game over až do attractu), náhodné vstupy seedy 1–7 (3 000 snímků), autopilot; ověřeno nezávisle i mnou.
- 2026-08-30 Safari (macOS/iOS) kreslilo místo sprajtů písmena/číslice — `TileMapEntity.compose()` přepsáno na jediné
  `putImageData` přes sdílený `TileMapRender.blitTile` (žádné `drawImage` z dočasných canvasů; WebKit tam dává stará
  data). Verze 2026.08.30.2. Uživatel potvrdil opravu v Safari 2026-08-30 (WebKit lokálně nelze spustit).
- Zbývá ověřit ručně v prohlížeči (canvas): START GAME → hra, ovládání, pauza, game over → HoF; dotyk na mobilu.
  Neportováno (PL-M5): attract demo za čítačem 0x120, 2 hráči, stavy 6/7, fáze 3–7.

### PL-M5 Kompletní hra — ☑ 2026-08-30
- Výstup: `app/gameWorker.js` (~3 300 ř.) — port fází 2–7 a stavů 6/7: mateřská loď (sloty 8 B, skripty 3F00h, kreslení
  pruhů, zásahy s maskami, HP, pohyb scrollem, bomby, paprsek), obrázky fází 4/6, vlna 2 s 5 cíli a bonusem (stav 6),
  přistání (setrvačnost, sestup, značky, světla dráhy, kolize terénu, vyhodnocení 500–4000), stav 7 a nové kolo,
  cyklus obtížnosti z tabulek, smrt ve fázi ≥4 (rollback), game over. `tools/rom2tables.mjs` 75 tabulek.
  Protokol: `roundComplete` jen informativní, hra končí pouze `gameOver`; `frame` má `round`, `phase`, rozšířené stavy.
  Nástroj `tools/render-frame.mjs` (PNG libovolného snímku z workeru podle skriptu vstupů).
- Hotovo když: celý průběh od menu po zápis skóre bez zvuku — ☑ regrese `tools/regress.mjs` proti `tools/refemu`:
  `input-round1.txt` celé 1. kolo (vlna 1 → loď → vlna 2 → stav 6 → planeta → přistání → stav 7 → 2. kolo do fáze 3):
  **13 000 snímků, 151 sledovaných bajtů, 0 odchylek, 29 dumpů shodných**; `input-gameover.txt` (3 smrti ve fázi 3 →
  game over → attract): 5 350 snímků, 0 odchylek. Ověřeno nezávisle i mnou; snímky fází 3/5/7 a stavu 7 vizuálně OK.
- Opravy při portu: chyba workeru v indexu 37C0h; refemu: limity skriptu (1 024 → 16 384 řádků) a dumpů (32 → 256);
  dvě nepřesnosti v `notes/C` (doplněno v sekci „Opravy zjištěné při portu").
- Neportováno záměrně: attract demo za čítačem 0x120 (PL-M7), 2 hráči, ochrana/kontrolní součty. Kola ≥3 jen tabulkově.
- Zbývá ručně v prohlížeči: průchod celou hrou, game over → zápis do HoF (`GameOverModel`), vzhled fází 3–7.

### PL-M6 Zvuk — ☑ 2026-08-30 (A/B poslechem zbývá)
- Přístup (jiný než SI): Pleiads nemá jednorázové efekty — program každý snímek zapisuje latche A/B (6000h/6800h)
  a analogová deska z nich hraje spojitě. Proto **emulace zvukové desky** v AudioWorkletu `app/pleiadsSoundProcessor.js`
  (standalone soubor jako `gameWorker.js`): port MAME `pleiads.cpp` (tón 1 = 8 kHz/(16−n), tóny 2/3 z 556 s kondenzátorem
  PB4, tón 4 s PC4/PC5/PA5, 18bitový polynomiální šum s obálkou PA6 a přímým bitem 7) + TMS3615 (`tms36xx.cpp`, 13 not,
  4 hlasy 16'/8'/4'/2', lineární dozvuk 0,33 s, nota se spouští jen při změně latch B, oktáva z bitů 6–7). Worker se nemění:
  model předává `frame.latches` (`a`, `b`, `sod`) přes `AudioManager.playFrame` → `PleiadsSoundHandler` (sběrnice `sounds`,
  vzor svision `AudioWorkletHandler`: fetch + blob URL, 1 registrace na kontext, hlasitost gain uzlem).
- **Výstřel (SOD, MAME neemuluje):** syntéza podle nahrávky z PCB `sources/sound/pleiads-shoot.wav` (analýza po 10 ms:
  šumový tón ~1,45 kHz → 1,1 kHz, exponenciální dozvuk, RMS 0,21 → 0,01 za 0,9 s) — obdélník 1450→1100 Hz (τ 0,35 s)
  hradlovaný rychlým LFSR, obálka τ 0,28 s, 0,95 s.
- **Rozhodnutí o melodii 7910E: syntéza** (ne nahrávka). Podle datasheetu Epson (`sources/docs/SVM7910`, str. 3,
  přečteno přes pdftoppm) hraje standardní **7910E: melodie 1 „Two Minuets" (J. S. Bach), melodie 2 „Dark Eyebrows"
  (ruská lidová = „Oči čornyje")** — obě volná díla (fóra uvádějící Für Elise/Romance popisují Phoenix s MN6221AA).
  ROM nedumpovaná, nahrávky jen videa → vlastní přepisy jako skóre svision `AudioOscillatorHandler` na sběrnici `music`
  (`app/soundEffects.js`: Menuet G dur BWV Anh. 114 prvních 16 taktů, „Oči čornyje" 16 taktů — přibližný přepis).
  **Zapojení ze schémat Centuri** (`Pleiades_Centuri_manual_schematics.pdf` str. 18 „CPU BOARD; TEHKAN-01", IC 44):
  SEL1/SEL2 nezapojené, MSL (pin 9, L = melodie 1, H = melodie 2) a MT (pin 4, hraje dokud H) jsou přes invertory LS14
  napojeny na **bity 6 a 7 latch B** (LS374 (34)); oscilátor R82/R83 100k + C46 51p (standard 131k → tempo ≈ 1,3×),
  obálky CTL1/CTL2 6,8µ/100k, výstup MO pin 12 do mixu přes R84/C44. **Který bit je MT a který MSL ze skenu nejde
  odečíst** → zvoleno podle chování hry: bit 6 → MT, bit 7 → MSL (`AudioManager.MELODIES`: 00 fáze 0/1 → melodie 2,
  10 ostatní fáze → melodie 1, 01 fáze 6 → ticho; tj. hudba téměř po celou hru, jak popisují majitelé). Alternativa
  (bit 7 → MT) = hudba jen ve fázích 0/1 a 6 — rozhodnout A/B proti videím. MAME bere tyto bity jako oktávu TMS3615
  (ponecháno pro efekty).
- **Zjištění ze schémat pro PL-M8:** na Centuri/Tehkan CPU desce **není TMS3615** — dolní nibble latch B jde do děliče
  LS163 (41) (druhý programovatelný tón, obdoba tónu 1 z latch A → LS163 (28)); MAME `pleiads.cpp` je tedy u „TMS" not
  aproximace. Bity 6/7 latch A → diody/RC → 4066 (obálky šumu) odpovídají MAME.
- Ukázky v menu: SOUNDS = latch skript (výstřel, `sound_hit_a`, `sound_ping` stejnými vzorci jako program),
  MUSIC = Romance jednou. Audio se otevírá až ve hře / dialogu (beze změny).
- Ověřeno headless: `tools/render-sound.mjs` (worker → latche → procesor → WAV): `input-round1.txt` snímky 150–3149:
  43 hodnot latch A, 27 hodnot B, 60 výstřelů, 265 spuštění not, 49,6 s, špička 0,88, 0 NaN, 0 ořezů, ticho = RMS 0
  (DC z MAME odstraněno, tanh limiter); `--demo` 2,85 s OK. `svtool build bundle` + `import-from` + `verify` OK
  (bundle 60 zdrojů, 3 standalone), `smoke-model` OK. HTTP kontrola `willy2.shipard.pro:34444` v době dokončení
  neprošla (server neodpovídal, timeout) — nasazení souboru `js/pleiadsSoundProcessor.js` ověřit spolu s A/B.
- Hotovo když: efekty A/B přijatelné proti PCB nahrávce/MAME; melodie hraje — **technicky splněno**; **subjektivní A/B
  poslechem (efekty vs. MAME/videa, melodie vs. videa z reálné desky, mapování bitů 6–7 → melodie) musí udělat uživatel**
  v prohlížeči (`https://willy2.shipard.pro:34444/pleiades/`). Ladění: konstanty v hlavičce `pleiadsSoundProcessor.js`,
  `MELODIES` v `audioManager.js`, přepisy v `soundEffects.js`.
- Neřešeno: latch C (5000h bity 4–5) hra nikdy nezapisuje — port jen kvůli úplnosti; IC87 „zap" šumu (v MAME
  neimplementováno) rovněž ne.

### PL-M7 Attract mode, nastavení, PWA, testflight — ☐
- ☑ 2026-09-12 **Menu bez rámečku, font hry** (jako SI) — zelený rámeček kolem menu odstraněn; `app/pleiadesFonts8x8.js`
  (`PleiadesFonts8x8` nad `ZXFonts8x8`, statická HEX tabulka z `tools/tiles2font.mjs`): 0–9, A–Z, `-*©` ze znakových
  dlaždic grafické ROM (`data/tiles.json`, fg 01h–1Ah, 20h–29h, 2Bh, 1Fh, 2Ch), zbytek z fontu ZX ROM (výchozí tabulka
  `ZXFonts8x8`; žádný font z `~/sw/zx-fonts` se s písmem Pleiads neshoduje, nejbližší se liší ve 103 z 288 řádků).
  Vzniká v `GameApp` jako `fonts.pleiadesFonts8x8` (+ `Prop`), menu a verze jím píší, copyright zůstává fontem 5×5.
  Nadpis PLEIADES v menu zrušen (titul ukazuje boot). Podklad menu zatím žádný: smyčka titulu attractu hraná
  workerem (`AttractTitle` s volbami `loop`, `clearTexts`, `clearForeground`) byla vyzkoušena a zrušena, podklad se
  udělá jinak. Veřejný název `$appPublicName` v `config/config.php` (index.php).
- ☑ 2026-09-12 **BootModel** — `app/bootModel.js` nahrazuje `ZXResetModel`: titul attractu originálu jako zaváděcí
  animace, ale **hraje ho sám worker** (žádná vlastní skladba obrazu; přehrávač `app/attractTitle.js`, sdílený
  s menu): bez mince, tiše přetočen na čítač attractu 01B1h (`fastForwardAttract`, hned po smazání tabulky skóre),
  zastaven na 04B0h (`pauseAtAttract`) = po tanci dvou obrázků pod nápisem, před demo hrou; snímky kreslí
  `TileMapEntity` jako ve hře. Dvě vlastní odchylky na straně zobrazení: světla přistávací dráhy dole běží jako ve
  fázi přistání (`landing_anim_tiles`, tabulka 37C0h; `AttractTitle.animateLandingLights` posouvá dlaždice 78h–7Bh
  v přijaté stránce) a od 03BFh se ignoruje změna banky palety (`attract_reinit` přebarví celý obraz;
  `PALETTE_FREEZE_COUNTER`). Worker zůstává věrný. Klávesa boot ukončí hned.
  Kvůli tomu portován attract 01B0h–03FFh: `attract_demo_start` 1B0Ch (01C0h–01E0h, planeta fáze 0), `attract_enemy_showcase`
  1AD0h (0200h–03C0h: 7× 64 snímků, netvor morfující 16 obrázky `draw_big_sprite` a písmeno PLEIADS z hvězdicových dlaždic
  65h/6Ah/6Dh do pozadí, tabulka 1AB0h), `attract_reinit` 1C00h (03BFh/03C0h: smazání bloku dráhy, copyright, skrytý
  součet řádku copyrightu → 4381h, pro originál +0), `attract_ship_anim` 03C0h (0400h–04AFh, dva 2×2 obrázky 1400h
  na 4252h/4132h) a `copy_ram_page` 0460h (stav 0 → hráč 2 na stránce 1; snímek nese zobrazovanou stránku). Pozor:
  `cmp16_range` má obě meze včetně a přehlídka začíná na 0200h (v listingu `LXI B,inc16` = hodnota), ne 01E0h.
  Ověřeno `tools/regress.mjs --script sources/reference/input-attract.txt --frames 1300` (nový scénář, porovnává
  i stránku 1 dumpů): 0 odchylek, všechny dumpy shodné. Za 04E6h (demo hra) worker stále končí — zbytek PL-M7.
  Titul ≈ 12 s + 1 s hotového titulu, pak rovnou menu (žádná obrazovka s copyrightem).
- Výstup: attract (title, demo, HoF, INSERT COIN náhrada), SETTINGS (ovládání, sharp/retro),
  About, PWA, `testFlightPage.php`, `~/sw/testflights/pleiades`.
- Hotovo když: testflight nasazen, hratelné na mobilu i desktopu.

### PL-M8 Věrnost a dokončení — ☐
- Výstup: headless regresní testy proti `tools/refemu` (trasy RAM) a kontrola proti MAME (screenshot startu
  fáze 1, palety), About/Credits, veřejný název.
- Hotovo když: regresní testy procházejí, kap. 11 bez bodů blokujících vydání.
