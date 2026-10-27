// Shared helpers for tests: filesystem-backed assets + headless engine.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Assets } from '../src/engine/assets.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const GAME_DIR = process.env.HP_GAME_DIR || path.resolve(here, '../../HarryPotter');

// in-memory localStorage for save tests
const mem = new Map();
globalThis.localStorage ??= { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k), clear: () => mem.clear() };

export class NodeAssets extends Assets {
  constructor(dir = GAME_DIR) { super(''); this.dir = dir; }
  async listFiles() {
    const out = [];
    for (const d of ['Maps', 'System', 'Textures', 'Sounds', 'Music']) for (const f of fs.readdirSync(path.join(this.dir, d))) out.push(d + '/' + f);
    return out;
  }
  async fetchBuffer(rel) { const b = fs.readFileSync(path.join(this.dir, rel)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
}

let sharedAssets = null;
export async function assets() {
  if (!sharedAssets) { sharedAssets = new NodeAssets(); await sharedAssets.init(); }
  return sharedAssets;
}

export const stubHud = () => ({ width: 960, height: 720, font: () => null, tile() {}, textWidth: () => 0, drawLine() {} });

// Fresh engine (optionally with a map loaded). Captures console warnings/errors.
export async function engine(map, opts = {}) {
  const { Engine } = await import('../src/game/engine/engine.js');
  const eng = new Engine(await assets());
  eng.issues = [];
  const push = (kind, args) => {
    const s = args.map(String).join(' ').split('\n')[0];
    if (!process.env.ALL_ISSUES && /Accessed None|missing anim|no save in slot/.test(s)) return;
    eng.issues.push(kind + ': ' + s);
  };
  eng.restoreConsole = captureConsole(push);
  await eng.init();
  eng.hud = stubHud();
  if (map) await eng.loadMap(map, '', opts.travel || null);
  return eng;
}

export function captureConsole(push) {
  const oe = console.error, ow = console.warn;
  console.error = (...a) => push('error', a);
  console.warn = (...a) => push('warn', a);
  return () => { console.error = oe; console.warn = ow; };
}

export function tick(eng, seconds, dt = 1 / 30, each) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    each?.(i);
    eng.tick(dt); eng.preRender(960, 720); eng.postRender(960, 720);
    if (eng.pendingTravel) return true;
  }
  return false;
}

export function cutscenePlaying(eng) {
  const L = eng.level;
  return L.actors.some(a => a.bPlaying && a.Class.isA('CutScene')) || !!eng.player?.__state?.name?.startsWith('Cut');
}

export function skipCutscenes(eng, maxSeconds = 120) {
  for (let t = 0; t < maxSeconds && cutscenePlaying(eng); t += 1) if (tick(eng, 1)) return true;
  return false;
}
