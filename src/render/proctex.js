// Procedural textures (Fire.dll, UnFractal.cpp): FireTexture spark engine and heat diffusion, the
// WaterTexture two-field wave simulation (WaveTexture lit through its table, WetTexture as horizontal
// refraction of a source texture) and IceTexture glass panning. All work on 8-bit palette indices like the
// engine and are colourized through the texture's palette; ticking follows UTexture::Tick.
import { readProperties } from '../engine/uobject.js';

// ---------------------------------------------------------------- shared tables
const PhaseTable = new Uint8Array(256), SignedPhaseTable = new Uint8Array(256), LightPhaseTable = new Uint8Array(256);
for (let t = 0; t < 256; t++) PhaseTable[t] = Math.round(127.45 + 127.5 * Math.sin((t / 256) * 6.2831853));
for (let t = 0; t < 256; t++) {
  LightPhaseTable[t] = Math.min(255, Math.max(0, PhaseTable[t] + 32));
  SignedPhaseTable[t] = (-128 + sb(PhaseTable[t])) & 255;
}
function sb(v) { return (v << 24) >> 24; } // byte as SBYTE

// SpeedRand: shift-register generator on 64 bytes (the C version of the engine's)
const SpeedRandArr = new Uint8Array(512);
for (let t = 0; t < 512; t++) SpeedRandArr[t] = (Math.random() * 256) & 255;
let SpeedRindex = 0;
function SpeedRand() {
  SpeedRindex = (SpeedRindex + 1) & 63;
  return (SpeedRandArr[(SpeedRindex + 31) & 63] ^= SpeedRandArr[SpeedRindex]);
}

// spark types (ESpark, then the internal ones)
const S = {
  Burn: 0, Sparkle: 1, Pulse: 2, Signal: 3, Blaze: 4, OzHasSpoken: 5, Cone: 6, BlazeRight: 7, BlazeLeft: 8, Cylinder: 9,
  Cylinder3D: 10, Lissajous: 11, Jugglers: 12, Emit: 13, Fountain: 14, Flocks: 15, Eels: 16, Organic: 17, WanderOrganic: 18,
  RandomCloud: 19, CustomCloud: 20, LocalCloud: 21, Stars: 22, LineLightning: 23, RampLightning: 24, SphereLightning: 25,
  Wheel: 26, Gametes: 27, Sprinkler: 28, LissajX: 29, LissajY: 30, TRANSIENTS: 31, Drifter: 32, DriftSlow: 33, Faller: 34,
  VShooter: 35, Drop: 36, Move: 37, SpawnedEel: 38, SpawnedTwirl: 39, SprinklerTwirl: 40, Custom: 41, Graviton: 42, SpawnedSperm: 43,
};

// Read the native spark list that follows the mip data of a FireTexture export (TArray<FSpark>)
export function readSparks(pkg, exp) {
  const r = pkg.readerFor(exp);
  readProperties(r);
  const nm = r.idx();
  for (let i = 0; i < nm; i++) { if (pkg.version >= 63) r.i32(); const sz = r.idx(); r.pos += sz; r.i32(); r.i32(); r.u8_(); r.u8_(); }
  const sparks = [];
  if (r.pos < r.end) {
    const n = r.idx();
    for (let i = 0; i < n && r.pos + 8 <= r.end; i++) {
      sparks.push({ Type: r.u8_(), Heat: r.u8_(), X: r.u8_(), Y: r.u8_(), ByteA: r.u8_(), ByteB: r.u8_(), ByteC: r.u8_(), ByteD: r.u8_() });
    }
  }
  return sparks;
}

const log2 = n => Math.round(Math.log2(n));

// base: index bitmap, palette colourizing and UTexture::Tick timing (MaxFrameRate catch-up, priming)
class Fractal {
  constructor(w, h, props, palette) {
    this.w = w; this.h = h; this.props = props;
    this.UBits = log2(w); this.UMask = w - 1; this.VMask = h - 1;
    this.data = new Uint8Array(w * h);
    this.rgba = new Uint8Array(w * h * 4);
    this.palette = palette; this.masked = !!props.bMasked;
    this.GlobalPhase = 0; this.AuxPhase = 0; this.DrawPhase = 0;
    this.accumulator = 0;
    this.primeCurrent = props.PrimeCurrent | 0; this.primeCount = props.PrimeCount | 0;
  }
  // UTexture::Tick
  tick(dt) {
    while (this.primeCurrent < this.primeCount) { this.primeCurrent++; this.constantTimeTick(); }
    const max = this.props.MaxFrameRate ?? 0;
    if (!max) { this.constantTimeTick(); return true; }
    const minTime = 1 / Math.min(100, Math.max(0.1, max)), maxTime = 1 / Math.min(100, Math.max(0.1, this.props.MinFrameRate ?? 0));
    this.accumulator += dt;
    if (this.accumulator < minTime) return false;
    this.constantTimeTick();
    if (this.accumulator < maxTime) this.accumulator = 0;
    else { this.accumulator -= maxTime; if (this.accumulator > maxTime) this.accumulator = maxTime; }
    return true;
  }
  colorize(src = this.data) {
    const pal = this.palette, out = this.rgba, n = this.w * this.h;
    for (let i = 0; i < n; i++) {
      const c = src[i], o = i * 4;
      if (pal) { out[o] = pal[c * 4]; out[o + 1] = pal[c * 4 + 1]; out[o + 2] = pal[c * 4 + 2]; }
      else { out[o] = out[o + 1] = out[o + 2] = c; }
      out[o + 3] = this.masked && c === 0 ? 0 : 255;
    }
  }
}

