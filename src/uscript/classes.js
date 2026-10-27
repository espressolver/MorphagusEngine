// Runtime type system for the UnrealScript VM.
import { Reader } from '../engine/upackage.js';
import { loadScriptObject, FUNC, CPF, EX } from './loader.js';

export class PropInfo {
  constructor(o, owner) {
    this.name = o.name;
    this.key = o.name;            // storage key on objects (differs for shadowed properties)
    this.kind = o.kind;           // 'IntProperty' etc.
    this.arrayDim = o.arrayDim || 1;
    this.flags = o.propFlags || 0;
    this.raw = o;
    this.owner = owner;
    this.isParm = !!(this.flags & CPF.Parm);
    this.isOut = !!(this.flags & CPF.OutParm);
    this.isReturn = !!(this.flags & CPF.ReturnParm);
    this.isOptional = !!(this.flags & CPF.OptionalParm);
    this.isSkip = !!(this.flags & CPF.SkipParm);
    this.isCoerce = !!(this.flags & CPF.CoerceParm);
    this.enumNames = null;
    this.struct = null;          // StructInfo for StructProperty
    this.objClass = null;        // class name for object/class props
  }
}

export class StructInfo {
  constructor(name) { this.name = name; this.members = []; this.byName = new Map(); }
  zero() {
    const o = {};
    for (const m of this.members) o[m.name] = zeroOf(m);
    return o;
  }
}

export class FuncInfo {
  constructor(o, owner) {
    this.name = o.name;
    this.lname = o.name.toLowerCase();
    this.flags = o.flags;
    this.iNative = o.iNative;
    this.code = o.code;
    this.raw = o;
    this.owner = owner;  // ClassInfo or StateInfo
    this.params = [];
    this.locals = [];
    this.ret = null;
    this.superFunc = null;
    this.isNative = !!(o.flags & FUNC.Native);
    this.isLatent = !!(o.flags & FUNC.Latent);
    this.isStatic = !!(o.flags & FUNC.Static);
    this.isIterator = !!(o.flags & FUNC.Iterator);
    this.isSingular = !!(o.flags & FUNC.Singular);
    this.jumpMap = buildJumpMap(o.code);
  }
}

export class StateInfo {
  constructor(o, cls) {
    this.name = o.name;
    this.lname = o.name.toLowerCase();
    this.raw = o;
    this.cls = cls;
    this.funcs = new Map();
    this.code = o.code;
    this.jumpMap = buildJumpMap(o.code);
    this.labels = new Map();
    for (const s of o.code) if (s.op === EX.LabelTable) for (const l of s.labels) this.labels.set(l.name.toLowerCase(), l.off);
    this.superState = null;
    this.ignores = new Set();
  }
}

function buildJumpMap(code) {
  const m = new Map();
  if (code) code.forEach((s, i) => m.set(s.mem, i));
  return m;
}

export function zeroOf(p, ignoreDim = false) {
  if (!ignoreDim && p.arrayDim > 1) {
    const a = new Array(p.arrayDim);
    for (let i = 0; i < p.arrayDim; i++) a[i] = zeroOf(p, true);
    return a;
  }
  switch (p.kind) {
    case 'ByteProperty': case 'IntProperty': case 'FloatProperty': return 0;
    case 'BoolProperty': return false;
    case 'NameProperty': return 'None';
    case 'StrProperty': case 'StringProperty': return '';
    case 'ObjectProperty': case 'ClassProperty': return null;
    case 'StructProperty': return p.struct ? p.struct.zero() : {};
    case 'ArrayProperty': return [];
    default: return null;
  }
}

export function cloneVal(v) {
  if (v === null || typeof v !== 'object') return v;
  if (v.__isUObject || v.__isClass) return v;
  if (Array.isArray(v)) return v.map(cloneVal);
  const o = {};
  for (const k in v) o[k] = cloneVal(v[k]);
  return o;
}

