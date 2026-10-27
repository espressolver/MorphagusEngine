// UE1 light colour / falloff helpers and lightmap generation from shadow bitmaps.

// UE1 FGetHSV: hue/saturation/brightness bytes -> linear RGB (0..1)
export function hsvColor(H, S, V) {
  let b = V * 1.4 / 255;
  b *= 0.7 / (0.01 + Math.sqrt(b));
  b = Math.min(1, Math.max(0, b));
  let h;
  if (H < 86) h = [(85 - H) / 85, H / 85, 0];
  else if (H < 171) h = [0, (170 - H) / 85, (H - 85) / 85];
  else h = [(H - 170) / 85, 0, (255 - H) / 84];
  const s = S / 255;
  return [(h[0] + s * (1 - h[0])) * b, (h[1] + s * (1 - h[1])) * b, (h[2] + s * (1 - h[2])) * b];
}

export function lightFromProps(props, loc) {
  const p = props;
  const type = p.LightType ?? 0;
  if (type === 0) return null;
  const color = hsvColor(p.LightHue ?? 0, p.LightSaturation ?? 255, p.LightBrightness ?? 64);
  return {
    pos: [loc.x ?? loc.X ?? 0, loc.y ?? loc.Y ?? 0, loc.z ?? loc.Z ?? 0],
    radius: Math.max(p.DrawScale ?? 1, 1) * 25 * ((p.LightRadius ?? 64) + 1), // WorldLightRadius
    color,
    type,
    effect: p.LightEffect ?? 0,
    cone: p.LightCone ?? 128,
    rot: p.Rotation ? { pitch: p.Rotation.pitch ?? p.Rotation.Pitch ?? 0, yaw: p.Rotation.yaw ?? p.Rotation.Yaw ?? 0, roll: 0 } : { pitch: 0, yaw: 0, roll: 0 },
    period: p.LightPeriod ?? 32,
    phase: p.LightPhase ?? 0,
    bSpecialLit: !!p.bSpecialLit,
    bActorShadows: !!p.bActorShadows,
    dark: !!p.bDarkLight,
    hue: p.LightHue ?? 0, sat: p.LightSaturation ?? 255, brightness: p.LightBrightness ?? 64,
    radiusInner: Math.max(p.DrawScale ?? 1, 1) * 25 * ((p.LightRadius ?? 64) + 1) * (p.LightRadiusInner ?? 0) / 256,
    source: p.LightSource ?? 0,
  };
}

// ---- static (lightmap) lighting, as URender's FLightManager computes it ----

// LightDist[i]: falloff 2S^3 - 3S^2 + 1 at S = sqrt((i + 1) / 4096) of the radius; LightDistInc = that / S
export const LIGHT_DIST = new Float32Array(4096), LIGHT_DIST_INC = new Float32Array(4096);
for (let i = 0; i < 4096; i++) {
  const S = Math.sqrt((i + 1) / 4096), t = 2 * S * S * S - 3 * S * S + 1;
  LIGHT_DIST[i] = t; LIGHT_DIST_INC[i] = t / S;
}

// FLightInfo colour: hue/saturation at full value, times LightBrightness/255 and the level brightness
// (steady: the light-type effects are left to the dynamic path)
export function staticLightColor(L, levelBrightness = 1, typeScale = 1) {
  const c = hsvColor(L.hue, L.sat, 255), b = Math.min(1, Math.max(0, L.brightness / 255 * typeScale));
  return [c[0] * b * levelBrightness, c[1] * b * levelBrightness, c[2] * b * levelBrightness];
}

// ToByte: round to nearest (even), low byte
export function toByte(f) {
  const r = Math.round(f);
  return (Math.abs(f % 1) === 0.5 && r % 2 ? r - 1 : r) & 255;
}

const SPATIAL_GENERAL = new Set([4, 5, 6, 8, 9, 10, 12, 13, 14, 16, 17, 18]);

