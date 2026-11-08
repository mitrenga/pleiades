![](/images/app-icon-256x256.png)

PLEIADES
=====================
Faithful browser remake of the 1981 Tehkan arcade shooter Pleiads — work in progress.

## About
Released by Tehkan in 1981 (Centuri licence in the USA). The original game logic is rewritten in
JavaScript from our own disassembly of the program ROM (not emulated); see `GAME-DESIGN.md` for
the design and `MILESTONES.md` for the plan. Sibling projects: Space Invaders (the arcade
skeleton this project is derived from), Manic Miner, Jet Set Willy (same svision kernel).

Status: **PL-M2** — project skeleton: menu, hall of fame, settings, about; the game itself
(worker, `TileMapEntity`, data from ROM) comes in PL-M3/PL-M4. The app icons, poster and cover
in `images/` are placeholders copied from Manic Miner and will be replaced in PL-M7.

## Play now
https://pleiades.free (placeholder, not deployed yet)

## Requirements
- PHP 8.1+
- nginx
- MySQL / MariaDB
- Node.js + terser, for building the bundle (`npm i -g terser`)
- es-check, for the ES2018 compatibility gate in `svtool verify` (`npm i -g es-check`)

## Install
(`~/` below refers to the project root, not your home directory.)
- clone this repository
- clone library repository https://github.com/mitrenga/svision
- check symlink ~/app/svision
- configure nginx (example: ~/config/nginx.conf)
- create path ~/js with permissions 0777
- create database (script: ~/config/createDB.sql)
- create configuration file ~/config/config.php (example: ~/config/config.php.sample)
- build the production bundle: ~/app/svision/tools/svtool build bundle

## Developer mode
Developer mode is switched in `~/config/config.php` (both settings are optional; without them the app runs in production mode):

```php
$devMode = true;
$devModeName = '.{\"penColor\":\"#000000\",\"bkColor\":\"#fefe00\",\"width\":185}◢◤ ◢◤ ◢◤ ◢◤  DEVELOPER MODE ◢◤ ◢◤ ◢◤ ◢◤';
```

`$devMode` values:
- `true` — development: JS sources are served directly instead of the bundle and the service worker is unregistered/bypassed
- `['serviceWorker' => true]` — development, but the service worker stays enabled
- `false` or not set — production: minified bundle + service worker

`$devModeName` is a label rendered in the bezel of the game screen (plain text, or text prefixed
with a `.{...}` JSON object applied to the label's TextEntity: `penColor`, `bkColor`, `width`).

### Developer parameters

In dev mode only (R-058, `Tool.devParam`): `?devMock=1` runs the game
against the in-thread `app/mockWorker.js` instead of the real worker, so the
UI and the game over path can be exercised without the tables. The same
knob goes into the configuration as `$devMode = ['mock' => 1]`; the address
wins. On a production server the parameter does not exist.

## Build & tooling
The `svtool` CLI (`~/app/svision/tools/svtool`) builds and checks the deploy. Run it from the project root:
- `svtool build bundle` — minified production bundle `js/bundle.<version>.min.js` (requires terser)
- `svtool build debug-bundle` — the same concatenation left unminified, `js/bundle.<version>.js`, for debugging on a device whose console cannot be opened
- `svtool verify` — check the `js/` deploy is complete, matches the current sources, and stays within ES2018
- `svtool info` — show the app version, deploy state and the most recent database records
- `svtool clean` — remove everything generated from `js/`

## Sources
Reference material (ROM, disassembly, MAME driver, manuals, sound recordings) lives in
`sources/` (see `GAME-DESIGN.md` chap. 8). The ROM set (`sources/rom/pleiads/`, `*.zip`) is
outside git; the rest of `sources/` is tracked.

## License
See the [LICENSE](LICENSE) file.