export class ClassInfo {
  constructor(vm, pkg, exp) {
    this.vm = vm;
    this.__isClass = true;
    this.pkg = pkg;
    this.exp = exp;
    this.name = exp.name;
    this.lname = exp.name.toLowerCase();
    this.superClass = null;
    this.ownProps = [];
    this.props = [];          // all props incl. inherited
    this.propByName = new Map();
    this.funcs = new Map();   // own + inherited (lowercase name -> FuncInfo)
    this.states = new Map();  // own + inherited
    this.enums = new Map();
    this.consts = new Map();
    this.structs = new Map();
    this.defaults = null;     // default object
    this.raw = null;
    this.linked = false;
  }
  isChildOf(other) {
    for (let c = this; c; c = c.superClass) if (c === other) return true;
    return false;
  }
  isA(name) {
    const l = name.toLowerCase();
    for (let c = this; c; c = c.superClass) if (c.lname === l) return true;
    return false;
  }
  findFunction(lname) { return this.funcs.get(lname) || null; }
  findState(lname) { return this.states.get(lname) || null; }
  toString() { return this.name; }
}

// Loads and links classes on demand across packages
export class ClassTable {
  constructor(assets, vm) {
    this.assets = assets;
    this.vm = vm;
    this.classes = new Map();  // lname -> ClassInfo
    this.structs = new Map();  // "pkg.ref" cache
    this.packages = new Set();
    this.loadCache = new Map(); // "pkgname:index" -> loaded script object
  }

  async loadPackage(name) {
    const pkg = await this.assets.pkg(name);
    if (!pkg) return null;
    if (this.packages.has(pkg)) return pkg;
    this.packages.add(pkg);
    for (const e of pkg.exports) if (e.className === 'Class') {
      const l = e.name.toLowerCase();
      if (!this.classes.has(l)) this.classes.set(l, new ClassInfo(this.vm, pkg, e));
    }
    // ensure imported packages containing classes are loaded too
    for (const im of pkg.imports) if (im.package === 0 && im.className === 'Package') {
      if (this.assets.has(im.name)) {
        const p = await this.assets.pkg(im.name);
        if (p && p.exports.some(x => x.className === 'Class')) await this.loadPackage(im.name);
      }
    }
    return pkg;
  }

  get(name) {
    if (!name) return null;
    const c = this.classes.get(String(name).toLowerCase());
    if (c && !c.linked) this.link(c);
    return c || null;
  }

  obj(pkg, ref) {
    // Load the script object for a reference (export in its own package)
    let p = pkg, idx = ref;
    if (ref < 0) {
      const im = pkg.imports[-ref - 1];
      // find in the package where it's defined
      const outerChain = [];
      let cur = ref;
      while (cur < 0) { const i = pkg.imports[-cur - 1]; outerChain.unshift(i.name.toLowerCase()); cur = i.package; }
      const target = [...this.packages].find(x => x.name.toLowerCase() === outerChain[0]);
      if (!target) return null;
      const e = target.exports.find(x => {
        if (x.name.toLowerCase() !== outerChain[outerChain.length - 1] || x.className !== im.className) return false;
        // verify parent chain
        let c = x.package, i = outerChain.length - 2;
        while (i >= 1 && c > 0) { if (target.exports[c - 1].name.toLowerCase() !== outerChain[i]) return false; c = target.exports[c - 1].package; i--; }
        return true;
      });
      if (!e) return null;
      p = target; idx = e.index + 1;
    }
    const key = p.name + ':' + idx;
    let o = this.loadCache.get(key);
    if (!o) {
      o = loadScriptObject(p, p.exports[idx - 1]);
      this.loadCache.set(key, o);
    }
    return o;
  }

  // Walk a Children chain
  *children(pkg, first) {
    let ref = first;
    for (let g = 0; ref && g < 10000; g++) {
      const o = this.obj(pkg, ref);
      if (!o) break;
      yield o;
      ref = o.next;
      pkg = o.pkg;
    }
  }

  structInfo(pkg, ref) {
    const o = this.obj(pkg, ref);
    if (!o) return null;
    const key = o.pkg.name + '.' + o.name + '#' + o.exp.index;
    let s = this.structs.get(key);
    if (s) return s;
    s = new StructInfo(o.name);
    this.structs.set(key, s);
    if (o.superField) {
      const sup = this.structInfo(o.pkg, o.superField);
      if (sup) for (const m of sup.members) { s.members.push(m); s.byName.set(m.name.toLowerCase(), m); }
    }
    const own = [];
    for (const c of this.children(o.pkg, o.children)) if (c.kind.endsWith('Property')) { const pi = this.propInfo(c, s); c.__pinfo = pi; own.push(pi); }
    // children chain order matches declaration order
    for (const m of own) { s.members.push(m); s.byName.set(m.name.toLowerCase(), m); }
    return s;
  }