// ---------------------------------------------------------------- FireTexture
export class FireSim extends Fractal {
  constructor(w, h, props, sparks, palette) {
    super(w, h, props, palette);
    // (NumSparks = the engine's ActiveSparkNum)
    this.sparks = sparks.slice(0, props.NumSparks ?? sparks.length).map(s => ({ ...s }));
    this.limit = Math.min(8192, Math.max(4, props.SparksLimit ?? 1024));
    if (this.sparks.length > this.limit) this.sparks.length = this.limit;
    this.StarStatus = 1;
    // RenderTable: average of the four cells, cooled by (255 - RenderHeat) / 16
    const rh = props.RenderHeat ?? 220;
    this.table = new Uint8Array(1028);
    for (let T = 0; T < 1024; T++) this.table[T] = Math.trunc(Math.min(255, Math.max(0, T / 4 + 1 - (255 - rh) / 16)));
    this.rising = props.bRising !== false;
    this.FX_Frequency = props.FX_Frequency ?? 16;
  }
  constantTimeTick() {
    if (this.w < 8 || this.h < 8) return;
    this.redrawSparks();
    if (this.rising) this.calcWrapFire(); else this.calcSlowFire();
    this.postDrawSparks();
  }
  step(dt) { if (this.tick(dt)) { this.colorize(); return true; } return false; }

  calcWrapFire() {
    const B = this.data, T = this.table, X = this.w, Y = this.h;
    const row = (y, lo, lower) => {
      const t = y * X, b = lo * X, l = lower * X;
      B[t] = T[B[b] + B[b + X - 1] + B[b + 1] + B[l]];
      for (let x = 1; x < X - 1; x++) B[t + x] = T[B[b + x] + B[b + x - 1] + B[b + x + 1] + B[l + x]];
      B[t + X - 1] = T[B[b + X - 1] + B[b + X - 2] + B[b] + B[l + X - 1]];
    };
    for (let y = 0; y < Y - 2; y++) row(y, y + 1, y + 2);
    row(Y - 2, Y - 1, 0);
    row(Y - 1, 0, 1);
  }
  calcSlowFire() {
    const B = this.data, T = this.table, X = this.w, Y = this.h;
    const line0 = B.slice(0, X);
    const row = (y, lowerArr, l) => {
      const t = y * X;
      B[t] = T[B[t] + B[t + X - 1] + B[t + 1] + lowerArr[l]];
      for (let x = 1; x < X - 1; x++) B[t + x] = T[B[t + x] + B[t + x - 1] + B[t + x + 1] + lowerArr[l + x]];
      B[t + X - 1] = T[B[t + X - 1] + B[t + X - 2] + B[t] + lowerArr[l + X - 1]];
    };
    for (let y = 0; y < Y - 1; y++) row(y, B, (y + 1) * X);
    row(Y - 1, line0, 0);
  }

  put(x, y, v) { this.data[(x & this.UMask) + ((y & this.VMask) << this.UBits)] = v & 255; }
  spawn() { if (this.sparks.length >= this.limit) return null; const n = { Type: 0, Heat: 0, X: 0, Y: 0, ByteA: 0, ByteB: 0, ByteC: 0, ByteD: 0 }; this.sparks.push(n); return n; }
  remove(i) { const last = this.sparks.pop(); if (i < this.sparks.length) this.sparks[i] = last; }

  moveXY(s, xs, ys) {
    xs = sb(xs); ys = sb(ys);
    if (xs < 0) { if ((SpeedRand() & 127) < -xs) s.X = this.UMask & (s.X - 1); }
    else if ((SpeedRand() & 127) < xs) s.X = this.UMask & (s.X + 1);
    if (ys < 0) { if ((SpeedRand() & 127) < -ys) s.Y = this.VMask & (s.Y - 1); }
    else if ((SpeedRand() & 127) < ys) s.Y = this.VMask & (s.Y + 1);
  }
  move(s) { this.moveXY(s, s.ByteA, s.ByteB); }
  moveTwo(s) {
    const a = sb(s.ByteA);
    if (a < 0) { if ((SpeedRand() & 127) < -a) s.X = this.UMask & (s.X - 1); }
    else if ((SpeedRand() & 127) < a) s.X = this.UMask & (s.X + 1);
    s.Y = this.VMask & (s.Y - 2);
  }
  moveAngle(s, angle) { this.moveXY(s, (-127 + sb(PhaseTable[angle & 255])) & 255, (-127 + sb(PhaseTable[(angle + 64) & 255])) & 255); }
  wander(s) {
    // (the engine's "SpeedRand() & 15 == 15" is SpeedRand() & 1)
    if (SpeedRand() & 1) s.X = this.UMask & (s.X + (SpeedRand() & 15) - 7);
    if (SpeedRand() & 1) s.Y = this.VMask & (s.Y + (SpeedRand() & 15) - 7);
  }

