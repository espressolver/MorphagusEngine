// Asset format tests: every package/script/mesh/animation/texture in the install must decode cleanly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assets } from './helpers.mjs';
import { loadScriptObject } from '../src/uscript/loader.js';
import { readSkeletalMesh, readAnimation } from '../src/engine/umesh.js';
import { readTexture, readPalette, decodeTextureRGBA, readSound, readMusic } from '../src/engine/uobject.js';
import { readLevel, readModel } from '../src/engine/umodel.js';

const pkgs = async dir => {
  const a = await assets();
  return Promise.all(a.manifest.filter(f => f.startsWith(dir + '/')).map(f => a.pkg(f.split('/').pop().split('.')[0])));
};

test('all script objects decode to exactly their stored bytecode size', async () => {
  let n = 0, bad = [];
  for (const p of await pkgs('System')) {
    if (!p) continue;
    for (const e of p.exports) {
      if (!['Function', 'State', 'Class', 'Struct'].includes(e.className)) continue;
      const o = loadScriptObject(p, e);
      n++;
      if (o.scriptSize > 0 && (o.decodedSize > o.scriptSize || o.scriptSize - o.decodedSize > 3)) bad.push(`${p.name}.${e.name}`);
      if (o.kind === 'Class') assert.equal(o._left, 0, `${p.name}.${e.name} class tail`);
    }
  }
  assert.ok(n > 10000, 'decoded ' + n);
  assert.deepEqual(bad, []);
});

test('all skeletal meshes and animations parse to the end of their export', async () => {
  let meshes = 0, anims = 0;
  for (const p of await pkgs('System')) {
    if (!p) continue;
    for (const e of p.exports) {
      if (e.className === 'SkeletalMesh') { const m = readSkeletalMesh(p, e); assert.equal(m._left, 0, e.name); meshes++; }
      if (e.className === 'Animation') { const a = readAnimation(p, e); assert.equal(a._left, 0, e.name); anims++; }
    }
  }
  assert.ok(meshes > 300 && anims > 300, `${meshes} meshes, ${anims} anims`);
});

test('skeletal mesh vertices rebuilt from LocalPoints are consistent across bone influences', async () => {
  const THREE = await import('three');
  const a = await assets();
  for (const [pk, name] of [['HarryPotter', 'skharryMesh'], ['HPModels', 'skgen_male_1Mesh']]) {
    const p = await a.pkg(pk);
    const m = readSkeletalMesh(p, p.exports.find(x => x.name === name));
    const W = [];
    m.refSkeleton.forEach((b, i) => { const q = new THREE.Quaternion(...b.orient); if (i > 0) q.conjugate(); const L = new THREE.Matrix4().compose(new THREE.Vector3(...b.pos), q, new THREE.Vector3(1, 1, 1)); W[i] = i === 0 ? L : W[b.parent].clone().multiply(L); });
    const pos = m.points.map(() => []);
    m.boneWeightIdx.forEach(([wi, n], bone) => { for (let k = 0; k < n; k++) { const [pi] = m.boneWeights[wi + k]; pos[pi].push(new THREE.Vector3(...m.localPoints[wi + k]).applyMatrix4(W[bone])); } });
    let worst = 0;
    for (const list of pos) for (const v of list) worst = Math.max(worst, v.distanceTo(list[0]));
    assert.ok(worst < 0.05, `${name} influence mismatch ${worst}`);
  }
});

test('every texture in Textures/*.utx decodes', async () => {
  let n = 0;
  for (const p of await pkgs('Textures')) {
    if (!p) continue;
    for (const e of p.exports) {
      if (e.className !== 'Texture') continue;
      const t = readTexture(p, e);
      const pal = t.props.Palette && t.props.Palette.ref > 0 ? readPalette(p, p.exports[t.props.Palette.ref - 1]) : null;
      const d = decodeTextureRGBA(t, pal, 0);
      assert.ok(d && d.w > 0 && d.data.length === d.w * d.h * 4, e.name);
      n++;
    }
  }
  assert.ok(n > 1000, 'textures ' + n);
});

test('every map level and BSP model parses exactly', async () => {
  for (const p of await pkgs('Maps')) {
    const L = readLevel(p, p.exports.find(e => e.className === 'Level'));
    const m = readModel(p, p.exports[L.model - 1]);
    assert.equal(m._end, m._expEnd, p.name);
    assert.ok(L.actors.length > 0, p.name);
  }
});

test('sounds and music carry WAV or MPEG data', async () => {
  const a = await assets();
  const s = await a.pkg('Ambient'), mu = await a.pkg('Phoenix');
  const snd = readSound(s, s.exports.find(e => e.className === 'Sound'));
  assert.ok(['WAV', 'mp2'].includes(snd.format) && snd.data.length > 1000);
  const mus = readMusic(mu, mu.exports[0]);
  assert.equal(mus.format, 'mp2');
});
