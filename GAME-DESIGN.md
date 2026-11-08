# Pleiads — zadání remaku

Stav k 2026-08-30. Pracovní zadání; body **[?]** jsou otevřené, body **[ověřit]**
je nutné potvrdit z vlastní disassemblace / MAME před implementací.
Společná pravidla pro všechny tři arkádové remaky (dříve `~/sw/spaceinvaders/ARCADE-PLATFORMS.md`,
zrušen) jsou do tohoto dokumentu **zapracována** a přizpůsobena Pleiads; sesterské projekty:
`~/sw/spaceinvaders/GAME-DESIGN.md`, `~/sw/battlezone/GAME-DESIGN.md`. Tři hry vznikají **současně**. Milníky a závislosti: `MILESTONES.md`.

## 0. Společný rámec a role Pleiads

> **Změna 2026-08-30:** `ArcadeRasterPlatform`/`ArcadeRasterLayout` byly přesunuty z `app/` do svision jako
> **`svision/js/platform/canvas2D/arcade/arcadePlatform.js` + `arcadeLayout.js`** (třídy `ArcadePlatform`,
> `ArcadeLayout`), sdílené SI, Pleiades i Stingerem; projekt drží jen konfiguraci v `app/appPlatform.js`.
> Platforma **neplní** `app.stack.ButtonEntity` (hover/klik barvy) — společný mechanismus pro ZX i arcade
> (`config.buttonColors`) se navrhne později. Zmínky „v `app/`, ne ve svision" níže jsou historické.

- **Věrný remake, ne emulátor.** Logika se přepisuje do JavaScriptu; zachovává se původní
  celočíselná aritmetika, tabulky, pořadí výpočtů a časování po snímcích. Referencí je
  ROM set `pleiads` v MAME s továrním nastavením DIP.
- **Pleiads je druhá v pořadí** (Space Invaders → Pleiads → Battlezone), řeší se paralelně.
  Od SI **přebírá** (kopií souborů do `app/`, ne přes svision) `ArcadeRasterPlatform`/`Layout`,
  pevný tick ve workeru, syntetizátor zvukových efektů a pomocné obrazovky; **přidává** do svision `TileMapEntity`, kodek
  2 bpp dlaždic ve `SpriteTool` a nástroj `rom2tiles`. Dokud SI platformu nedodá, běží
  na Pleiads **disassemblace** a převod dat — to na SI nečeká.
- Vzor kódu: MM/JSW (`gameApp.js`, `menuModel.js`, `mainModel.js`, `gameWorker.js`,
  `hallOfFameEntity.js`, `aboutEntity.js`, `audioManager.js`). Herní fyzika ve
  **workeru** s pevným tickem, UI vrstva v modelu/entitách.
- Kostra jako MM/JSW: `index.php` + `app/` + `config/` + `db/`, symlink `app/svision`,
  `svtool build/verify`, PWA, hall of fame.
- Rozdíly proti MM/JSW: `ArcadeRasterPlatform` místo `ZXPlatform`; obraz
  **na výšku**; barvy z PROM palet místo ZX atributů; arkádový font 8×8 z ROM;
  **attract mode** místo tape-loading menu; vstup mapovaný na páku + tlačítka;
  **žádné save game**, jen hall of fame.

## 1. Referenční verze

- **Tehkan Pleiads (1981)**, ROM set `pleiads` v MAME (originál Tehkan). **Ne** Centuri
  (USA), Irecsa ani bootlegy — ty slouží jen k porovnání.
- **Název:** „**Pleiads**" je pravopis na titulní obrazovce Tehkan verze (proto MAME set `pleiads`);
  „**Pleiades**" je správný anglický název souhvězdí a používá jej Centuri (USA) na kabinetu
  i v manuálu (MAME u `pleiadce`: *"Pleiades" in manual and on cabinet*). V projektu: ROM set,
  data a interní identifikátory = `pleiads`; adresář projektu a veřejný název remaku = **Pleiades**.
