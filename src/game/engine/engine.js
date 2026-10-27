// Game engine: VM + level + player/input + console commands.
import { DebugLog } from './debug.js';
import { VM } from '../../uscript/vm.js';
import { installCoreNatives } from '../../uscript/natives_core.js';
import { installActorNatives } from './natives_actor.js';
import { installCanvasNatives } from './natives_canvas.js';
import { installParticleNatives } from './particles.js';
import { installGestureNatives } from './natives_gesture.js';
import { snapshotLevel, restoreLevel, storageGet, storageSet, captureBaseline } from './save.js';
import { GameLevel } from './level.js';
import { weaponCoords } from './bones.js';
import { parseIni } from './ini.js';
import { FUNC } from '../../uscript/loader.js';

export const BASE_PACKAGES = ['Core', 'Engine', 'Fire', 'UWindow', 'HPBase', 'HPParticle', 'HPModels', 'HPSounds',
  'HarryPotter', 'HProps', 'HPMenu', 'HPDialog', 'HPPuzzle', 'UnrealShare'];
// sound packages scripts load by name at run time (DynamicLoadObject)
const DYNAMIC_PACKAGES = ['AllDialog'];

// the typed sequence that toggles the door mode (see keyEvent)
const DOOR_MODE_SEQUENCE = 'alohomora';

export class Engine {
  constructor(assets) {
    this.assets = assets;
    this.vm = new VM(assets);
    // issue log + state snapshots (debug.js)
    this.debug = new DebugLog(this);
    this.vm.debugLog = this.debug;
    this.level = null;
    this.player = null;      // PlayerPawn
    this.viewport = null;
    this.console = null;
    this.keysDown = new Set();
    this.pendingPress = [];
    this.mouse = { dx: 0, dy: 0 };
    this.hooks = { levelLoaded: [], beforeTick: [], afterTick: [] };
    this.extraObjects = [];
    this.defaultGame = 'GameInfo';
    this.time = 0;
  }

  async init() {
    const vm = this.vm;
    await vm.loadPackages(BASE_PACKAGES.filter(p => this.assets.has(p)));
    installCoreNatives(vm);
    vm.indexNatives();
    this.addIntrinsicClasses();
    installActorNatives(vm, this);
    installCanvasNatives(vm, this);
    installParticleNatives(vm, this);
    installGestureNatives(vm);
    // config
    this.ini = parseIni(await this.readText('System/Default.ini'));
    this.userIni = parseIni(await this.readText('System/DefUser.ini'));
    this.buildInput();
    this.defaultGame = (this.ini['Engine.Engine']?.DefaultGame || 'Engine.GameInfo').split('.').pop();
    vm.localize = (sec, key, pkg) => this.localize(sec, key, pkg);
    this.localeFiles = new Map();
  }

  // Classes that exist only in C++ (no script export), e.g. Viewport extends Player
  addIntrinsicClasses() {
    const vm = this.vm;
    const t = vm.table;
    const mk = (name, superName) => {
      if (t.classes.has(name.toLowerCase())) return;
      const sup = vm.cls(superName);
      if (!sup) return;
      const c = Object.create(Object.getPrototypeOf(sup));
      Object.assign(c, sup);
      c.name = name; c.lname = name.toLowerCase();
      c.superClass = sup;
      c.ownProps = [];
      c.props = sup.props.slice();
      c.propByName = new Map(sup.propByName);
      c.funcs = new Map(sup.funcs);
      c.states = new Map(sup.states);
      c.defaults = { ...sup.defaults, Class: c, Name: name };
      c.linked = true;
      c.intrinsic = true;
      t.classes.set(c.lname, c);
    };
    mk('Viewport', 'Player');
  }

  async readText(rel) {
    try { return new TextDecoder('latin1').decode(await this.assets.fetchBuffer(rel)); } catch { return ''; }
  }