  drawFlashRamp(Xpos, Ypos, Xlen, Ylen, Color1, Color2) {
    if (((Ylen & 1) && (Ylen * 2 >= Xlen)) || ((Xlen & 1) && (Ylen * 2 < Xlen))) {
      Xpos = (Xpos + ((Xlen & 1) ? -Xlen : Xlen)) & 255;
      Ypos = (Ypos + ((Ylen & 1) ? -Ylen : Ylen)) & 255;
      Xlen ^= 1; Ylen ^= 1;
      const t = Color1; Color1 = Color2; Color2 = t;
    }
    const MajorLen = 1 | (Xlen >= Ylen ? Xlen : Ylen);
    const flash = new Uint8Array(256);
    let FlashPos = 0;
    for (let f = 0; f < MajorLen; f++) FlashPos += (flash[f] = SpeedRand());
    let Ystep, RealYlen, Xstep, RealXlen;
    if (Ylen & 1) { Ystep = -1; RealYlen = -Ylen; } else { Ystep = 1; RealYlen = Ylen; }
    if (Xlen & 1) { Xstep = -1; RealXlen = -Xlen; } else { Xstep = 1; RealXlen = Xlen; }
    let ramp = (Color1 << 23) | 0;
    const slope = Math.trunc(((Color2 - Color1) << 23) / MajorLen);
    const D = this.data;
    if (Xlen >= Ylen) {
      let Ypoz = Ypos << 6;
      const bias = Math.trunc(((RealYlen << 6) - FlashPos) / MajorLen);
      for (let f = 0; f < Xlen; f++) {
        Ypoz += flash[f] + bias;
        const dest = (((Ypoz >> 6) & this.VMask) << this.UBits) + (Xpos & this.UMask);
        Xpos = (Xpos + Xstep) & 255;
        ramp = (ramp + slope) | 0;
        D[dest] = (ramp >> 23) & 255;
      }
    } else {
      let Xpoz = Xpos << 6;
      const bias = Math.trunc(((RealXlen << 6) - FlashPos) / MajorLen);
      for (let f = 0; f < Ylen; f++) {
        Xpoz += flash[f] + bias;
        const dest = ((Ypos & this.VMask) << this.UBits) + ((Xpoz >> 6) & this.UMask);
        Ypos = (Ypos + Ystep) & 255;
        ramp = (ramp + slope) | 0;
        D[dest] = (ramp >> 23) & 255;
      }
    }
  }

