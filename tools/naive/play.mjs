// Plays one map's steps with a Bot (input only, except tp: a teleport to skip to the part under test). Shared by the Node test runner and the browser recorder.
import { STEPS } from './steps.mjs';

export const norm = m => String(m || '').toLowerCase().replace(/\.unr$/, '').replace(/[?#].*$/, '');

// generator: yields once per engine frame; returns { steps: [...] }
export function* playSteps(eng, bot, map, log = () => {}) {
  const L = eng.level, p = eng.player;
  const find = name => L.actors.find(a => a.Name === name && !a.__deleted);
  const steps = [];
  let r = yield* bot.wait(3);
  if (r !== 'travel') yield* bot.waitCutscenes();
  for (const step of STEPS[norm(map)] || []) {
    if (eng.pendingTravel) break;
    const t0 = bot.time;
    let out;
    if (step.tp) {
      // teleport (actor name or [x, y, z]), optionally facing yaw; for skipping to the part under test
      const g = typeof step.tp === 'string' ? find(step.tp) : null;
      const at = g ? { X: g.Location.X + (step.dx || 0), Y: g.Location.Y + (step.dy || 0), Z: g.Location.Z + (step.dz ?? 20) } : Array.isArray(step.tp) ? { X: step.tp[0], Y: step.tp[1], Z: step.tp[2] } : null;
      out = at && L.physics.farMoveActor(p, at) ? 'ok' : 'blocked';
      if (out === 'ok' && step.yaw !== undefined) { p.Rotation = { ...p.Rotation, Yaw: step.yaw }; p.ViewRotation = { ...p.ViewRotation, Yaw: step.yaw }; }
      if (out === 'ok') yield* bot.wait(0.5);
    } else if (step.stun) {
      // cast at each target until all are in the given state (default 'stunned')
      const want = (step.state || 'stunned').toLowerCase(), targets = step.stun.map(find).filter(Boolean);
      const done = () => targets.every(g => String(g.__state?.name).toLowerCase() === want);
      out = targets.length === step.stun.length ? 'timeout' : 'missing';
      for (let t0s = bot.time; out === 'timeout' && bot.time - t0s < (step.timeout ?? 300);) {
        if (done()) { out = 'done'; break; }
        const g = targets.filter(g => String(g.__state?.name).toLowerCase() !== want).sort((a, b) => Math.hypot(a.Location.X - p.Location.X, a.Location.Y - p.Location.Y) - Math.hypot(b.Location.X - p.Location.X, b.Location.Y - p.Location.Y))[0];
        const r = yield* bot.cast(g, { tries: 1 });
        if (r === 'travel') { out = r; break; }
        if (r === 'unreachable') yield* bot.wait(0.5);
      }
    } else if (step.go) {
      const g = find(step.go);
      out = g ? yield* bot.goTo(g, { radius: step.radius ?? Math.max(40, Math.min(g.CollisionRadius || 40, 120)), timeout: step.timeout ?? 300 }) : 'missing';
    } else if (step.solve) {
      const g = find(step.solve);
      out = g ? yield* bot.goSolve(g, { radius: step.radius ?? Math.max(40, Math.min(g.CollisionRadius || 40, 120)), timeout: step.timeout ?? 240 }) : 'missing';
    } else if (step.beans) out = yield* bot.collect(a => /JellyBean|Bean$/.test(a.Class.name), () => p.numBeans >= step.beans, step.timeout ?? 900);
    else if (step.bump) { const g = find(step.bump); out = g ? yield* bot.bump(g) : 'missing'; }
    else if (step.cast) { const g = find(step.cast); out = g ? yield* bot.cast(g) : 'missing'; }
    else if (step.lesson) out = yield* bot.lesson(find(step.lesson));
    else if (step.wait) out = yield* bot.wait(step.wait);
    if (out !== 'travel' && !eng.pendingTravel) yield* bot.waitCutscenes();
    const ok = ['arrived', 'done', 'travel', 'ok'].includes(out) || !!eng.pendingTravel;
    steps.push({ step: JSON.stringify(step), out, ok, sec: Math.round(bot.time - t0) });
    log(`  ${ok ? '✓' : '✗'} ${JSON.stringify(step).padEnd(40)} ${String(out).padEnd(8)} harry ${p.Location.X | 0},${p.Location.Y | 0},${(p.Location.Z - p.CollisionHeight) | 0} beans ${p.numBeans} t=${bot.time.toFixed(0)}`);
    if (!ok && !step.optional) break;
  }
  // after the last step the level should end by itself (cutscene -> ChangeLevel)
  for (let t = 0; t < 300 && !eng.pendingTravel; t += 1) if ((yield* bot.wait(1)) === 'travel') break;
  return { steps };
}