  // Localization (.int / .tra files): [Section] Key=Value
  async loadLocale(pkg) {
    const k = pkg.toLowerCase();
    if (this.localeFiles.has(k)) return this.localeFiles.get(k);
    const ext = this.assets.lang === 'int' ? 'int' : this.assets.lang;
    let txt = '';
    const files = this.assets.manifest || [];
    const find = e => files.find(f => f.toLowerCase() === `system/${k}.${e}`);
    const f = find(ext) || find('int');
    if (f) {
      const buf = await this.assets.fetchBuffer(f);
      txt = decodeLocale(new Uint8Array(buf));
    }
    const data = parseIni(txt);
    this.localeFiles.set(k, data);
    return data;
  }
  // Preload every localization file (System/*.int and the selected language variant)
  async loadAllLocales() {
    if (this.localesLoaded) return;
    this.localesLoaded = true;
    const names = new Set();
    for (const f of this.assets.manifest || []) {
      const m = /^System\/([^/.]+)\.(int|tra|[a-z]{3})$/i.exec(f);
      if (m && !/^(dll|exe|ini|bmp|ico|u)$/i.test(m[2])) names.add(m[1].toLowerCase());
    }
    await Promise.all([...names].map(n => this.loadLocale(n)));
  }

  localize(sec, key, pkg) {
    const d = this.localeFiles.get(String(pkg).toLowerCase());
    if (!d) return '';
    const s = d[sec] || d[Object.keys(d).find(x => x.toLowerCase() === sec.toLowerCase())];
    if (!s) return '';
    const kk = Object.keys(s).find(x => x.toLowerCase() === key.toLowerCase());
    return kk ? s[kk] : '';
  }

  // ------------------------------------------------------------------ map loading
  // Capture the player's CPF_Travel properties (UE1 travel); object refs to actors are re-created by script
  captureTravel() {
    const p = this.player;
    if (!p) return null;
    const out = {};
    for (const prop of p.Class.props) {
      if (!(prop.flags & 0x10000)) continue;
      const v = p[prop.key];
      if (v && typeof v === 'object' && v.__isUObject && !v.__asset) continue;
      out[prop.key] = cloneValue(v);
    }
    return { cls: p.Class.name, props: out };
  }

  applyTravel(t) {
    const p = this.player;
    if (!t || !p) return;
    for (const k in t.props) p[k] = cloneValue(t.props[k]);
    this.vm.event(p, 'TravelPreAccept');
    this.vm.event(p, 'TravelPostAccept');
  }

  // UGameEngine ExportTravel: the player and its inventory chain, each actor with bTravel, as its class,
  // name and the CPF_Travel properties that differ from the class defaults (actor references by name)
  exportTravel() {
    const p = this.player;
    if (!p) return [];
    const out = [];
    const one = a => {
      if (!a.bTravel) return;
      const d = a.Class.defaults || {}, props = {};
      const enc = v => (v && typeof v === 'object' && v.__isUObject && !v.__asset && !v.__isClass) ? { __actor: v.Name } : cloneValue(v);
      const same = (x, y) => x === y || (x && y && typeof x === 'object' && !x.__isUObject && JSON.stringify(x) === JSON.stringify(y));
      for (const prop of a.Class.props) {
        if (!(prop.flags & 0x10000)) continue;
        const v = a[prop.key], dv = d[prop.key];
        if (prop.arrayDim > 1 && Array.isArray(v)) {
          const el = {};
          v.forEach((x, i) => { if (!same(x, dv?.[i])) el[i] = enc(x); });
          if (Object.keys(el).length) props[prop.key] = { __elements: el };
        } else if (!same(v, dv)) props[prop.key] = enc(v);
      }
      out.push({ cls: a.Class.name, name: a.Name, player: a.Class.isA('PlayerPawn'), props });
    };
    one(p);
    for (let i = p.Inventory, n = 0; i && n < 1000; i = i.Inventory, n++) one(i);
    return out;
  }

