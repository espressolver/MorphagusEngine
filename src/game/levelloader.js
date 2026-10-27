// Loads a map package: actors (with class defaults), BSP geometry, sky zone.
import * as THREE from 'three';
import { readLevel } from '../engine/umodel.js';
import { mergeProps } from '../engine/uclass.js';
import { buildLevelGeometry } from '../render/level.js';
import { shared } from '../render/materials.js';
import { World } from './world.js';

export const UROT = Math.PI / 32768;

// Unreal location -> three vector
export function uvec(v) { return new THREE.Vector3(v?.x || 0, v?.z || 0, v?.y || 0); }

export async function loadLevel(ctx, mapName) {
  const { assets, classes } = ctx;
  const pkg = await assets.pkg(mapName);
  if (!pkg) throw new Error('map not found: ' + mapName);
  // Load every package this map imports (textures, sounds, classes) in parallel
  await assets.preloadDeps(pkg);
  for (const im of pkg.imports) if (im.package === 0 && im.className === 'Package') {
    const p = await assets.pkg(im.name);
    if (p && p.exports.some(e => e.className === 'Class')) await classes.loadPackage(im.name);
  }
  await classes.loadPackage(mapName);

  const levelExp = pkg.exports.find(e => e.className === 'Level');
  const L = readLevel(pkg, levelExp);

  // ---- actors ----
  const actors = [];
  const actorsByRef = new Map();
  for (const ref of new Set(L.actors)) { // (some maps list an actor twice)
    if (!ref) continue;
    const exp = pkg.exports[ref - 1];
    const own = assets.props(pkg, exp);
    const props = mergeProps(classes.merged(exp.className), own);
    const a = { ref, name: exp.name, cls: exp.className, props, own, exp };
    actors.push(a);
    actorsByRef.set(ref, a);
  }

  // ---- BSP ----
  const geo = await buildLevelGeometry(ctx, pkg, L.model, actorsByRef);
  const scene = new THREE.Scene();
  scene.add(geo.root);

  const levelInfo = actors.find(a => a.cls === 'LevelInfo');
  const title = levelInfo?.props.Title || mapName;

  // ---- player start ----
  const starts = actors.filter(a => classes.isA(a.cls, 'PlayerStart'));
  const ps = starts.find(s => s.props.bEnabled !== false) || starts[0];
  const playerStart = ps
    ? { pos: uvec(ps.props.Location), yaw: -(ps.props.Rotation?.yaw || 0) * UROT - Math.PI / 2, actor: ps }
    : { pos: new THREE.Vector3(), yaw: 0 };

  // ---- sky zone ----
  const sky = actors.find(a => classes.isA(a.cls, 'SkyZoneInfo'));
  const skyPos = sky ? uvec(sky.props.Location) : null;
  const skyCam = new THREE.PerspectiveCamera();

  // backdrop surfaces: depth only in main pass (sky shows through), visible in sky pass
  const backdropMats = [];
  geo.skyBackdrop.traverse(o => { if (o.isMesh) backdropMats.push(o.material); });

  const level = {
    world: null,
    name: mapName, title, pkg, actors, actorsByRef, scene, geo, playerStart, levelInfo, sky,
    update(dt, camera) { this.world?.update(dt); },
    render(renderer, camera) {
      if (skyPos) {
        skyCam.copy(camera);
        skyCam.position.copy(skyPos);
        skyCam.updateMatrixWorld();
        for (const m of backdropMats) m.colorWrite = false;
        renderer.render(scene, skyCam);
        renderer.clearDepth();
      }
      for (const m of backdropMats) m.colorWrite = !skyPos;
      renderer.render(scene, camera);
    },
    dispose() {
      scene.traverse(o => { if (o.geometry) o.geometry.dispose(); });
      for (const p of geo.pages) p.dispose();
    },
  };
  // ---- actor visuals ----
  const world = new World(ctx, level);
  level.world = world;
  const jobs = [];
  for (const a of actors) {
    const dt = a.props.DrawType ?? 1;
    if (dt === 2 && a.props.Mesh) jobs.push(world.spawnVisual(a));
    else if (dt === 3 && a.props.Brush && classes.isA(a.cls, 'Mover')) jobs.push(world.spawnVisual(a));
  }
  await Promise.all(jobs);
  return level;
}
