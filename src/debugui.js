// Debug mode (?debug=1): an overlay with the map, time, player / camera state, the actor at the crosshair and
// the latest issue; F8 toggles it, F9 saves a snapshot (JSON download + reproduce URL to the clipboard),
// F10 locks the crosshair actor and lists all its properties. ?pos=x,y,z&yaw=n puts the player there on load.
// window.__debug.snapshot() / .issues / .focus work in any mode.

export function installDebug(engine, view, enabled) {
  const dbg = engine.debug;
  let shown = enabled, locked = null, lastText = '';

  // anything the page logs or throws goes to the issue log too (script issues are already there)
  const wrap = (kind, orig) => (...args) => {
    const s = args.map(a => (a instanceof Error ? a.stack || a.message : typeof a === 'object' ? safe(a) : String(a))).join(' ');
    if (!s.startsWith('[US]')) dbg.add(kind, s, null);
    return orig(...args);
  };
  console.warn = wrap('warn', console.warn.bind(console));
  console.error = wrap('error', console.error.bind(console));
  addEventListener('error', e => dbg.add('error', `${e.message} @ ${e.filename}:${e.lineno}`, null));
  addEventListener('unhandledrejection', e => dbg.add('error', 'unhandled rejection: ' + (e.reason?.stack || e.reason), null));

  const panel = document.createElement('pre');
  panel.style.cssText = 'position:fixed;right:8px;top:44px;z-index:50;max-width:46vw;max-height:80vh;overflow:auto;margin:0;padding:8px 10px;' +
    'font:11px/1.35 ui-monospace,Menlo,monospace;color:#e8e8e8;background:rgba(10,10,14,.82);border:1px solid #555;border-radius:6px;white-space:pre-wrap;pointer-events:auto';
  panel.style.display = shown ? 'block' : 'none';
  document.body.appendChild(panel);

  const fmt = v => (v ? `${v.X.toFixed(0)},${v.Y.toFixed(0)},${v.Z.toFixed(0)}` : '-');
  const one = a => (a ? `${a.Name} (${a.Class?.name})${a.__state?.name ? ' [' + a.__state.name + ']' : ''} @ ${fmt(a.Location)}` : '-');

  function update() {
    if (!shown) return;
    const lvl = engine.level, p = engine.player, v = engine.lastView;
    if (!lvl) return;
    const f = locked && !locked.__deleted ? locked : dbg.focusActor(v);
    const last = dbg.issues[dbg.issues.length - 1];
    let text = `DEBUG  F8 hide · F9 save snapshot · F10 ${locked ? 'unlock' : 'lock'} target\n` +
      `map    ${lvl.mapName}  "${lvl.levelInfo?.Title || ''}"  t=${(lvl.timeSeconds || 0).toFixed(1)}s  frame ${engine.frameNo || 0}\n` +
      `player ${one(p)}\n` +
      `       yaw ${p?.Rotation?.Yaw | 0}  phys ${p?.Physics}  zone ${p?.Region?.Zone?.Name || '-'}  base ${p?.Base?.Name || '-'}  anim ${p?.AnimSequence}\n` +
      `camera ${fmt(v?.loc)}  yaw ${v?.rot?.Yaw | 0} pitch ${v?.rot?.Pitch | 0}  view ${v?.actor?.Name || '-'}\n` +
      `target ${locked ? '(locked) ' : ''}${one(f)}\n` +
      `issues ${dbg.total} (${dbg.counts.size} kinds)` + (last ? `\n  last: [${last.kind}] ${last.object ? last.object.name + ' ' : ''}${last.msg.slice(0, 160)}` : '');
    if (locked && !locked.__deleted) text += '\n\n' + safe(dbg.describeActor(locked), 2);
    if (text !== lastText) { panel.textContent = text; lastText = text; }
  }
  setInterval(update, 200);

  function saveSnapshot() {
    const snap = dbg.snapshot({ focus: locked && !locked.__deleted ? locked : undefined });
    const json = JSON.stringify(snap, null, 1);
    console.log('[debug] snapshot', snap);
    const blob = new Blob([json], { type: 'application/json' }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hpdebug_${snap.map}_${snap.levelTime}s.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    const summary = `${location.origin}${location.pathname}${snap.reproduce}\nmap ${snap.map} t=${snap.levelTime}s player ${fmt(engine.player?.Location)}` +
      (snap.focus ? `\ntarget ${snap.focus.name} (${snap.focus.class}) @ ${fmt(snap.focus.loc)}` : '');
    navigator.clipboard?.writeText(summary).catch(() => {});
    flash('snapshot saved; reproduce URL copied');
    return snap;
  }

  function flash(msg) {
    const d = document.createElement('div');
    d.textContent = msg;
    d.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:60;padding:6px 12px;font:12px sans-serif;color:#fff;background:#2a6;border-radius:4px';
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 1800);
  }

  // returns true when the key was a debug key
  function onKey(k) {
    if (!enabled) return false;
    if (k === 'F8') { shown = !shown; panel.style.display = shown ? 'block' : 'none'; return true; }
    if (k === 'F9') { saveSnapshot(); return true; }
    if (k === 'F10') { locked = locked ? null : dbg.focusActor(engine.lastView); window.__debug.focus = locked; update(); return true; }
    return false;
  }

  // ?pos=x,y,z&yaw=n: put the player there once the level is up
  function placePlayer(params) {
    const pos = params.get('pos'), p = engine.player;
    if (!pos || !p || !engine.level) return;
    const [X, Y, Z] = pos.split(',').map(Number);
    if (![X, Y, Z].every(Number.isFinite)) return;
    engine.level.physics.farMoveActor(p, { X, Y, Z });
    const yaw = +params.get('yaw');
    if (Number.isFinite(yaw)) { p.Rotation = { ...p.Rotation, Yaw: yaw | 0 }; p.ViewRotation = { ...(p.ViewRotation || p.Rotation), Yaw: yaw | 0 }; }
    flash(`moved to ${X},${Y},${Z}`);
  }

  window.__debug = {
    snapshot: opts => dbg.snapshot(opts),
    save: saveSnapshot,
    get issues() { return dbg.issues; },
    focus: null,
    describe: a => dbg.describeActor(a),
    find: name => engine.level?.actors.find(a => String(a.Name).toLowerCase() === String(name).toLowerCase()) || null,
  };
  return { onKey, placePlayer };
}

function safe(o, indent) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(o, (k, v) => {
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[circular]';
        seen.add(v);
        if (v.Class && v.Name && k) return `${v.Class.name}'${v.Name}'`;
      }
      return v;
    }, indent);
  } catch { return String(o); }
}
