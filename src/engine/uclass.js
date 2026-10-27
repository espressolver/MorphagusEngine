// UClass default-properties extraction.
// The class tail (ClassFlags, GUID, Dependencies, PackageImports, Within, ConfigName, defaults)
// follows variable-length serialized bytecode, so we locate it by scanning for a start offset that
// parses validly and ends exactly at the export boundary.
import { Reader } from './upackage.js';
import { readProperties } from './uobject.js';

function tryTail(pkg, r, start, end) {
  r.pos = start;
  try {
    r.u32(); // ClassFlags
    r.skip(16); // GUID
    const nd = r.idx();
    if (nd < 1 || nd > 4096) return null;
    for (let i = 0; i < nd; i++) {
      const c = r.idx();
      if (c === 0 || c > pkg.exports.length || -c > pkg.imports.length) return null;
      if ((c > 0 ? pkg.exports[c - 1].className : pkg.imports[-c - 1].className) !== 'Class') return null;
      r.u32(); r.u32();
    }
    const ni = r.idx();
    if (ni < 0 || ni > 4096) return null;
    for (let i = 0; i < ni; i++) { const n = r.idx(); if (n < 0 || n >= pkg.names.length) return null; }
    const within = r.idx();
    if (within > pkg.exports.length || -within > pkg.imports.length) return null;
    if (within !== 0 && (within > 0 ? pkg.exports[within - 1].className : pkg.imports[-within - 1].className) !== 'Class') return null;
    const cfg = r.idx();
    if (cfg < 0 || cfg >= pkg.names.length) return null;
    if (r.pos > end) return null;
    const props = readPropertiesChecked(pkg, r, end);
    if (props && r.pos === end) return props;
  } catch (e) { /* invalid candidate */ }
  return null;
}

function readPropertiesChecked(pkg, r, end) {
  // Validate names before trusting the generic reader
  const save = r.pos;
  for (let guard = 0; guard < 4096; guard++) {
    if (r.pos >= end) return null;
    const ni = r.idx();
    if (ni < 0 || ni >= pkg.names.length) return null;
    if (pkg.names[ni] === 'None') break;
    const info = r.u8_();
    const type = info & 15;
    if (type === 0) return null;
    if (type === 10) { const sn = r.idx(); if (sn < 0 || sn >= pkg.names.length) return null; }
    const st = (info >> 4) & 7;
    let size = [1, 2, 4, 12, 16][st];
    if (st === 5) size = r.u8_(); else if (st === 6) size = r.u16(); else if (st === 7) size = r.u32();
    if ((info & 0x80) && type !== 3) {
      const b = r.u8_();
      if ((b & 0x80) && !(b & 0x40)) r.skip(1); else if (b & 0x80) r.skip(3);
    }
    if (type !== 3) r.pos += size;
    if (r.pos > end) return null;
  }
  r.pos = save;
  return readProperties(r);
}

export function readClassDefaults(pkg, exp) {
  const r = new Reader(pkg.r.buf, exp.offset);
  r.pkg = pkg;
  const end = exp.offset + exp.size;
  // Minimum tail is ~4+16+1+1+1+1+1 = 25 bytes; scan backwards
  // Dependencies always include the class itself, so a real tail has nd >= 1; keep the earliest valid start.
  let best = null;
  for (let p = end - 25; p >= exp.offset; p--) {
    const props = tryTail(pkg, r, p, end);
    if (props) best = props;
  }
  return best;
}

// Class registry across loaded packages: name -> { name, superName, pkg, exp, defaults }
export class ClassRegistry {
  constructor(assets) {
    this.assets = assets;
    this.classes = new Map();
  }
  async loadPackage(pkgName) {
    const pkg = await this.assets.pkg(pkgName);
    if (!pkg || pkg._classesLoaded) return pkg;
    pkg._classesLoaded = true;
    for (const e of pkg.exports) {
      if (e.className !== 'Class') continue;
      const key = e.name.toLowerCase();
      if (this.classes.has(key)) continue;
      const superName = e.superIndex ? pkg.refName(e.superIndex) : null;
      this.classes.set(key, { name: e.name, superName, pkg, exp: e, _defaults: undefined });
    }
    return pkg;
  }
  get(name) { return name ? this.classes.get(name.toLowerCase()) : null; }
  defaultsOf(name) {
    const c = this.get(name);
    if (!c) return {};
    if (c._defaults === undefined) c._defaults = readClassDefaults(c.pkg, c.exp) || {};
    return c._defaults;
  }
  // Merged defaults through the inheritance chain
  merged(name) {
    const c = this.get(name);
    if (!c) return {};
    if (c._merged) return c._merged;
    const base = c.superName ? this.merged(c.superName) : {};
    const own = this.defaultsOf(name);
    c._merged = mergeProps(base, own);
    return c._merged;
  }
  isA(name, ancestor) {
    const a = ancestor.toLowerCase();
    for (let c = this.get(name), g = 0; c && g < 64; c = this.get(c.superName), g++) if (c.name.toLowerCase() === a) return true;
    return false;
  }
  chain(name) {
    const out = [];
    for (let c = this.get(name), g = 0; c && g < 64; c = this.get(c.superName), g++) out.push(c.name);
    return out;
  }
}

export function mergeProps(base, own) {
  const out = { ...base };
  for (const k in own) {
    const v = own[k];
    if (v && v.__arr && out[k] && out[k].__arr) out[k] = { ...out[k], ...v };
    else out[k] = v;
  }
  return out;
}
