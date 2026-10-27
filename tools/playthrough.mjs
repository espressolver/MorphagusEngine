// Full-game playthrough harness: plays the story chain in order, carrying travel state between maps.
// Per map: skip cutscenes, walk Harry to the exit along the nav graph with real key input,
// fall back to forcing the exit trigger, then check the travel destination.
// usage: node tools/playthrough.mjs [startMap] [maxMaps]
import { engine, tick, cutscenePlaying } from '../tests/helpers.mjs';

const CHAIN = 'Lev_Tut1,Lev_Tut1b,Lev_Tut2,Lev_Tut3,Lev_Tut3b,Lev2_HogFront,Lev2_Inc_A,Lev2_Inc_B,Lev2_HogFront_2,Lev2_RemChase,Lev2_HogFront_3,Lev2_Fire2,Lev2_fire1,Lev2_Quid1,Lev3_Intro,Lev3_Lumos,Lev3_PreDungeon,Lev3_Dungeon,Lev3_DungeonB,Lev3_PreTroll,Lev3_Troll,Lev3_Quid2,Lev4_Sneak,Lev4_Sneak2,Lev5_Fluffy,Lev5_Snare,Lev5_FlyKeys,Lev5_Chess,Lev5_Final,Snapes_Office,startup'.split(',');
const norm = m => String(m || '').toLowerCase().replace(/\.unr$/, '').replace(/[?#].*$/, '');
const start = Math.max(0, CHAIN.findIndex(m => norm(m) === norm(process.argv[2] || CHAIN[0])));
const maxMaps = +(process.argv[3] || CHAIN.length - 1);

const castLines = a => { const out = []; for (let i = 0; i < 7; i++) { const s = a['Cast' + i + 'Script']; if (s) for (const k in s) if (typeof s[k] === 'string' && s[k]) out.push(s[k]); } return out; };
function exits(L) {
  const out = [];
  for (const a of L.actors) {
    if (a.__deleted) continue;
    if (a.Class.isA('CutScene') && castLines(a).some(l => /\b(changelevel|loadlevel)\b/i.test(l))) out.push(a);
    else if (a.Class.isA('TriggerChangeLevel')) out.push(a);
  }
  return out.sort((x, y) => (y.bTouchStarts ? 1 : 0) - (x.bTouchStarts ? 1 : 0));
}

const dist2 = (a, b) => Math.hypot(a.X - b.X, a.Y - b.Y);
function walkToward(eng, target, seconds) {
  const p = eng.player, L = eng.level;
  let held = false, lastPos = { ...p.Location }, stuck = 0, t = 0, wp = null, repath = 0;
  const release = () => { if (held) { eng.keyEvent('Up', 'release'); held = false; } };
  const res = tick(eng, seconds, 1 / 30, () => {
    t += 1 / 30;
    if (cutscenePlaying(eng) || !/PlayerWalking|Walking/i.test(p.__state?.name || '')) { release(); return; }
    if ((repath -= 1 / 30) <= 0 || !wp || dist2(p.Location, wp.Location) < 40) {
      wp = L.nav.findPathTo(p, target.Location, null) || target;
      repath = 0.5;
    }
    const dx = wp.Location.X - p.Location.X, dy = wp.Location.Y - p.Location.Y;
    const yaw = Math.round(Math.atan2(dy, dx) * 32768 / Math.PI) & 65535;
    p.ViewRotation = { ...p.ViewRotation, Yaw: yaw }; p.Rotation = { ...p.Rotation, Yaw: yaw };
    if (!held) { eng.keyEvent('Up', 'press'); held = true; }
    if (Math.floor(t) !== Math.floor(t - 1 / 30)) {
      const moved = dist2(p.Location, lastPos); lastPos = { ...p.Location };
      if (moved < 30) { stuck++; eng.keyEvent('Space', 'press'); eng.keyEvent('Space', 'release'); } else stuck = 0;
    }
  });
  release();
  return { traveled: res, reached: dist2(p.Location, target.Location) < Math.max(80, target.CollisionRadius || 0), stuck };
}

const RU = Math.PI / 32768;
// Map-specific gameplay the generic exit search can't do; return true once the level's goal was played
const SOLVERS = {
  // put Fluffy's three heads to sleep with the flute, facing each head from inside its attack cone
  lev5_fluffy(eng) {
    const p = eng.player, L = eng.level, f = L.actors.find(a => a.Class.name === 'Fluffy');
    for (const name of ['CutScene0', 'CutScene2']) {
      const c = L.actors.find(a => a.Name === name);
      L.physics.setLocation(p, { ...c.Location }); tick(eng, 1);
      for (let s = 0; s < 120 && cutscenePlaying(eng); s++) tick(eng, 1);
    }
    if (!p.Flute) { if (process.env.PT_DEBUG) console.log('   no flute', p.__state?.name, 'travel', eng.pendingTravel?.map); return false; }
    for (let t0 = L.timeSeconds; L.timeSeconds - t0 < 240 && f.__state?.name !== 'asleep' && !/dead/i.test(p.__state?.name);) {
      const head = f.Heads.find(x => !x.bSleeping);
      if (!head) { tick(eng, 1); continue; }
      const yaw = f.Rotation.Yaw * RU, dir = { X: Math.cos(yaw), Y: Math.sin(yaw) };
      const along = (head.Location.X - f.Location.X) * dir.X + (head.Location.Y - f.Location.Y) * dir.Y;
      const dd = (p.CollisionRadius + f.AttackDist) * 0.8;
      L.physics.setLocation(p, { X: head.Location.X - dir.X * (along - dd), Y: head.Location.Y - dir.Y * (along - dd), Z: p.Location.Z + 5 });
      const fy = Math.round(Math.atan2(head.Location.Y - p.Location.Y, head.Location.X - p.Location.X) / RU) & 65535;
      p.Rotation = { ...p.Rotation, Yaw: fy }; p.ViewRotation = { ...p.ViewRotation, Yaw: fy };
      tick(eng, 0.2);
      eng.keyEvent('LeftMouse', 'press');
      for (let t = 0; t < 60 && !head.bSleeping; t++) { tick(eng, 0.25); if (head.__state?.name !== 'listening' && t > 2) break; }
      eng.keyEvent('LeftMouse', 'release'); tick(eng, 0.3);
    }
    if (process.env.PT_DEBUG) console.log('   fluffy', f.__state?.name, 'heads', f.Heads.map(x => x.bSleeping ? 'Z' : x.__state?.name).join(','), 'harry', p.__state?.name, 'travel', eng.pendingTravel?.map);
    return f.__state?.name === 'asleep' || f.Heads.every(x => x.bSleeping);
  },
};

function settle(eng, seconds) {
  // let scripted sequences play out (cutscenes, dialogs); returns true on travel
  for (let s = 0; s < seconds; s += 2) if (tick(eng, 2)) return true;
  return false;
}

const report = [];
let travel = null;
for (let i = start; i < Math.min(CHAIN.length - 1, start + maxMaps); i++) {
  const map = CHAIN[i], expect = CHAIN[i + 1];
  const t0 = Date.now();
  const eng = await engine(map, { travel });
  const p = eng.player, L = eng.level;
  const row = { map, method: '', next: '', ok: false, beans: 0, issues: [] };
  try {
    // intro
    let traveled = settle(eng, 6);
    for (let s = 0; !traveled && s < 180 && cutscenePlaying(eng); s += 2) traveled = tick(eng, 2);
    const ex = exits(L);
    row.exits = ex.map(e => e.Name).join(',');
    const solver = SOLVERS[norm(map)];
    if (!traveled && solver) {
      const played = solver(eng);
      traveled = !!eng.pendingTravel || settle(eng, 120);
      row.method = traveled ? 'played' : played ? 'played(no-exit)' : 'solver-failed';
    }
    if (!traveled && ex.length) {
      const goal = ex.find(e => e.bTouchStarts) || null;
      if (goal) {
        const w = walkToward(eng, goal, 90);
        traveled = w.traveled || settle(eng, 20);
        if (traveled) row.method = 'walked';
        else if (w.reached) row.method = 'walked(no-start)';
        if (!traveled) { L.physics.setLocation(p, { ...goal.Location }); traveled = tick(eng, 1) || settle(eng, 30); if (traveled) row.method = 'teleport-touch'; }
      }
      if (!traveled) {
        // force the exit: fire its Tag event (what the level's gameplay would trigger)
        for (const e of ex) {
          eng.vm.event(e, 'Trigger', p, p);
          if ((traveled = tick(eng, 1) || settle(eng, 240))) { row.method = row.method || 'forced:' + e.Name; break; }
        }
      }
    } else if (traveled && !row.method) row.method = 'intro';
    if (eng.pendingTravel) {
      row.next = norm(eng.pendingTravel.map);
      row.ok = row.next === norm(expect);
      travel = eng.pendingTravel.travel || travel;
      row.items = !!eng.pendingTravel.items;
    }
    row.beans = p.numBeans; row.hp = p.lifePotions; row.state = p.__state?.name;
  } catch (e) { row.issues.push('FATAL ' + e.stack.split('\n').slice(0, 3).join(' | ')); }
  eng.restoreConsole();
  row.issues.push(...new Set(eng.issues));
  row.sec = ((Date.now() - t0) / 1000).toFixed(0);
  report.push(row);
  console.log(`${row.ok ? 'OK  ' : 'FAIL'} ${map.padEnd(16)} -> ${(row.next || '-').padEnd(16)} expect ${norm(expect).padEnd(16)} ${row.method.padEnd(22)} beans=${row.beans} hp=${row.hp} ${row.sec}s exits=${row.exits}`);
  for (const s of row.issues.slice(0, 8)) console.log('       ' + s);
  if (!row.ok && !eng.pendingTravel) travel = eng.captureTravel();
}
import('fs').then(fs => fs.writeFileSync(process.env.PT_OUT || 'playthrough.json', JSON.stringify(report, null, 1)));