  redrawSparks() {
    this.AuxPhase = (this.AuxPhase + this.FX_Frequency) & 255;
    this.GlobalPhase++;
    const D = this.data, U = this.UMask, V = this.VMask, UB = this.UBits;
    const at = s => s.X + (s.Y << UB);
    const sp = this.sparks;
    for (let i = 0; i < sp.length; i++) {
      const s = sp[i];
      switch (s.Type) {
        case S.Burn: D[at(s)] = SpeedRand(); break;
        case S.Sparkle: {
          const nx = s.X + ((SpeedRand() * s.ByteA) >> 8), ny = s.Y + ((SpeedRand() * s.ByteB) >> 8);
          D[(U & nx) + ((V & ny) << UB)] = s.Heat; break;
        }
        case S.Pulse: D[at(s)] = s.Heat; s.Heat = (s.Heat + s.ByteD) & 255; break;
        case S.Signal:
          if (s.Heat > s.ByteC) D[at(s)] = s.Heat;
          s.Heat = (s.Heat + s.ByteD) & 255;
          if (s.Heat < s.ByteD) s.Heat = SpeedRand();
          break;
        case S.Cylinder: case S.Cylinder3D: {
          if (s.Type === S.Cylinder || ((s.ByteA + 64) & 255) < 128) {
            const h = Math.min(PhaseTable[(s.ByteA + 64) & 255] + s.Heat, 255);
            const xt = (s.X + ((PhaseTable[s.ByteA] * s.ByteB) >> 8)) & 255;
            D[(xt & U) + (s.Y << UB)] = h;
          }
          s.ByteA = (s.ByteA + s.ByteD) & 255; break;
        }
        case S.Jugglers: {
          const h = Math.min(PhaseTable[(s.ByteA + 64) & 255] + s.Heat, 255);
          const yt = (s.Y + ((PhaseTable[s.ByteA] * s.ByteB) >> 8)) & 255;
          D[s.X + ((yt & V) << UB)] = h;
          s.ByteA = (s.ByteA + s.ByteD) & 255; break;
        }
        case S.Lissajous: {
          const h = LightPhaseTable[(s.ByteA + 64) & 255];
          const xt = (s.X + ((PhaseTable[s.ByteA] * s.Heat) >> 8)) & 255, yt = (s.Y + ((PhaseTable[s.ByteB] * s.Heat) >> 8)) & 255;
          D[(xt & U) + ((yt & V) << UB)] = h;
          s.ByteA = (s.ByteA + s.ByteC) & 255; s.ByteB = (s.ByteB + s.ByteD) & 255; break;
        }
        case S.LissajX: {
          const xt = (s.X + ((PhaseTable[s.ByteA] * s.Heat) >> 8)) & 255;
          D[(xt & U) + (s.Y << UB)] = LightPhaseTable[(s.ByteA + 64) & 255];
          s.ByteA = (s.ByteA + s.ByteC) & 255; break;
        }
        case S.LissajY: {
          const yt = (s.Y + ((PhaseTable[s.ByteB] * s.Heat) >> 8)) & 255;
          D[s.X + ((yt & V) << UB)] = LightPhaseTable[(s.ByteB + 64) & 255];
          s.ByteB = (s.ByteB + s.ByteD) & 255; break;
        }
        case S.Blaze:
          if (this.sparks.length < this.limit && 128 > SpeedRand()) {
            const n = this.spawn();
            Object.assign(n, { Type: S.Drifter, Heat: s.Heat, X: s.X, Y: s.Y, ByteA: SpeedRand(), ByteB: SpeedRand(), ByteC: s.ByteC, ByteD: s.ByteD });
          }
          break;
        case S.OzHasSpoken:
          if (this.sparks.length < this.limit && 128 > SpeedRand()) {
            const n = this.spawn();
            Object.assign(n, { Type: S.DriftSlow, Heat: s.Heat, X: s.X, Y: s.Y, ByteA: ((SpeedRand() & 127) - 63) & 255, ByteB: (-127) & 255, ByteD: 2 });
          }
          break;
        case S.Cone:
          if (this.sparks.length < this.limit && 64 > SpeedRand()) {
            const n = this.spawn();
            Object.assign(n, { Type: S.Faller, Heat: s.Heat, X: s.X, Y: s.Y, ByteA: ((SpeedRand() & 127) - 63) & 255, ByteB: 0, ByteC: 50 });
          }
          break;
        case S.BlazeRight: case S.BlazeLeft:
          if (this.sparks.length < this.limit && 64 > SpeedRand()) {
            const n = this.spawn();
            const a = s.Type === S.BlazeRight ? (SpeedRand() & 63) + 63 : (SpeedRand() & 63) - 128;
            Object.assign(n, { Type: S.Faller, Heat: s.Heat, X: s.X, Y: s.Y, ByteA: a & 255, ByteB: (-29) & 255, ByteC: s.ByteC });
          }
          break;
        case S.Emit: case S.Fountain:
          if (this.sparks.length < this.limit && 64 > SpeedRand()) {
            const n = this.spawn();
            Object.assign(n, { Type: s.Type === S.Emit ? S.DriftSlow : S.Graviton, Heat: s.Heat, X: s.X, Y: s.Y, ByteA: s.ByteA, ByteB: s.ByteB, ByteD: s.ByteD });
          }
          break;
        case S.Organic:
          if (this.sparks.length < this.limit && 128 > SpeedRand()) {
            const n = this.spawn();
            n.Type = S.VShooter;
            n.X = U & (s.X + ((SpeedRand() * s.ByteC) >> 8));
            n.Y = V & (s.Y + ((SpeedRand() * s.ByteC) >> 8));
            n.ByteA = (SpeedRand() - 127) & 255; n.ByteB = 129; n.ByteC = 255;
          }
          break;
        case S.WanderOrganic:
          if (this.sparks.length < this.limit) {
            const n = this.spawn();
            n.Type = S.VShooter; n.X = U & (s.X + (SpeedRand() & 31)); n.Y = V & (s.Y + (SpeedRand() & 31));
            n.ByteA = (SpeedRand() - 127) & 255; n.ByteB = 129; n.ByteC = 255;
          }
          this.wander(s); break;
        case S.RandomCloud:
          if (this.sparks.length < this.limit) {
            const n = this.spawn();
            n.Type = S.Drop; n.X = U & (s.X + (SpeedRand() & 31)); n.Y = V & (s.Y + (SpeedRand() & 31));
            n.ByteA = ((SpeedRand() & 31) - 15) & 255; n.ByteB = 129; n.ByteC = 0;
          }
          this.wander(s); break;
        case S.Eels:
          if (SpeedRand() < 20 && this.sparks.length < this.limit) {
            const n = this.spawn();
            n.Heat = s.Heat; n.Type = S.SpawnedEel; n.X = U & (s.X + (SpeedRand() & 31)); n.Y = V & (s.Y + (SpeedRand() & 31));
            n.ByteA = SpeedRand(); n.ByteB = SpeedRand(); n.ByteC = s.ByteC;
          }
          this.wander(s); break;
        case S.Gametes:
          if (SpeedRand() < 20 && this.sparks.length < this.limit) {
            const n = this.spawn();
            n.Type = S.SpawnedSperm; n.Heat = s.Heat; n.X = U & (s.X + (SpeedRand() & 31)); n.Y = V & (s.Y + (SpeedRand() & 31));
            n.ByteA = SpeedRand(); n.ByteC = s.ByteC; n.ByteD = SpeedRand();
          }
          this.wander(s); break;
        case S.CustomCloud:
          if (this.sparks.length < this.limit) {
            const n = this.spawn();
            n.Type = S.Move; n.X = U & (s.X + (SpeedRand() & 31)); n.Y = V & (s.Y + (SpeedRand() & 31));
            n.ByteA = s.ByteA; n.ByteB = s.ByteB; n.ByteC = s.ByteD;
          }
          s.X = U & (s.X + (SpeedRand() & 7) - (SpeedRand() & 7));
          s.Y = V & (s.Y + (SpeedRand() & 7) - (SpeedRand() & 7));
          break;
        case S.LocalCloud:
          if (this.sparks.length < this.limit) {
            const n = this.spawn();
            n.Type = S.Move; n.X = U & (s.X + ((SpeedRand() * s.ByteC) >> 8)); n.Y = V & (s.Y + ((SpeedRand() * s.ByteC) >> 8));
            n.ByteA = s.ByteA; n.ByteB = s.ByteB; n.ByteC = s.ByteD;
          }
          break;
        case S.Flocks:
          if (this.sparks.length < this.limit) {
            const n = this.spawn();
            n.Type = S.SpawnedTwirl; n.X = U & (s.X + (SpeedRand() & 31)); n.Y = V & (s.Y + (SpeedRand() & 31));
            n.ByteB = s.ByteA; n.ByteA = 0; n.ByteC = s.ByteB; n.ByteD = s.ByteD; n.Heat = s.Heat;
            s.ByteA = (s.ByteA + s.ByteC) & 255;
          }
          s.X = U & (s.X + (SpeedRand() & 7) - (SpeedRand() & 7));
          s.Y = V & (s.Y + (SpeedRand() & 7) - (SpeedRand() & 7));
          break;
        case S.Wheel:
          if (this.sparks.length < this.limit) {
            const n = this.spawn();
            n.Type = S.SpawnedTwirl; n.X = s.X; n.Y = s.Y; n.ByteB = s.ByteA; n.ByteA = 0; n.ByteC = s.ByteB; n.ByteD = s.ByteD; n.Heat = s.Heat;
          }
          s.ByteA = (s.ByteA + s.ByteC) & 255; break;
        case S.Sprinkler:
          if (this.sparks.length < this.limit) {
            const n = this.spawn();
            Object.assign(n, { Type: S.SprinklerTwirl, X: s.X, Y: s.Y, Heat: s.Heat, ByteA: s.ByteA, ByteB: s.ByteB, ByteC: s.ByteC, ByteD: 2 });
          }
          s.ByteA = (s.ByteA + s.ByteD) & 255; break;
        case S.Stars: D[at(s)] = s.ByteB; break; // restore the sky before the update
        case S.LineLightning: case S.RampLightning:
          if (s.Heat === 0) break;
          if (s.ByteC > 0) {
            s.ByteC--;
            this.drawFlashRamp(s.X, s.Y, s.ByteA, s.ByteB, s.Heat, s.Type === S.LineLightning ? s.Heat : s.Heat >> 3);
          } else if (SpeedRand() >= s.ByteD) s.ByteC = (1 + SpeedRand()) & 5;
          break;
        case S.SphereLightning:
          if (SpeedRand() >= s.ByteD) {
            const ang = SpeedRand(), R = s.ByteC;
            const dx = (R * PhaseTable[ang]) >> 8, dy = (R * PhaseTable[(ang + 64) & 255]) >> 8;
            let xl = dx - Math.trunc(R / 2), yl = dy - Math.trunc(R / 2);
            xl = xl <= 0 ? (-xl) | 1 : xl & ~1;
            yl = yl <= 0 ? (-yl) | 1 : yl & ~1;
            this.drawFlashRamp(s.X, s.Y, xl & 255, yl & 255, s.Heat, s.Heat >> 2);
          }
          break;
        // transients
        case S.Drifter:
          s.Heat = (s.Heat - 5) & 255;
          if (s.Heat < 251) { D[at(s)] = s.Heat; this.move(s); } else this.remove(i);
          break;
        case S.DriftSlow:
          s.Heat = (s.Heat - s.ByteD) & 255;
          if (s.Heat > s.ByteD) { D[at(s)] = s.Heat; this.move(s); } else this.remove(i);
          break;
        case S.Custom:
          s.Heat = (s.Heat - s.ByteC) & 255;
          if (s.Heat < 250) { D[at(s)] = s.Heat; this.move(s); } else this.remove(i);
          break;
        case S.Faller:
          s.ByteC = (s.ByteC - 1) & 255;
          if (s.ByteC > 0) { D[at(s)] = s.Heat; this.move(s); if (sb(s.ByteB) < 122) s.ByteB = (s.ByteB + 3) & 255; } else this.remove(i);
          break;
        case S.Graviton:
          s.Heat = (s.Heat - s.ByteD) & 255;
          if (s.Heat > 50) {
            D[at(s)] = s.Heat; this.move(s);
            if ((this.GlobalPhase & 1) && sb(s.ByteB) < 124) s.ByteB = (s.ByteB + 3) & 255;
          } else this.remove(i);
          break;
        case S.VShooter:
          s.ByteC = (s.ByteC - 3) & 255;
          if (s.ByteC > 190) { D[at(s)] = s.ByteC; this.moveTwo(s); } else this.remove(i);
          break;
        case S.Drop:
          s.ByteC = (s.ByteC + 4) & 255;
          if (s.ByteC < 250) { D[at(s)] = s.ByteC; this.moveTwo(s); } else this.remove(i);
          break;
        case S.Move:
          s.ByteC = (s.ByteC + 4) & 255;
          if (s.ByteC < 250) { D[at(s)] = s.ByteC; this.move(s); } else this.remove(i);
          break;
        case S.SpawnedEel:
          s.ByteC = (s.ByteC - 1) & 255;
          if (s.ByteC < 255) { D[at(s)] = s.Heat; this.move(s); } else this.remove(i);
          break;
        case S.SpawnedSperm:
          s.ByteC = (s.ByteC - 1) & 255;
          if (s.ByteC < 255) {
            D[at(s)] = s.Heat;
            s.ByteA = (s.ByteA + 7) & 255;
            let saw = 127 & s.ByteA;
            if (saw > 63) saw = 127 - saw;
            this.moveAngle(s, (saw + s.ByteD) & 255);
          } else this.remove(i);
          break;
        case S.SpawnedTwirl:
          s.ByteC = (s.ByteC - 1) & 255;
          if (s.ByteC < 255) {
            D[at(s)] = s.Heat;
            const tx = SignedPhaseTable[(s.ByteB + 64) & 255], ty = SignedPhaseTable[s.ByteB];
            const w = ((s.ByteA | (s.ByteB << 8)) + (s.ByteD << 4)) & 0xffff;
            s.ByteA = w & 255; s.ByteB = w >> 8;
            this.moveXY(s, tx, ty);
          } else this.remove(i);
          break;
        case S.SprinklerTwirl:
          s.ByteC = (s.ByteC - 1) & 255;
          if (s.ByteC < 255) {
            D[at(s)] = s.Heat;
            const tx = (-128 + sb(PhaseTable[(s.ByteA + 64) & 255])) & 255, ty = s.ByteB;
            s.ByteA = (s.ByteA + s.ByteD) & 255;
            this.moveXY(s, tx, ty);
          } else this.remove(i);
          break;
      }
    }
  }

