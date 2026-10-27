import * as THREE from 'three';
import { Assets } from './engine/assets.js';
import { TextureCache } from './render/textures.js';
import { Engine } from './game/engine/engine.js';
import { GameRenderer } from './render/gamerenderer.js';
import { HudCanvas, gameViewRect } from './render/hudcanvas.js';
import { AudioSystem } from './audio/audio.js';
import { installDebug } from './debugui.js';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
// UE1's D3D renderer blends texels and light values as stored (gamma space): no colour-space conversion
THREE.ColorManagement.enabled = false;
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.autoClear = false;
document.body.appendChild(renderer.domElement);
addEventListener('resize', () => renderer.setSize(innerWidth, innerHeight));

const params = new URLSearchParams(location.search);
const assets = new Assets('game/'); // relative: the site may live in a sub-directory
assets.lang = params.get('lang') || 'tra';
const loadText = document.getElementById('loadtext');
const loadBar = document.getElementById('loadbar');
let loaded = 0;
assets.onProgress = f => { loaded++; loadText.textContent = 'Loading ' + f; loadBar.style.width = Math.min(100, loaded * 2) + '%'; };

const ctx = { assets, renderer, brightness: { value: 1.0 } };
const engine = new Engine(assets);
const view = new GameRenderer(ctx, engine);
window.__engine = engine; window.__view = view; window.__ctx = ctx;
const debugUI = installDebug(engine, view, !!params.get('debug'));
// short notices from the engine (special modes)
engine.onNotice = msg => {
  const d = document.createElement('div');
  d.textContent = msg;
  d.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:60;padding:6px 14px;font:13px sans-serif;color:#fff;background:#2a6c;border-radius:4px;pointer-events:none';
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 2500);
};
if (params.get('doors')) engine.setDoorMode(true);
// the fps / position line and the map picker are developer tools: shown with ?debug=1 only (the game view
// now fills the window, so they would sit on top of it)
if (!params.get('debug')) for (const id of ['hud', 'maps']) document.getElementById(id).style.display = 'none';

// ---------------- input -> UE1 key names
const KEYMAP = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Space: 'Space', Enter: 'Enter',
  Escape: 'Escape', ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Ctrl', ControlRight: 'Ctrl',
  AltLeft: 'Alt', AltRight: 'Alt', Tab: 'Tab', Backspace: 'Backspace', Backquote: 'Tilde', Slash: 'Slash',
  PageUp: 'PageUp', PageDown: 'PageDown', Home: 'Home', End: 'End', Insert: 'Insert', Delete: 'Delete',
  BracketLeft: 'LeftBracket', BracketRight: 'RightBracket', Pause: 'Pause', CapsLock: 'CapsLock',
};
const keyName = e => KEYMAP[e.code] || (e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : /^F\d+$/.test(e.code) ? e.code : null);
addEventListener('keydown', e => {
  const k = keyName(e);
  if (!k) return;
  if (!e.repeat && debugUI.onKey(k)) { e.preventDefault(); return; }
  if (!e.repeat) engine.keyEvent(k, 'press');
  if (e.key.length === 1) engine.keyType(e.key);
  if (k !== 'F12' && k !== 'F5') e.preventDefault();
});
addEventListener('keyup', e => { const k = keyName(e); if (k) engine.keyEvent(k, 'release'); });
const cvs = renderer.domElement;
cvs.addEventListener('mousedown', e => {
  engine.menuActive = !!engine.console?.menuBook?.bIsOpen;
  if (document.pointerLockElement !== cvs && !engine.menuActive) cvs.requestPointerLock?.();
  engine.keyEvent(['LeftMouse', 'MiddleMouse', 'RightMouse'][e.button] || 'LeftMouse', 'press');
});
addEventListener('mouseup', e => engine.keyEvent(['LeftMouse', 'MiddleMouse', 'RightMouse'][e.button] || 'LeftMouse', 'release'));
addEventListener('mousemove', e => {
  const vr = engine.hud?.view || gameViewRect();
  engine.mouseX = e.clientX - vr.x; engine.mouseY = e.clientY - vr.y;
  if (document.pointerLockElement === cvs) { engine.mouse.dx += e.movementX; engine.mouse.dy += e.movementY; }
});
addEventListener('contextmenu', e => e.preventDefault());

function startLevelMusic() {
  const a = engine.audio, li = engine.level?.levelInfo;
  if (!a?.ctx || a.ctx.state !== 'running' || !li) return;
  if (!a.music && li.Song && !engine.player?.Song) a.playMusic(li.Song, 1);
}

