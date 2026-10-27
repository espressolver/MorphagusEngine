// Converts UE1 textures (palettized / DXT1) into three.js textures, cached by full path.
import * as THREE from 'three';
import { readTexture, readPalette, decodeTextureRGBA } from '../engine/uobject.js';
import { FireSim, WaveSim, WetSim, IceSim, readSparks } from './proctex.js';

export class TextureCache {
  constructor(assets, renderer) {
    this.assets = assets;
    this.renderer = renderer;
    this.cache = new Map();
    this.palettes = new Map();
    this.white = makeSolid(255, 255, 255);
    this.white.userData = { w: 64, h: 64, props: {} };
    this.animated = [];  // textures with AnimNext chains
    this.procedural = []; // live Fire/Water textures
  }

  async palette(pkg, ref) {
    const res = await this.assets.resolve(pkg, ref);
    if (!res) return null;
    let pal = this.palettes.get(res.exp);
    if (!pal) { pal = readPalette(res.pkg, res.exp); this.palettes.set(res.exp, pal); }
    return pal;
  }

  // Load by (pkg, ref)
  async get(pkg, ref) {
    if (!ref) return null;
    const res = await this.assets.resolve(pkg, ref);
    if (!res) return null;
    return this.fromExport(res.pkg, res.exp);
  }

  async getPath(path) {
    const res = await this.assets.resolvePath(path, 'Texture');
    if (!res) return null;
    return this.fromExport(res.pkg, res.exp);
  }

  fromExport(pkg, exp) {
    let p = this.cache.get(exp);
    if (!p) {
      p = this._load(pkg, exp).catch(err => { console.warn('texture', exp.name, err); return null; });
      this.cache.set(exp, p);
    }
    return p;
  }

  async _load(pkg, exp) {
    if (exp.className === 'FireTexture' || exp.className === 'WetTexture' || exp.className === 'IceTexture' || exp.className === 'WaveTexture') {
      const t = await this._loadProcedural(pkg, exp);
      if (t) return t;
    }
    const tex = readTexture(pkg, exp);
    const props = tex.props;
    let pal = null;
    if (tex.format === 0 && props.Palette) pal = await this.palette(pkg, props.Palette.ref);
    const mips = [];
    const usable = tex.mips.filter(m => m.w > 0 && m.h > 0 && m.data.length > 0);
    for (let i = 0; i < usable.length; i++) {
      const fake = { mips: [usable[i]], format: tex.format, props };
      const d = decodeTextureRGBA(fake, pal, 0);
      if (!d) break;
      mips.push(d);
      // three needs a complete chain down to 1x1 with halving sizes
      if (i > 0 && (d.w !== Math.max(1, mips[i - 1].w >> 1) || d.h !== Math.max(1, mips[i - 1].h >> 1))) { mips.pop(); break; }
    }
    if (!mips.length) return null;
    const t = new THREE.DataTexture(mips[0].data, mips[0].w, mips[0].h, THREE.RGBAFormat);
    const complete = mips.length > 1 && mips[mips.length - 1].w === 1 && mips[mips.length - 1].h === 1;
    if (complete) {
      t.mipmaps = mips.map(m => ({ data: m.data, width: m.w, height: m.h }));
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = false;
    } else {
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
    }
    t.magFilter = props.bNoSmooth ? THREE.NearestFilter : THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.NoColorSpace;
    t.anisotropy = 4;
    t.flipY = false;
    t.needsUpdate = true;
    t.name = exp.name;
    t.userData = { w: mips[0].w, h: mips[0].h, props, masked: !!props.bMasked, className: exp.className, pkg, exp };
    // Animated texture chains (AnimNext)
    if (props.AnimNext) {
      t.userData.animNext = props.AnimNext;
      t.userData.frames = null;
      this._setupAnim(t, pkg);
    }
    return t;
  }