  postDrawSparks() {
    if (this.StarStatus === 0) return;
    let found = false;
    for (const s of this.sparks) {
      if (s.Type !== S.Stars) continue;
      found = true;
      const d = s.X + (s.Y << this.UBits), dim = this.data[d];
      s.ByteB = dim;
      if (dim < 38) this.data[d] = s.ByteA;
    }
    if (!found) this.StarStatus = 0;
  }
}

// ---------------------------------------------------------------- WaterTexture family
const WaveTable = new Uint8Array(1536);
for (let t = 0; t < 1536; t++) WaveTable[t] = Math.min(255, Math.max(0, (Math.trunc(t / 2) - 256) + ((t - 512) < 256 ? 1 : 0)));

class WaterSimBase extends Fractal {
  constructor(w, h, props, palette) {
    super(w, h, props, palette);
    this.fields = new Uint8Array(w * h / 2).fill(128);
    this.parity = 0;
    this.table = new Uint8Array(1028);
    this.drops = [];
    const n = props.NumDrops | 0, src = props.Drops || [];
    for (let i = 0; i < n; i++) {
      let d = src[i] || {};
      if (d._raw) { const b = d._raw; d = { Type: b[0], Depth: b[1], X: b[2], Y: b[3], ByteA: b[4], ByteB: b[5], ByteC: b[6], ByteD: b[7] }; }
      this.drops.push({ Type: d.Type | 0, Depth: d.Depth | 0, X: d.X | 0, Y: d.Y | 0, ByteA: d.ByteA | 0, ByteB: d.ByteB | 0, ByteC: d.ByteC | 0, ByteD: d.ByteD | 0 });
    }
  }
  // WaterRedrawDrops: the drops drive both wave fields
  redrawDrops() {
    const U2 = this.UMask >> 1, V2 = this.VMask >> 1, UB = this.UBits, XS = this.w / 2, F = this.fields;
    const set = (i, a, b = a) => { F[i] = a & 255; F[i + XS] = b & 255; };
    this.GlobalPhase++;
    for (const d of this.drops) {
      const X = d.X, Y = d.Y, dest = (Y << UB) + X;
      switch (d.Type) {
        case 0: set(dest, d.ByteD); break; // FixedDepth
        case 1: d.Depth = (d.Depth + d.ByteD) & 255; set(dest, PhaseTable[d.Depth]); break; // PhaseSpot
        case 3: { d.Depth = (d.Depth + d.ByteD) & 255; set(dest, Math.max(128, PhaseTable[d.Depth])); break; } // HalfAmpl
        case 2: d.Depth = (d.Depth + d.ByteD) & 255; set(dest, 64 + (PhaseTable[d.Depth] >> 1)); break; // ShallowSpot
        case 4: // RandomMover
          d.X = U2 & (X - (SpeedRand() & 3) + (SpeedRand() & 3));
          d.Y = V2 & (Y - (SpeedRand() & 3) + (SpeedRand() & 3));
          set(dest, 128 + 57, 128 - 57); break;
        case 5: set(dest, SpeedRand(), SpeedRand()); break; // FixedRandomSpot
        case 6: case 64: case 7: case 65: { // WhirlyThing / back, BigWhirly / back
          let ph;
          if (d.Type === 7) ph = ((d.ByteA | (d.ByteB << 8)) + (d.ByteC | (d.ByteD << 8))) & 0xffff;
          else ph = ((d.ByteB << 8) + d.ByteA + (d.Type === 6 ? 1 : -1) * ((d.ByteD << 8) + d.ByteC)) & 0xffff;
          d.ByteA = ph & 255; d.ByteB = ph >> 8;
          const sh = d.Type === 6 || d.Type === 64 ? 4 : 3;
          const ax = U2 & (X + (PhaseTable[d.ByteB] >> sh)), ay = (V2 & (Y + (PhaseTable[(d.ByteB + 64) & 255] >> sh))) << UB;
          set(ax + ay, d.Depth); break;
        }
        case 8: case 12: { // HorizontalLine / Osc
          let depth = d.Depth;
          if (d.Type === 12) { d.Depth = (d.Depth + d.ByteC) & 255; depth = PhaseTable[d.Depth]; }
          const seg = d.ByteD >> 1, row = Y << UB;
          for (let t = 0; t <= seg; t++) set(row + ((t + X) & U2), depth);
          break;
        }
        case 9: case 13: case 10: case 14: case 11: case 15: { // Vertical / Diagonal lines and oscillators
          let depth = d.Depth;
          if (d.Type >= 12) { d.Depth = (d.Depth + d.ByteC) & 255; depth = PhaseTable[d.Depth]; }
          const seg = d.ByteD >> 1, dx = d.Type === 9 || d.Type === 13 ? 0 : d.Type === 10 || d.Type === 14 ? -1 : 1;
          for (let t = 0; t <= seg; t++) set((((Y + t) & V2) << UB) + (dx ? ((X + dx * t) & U2) : X), depth);
          break;
        }
        case 17: { // AreaClamp
          const seg = d.ByteD >> 1;
          for (let v = 0; v < seg; v++) {
            const dy = ((Y + v) & V2) << UB;
            let dst = dy + (X & U2);
            for (let u = 1; u <= seg; u++) { set(dst, d.Depth); dst = dy + ((u + X) & U2); }
          }
          break;
        }
        case 16: // RainDrops
          if ((SpeedRand() & 15) === 0) {
            const spray = d.ByteD;
            const ay = ((Y + ((SpeedRand() * spray) >> 8)) & V2) << UB, ax = (X + ((SpeedRand() * spray) >> 8)) & U2;
            set(ay + ax, d.Depth, 255 ^ d.Depth);
          }
          break;
        case 18: // LeakyTap
          d.ByteA = (d.ByteA + d.ByteD) & 255;
          if (d.ByteA <= d.ByteD) set(dest, d.Depth, 255 ^ d.Depth);
          break;
        case 19: // DrippyTap
          d.ByteA = (d.ByteA + d.ByteD) & 255;
          if (d.ByteA <= d.ByteD) { d.ByteA = SpeedRand(); set(dest, d.Depth, 255 ^ d.Depth); }
          break;
      }
    }
  }
  // CalculateWater: one of the two interleaved fields steps (new = WaveTable[sum of its 4 diagonal neighbours
  // in the other field - 2 x old]) and the four pixels around each cell get RenderTable[slopes]
  calculateWater() {
    const X = this.w / 2, Y = this.h / 2, F = this.fields, B = this.data, W = this.w, H = this.h, R = this.table;
    this.parity = (this.parity + 1) & 255;
    const even = (this.parity & 1) === 0;
    const a = (y, x) => F[((y + Y) % Y) * 2 * X + ((x + X) % X)];
    const b = (y, x) => F[((y + Y) % Y) * 2 * X + X + ((x + X) % X)];
    const px = (x, y) => ((y + H) % H) * W + ((x + W) % W);
    for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) {
      let A, C, E, G, Bq, D, Fq, Hq, cell, p1, p2, p3, p4;
      if (even) {
        A = b(y - 1, x - 3); C = b(y - 1, x - 2); E = b(y - 1, x - 1); G = b(y - 1, x);
        Bq = b(y, x - 3); D = b(y, x - 2); Fq = b(y, x - 1); Hq = b(y, x);
        cell = y * 2 * X + x;
        p1 = px(2 * x - 1, 2 * y - 1); p2 = px(2 * x, 2 * y - 1); p3 = px(2 * x - 1, 2 * y); p4 = px(2 * x, 2 * y);
      } else {
        A = a(y, x - 2); C = a(y, x - 1); E = a(y, x); G = a(y, x + 1);
        Bq = a(y + 1, x - 2); D = a(y + 1, x - 1); Fq = a(y + 1, x); Hq = a(y + 1, x + 1);
        cell = y * 2 * X + X + x;
        p1 = px(2 * x, 2 * y); p2 = px(2 * x + 1, 2 * y); p3 = px(2 * x, 2 * y + 1); p4 = px(2 * x + 1, 2 * y + 1);
      }
      F[cell] = WaveTable[512 + (E + G + Fq + Hq) - (F[cell] << 1)];
      const EA = E - A, FB = Fq - Bq, GC = G - C, HD = Hq - D;
      B[p2] = R[512 + GC + HD];
      B[p3] = R[512 + FB + HD];
      B[p1] = R[512 + Math.trunc((FB + HD + EA + GC) / 2)];
      B[p4] = R[512 + HD + HD];
    }
  }
}