async function start(map, travel = null, restore = null, options = '') {
  engine.audio?.stopAll();
  document.getElementById('loading').style.display = 'flex';
  const t0 = performance.now();
  const level = await engine.loadMap(map, options, travel);
  if (restore) engine.restoreSave(restore);
  // fresh level: let HPConsole take its level-start checkpoint save (as after ChangeLevel)
  else if (engine.console && !/^(startup|entry)$/i.test(map)) { engine.console.bLoadNewLevel = true; engine.pendingAutosave = true; }
  await view.setLevel(level);
  // ?debug=1 enables the game's own debug mode (e.g. hold Space to fast-forward cutscenes)
  if (params.get('debug') && engine.console) engine.console.bDebugMode = true;
  // ?pos / ?yaw (debug reproduce URLs) apply to the first map only
  if (!start.placed) { start.placed = true; debugUI.placePlayer(params); }
  console.log('map', map, 'ready in', (performance.now() - t0) | 0, 'ms');
  document.getElementById('loading').style.display = 'none';
}

async function boot() {
  await assets.init();
  ctx.textures = new TextureCache(assets, renderer);
  ctx.textures.assets = assets;
  await engine.init();
  // class defaults (numbers / bools) under a texture's saved properties, e.g. FireTexture.bRising
  ctx.textures.classDefaults = name => {
    let d = null;
    try { d = engine.vm.cls(name)?.defaults; } catch { /* not a script class */ }
    const out = {};
    if (d) for (const k in d) if (typeof d[k] === 'number' || typeof d[k] === 'boolean') out[k] = d[k];
    return out;
  };
  engine.hud = new HudCanvas(ctx.textures);
  engine.audio = new AudioSystem(engine);
  const unlock = () => { engine.audio.resume(); startLevelMusic(); };
  addEventListener('keydown', unlock); addEventListener('mousedown', unlock);
  const sel = document.getElementById('maps');
  for (const f of assets.manifest.filter(f => f.startsWith('Maps/'))) sel.add(new Option(f.slice(5, -4), f.slice(5, -4)));
  // no ?map=: the engine's LocalMap (Default.ini [URL], Startup.unr — the main menu)
  const localMap = String(engine.ini?.URL?.LocalMap || 'Startup.unr').replace(/\.unr$/i, '');
  const initial = params.get('map') || assets.manifest.find(f => f.toLowerCase() === `maps/${localMap.toLowerCase()}.unr`)?.slice(5, -4) || 'Lev_Tut1';
  sel.value = initial;
  sel.onchange = () => { history.replaceState(null, '', '?map=' + sel.value); engine.travel(sel.value); };
  await start(initial);
  requestAnimationFrame(frame);
}

const hud = document.getElementById('hud');
let last = performance.now(), acc = 0, fpsAcc = 0, fpsN = 0, fps = 0, traveling = false;
const STEP = 1 / 60;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  fpsAcc += dt; fpsN++; if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
  if (engine.pendingTravel && !traveling) {
    traveling = true;
    const t = engine.pendingTravel; engine.pendingTravel = null;
    history.replaceState(null, '', '?map=' + t.map + (params.get('debug') ? '&debug=1' : ''));
    start(t.map, t.travel, t.restore, t.options || '').catch(e => console.error(e)).finally(() => { traveling = false; });
    return;
  }
  if (traveling) return;
  // UE1 ticks once per rendered frame with the real frame time (no fixed-step judder);
  // long frames are split so physics stays stable.
  if (window.__drive) window.__drive(dt); // test/automation driver advances the engine itself
  else {
    let remaining = dt;
    while (remaining > 1e-4) { const step = Math.min(remaining, 1 / 30); engine.tick(step); remaining -= step; }
  }
  ctx.textures.update(dt);
  const hc = engine.hud;
  // menus and the start-up map are 4:3 screens: draw them in a centred 4:3 frame
  hc.frame43 = !!engine.console?.menuBook?.bIsOpen || /^(startup|entry)$/i.test(engine.level?.mapName || '');
  hc.begin();
  view.viewRect = hc.view;
  engine.preRender(hc.width, hc.height);
  view.render(dt);
  engine.lastView = view.lastView;
  engine.postRender(hc.width, hc.height);
  hc.end();
  engine.audio.update(view.lastView);
  const p = engine.player;
  hud.textContent = `${engine.level?.levelInfo?.Title || ''}  ${fps.toFixed(0)} fps  draw ${renderer.info.render.calls}\n` +
    (p ? `${p.Class.name} ${p.__state?.name || ''}  ${p.Location.X.toFixed(0)},${p.Location.Y.toFixed(0)},${p.Location.Z.toFixed(0)}  anim ${p.AnimSequence}` : '');
}

boot().catch(e => { loadText.textContent = 'Error: ' + e.message; console.error(e); });