  // ULevel::SpawnPlayActor after Login: TravelPreAccept on the player, the travelling actors spawned
  // (owned by the player, at its place; a PlayerPawn record is the player itself), their properties
  // imported (actor references to other accepted actors), TravelPreAccept on each in reverse order,
  // Game.AcceptInventory, TravelPostAccept on each in reverse, then on the player
  acceptTravel(p, records) {
    const vm = this.vm, lvl = this.level;
    vm.event(p, 'TravelPreAccept');
    const accepted = [];
    for (const r of records || []) {
      const cls = vm.cls(r.cls);
      if (!cls) continue;
      if (cls.isA('PlayerPawn')) accepted.push({ actor: p, r });
      else {
        const a = lvl.spawn(cls, p, null, { ...p.Location }, { ...p.Rotation }, { noFit: true, force: true });
        if (a) accepted.push({ actor: a, r });
      }
    }
    const dec = v => (v && typeof v === 'object' && '__actor' in v) ? (accepted.find(x => x.r.name === v.__actor)?.actor ?? undefined) : cloneValue(v);
    for (const { actor, r } of accepted) {
      for (const k in r.props) {
        const v = r.props[k];
        if (v && typeof v === 'object' && v.__elements) {
          if (!Array.isArray(actor[k])) continue;
          for (const i in v.__elements) { const x = dec(v.__elements[i]); if (x !== undefined) actor[k][i] = x; }
        } else { const x = dec(v); if (x !== undefined) actor[k] = x; }
      }
    }
    for (let i = accepted.length - 1; i >= 0; i--) vm.event(accepted[i].actor, 'TravelPreAccept');
    if (lvl.game) vm.event(lvl.game, 'AcceptInventory', p);
    for (let i = accepted.length - 1; i >= 0; i--) vm.event(accepted[i].actor, 'TravelPostAccept');
    vm.event(p, 'TravelPostAccept');
  }

  saveExists() {
    for (let i = 0; i < 100; i++) if (storageGet('slot' + i)) return true;
    return false;
  }

  restoreSave(snap) { restoreLevel(this, snap); }