// WaveTexture: the water lit through SetWaveLight's table
export class WaveSim extends WaterSimBase {
  constructor(w, h, props, palette) {
    super(w, h, props, palette);
    const amp = props.WaveAmp ?? 128, lamp = Math.PI * (props.BumpMapLight ?? 50) / 255, viewer = Math.PI * (props.BumpMapAngle ?? 170) / 255;
    const range = props.PhongRange ?? 180, size = props.PhongSize ?? 32;
    const fakeAtan = x => 3.1415 * 0.5 * x / (Math.abs(x) + 1);
    for (let i = 0; i < 1024; i++) {
      const normal = fakeAtan((amp / 255) * (512 - i) / 196) + Math.PI * 0.5;
      let light = Math.trunc((256 - Math.trunc(range / 2)) * Math.cos(normal - lamp));
      const pr = size / 512, refl = normal * 2 - lamp;
      if ((refl - viewer) ** 2 < pr * pr) light += Math.trunc((range * 2) * (pr - Math.abs(refl - viewer)) / pr);
      this.table[i] = Math.min(255, Math.max(0, light));
    }
  }
  constantTimeTick() { if (this.w >= 8 && this.h >= 8) { this.redrawDrops(); this.calculateWater(); } }
  step(dt) { if (this.tick(dt)) { this.colorize(); return true; } return false; }
}

