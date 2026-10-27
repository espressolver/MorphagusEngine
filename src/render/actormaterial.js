// Vertex-lit material for actor meshes (UE1 style: ambient + up to 6 point lights, no shadows).
import * as THREE from 'three';
import { PF } from '../engine/upackage.js';
import { shared, VOLFOG_GLSL } from './materials.js';

const vert = /* glsl */`
  #include <common>
  #include <skinning_pars_vertex>
  #ifdef USE_SKINNING
    attribute vec4 skinIndex1; attribute vec4 skinWeight1;
    attribute vec4 skinIndex2; attribute vec4 skinWeight2;
    attribute vec4 skinIndex3; attribute vec4 skinWeight3;
  #endif
  #include <logdepthbuf_pars_vertex>
  uniform vec3 ambient;
  uniform vec3 lightPos[6];
  uniform vec3 lightColor[6];
  uniform float lightRadius[6];
  uniform float lightRMult[6];
  uniform float lightSrc[6];
  uniform vec3 lightDir[6];
  uniform float diffuse;
  uniform float specular;
  uniform float specMinCos;
  uniform vec3 unlitLight;
  uniform float fogZone;
  uniform float style;
  varying vec3 vFogAdd;
  ${VOLFOG_GLSL}
  uniform float unlit;
  uniform float envMap;
  varying vec2 vUv;
  varying vec3 vLight;
  varying float vFogDepth;
  void main() {
    vUv = uv;
    #include <beginnormal_vertex>
    #include <begin_vertex>
    #ifdef USE_SKINNING
      // all influences (up to 16 in four sets), like the engine's weighted skinning
      mat4 skinM = skinWeight.x * getBoneMatrix(skinIndex.x) + skinWeight.y * getBoneMatrix(skinIndex.y)
                 + skinWeight.z * getBoneMatrix(skinIndex.z) + skinWeight.w * getBoneMatrix(skinIndex.w);
      skinM += skinWeight1.x * getBoneMatrix(skinIndex1.x) + skinWeight1.y * getBoneMatrix(skinIndex1.y)
             + skinWeight1.z * getBoneMatrix(skinIndex1.z) + skinWeight1.w * getBoneMatrix(skinIndex1.w);
      skinM += skinWeight2.x * getBoneMatrix(skinIndex2.x) + skinWeight2.y * getBoneMatrix(skinIndex2.y)
             + skinWeight2.z * getBoneMatrix(skinIndex2.z) + skinWeight2.w * getBoneMatrix(skinIndex2.w);
      skinM += skinWeight3.x * getBoneMatrix(skinIndex3.x) + skinWeight3.y * getBoneMatrix(skinIndex3.y)
             + skinWeight3.z * getBoneMatrix(skinIndex3.z) + skinWeight3.w * getBoneMatrix(skinIndex3.w);
      skinM = bindMatrixInverse * skinM * bindMatrix;
      objectNormal = (skinM * vec4(objectNormal, 0.0)).xyz;
      transformed = (skinM * vec4(transformed, 1.0)).xyz;
    #endif
    vec4 wp = modelMatrix * vec4(transformed, 1.0);
    vec3 n = normalize(mat3(modelMatrix) * objectNormal);
    // FLightManager::LightAndFog: ambient + each light's colour x incidence (radial, planar or ambient
    // source) x ScaleGlow*2 x min(1, (radius - distance) / (radius - inner radius)), clamped to 1;
    // unlit: ScaleGlow/2 + AmbientGlow/256
    vec3 L;
    if (unlit < 0.5) {
      L = ambient;
      for (int i = 0; i < 6; i++) {
        vec3 d = lightPos[i] - wp.xyz;
        float ls = length(d);
        vec3 lv = lightSrc[i] > 1.5 ? n * ls : lightSrc[i] > 0.5 ? lightDir[i] * ls : d;
        float G = lightSrc[i] > 1.5 ? 1.0 : lightSrc[i] > 0.5 ? dot(lightDir[i], n) : dot(d, n) / max(ls, 1e-4);
        G = max(G * diffuse, 0.0);
        if (specular > 0.0) {
          // the light vector mirrored by the normal, against the eye-to-vertex vector
          vec3 pv = wp.xyz - cameraPosition;
          float S = dot(lv - 2.0 * n * dot(lv, n), pv);
          if (S > 0.0) {
            S = S * S / (dot(lv, lv) * dot(pv, pv)) - specMinCos;
            if (S > 0.0) G += specular * S;
          }
        }
        if (G > 0.0) {
          G *= min(1.0, (lightRadius[i] - ls) * lightRMult[i]);
          L = max(L + lightColor[i] * G, lightColor[i].r < 0.0 ? vec3(0.0) : vec3(-1e9));
        }
      }
      L = clamp(L, 0.0, 1.0);
    } else L = unlitLight;
    vLight = L;
    // volumetric fog in a fog zone, added as the vertex specular colour (not on translucent / modulated)
    vFogAdd = fogZone > 0.5 && style < 2.5 ? vertexFog(wp.xyz - cameraPosition) : vec3(0.0);
    if (envMap > 0.5) {
      vec3 vn = normalize(mat3(viewMatrix) * n);
      vUv = vn.xy * 0.5 + 0.5;
    }
    vec4 mv = viewMatrix * wp;
    vFogDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }
`;
const frag = /* glsl */`
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D map;
  uniform float masked;
  uniform float glow;
  uniform float opacity;
  uniform float style;
  uniform vec3 fogColor;
  uniform float fogDensity;
  uniform vec3 tint;
  varying vec2 vUv;
  varying vec3 vLight;
  varying float vFogDepth;
  varying vec3 vFogAdd;
  void main() {
    #include <logdepthbuf_fragment>
    vec4 t = texture2D(map, vUv);
    if (masked > 0.5 && t.a < 0.5) discard;
    // modulated polygons are drawn with a white vertex colour (D3D DrawGouraudPolygon)
    vec3 c = style > 3.5 ? t.rgb : t.rgb * vLight * tint + vFogAdd;
    if (style > 2.5 && style < 3.5) c *= opacity; // translucent fade
    if (fogDensity > 0.0) c = mix(c, fogColor, clamp(1.0 - exp(-fogDensity * vFogDepth), 0.0, 1.0));
    gl_FragColor = vec4(c, (style > 2.5 && style < 3.5) ? 1.0 : opacity);
    #include <colorspace_fragment>
  }
`;