  async loadMap(mapName, options = '', travel = null) {
    const portal = /#([^?]*)/.exec(options)?.[1] || '';
    options = options.replace(/#[^?]*/, '');
    const vm = this.vm;
    if (this.level) this.unloadLevel();
    const level = new GameLevel(this, mapName);
    this.level = level;
    // the dialog package: scripts fetch lines with DynamicLoadObject("AllDialog.<id>"), which the engine
    // loads synchronously, so it must be in memory before the level runs (first lines were silent otherwise)
    const dialogs = DYNAMIC_PACKAGES.filter(p => this.assets.has(p)).map(p => this.assets.pkg(p));
    await this.loadAllLocales();
    await level.load();
    await Promise.all(dialogs);
    level.beginPlay(options);
    level.travelInfo = travel;
    this.login(options, travel, portal);
    captureBaseline(this);
    for (const h of this.hooks.levelLoaded) await h(level);
    return level;
  }

  unloadLevel() {
    this.level = null;
    this.player = null;
  }

  login(options, travel = null, portal = '') {
    const vm = this.vm;
    const lvl = this.level;
    const game = lvl.game;
    const err = mkOut('');
    const pcClass = vm.cls(this.ini['Engine.GameInfo']?.DefaultPlayerClass?.split('.').pop() || 'Harry') || vm.cls('Harry');
    let pawn = null;
    if (game && vm.findFunction(game, 'login')) pawn = vm.event(game, 'Login', portal, options, err, pcClass);
    if (!pawn) {
      // fallback: reuse a placed PlayerPawn or spawn at a PlayerStart
      pawn = lvl.actors.find(a => a.Class.isA('PlayerPawn') && !a.__deleted);
      if (!pawn) {
        const ps = lvl.actors.find(a => a.Class.isA('PlayerStart'));
        pawn = lvl.spawn(pcClass, null, null, ps?.Location, ps?.Rotation);
      }
    }
    if (!pawn) throw new Error('could not create player: ' + err.get());
    this.possess(pawn);
    this.acceptTravel(pawn, Array.isArray(travel) ? travel : []);
    if (game) vm.event(game, 'PostLogin', pawn);
  }

  possess(pawn) {
    const vm = this.vm;
    if (!this.viewport) {
      const vpCls = vm.cls('Viewport') || vm.cls('Player');
      this.viewport = vm.newObject(vpCls, 'Viewport0');
      this.extraObjects.push(this.viewport);
      const conName = (this.ini['Engine.Engine']?.Console || 'Engine.Console').split('.').pop();
      const conCls = vm.cls(conName) || vm.cls('Console');
      if (conCls) {
        this.console = vm.newObject(conCls, 'Console0');
        this.console.Viewport = this.viewport;
        this.viewport.Console = this.console;
        this.extraObjects.push(this.console);
      }
    }
    if (this.player && this.player !== pawn) this.player.Player = null;
    this.player = pawn;
    this.viewport.Actor = pawn;
    pawn.Player = this.viewport;
    vm.event(pawn, 'Possess');
    if (this.console && !this.consoleInited) { this.consoleInited = true; vm.event(this.console, 'Created'); }
  }

  travel(url, items = false) {
    // "open saveN.usa" loads a save slot
    const sv = /^\s*save(\d+)\.usa/i.exec(String(url));
    if (sv) {
      const snap = storageGet('slot' + sv[1]);
      if (!snap) { console.warn('no save in slot', sv[1]); return; }
      this.pendingTravel = { map: snap.map, options: '', items: false, travel: null, restore: snap };
      return;
    }
    // FURL: Map?Option…#Portal; an options-only URL is relative to the current map, and ?restart
    // re-enters it with the travel data it was entered with
    const u = String(url).trim();
    let m = u.split('?')[0].split('#')[0].replace(/\.unr$/i, '').trim();
    const rest = u.slice(u.split('?')[0].split('#')[0].length);
    if (!m && this.level && rest) m = this.level.mapName;
    if (!m) return;
    const restart = /\?restart\b/i.test(rest);
    const travel = restart ? (this.level?.travelInfo ?? null) : items ? this.exportTravel() : null;
    this.pendingTravel = { map: m, options: restart ? '' : rest, items, travel };
  }

  // ------------------------------------------------------------------ input
  buildInput() {
    const sec = this.userIni['Engine.Input'] || {};
    this.aliases = new Map();
    this.bindings = new Map();
    for (const k in sec) {
      const v = sec[k];
      if (/^aliases/i.test(k)) {
        const m = /Command="([^"]*)",\s*Alias=(\w+)/i.exec(v);
        if (m && m[2].toLowerCase() !== 'none') this.aliases.set(m[2].toLowerCase(), m[1]);
      } else if (v) this.bindings.set(k.toLowerCase(), v);
    }
    // Space also jumps (user request) unless the ini binds it; HPConsole still sees Space first for
    // skip/throw, and while Harry holds something (a wizard cracker) Space only throws (see keyEvent)
    if (!this.bindings.get('space')) { this.bindings.set('space', 'Jump'); this.spaceJumpAdded = true; }
  }

  // UE1 IST_Press / IST_Release / IST_Hold processing of a key binding string
  processBinding(cmdStr, action, delta, expanded = false) {
    const parts = String(cmdStr).split('|').map(s => s.trim()).filter(Boolean);
    for (let part of parts) {
      // aliases expand once (an alias may contain a command of the same name, e.g. Jump)
      const alias = expanded ? null : this.aliases.get(part.split(/\s+/)[0].toLowerCase());
      if (alias && part.split(/\s+/).length === 1) { this.processBinding(alias, action, delta, true); continue; }
      const m = /^(\w+)\s*(.*)$/.exec(part);
      if (!m) continue;
      const verb = m[1].toLowerCase(), rest = m[2];
      const pawn = this.player;
      // UInput::Exec: Axis (hold: += Delta*Speed, mouse: += 0.01*Delta*Speed, SpeedBase: any action),
      // Button (1 on press, 0 on release), Pulse (1 on press), Toggle (flips the 0x80 bit on press)
      if (verb === 'axis') {
        const name = rest.split(/\s+/)[0];
        const sp = /speed=([-+]?[\d.]+)/i.exec(rest), sb = /speedbase=([-+]?[\d.]+)/i.exec(rest);
        const speed = sp ? parseFloat(sp[1]) : 1, base = sb ? parseFloat(sb[1]) : 0;
        if (!pawn) continue;
        const k = this.propName(pawn, name);
        if (base > 0) pawn[k] = (pawn[k] || 0) + delta * base * speed;
        else if (action === 'axis') pawn[k] = (pawn[k] || 0) + 0.01 * delta * speed;
        else if (action === 'hold') pawn[k] = (pawn[k] || 0) + delta * speed;
      } else if (verb === 'button' || verb === 'pulse') {
        const name = rest.split(/\s+/)[0];
        if (!pawn) continue;
        const k = this.propName(pawn, name);
        if (action === 'press') pawn[k] = 1;
        else if (action === 'release' && verb === 'button' && pawn[k]) pawn[k] = 0;
      } else if (verb === 'toggle') {
        const name = rest.split(/\s+/)[0];
        if (pawn && action === 'press') { const k = this.propName(pawn, name); pawn[k] = ((pawn[k] | 0) ^ 0x80) & 255; }
      } else if (verb === 'onrelease') {
        if (action === 'release') this.exec(rest);
      } else if (action === 'press') {
        this.exec(part);
      }
    }
  }

  propName(o, name) {
    const p = o.Class?.propByName.get(name.toLowerCase());
    return p ? p.name : name;
  }

  keyEvent(key, action, delta = 0) {
    const lk = key.toLowerCase();
    // typing the sequence "alohomora" toggles the door mode: every cast then opens the door aimed at
    if (action === 'press' && /^[a-z]$/.test(lk)) {
      this.typedKeys = ((this.typedKeys || '') + lk).slice(-16);
      if (this.typedKeys.endsWith(DOOR_MODE_SEQUENCE)) { this.typedKeys = ''; this.setDoorMode(!this.doorMode); }
    }
    // console first
    const vm = this.vm;
    if (this.console) {
      const ik = this.ikey(key);
      const act = { press: 1, release: 3, axis: 4 }[action] || 1;
      if (ik !== undefined && vm.event(this.console, 'KeyEvent', ik, act, delta)) return true;
    }
    if (action === 'press') this.keysDown.add(key.toLowerCase());
    if (action === 'release') this.keysDown.delete(key.toLowerCase());
    const b = this.bindings.get(key.toLowerCase());
    // door mode: casting (releasing the cast button) opens the door being aimed at
    const unlock = action === 'release' && lk === 'leftmouse' && this.doorMode && !this.menuActive;
    if (b && this.spaceJumpAdded && key.toLowerCase() === 'space' && this.player?.CarryingActor) return false;
    if (b) this.processBinding(b, action, delta);
    if (unlock) this.openDoorAtAim();
    return !!b;
  }

  setDoorMode(on) {
    this.doorMode = !!on;
    this.onNotice?.(on ? 'Door mode ON: casting opens any door (type alohomora again to turn it off)' : 'Door mode OFF');
  }

  // Door mode (toggled by typing alohomora, or ?doors=1): the door (mover) Harry casts at moves to its other
  // end (DoOpen / DoClose), together with the movers sharing its tag (double doors), whatever its lock or
  // trigger. The door is the locked target, else the nearest mover in Harry's way: fat lines from his eyes
  // along his facing (level, his view pitch, 15 down / up, 30 up; gates are bars, some hang high), no wall
  // first; else the first one on the line through the centre of the view. Returns the movers moved.
  openDoorAtAim(maxDist = 3000) {
    const lvl = this.level, p = this.player, vm = this.vm, P = lvl?.physics;
    if (!lvl || !p) return [];
    const isMover = a => a && !a.__deleted && a.Class.isA('Mover');
    const RU = Math.PI / 32768, ext = { X: 8, Y: 8, Z: 8 };
    const dirOf = r => ({ X: Math.cos(r.Pitch * RU) * Math.cos(r.Yaw * RU), Y: Math.cos(r.Pitch * RU) * Math.sin(r.Yaw * RU), Z: Math.sin(r.Pitch * RU) });
    // the first mover on a line (before any wall), with its distance
    const along = (loc, rot) => {
      const d = dirOf(rot);
      for (const h of P.multiLineCheck(loc, { X: loc.X + d.X * maxDist, Y: loc.Y + d.Y * maxDist, Z: loc.Z + d.Z * maxDist }, ext, false)) {
        if (h.actor === lvl.levelInfo) return null;
        if (isMover(h.actor)) return { m: h.actor, t: h.time };
      }
      return null;
    };
    const eye = { X: p.Location.X, Y: p.Location.Y, Z: p.Location.Z + (p.BaseEyeHeight || 0) };
    let door = isMover(p.rectarget?.victim) ? p.rectarget.victim : null;
    if (!door) {
      const vp = (p.ViewRotation || p.Rotation).Pitch << 16 >> 16, deg = 65536 / 360;
      let best = null;
      for (const pitch of [0, vp, -15 * deg, 15 * deg, 30 * deg]) {
        const h = along(eye, { Pitch: pitch | 0, Yaw: p.Rotation.Yaw, Roll: 0 });
        if (h && (!best || h.t < best.t)) best = h;
      }
      door = best?.m || null;
    }
    if (!door && this.lastView) door = along(this.lastView.loc, this.lastView.rot)?.m || null;
    if (!door) return [];
    const tag = String(door.Tag || '');
    const group = tag && tag.toLowerCase() !== 'mover' ? lvl.actors.filter(a => isMover(a) && String(a.Tag) === tag) : [door];
    // each cast flips the door to its other end: from its first key it opens (DoOpen), else it goes back
    // (DoClose) — some gates hang open and drop shut, so one way alone could leave them closed
    const opened = [];
    for (const m of group) {
      const f = vm.findFunction(m, (m.KeyNum | 0) === 0 ? 'doopen' : 'doclose');
      if (!f) continue;
      m.bDelaying = false;
      vm.invoke(f, m, []);
      opened.push(m);
    }
    if (opened.length) this.debug?.add('info', `door mode moved ${opened.map(m => `${m.Name} to key ${m.KeyNum}`).join(', ')}`, door);
    return opened;
  }

  keyType(ch) {
    if (this.console) this.vm.event(this.console, 'KeyType', ch.charCodeAt(0));
  }

  ikey(key) { return IK[key.toLowerCase()]; }

  // Called from GameLevel.tickActor for the player before its script tick
  playerTick(pawn, dt) {
    const vm = this.vm;
    // reset input axes, then accumulate held keys
    for (const p of pawn.Class.props) if ((p.flags & 0x4) && p.kind === 'FloatProperty') pawn[p.name] = 0;
    for (const k of this.keysDown) { const b = this.bindings.get(k); if (b) this.processBinding(b, 'hold', dt); }
    if (this.mouse.dx) { const b = this.bindings.get('mousex'); if (b) this.processBinding(b, 'axis', this.mouse.dx); }
    if (this.mouse.dy) { const b = this.bindings.get('mousey'); if (b) this.processBinding(b, 'axis', -this.mouse.dy); }
    this.mouse.dx = this.mouse.dy = 0;
    const scale = dt > 0 ? 20 / dt : 0;
    for (const p of pawn.Class.props) if ((p.flags & 0x4) && p.kind === 'FloatProperty') pawn[p.name] *= scale;
    this.playerRanPhysics = false;
    // UE1: the engine calls PlayerInput (axis remapping) natively before PlayerTick
    vm.event(pawn, 'PlayerInput', dt);
    vm.event(pawn, 'PlayerTick', dt);
    // ReadInput(-1): the input axes are scaled to zero after the tick
    for (const p of pawn.Class.props) if ((p.flags & 0x4) && p.kind === 'FloatProperty') pawn[p.name] = 0;
    if (this.console) vm.event(this.console, 'Tick', dt);
  }

  // ------------------------------------------------------------------ exec
  exec(cmd) {
    const s = String(cmd).trim();
    if (!s) return '';
    const vm = this.vm;
    const name = s.split(/\s+/)[0].toLowerCase();
    const args = s.slice(name.length).trim();
    const targets = [this.console, this.player, this.player?.myHUD, this.level?.game];
    for (const t of targets) {
      if (!t) continue;
      const f = vm.findFunction(t, name);
      if (f && (f.flags & FUNC.Exec)) {
        vm.invoke(f, t, parseExecArgs(f, args));
        return '';
      }
    }
    return this.engineCommand(name, args, s);
  }

  consoleCommand(cmd, src) { return this.exec(cmd); }

  engineCommand(name, args, full) {
    const vm = this.vm;
    switch (name) {
      case 'open': case 'start': case 'servertravel': this.travel(args); return '';
      case 'playersonly': if (this.level) this.level.levelInfo.bPlayersOnly = !this.level.levelInfo.bPlayersOnly; return '';
      case 'set': {
        const [cls, prop, ...val] = args.split(/\s+/);
        const c = vm.cls(cls);
        if (c) {
          const p = c.propByName.get(String(prop).toLowerCase());
          const v = parseVal(p, val.join(' '));
          c.defaults[p?.name || prop] = v;
          for (const a of this.level?.actors || []) if (a.Class.isChildOf(c)) a[p?.name || prop] = v;
        }
        return '';
      }
      case 'get': {
        const [cls, prop] = args.split(/\s+/);
        const c = vm.cls(cls);
        const p = c?.propByName.get(String(prop).toLowerCase());
        return c && p ? String(c.defaults[p.name]) : '';
      }
      case 'exit': case 'quit': this.onQuit?.(); return '';
      case 'savegame': {
        const slot = parseInt(args) || 0;
        if (this.level) storageSet('slot' + slot, snapshotLevel(this));
        return '';
      }
      case 'pause': if (this.level) this.level.paused = !this.level.paused; return '';
      default:
        this.onCommand?.(name, args, full);
        return '';
    }
  }

  // ------------------------------------------------------------------ canvas / render events
  canvasObject(w, h) {
    const vm = this.vm;
    if (!this.canvas) {
      this.canvas = vm.newObject(vm.cls('Canvas'), 'Canvas0');
      this.extraObjects.push(this.canvas);
    }
    const c = this.canvas;
    c.SizeX = w; c.SizeY = h; c.ClipX = w; c.ClipY = h;
    c.OrgX = 0; c.OrgY = 0; c.CurX = 0; c.CurY = 0; c.CurYL = 0; c.Z = 1; c.Style = 1;
    c.SpaceX = 0; c.SpaceY = 0; c.bCenter = false; c.bNoSmooth = false;
    c.DrawColor = { R: 127, G: 127, B: 127, A: 255 };
    c.Viewport = this.viewport;
    c.Font = c.SmallFont;
    return c;
  }

  // Canvas.DrawActor: render the actor this frame even if hidden (HUD/console 3D items)
  drawActorOnCanvas(c, actor) {
    if (actor) actor.__canvasFrame = this.frameNo;
  }

  preRender(w, h) {
    this.frameNo = (this.frameNo || 0) + 1;
    if (!this.player || !this.hud) return;
    const c = this.canvasObject(w, h);
    this.vm.event(this.player, 'PreRender', c);
    if (this.console) this.vm.event(this.console, 'PreRender', c);
  }

  postRender(w, h) {
    if (!this.player || !this.hud) return;
    const vp = this.viewport;
    if (vp) {
      vp.WindowsMouseX = this.mouseX ?? 0; vp.WindowsMouseY = this.mouseY ?? 0;
      vp.bWindowsMouseAvailable = true;
    }
    let c = this.canvasObject(w, h);
    this.vm.event(this.player, 'PostRender', c);
    c = this.canvasObject(w, h);
    if (this.console) this.vm.event(this.console, 'PostRender', c);
  }

  // ------------------------------------------------------------------ main tick
  tick(dt) {
    if (this.pendingTravel) return;
    // Level-start checkpoint for levels opened directly (no menu slot chosen): HPConsole.DoLevelSave(99)
    if (this.pendingAutosave && this.console && this.level && this.player) {
      this.pendingAutosave = false;
      const book = this.console.menuBook;
      if (!book || !book.SlotPage) {
        const f = this.vm.findFunction(this.console, 'dolevelsave');
        if (f) this.vm.invoke(f, this.console, [99]);
      }
    }
    for (const h of this.hooks.beforeTick) h(dt);
    if (this.level && !this.level.paused) this.level.tick(dt);
    else if (this.player) this.playerTick(this.player, 0);
    this.updateWeaponCoords();
    this.time += dt;
    for (const h of this.hooks.afterTick) h(dt);
  }

  // Pawn.WeaponLoc / WeaponRot: the renderer stores the weapon attach point of every drawn skeletal pawn
  // (UnSprite.cpp after DrawMesh), so script reads the last frame's hand position (carried crackers, wand FX);
  // pawns the renderer didn't draw (or no renderer) get it from the engine-side pose
  updateWeaponCoords() {
    const lvl = this.level;
    if (!lvl?.anim) return;
    for (const a of lvl.actors) {
      if (a.__deleted || a.bHidden || !a.Mesh || !(a.__isPawn ?? (a.__isPawn = a.Class.isA('Pawn')))) continue;
      if (a.__weaponDrawn) { a.__weaponDrawn = false; continue; } // the renderer stored it from the drawn pose
      const w = weaponCoords(lvl, a);
      if (!w) continue;
      a.WeaponLoc = w.loc; a.WeaponRot = w.rot; a.__weaponMatrix = w.matrix;
    }
  }
}