// The effect's spatial value x scale at a luxel, before the shadow value (Spatial / Visible / Scale of
// the LE_ classes; dynamic ones — searchlight, waves, disco… — are taken at their plain radial value).
// (vx, vy, vz): luxel minus light; planeDot: light-to-surface-plane distance; n: surface normal
export function luxelSpatial(L, vx, vy, vz, planeDot, n, t = 0) {
  const R = L.radius, d2 = vx * vx + vy * vy + vz * vz, eff = L.effect;
  let idx;
  if (SPATIAL_GENERAL.has(eff)) {
    idx = Math.round(d2 * 4093 / (R * R));
    if (idx >= 4096) return 0;
  } else {
    const inner = Math.round(d2 * (4095 / Math.max(1, R)) ** 2);
    if (inner >= 4096 * 4096) return 0;
    idx = inner >> 12;
  }
  const Ri = L.radiusInner || 0, rr = 1 / Math.max(1, R);
  // Effect_None::Init: incidence from the plane distance (radial), the view direction (plane), or none
  let diffuse, tab = LIGHT_DIST;
  if (L.source === 1) {
    const yaw = L.rot.yaw * Math.PI / 32768, pitch = L.rot.pitch * Math.PI / 32768;
    const fx = Math.cos(pitch) * Math.cos(yaw), fy = Math.cos(pitch) * Math.sin(yaw), fz = Math.sin(pitch);
    diffuse = Math.max(-(fx * n[0] + fy * n[1] + fz * n[2]), 0);
  } else if (L.source === 2) diffuse = 1;
  else { diffuse = Math.abs(planeDot) * rr; tab = LIGHT_DIST_INC; }
  const kInner = R - Ri > 0 ? R / (R - Ri) : 1e9;
  const none = () => Math.min(diffuse * kInner * tab[idx], 1);
  switch (eff) {
    case 17: return Math.max(0, 1 - (vx * vx + vy * vy) * rr * rr); // Cylinder
    case 13: return Math.min(kInner * LIGHT_DIST[idx], 1);             // NonIncidence
    case 14: return Math.max(0, 1 - 10 * Math.abs(LIGHT_DIST[idx] - 0.1)); // Shell
    case 8: case 12: {                                                  // (static) spotlight
      const yaw = L.rot.yaw * Math.PI / 32768, pitch = L.rot.pitch * Math.PI / 32768;
      const fx = Math.cos(pitch) * Math.cos(yaw), fy = Math.cos(pitch) * Math.sin(yaw), fz = Math.sin(pitch);
      const sine = 1 - L.cone / 256, vd = vx * fx + vy * fy + vz * fz;
      if (!(vd > 0 && vd * vd > sine * sine * d2)) return 0;
      const sc = (vd / Math.sqrt(d2) - sine) / (1 - sine);
      return none() * sc * sc;
    }
    case 4: case 5: case 6: case 9: case 10: case 16: case 18: {
      const sc = cycleScale(L, eff, vx, vy, vz, t);
      return sc > 0 ? none() * sc : 0;
    }
    default: return Ri ? none() : diffuse * tab[idx];
  }
}

// Effect_Cycle family (time-varying spatial effects): visibility x scale at a luxel; 0 = not lit
const TO_RAD = Math.PI * 2 / 65536, sinTab = i => Math.sin((i % 65536) * TO_RAD), cosTab = i => Math.cos((i % 65536) * TO_RAD);
function cycleScale(L, eff, X, Y, Z, t) {
  let tab = Math.trunc(L.period ? t * (1 << 20) / L.period : 0) + ((L.phase | 0) << 8);
  let ang = tab * TO_RAD;
  const size = Math.hypot(X, Y, Z);
  switch (eff) {
    case 4: { // SearchLight
      ang += Math.PI / 2;
      let a = (4 * (ang + Math.atan2(X, Y))) % (8 * Math.PI);
      if (a < 0) a += 8 * Math.PI;
      if (!(a >= Math.PI && a <= Math.PI * 3)) return 0;
      let sc = 0.5 + 0.5 * Math.cos(a);
      const D = 0.00006 * (X * X + Y * Y);
      if (D < 1) sc *= D;
      return sc;
    }
    case 5: return 0.7 + 0.3 * sinTab(Math.round(size * 1024) - tab);
    case 6: return 0.7 + 0.3 * sinTab(Math.round(size * 512) - tab);
    case 9: {
      const d = Math.trunc(8 * size);
      return (0.9 + 0.1 * sinTab((d << 5) - tab)) * (0.9 + 0.1 * cosTab((d << 4) + tab)) * (0.9 + 0.1 * sinTab((d >> 3) - tab));
    }
    case 10: {
      const s1 = 0.5 + 0.5 * Math.cos(11 * Math.atan2(X, Y) + ang), s2 = 0.5 + 0.5 * Math.cos(11 * Math.atan2(Math.hypot(X, Y), Z) + ang);
      let sc = s1 + s2 - s1 * s2;
      const D = 0.00005 * (X * X + Y * Y);
      if (D < 1) sc *= D;
      return 1 - sc;
    }
    case 16: return 0.5 + 0.5 * Math.cos(11 * Math.atan2(Math.hypot(X, Y), Z) + ang);
    case 18: {
      let sc = 0.5 + 0.5 * Math.cos(6 * Math.atan2(X, Y) + ang);
      const D = 0.0001 * (X * X + Y * Y);
      if (D < 1) sc = 1 - D + sc * D;
      return sc;
    }
  }
  return 1;
}

