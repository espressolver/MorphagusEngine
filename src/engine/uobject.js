// UE1 tagged property parsing + common object decoders.
import { Reader } from './upackage.js';

const SIZES = [1, 2, 4, 12, 16];

function readStruct(r, structName, size) {
  const p = r.pkg;
  const start = r.pos;
  let v;
  switch (structName) {
    case 'Vector': v = { x: r.f32(), y: r.f32(), z: r.f32() }; break;
    case 'Rotator': v = { pitch: r.i32(), yaw: r.i32(), roll: r.i32() }; break;
    case 'Color': v = { r: r.u8_(), g: r.u8_(), b: r.u8_(), a: r.u8_() }; break;
    case 'Plane': v = { x: r.f32(), y: r.f32(), z: r.f32(), w: r.f32() }; break;
    case 'Scale': v = { x: r.f32(), y: r.f32(), z: r.f32(), sheerRate: r.f32(), sheerAxis: r.u8_() }; break;
    case 'PointRegion': v = { zone: p.refPath(r.idx()), zoneRef: 0, leaf: r.i32(), zoneNumber: r.u8_() }; break;
    default: v = { _raw: r.bytes(size).slice() };
  }
  r.pos = start + size;
  return v;
}

// Returns a plain object { propName: value } ; arrays (static) as propName: {0:..,1:..}
export function readProperties(r) {
  const p = r.pkg;
  const props = {};
  for (let guard = 0; guard < 10000; guard++) {
    const name = p.names[r.idx()];
    if (name === undefined || name === 'None') break;
    const info = r.u8_();
    const type = info & 0x0f;
    const sizeType = (info >> 4) & 7;
    const isArr = (info & 0x80) !== 0;
    let structName = null;
    if (type === 10) structName = p.names[r.idx()];
    let size;
    if (sizeType < 5) size = SIZES[sizeType];
    else if (sizeType === 5) size = r.u8_();
    else if (sizeType === 6) size = r.u16();
    else size = r.u32();
    let arrayIndex = 0;
    if (isArr && type !== 3) {
      const b = r.u8_();
      if ((b & 0x80) === 0) arrayIndex = b;
      else if ((b & 0xc0) === 0x80) arrayIndex = ((b & 0x7f) << 8) | r.u8_();
      else arrayIndex = ((b & 0x3f) << 24) | (r.u8_() << 16) | (r.u8_() << 8) | r.u8_();
    }
    const start = r.pos;
    let v;
    switch (type) {
      case 1: v = r.u8_(); break;
      case 2: v = r.i32(); break;
      case 3: v = isArr; break;
      case 4: v = r.f32(); break;
      case 5: case 8: {
        const ref = r.idx();
        v = ref === 0 ? null : { ref, path: p.refPath(ref), name: p.refName(ref), cls: refClass(p, ref) };
        if (v) Object.defineProperty(v, 'pkg', { value: p, enumerable: false });
        break;
      }
      case 6: v = p.names[r.idx()]; break;
      case 13: v = r.str(); break;
      case 10: v = readStruct(r, structName, size); break;
      case 11: v = { x: r.f32(), y: r.f32(), z: r.f32() }; break;
      case 12: v = { pitch: r.i32(), yaw: r.i32(), roll: r.i32() }; break;
      default: v = { _type: type, _raw: r.bytes(size).slice() };
    }
    r.pos = start + (type === 3 ? 0 : size);
    if (isArr && type !== 3) {
      if (typeof props[name] !== 'object' || props[name] === null || !props[name].__arr) props[name] = { __arr: true };
      props[name][arrayIndex] = v;
    } else props[name] = v;
  }
  return props;
}

function refClass(p, ref) {
  if (ref > 0) return p.exports[ref - 1].className;
  return p.imports[-ref - 1].className;
}

// ---- Palette ----
export function readPalette(pkg, exp) {
  const r = pkg.readerFor(exp);
  readProperties(r);
  const n = r.idx();
  const pal = new Uint8Array(n * 4);
  for (let i = 0; i < n * 4; i++) pal[i] = r.u8_();
  return pal;
}

// ---- Texture ----
// Formats: 0 P8, 1 RGBA7, 2 RGB16, 3 DXT1, 4 RGB8, 5 RGBA8
export function readTexture(pkg, exp) {
  const r = pkg.readerFor(exp);
  const props = readProperties(r);
  const mips = [];
  const readMips = () => {
    const n = r.idx();
    const out = [];
    for (let i = 0; i < n; i++) {
      if (pkg.version >= 63) r.i32(); // skip offset of lazy array
      const sz = r.idx();
      const data = r.bytes(sz);
      const u = r.i32(), v = r.i32();
      r.u8_(); r.u8_();
      out.push({ data, w: u, h: v });
    }
    return out;
  };
  mips.push(...readMips());
  return { props, mips, format: props.Format || 0 };
}