function cloneValue(v) {
  if (v === null || typeof v !== 'object' || v.__isUObject || v.__isClass) return v;
  if (Array.isArray(v)) return v.map(cloneValue);
  const o = {};
  for (const k in v) o[k] = cloneValue(v[k]);
  return o;
}

function mkOut(v) { const o = { __ref: true, v, get() { return this.v; }, set(x) { this.v = x; } }; return o; }

function parseExecArgs(f, args) {
  const out = [];
  let rest = args;
  f.params.forEach((p, i) => {
    if (i === f.params.length - 1 && (p.kind === 'StrProperty')) { out.push(rest); rest = ''; return; }
    const m = /^\s*("([^"]*)"|\S+)\s*/.exec(rest);
    if (!m) { out.push(undefined); return; }
    rest = rest.slice(m[0].length);
    out.push(parseVal(p, m[2] ?? m[1]));
  });
  return out;
}

function parseVal(p, s) {
  if (!p) return s;
  switch (p.kind) {
    case 'IntProperty': case 'ByteProperty': return parseInt(s) || 0;
    case 'FloatProperty': return parseFloat(s) || 0;
    case 'BoolProperty': return /^(true|1|yes|on)$/i.test(s);
    default: return s;
  }
}

// Locale files may be UTF-16LE (with BOM) or Big5/ANSI
function decodeLocale(u8) {
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  try { return new TextDecoder('big5').decode(u8); } catch { return new TextDecoder('latin1').decode(u8); }
}