// WetTexture: the water as signed horizontal displacement into the source texture's texels
export class WetSim extends WaterSimBase {
  constructor(w, h, props, source) {
    super(w, h, props, source?.palette || null);
    this.source = source; // { data (indices), w, h, palette, sim? }
    const amp = props.WaveAmp ?? 128;
    for (let i = 0; i < 1024; i++) this.table[i] = Math.min(127, Math.max(-128, Math.trunc((i - 511) * (amp / 512)))) & 255;
    this.local = null;
    if (source && (source.w !== w || source.h !== h)) {
      const us = log2(w) - log2(source.w), vs = log2(h) - log2(source.h);
      if (us >= 0 && vs >= 0) {
        this.local = new Uint8Array(w * h);
        for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) this.local[u + v * w] = source.data[(u >> us) + ((v >> vs) << log2(source.w))];
      } else this.source = null;
    }
  }
  constantTimeTick() {
    if (!this.source || this.w < 8 || this.h < 8) return;
    this.redrawDrops(); this.calculateWater();
    const src = this.local || this.source.data, D = this.data, U = this.UMask;
    for (let v = 0; v < this.h; v++) {
      const row = v << this.UBits;
      for (let u = 0; u < this.w; u++) D[row + u] = src[row + ((u + D[row + u]) & U)];
    }
  }
  step(dt) { if (this.tick(dt)) { this.colorize(); return true; } return false; }
}

