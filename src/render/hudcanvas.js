// 2D overlay for UE1 Canvas drawing (HUD, console, UWindow menus): WebGL2 quad batcher.
import { readProperties } from '../engine/uobject.js';

const VS = `#version 300 es
in vec2 aPos; in vec2 aUV; in vec4 aCol;
uniform vec2 uSize; uniform vec4 uView; // view rect (x, y, w, h) in CSS px; uSize = full canvas CSS size
out vec2 vUV; out vec4 vCol;
void main() {
  vUV = aUV; vCol = aCol;
  vec2 p = uView.xy + aPos;
  gl_Position = vec4(p.x / uSize.x * 2.0 - 1.0, 1.0 - p.y / uSize.y * 2.0, 0.0, 1.0);
}`;
const FS = `#version 300 es
precision mediump float;
in vec2 vUV; in vec4 vCol;
uniform sampler2D uTex; uniform float uMasked; uniform float uMode; uniform float uAlpha;
out vec4 o;
void main() {
  vec4 t = texture(uTex, vUV);
  if (uMasked > 0.5 && t.a < 0.5) discard;
  if (uMode > 3.5) { o = vec4(mix(vec3(1.0), t.rgb, vCol.a), 1.0); return; }      // modulated
  if (uMode > 2.5) { o = vec4(t.rgb * vCol.rgb * vCol.a, 1.0); return; }         // translucent (additive-ish)
  // UE1 Canvas: normal style is opaque; only masked textures / font atlases carry alpha
  o = vec4(t.rgb * vCol.rgb, (uAlpha > 0.5 ? t.a : 1.0) * vCol.a);
}`;

const MAXQ = 4096;

// Centered 4:3 game view rectangle in CSS pixels (UE1 UI assumes 4:3)
// The game view fills the window (any aspect). The menus and the start-up screens are 4:3 art, so they get a
// centred 4:3 frame (frame43); ?aspect=4:3 keeps that frame everywhere
const FIXED_43 = /^4:?3$/.test(new URLSearchParams(globalThis.location?.search || '').get('aspect') || '');
export function gameViewRect(frame43 = false) {
  const W = innerWidth, H = innerHeight;
  if (!FIXED_43 && !frame43) return { x: 0, y: 0, w: W, h: H };
  let w = W, h = Math.round(W * 3 / 4);
  if (h > H) { h = H; w = Math.round(H * 4 / 3); }
  return { x: Math.floor((W - w) / 2), y: Math.floor((H - h) / 2), w, h };
}

