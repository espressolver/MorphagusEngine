// List closed trigger-operated doors (movers) and what opens them: the Event / Dispatcher chain back to a
// spell target (cast), a touch trigger (walk in), a cutscene, or a character script.
// usage: node tools/naive/gates.mjs Map
import { engine } from '../../tests/helpers.mjs';

const map = process.argv[2];
const eng = await engine(map); eng.restoreConsole();
const L = eng.level;
const lc = s => String(s ?? '').toLowerCase();
const loc = a => [a.Location.X, a.Location.Y, a.Location.Z].map(v => v | 0).join(',');
const castLines = c => { const out = []; for (let i = 0; i < 7; i++) { const s = c['Cast' + i + 'Script']; if (s) out.push(...Object.values(s).filter(x => typeof x === 'string')); } return out; };
function sources(tag, depth = 0, seen = new Set()) {
  if (!tag || lc(tag) === 'none' || depth > 5 || seen.has(lc(tag))) return [];
  seen.add(lc(tag));
  const out = [];
  for (const a of L.actors) {
    if (a.__deleted) continue;
    const evs = [a.Event, ...(a.OutEvents && typeof a.OutEvents === 'object' ? Object.values(a.OutEvents) : [])].map(lc);
    if (evs.includes(lc(tag))) {
      if (a.Class.isA('Dispatcher') || (a.Class.isA('Trigger') && !a.bCollideActors)) {
        const up = sources(a.Tag, depth + 1, seen);
        out.push(...(up.length ? up.map(u => `${u} -> ${a.Class.name}:${a.Name}`) : [`(nothing triggers ${a.Class.name}:${a.Name} tag=${a.Tag})`]));
      } else {
        const how = a.Class.isA('spellTrigger') ? `CAST ${a.Name}@${loc(a)} (${a.eVulnerableToSpell})` : a.Class.isA('Trigger') ? `TOUCH ${a.Name}@${loc(a)}` : `${a.Class.name}:${a.Name}@${loc(a)}`;
        out.push(how);
      }
    }
    if (a.Class.isA('CutScene') && castLines(a).some(l => new RegExp('^\\s*trigger\\s+' + tag + '\\s*$', 'i').test(l))) {
      const up = a.bTouchStarts ? [`TOUCH-CUT ${a.Name}@${loc(a)}`] : sources(a.Tag, depth + 1, seen).map(u => `${u} -> cut:${a.Name}`);
      out.push(...(up.length ? up : [`(cutscene ${a.Name} tag=${a.Tag})`]));
    }
  }
  return out;
}
for (const m of L.actors) {
  if (!m.__moverMesh || m.__deleted || !/^Trigger/.test(m.__state?.name || '') || (m.KeyNum | 0) !== 0) continue;
  console.log(`DOOR ${m.Name} tag=${m.Tag} @${loc(m)} ${m.__state.name}`);
  for (const s of sources(m.Tag)) console.log('   <- ' + s);
}