// Which surface-light path a light takes (FLightManager::AddLight): 'static' (baked once), 'dynamic'
// (shadow-masked, re-merged every frame: a non-steady type, a time-varying or merge-time effect, or a
// non-static light that can't move) or 'moving' (no shadow mask: movable lights)
const SPATIAL_DYN = new Set([4, 5, 6, 7, 9, 10, 16, 18]), MERGE_DYN = new Set([1, 2, 3]);
export function surfLightKind(p) {
  if (p.bDynamicLight || !(p.bStatic || p.bNoDelete)) return 'moving';
  if (p.bStatic && (p.LightType ?? 0) === 1 && !SPATIAL_DYN.has(p.LightEffect | 0) && !MERGE_DYN.has(p.LightEffect | 0)) return 'static';
  return 'dynamic';
}

// FGlobalRandoms: 256 per-tick randoms (RandomBase) and 256 that drift toward them over 16 ticks (Random),
// ticking at 35 Hz
export class GlobalRandoms {
  constructor() { this.bases = new Float32Array(256); this.rands = new Float32Array(256); this.deltas = new Float32Array(256); this.last = 0; }
  tick(time) {
    const ticks = Math.trunc(time * 35) >>> 0;
    for (let i = 0; i < 256; i++) this.bases[i] = Math.random();
    if (this.last && ((ticks - this.last) * 16) >>> 0 < 256) {
      let r = (ticks * 16) & 255;
      const m = (this.last * 16) & 255;
      for (let n = m; n !== r; n = (n + 1) & 255) this.deltas[n] = (this.bases[n] - this.rands[n]) / 16;
      const f = (ticks - this.last) & 255;
      do { this.rands[r] += this.deltas[r] * f; r = (r + 1) & 255; } while (r !== m);
    } else for (let i = 0; i < 256; i++) { this.rands[i] = Math.random(); this.deltas[i] = (this.bases[i] - this.rands[i]) / 16; }
    for (let i = 0; i < 256; i++) this.rands[i] = Math.min(1, Math.max(0, this.rands[i]));
    this.last = ticks;
  }
  randomBase(i) { return this.bases[i & 255]; }
  random(i) { return this.rands[i & 255]; }
}

// URender::GlobalLighting light-type brightness factor (before the 0..1 clamp)
export function lightTypeScale(a, t, frame, rnd) {
  const period = a.LightPeriod ?? 32, phase = (a.LightPhase ?? 0) << 8;
  switch (a.LightType ?? 1) {
    case 0: return 0;
    case 2: return 0.6 + 0.39 * sinTab(Math.round(t * 35 * 65536 / Math.max(period, 1) + phase));
    case 3: return Math.round(t * 35 * 65536 / (period + 1) + phase) & 1 ? 0 : 1;
    case 4: { const r = rnd ? rnd.randomBase(a.__rndKey ??= (Math.random() * 256) | 0) : Math.random(); return r < 0.5 ? 0 : r; }
    case 5: return frame & 1 ? 0 : 1;
    case 7: return 0.9 + 0.09 * sinTab(t * 35 * 65536 / Math.max(period, 1) + phase);
    default: return 1;
  }
}

