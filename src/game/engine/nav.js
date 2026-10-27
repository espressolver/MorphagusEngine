// Navigation graph from the level's ReachSpecs; implements Pawn path-finding natives.
export class NavGraph {
  constructor(level, reachSpecs) {
    this.level = level;
    this.edges = new Map(); // node -> [{ to, dist, radius, height }]
    const byExp = level.objMap;
    const pkg = level.pkg;
    const act = ref => (ref > 0 ? byExp.get(pkg.exports[ref - 1]) : null);
    // every spec by index (NavigationPoint.Paths[] holds these indices), pruned ones included
    this.specs = (reachSpecs || []).map(rs => ({ start: act(rs.start), end: act(rs.end) }));
    for (const rs of reachSpecs || []) {
      if (rs.pruned) continue;
      const a = act(rs.start), b = act(rs.end);
      if (!a || !b) continue;
      if (!this.edges.has(a)) this.edges.set(a, []);
      this.edges.get(a).push({ to: b, dist: Math.max(1, rs.distance), radius: rs.radius, height: rs.height });
    }
    this.nodes = level.actors.filter(x => x.Class.isA('NavigationPoint'));
    // nodes that are part of the path network (cut marks etc. without reach specs can't start or end a route)
    this.linked = new Set();
    for (const [a, list] of this.edges) { this.linked.add(a); for (const e of list) this.linked.add(e.to); }
  }

  // Dijkstra from start to any node satisfying goal(); returns path array [start..goal]
  route(start, goal, pawn) {
    if (!start) return null;
    const dist = new Map([[start, 0]]), prev = new Map(), open = [start], done = new Set();
    const r = pawn?.CollisionRadius || 0, h = pawn?.CollisionHeight || 0;
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (dist.get(open[i]) < dist.get(open[bi])) bi = i;
      const n = open.splice(bi, 1)[0];
      if (done.has(n)) continue;
      done.add(n);
      if (goal(n)) {
        const path = [n];
        for (let c = n; prev.has(c);) { c = prev.get(c); path.unshift(c); }
        return path;
      }
      for (const e of this.edges.get(n) || []) {
        if (e.radius && r > e.radius + 1) continue;
        if (e.height && h > e.height + 1) continue;
        if (e.to.__deleted || done.has(e.to)) continue;
        const nd = dist.get(n) + e.dist;
        if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, n); open.push(e.to); }
      }
    }
    return null;
  }

  // Nearest node the pawn can reach directly
  nearestNode(pawn, loc = pawn.Location, maxDist = 1200) {
    const P = this.level.physics;
    let best = null, bd = Infinity;
    for (const n of this.nodes) {
      if (n.__deleted || (this.linked.size && !this.linked.has(n))) continue;
      const d = Math.hypot(n.Location.X - loc.X, n.Location.Y - loc.Y, n.Location.Z - loc.Z);
      if (d >= bd || d > maxDist) continue;
      if (P.trace(loc, n.Location, null, false, pawn)) continue;
      best = n; bd = d;
    }
    return best;
  }

  setRoute(pawn, path) {
    if (!Array.isArray(pawn.RouteCache)) return;
    for (let i = 0; i < pawn.RouteCache.length; i++) pawn.RouteCache[i] = path?.[i] || null;
  }

  // FindPathTo / FindPathToward: next waypoint toward a location (or actor)
  findPathTo(pawn, dest, destActor) {
    const P = this.level.physics;
    if (!P.trace(pawn.Location, dest, null, false, pawn)) { this.setRoute(pawn, destActor ? [destActor] : []); return destActor || null; }
    const start = this.nearestNode(pawn);
    if (!start) return null;
    const endNode = destActor && destActor.Class.isA('NavigationPoint') ? destActor : this.nearestNode(pawn, dest);
    if (!endNode) return null;
    const path = this.route(start, n => n === endNode, pawn);
    if (!path) return null;
    // skip the start node if we're already there
    const route = path.length > 1 && Math.hypot(start.Location.X - pawn.Location.X, start.Location.Y - pawn.Location.Y) < (pawn.CollisionRadius || 20) * 2 ? path.slice(1) : path;
    this.setRoute(pawn, route);
    return route[0] || null;
  }

  // HP APawn::findPath (UnRoute.cpp): depth-first over each node's Paths[] specs (either end that isn't
  // visited yet), descending only into nodes of the start point's class, until a node named DestName turns
  // up; the result is the second entry of the search stack (the first step), or the goal when it is next to
  // the start. No size checks. Each node's list is scanned twice (the "upstream" pass) before backing up.
  findPath(pawn, start, destName) {
    if (!start) return null;
    const target = String(destName || '').toLowerCase();
    const cls = start.Class, stack = [start], tested = [-1], visited = new Set([start]);
    let upstream = false;
    for (;;) {
      const top = stack.length - 1;
      if (top < 0) return null;
      const node = stack[top];
      tested[top]++;
      const idx = node.Paths?.[tested[top]] ?? -1;
      if (idx < 0) {
        if (upstream) { stack.pop(); tested.pop(); if (stack.length) tested[stack.length - 1] = -1; upstream = false; }
        else { upstream = true; tested[top] = -1; }
        continue;
      }
      const spec = this.specs[idx];
      if (!spec) continue;
      const next = spec.start && !visited.has(spec.start) ? spec.start : spec.end && !visited.has(spec.end) ? spec.end : null;
      if (!next) continue;
      visited.add(next);
      if (String(next.Name).toLowerCase() === target) return stack[1] || next;
      if (next.Class === cls) { stack.push(next); tested.push(-1); }
    }
  }

  randomDest(pawn) {
    const start = this.nearestNode(pawn);
    const cands = this.nodes.filter(n => !n.__deleted);
    for (let i = 0; i < 8 && cands.length; i++) {
      const goal = cands[(Math.random() * cands.length) | 0];
      const path = this.route(start, n => n === goal, pawn);
      if (path && path.length > 1) { this.setRoute(pawn, path.slice(1)); return goal; }
    }
    return null;
  }
}
