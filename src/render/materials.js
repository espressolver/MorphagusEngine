// UE1-style surface materials for BSP and brushes.
import * as THREE from 'three';
import { PF } from '../engine/upackage.js';

export const MAX_DYN = 8;
export const MAX_VOL = 8;
export const shared = {
  time: { value: 0 },
  dynPos: { value: Array.from({ length: MAX_DYN }, () => new THREE.Vector3()) },
  dynColor: { value: Array.from({ length: MAX_DYN }, () => new THREE.Color(0, 0, 0)) },
  dynRadius: { value: new Array(MAX_DYN).fill(1) },
  fogColor: { value: new THREE.Color(0, 0, 0) },
  fogDensity: { value: 0 },
  levelTime: { value: 0 },
  // volumetric (fog-zone) lights, farthest first
  volCount: { value: 0 },
  volPos: { value: Array.from({ length: MAX_VOL }, () => new THREE.Vector3()) },
  volColor: { value: Array.from({ length: MAX_VOL }, () => new THREE.Vector3()) },
  volRadius: { value: new Array(MAX_VOL).fill(1) },
  volBright: { value: new Array(MAX_VOL).fill(0) },
  volFog: { value: new Array(MAX_VOL).fill(0) },
  volAmb: { value: new Array(MAX_VOL).fill(0) },
};

// FLightManager::Volumetric: the fog line integral of one light's sphere (density 1 - r^2/R^2) along the
// eye-to-point vector V (L: light relative to the eye); 0..1
export const VOLFOG_GLSL = /* glsl */`
  uniform int volCount;
  uniform vec3 volPos[${MAX_VOL}];
  uniform vec3 volColor[${MAX_VOL}];
  uniform float volRadius[${MAX_VOL}];
  uniform float volBright[${MAX_VOL}];
  uniform float volFog[${MAX_VOL}];
  uniform float volAmb[${MAX_VOL}];
  float volumetric(int i, vec3 V) {
    float R = volRadius[i], R2 = R * R, rR = 1.0 / R;
    if (volAmb[i] > 0.5) return min(length(V) * rR * volBright[i], 1.0);
    vec3 L = volPos[i] - cameraPosition;
    float S = dot(L, V), Ls2 = dot(L, L);
    if (Ls2 >= R2 && S < 0.0) return 0.0;
    float V2 = max(dot(V, V), 1e-6);
    float d = Ls2 - S * S / V2;
    if (R2 < d) return 0.0;
    float Vs = sqrt(V2), c0 = S / Vs, h = sqrt(R2 - d), c1 = c0 - Vs, c2;
    bool full = false;
    if (c0 > h) { c2 = h; if (c1 < -h) { c1 = -h; full = true; } }
    else { c2 = c0; if (c1 < -h) c1 = -h; }
    if (c1 >= c2) return 0.0;
    float D2 = d / R2, I = 3.0 - 3.0 * D2;
    c2 *= rR;
    float F;
    if (full) F = 2.0 * volBright[i] * (c2 * (I - c2 * c2));
    else { c1 *= rR; F = volBright[i] * ((c2 * (I - c2 * c2)) - (c1 * (I - c1 * c1))); }
    return clamp(F, 0.0, 1.0);
  }
  // surface fog map (0..127 per channel and alpha): each light through its palette (round(F x 255) x colour,
  // at most 127), merged over the previous ones by ByteFog ((127 - a) x old / 127)
  vec4 surfaceFog(vec3 V) {
    vec4 dst = vec4(0.0);
    for (int i = 0; i < ${MAX_VOL}; i++) {
      if (i >= volCount) break;
      float F = volumetric(i, V);
      if (F <= 0.0) continue;
      float li = floor(F * 255.0 + 0.5);
      vec3 col = min(floor(li * floor(volColor[i] * 65536.0) / 65536.0), vec3(127.0));
      float a = min(floor(li * floor(volFog[i] * 65536.0) / 65536.0), 127.0);
      dst.rgb = min(floor((127.0 - a) * dst.rgb / 127.0) + col, vec3(127.0));
      dst.a = min(dst.a + a, 127.0);
    }
    return dst;
  }
  // actor vertex fog (LightAndFog): value = 2 x integral; added as the vertex specular colour
  vec3 vertexFog(vec3 V) {
    vec4 fog = vec4(0.0);
    for (int i = 0; i < ${MAX_VOL}; i++) {
      if (i >= volCount) break;
      float v = 2.0 * volumetric(i, V);
      if (v <= 0.0) continue;
      float A = min(volFog[i] * v, 1.0);
      fog.rgb = min(volColor[i] * v + fog.rgb * (1.0 - A), vec3(1.0));
      fog.a = min(A + fog.a, 1.0);
    }
    return fog.rgb;
  }
`;