  propInfo(o, owner) {
    const p = new PropInfo(o, owner);
    if (o.kind === 'StructProperty') p.struct = this.structInfo(o.pkg, o.struct);
    if (o.kind === 'ByteProperty' && o.enum) {
      const e = this.obj(o.pkg, o.enum);
      if (e) p.enumNames = e.names;
    }
    if ((o.kind === 'ObjectProperty' || o.kind === 'ClassProperty') && o.propClass) p.objClass = o.pkg.refName(o.propClass);
    if (o.kind === 'ClassProperty' && o.metaClass) p.metaClass = o.pkg.refName(o.metaClass);
    if (o.kind === 'ArrayProperty' && o.inner) p.inner = this.propInfo(this.obj(o.pkg, o.inner), owner);
    return p;
  }

  funcInfo(o, owner) {
    const f = new FuncInfo(o, owner);
    for (const c of this.children(o.pkg, o.children)) {
      if (!c.kind.endsWith('Property')) continue;
      const p = this.propInfo(c, f);
      c.__pinfo = p;
      if (p.isReturn) f.ret = p;
      else if (p.isParm) f.params.push(p);
      else f.locals.push(p);
    }
    return f;
  }

  link(c) {
    if (c.linked) return;
    c.linked = true;
    const raw = this.obj(c.pkg, c.exp.index + 1);
    c.raw = raw;
    c.flags = raw.classFlags;
    c.configName = raw.configName;
    // super
    if (raw.superField) {
      const sname = c.pkg.refName(raw.superField);
      c.superClass = this.get(sname);
    }
    const sup = c.superClass;
    if (sup) {
      c.props = sup.props.slice();
      for (const [k, v] of sup.propByName) c.propByName.set(k, v);
      for (const [k, v] of sup.funcs) c.funcs.set(k, v);
      for (const [k, v] of sup.states) c.states.set(k, v);
      for (const [k, v] of sup.enums) c.enums.set(k, v);
      for (const [k, v] of sup.consts) c.consts.set(k, v);
    }
    const ownStates = [];
    for (const ch of this.children(c.pkg, raw.children)) {
      if (ch.kind.endsWith('Property')) {
        const p = this.propInfo(ch, c);
        // A subclass may redeclare a variable with the same name: UnrealScript keeps separate storage.
        if (sup && sup.propByName.has(p.name.toLowerCase())) p.key = p.name + '@' + c.name;
        ch.__pinfo = p;
        c.ownProps.push(p); c.props.push(p); c.propByName.set(p.name.toLowerCase(), p);
      } else if (ch.kind === 'Function') {
        const f = this.funcInfo(ch, c);
        f.superFunc = c.funcs.get(f.lname) || null;
        c.funcs.set(f.lname, f);
      } else if (ch.kind === 'State') {
        ownStates.push(ch);
      } else if (ch.kind === 'Enum') {
        c.enums.set(ch.name.toLowerCase(), ch.names);
      } else if (ch.kind === 'Const') {
        c.consts.set(ch.name.toLowerCase(), ch.value);
      }
    }
    for (const so of ownStates) {
      const st = new StateInfo(so, c);
      // inherit from same-named state in super class, or explicit "extends" state
      const parentSame = sup ? sup.states.get(st.lname) : null;
      let parent = parentSame;
      if (so.superField) {
        const sname = so.pkg.refName(so.superField).toLowerCase();
        parent = c.states.get(sname) || parent;
      }
      st.superState = parent;
      if (parent) for (const [k, v] of parent.funcs) st.funcs.set(k, v);
      if (parent && !st.code.length) { st.code = parent.code; st.jumpMap = parent.jumpMap; st.labels = parent.labels; }
      for (const ch of this.children(so.pkg, so.children)) {
        if (ch.kind === 'Function') {
          const f = this.funcInfo(ch, st);
          f.superFunc = st.funcs.get(f.lname) || c.funcs.get(f.lname) || null;
          st.funcs.set(f.lname, f);
        }
      }
      // ignores: functions in state probe mask aren't tracked by name in UE1 bytecode;
      // UE1 marks ignored functions as state functions with no code + ignore mask bits.
      c.states.set(st.lname, st);
    }
    // UE1: the auto state is the most-derived class's 'auto state' (a subclass's auto overrides its parent's)
    c.autoState = ownStates.map(so => c.states.get(so.name.toLowerCase())).find(st => st && (st.raw.stateFlags & 2)) || (sup ? sup.autoState : null) || null;
    this.buildDefaults(c);
  }