- Původní zdrojáky nejsou veřejné a **neexistuje hotová komentovaná disassemblace**
  → první fází projektu je **vlastní disassemblace ~16 KiB programové ROM** (8085A;
  lze vyjít z disassemblace příbuzného Phoenixu, hardware je odvozený).
- Zdroj hardwaru: MAME driver `phoenix.cpp` (`pleiads` varianta), `phoenix_v.cpp`
  (video), `pleiads.cpp` (zvuk), servisní manuál a schémata.

## 2. Fakta z originálu

Ověřeno 2026-08-30 z MAME (`sources/mame/phoenix.cpp`, `phoenix.h`, `phoenix_v.cpp`, commit 601bc4cd)
a z vlastní disassemblace (`sources/asm/pleiades/`, detaily a důkazy v `notes/A–D.md`, mapa RAM v `RAMUse.md`).

- **Časování:** krystal 11 MHz; pixel clock i CPU 8085A = 11/2 = **5,5 MHz** (MAME komentář „2.75 MHz"
  je fakticky frekvence po interním děliči 8085 — interní takt CPU 2,75 MHz). Raster: HTOTAL 352,
  HBLANK 256–351; VTOTAL 256, VBLANK 208–255 → **refresh 5 500 000 / (352 × 256) = 61,035 Hz**.
  DSW0 bit 7 = /VBLANK (0 = v zatemnění) — program se na snímek synchronizuje jeho pollingem.
- **Obraz:** dlaždice 8×8, 2 bpp (2 bitové roviny po 8 B, `charlayout`). Hardwarová plocha 256 (š) × 208 (v)
  = 32 × 26 dlaždic; tilemapy 32×32 (`TILEMAP_SCAN_ROWS`), viditelných 26 řádků. Hra je `ROT90` →
  **hráč vidí 208 (š) × 256 (v) = 26 sloupců × 32 řádků dlaždic** (orientace potvrzena). Byte VRAM
  `+1` = o řádek níž, `+32` = o sloupec vlevo (převzato z RAMUse Phoenixu, stejný hardware).
- **VRAM:** 4000h–4FFFh, dvě stránky (bit 0 registru 5000h) — stránka 1 zároveň otáčí obraz pro
  2. hráče v cocktail módu. V každé stránce: popředí 4000h–433Fh (index dlaždice + 0x000),
  pozadí 4800h–4B3Fh (index + 0x800), mezi tím RAM proměnných 4340h–47FFh a zásobník 4B40h–4BFFh
  (potvrzeno z disassemblace; SP = 4BFFh, mapa v `sources/asm/pleiades/RAMUse.md`).
- **Barvy:** dvě PROM 256×4 (7611-5.26 nižší, 7611-5.33 vyšší bity) → 256 položek; index barvy =
  `(kód dlaždice >> 5) | (popředí ? 8 : 0) | (paleta << 4)` × 4 pixely 2 bpp → 64 „color codes" × 4.
  Barva dlaždice tedy plyne z horních 3 bitů jejího kódu. **Paleta 0–3** = bity 1–2 registru 5000h
  (Phoenix má jen 1 bit); stejná pro obě vrstvy; tabulka palet v ROM 0420h–042Fh, nastavuje rutina
  06BCh, 4 změny palety za úroveň (MAME komentář). Odporová síť `pleiads_net_info` pro převod na RGB.
- **Scroll:** zápis 5800h = `set_scrollx` pozadí — v hardwarové orientaci vodorovný, **pro hráče
  vertikální**, 8 bitů, jen vrstva pozadí.
- **Registry:** 5000h W video (bit 0 stránka, bity 1–2 paleta, bity 2–7 „otázka" ochrany + `control_c_w`
  zvuku); 6000h/6800h W zvuk A/B; 7000h R vstupy (bit 0 mince, 1 start 1P, 2 start 2P, 3 odpověď
  ochrany, 4–7 páka/tlačítko multiplexované podle stránky: 1P při stránce 0, 2P při 1);
  7800h R DIP + /VBLANK.