  // A texture's palette-index bitmap for the Wet/Ice textures that read it (live for procedural ones)
  async indexSource(pkg, ref) {
    if (!ref) return null;
    const res = await this.assets.resolve(pkg, ref.ref ?? ref);
    if (!res) return null;
    const t = await this.fromExport(res.pkg, res.exp);
    if (t?.userData?.sim) { const s = t.userData.sim; return { data: s.data, w: s.w, h: s.h, palette: s.palette, sim: s }; }
    const tex = readTexture(res.pkg, res.exp);
    const m = tex.mips[0];
    if (!m || tex.format !== 0) return null;
    const pal = tex.props.Palette ? await this.palette(res.pkg, tex.props.Palette.ref) : null;
    return { data: m.data, w: m.w, h: m.h, palette: pal };
  }

  async _loadProcedural(pkg, exp) {
    const tex = readTexture(pkg, exp);
    const props = { ...(this.classDefaults?.(exp.className) || {}), ...tex.props };
    const w = props.USize || 64, h = props.VSize || 64;
    let sim;
    const pal = props.Palette ? await this.palette(pkg, props.Palette.ref) : null;
    if (exp.className === 'FireTexture') {
      let sparks = [];
      try { sparks = readSparks(pkg, exp); } catch { /* none */ }
      sim = new FireSim(w, h, props, sparks, pal);
    } else if (exp.className === 'WaveTexture') sim = new WaveSim(w, h, props, pal);
    else if (exp.className === 'WetTexture') sim = new WetSim(w, h, props, await this.indexSource(pkg, props.SourceTexture));
    else sim = new IceSim(w, h, props, await this.indexSource(pkg, props.SourceTexture), await this.indexSource(pkg, props.GlassTexture));
    sim.step(0);
    sim.colorize();
    const t = new THREE.DataTexture(sim.rgba, w, h, THREE.RGBAFormat);
    t.magFilter = props.bNoSmooth ? THREE.NearestFilter : THREE.LinearFilter; t.minFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.NoColorSpace;
    t.flipY = false; t.needsUpdate = true;
    t.name = exp.name;
    t.userData = { w, h, props, masked: !!props.bMasked, className: exp.className, pkg, exp, sim };
    this.procedural.push({ tex: t, sim });
    return t;
  }

  async _setupAnim(t, pkg) {
    const frames = [t];
    let curPkg = pkg, cur = t.userData.props.AnimNext;
    for (let guard = 0; guard < 64 && cur; guard++) {
      const res = await this.assets.resolve(curPkg, cur.ref);
      if (!res || res.exp === t.userData.exp) break;
      const ft = await this.fromExport(res.pkg, res.exp);
      if (!ft || frames.includes(ft)) break;
      frames.push(ft);
      curPkg = res.pkg;
      cur = ft.userData.props.AnimNext;
    }
    if (frames.length > 1) {
      this.animated.push({ tex: t, frames, acc: 0, index: 0, base: t.image, baseMips: t.mipmaps });
    }
  }

  // Swap animated texture images each frame; step procedural textures
  update(dt) {
    // UTexture::Update / Tick for the procedural textures (sources were registered before their users)
    for (const p of this.procedural) if (p.sim.step(dt)) p.tex.needsUpdate = true;
    // UTexture::Tick catch-up (MaxFrameRate 0: every frame) stepping AnimCur along AnimNext
    for (const a of this.animated) {
      const p = a.tex.userData.props, max = p.MaxFrameRate ?? 0;
      let tick = false;
      if (!max) tick = true;
      else {
        const minTime = 1 / Math.min(100, Math.max(0.1, max)), maxTime = 1 / Math.min(100, Math.max(0.1, p.MinFrameRate ?? 0));
        a.acc = (a.acc || 0) + dt;
        if (a.acc >= minTime) {
          tick = true;
          if (a.acc < maxTime) a.acc = 0;
          else { a.acc -= maxTime; if (a.acc > maxTime) a.acc = maxTime; }
        }
      }
      if (!tick) continue;
      const idx = (a.index + 1) % a.frames.length;
      {
        a.index = idx;
        const f = a.frames[idx];
        a.tex.image = idx === 0 ? a.base : f.image;
        a.tex.mipmaps = idx === 0 ? a.baseMips : f.mipmaps;
        a.tex.needsUpdate = true;
      }
    }
  }
}

export function makeSolid(r, g, b, a = 255) {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}
