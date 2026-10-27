// UnrealScript bytecode virtual machine.
import { EX, FUNC } from './loader.js';
import { ClassTable, cloneVal, zeroOf, readTypedProperties } from './classes.js';

export class UObject {
  constructor(cls, name) {
    this.__isUObject = true;
    this.__id = UObject.nextId++;
    this.Class = cls;
    this.Name = name || cls.name + this.__id;
    this.__state = null;       // StateInfo
    this.__stateFrame = null;  // { state, pc } for state code
    this.__latent = null;
    this.__deleted = false;
  }
  toString() { return this.__path || this.Name; }
}
UObject.nextId = 0;

// Lightweight handle for non-script assets (textures, sounds, meshes, fonts...)
export class AssetRef {
  constructor(pkg, exp, path) {
    this.__isUObject = true;
    this.__asset = true;
    this.pkg = pkg; this.exp = exp;
    this.Name = exp ? exp.name : (path || '').split('.').pop();
    this.__className = exp ? exp.className : 'Object';
    this.__path = path || (exp ? pkg.name + '.' + exp.name : 'None');
    this.Class = null;
  }
  toString() { return this.__path; }
}

const LATENT = Symbol('latent');
export const STOP = Symbol('stop');

export class ScriptError extends Error {}

// probe name -> bit (UE1 probe functions, names 300..363)
const PROBES = ['spawned', 'destroyed', 'gainedchild', 'lostchild', 'probe4', 'probe5', 'trigger', 'untrigger',
  'timer', 'hitwall', 'falling', 'landed', 'zonechange', 'touch', 'untouch', 'bump', 'beginstate', 'endstate',
  'basechange', 'attach', 'detach', 'actorentered', 'actorleaving', 'killcredit', 'animend', 'endedrotation',
  'interpolateend', 'encroachingon', 'encroachedby', 'footzonechange', 'headzonechange', 'paintimer',
  'speechtimer', 'mayfall', 'probe34', 'die', 'tick', 'playertick', 'expired', 'probe39', 'seeplayer',
  'enemynotvisible', 'hearnoise', 'updateeyeheight', 'seemonster', 'seefriend', 'specialhandling',
  'botdesireability'];
export const PROBE_BIT = new Map(PROBES.map((n, i) => [n, i]));

export class VM {
  constructor(assets) {
    this.assets = assets;
    this.table = new ClassTable(assets, this);
    this.natives = new Map();       // iNative -> fn(self, args, frame, ctx)
    this.namedNatives = new Map();  // 'class.func' (lowercase) -> fn
    this.nativeInfo = new Map();    // iNative -> FuncInfo (param metadata)
    this.assetCache = new Map();
    this.levelObjects = null;       // Map(export -> UObject) during level load
    this.warnings = new Map();
    this.log = (...a) => console.log('[US]', ...a);
    this.maxSteps = 5_000_000;
    this.callDepth = 0;
    this.time = 0;
  }

  async loadPackages(names) {
    for (const n of names) await this.table.loadPackage(n);
  }

  cls(name) { return this.table.get(name); }

  // Register native functions after Core/Engine are loaded
  indexNatives() {
    for (const c of this.table.classes.values()) {
      if (!['core', 'engine', 'fire', 'ipdrv', 'uwindow', 'editor'].includes(c.pkg.name.toLowerCase())) continue;
      this.table.get(c.name);
      for (const f of c.funcs.values()) if (f.isNative && f.iNative && !this.nativeInfo.has(f.iNative)) this.nativeInfo.set(f.iNative, f);
    }
  }

  // (every occurrence goes to the debug log with the object running script; the console only sees 3)
  warnOnce(key, ...msg) {
    const n = (this.warnings.get(key) || 0) + 1;
    this.warnings.set(key, n);
    this.debugLog?.add('script', msg.map(String).join(' '), this.curSelf);
    if (n <= 3) console.warn('[US]', ...msg);
  }

  // ------------------------------------------------------------------
  // Object references inside packages
  resolveObjectRef(pkg, ref, prop) {
    if (!ref) return null;
    let cname, name;
    if (ref > 0) { const e = pkg.exports[ref - 1]; cname = e.className; name = e.name; }
    else { const im = pkg.imports[-ref - 1]; cname = im.className; name = im.name; }
    if (cname === 'Class') return this.cls(name);
    // level actors / objects
    if (ref > 0 && this.levelObjects) {
      const e = pkg.exports[ref - 1];
      const o = this.levelObjects.get(e);
      if (o) return o;
    }
    return this.assetRef(pkg, ref);
  }

