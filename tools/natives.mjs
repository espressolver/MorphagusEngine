import fs from 'fs';
import { UPackage } from '../src/engine/upackage.js';
import { loadScriptObject, EX, FUNC } from '../src/uscript/loader.js';
const pk = {};
for (const f of fs.readdirSync('../HarryPotter/System').filter(f => f.endsWith('.u'))) {
  const b = fs.readFileSync('../HarryPotter/System/' + f);
  pk[f.slice(0, -2)] = new UPackage(f.slice(0, -2), b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
// native function table: name -> {iNative, owner, flags}
const natives = [], byIdx = new Map(), byName = new Map();
for (const [n, p] of Object.entries(pk)) for (const e of p.exports) if (e.className === 'Function') {
  const o = loadScriptObject(p, e);
  if (o.flags & FUNC.Native) {
    const owner = p.refName(e.package);
    const rec = { pkg: n, owner, name: e.name, iNative: o.iNative, flags: o.flags, uses: 0 };
    natives.push(rec);
    if (o.iNative) byIdx.set(o.iNative, rec);
    const k = e.name.toLowerCase(); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(rec);
  }
}
const GAME = new Set(['Engine','HPBase','HarryPotter','HPMenu','HProps','HPModels','HPParticle','HPSounds','HPDialog','HPPuzzle','Hub2','Hub3','Hub4','Hub5','Hog1','Hog2','Tut1','Tut2','Tut3','Fire','UWindow','Core','UnrealShare','DProps']);
const walk = (n, p) => {
  if (!n || typeof n !== 'object') return;
  if (n.op === EX.FirstNative && byIdx.has(n.native)) byIdx.get(n.native).uses++;
  if (n.op === EX.FinalFunction) { const nm = p.refName(n.func)?.toLowerCase(); for (const r of byName.get(nm) || []) r.uses++; }
  if (n.op === EX.VirtualFunction || n.op === EX.GlobalFunction) { for (const r of byName.get(n.fname.toLowerCase()) || []) r.uses++; }
  for (const k in n) if (k !== 'mem' && typeof n[k] === 'object') { const v = n[k]; if (Array.isArray(v)) v.forEach(x => walk(x, p)); else walk(v, p); }
};
for (const [n, p] of Object.entries(pk)) if (GAME.has(n)) for (const e of p.exports) if (['Function','State','Class'].includes(e.className)) {
  const o = loadScriptObject(p, e); for (const s of o.code) walk(s, p);
}
const used = natives.filter(r => r.uses > 0);
console.log('natives total', natives.length, 'used', used.length);
const own = {}; for (const r of used) own[r.pkg + '.' + r.owner] = (own[r.pkg + '.' + r.owner] || 0) + 1;
console.log(own);
fs.writeFileSync('tools/natives.json', JSON.stringify(natives.map(({ pkg, owner, name, iNative, flags, uses }) => ({ pkg, owner, name, iNative, flags, uses })), null, 1));
console.log(used.filter(r => !['Object'].includes(r.owner)).sort((a, b) => b.uses - a.uses).map(r => `${r.owner}.${r.name}${r.flags & FUNC.Latent ? '[L]' : ''}${r.flags & FUNC.Iterator ? '[I]' : ''}:${r.uses}`).join('  '));
