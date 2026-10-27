# MorphagusEngine

**English** | [中文](README.zh-CN.md)

A web reimplementation of the Unreal Engine 1 runtime used by *Harry Potter and the Philosopher's Stone*
(*Sorcerer's Stone*, PC, 2001). It loads the game's own packages and runs its original UnrealScript code in the
browser: the script virtual machine, physics and collision, skeletal animation, rendering with three.js /
WebGL, audio, the game's menus, saves and level flow.

| | |
|---|---|
| ![Hogwarts entrance hall](docs/screenshots/hogwarts.jpg) | ![Hogwarts grounds](docs/screenshots/grounds.jpg) |
| ![Dungeon](docs/screenshots/dungeon.jpg) | ![Quidditch](docs/screenshots/quidditch.jpg) |

*Screenshots of the English version running in the browser.*

> **This repository contains no game assets.** No maps, textures, sounds, music, meshes, script packages or
> any other file of the game are included. You need your own installed copy of the game; the engine reads the
> data from that folder at run time.

## Features

- Unreal package reader (names, imports / exports, properties, textures, meshes, sounds, music, levels)
- UnrealScript VM: states and latent functions, the Core / Engine natives and Harry Potter's own natives
- Physics: walking, falling, flying, swimming, movers, encroachment, touch / bump, traces
- Rendering: BSP levels with lightmaps and dynamic lights, skeletal meshes, sprites and particle systems,
  procedural textures, volumetric fog, mirrors and warp zones, decals and shadows
- Audio: positional sounds, music, dialogue
- The game's menus and HUD, cutscenes, level transitions, save games (browser localStorage)
- The view adapts to any window size (wider screens see more at the sides)
- Debug tools: overlay, actor inspector, state snapshots with a reproduce URL

`docs/engine-parity.md` lists every engine module and how it was checked against the reference behaviour.

## Requirements

- Node.js 18 or newer
- An installed copy of *Harry Potter and the Philosopher's Stone* for PC (the folder containing `Maps/`,
  `System/`, `Textures/`, `Sounds/`, `Music/`)

## Running

```bash
npm install
HP_GAME_DIR=/path/to/your/HarryPotter npm run dev   # default: ../HarryPotter
```

Open http://localhost:5173/ for the main menu, or start a map directly with `?map=Lev_Tut1`.

| URL option | Effect |
|---|---|
| `map=<name>` | start that map |
| `lang=int` | English (default: the Traditional Chinese release) |
| `debug=1` | debug overlay — F8 toggle, F9 snapshot, F10 lock target |
| `aspect=4:3` | keep the original 4:3 frame |
| `doors=1` | door mode: casting opens the door Harry aims at (typing `alohomora` in game toggles it) |

Controls are the game's own (`System/DefUser.ini`); Space also jumps.

## Static deployment

```bash
tools/package.sh -l int        # scripts + the data the engine needs, zipped (-l tra|int|all)
tools/package.sh -s            # scripts only (index.html and assets/)
```

Unzip into any static web server directory and open `index.html`. A full package contains your game data:
keep such a site private.

## Tests

```bash
npm test                                    # engine parity and gameplay tests (need the game folder)
node tools/naive/run.mjs Lev_Tut1 Lev_Tut1   # input-driven playthrough bot
```

## License

The engine code is released under the [MIT License](LICENSE). It covers this code only: *Harry Potter*, the
game, its data and its scripts belong to their respective owners and are not part of this repository. This is
an unofficial fan project, not affiliated with or endorsed by Warner Bros., Electronic Arts or KnowWonder.
