// Mirrored surfaces and warp-zone portals (URender::DrawFrame CreateChildFrame): the scene is drawn again from
// a virtual camera — the view reflected in the mirror plane, or carried through the two warp zones' WarpCoords —
// with the near plane on the portal plane, and the portal polygons show that image.
import * as THREE from 'three';

const vert = /* glsl */`
  #include <logdepthbuf_pars_vertex>
  uniform mat4 textureMatrix;
  varying vec4 vUv;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vUv = textureMatrix * wp;
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }
`;
const frag = /* glsl */`
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D tDiffuse;
  varying vec4 vUv;
  void main() {
    #include <logdepthbuf_fragment>
    gl_FragColor = vec4(texture2DProj(tDiffuse, vUv).rgb, 1.0);
  }
`;

// Unreal (X, Y, Z) -> three (x, z, y)
const T = v => new THREE.Vector3(v.X, v.Z, v.Y);

export class Portals {
  constructor(renderer) {
    this.renderer = renderer;
    this.list = [];
    this.target = new THREE.WebGLRenderTarget(1, 1, { samples: 0 });
    this.cam = new THREE.PerspectiveCamera();
  }

  // entry: { mesh (three, world coordinates), kind: 'mirror' | 'warp', normal, point (three), zone (warp: this
  // side's WarpZoneInfo, live) }
  add(e) {
    e.target = new THREE.WebGLRenderTarget(1, 1);
    e.texMatrix = new THREE.Matrix4();
    e.mesh.material = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: e.target.texture }, textureMatrix: { value: e.texMatrix } },
      vertexShader: vert, fragmentShader: frag, side: THREE.DoubleSide,
    });
    e.mesh.renderOrder = -1;
    this.list.push(e);
  }

  // the world -> world map of a warp portal: into this zone's frame (UnWarp), out of the other side's (Warp)
  warpMatrix(zone) {
    const other = zone?.OtherSideActor;
    if (!zone?.WarpCoords || !other?.WarpCoords) return null;
    const frame = W => {
      // WarpCoords maps world -> zone-local (rows = axes); the inverse is columns = axes plus Origin
      const m = new THREE.Matrix4(), x = T(W.XAxis), y = T(W.YAxis), z = T(W.ZAxis), o = T(W.Origin);
      // local (Unreal x, y, z) in three's (x, z, y) slots
      m.makeBasis(x, z, y).setPosition(o);
      return m;
    };
    return frame(other.WarpCoords).multiply(frame(zone.WarpCoords).invert());
  }

  render(scene, camera, width, height) {
    const r = this.renderer, frustum = new THREE.Frustum(), pm = new THREE.Matrix4();
    pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pm);
    const camPos = camera.position;
    for (const e of this.list) e.mesh.visible = false;
    for (const e of this.list) {
      if (!e.mesh.geometry.boundingSphere) e.mesh.geometry.computeBoundingSphere();
      if (!frustum.intersectsSphere(e.mesh.geometry.boundingSphere)) continue;
      const toCam = camPos.clone().sub(e.point);
      if (e.kind === 'mirror' && toCam.dot(e.normal) <= 0) continue;
      const vc = this.cam;
      vc.projectionMatrix.copy(camera.projectionMatrix);
      vc.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
      let clipN, clipP, map = null;
      if (e.kind === 'mirror') {
        // reflect the eye and its frame in the plane
        const n = e.normal, refl = v => v.clone().sub(n.clone().multiplyScalar(2 * v.clone().sub(e.point).dot(n)));
        const pos = refl(camPos);
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
        const target = refl(camPos.clone().add(fwd));
        vc.position.copy(pos);
        vc.up.copy(up.clone().reflect(n));
        vc.lookAt(target);
        vc.updateMatrixWorld();
        clipN = n.clone(); clipP = e.point.clone();
      } else {
        // (from inside the warp zone the portal is an ordinary zone boundary)
        if (toCam.dot(e.normal) > 0) continue;
        map = this.warpMatrix(e.zone);
        if (!map) continue;
        vc.matrixWorld.copy(map.clone().multiply(camera.matrixWorld));
        vc.matrixWorld.decompose(vc.position, vc.quaternion, vc.scale);
        vc.updateMatrixWorld(true);
        // the portal plane carried to the other side, keeping what lies beyond it
        clipN = e.normal.clone().transformDirection(map); clipP = e.point.clone().applyMatrix4(map);
      }
      vc.matrixWorldInverse.copy(vc.matrixWorld).invert();
      // texture matrix: bias x P x V (x the warp map for portals)
      e.texMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
      e.texMatrix.multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);
      if (map) e.texMatrix.multiply(map);
      // oblique near plane on the portal plane (Lengyel)
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(clipN, clipP).applyMatrix4(vc.matrixWorldInverse);
      const clip = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant), P = vc.projectionMatrix.elements;
      const q = new THREE.Vector4((Math.sign(clip.x) + P[8]) / P[0], (Math.sign(clip.y) + P[9]) / P[5], -1, (1 + P[10]) / P[14]);
      clip.multiplyScalar(2 / clip.dot(q));
      P[2] = clip.x; P[6] = clip.y; P[10] = clip.z + 1; P[14] = clip.w;
      e.target.setSize(width, height);
      const prev = r.getRenderTarget(), scissor = r.getScissorTest();
      r.setScissorTest(false);
      r.setRenderTarget(e.target);
      r.clear();
      r.render(scene, vc);
      r.setRenderTarget(prev);
      r.setScissorTest(scissor);
      e.mesh.visible = true;
    }
  }
}