  assetRef(pkg, ref) {
    let tp = pkg, exp = null;
    if (ref > 0) exp = pkg.exports[ref - 1];
    else {
      const chain = [];
      let cur = ref;
      while (cur < 0) { const im = pkg.imports[-cur - 1]; chain.unshift(im.name); cur = im.package; }
      const loaded = this.assets.loaded?.get(chain[0].toLowerCase());
      const im = pkg.imports[-ref - 1];
      if (loaded) {
        tp = loaded;
        exp = this.assets.constructor.findInPackage(loaded, chain.slice(1).map(s => s.toLowerCase()), im.className);
      }
      if (!exp) {
        const key = chain.join('.').toLowerCase();
        let a = this.assetCache.get(key);
        if (!a) { a = new AssetRef(null, null, chain.join('.')); a.__className = im.className; a.__unresolved = true; this.assetCache.set(key, a); }
        return a;
      }
    }
    let a = this.assetCache.get(exp);
    if (!a) {
      a = new AssetRef(tp, exp, tp.refPath(exp.index + 1));
      this.assetCache.set(exp, a);
      this.assetCache.set(a.__path.toLowerCase(), a);
      this.initAssetProps(a);
    }
    return a;
  }

  // Give an asset reference its script class + serialized properties (e.g. Texture.USize/VSize)
  initAssetProps(a) {
    if (!a.exp) return;
    const cls = this.cls(a.exp.className);
    if (!cls) return;
    a.Class = cls;
    const d = cls.defaults;
    for (const k in d) if (!(k in a) || a[k] === undefined) a[k] = cloneVal(d[k]);
    a.Class = cls;
    a.Name = a.exp.name;
    try {
      const r = a.pkg.readerFor(a.exp);
      readTypedProperties(this.table, r, cls, a);
    } catch (e) { /* tolerate */ }
  }

  // Find an asset by "Package.Group.Name" (for DynamicLoadObject)
  findAsset(path, className) {
    const key = path.toLowerCase();
    if (this.assetCache.has(key)) return this.assetCache.get(key);
    const parts = path.split('.');
    const pkg = this.assets.loaded?.get(parts[0].toLowerCase());
    if (!pkg) {
      // Package not fetched yet: hand out a placeholder and fill it in when it arrives.
      if (!this.assets.has(parts[0])) return null;
      const a = new AssetRef(null, null, path);
      a.__className = className || 'Object';
      a.__unresolved = true;
      this.assetCache.set(key, a);
      this.assets.pkg(parts[0]).then(p => {
        if (!p) return;
        const exp = this.assets.constructor.findInPackage(p, parts.slice(1).map(x => x.toLowerCase()), className);
        if (!exp) return;
        a.pkg = p; a.exp = exp; a.__className = exp.className; a.Name = exp.name; a.__unresolved = false;
        this.assetCache.set(exp, a);
        this.initAssetProps(a);
      });
      return a;
    }
    const exp = this.assets.constructor.findInPackage(pkg, parts.slice(1).map(s => s.toLowerCase()), className);
    if (!exp) return null;
    return this.assetRef(pkg, exp.index + 1);
  }

  // ------------------------------------------------------------------
  // Object creation
  newObject(cls, name, outer) {
    if (!cls.linked) this.table.link(cls);
    const o = new UObject(cls, name);
    const d = cls.defaults;
    for (const k in d) o[k] = cloneVal(d[k]);
    o.Class = cls;
    o.Name = name || (cls.name + o.__id);
    o.Outer = outer || null;
    return o;
  }

  // Apply serialized (tagged) properties from a level/package export onto an object
  applyExportProps(o, pkg, exp) {
    const r = pkg.readerFor(exp);
    readTypedProperties(this.table, r, o.Class, o);
  }

  // ------------------------------------------------------------------
  // Function lookup
  findFunction(obj, lname) {
    const st = obj.__state;
    if (st) { const f = st.funcs.get(lname); if (f) return f; }
    return obj.Class.funcs.get(lname) || null;
  }

  funcFromRef(pkg, ref) {
    const raw = this.table.obj(pkg, ref);
    if (!raw) return null;
    if (raw.__info) return raw.__info;
    // link owner class so FuncInfos exist
    let ownerExp = raw.pkg.exports[raw.exp.package - 1];
    if (ownerExp && ownerExp.className === 'State') ownerExp = raw.pkg.exports[ownerExp.package - 1];
    if (ownerExp) this.cls(ownerExp.name);
    if (!raw.__info) {
      // FuncInfo created by link() holds raw; index them
      for (const c of this.table.classes.values()) if (c.linked) {
        for (const f of c.funcs.values()) f.raw.__info = f;
        for (const s of c.states.values()) for (const f of s.funcs.values()) f.raw.__info = f;
      }
    }
    return raw.__info || null;
  }

  // Is probe event enabled for object's current state?
  probeIgnored(obj, lname) {
    const st = obj.__state;
    if (!st) return false;
    const bit = PROBE_BIT.get(lname);
    if (bit === undefined) return false;
    const m = st.raw.ignoreMask;
    const w = bit < 32 ? m[0] : m[1];
    return ((w >>> (bit & 31)) & 1) === 0;
  }

  // Engine -> script event call. Returns return value or undefined if not implemented.
  event(obj, name, ...args) {
    if (!obj || obj.__deleted) return undefined;
    const lname = name.toLowerCase();
    if (obj.__disabled && obj.__disabled.has(lname)) return undefined;
    if (this.probeIgnored(obj, lname)) return undefined;
    const f = this.findFunction(obj, lname);
    if (!f) return undefined;
    return this.invoke(f, obj, args);
  }