  buildDefaults(c) {
    const d = c.superClass ? cloneObject(c.superClass.defaults) : {};
    for (const p of c.ownProps) d[p.key] = zeroOf(p);
    // decode own default properties (typed)
    const raw = c.raw;
    if (raw.defaultsPos !== undefined) {
      const r = new Reader(c.pkg.r.buf, raw.defaultsPos);
      r.pkg = c.pkg;
      r.end = c.exp.offset + c.exp.size;
      readTypedProperties(this, r, c, d);
    }
    d.Class = c;
    d.Name = c.name;
    c.defaults = d;
  }
}

function cloneObject(src) {
  const o = {};
  for (const k in src) o[k] = cloneVal(src[k]);
  return o;
}

// ---------------------------------------------------------------------------
// Typed property decoding (defaults and level actor properties)

function readBinaryValue(table, r, p, pkg) {
  switch (p.kind) {
    case 'ByteProperty': return r.u8_();
    case 'IntProperty': return r.i32();
    case 'FloatProperty': return r.f32();
    case 'BoolProperty': return r.u8_() !== 0; // UBoolProperty::SerializeItem writes one byte
    case 'NameProperty': return pkg.names[r.idx()];
    case 'StrProperty': return r.str();
    case 'ObjectProperty': case 'ClassProperty': return table.vm.resolveObjectRef(pkg, r.idx(), p);
    case 'StructProperty': {
      const o = {};
      for (const m of p.struct?.members || []) {
        if (m.arrayDim > 1) { o[m.name] = []; for (let i = 0; i < m.arrayDim; i++) o[m.name].push(readBinaryValue(table, r, m, pkg)); }
        else o[m.name] = readBinaryValue(table, r, m, pkg);
      }
      return o;
    }
    case 'ArrayProperty': {
      const n = r.idx();
      const a = [];
      for (let i = 0; i < n; i++) a.push(readBinaryValue(table, r, p.inner, pkg));
      return a;
    }
    default: return null;
  }
}

export function readTypedProperties(table, r, cls, target) {
  const pkg = r.pkg;
  for (let guard = 0; guard < 10000; guard++) {
    const name = pkg.names[r.idx()];
    if (name === undefined || name === 'None') break;
    const info = r.u8_();
    const type = info & 0x0f;
    const sizeType = (info >> 4) & 7;
    const isArr = (info & 0x80) !== 0;
    if (type === 10) r.idx();
    let size;
    if (sizeType < 5) size = [1, 2, 4, 12, 16][sizeType];
    else if (sizeType === 5) size = r.u8_();
    else if (sizeType === 6) size = r.u16();
    else size = r.u32();
    let idx = 0;
    if (isArr && type !== 3) {
      const b = r.u8_();
      if ((b & 0x80) === 0) idx = b;
      else if ((b & 0xc0) === 0x80) idx = ((b & 0x7f) << 8) | r.u8_();
      else idx = ((b & 0x3f) << 24) | (r.u8_() << 16) | (r.u8_() << 8) | r.u8_();
    }
    const start = r.pos;
    const p = cls ? cls.propByName.get(name.toLowerCase()) : null;
    let v;
    if (type === 3) v = isArr;
    else if (p) {
      try { v = readBinaryValue(table, r, p, pkg); } catch (e) { v = undefined; }
      if (p.kind === 'ByteProperty' && type !== 1) v = undefined;
    }
    if (type !== 3) r.pos = start + size;
    if (!p || v === undefined) continue;
    const key = p.key;
    if (p.arrayDim > 1 && !(type === 3 && !isArr)) {
      if (!Array.isArray(target[key])) target[key] = zeroOf(p);
      target[key][type === 3 ? 0 : idx] = v;
    } else target[key] = v;
  }
}