// ---------------------------------------------------------------- IceTexture
export class IceSim extends Fractal {
  constructor(w, h, props, source, glass) {
    super(w, h, props, source?.palette || null);
    this.source = source; this.glass = glass;
    this.MasterCount = props.MasterCount ?? 0; this.UDisplace = props.UDisplace ?? 0; this.VDisplace = props.VDisplace ?? 0;
    this.UPosition = props.UPosition ?? 0; this.VPosition = props.VPosition ?? 0;
    this.oldU = -1; this.oldV = -1; this.force = true; this.static = false;
    if (source && (w < 8 || h < 8)) this.source = this.glass = null;
    else if (source) {
      const badSrc = source.w !== w || source.h !== h;
      if (glass && (glass.w !== w || glass.h !== h)) this.glass = null;
      if (badSrc || !this.glass) {
        // a static (upsampled) copy of the source, no animation
        const us = log2(w) - log2(source.w), vs = log2(h) - log2(source.h);
        if (us >= 0 && vs >= 0) {
          for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) this.data[u + v * w] = source.data[(u >> us) + ((v >> vs) << log2(source.w))];
          this.static = true;
        } else this.source = null;
      }
    }
  }
  movePosition(dt) {
    const p = this.props, amp = (p.Amplitude ?? 44) + 1, fr = (p.Frequency ?? 11) + 1;
    this.MasterCount += dt * 120;
    this.UDisplace += 2 * dt * -sb((p.HorizPanSpeed ?? 128) - 128);
    this.VDisplace += 2 * dt * sb((p.VertPanSpeed ?? 128) - 128);
    const mc = this.MasterCount;
    switch (p.PanningStyle | 0) {
      case 0: this.UPosition = this.UDisplace; this.VPosition = this.VDisplace; break;
      case 1: this.UPosition = this.UDisplace + Math.round(amp * Math.sin(mc * fr * 0.0012)); this.VPosition = this.VDisplace + Math.round(amp * Math.cos(mc * fr * 0.0012)); break;
      case 2: this.UPosition = this.UDisplace + Math.round(amp * Math.sin(mc * fr * 0.0012)); this.VPosition = this.VDisplace + Math.round(amp * Math.cos(mc * fr * 0.0011)); break;
      case 3: this.UPosition = this.UDisplace + Math.round(0.5 * amp * Math.sin(mc * fr * 0.0012)); this.VPosition = this.VDisplace; break;
      case 4: this.UPosition = this.UDisplace; this.VPosition = this.VDisplace + Math.round(0.5 * amp * Math.cos(mc * fr * 0.0012)); break;
    }
  }
  render(dt) {
    if (!this.glass || !this.source || this.static) return;
    this.movePosition(dt);
    const ru = Math.round(this.UPosition), rv = Math.round(this.VPosition);
    if (ru === this.oldU && rv === this.oldV && !this.force) return;
    this.oldU = ru; this.oldV = rv;
    const U = this.UMask, V = this.VMask, UB = this.UBits, ud = ru & U, vd = rv & V;
    const T = this.source.data, G = this.glass.data, D = this.data;
    for (let v = 0; v < this.h; v++) {
      const line = v << UB;
      if (this.props.MoveIce === false) { // BlitIceTex: the source slides under fixed glass
        const tex = ((v + vd) & V) << UB;
        for (let u = 0; u < this.w; u++) D[line + u] = T[tex + ((u + ud + G[line + u]) & U)];
      } else { // BlitTexIce: the glass slides over the fixed source
        const gl = ((v + vd) & V) << UB;
        for (let u = 0; u < this.w; u++) D[line + u] = T[line + ((u + G[gl + ((u + ud) & U)]) & U)];
      }
    }
    this.force = false;
  }
  constantTimeTick() { this.render(1 / 120); }
  // UIceTexture::Tick: frame-synced (TimeMethod 0) goes through UTexture::Tick; real-time scrolls by dt
  step(dt) {
    if ((this.props.TimeMethod | 0) === 0) { if (!this.tick(dt)) return false; }
    else { while (this.primeCurrent < this.primeCount) { this.primeCurrent++; this.constantTimeTick(); } this.render(dt); }
    this.colorize();
    return true;
  }
}