  // Call a FuncInfo with evaluated argument values
  invoke(f, self, args = []) {
    if (f.isNative) return this.callNative(f, self, args.map(v => v), null);
    if (f.isSingular) {
      self.__singular ??= new Set();
      if (self.__singular.has(f)) return undefined;
      self.__singular.add(f);
      try { return this._run(f, self, args, null); } finally { self.__singular.delete(f); }
    }
    return this._run(f, self, args, null);
  }

  callNative(f, self, args, fr) {
    let fn = f.iNative ? this.natives.get(f.iNative) : null;
    if (!fn) {
      const owner = f.owner.cls ? f.owner.cls : f.owner;
      for (let c = owner; c && !fn; c = c.superClass) fn = this.namedNatives.get(c.lname + '.' + f.lname);
    }
    if (!fn) {
      this.warnOnce('nat:' + f.name, 'missing native', f.owner.name + '.' + f.name, f.iNative);
      return f.ret ? zeroOf(f.ret) : undefined;
    }
    return fn(self, args, fr, f);
  }

  _newFrame(f, self, args) {
    const locals = {};
    const ps = f.params;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      let v = args[i];
      if (p.isOut && v && v.__ref) v = v.get();
      locals[p.name] = v === undefined ? zeroOf(p) : cloneVal(v);
    }
    for (const p of f.locals) locals[p.name] = zeroOf(p);
    return { f, self, locals, pkg: f.raw.pkg, code: f.code, jumpMap: f.jumpMap, pc: 0, ret: undefined, iters: null };
  }

  _run(f, self, args) {
    if (++this.callDepth > 250) { this.callDepth--; this.warnOnce('depth', 'recursion limit', f.name); return undefined; }
    const fr = this._newFrame(f, self, args);
    const prevSelf = this.curSelf;
    this.curSelf = self;
    try {
      this.execBlock(fr);
    } catch (e) {
      if (e === STOP) { /* fallthrough */ } else {
        if (!(e instanceof ScriptError)) { console.error('[US] error in', self.Class.name + '.' + f.name, e); this.debugLog?.add('error', `${self.Class.name}.${f.name}: ${e?.stack || e}`, self); }
        else this.warnOnce('err:' + f.name + e.message, 'script error in', self.Class.name + '.' + f.name, e.message);
      }
    } finally { this.callDepth--; this.curSelf = prevSelf; }
    // write back out params
    const ps = f.params;
    for (let i = 0; i < ps.length; i++) if (ps[i].isOut && args[i] && args[i].__ref) args[i].set(fr.locals[ps[i].name]);
    return fr.ret !== undefined ? fr.ret : (f.ret ? zeroOf(f.ret) : undefined);
  }

  // ------------------------------------------------------------------
  // Statement execution
  execBlock(fr, isState = false) {
    const code = fr.code;
    let steps = 0;
    while (fr.pc < code.length) {
      if (++steps > this.maxSteps) throw new ScriptError('runaway loop');
      const s = code[fr.pc++];
      switch (s.op) {
        case EX.Return:
          if (s.expr.op !== EX.Nothing) fr.ret = cloneVal(this.ev(s.expr, fr, fr.self));
          return 'return';
        case EX.Stop: return 'stop';
        case EX.LabelTable: return 'stop';
        case EX.Nothing: case EX.EndFunctionParms: break;
        case EX.Jump: this._jump(fr, s.target); break;
        case EX.JumpIfNot: if (!this.ev(s.expr, fr, fr.self)) this._jump(fr, s.target); break;
        case EX.Switch: this._switch(fr, s); break;
        case EX.Case: break; // fallthrough into next case body
        case EX.Assert: if (!this.ev(s.expr, fr, fr.self)) this.warnOnce('assert' + s.line, 'assertion failed line', s.line, fr.f?.name); break;
        case EX.GotoLabel: {
          const label = String(this.ev(s.expr, fr, fr.self)).toLowerCase();
          const st = fr.state;
          const off = st?.labels.get(label);
          if (off === undefined) return 'stop';
          this._jump(fr, off);
          break;
        }
        case EX.Iterator: this._iterStart(fr, s); break;
        case EX.IteratorNext: this._iterNext(fr); break;
        case EX.IteratorPop: fr.iters?.pop(); break;
        default:
          this.ev(s, fr, fr.self);
          if (isState && (fr.self.__latent || fr.self.__stateFrame !== fr.sf)) return 'latent';
      }
      if (fr.self.__deleted && isState) return 'stop';
    }
    return 'end';
  }

  _jump(fr, mem) {
    const i = fr.jumpMap.get(mem);
    if (i === undefined) throw new ScriptError('bad jump ' + mem);
    fr.pc = i;
  }

  _switch(fr, s) {
    const v = this.ev(s.expr, fr, fr.self);
    const code = fr.code;
    for (let g = 0; g < 1024; g++) {
      const c = code[fr.pc];
      if (!c || c.op !== EX.Case) return;
      if (c.next === 0xffff) { fr.pc++; return; }
      const cv = this.ev(c.expr, fr, fr.self);
      if (valEq(v, cv)) { fr.pc++; return; }
      this._jump(fr, c.next);
    }
  }

  _iterStart(fr, s) {
    // s.expr is a native iterator call; evaluate args, gather out refs
    const call = s.expr;
    const f = this._calleeOf(call, fr, fr.self);
    const { args } = this._evalArgs(call.args, f, fr);
    const outs = [];
    f.params.forEach((p, i) => { if (p.isOut && args[i]?.__ref) outs.push(args[i]); });
    const target = call.op === EX.Context ? this.ev(call.obj, fr, fr.self) : fr.self;
    const list = this.callNative(f, target, args, fr) || [];
    // natives return a list, or a generator walking live data (UE1 iterators look at the actor list as
    // the loop runs: actors spawned meanwhile are visited, destroyed ones are skipped)
    const it = typeof list.next === 'function' ? { gen: list, cur: list.next(), outs, end: s.end, start: fr.pc } : { list, i: 0, outs, end: s.end, start: fr.pc };
    fr.iters ??= [];
    fr.iters.push(it);
    this._iterAssign(fr, it);
  }

  _iterDone(it) { return it.gen ? !!it.cur.done : it.i >= it.list.length; }

  _iterAssign(fr, it) {
    if (this._iterDone(it)) { fr.iters.pop(); this._jump(fr, it.end); return; }
    const row = it.gen ? it.cur.value : it.list[it.i];
    if (Array.isArray(row)) row.forEach((v, k) => it.outs[k]?.set(v));
    else it.outs[0]?.set(row);
  }

  _iterNext(fr) {
    const it = fr.iters?.[fr.iters.length - 1];
    if (!it) return;
    if (it.gen) it.cur = it.gen.next();
    else {
      it.i++;
      // skip deleted actors
      while (it.i < it.list.length) {
        const r = it.list[it.i];
        const o = Array.isArray(r) ? r[0] : r;
        if (o && o.__deleted) { it.i++; continue; }
        break;
      }
    }
    if (this._iterDone(it)) { fr.iters.pop(); this._jump(fr, it.end); return; }
    fr.pc = it.start;
    this._iterAssign(fr, it);
  }

  // ------------------------------------------------------------------
  // State code
  // UObject::GotoState (engine side): EndState in the old state (unless already inside EndState), switch,
  // reset the probe mask and state code, BeginState in the new one; a state switch inside either event
  // preempts this one. An unknown state (or 'Auto' without one) leaves the actor in no state.
  // Returns 'success' | 'notfound' | 'preempted'.
  gotoStateOnly(obj, stateName) {
    let lname = stateName ? String(stateName).toLowerCase() : 'none';
    if (/^'*$/.test(lname)) lname = 'none'; // empty name may be stored as a quote
    obj.__latent = null;
    let node = null;
    if (lname === 'auto') node = obj.Class.autoState || null;
    else if (lname !== 'none') node = obj.Class.states.get(lname) || null;
    const old = obj.__state || null;
    if (old && node !== old && !obj.__inEndState) {
      obj.__stateChanged = false;
      obj.__inEndState = true;
      this.event(obj, 'EndState');
      obj.__inEndState = false;
      if (obj.__stateChanged) return 'preempted';
    }
    obj.__state = node;
    obj.__stateFrame = null;
    obj.__disabled = null; // probe mask back to the state's: Disable() only lasts for the current state
    if (node && node !== old) {
      obj.__stateChanged = false;
      this.event(obj, 'BeginState');
      if (obj.__stateChanged) return 'preempted';
    }
    if (!node) return 'notfound';
    obj.__stateChanged = true;
    return 'success';
  }

  // UObject::GotoLabel: the label is looked up in the state and then its parent states
  gotoLabel(obj, label) {
    obj.__latent = null;
    const ll = String(label || 'Begin').toLowerCase();
    for (let st = obj.__state; st && ll !== 'none'; st = st.superState) {
      const off = st.labels.get(ll);
      if (off !== undefined) { obj.__stateFrame = { state: st, pc: st.jumpMap.get(off) ?? 0 }; return true; }
    }
    obj.__stateFrame = null;
    return false;
  }

  // script GotoState(optional NewState = current state, optional Label): only a different state is
  // entered; then the label (Begin by default) is jumped to
  gotoState(obj, stateName, label) {
    const cur = obj.__state ? obj.__state.name : 'None';
    if (stateName === undefined || stateName === null) stateName = cur;
    let r = 'success';
    if (String(stateName).toLowerCase() !== String(cur).toLowerCase()) r = this.gotoStateOnly(obj, stateName);
    if (r === 'success') {
      const hasLabel = label && String(label).toLowerCase() !== 'none';
      if (!this.gotoLabel(obj, hasLabel ? label : 'Begin') && hasLabel) this.warnOnce('nolabel' + stateName + label, 'GotoState: label not found', stateName, label);
    } else if (r === 'notfound') {
      const ln = String(stateName).toLowerCase();
      if (ln !== 'none' && ln !== 'auto' && !/^'*$/.test(ln)) this.warnOnce('nostate' + ln, 'no state', stateName, 'in', obj.Class.name);
    }
    return r !== 'notfound';
  }

  // Run state code until latent / stop
  runState(obj) {
    for (let guard = 0; guard < 32; guard++) {
      const sf = obj.__stateFrame;
      if (!sf || obj.__latent || obj.__deleted) return;
      const st = sf.state;
      const fr = { f: null, self: obj, locals: {}, pkg: st.raw.pkg, code: st.code, jumpMap: st.jumpMap, pc: sf.pc, state: st, sf, iters: null };
      let res;
      const prevSelf = this.curSelf;
      this.curSelf = obj;
      try { res = this.execBlock(fr, true); }
      catch (e) {
        if (!(e instanceof ScriptError)) { console.error('[US] state error', obj.Class.name, st.name, e); this.debugLog?.add('error', `${obj.Class.name} state ${st.name}: ${e?.stack || e}`, obj); }
        else this.warnOnce('serr' + st.name + e.message, 'state error', obj.Class.name, st.name, e.message);
        this.curSelf = prevSelf;
        obj.__stateFrame = null; return;
      }
      this.curSelf = prevSelf;
      if (obj.__stateFrame !== sf) continue; // GotoState switched code: run the new code now
      if (res === 'latent') { sf.pc = fr.pc; return; }
      obj.__stateFrame = null;
      return;
    }
  }

  // ------------------------------------------------------------------
  // Expression evaluation. `obj` is the current context object.
  // Storage key for a property reference (handles shadowed properties)
  propName(fr, n) {
    if (n.pname !== undefined) return n.pname;
    const raw = this.table.obj(fr.pkg, n.prop);
    if (raw && !raw.__pinfo) {
      // make sure the owning class is linked so the PropInfo exists
      let owner = raw.pkg.exports[raw.exp.package - 1];
      while (owner && owner.className !== 'Class' && owner.package) owner = raw.pkg.exports[owner.package - 1];
      if (owner && owner.className === 'Class') this.cls(owner.name);
    }
    return n.pname = (raw && raw.__pinfo) ? raw.__pinfo.key : fr.pkg.refName(n.prop);
  }

  ref(n, fr, obj) {
    switch (n.op) {
      case EX.LocalVariable: case EX.NativeParm: return mkref(fr.locals, this.propName(fr, n));
      case EX.InstanceVariable:
        if (!obj) throw new ScriptError('Accessed None (' + this.propName(fr, n) + ')');
        return mkref(obj, this.propName(fr, n));
      case EX.DefaultVariable: {
        const d = obj.__isClass ? obj.defaults : (obj.Class?.defaults || obj);
        return mkref(d, this.propName(fr, n));
      }
      case EX.BoolVariable: return this.ref(n.expr, fr, obj);
      case EX.ArrayElement: case EX.DynArrayElement: {
        const idx = this.ev(n.index, fr, fr.self) | 0;
        const r = this.ref(n.array, fr, obj);
        let arr = r.get();
        if (!Array.isArray(arr)) { arr = []; r.set(arr); }
        return mkref(arr, this.arrayIndex(arr, idx, n.op === EX.DynArrayElement, fr));
      }
      case EX.StructMember: {
        const r = this.ref(n.expr, fr, obj);
        let s = r.get();
        if (!s || typeof s !== 'object') { s = {}; r.set(s); }
        return mkref(s, this.propName(fr, n));
      }
      case EX.Context: case EX.ClassContext: {
        let o = this.ev(n.obj, fr, obj);
        if (n.op === EX.ClassContext && o && o.__isClass) o = o.defaults;
        if (!o) { this.warnOnce('none' + fr.f?.name + n.mem, 'Accessed None (assign) in', fr.self.Class.name + '.' + (fr.f?.name || fr.state?.name), '(' + this.describe(n.obj, fr) + ')'); return mkref({}, 'x'); }
        return this.ref(n.expr, fr, o);
      }
      default: {
        // non-lvalue (e.g. function result): temp
        const v = this.ev(n, fr, obj);
        return mkref({ v }, 'v');
      }
    }
  }

  // UE1 array indexing: a fixed array clamps an out-of-range index (with a warning); a dynamic array grows
  // (zero-filled) to reach it, a negative index reads/writes element 0
  arrayIndex(arr, i, dynamic, fr) {
    if (dynamic) {
      if (i < 0) { this.warnOnce('aob' + (fr.f?.name || ''), 'Accessed array out of bounds', i, '/', arr.length); return 0; }
      while (arr.length <= i) arr.push(arr.length ? zeroLike(arr[0]) : undefined);
      return i;
    }
    if (i >= arr.length || i < 0) {
      this.warnOnce('aob' + (fr.f?.name || fr.state?.name || ''), 'Accessed array out of bounds', i, '/', arr.length, 'in', fr.self?.Class?.name + '.' + (fr.f?.name || fr.state?.name));
      return Math.max(0, Math.min(arr.length - 1, i));
    }
    return i;
  }

  ev(n, fr, obj) {
    switch (n.op) {
      case EX.LocalVariable: case EX.NativeParm: return fr.locals[this.propName(fr, n)];
      case EX.InstanceVariable: {
        if (!obj) throw new ScriptError('Accessed None');
        const v = obj[this.propName(fr, n)];
        return v;
      }
      case EX.DefaultVariable: {
        const d = obj.__isClass ? obj.defaults : (obj.Class?.defaults || obj);
        return d[this.propName(fr, n)];
      }
      case EX.BoolVariable: return !!this.ev(n.expr, fr, obj);
      case EX.Let: case EX.LetBool: {
        const r = this.ref(n.lhs, fr, obj);
        r.set(cloneVal(this.ev(n.rhs, fr, fr.self)));
        return undefined;
      }
      case EX.ArrayElement: case EX.DynArrayElement: {
        const arr = this.ev(n.array, fr, obj);
        const i = this.ev(n.index, fr, fr.self) | 0;
        return Array.isArray(arr) ? arr[this.arrayIndex(arr, i, n.op === EX.DynArrayElement, fr)] : undefined;
      }
      case EX.ArrayLength: { const a = this.ev(n.expr, fr, obj); return Array.isArray(a) ? a.length : 0; }
      case EX.StructMember: {
        const s = this.ev(n.expr, fr, obj);
        return s ? s[this.propName(fr, n)] : undefined;
      }
      case EX.Context: {
        const o = this.ev(n.obj, fr, obj);
        if (!o) {
          this.warnOnce('none:' + (fr.f?.name || fr.state?.name) + n.mem, 'Accessed None in', fr.self.Class.name + '.' + (fr.f?.name || fr.state?.name), '(' + this.describe(n.obj, fr) + ')');
          return this.typeZero(n.expr, fr);
        }
        return this.ev(n.expr, fr, o);
      }
      case EX.ClassContext: {
        const c = this.ev(n.obj, fr, obj);
        if (!c) return this.typeZero(n.expr, fr);
        return this.ev(n.expr, fr, c.__isClass ? c.defaults : c);
      }
      case EX.Self: return obj;
      case EX.IntConst: case EX.FloatConst: case EX.StringConst: case EX.UnicodeStringConst:
      case EX.NameConst: case EX.ByteConst: case EX.IntConstByte: return n.value;
      case EX.RotationConst: case EX.VectorConst: return { ...n.value };
      case EX.IntZero: return 0;
      case EX.IntOne: return 1;
      case EX.True: return true;
      case EX.False: return false;
      case EX.NoObject: return null;
      case EX.ObjectConst: return n._obj !== undefined ? n._obj : (n._obj = this.resolveObjectRef(fr.pkg, n.obj));
      case EX.Nothing: return undefined;
      case EX.Skip: return this.ev(n.expr, fr, obj);
      case EX.EatString: this.ev(n.expr, fr, obj); return undefined;
      case EX.MetaCast: {
        const c = this.ev(n.expr, fr, obj);
        const t = n._cls ??= this.resolveObjectRef(fr.pkg, n.cls);
        return c && c.__isClass && t && c.isChildOf(t) ? c : null;
      }
      case EX.DynamicCast: {
        const v = this.ev(n.expr, fr, obj);
        const t = n._cls ??= this.resolveObjectRef(fr.pkg, n.cls);
        if (!v) return null;
        if (!t) {
          // an intrinsic class without script (Sound, Music, Mesh...): assets of that class by name
          const tn = n._clsName ??= String(fr.pkg.refName(n.cls) || '').toLowerCase();
          return v.__asset && tn && (tn === 'object' || String(v.__className || '').toLowerCase() === tn) ? v : null;
        }
        if (v.__isClass) return v; // class -> Class cast
        if (v.__asset) {
          if (v.Class && v.Class.__isClass) return v.Class.isChildOf(t) ? v : null;
          return (t.lname === 'object' || v.__className.toLowerCase() === t.lname || isAssetA(v, t)) ? v : null;
        }
        return v.Class && v.Class.isChildOf(t) ? v : null;
      }
      case EX.StructCmpEq: return deepEq(this.ev(n.a, fr, obj), this.ev(n.b, fr, obj));
      case EX.StructCmpNe: return !deepEq(this.ev(n.a, fr, obj), this.ev(n.b, fr, obj));
      case EX.New: {
        const outer = this.ev(n.outer, fr, obj);
        const name = this.ev(n.name, fr, obj);
        this.ev(n.flags, fr, obj);
        const c = this.ev(n.cls, fr, obj);
        if (!c) return null;
        const o = this.newObject(c, name && name !== 'None' ? name : undefined, outer || null);
        this.onNewObject?.(o);
        return o;
      }
      case EX.VirtualFunction: case EX.GlobalFunction: case EX.FinalFunction: case EX.FirstNative:
        return this.callNode(n, fr, obj);
      default:
        if (n.conv) return this.convert(n.conv, this.ev(n.expr, fr, obj));
        throw new ScriptError('unhandled op 0x' + n.op.toString(16));
    }
  }

  // Zero value of an expression's static type (UE1 returns zeroed results for Accessed None)
  typeZero(n, fr) {
    try {
      switch (n.op) {
        case EX.InstanceVariable: case EX.DefaultVariable: case EX.LocalVariable: case EX.StructMember: {
          this.propName(fr, n);
          const raw = this.table.obj(fr.pkg, n.prop);
          return raw?.__pinfo ? zeroOf(raw.__pinfo) : undefined;
        }
        case EX.BoolVariable: return false;
        case EX.ArrayElement: { const z = this.typeZero(n.array, fr); return Array.isArray(z) ? z[0] : z; }
        case EX.FinalFunction: { const f = this.funcFromRef(fr.pkg, n.func); return f?.ret ? zeroOf(f.ret) : undefined; }
        case EX.FirstNative: { const f = this.nativeInfo.get(n.native); return f?.ret ? zeroOf(f.ret) : undefined; }
        case EX.Context: case EX.ClassContext: return this.typeZero(n.expr, fr);
        default: if (n.conv) return this.convert(n.conv, undefined);
      }
    } catch { /* ignore */ }
    return undefined;
  }

  describe(n, fr) {
    switch (n.op) {
      case EX.LocalVariable: case EX.InstanceVariable: case EX.DefaultVariable: return this.propName(fr, n);
      case EX.Context: return this.describe(n.obj, fr) + '.' + this.describe(n.expr, fr);
      case EX.StructMember: return this.describe(n.expr, fr) + '.' + this.propName(fr, n);
      case EX.VirtualFunction: case EX.GlobalFunction: return n.fname + '()';
      case EX.FinalFunction: return fr.pkg.refName(n.func) + '()';
      case EX.ArrayElement: return this.describe(n.array, fr) + '[]';
      case EX.DynamicCast: return 'cast(' + this.describe(n.expr, fr) + ')';
      default: return 'op' + n.op.toString(16);
    }
  }

  _calleeOf(n, fr, obj) {
    switch (n.op) {
      case EX.FirstNative: return n._f ??= this.nativeInfo.get(n.native);
      case EX.FinalFunction: return n._f ??= this.funcFromRef(fr.pkg, n.func);
      case EX.VirtualFunction: return this.findFunction(obj, n.lname ??= n.fname.toLowerCase());
      case EX.GlobalFunction: return obj.Class.funcs.get(n.lname ??= n.fname.toLowerCase());
      case EX.Context: return this._calleeOf(n.expr, fr, this.ev(n.obj, fr, obj));
    }
    return null;
  }

  _evalArgs(argNodes, f, fr) {
    const args = new Array(argNodes.length);
    for (let i = 0; i < argNodes.length; i++) {
      const a = argNodes[i];
      const p = f?.params[i];
      if (a.op === EX.Nothing) { args[i] = undefined; continue; }
      if (p && p.isOut) args[i] = this.ref(a, fr, fr.self);
      else if (a.op === EX.Skip) args[i] = { __lazy: true, node: a.expr };
      else args[i] = this.ev(a, fr, fr.self);
    }
    return { args };
  }

  callNode(n, fr, obj) {
    if (!obj) throw new ScriptError('call on None');
    // short-circuit boolean operators
    if (n.op === EX.FirstNative) {
      if (n.native === 130) return !!this.ev(n.args[0], fr, fr.self) && !!this.ev(n.args[1], fr, fr.self);
      if (n.native === 132) return !!this.ev(n.args[0], fr, fr.self) || !!this.ev(n.args[1], fr, fr.self);
    }
    let f = this._calleeOf(n, fr, obj);
    if (!f) {
      if (n.op === EX.FirstNative) {
        const fn = this.natives.get(n.native);
        if (fn) {
          const args = n.args.map(a => a.op === EX.Nothing ? undefined : this.ev(a, fr, fr.self));
          return fn(obj, args, fr, null);
        }
        this.warnOnce('nat' + n.native, 'unknown native', n.native);
        return undefined;
      }
      this.warnOnce('nofn' + (n.fname || n.func), 'function not found', n.fname || fr.pkg.refName(n.func), 'on', obj.Class?.name);
      // still evaluate args for side effects
      for (const a of n.args) if (a.op !== EX.Nothing) this.ev(a, fr, fr.self);
      return undefined;
    }
    const { args } = this._evalArgs(n.args, f, fr);
    for (let i = 0; i < args.length; i++) if (args[i] && args[i].__lazy) args[i] = this.ev(args[i].node, fr, fr.self);
    // static functions run on the class default object
    let self = obj;
    if (f.isNative) {
      const r = this.callNative(f, self, args, fr);
      return r;
    }
    if (f.isSingular) {
      self.__singular ??= new Set();
      if (self.__singular.has(f)) return undefined;
      self.__singular.add(f);
      try { return this._run(f, self, args); } finally { self.__singular.delete(f); }
    }
    return this._run(f, self, args);
  }

  // ------------------------------------------------------------------
  convert(c, v) {
    switch (c) {
      case EX.RotatorToVector: return rotToVec(v);
      case EX.ByteToInt: case EX.ByteToFloat: return v | 0;
      case EX.ByteToBool: case EX.IntToBool: case EX.FloatToBool: return !!v;
      case EX.IntToByte: return v & 255;
      case EX.IntToFloat: return +v;
      case EX.BoolToByte: case EX.BoolToInt: return v ? 1 : 0;
      case EX.BoolToFloat: return v ? 1 : 0;
      case EX.FloatToByte: return (Math.trunc(v) & 255);
      case EX.FloatToInt: return Math.trunc(v) | 0;
      case EX.StringToName: return String(v);
      case EX.ObjectToBool: return !!v;
      case EX.NameToBool: return !!v && String(v).toLowerCase() !== 'none';
      case EX.StringToByte: return (parseInt(v) || 0) & 255;
      case EX.StringToInt: return parseInt(v) || 0;
      case EX.StringToBool: { const s = String(v).toLowerCase(); return s === 'true' ? true : s === 'false' ? false : (parseInt(s) || 0) !== 0; }
      case EX.StringToFloat: return parseFloat(v) || 0;
      case EX.StringToVector: { const p = String(v).split(','); return { X: +p[0] || 0, Y: +p[1] || 0, Z: +p[2] || 0 }; }
      case EX.StringToRotator: { const p = String(v).split(','); return { Pitch: p[0] | 0, Yaw: p[1] | 0, Roll: p[2] | 0 }; }
      case EX.VectorToBool: return !!v && (v.X !== 0 || v.Y !== 0 || v.Z !== 0);
      case EX.VectorToRotator: return vecToRot(v);
      case EX.RotatorToBool: return !!v && (v.Pitch !== 0 || v.Yaw !== 0 || v.Roll !== 0);
      case EX.ByteToString: case EX.IntToString: return String(v | 0);
      case EX.BoolToString: return v ? 'True' : 'False';
      case EX.FloatToString: return fmtFloat(v);
      case EX.ObjectToString: return v ? (v.__isClass ? v.pkg.name + '.' + v.name : (v.__path || v.Name)) : 'None';
      case EX.NameToString: return String(v ?? 'None');
      case EX.VectorToString: return v ? `${fmtFloat(v.X)},${fmtFloat(v.Y)},${fmtFloat(v.Z)}` : '0.000000,0.000000,0.000000';
      case EX.RotatorToString: return v ? `${v.Pitch & 65535},${v.Yaw & 65535},${v.Roll & 65535}` : '0,0,0';
    }
    return v;
  }
}

function mkref(o, k) { return { __ref: true, get: () => o[k], set: v => { o[k] = v; } }; }

function zeroResult(n) { return undefined; }
// zero value shaped like v (for growing dynamic arrays)
function zeroLike(v) {
  if (typeof v === 'number') return 0;
  if (typeof v === 'string') return '';
  if (typeof v === 'boolean') return false;
  if (v && typeof v === 'object' && !v.__isUObject && !v.__isClass) { const o = Array.isArray(v) ? [] : {}; for (const k in v) o[k] = zeroLike(v[k]); return o; }
  return null;
}

// printf("%f") (HP1's Core.dll formats floats this way)
export function fmtFloat(v) { v = +v; if (v === Infinity) return '1.#INF00'; if (v === -Infinity) return '-1.#INF00'; if (Number.isNaN(v)) return '-1.#IND00'; return v.toFixed(6); }

export function valEq(a, b) {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  if (a && typeof a === 'object' && !a.__isUObject && !a.__isClass) return deepEq(a, b);
  return a === b || (a == null && b == null);
}

export function deepEq(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return a == b;
  if (a.__isUObject || b.__isUObject || a.__isClass || b.__isClass) return a === b;
  for (const k in a) if (!deepEq(a[k], b[k])) return false;
  return true;
}

function isAssetA(v, t) {
  // texture subclasses etc.
  const map = { texture: ['texture', 'firetexture', 'watertexture', 'wavetexture', 'wettexture', 'icetexture', 'scriptedtexture', 'fractaltexture'] };
  return map[t.lname]?.includes(v.__className.toLowerCase()) || false;
}

const RU = Math.PI / 32768;
export function rotToVec(r) {
  if (!r) return { X: 1, Y: 0, Z: 0 };
  const p = r.Pitch * RU, y = r.Yaw * RU;
  return { X: Math.cos(p) * Math.cos(y), Y: Math.cos(p) * Math.sin(y), Z: Math.sin(p) };
}
export function vecToRot(v) {
  if (!v) return { Pitch: 0, Yaw: 0, Roll: 0 };
  // UE1 FVector::Rotation(): signed components (scripts compare e.g. pitch < -8000), truncated, scaled by
  // MAXWORD/2pi like the engine
  const K = 65535 / (2 * Math.PI);
  const yaw = Math.trunc(Math.atan2(v.Y, v.X) * K);
  const pitch = Math.trunc(Math.atan2(v.Z, Math.hypot(v.X, v.Y)) * K);
  return { Pitch: pitch, Yaw: yaw, Roll: 0 };
}
export { LATENT };
