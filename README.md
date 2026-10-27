# MorphagusEngine

A web reimplementation of the Unreal Engine 1 runtime used by *Harry Potter and the Philosopher's Stone* (PC,
2001): package loading, the UnrealScript virtual machine, physics, collision, animation, rendering (three.js /
WebGL), audio and the game's own menus, saves and level flow — running the original game scripts in the
browser.

**This repository contains no game assets.** No maps, textures, sounds, music, meshes, scripts packages or
other files from the game are included. To run it you need your own installed copy of the game; the engine
reads the data from that folder at run time.

## Running

```bash
npm install
HP_GAME_DIR=/path/to/your/HarryPotter npm run dev   # default: ../HarryPotter
```

Open http://localhost:5173/ (the main menu), or `?map=Lev_Tut1` to start a map directly.

URL options: `debug=1` (debug overlay: F8 toggle, F9 snapshot, F10 lock target), `lang=int` (English),
`aspect=4:3` (original 4:3 frame), `doors=1` (door mode: casting opens the door aimed at; typing
`alohomora` in game toggles it).

Saves are kept in the browser's localStorage.

## Static deployment

`tools/package.sh` builds the scripts and copies the needed data from your installation into a zip for any
static web server (`-l tra|int|all` language, `-s` scripts only). The result contains your game data: keep
such a site private.

## Tests

```bash
npm test                                   # engine parity and gameplay tests (needs the game folder)
node tools/naive/run.mjs Lev_Tut1 Lev_Tut1  # input-driven playthrough bot
```

`docs/engine-parity.md` lists every engine module and how it was checked; `docs/debugging.md` describes the
debug tools.
