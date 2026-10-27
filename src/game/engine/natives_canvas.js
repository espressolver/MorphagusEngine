// Canvas natives (UE1 semantics) backed by HudCanvas.
export function installCanvasNatives(vm, engine) {
  const N = (idx, fn) => vm.natives.set(idx, fn);
  const NN = (name, fn) => vm.namedNatives.set(name.toLowerCase(), fn);
  const H = () => engine.hud;

  // the canvas font; outside English the engine draws LargeFont/BigFont text with MedFont
  const fontRef = c => (c.Font && (c.Font === c.LargeFont || c.Font === c.BigFont) && String(vm.language || 'tra').toLowerCase() !== 'int' && c.MedFont) ? c.MedFont : c.Font;
  const fontOf = c => H()?.font(fontRef(c));
  const charSize = (f, ch) => { const g = H().glyph(f, ch); return g ? [g.adv, g.h] : [0, 0]; };

  // UE1 UCanvas::WrappedPrint: lines broken at spaces (or mid-word when one word doesn't fit) once the
  // running width (chars + SpaceX, from CurX; from 0 when centring) passes ClipX; centred lines are drawn
  // centred on CurX. CurX is restored, CurY moves down per line. Returns { xl, yl }.
  function wrappedPrint(c, text, draw) {
    const h = H(), f = fontOf(c);
    if (!h || !f) return { xl: 0, yl: 0 };
    let t = String(text ?? '');
    if (c.ClipX < 0 || c.ClipY < 0 || !t) return { xl: 0, yl: 0 };
    const sx = c.SpaceX || 0, sy = c.SpaceY || 0, center = !!c.bCenter;
    let xl = 0, yl = 0;
    const origX = c.CurX || 0;
    do {
      let clean = 0, testXL = center ? 0 : Math.trunc(origX), cleanXL = 0, testYL = 0, cleanYL = 0, got = false, i = 0;
      while (i < t.length && t[i] !== '\n') {
        const [w, ht] = charSize(f, t[i]);
        testXL += Math.trunc(w + sx);
        testYL = Math.max(testYL, ht + Math.trunc(sy));
        if (testXL > c.ClipX) break;
        i++;
        const brk = t[i] === ' ' || t[i] === '\n' || i >= t.length;
        if (brk || !got) { clean = i; cleanXL = testXL; cleanYL = testYL; got = got || brk; }
      }
      if (clean === 0) break;
      if (draw && c.Style !== 0 && (c.OrgY || 0) + (c.CurY || 0) < (h.height || 1e9) && (c.OrgY || 0) + (c.CurY || 0) + cleanYL > 0) {
        const lineX = center ? Math.trunc(origX - cleanXL / 2) : Math.trunc(origX);
        h.drawLine(f, t.slice(0, clean), (c.OrgX || 0) + lineX, (c.OrgY || 0) + Math.trunc(c.CurY || 0), c.DrawColor, c.Style, null, sx);
      }
      c.CurX = origX;
      c.CurY = (c.CurY || 0) + cleanYL;
      yl += cleanYL;
      xl = Math.max(xl, cleanXL);
      t = t.slice(clean);
      if (t[0] === '\n') t = t.slice(1);
      t = t.replace(/^ +/, '');
    } while (t.length);
    return { xl, yl };
  }
  // measure without drawing, from (0,0), leaving the pen where it was
  function measure(c, text, clipX) {
    const ox = c.CurX, oy = c.CurY, oc = c.ClipX;
    c.CurX = 0; c.CurY = 0;
    if (clipX !== undefined) c.ClipX = clipX;
    const r = wrappedPrint(c, text, false);
    c.CurX = ox; c.CurY = oy; c.ClipX = oc;
    return r;
  }

  // DrawText(Text, optional bool CR = true)
  N(465, (c, [text, cr]) => {
    if (!c.Font) { vm.warnOnce('drawtextnofont', 'DrawText: No font'); return; }
    if (!fontOf(c)) return; // (no renderer)
    let r = { xl: 0, yl: 0 };
    if (c.Style !== 0) r = wrappedPrint(c, text ?? '', true);
    c.CurX = (c.CurX || 0) + r.xl;
    c.CurYL = Math.max(c.CurYL || 0, r.yl);
    if (cr === undefined || cr) { c.CurX = 0; c.CurY = (c.CurY || 0) + c.CurYL; c.CurYL = 0; }
  });
  // StrLen: wrapped size at the current ClipX; TextSize: unwrapped (ClipX 32767)
  N(464, (c, [text, xl, yl]) => { const r = measure(c, text ?? ''); xl.set(r.xl); yl.set(r.yl); });
  N(470, (c, [text, xl, yl]) => {
    if (!fontOf(c)) { xl.set(0); yl.set(0); return; }
    const r = measure(c, text ?? '', 32767); xl.set(r.xl); yl.set(r.yl);
  });
  N(466, (c, [tex, XL, YL, U, V, UL, VL]) => { // DrawTile
    if (!tex) return;
    if (c.Style !== 0) H()?.tile(tex, (c.OrgX || 0) + (c.CurX || 0), (c.OrgY || 0) + (c.CurY || 0), XL, YL, U, V, UL, VL, c.DrawColor, c.Style || 1);
    c.CurX = (c.CurX || 0) + XL + (c.SpaceX || 0);
    c.CurYL = Math.max(c.CurYL || 0, YL);
  });
  N(468, (c, [tex, XL, YL, U, V, UL, VL]) => { // DrawTileClipped
    if (!tex || XL <= 0 || YL <= 0) return;
    let cx = c.CurX || 0, cy = c.CurY || 0;
    if (cx < 0) { const k = cx * UL / XL; U -= k; UL += k; XL += cx; cx = 0; }
    if (cy < 0) { const k = cy * VL / YL; V -= k; VL += k; YL += cy; cy = 0; }
    if (XL > c.ClipX - cx) { UL += (c.ClipX - cx - XL) * UL / XL; XL = c.ClipX - cx; }
    if (YL > c.ClipY - cy) { VL += (c.ClipY - cy - YL) * VL / YL; YL = c.ClipY - cy; }
    if (XL > 0 && YL > 0 && c.Style !== 0) H()?.tile(tex, (c.OrgX || 0) + cx, (c.OrgY || 0) + cy, XL, YL, U, V, UL, VL, c.DrawColor, c.Style || 1);
    c.CurX = cx + XL + (c.SpaceX || 0);
    c.CurY = cy;
    c.CurYL = Math.max(c.CurYL || 0, YL);
  });
  N(469, (c, [text, hotkey]) => { // DrawTextClipped
    const h = H(), f = fontOf(c);
    if (!h || !f) return;
    let s = String(text ?? '');
    if (hotkey) s = s.replace(/&(&|.)?/g, (m, ch) => ch === '&' ? '&' : (ch || '')); // (the engine underlines the hotkey)
    const x0 = c.OrgX || 0, y0 = c.OrgY || 0;
    if (c.Style !== 0) h.drawLine(f, s, x0 + Math.trunc(c.CurX || 0), y0 + Math.trunc(c.CurY || 0), c.DrawColor, c.Style, { x0, y0, x1: x0 + c.ClipX, y1: y0 + c.ClipY }, c.SpaceX || 0);
  });
  N(467, (c, [actor]) => engine.drawActorOnCanvas?.(c, actor));
  N(471, (c, [actor, wire, x, y, xb, yb]) => engine.drawActorOnCanvas?.(c, actor, { x, y, xb, yb }));
  N(480, () => {});

  NN('console.createnativefont', (s, [name, height]) => {
    const key = 'nf:' + name + ':' + height;
    let f = vm.assetCache.get(key);
    if (!f) {
      f = { __isUObject: true, __asset: true, __className: 'Font', Name: 'NativeFont_' + height, __path: key, __nativeFont: { name: String(name), height: height | 0 }, toString() { return key; } };
      vm.assetCache.set(key, f);
    }
    return f;
  });
  NN('scriptedtexture.textsize', (s, [text, xl, yl, font]) => {
    const h = H(), f = h?.font(font);
    xl.set(f ? h.textWidth(f, String(text)) : 0); yl.set(f ? f.height : 0);
  });
}