// Merge one light into a lightmap's 0..127 colour bytes: the shadow-filtered spatial byte (with the merge-time
// TorchWaver / FireWaver / WateryShimmer flicker), through the palette; dark lights subtract (floor 0)
export function mergeSurfLight(acc, n, L, fc, shadow, spatial, rnd, key = 0) {
  const fix = fc.map(c => Math.floor(c * 65536)), eff = L.effect;
  for (let j = 0; j < n; j++, key++) {
    const sh = shadow[j];
    if (!sh) continue;
    const f = spatial(j);
    if (!(f > 0)) continue;
    let i = toByte(sh * f);
    if (eff === 1) i = Math.floor(i * (0.95 + 0.05 * rnd.randomBase(key)));
    else if (eff === 2) i = Math.floor(i * (0.8 + 0.2 * rnd.randomBase(key)));
    else if (eff === 3) i = Math.floor(i * (0.6 + 0.4 * rnd.random(key)));
    if (!i) continue;
    const k = j * 3;
    for (let c = 0; c < 3; c++) {
      const pc = Math.min(127, Math.floor(i * fix[c] / 65536));
      acc[k + c] = L.dark ? Math.max(0, acc[k + c] - pc) : Math.min(127, acc[k + c] + pc);
    }
  }
}

// ShadowMapGen: the 1-bit shadow mask (LSB first, rows of `rowBytes`) smoothed with the 3x3 filter
// 24 40 24 / 40 64 40 / 24 40 24 (each row's sum scaled by 255/320 and floored), edges repeated; out 0..254
export function filterShadow(bits, off, w, h, rowBytes) {
  const out = new Uint8Array(w * h);
  const W = [[24, 40, 24], [40, 64, 40], [24, 40, 24]];
  const last = rowBytes * 8 - 1;
  const bit = (u, v) => {
    v = Math.min(h - 1, Math.max(0, v));
    u = u < 0 ? 0 : u > last ? last : u;
    return (bits[off + v * rowBytes + (u >> 3)] >> (u & 7)) & 1;
  };
  for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) {
    let sum = 0;
    for (let j = 0; j < 3; j++) {
      const acc = W[j][0] * bit(u - 1, v + j - 1) + W[j][1] * bit(u, v + j - 1) + W[j][2] * bit(u + 1, v + j - 1);
      sum += Math.floor(acc * 255 / 320);
    }
    out[v * w + u] = sum;
  }
  return out;
}

// Spatial light effect evaluation at a point (UE1 "spatial" effects, static ones only)
export function lightAt(L, x, y, z, nx, ny, nz) {
  const dx = L.pos[0] - x, dy = L.pos[1] - y, dz = L.pos[2] - z;
  const d2 = dx * dx + dy * dy + dz * dz;
  const r2 = L.radius * L.radius;
  if (d2 >= r2) return 0;
  const d = Math.sqrt(d2) || 1;
  let inc = (nx * dx + ny * dy + nz * dz) / d;
  if (L.effect === 13) inc = 1; // LE_NonIncidence
  if (inc <= 0) return 0;
  let f = 1 - d2 / r2;          // UE1 smooth falloff
  if (L.effect === 12 || L.effect === 8) { // spotlight / static spot
    const yaw = L.rot.yaw * Math.PI / 32768, pitch = L.rot.pitch * Math.PI / 32768;
    const fx = Math.cos(pitch) * Math.cos(yaw), fy = Math.cos(pitch) * Math.sin(yaw), fz = Math.sin(pitch);
    const dot = -(fx * dx + fy * dy + fz * dz) / d;
    const cone = 1 - L.cone / 256;
    if (dot < cone) return 0;
    f *= (dot - cone) / (1 - cone);
  }
  if (L.effect === 17) { // LE_Cylinder
    const h2 = dx * dx + dy * dy;
    if (h2 >= r2) return 0;
    f = 1 - h2 / r2;
  }
  return f * (L.effect === 13 ? 1 : (0.5 + 0.5 * inc)) * inc * 2;
}

// Shelf packer for lightmap atlas pages
export class AtlasPacker {
  constructor(size = 2048) {
    this.size = size;
    this.pages = [];
    this.newPage();
  }
  newPage() {
    const page = { data: new Uint8Array(this.size * this.size * 4), x: 0, y: 0, rowH: 0 };
    this.pages.push(page);
    return page;
  }
  alloc(w, h) {
    const W = w + 2, H = h + 2;
    let page = this.pages[this.pages.length - 1];
    if (page.x + W > this.size) { page.x = 0; page.y += page.rowH; page.rowH = 0; }
    if (page.y + H > this.size) { page = this.newPage(); }
    const x = page.x + 1, y = page.y + 1;
    page.x += W;
    page.rowH = Math.max(page.rowH, H);
    return { page: this.pages.length - 1, x, y };
  }
}
