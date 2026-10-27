// Parity tests: particle emission (UnParticleFX.cpp EmitParticles).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engine, tick } from './helpers.mjs';
import { meshWorldVerts } from '../src/game/engine/bones.js';

test('DIST_OwnerMesh: particles start on a triangle of the owner mesh in its pose, along its normal', async () => {
  const e = await engine('Lev_Tut3'); tick(e, 0.5);
  const fx = e.level.actors.find(a => a.Class.name === 'Lock' && !a.__deleted && a.Owner?.Mesh);
  assert.ok(fx, 'a padlock spark system');
  const zero = { Base: 0, Rand: 0 };
  Object.assign(fx, { SourceDepth: zero, SourceWidth: zero, SourceHeight: zero, Speed: zero, GravityModifier: 0, Gravity: { X: 0, Y: 0, Z: 0 }, Damping: 0, Chaos: 0, Attraction: { X: 0, Y: 0, Z: 0 }, ParticlesAlive: 0, ParticlesMax: 0, bVelocityRelative: false });
  fx.ParticlesPerSec = { Base: 200, Rand: 0 };
  const P = e.level.particles, S = P.state(fx);
  S.list.length = 0;
  fx.LastEmitLocation = { ...fx.Location };
  const n = P.emit(fx, 0.1);
  assert.ok(n > 5, 'emitted ' + n);
  const { verts, tris } = meshWorldVerts(e.level, fx.Owner);
  const onTri = q => tris.some(([i0, i1, i2]) => {
    const a = verts[i0], b = verts[i1], c = verts[i2];
    const e1 = [b.X - a.X, b.Y - a.Y, b.Z - a.Z], e2 = [c.X - a.X, c.Y - a.Y, c.Z - a.Z], d = [q.X - a.X, q.Y - a.Y, q.Z - a.Z];
    const nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]], l = Math.hypot(...nrm);
    return l > 1e-6 && Math.abs((d[0] * nrm[0] + d[1] * nrm[1] + d[2] * nrm[2]) / l) < 1e-3;
  });
  for (const p of S.list) assert.ok(onTri(p.pos), 'on the mesh surface: ' + JSON.stringify(p.pos));
  e.restoreConsole();
});
