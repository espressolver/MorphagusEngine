// Debug top-down map of a level region: floor height (gray), explored planner nodes (green),
// blockers (red), movers (blue), triggers/cutscenes (yellow), player (magenta), goal (cyan).
// usage: node tools/naive/topdown.mjs Map cx,cy,halfSize zLow,zHigh out.png [goalActor]
import fs from 'fs';
import zlib from 'zlib';
import { engine } from '../../tests/helpers.mjs';
import { Bot } from './bot.mjs';
import { GridNav } from './gridnav.mjs';
import { cylinderFloor } from '../../src/game/engine/collision.js';

export function writePNG(path, w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

export function drawTopdown(eng, { cx, cy, half, zLow, zHigh, out, nav, goal, res = 512 }) {
  const L = eng.level, W = L.world, px = (half * 2) / res;
  const img = Buffer.alloc(res * res * 3);
  const set = (x, y, c) => { const i = Math.round((y - (cy - half)) / px), j = Math.round((x - (cx - half)) / px); if (i < 0 || j < 0 || i >= res || j >= res) return; const o = ((res - 1 - i) * res + j) * 3; img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2]; };
  for (let i = 0; i < res; i++) for (let j = 0; j < res; j++) {
    const x = cx - half + j * px, y = cy - half + i * px;
    const f = cylinderFloor(W, x, y, px * 0.5, zLow, zHigh);
    const o = ((res - 1 - i) * res + j) * 3;
    if (f) { const g = 40 + Math.round(200 * (f.z - zLow) / (zHigh - zLow)); img[o] = img[o + 1] = img[o + 2] = g; }
  }
  const disc = (loc, r, c) => { for (let a = 0; a < 6.283; a += 0.2) for (let rr = 0; rr <= r; rr += px) set(loc.X + Math.cos(a) * rr, loc.Y + Math.sin(a) * rr, c); };
  if (nav) for (const k of nav.cache.keys()) { const [x, y] = k.split(',').map(Number); set(x * 24, y * 24, [0, 200, 0]); }
  for (const a of L.actors) {
    if (a.__deleted) continue;
    if (a.__moverMesh) disc(a.Location, Math.max(px * 2, 24), [60, 60, 255]);
    else if (a.Class.isA('Trigger') || a.Class.isA('CutScene')) disc(a.Location, Math.max(px * 2, Math.min(a.CollisionRadius || 20, 60)), [230, 210, 0]);
    else if (a.bBlockPlayers && a.bCollideActors && !a.Class.isA('Pawn')) disc(a.Location, a.CollisionRadius || 10, [220, 30, 30]);
  }
  if (goal) disc(goal.Location || goal, 30, [0, 230, 230]);
  disc(eng.player.Location, 20, [255, 0, 255]);
  writePNG(out, res, res, img);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [map, area, zr, out, goalName] = process.argv.slice(2);
  const eng = await engine(map); const bot = new Bot(eng);
  bot.wait(3); bot.waitCutscenes();
  const [cx, cy, half] = area.split(',').map(Number), [zLow, zHigh] = zr.split(',').map(Number);
  const goal = goalName ? eng.level.actors.find(a => a.Name === goalName) : null;
  const nav = new GridNav(eng, );
  if (goal) nav.plan(goal.Location, 60, 60000);
  drawTopdown(eng, { cx, cy, half, zLow, zHigh, out, nav, goal });
  eng.restoreConsole();
}
