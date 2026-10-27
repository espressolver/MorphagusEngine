// Gesture natives (spell lessons), following KnowWonder's UGesture rules: the pattern's points are
// densified to 8 steps per segment; CompareGesture scores the traced points against them both ways
// (pattern points not reached, traced points off the pattern), CompareGesturePoint is the distance from a
// point to the nearest pattern point (at most 1).

// pattern points with 7 extra points between each pair (the engine's 7th uses 3/4 instead of 6/8 in
// CompareGesture — the same value)
function densify(g) {
  const pts = (g?.Points || []).filter(p => p);
  const out = [];
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k];
    out.push({ X: a.X, Y: a.Y });
    const b = pts[k + 1];
    if (b) for (let s = 1; s < 8; s++) out.push({ X: (b.X - a.X) * s / 8 + a.X, Y: (b.Y - a.Y) * s / 8 + a.Y });
  }
  return out;
}

const nearest = (p, list) => {
  let m = 1;
  for (const q of list) { const d = Math.hypot(p.X - q.X, p.Y - q.Y); if (d < m) m = d; }
  return m;
};

// the traced points: unused ones (Z = -1) and repeats (within 0.001) dropped
function traced(drawn) {
  const out = [];
  for (const p of (drawn || []).slice(0, 1024)) {
    if (!p || p.Z === -1) continue;
    if (out.some(q => Math.abs(q.X - p.X) < 0.001 && Math.abs(q.Y - p.Y) < 0.001)) continue;
    out.push({ X: p.X, Y: p.Y });
  }
  return out;
}

export function compareGesture(g, drawn, acc) {
  const mouse = traced(drawn), target = densify(g);
  let errors = 0, total = 0;
  for (const t of target) {
    const d = nearest(t, mouse);
    if (d > acc) { const e = Math.min(2, Math.trunc(1 + d / (acc * 5))); errors += e; total += e; }
    else total += 2;
  }
  for (const m of mouse) {
    const d = nearest(m, target);
    if (d > acc) { const e = Math.min(3, Math.trunc(d / acc)); errors += e; total += e; }
  }
  if (mouse.length < 10) { total += 500; errors += 500; }
  return Math.max(0, Math.min(1, 1 - errors / total));
}

export function installGestureNatives(vm) {
  vm.natives.set(427, (g, [pt]) => (pt ? nearest(pt, densify(g)) : 1));
  vm.natives.set(426, (g, [drawn, acc]) => compareGesture(g, drawn, acc));
}
