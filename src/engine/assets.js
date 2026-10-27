// Runtime asset manager: fetches the user's game packages and resolves cross-package references.
import { UPackage } from './upackage.js';
import { readProperties, readPalette, readTexture, readSound, readMusic } from './uobject.js';

const EXT_ORDER = ['.u', '.utx', '.uax', '.umx', '.unr'];

export class Assets {
  constructor(base = '/game/') {
    this.base = base;
    this.files = new Map();   // lowercase package name -> relative path
    this.pkgs = new Map();    // lowercase package name -> Promise<UPackage>
    this.loaded = new Map();  // lowercase package name -> UPackage (once loaded)
    this.lang = 'tra';        // 'tra' = Traditional Chinese variants when present, 'int' = English
    this.onProgress = null;
    this.propCache = new WeakMap();
  }

  async listFiles() { return (await fetch(this.base + 'manifest.json')).json(); }

  async init() {
    const list = await this.listFiles();
    this.manifest = list;
    const byName = new Map();
    for (const f of list) {
      const file = f.split('/').pop();
      const dot = file.indexOf('.');
      if (dot < 0) continue;
      const name = file.slice(0, dot).toLowerCase();
      const ext = file.slice(dot).toLowerCase();
      if (!byName.has(name)) byName.set(name, {});
      byName.get(name)[ext] = f;
    }
    this.byName = byName;
    for (const [name, exts] of byName) {
      let chosen = null;
      if (this.lang !== 'int') {
        for (const e of ['.tra_uax', '.tra_utx']) if (exts[e]) chosen = exts[e];
      }
      if (!chosen) for (const e of EXT_ORDER) if (exts[e]) { chosen = exts[e]; break; }
      if (chosen) this.files.set(name, chosen);
    }
  }

  has(name) { return this.files.has(name.toLowerCase()); }

  async fetchBuffer(rel) {
    const res = await fetch(this.base + rel.split('/').map(encodeURIComponent).join('/'));
    if (!res.ok) throw new Error('fetch failed: ' + rel);
    return res.arrayBuffer();
  }

  pkg(name) {
    const key = name.toLowerCase();
    let p = this.pkgs.get(key);
    if (!p) {
      const rel = this.files.get(key);
      if (!rel) return Promise.resolve(null);
      p = this.fetchBuffer(rel).then(buf => {
        const pk = new UPackage(name, buf);
        pk.assets = this;
        this.loaded.set(key, pk);
        this.onProgress?.(rel);
        return pk;
      });
      this.pkgs.set(key, p);
    }
    return p;
  }

  // Load all top-level packages imported by pkg (in parallel)
  async preloadDeps(pkg, filter) {
    const names = new Set();
    for (const im of pkg.imports) if (im.package === 0 && im.className === 'Package') names.add(im.name);
    const list = [...names].filter(n => this.has(n) && (!filter || filter(n)));
    await Promise.all(list.map(n => this.pkg(n)));
  }

  // Outer chain names (excluding top package) for an export/import ref, innermost last
  static chain(pkg, ref) {
    const out = [];
    let cur = ref;
    while (cur !== 0) {
      if (cur > 0) { const e = pkg.exports[cur - 1]; out.unshift(e.name.toLowerCase()); cur = e.package; }
      else { const im = pkg.imports[-cur - 1]; out.unshift(im.name.toLowerCase()); cur = im.package; }
    }
    return out;
  }

  // Resolve a reference inside pkg to { pkg, exp } (following imports into other packages).
  async resolve(pkg, ref) {
    if (!ref) return null;
    if (ref > 0) return { pkg, exp: pkg.exports[ref - 1] };
    const im = pkg.imports[-ref - 1];
    const chain = Assets.chain(pkg, ref);
    const target = await this.pkg(chain[0]);
    if (!target) return null;
    const exp = Assets.findInPackage(target, chain.slice(1), im.className);
    return exp ? { pkg: target, exp } : null;
  }

  // Resolve by "Package.Group.Name" path string
  async resolvePath(path, className) {
    const chain = path.toLowerCase().split('.');
    const target = await this.pkg(chain[0]);
    if (!target) return null;
    const exp = Assets.findInPackage(target, chain.slice(1), className);
    return exp ? { pkg: target, exp } : null;
  }

  static findInPackage(pkg, chain, className) {
    if (!pkg._index) {
      pkg._index = new Map();
      for (const e of pkg.exports) {
        const k = e.name.toLowerCase();
        if (!pkg._index.has(k)) pkg._index.set(k, []);
        pkg._index.get(k).push(e);
      }
    }
    const cands = pkg._index.get(chain[chain.length - 1]) || [];
    let best = null;
    for (const e of cands) {
      if (className && e.className !== className && className !== 'Class' && e.className !== 'Class') {
        // allow subclasses for textures (FireTexture etc.)
        if (!(className === 'Texture' || className === 'Sound')) continue;
      }
      // verify outer chain where available
      let ok = true, cur = e.package;
      for (let i = chain.length - 2; i >= 0 && cur !== 0; i--) {
        const o = pkg.exports[cur - 1];
        if (!o || o.name.toLowerCase() !== chain[i]) { ok = false; break; }
        cur = o.package;
      }
      if (ok) return e;
      best = best || e;
    }
    return best;
  }

  props(pkg, exp) {
    let c = this.propCache.get(exp);
    if (!c) { c = readProperties(pkg.readerFor(exp)); this.propCache.set(exp, c); }
    return c;
  }
}
