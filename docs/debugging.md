# Debugging

## Debug mode in the browser — `?debug=1`

Open e.g. `http://localhost:5173/?map=Lev_Tut1&debug=1`. It also turns on the game's own `bDebugMode`
(hold Space to fast-forward cutscenes). An overlay shows the map, level time, frame, the player (name,
state, location, yaw, physics, zone, base, animation), the camera, the actor at the crosshair and the
latest issue.

| Key | |
|---|---|
| F8 | show / hide the overlay |
| F9 | save a snapshot: downloads `hpdebug_<map>_<time>s.json`, copies a reproduce URL + summary to the clipboard, logs it to the console |
| F10 | lock the actor at the crosshair (or unlock) — the overlay then lists all its properties |

**Going back to a spot:** the snapshot's `reproduce` field is a URL like
`?map=Lev_Tut1&debug=1&pos=-245,-1500,-227&yaw=16384` — loading it puts the player there.

## What a snapshot holds

- `map`, `title`, `levelTime`, `frame`, `reproduce`
- `player` and `camera` (location, rotation, state, zone, base, animation, view target)
- `focus`: the crosshair / locked actor with every property, collision, base, owner, latent action, timer, touching
- `nearby`: actors within 1500 units, nearest first
- `issues`: the last 100 issues, each with map, level time, frame, the **object** whose script raised it
  (name, class, location, state) and the player location; `issueTotals` counts every distinct issue

Issues come from script errors and every `Accessed None` (the console prints only the first 3 of a kind),
from `console.warn` / `console.error`, uncaught errors and rejected promises.

## From the console / tools

- `__debug.snapshot()`, `__debug.save()`, `__debug.issues`, `__debug.find('Tut1Fred3')`, `__debug.describe(actor)`
- Headless: `engine.debug.snapshot({ view })`, `engine.debug.issues` (`tests/helpers.mjs` engines have it too)
- `tools/naive/run.mjs` writes `hpdebug_<map>.json` to the temp directory when a map fails
