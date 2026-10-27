// What opens what: walks Event / Dispatcher / cutscene "Trigger X" links back from a tag to the things a
// player can actually do - cast a spell at a spell target, or walk into a touch trigger / touch cutscene.
const lc = s => String(s ?? '').toLowerCase();
const castLines = c => { const out = []; for (let i = 0; i < 7; i++) { const s = c['Cast' + i + 'Script']; if (s) out.push(...Object.values(s).filter(x => typeof x === 'string')); } return out; };

export function actionsFor(L, tag, depth = 0, seen = new Set()) {
  if (!tag || lc(tag) === 'none' || depth > 6 || seen.has(lc(tag))) return [];
  seen.add(lc(tag));
  const out = [];
  for (const a of L.actors) {
    if (a.__deleted) continue;
    const evs = [a.Event, ...(a.OutEvents && typeof a.OutEvents === 'object' ? Object.values(a.OutEvents) : [])].map(lc);
    if (evs.includes(lc(tag))) {
      if (a.Class.isA('spellTrigger')) out.push({ type: 'cast', actor: a });
      else if (a.Class.isA('Pawn') && (a.eVulnerableToSpell | 0) > 0) out.push({ type: 'cast', actor: a }); // e.g. gnomes to flip
      else if (a.Class.isA('Trigger') && a.bCollideActors && !a.Class.isA('spellTrigger')) out.push({ type: 'touch', actor: a });
      else out.push(...actionsFor(L, a.Tag, depth + 1, seen)); // dispatchers, counters, untouchable triggers
    }
    if (a.Class.isA('CutScene') && castLines(a).some(l => new RegExp('^\\s*trigger\\s+' + tag + '\\s*$', 'i').test(l))) {
      if (a.bTouchStarts) out.push({ type: 'touch', actor: a });
      else out.push(...actionsFor(L, a.Tag, depth + 1, seen));
    }
  }
  return out;
}

// closed trigger-operated movers (doors, gates, bridges) with the actions that operate them
export function closedGates(L) {
  return L.actors.filter(m => m.__moverMesh && !m.__deleted && /^Trigger/.test(m.__state?.name || '') && (m.KeyNum | 0) === 0)
    .map(m => ({ door: m, actions: actionsFor(L, m.Tag) }));
}
