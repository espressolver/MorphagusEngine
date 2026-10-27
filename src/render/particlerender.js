// GPU billboards for ParticleFX systems.
import * as THREE from 'three';
import { shared } from './materials.js';

const vert = /* glsl */`
  attribute vec3 center;
  attribute vec2 corner;
  attribute vec4 pcolor;
  attribute vec3 psize;   // width, length, angle
  attribute vec3 pvel;
  uniform float isLine;
  varying vec2 vUv;
  varying vec4 vColor;
  void main() {
    vUv = corner * 0.5 + 0.5;
    vColor = pcolor;
    vec4 mv = modelViewMatrix * vec4(center, 1.0);
    if (isLine > 0.5) {
      vec3 dir = normalize((modelViewMatrix * vec4(center + pvel * 0.05, 1.0)).xyz - mv.xyz + vec3(1e-5));
      vec3 side = normalize(cross(dir, vec3(0.0, 0.0, 1.0)) + vec3(1e-5));
      mv.xyz += side * corner.x * psize.x * 0.5 + dir * corner.y * psize.y * 0.5;
    } else {
      float c = cos(psize.z), s = sin(psize.z);
      vec2 o = vec2(corner.x * psize.x, corner.y * psize.y) * 0.5;
      mv.xy += vec2(c * o.x - s * o.y, s * o.x + c * o.y);
    }
    gl_Position = projectionMatrix * mv;
  }`;
const frag = /* glsl */`
  uniform sampler2D map;
  uniform float additive;
  uniform float glow;
  varying vec2 vUv;
  varying vec4 vColor;
  void main() {
    vec4 t = texture2D(map, vUv);
    vec3 c = t.rgb * vColor.rgb * glow;
    if (additive > 0.5) gl_FragColor = vec4(c * vColor.a, 1.0);
    else { float a = t.a * vColor.a; if (a < 0.02) discard; gl_FragColor = vec4(c, a); }
    #include <colorspace_fragment>
  }`;

export class ParticleVisual {
  constructor(actor, textures, white) {
    this.actor = actor;
    this.textures = textures;
    this.white = white;
    this.group = new THREE.Group();
    this.meshes = new Map(); // texture exp -> { mesh, cap }
  }

  meshFor(texRef, tex) {
    const key = texRef?.exp || 'none';
    let m = this.meshes.get(key);
    if (m) return m;
    const a = this.actor;
    const style = a.Style ?? 1;
    const additive = style === 3 || style === 1; // particle textures are drawn translucent by default
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: tex || this.white }, additive: { value: additive ? 1 : 0 }, glow: { value: a.ScaleGlow ?? 1 }, isLine: { value: a.RenderPrimitive === 0 ? 1 : 0 } },
      vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    if (additive) { mat.blending = THREE.CustomBlending; mat.blendSrc = THREE.OneFactor; mat.blendDst = THREE.OneMinusSrcColorFactor; }
    const geo = new THREE.BufferGeometry();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    m = { mesh, cap: 0, geo, mat };
    this.meshes.set(key, m);
    this.group.add(mesh);
    if (texRef?.exp && !tex) {
      this.textures.fromExport(texRef.pkg, texRef.exp).then(t => { if (t) mat.uniforms.map.value = t; });
    }
    return m;
  }

  ensureCap(m, n) {
    if (m.cap >= n) return;
    const cap = Math.max(16, 1 << Math.ceil(Math.log2(n)));
    const geo = m.geo;
    const quadCorners = [-1, -1, 1, -1, 1, 1, -1, 1];
    const corner = new Float32Array(cap * 8);
    const index = new Uint32Array(cap * 6);
    for (let i = 0; i < cap; i++) {
      corner.set(quadCorners, i * 8);
      index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    geo.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
    geo.setAttribute('center', new THREE.BufferAttribute(new Float32Array(cap * 12), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('pcolor', new THREE.BufferAttribute(new Float32Array(cap * 16), 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('psize', new THREE.BufferAttribute(new Float32Array(cap * 12), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('pvel', new THREE.BufferAttribute(new Float32Array(cap * 12), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 12), 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    m.cap = cap;
  }

  update() {
    const a = this.actor;
    const list = a.__ps?.list || [];
    // the engine draws a whole system with its first texture
    const tex = (a.Textures || [])[0] || null;
    const byTex = new Map(list.length ? [[tex?.exp || 'none', { ref: tex, ps: list }]] : []);
    for (const [k, m] of this.meshes) if (!byTex.has(k)) m.geo.setDrawRange(0, 0);
    const glow = a.ScaleGlow ?? 1;
    for (const [k, { ref, ps }] of byTex) {
      const m = this.meshFor(ref, null);
      this.ensureCap(m, ps.length);
      m.mat.uniforms.glow.value = glow;
      const C = m.geo.attributes.center.array, P = m.geo.attributes.pcolor.array, S = m.geo.attributes.psize.array, Vv = m.geo.attributes.pvel.array;
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        for (let v = 0; v < 4; v++) {
          const o3 = (i * 4 + v) * 3, o4 = (i * 4 + v) * 4;
          // Unreal -> three coordinates (x, z, y)
          C[o3] = p.pos.X; C[o3 + 1] = p.pos.Z; C[o3 + 2] = p.pos.Y;
          Vv[o3] = p.vel.X; Vv[o3 + 1] = p.vel.Z; Vv[o3 + 2] = p.vel.Y;
          P[o4] = p.c[0]; P[o4 + 1] = p.c[1]; P[o4 + 2] = p.c[2]; P[o4 + 3] = Math.max(0, Math.min(1, p.Alpha));
          S[o3] = Math.max(0.1, p.Width); S[o3 + 1] = Math.max(0.1, p.Length || p.Width); S[o3 + 2] = p.Spin;
        }
      }
      for (const n of ['center', 'pcolor', 'psize', 'pvel']) m.geo.attributes[n].needsUpdate = true;
      m.geo.setDrawRange(0, ps.length * 6);
    }
  }
}