export class HudCanvas {
  constructor(textures) {
    this.textures = textures;
    this.el = document.createElement('canvas');
    this.el.id = 'hudcanvas';
    Object.assign(this.el.style, { position: 'fixed', left: '0', top: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: 2 });
    document.body.appendChild(this.el);
    const gl = this.gl = this.el.getContext('webgl2', { premultipliedAlpha: false, alpha: true, antialias: false });
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]]) {
      const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(sh));
      gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    this.prog = prog;
    this.loc = {
      aPos: gl.getAttribLocation(prog, 'aPos'), aUV: gl.getAttribLocation(prog, 'aUV'), aCol: gl.getAttribLocation(prog, 'aCol'),
      uSize: gl.getUniformLocation(prog, 'uSize'), uView: gl.getUniformLocation(prog, 'uView'), uTex: gl.getUniformLocation(prog, 'uTex'),
      uMasked: gl.getUniformLocation(prog, 'uMasked'), uMode: gl.getUniformLocation(prog, 'uMode'), uAlpha: gl.getUniformLocation(prog, 'uAlpha'),
    };
    this.buf = new Float32Array(MAXQ * 6 * 8);
    this.vbo = gl.createBuffer();
    this.n = 0;
    this.cur = null;
    this.texCache = new Map();   // exp -> { gl, w, h } | 'loading'
    this.fontCache = new Map();  // exp or native key -> font
    this.glyphAtlas = null;
    this.scale = 1;
  }

  resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    if (this.el.width !== w || this.el.height !== h) { this.el.width = w; this.el.height = h; }
    this.dpr = dpr;
    // logical canvas = the game view rect (CSS px)
    const v = gameViewRect(this.frame43);
    this.view = v;
    this.width = v.w; this.height = v.h;
  }

  begin() {
    this.resize();
    const gl = this.gl;
    gl.viewport(0, 0, this.el.width, this.el.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniform2f(this.loc.uSize, innerWidth, innerHeight);
    gl.uniform4f(this.loc.uView, this.view.x, this.view.y, this.view.w, this.view.h);
    gl.enable(gl.BLEND);
    this.n = 0; this.cur = null;
  }

  // ---------------------------------------------------------------- textures
  texFor(ref) {
    if (!ref || !ref.exp) return null;
    let t = this.texCache.get(ref.exp);
    if (t === 'loading') return null;
    if (t) return t;
    this.texCache.set(ref.exp, 'loading');
    this.textures.fromExport(ref.pkg, ref.exp).then(tex => {
      if (!tex) { this.texCache.set(ref.exp, null); return; }
      this.texCache.set(ref.exp, this.upload(tex.image.data, tex.image.width, tex.image.height, tex.userData.masked, !!tex.userData.props.bNoSmooth));
    });
    return null;
  }

  upload(data, w, h, masked, nearest) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { gl: t, w, h, masked, repeat: false };
  }

  // ---------------------------------------------------------------- batching
  setState(tex, style) {
    const key = tex;
    if (this.cur && this.cur.tex === key && this.cur.style === style) return;
    this.flush();
    this.cur = { tex: key, style };
  }

  flush() {
    if (!this.n || !this.cur) { this.n = 0; return; }
    const gl = this.gl, L = this.loc;
    const { tex, style } = this.cur;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.gl);
    gl.uniform1i(L.uTex, 0);
    gl.uniform1f(L.uMasked, (style === 2 || tex.masked) ? 1 : 0);
    gl.uniform1f(L.uMode, style);
    gl.uniform1f(L.uAlpha, tex.alpha ? 1 : 0);
    if (style === 3) gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
    else if (style === 4) gl.blendFunc(gl.DST_COLOR, gl.SRC_COLOR);
    else gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.buf.subarray(0, this.n * 6 * 8), gl.STREAM_DRAW);
    const stride = 32;
    gl.enableVertexAttribArray(L.aPos); gl.vertexAttribPointer(L.aPos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(L.aUV); gl.vertexAttribPointer(L.aUV, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(L.aCol); gl.vertexAttribPointer(L.aCol, 4, gl.FLOAT, false, stride, 16);
    gl.drawArrays(gl.TRIANGLES, 0, this.n * 6);
    this.n = 0;
  }

  // quad in logical px, uv in 0..1
  quad(tex, style, x, y, w, h, u0, v0, u1, v1, r, g, b, a) {
    if (!tex || style === 0) return;
    this.setState(tex, style);
    if (this.n >= MAXQ) this.flush();
    const B = this.buf;
    let o = this.n * 48;
    const P = (px, py, pu, pv) => { B[o++] = px; B[o++] = py; B[o++] = pu; B[o++] = pv; B[o++] = r; B[o++] = g; B[o++] = b; B[o++] = a; };
    P(x, y, u0, v0); P(x + w, y, u1, v0); P(x, y + h, u0, v1);
    P(x + w, y, u1, v0); P(x + w, y + h, u1, v1); P(x, y + h, u0, v1);
    this.n++;
  }

  // Draw a texture tile (UE semantics: U,V,UL,VL in texels)
  tile(ref, x, y, xl, yl, U, V, UL, VL, color, style) {
    const t = this.texFor(ref);
    if (!t) return;
    const c = color || { R: 255, G: 255, B: 255, A: 255 };
    const u0 = U / t.w, v0 = V / t.h, u1 = (U + UL) / t.w, v1 = (V + VL) / t.h;
    if (!t.repeat && (Math.min(u0, u1) < -0.001 || Math.max(u0, u1) > 1.001 || Math.min(v0, v1) < -0.001 || Math.max(v0, v1) > 1.001)) {
      // this texture is tiled: switch to repeat wrapping
      this.flush();
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, t.gl);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      t.repeat = true;
    }
    this.quad(t, style || 1, x, y, xl, yl, u0, v0, u1, v1, c.R / 255, c.G / 255, c.B / 255, 1);
  }

  // ---------------------------------------------------------------- fonts
  font(ref) {
    if (!ref) return null;
    if (ref.__nativeFont) return this.nativeFont(ref.__nativeFont.name, ref.__nativeFont.height);
    if (!ref.exp) return null;
    let f = this.fontCache.get(ref.exp);
    if (f) return f;
    f = this.parseFont(ref.pkg, ref.exp);
    this.fontCache.set(ref.exp, f);
    return f;
  }

  parseFont(pkg, exp) {
    const r = pkg.readerFor(exp);
    readProperties(r);
    const np = r.idx();
    const pages = [];
    for (let i = 0; i < np; i++) {
      const texRef = r.idx();
      const nc = r.idx();
      const chars = [];
      for (let k = 0; k < nc; k++) chars.push([r.i32(), r.i32(), r.i32(), r.i32()]);
      pages.push({ tex: { pkg, exp: texRef > 0 ? pkg.exports[texRef - 1] : null, ref: texRef }, chars });
    }
    const perPage = r.pos < r.end ? r.i32() : 256;
    const remap = new Map();
    if (r.pos < r.end) {
      try {
        const n = r.idx();
        for (let i = 0; i < n; i++) { const a = r.u16(), b = r.u16(); remap.set(a, b); }
      } catch { /* ignore */ }
    }
    // line height
    let height = 0;
    for (const p of pages) for (const c of p.chars) height = Math.max(height, c[3]);
    const f = { pages, perPage: perPage || 256, remap, height: height || 12 };
    // resolve imported page textures
    for (const p of pages) if (!p.tex.exp && p.tex.ref < 0) {
      const a = this.textures.assets;
      p.tex = null;
    }
    return f;
  }

  glyph(f, ch) {
    if (f.native) return this.nativeGlyph(f, ch);
    let code = ch.charCodeAt(0);
    if (f.remap.size) { const m = f.remap.get(code); if (m !== undefined) code = m; }
    const page = f.pages[Math.floor(code / f.perPage)];
    if (!page) return null;
    const c = page.chars[code % f.perPage];
    // (a font without lowercase glyphs draws them as capitals, like the engine)
    if ((!c || !c[2]) && ch >= 'a' && ch <= 'z') return this.glyph(f, ch.toUpperCase());
    if (!c || !c[2]) return null;
    return { page, u: c[0], v: c[1], w: c[2], h: c[3], adv: c[2] };
  }

  nativeFont(name, height) {
    const key = 'native:' + name + ':' + height;
    let f = this.fontCache.get(key);
    if (!f) {
      f = { native: true, name, height: Math.round(height * 1.0), glyphs: new Map(), css: `${Math.round(height * 0.85)}px "PMingLiU", "MingLiU", "Songti TC", "Noto Serif TC", serif` };
      this.fontCache.set(key, f);
    }
    return f;
  }

  nativeGlyph(f, ch) {
    let g = f.glyphs.get(ch);
    if (g) return g;
    const A = this.ensureAtlas();
    const ctx = A.ctx;
    ctx.font = f.css;
    const w = Math.ceil(ctx.measureText(ch).width) || Math.ceil(f.height / 2);
    const h = f.height;
    if (A.x + w + 2 > A.size) { A.x = 1; A.y += A.rowH + 2; A.rowH = 0; }
    if (A.y + h + 2 > A.size) { A.x = 1; A.y = 1; A.rowH = 0; ctx.clearRect(0, 0, A.size, A.size); for (const ff of this.fontCache.values()) if (ff.native) ff.glyphs.clear(); }
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'top';
    ctx.fillText(ch, A.x, A.y + Math.round(h * 0.08));
    g = { atlas: true, u: A.x, v: A.y, w, h, adv: w };
    A.x += w + 2; A.rowH = Math.max(A.rowH, h);
    A.dirty = true;
    f.glyphs.set(ch, g);
    return g;
  }

  ensureAtlas() {
    if (this.glyphAtlas) return this.glyphAtlas;
    const size = 2048;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d', { willReadFrequently: false });
    const gl = this.gl;
    const t = gl.createTexture();
    this.glyphAtlas = { canvas: c, ctx, size, x: 1, y: 1, rowH: 0, dirty: true, tex: { gl: t, w: size, h: size, masked: false, alpha: true } };
    return this.glyphAtlas;
  }

  syncAtlas() {
    const A = this.glyphAtlas;
    if (!A || !A.dirty) return;
    const gl = this.gl;
    this.flush();
    gl.bindTexture(gl.TEXTURE_2D, A.tex.gl);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, A.canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    A.dirty = false;
  }

  textWidth(f, s) {
    let w = 0;
    for (const ch of s) { const g = this.glyph(f, ch); w += g ? g.adv : 0; }
    return w;
  }

  // draw a single line; clip = {x0,y0,x1,y1} optional
  drawLine(f, s, x, y, color, style, clip, spaceX = 0) {
    if (!f) return;
    const col = color || { R: 255, G: 255, B: 255, A: 255 };
    const r = col.R / 255, g = col.G / 255, b = col.B / 255;
    let cx = x;
    for (const ch of s) {
      const gl = this.glyph(f, ch);
      if (!gl) continue; // characters the font lacks take no space
      let tex;
      if (gl.atlas) { this.syncAtlas(); tex = this.glyphAtlas.tex; }
      else tex = gl.page.tex && this.texFor(gl.page.tex);
      if (tex && ch !== ' ') {
        let qx = cx, qy = y, qw = gl.w, qh = gl.h, u0 = gl.u, v0 = gl.v, u1 = gl.u + gl.w, v1 = gl.v + gl.h;
        if (clip) {
          if (qx >= clip.x1 || qy >= clip.y1 || qx + qw <= clip.x0 || qy + qh <= clip.y0) { cx += gl.adv + spaceX; continue; }
          if (qx + qw > clip.x1) { const k = (clip.x1 - qx) / qw; u1 = u0 + (u1 - u0) * k; qw = clip.x1 - qx; }
          if (qy + qh > clip.y1) { const k = (clip.y1 - qy) / qh; v1 = v0 + (v1 - v0) * k; qh = clip.y1 - qy; }
          if (qx < clip.x0) { const k = (clip.x0 - qx) / qw; u0 = u0 + (u1 - u0) * k; qw -= clip.x0 - qx; qx = clip.x0; }
          if (qy < clip.y0) { const k = (clip.y0 - qy) / qh; v0 = v0 + (v1 - v0) * k; qh -= clip.y0 - qy; qy = clip.y0; }
        }
        this.quad(tex, style === 2 ? 2 : (style || 1), qx, qy, qw, qh, u0 / tex.w, v0 / tex.h, u1 / tex.w, v1 / tex.h, r, g, b, 1);
      }
      cx += gl.adv + spaceX;
    }
  }

  end() { this.flush(); }
}
