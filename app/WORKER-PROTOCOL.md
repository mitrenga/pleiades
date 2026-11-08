# Protokol worker ↔ model (PL-M4, doplněno PL-M5 2026-08-30)

Worker (`app/gameWorker.js`, classic worker script, bez importů) drží stav hry jako originál: virtuální stránku
RAM/VRAM `page` (Uint8Array 4096 = 4000h–4FFFh; fg 0000h–033Fh, proměnné 0340h–07FFh, bg 0800h–0B3Fh) plus
registry `paletteBank` (0–3) a `scroll` (0–255). Herní logika běží v pevném ticku = 1 snímek originálu
(61,035 Hz; akumulátor podle `performance.now()`), po každém ticku odešle snímek.

## model → worker (postMessage)
- `{id:'init', initData:{headless:false, dip:{lives:3, bonus:3}, seed?}}` — start ve stavu „vhozena mince + start“ (fáze 1 bez attractu).
- **Boot (2026-09-12, `app/bootModel.js`):** `{id:'init', initData:{headless:false, tables, inputScript:[], fastForwardAttract:0x1B1,
  pauseAtAttract:0x4B0}}` — bez mince = attract mode; worker synchronně přeskočí na čítač attractu 4398h/4399h = `fastForwardAttract`
  (titul: smazání tabulky skóre, planeta, přehlídka netvorů s nápisem PLEIADS) a při dosažení `pauseAtAttract` se zastaví (`paused`);
  model pak pošle `reset`. `{id:'speed', factor:n}` — herní čas běží n× rychleji (k dispozici, boot ani menu ji teď nepoužívají); `init` vrací 1.
- `{id:'controls', left:bool, right:bool, fire:bool}` — stav vstupů (drží se do další zprávy).
- `{id:'pause'}` / `{id:'continue'}` / `{id:'reset'}`.
- headless (`tools/regress.mjs`): `{id:'tick'}` provede přesně jeden snímek a odešle `frame`.

## worker → model
- `{id:'frame', frame:n, page:Uint8Array(4096) (kopie), paletteBank, scroll, score:int, hiScore:int, lives:int,
   round:int, phase:0–7, state:'intro'|'wave'|'flight'|'mothership'|'landing'|'bonus'|'dying'|'gameOver',
   sounds:[...názvy událostí zvuku v tomto snímku], attract:int|false}`
  — každý snímek (v UI lze posílat každý tick; model kreslí poslední přijatou VRAM). `page` je stránka, kterou hardware
  zobrazuje (bit 0 registru 5000h; stránka 0, dokud stav 0 nepřepne na hráče 2 — `copy_ram_page`), `attract` = čítač
  attractu 4398h/4399h mimo hru (43A2h = 0), jinak `false`.
- `{id:'gameOver', score, hiScore}` — po dokončení animace game over (jediný konec hry; worker se pak zastaví).
- `{id:'roundComplete', round, phase, completed}` — **PL-M5: jen informativní**, hra pokračuje. Posílá se při
  každém zvýšení 43B8h (kolo<<4 | fáze), tj. po dokončení každé fáze (1→2, 2→3, …, 7→ další kolo: `phase:0`,
  `round+1`); `completed` = předchozí hodnota 43B8h. Model na ni nemusí reagovat (PL-M4 zde hru končil —
  `stopAtRoundEnd` už neexistuje / je ignorováno).

## Doplněk workeru (implementace app/gameWorker.js)
- `initData` navíc: `tables` (obsah data/tables.json — povinné, worker z něj skládá 16 KiB obraz ROM),
  `inputScript` ([{frame, in0}] — skript mince/startu jako `sources/reference/input-start.txt`; výchozí = mince
  10–14, start 40–44), `fastForward` (výchozí true mimo headless: po `init` worker synchronně přeskočí na snímek,
  kdy 43A4 přejde do 1 = snímek 48), `dsw` (přímo hodnota DIP 7800h, jinak z `dip`).
- Číslování snímků = referenční emulátor (snímek 0 = reset, stav 1 od snímku 48, fáze 1 od 210).
- `frame` navíc: `latches:{a,b,sod}` (hodnoty zvukových latchů 6000h/6800h zapsané v tomto snímku a SOD) — **PL-M6: jediný
  zdroj zvuku**: model je předává `AudioManager.playFrame` → AudioWorklet `pleiadsSoundProcessor.js` (emulace desky),
  bity 6–7 `b` vybírají melodii na sběrnici `music`; `frame.sounds` jsou od PL-M6 jen informativní
  a `stopped` (false nebo důvod). Worker se zastaví jen na neportovaných cestách mimo hru: attract mode za
  čítačem 0x4E6 (demo hra, PL-M7) po game over, hra 2 hráčů po přepnutí stránky (nespouští se), přetečení
  kreditů. Attract do 0x4E5 (texty, planeta 0x120, titul 0x1B0, start dema 0x1C0–0x1E0, přehlídka netvorů
  s nápisem PLEIADS 0x200–0x3C0, `attract_reinit`, tanec dvou obrázků `attract_ship_anim` 0x400–0x4AF) je
  portovaný a ověřený (`node tools/regress.mjs --script sources/reference/input-attract.txt --frames 1300`,
  0 odchylek, dumpy obou stránek).
- Názvy zvukových událostí v `frame.sounds` (jednorázové spouště odvozené z příznaků, notes/D tabulka):
  `playerShot` (4361=30h), `enemyFire` (nová střela/bomba 43CC+), `enemyHit` (4364=FF: zásah za <100 b., též
  zásah pancíře mateřské lodi typu <8), `enemyHitBig` (4369=FF: ≥100 b., zásah mateřské lodi typu ≥8),
  `tileHit` (4366=FF: střela do scenérie / do jiné části mateřské lodi), `groundHit` (nový slot 4B90/4BA0),
  `enemyDive` (4BE3=10h), `ping` (4362≠0: animace pozadí fáze 1, objevení cíle fáze 5), `bonusLife` (436A=FF),
  `shipExplosion` (4363=FF), `landed` (4369=FF při dosednutí na plochu 6Fh ve fázi 7), `bonusCount` (4363=10h
  každých 32 snímků zobrazení bonusu ve stavu 7 — stejný latch 8Fh jako exploze, kratší).
- `state`: podle 43A4h/43B8h: stavy 1–3 a fáze 0/4 → `intro`, fáze 1/5 → `wave`, 2 → `flight`, 3 → `mothership`,
  6/7 → `landing`; 43A4=4 → `dying`, 5 → `gameOver`, 6/7 (bonusová obrazovka po vlně 2 / po přistání) → `bonus`.
- Průběh kola (43B8h dolní nibble): 0 nájezd planety → 1 vlna 1 → 2 odlet (scroll) → 3 mateřská loď (HP 43BBh 8→0)
  → 4 obrázek → 5 vlna 2 (5 cílů 43BCh, druhá střela) → stav 6 (exploze, bonus 4BDEh) → 6 planeta → 7 přistání →
  stav 7 (bonus 326Eh) → kolo+1, fáze 0. Smrt ve fázi ≥4 vrací fázi o 1 (L_0BA0), ve fázi 2/3 zůstává.