const vert = /* glsl */`
  attribute vec2 uv1;
  varying vec2 vUv;
  varying vec2 vLm;
  varying float vFogDepth;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  uniform float levelTime;
  uniform vec2 panSpeed;
  uniform vec2 texSize;
  uniform float wavy;
  void main() {
    // UnRender: auto-pan by LevelTime x 35 x the zone's TexU/VPanSpeed texels (1/256 steps, wrapping at
    // 1024); SmallWavy adds 8 sin T + 4 cos 2.3T (and 8 cos T + 4 sin 2.3T)
    vec2 pan = vec2(0.0);
    if (panSpeed.x != 0.0) pan.x = mod(floor(levelTime * 35.0 * panSpeed.x * 256.0 + 0.5), 262144.0) / 256.0;
    if (panSpeed.y != 0.0) pan.y = mod(floor(levelTime * 35.0 * panSpeed.y * 256.0 + 0.5), 262144.0) / 256.0;
    if (wavy > 0.0) pan += vec2(8.0 * sin(levelTime) + 4.0 * cos(2.3 * levelTime), 8.0 * cos(levelTime) + 4.0 * sin(2.3 * levelTime));
    vUv = uv + pan / texSize;
    vLm = uv1;
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vFogDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }
`;
const frag = /* glsl */`
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D map;
  uniform sampler2D lightMap;
  uniform float masked;
  uniform float unlit;
  uniform float modulated;
  uniform vec3 fogColor;
  uniform float fogDensity;
  uniform float brightness;
  uniform vec3 dynPos[8];
  uniform vec3 dynColor[8];
  uniform float dynRadius[8];
  uniform float fogZone;
  ${VOLFOG_GLSL}
  varying vec2 vUv;
  varying vec2 vLm;
  varying float vFogDepth;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  void main() {
    #include <logdepthbuf_fragment>
    vec4 t = texture2D(map, vUv);
    if (masked > 0.5 && t.a < 0.5) discard;
    vec3 c;
    if (modulated > 0.5) c = t.rgb;
    else if (unlit > 0.5) c = t.rgb;
    else {
      vec3 L = texture2D(lightMap, vLm).rgb * 2.0;
      // moving lights have no shadow mask (filled with 127): 127 x incidence x (2s^3 - 3s^2 + 1) through the
      // light's palette, on the lightmap's 0..127 scale (x 4/255 on screen), saturating at 127
      for (int i = 0; i < 8; i++) {
        vec3 d = dynPos[i] - vWorld;
        float dd = dot(d, d);
        float r = dynRadius[i];
        if (dd < r * r) {
          float dl = sqrt(dd), s = dl / r;
          float inc = max(dot(vNormalW, d) / max(dl, 1e-4), 0.0);
          L += dynColor[i] * (127.0 * 4.0 / 255.0) * inc * (2.0 * s * s * s - 3.0 * s * s + 1.0);
        }
      }
      L = min(L, vec3(127.0 * 4.0 / 255.0));
      c = t.rgb * L * brightness;
    }
    // fog map pass: dst x (1 - A) + RGB (RGBA7 doubled on upload)
    if (fogZone > 0.5) {
      vec4 f = surfaceFog(vWorld - cameraPosition);
      c = c * (1.0 - f.a * 2.0 / 255.0) + f.rgb * 2.0 / 255.0;
    }
    gl_FragColor = vec4(c, 1.0);
    #include <colorspace_fragment>
  }
`;

// zone: the surface's ZoneInfo properties (TexUPanSpeed / TexVPanSpeed, bFogZone)
export function makeSurfaceMaterial(tex, lightMap, flags, ctx, zone = null) {
  const masked = (flags & PF.Masked) || (tex && tex.userData && tex.userData.masked);
  const translucent = flags & PF.Translucent;
  const modulated = flags & PF.Modulated;
  const unlit = (flags & PF.Unlit) || (flags & PF.FakeBackdrop) || !lightMap;
  const p = (tex && tex.userData && tex.userData.props) || {};
  const pan = new THREE.Vector2((flags & PF.AutoUPan) ? (zone?.TexUPanSpeed ?? 1) : 0, (flags & PF.AutoVPan) ? (zone?.TexVPanSpeed ?? 1) : 0);
  const texSize = new THREE.Vector2((tex?.userData?.w || 64) * (p.DrawScale || 1), (tex?.userData?.h || 64) * (p.DrawScale || 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: tex },
      lightMap: { value: lightMap },
      masked: { value: masked ? 1 : 0 },
      unlit: { value: unlit ? 1 : 0 },
      modulated: { value: modulated ? 1 : 0 },
      time: shared.time,
      levelTime: shared.levelTime,
      texSize: { value: texSize },
      fogZone: { value: zone?.bFogZone && !translucent ? 1 : 0 },
      volCount: shared.volCount, volPos: shared.volPos, volColor: shared.volColor, volRadius: shared.volRadius,
      volBright: shared.volBright, volFog: shared.volFog, volAmb: shared.volAmb,
      fogColor: shared.fogColor,
      fogDensity: shared.fogDensity,
      brightness: ctx?.brightness || { value: 1 },
      dynPos: shared.dynPos, dynColor: shared.dynColor, dynRadius: shared.dynRadius,
      panSpeed: { value: pan },
      wavy: { value: (flags & PF.SmallWavy) ? 1 : 0 },
    },
    vertexShader: vert,
    fragmentShader: frag,
    side: (flags & PF.TwoSided) || masked ? THREE.DoubleSide : THREE.FrontSide,
  });
  if (translucent) {
    // UE1 translucency: dst = src + dst * (1 - src)
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.OneFactor;
    mat.blendDst = THREE.OneMinusSrcColorFactor;
  } else if (modulated) {
    mat.transparent = true;
    mat.depthWrite = false;
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.DstColorFactor;
    mat.blendDst = THREE.SrcColorFactor;
  }
  return mat;
}