// Decode the first usable mip of a texture to RGBA8.
export function decodeTextureRGBA(tex, palette, mipIndex = 0) {
  const m = tex.mips[Math.min(mipIndex, tex.mips.length - 1)];
  if (!m) return null;
  const { w, h, data } = m;
  const out = new Uint8Array(w * h * 4);
  const masked = !!tex.props.bMasked;
  switch (tex.format) {
    case 0: {
      for (let i = 0; i < w * h; i++) {
        const c = data[i] * 4;
        out[i * 4] = palette ? palette[c] : data[i];
        out[i * 4 + 1] = palette ? palette[c + 1] : data[i];
        out[i * 4 + 2] = palette ? palette[c + 2] : data[i];
        // palette index 0 is the mask colour; only masked materials discard it
        out[i * 4 + 3] = data[i] === 0 ? 0 : 255;
      }
      break;
    }
    case 3: decodeDXT1(data, w, h, out, masked); break;
    case 5: {
      // BGRA in memory
      for (let i = 0; i < w * h; i++) {
        out[i * 4] = data[i * 4 + 2]; out[i * 4 + 1] = data[i * 4 + 1];
        out[i * 4 + 2] = data[i * 4]; out[i * 4 + 3] = data[i * 4 + 3];
      }
      break;
    }
    case 4: {
      for (let i = 0; i < w * h; i++) {
        out[i * 4] = data[i * 3 + 2]; out[i * 4 + 1] = data[i * 3 + 1];
        out[i * 4 + 2] = data[i * 3]; out[i * 4 + 3] = 255;
      }
      break;
    }
    default:
      out.fill(255);
  }
  return { w, h, data: out };
}

function c565(c, o, i) {
  o[i] = ((c >> 11) & 31) * 255 / 31 | 0;
  o[i + 1] = ((c >> 5) & 63) * 255 / 63 | 0;
  o[i + 2] = (c & 31) * 255 / 31 | 0;
}

export function decodeDXT1(src, w, h, out, masked) {
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
  const col = new Uint8Array(16);
  let p = 0;
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const c0 = src[p] | (src[p + 1] << 8), c1 = src[p + 2] | (src[p + 3] << 8);
    const bits = (src[p + 4] | (src[p + 5] << 8) | (src[p + 6] << 16) | (src[p + 7] << 24)) >>> 0;
    p += 8;
    c565(c0, col, 0); c565(c1, col, 4);
    col[3] = col[7] = col[11] = col[15] = 255;
    if (c0 > c1) {
      for (let k = 0; k < 3; k++) {
        col[8 + k] = (2 * col[k] + col[4 + k]) / 3 | 0;
        col[12 + k] = (col[k] + 2 * col[4 + k]) / 3 | 0;
      }
    } else {
      for (let k = 0; k < 3; k++) { col[8 + k] = (col[k] + col[4 + k]) >> 1; col[12 + k] = 0; }
      col[15] = 0;
    }
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const px = bx * 4 + x, py = by * 4 + y;
      if (px >= w || py >= h) continue;
      const ci = ((bits >>> (2 * (y * 4 + x))) & 3) * 4;
      const o = (py * w + px) * 4;
      out[o] = col[ci]; out[o + 1] = col[ci + 1]; out[o + 2] = col[ci + 2]; out[o + 3] = col[ci + 3];
    }
  }
}

// ---- Sound: raw embedded file (WAV) ----
export function readSound(pkg, exp) {
  const r = pkg.readerFor(exp);
  const props = readProperties(r);
  const format = pkg.names[r.idx()];
  if (pkg.version >= 63) r.i32();
  const size = r.idx();
  return { props, format, data: r.bytes(size) };
}

// ---- Music: embedded tracker module ----
export function readMusic(pkg, exp) {
  const r = pkg.readerFor(exp);
  const props = readProperties(r);
  const format = pkg.names[r.idx()];
  if (pkg.version >= 63) r.i32();
  const size = r.idx();
  return { props, format, data: r.bytes(size) };
}

// ---- TextBuffer: UnrealScript source ----
export function readTextBuffer(pkg, exp) {
  const r = pkg.readerFor(exp);
  readProperties(r);
  r.u32(); r.u32();
  return r.str();
}

export { Reader };