- **Ochrana T‑X/T‑Y/T‑Z:** ekvivalent 74LS669+74LS83+74LS74; program na 0552h čte bit 3 portu 7000h,
  odpověď závisí na posledním zápisu do 5000h (00h/20h → 0, 0Ch/30h → 1). Remake ji ignoruje.
- **DIP (výchozí MAME):** životy **3** (3/4/5/6), bonus život **3 000 a 30 000** (3K/4K/5K/6K + ×10),
  1 mince = 1 hra, demo zvuky zapnuty, upright. Centuri verze má bonusy 7K/8K/9K — potvrzuje,
  že remake se drží Tehkan.
- **Ovládání:** 2‑směrná páka (vlevo/vpravo) + **jedno tlačítko Fire**; tlačítko 2 (u Phoenixu
  shield) **v Tehkan Pleiads není** (MAME `IPT_UNUSED`; kód čte jen bity fire/vlevo/vpravo). Žádný štít ani
  teleport v kódu není. Loď: X 08h–C0h, 1 px/snímek (ve fázích přistání setrvačnost přes 439Ch), **jedna
  střela** (Y −8 px/snímek; ve vlně 2 dvě střely); nepřátelské střely +4 px/snímek.
- **Průběh kola** (proměnná 43B8h = kolo<<4 | fáze, dispatcher 0800h/0814h; `notes/A`, `B`, `C`):
  fáze 0 intro/scroll → **1 vlna 1** (16 nepřátel, 8 současně, skripty pohybu z 2800h/2900h, morphing dle
  směru z 1600h/16C0h/1700h) → 2 přechod (scroll dolů) → **3 mateřská loď** (v pozadí, pohyb změnou
  scrollu; 8 objektových slotů, pancíř s HP 43BBh=8, bomby 3/4/5 dle kola, „paprsek") → 4 obrázek/prodleva
  → **5 vlna 2** (jiní nepřátelé, 5 cílů → bitmaska 43BCh → bonus 100×(kolo+1)×zásahy, stav 6) → 6 planeta
  → **7 přistání** (automatický sestup 0–2 řádky/snímek, řízení se setrvačností, dosednutí na dlaždici 6Fh,
  náraz 70h–7Bh = smrt; bonus `326Eh[idx]`×100 = 500…3500, přesný střed 4000) → nové kolo (fáze 0).
  Smrt ve fázi ≥4 vrací fázi o 1. Herní stavy 43A4h: 0 start/přepnutí hráče, 1 „get ready", 2 init,
  3 hra, 4 smrt, 5 game over, 6 bonusová obrazovka, 7 obrázek po přistání.
- **Časování:** nepřátelé se pohybují v lichých snímcích (30 Hz) po 8px buňkách; střelba testována v sudých.
- **Bodování:** formační nepřítel 80, útočící 30, diagonální 150, náraz do lodi 50, poslední nepřítel vlny
  180/130/250 +100×kolo; přistání viz výše. Skóre 3 B BCD (4381h–4383h), HI 4389h–438Bh; bonus život při
  N×1000 a poté N×10000 (N = 3–6 dle DIP), životy (DIP&3)+3.
- **RNG:** žádný LFSR — `S_3758`: `(((439Bh<<3)&7) + X_lodi) & 0Fh` (čítač snímků + poloha hráče);
  jinde přímo bity čítače 439Bh. Deterministické → demo/attract lze reprodukovat 1:1.
- **Grafika:** hardware nemá sprajty; objekty = záznamy 4 B (flags, dlaždice, X, Y) kreslené jako 1×1/2×2
  bloky dlaždic (čtveřice 1400h), velké obrázky přes 2AA0h. Znaková sada: 00 mezera, 01–1A A–Z, 20–29 0–9
  (řetězce viz `notes/D`).
- **Zvuk:** mono. Efekty = vlastní obvody (MAME `pleiads_sound`: latche A/B/C, 18‑bit polynomiální
  šum, RC obálky — `sources/mame/pleiads.cpp`) + TMS3615 (247 Hz, decay 0,33) jako „tms"; melodie
  **Epson 7910E** (v MAME `NO_DUMP`, není emulován → `MACHINE_IMPERFECT_SOUND`). Program drží stíny latchů
  438Ch/438Dh a skládá je každý snímek z příznaků s prioritami (`L_3B43`); **výstřel spouští přes SOD
  (`SIM`)**, což MAME neemuluje. Existuje nahrávka výstřelu z reálné desky (`sources/sound/`).

## 3. Rozsah remaku

- **Jen jeden hráč** (rozhodnuto 2026-08-29; režim dvou hráčů z originálu se nedělá).
- **High score a hall of fame na serveru, úplně stejně jako v Manic Mineru:** stejná
  DB tabulka/API (`db/`, `hallOfFameEntity.js`), jméno hráče jako v MM (ne arkádové
  iniciály), zápis po game over, zobrazení v attract mode / menu.
- **Úvodní menu jako v MM** (rozhodnuto 2026-08-29): po načtení se zobrazí `menuModel`
  se stejnou strukturou jako Manic Miner (START GAME, PLAYER NAME, HALL OF FAME, SOUNDS,
  MUSIC, SETTINGS, ATTRACT MODE, ABOUT GAME). Menu **neotevírá zvukové kanály** — audio
  se otevírá až výběrem položky, která zvuk potřebuje (vzor MM: `needEventForAudio()` +
  `ZXWaitForAudioEventEntity` před `startGame2`). Attract mode je položka menu (a
  případně automatický spořič po neaktivitě [?]), **implementovaný per hra**, ne jako
  sdílený modul svision.
- **CRT vzhled** se zapíná v SETTINGS stejně jako přepínač sharp/retro v MM
  (`layout.displayStyle`, `ZXSettingsEntity`), tj. rozšíření existujícího nastavení,
  ne nová volba. Default = jako v MM.
- Attract mode, náhrada INSERT COIN, nastavení, About, PWA. Žádné save game.
- **Pixelově a barevně věrný** obraz (dlaždice + palety z PROM).

## 4. Platforma a vzhled

- **`ArcadeRasterPlatform`** + **`ArcadeRasterLayout`** — **v `app/` projektu, ne ve svision** (rozhodnuto
  2026-08-30, stejně jako SI): soubory `arcadeRasterPlatform.js`, `arcadeRasterLayout.js` jsou kopie ze SI,
  konfigurace v `appPlatform.js` (`{width: 208, height: 256, overlay: {enabled: false}}`). Logická plocha
  **konfigurovatelná per hra** — Pleiads podle kap. 2 (208×256 na výšku, 26×32 dlaždic), bez
  ZX borderu; okolí = černý „bezel" s volitelným obrázkem [?] (sdílet se SI? [?]).
  Layout: celočíselné zvětšení (pixel-perfect), centrování; na mobilu na výšku vyplní
  displej, na desktopu vysoký výřez uprostřed; dotykové ovladače v černém okolí.
  CRT vzhled = přepínač sharp/retro v SETTINGS jako v MM. Barevný overlay se
  u Pleiads **nepoužívá** (barvy jsou z PROM).
- Zobecněné pomocné obrazovky (nastavení, hlasitost, remap, gamepad, jméno, chyba)
  v `canvas2D/` — dodá SI, Pleiads jen nastaví barvu/font.
- Nová **`TileMapEntity`** (svision, canvas2D) — přínos Pleiads:
  - mřížka dlaždic 8×8, N bitových rovin (2 bpp), paleta per dlaždice / per řádek;
  - dvě vrstvy (pozadí se scrollem + popředí), hardwarový vertikální scroll;
  - cache vykreslených dlaždic dle (index, paleta) v `DrawingCache`;
  - formát dat: rozšířit `SpriteTool` o kodek pro 2 bpp dlaždicové sady.
- Data dlaždic a palet z ROM převodem (`rom2tiles`) do JSON v `data/`.

## 5. Ovládání

- ←/→ + Fire (originál má jediné tlačítko, kap. 2), gamepad.
- Dotyk: **stejné ovládání jako v MM** — layouty z `controlsOptions.touchscreen` (tlačítko + horizontální joystick, prohoditelné strany, volba v SETTINGS), jen s akcí Fire místo Jump.

## 6. Architektura

- **Pevný tick = snímek originálu (61,035 Hz, kap. 2).** Worker běží akumulátorově
  (`dt` → N ticků), render interpolaci nedělá — kreslí se poslední stav. Rychlosti
  plynoucí v originále z doby běhu CPU se napodobují explicitně, ne emulací taktů.
- **Deterministický RNG** — přepsat původní generátor (z disassemblace), aby attract/demo
  běžel shodně s originálem, kde je to ověřitelné.
- Kostra = kopie MM. `gameWorker.js`: pevný tick = 1 snímek; stavový automat fází
  1–4; nepřátelé řízeni **tabulkami pohybu z ROM** (vzorce, časovače animací),
  převzatými doslova.
- Hvězdné pozadí a planety = `TileMapEntity` vrstva pozadí se scrollem; popředí =
  dlaždicová vrstva (texty, skóre, loď, nepřátelé) — **hardware nemá sprajty**, vše je
  dlaždice ve dvou tilemapách (ověřeno z MAME `phoenix_v.cpp`); „sprajt" v remaku = blok dlaždic.

## 7. Zvuk

- Originál: **vlastní analogové obvody** (efekty) + TMS3615 + melodický čip Epson 7910E; program jen
  každý snímek zapisuje latche A/B. **Rozhodnuto 2026-08-30 (PL-M6):** efekty nejsou jednorázové
  vzorky jako v SI, ale **emulace zvukové desky** — port MAME `pleiads.cpp` + `tms36xx.cpp` do
  AudioWorkletu `app/pleiadsSoundProcessor.js`, řízeného latchi z workeru (`frame.latches`).
  Syntetizátor svision (skóre) se používá jen pro melodii.
- Řízení: worker posílá ve `frame` hodnoty latchů 6000h/6800h a SOD (WORKER-PROTOCOL.md); model je
  předá `AudioManager.playFrame` (sběrnice `sounds` = deska, `music` = melodie).
- Výstřel (SOD, v MAME chybí) je syntetizován podle nahrávky z reálné desky (`sources/sound/`).
- **Melodie 7910E — rozhodnuto: syntéza.** Podle datasheetu Epson hraje 7910E „Two Minuets" (Bach) a
  „Dark Eyebrows" (ruská lidová) — volná díla; ROM není dumpovaná, nahrávky jen videa → vlastní přepisy
  jako skóre na `music`. Ze schémat Centuri: čip řízen MT (start) a MSL (výběr melodie) z latch B bitů 6–7
  přes invertory; přiřazení bitů je domněnka (viz MILESTONES PL-M6). Nahrávky se do hry nevkládají.


## 8. Data z ROM a právní rámec (společné)

- Grafika, font, tabulky, dlaždice a palety se získají **z ROM převodem přes nástroje v
  `tools/` projektu** (`rom2tiles.mjs`; svision nástroje pro převod ROM nemá — `rom2sprites` SI byl 2026-08-30 vrácen do `spaceinvaders/tools/`) do datových JSON/JS v `app/` či `data/` projektu.
  Hra jen čte data.
- **Všechny zdrojové podklady se ukládají do projektu** (rozhodnuto 2026-08-29) do adresáře
  **`~/sw/pleiades/sources/`**, ze kterého nástroje čerpají — ROM, disassemblace/zdrojáky,
  MAME drivery, nahrávky reálných zvuků, manuály a schémata:
  - `rom/` — ROM set `pleiads` (a pro porovnání Centuri/bootlegy), barevné PROM
  - `asm/` — vlastní komentovaná disassemblace (8085A) + disassemblace Phoenixu jako vodítko
  - `mame/` — `phoenix.cpp`, `phoenix_v.cpp`, `pleiads.cpp` (zvuk)
  - `sound/` — nahrávky z reálné desky (výstřel, melodie 7910E) k ladění syntézy
  - `docs/` — servisní manuál, schémata
  Evidence všech souborů (původ URL, datum stažení, velikost, checksum, licence) je v
  **`sources/FILES.md`**; každý podadresář má navíc `README.md` s původem.
  `sources/` je **mimo git a mimo publikovaný web** (`.gitignore`, nekopíruje se na server);
  do repozitáře jdou jen převedené JSON/JS data v `app/`/`data/`.
- Vše převzaté se eviduje v `SOURCES.md` (svision) a `CREDITS.md` (projekt):
  původ, autor, licence, co bylo upraveno.
- Název hry, grafika a zvuky jsou chráněné (Tehkan/Koei Tecmo). Postup jako u MM/JSW
  (nekomerční, CC BY-NC-SA); před veřejným vydáním rozhodnout název a míru vlastních
  audiovizuálních prvků. [?]
- Referenční nahrávky zvuku slouží jen k **ladění syntézy**, do hry se nevkládají.

## 9. Ověřování

- **Seznam měřitelných referencí** z disassemblace/MAME: tabulky skóre, časování
  animací, rychlosti, vzorce pohybu, pravidla fází, pozice objektů na startu, chování RNG.
- Regresní test: worker headless (Node) na N ticků s daným vstupem → porovnání stavu
  (pozice, skóre, fáze) s hodnotami z MAME debuggeru.
- Testflight stránka jako u MM/JSW (`testFlightPage.php`, `~/sw/testflights/pleiades`).

## 10. Postup (společný rytmus; body 1–2 nezávisle na SI)

1. Podklady do `sources/` (ROM, MAME, Phoenix disassemblace, nahrávky, manuály); **disassemblace ROM** (8085A) — vlastní komentovaný `.asm` v `sources/asm/`, mapa RAM,
   popis fází; vyplnit kap. 2; paralelně převod grafiky a palet (`rom2tiles`) → JSON.
2. Skelet projektu: kopie MM (index.php, config, db, images, app/* bez herní logiky),
   symlink `app/svision`, `svtool build` prochází s prázdnou hrou.
3. Platforma převzatá ze SI + `TileMapEntity`, statický screenshot ze dat.
4. Fáze 1 hratelná bez zvuku (loď, střelba, morphující nepřátelé, pozadí).
5. Fáze 2–4, bonusy, obtížnost, game over.
6. Zvuk: emulace zvukové desky (AudioWorklet) + syntéza melodie 7910E (rozhodnuto 2026-08-30).
7. Attract mode, hall of fame, nastavení, PWA, testflight.
8. Regresní testy, About/Credits.

## 11. Otevřené otázky [?]

- Přesné rozměry/orientace viditelné plochy.
- Hráčovy schopnosti (ochrana/teleport).
- Řešení melodického čipu.
- Společné pro všechny tři hry: **veřejný název a doména** pro vydání (interní název
  projektu = podadresář `pleiades`, rozhodnuto 2026-08-29; veřejný název držet jako parametr
  v `config/`); kabinetový bezel (obrázek ano/ne).
- Sdílený kabinetový bezel se SI.

- **Zrevidovat časování workeru** (operátor 2026-10-07, `../DECISIONS.md`
  R-046 „Co zbývá“). Worker odměřuje tiky **akumulátorem** –
  `app/gameWorker.js` a `app/mockWorker.js`, tik 16,38 ms, 61 Hz. Rozhodnuto
  akumulátor ve všech hrách zrušit a časovat jen konstantou `setTimeout`,
  nastavenou co nejblíž originálu (časem změřenou), jeden tik na volání;
  vzor je `../booty/app/gameWorker.js`.