// UE1 EInputKey codes for keys we forward to the console
export const IK = {
  backspace: 0x08, tab: 0x09, enter: 0x0d, shift: 0x10, ctrl: 0x11, alt: 0x12, pause: 0x13, capslock: 0x14,
  escape: 0x1b, space: 0x20, pageup: 0x21, pagedown: 0x22, end: 0x23, home: 0x24, left: 0x25, up: 0x26,
  right: 0x27, down: 0x28, insert: 0x2d, delete: 0x2e,
  '0': 0x30, '1': 0x31, '2': 0x32, '3': 0x33, '4': 0x34, '5': 0x35, '6': 0x36, '7': 0x37, '8': 0x38, '9': 0x39,
  a: 0x41, b: 0x42, c: 0x43, d: 0x44, e: 0x45, f: 0x46, g: 0x47, h: 0x48, i: 0x49, j: 0x4a, k: 0x4b, l: 0x4c, m: 0x4d,
  n: 0x4e, o: 0x4f, p: 0x50, q: 0x51, r: 0x52, s: 0x53, t: 0x54, u: 0x55, v: 0x56, w: 0x57, x: 0x58, y: 0x59, z: 0x5a,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75, f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
  leftmouse: 0x01, rightmouse: 0x02, middlemouse: 0x04, mousex: 0xe4, mousey: 0xe5, mousewheelup: 0xec, mousewheeldown: 0xed,
  tilde: 0xc0, slash: 0xbf, leftbracket: 0xdb, rightbracket: 0xdd,
};
