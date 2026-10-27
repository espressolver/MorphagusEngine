// Unreal Engine 1 package reader (version 61-76, as used by Harry Potter 1).
// Works in both the browser and Node (only needs ArrayBuffer/DataView).

export class Reader {
  constructor(buffer, offset = 0) {
    this.buf = buffer instanceof ArrayBuffer ? buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    this.dv = new DataView(this.buf);
    this.u8 = new Uint8Array(this.buf);
    this.pos = offset;
  }
  seek(p) { this.pos = p; return this; }
  skip(n) { this.pos += n; }
  get eof() { return this.pos >= this.buf.byteLength; }
  u8_() { return this.u8[this.pos++]; }
  i8() { return this.dv.getInt8(this.pos++); }
  u16() { const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  i16() { const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
  u32() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  i32() { const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  bytes(n) { const v = this.u8.subarray(this.pos, this.pos + n); this.pos += n; return v; }
  // Compact index: variable-length signed int
  idx() {
    let b0 = this.u8[this.pos++];
    const neg = b0 & 0x80;
    let v = b0 & 0x3f;
    if (b0 & 0x40) {
      let shift = 6, b;
      do {
        b = this.u8[this.pos++];
        v |= (b & 0x7f) << shift;
        shift += 7;
      } while ((b & 0x80) && shift < 35);
    }
    return neg ? -v : v;
  }
  // Length-prefixed (compact index) null-terminated string
  str() {
    const len = this.idx();
    if (len <= 0) return '';
    const s = this.u8.subarray(this.pos, this.pos + len - 1);
    this.pos += len;
    let out = '';
    for (let i = 0; i < s.length; i++) out += String.fromCharCode(s[i]);
    return out;
  }
  vec() { return [this.f32(), this.f32(), this.f32()]; }
  rot() { return { pitch: this.i32(), yaw: this.i32(), roll: this.i32() }; }
}

// Poly flags as used by the HP (KnowWonder UE1) engine
export const PF = {
  Invisible: 0x1, Masked: 0x2, Translucent: 0x4, NotSolid: 0x8, Environment: 0x10, ForceViewZone: 0x10,
  Semisolid: 0x20, Modulated: 0x40, FakeBackdrop: 0x80, TwoSided: 0x100, AutoUPan: 0x200,
  AutoVPan: 0x400, NoSmooth: 0x800, SpecialPoly: 0x1000 /* HP: climbable (reuses BigWavy) */, SmallWavy: 0x2000,
  Flat: 0x4000, LowShadowDetail: 0x8000, NoMerge: 0x10000, CloudWavy: 0x20000, DirtyShadows: 0x40000,
  BrightCorners: 0x80000, SpecialLit: 0x100000, Gouraud: 0x200000, NoBoundRejection: 0x200000,
  Unlit: 0x400000, HighShadowDetail: 0x800000, Memorized: 0x1000000, Selected: 0x2000000,
  Portal: 0x4000000, Mirrored: 0x8000000, Highlighted: 0x10000000, FlatShaded: 0x40000000,
  EdProcessed: 0x40000000, EdCut: 0x80000000,
};

export class UPackage {
  constructor(name, buffer) {
    this.name = name;
    const r = this.r = new Reader(buffer);
    const tag = r.u32();
    if (tag !== 0x9e2a83c1) throw new Error(`${name}: not an Unreal package`);
    this.version = r.u16();
    this.licensee = r.u16();
    this.flags = r.u32();
    const nameCount = r.u32(), nameOffset = r.u32();
    const exportCount = r.u32(), exportOffset = r.u32();
    const importCount = r.u32(), importOffset = r.u32();

    r.seek(nameOffset);
    this.names = new Array(nameCount);
    for (let i = 0; i < nameCount; i++) {
      this.names[i] = this.version >= 64 ? r.str() : this._cstr();
      r.u32(); // flags
    }
    r.seek(importOffset);
    this.imports = new Array(importCount);
    for (let i = 0; i < importCount; i++) {
      this.imports[i] = {
        classPackage: this.names[r.idx()],
        className: this.names[r.idx()],
        package: r.i32(),
        name: this.names[r.idx()],
      };
    }
    r.seek(exportOffset);
    this.exports = new Array(exportCount);
    for (let i = 0; i < exportCount; i++) {
      const e = {
        index: i,
        classIndex: r.idx(),
        superIndex: r.idx(),
        package: r.i32(),
        name: this.names[r.idx()],
        flags: r.u32(),
        size: r.idx(),
        offset: 0,
      };
      if (e.size > 0) e.offset = r.idx();
      this.exports[i] = e;
    }
    for (const e of this.exports) e.className = this.className(e.classIndex);
    this.objCache = new Map();
  }
  _cstr() {
    const r = this.r; let s = '';
    for (let c; (c = r.u8_()) !== 0;) s += String.fromCharCode(c);
    return s;
  }
  // Resolve object reference (1-based exports, negative imports)
  refName(ref) {
    if (ref > 0) return this.exports[ref - 1].name;
    if (ref < 0) return this.imports[-ref - 1].name;
    return null;
  }
  className(ref) {
    if (ref === 0) return 'Class';
    if (ref > 0) return this.exports[ref - 1].name;
    return this.imports[-ref - 1].name;
  }
  // Full path of a reference: "Package.Group.Name"
  refPath(ref) {
    if (ref === 0) return null;
    const parts = [];
    let cur = ref;
    while (cur !== 0) {
      if (cur > 0) { const e = this.exports[cur - 1]; parts.unshift(e.name); cur = e.package; }
      else { const im = this.imports[-cur - 1]; parts.unshift(im.name); cur = im.package; }
    }
    if (ref > 0) parts.unshift(this.name);
    return parts.join('.');
  }
  // Outermost package name of an import
  refPackage(ref) {
    if (ref >= 0) return this.name;
    let cur = ref, last = null;
    while (cur < 0) { last = this.imports[-cur - 1]; cur = last.package; }
    return last.name;
  }
  findExport(name, className) {
    const ln = name.toLowerCase();
    return this.exports.find(e => e.name.toLowerCase() === ln && (!className || e.className === className));
  }
  findExportPath(path, className) {
    // path like "Group.Name" or "Name"
    const parts = path.split('.').map(s => s.toLowerCase());
    return this.exports.find(e => {
      if (className && e.className !== className) return false;
      if (e.name.toLowerCase() !== parts[parts.length - 1]) return false;
      return true;
    });
  }
  // Reader positioned at the start of an export's data (after the optional state frame)
  readerFor(exp) {
    const r = new Reader(this.r.buf, exp.offset);
    r.end = exp.offset + exp.size;
    r.pkg = this;
    if (exp.flags & 0x02000000) { // RF_HasStack
      const node = r.idx(); r.idx(); r.u32(); r.u32(); r.u32(); // Node, StateNode, ProbeMask(QWORD), LatentAction
      if (node !== 0) r.idx();
    }
    return r;
  }
}