// style: 1 normal, 2 masked, 3 translucent, 4 modulated (UE1 ERenderStyle)
export function makeActorMaterial(tex, polyFlags, lightUniforms, opts = {}) {
  const style = opts.style || 1;
  const texMasked = tex?.userData?.masked;
  const masked = style === 2 || (polyFlags & PF.Masked) || texMasked;
  const translucent = style === 3 || (polyFlags & PF.Translucent);
  const modulated = style === 4 || (polyFlags & PF.Modulated);
  const unlit = opts.unlit || (polyFlags & PF.Unlit);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: tex },
      masked: { value: masked ? 1 : 0 },
      unlit: { value: unlit ? 1 : 0 },
      envMap: { value: (polyFlags & PF.Environment) || opts.envMap ? 1 : 0 },
      style: { value: translucent ? 3 : modulated ? 4 : 1 },
      ambient: lightUniforms.ambient,
      lightPos: lightUniforms.lightPos,
      lightColor: lightUniforms.lightColor,
      lightRadius: lightUniforms.lightRadius,
      lightRMult: lightUniforms.lightRMult,
      lightSrc: lightUniforms.lightSrc,
      lightDir: lightUniforms.lightDir,
      diffuse: lightUniforms.diffuse,
      specular: lightUniforms.specular,
      specMinCos: lightUniforms.specMinCos,
      unlitLight: lightUniforms.unlitLight,
      fogZone: lightUniforms.fogZone,
      volCount: shared.volCount, volPos: shared.volPos, volColor: shared.volColor, volRadius: shared.volRadius,
      volBright: shared.volBright, volFog: shared.volFog, volAmb: shared.volAmb,
      glow: lightUniforms.glow,
      opacity: lightUniforms.opacity,
      tint: opts.tint || { value: new THREE.Color(1, 1, 1) },
      fogColor: shared.fogColor,
      fogDensity: shared.fogDensity,
    },
    vertexShader: vert,
    fragmentShader: frag,
    side: (polyFlags & PF.TwoSided) || masked ? THREE.DoubleSide : THREE.FrontSide,
  });
  if (translucent) {
    mat.transparent = true; mat.depthWrite = false;
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.OneFactor; mat.blendDst = THREE.OneMinusSrcColorFactor;
  } else if (modulated) {
    mat.transparent = true; mat.depthWrite = false;
    mat.blending = THREE.CustomBlending;
    mat.blendSrc = THREE.DstColorFactor; mat.blendDst = THREE.SrcColorFactor;
  } else if (opts.fade) {
    mat.transparent = true;
  }
  if (!tex) mat.uniforms.map.value = opts.white;
  return mat;
}
