// Core (Object) native functions.
import { cloneVal, zeroOf } from './classes.js';
import { fmtFloat, rotToVec, vecToRot, deepEq } from './vm.js';

const RU = Math.PI / 32768;
const V = (X = 0, Y = 0, Z = 0) => ({ X, Y, Z });
const R = (Pitch = 0, Yaw = 0, Roll = 0) => ({ Pitch: Pitch | 0, Yaw: Yaw | 0, Roll: Roll | 0 });
const vs = v => Math.hypot(v.X, v.Y, v.Z);
const lc = s => String(s ?? '').toLowerCase();

// Rotator -> axes (UE FCoords from rotator)
export function rotAxes(r) {
  const p = (r?.Pitch || 0) * RU, y = (r?.Yaw || 0) * RU, rl = (r?.Roll || 0) * RU;
  const SP = Math.sin(p), CP = Math.cos(p), SY = Math.sin(y), CY = Math.cos(y), SR = Math.sin(rl), CR = Math.cos(rl);
  return {
    X: V(CP * CY, CP * SY, SP),
    Y: V(SR * SP * CY - CR * SY, SR * SP * SY + CR * CY, -SR * CP),
    Z: V(-(CR * SP * CY + SR * SY), CY * SR - CR * SP * SY, CR * CP),
  };
}
// vector << rotator (inverse transform), vector >> rotator (forward transform)
export function vecRotForward(v, r) { // v >> r : local -> world
  const a = rotAxes(r);
  return V(v.X * a.X.X + v.Y * a.Y.X + v.Z * a.Z.X, v.X * a.X.Y + v.Y * a.Y.Y + v.Z * a.Z.Y, v.X * a.X.Z + v.Y * a.Y.Z + v.Z * a.Z.Z);
}
export function vecRotInverse(v, r) { // v << r : world -> local
  const a = rotAxes(r);
  return V(v.X * a.X.X + v.Y * a.X.Y + v.Z * a.X.Z, v.X * a.Y.X + v.Y * a.Y.Y + v.Z * a.Y.Z, v.X * a.Z.X + v.Y * a.Z.Y + v.Z * a.Z.Z);
}

const i32 = x => x | 0;
// appRound: the x87 default rounding (to nearest, ties to even)
export const appRound = x => { const r = Math.round(x); return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r | 0; };
// FVector::SafeNormal: zero below a squared size of 1e-8
export const safeNormal = a => { const q = a.X * a.X + a.Y * a.Y + a.Z * a.Z; if (q < 1e-8) return V(); const k = 1 / Math.sqrt(q); return V(a.X * k, a.Y * k, a.Z * k); };
const set = (ref, v) => { ref.set(v); return v; };

export function installCoreNatives(vm) {
  const N = (idx, fn) => vm.natives.set(idx, fn);
  const NN = (name, fn) => vm.namedNatives.set(name.toLowerCase(), fn);

  // bool
  N(129, (s, [a]) => !a);
  N(242, (s, [a, b]) => !!a === !!b);
  N(243, (s, [a, b]) => !!a !== !!b);
  N(130, (s, [a, b]) => !!a && !!b);
  N(131, (s, [a, b]) => !!a !== !!b);
  N(132, (s, [a, b]) => !!a || !!b);
  // byte
  N(133, (s, [a, b]) => set(a, (a.get() * b) & 255));
  N(134, (s, [a, b]) => set(a, b ? Math.trunc(a.get() / b) & 255 : 0));
  N(135, (s, [a, b]) => set(a, (a.get() + b) & 255));
  N(136, (s, [a, b]) => set(a, (a.get() - b) & 255));
  N(137, (s, [a]) => set(a, (a.get() + 1) & 255));
  N(138, (s, [a]) => set(a, (a.get() - 1) & 255));
  N(139, (s, [a]) => { const v = a.get(); a.set((v + 1) & 255); return v; });
  N(140, (s, [a]) => { const v = a.get(); a.set((v - 1) & 255); return v; });
  // int
  N(141, (s, [a]) => ~a);
  N(143, (s, [a]) => i32(-a));
  N(144, (s, [a, b]) => Math.imul(a, b));
  N(145, (s, [a, b]) => b ? i32(a / b) : 0);
  N(146, (s, [a, b]) => i32(a + b));
  N(147, (s, [a, b]) => i32(a - b));
  N(148, (s, [a, b]) => a << b);
  N(149, (s, [a, b]) => a >> b);
  N(196, (s, [a, b]) => a >>> b);
  N(150, (s, [a, b]) => a < b); N(151, (s, [a, b]) => a > b); N(152, (s, [a, b]) => a <= b);
  N(153, (s, [a, b]) => a >= b); N(154, (s, [a, b]) => a === b); N(155, (s, [a, b]) => a !== b);
  N(156, (s, [a, b]) => a & b); N(157, (s, [a, b]) => a ^ b); N(158, (s, [a, b]) => a | b);
  N(159, (s, [a, b]) => set(a, i32(a.get() * b)));
  N(160, (s, [a, b]) => set(a, b ? i32(a.get() / b) : 0));
  N(161, (s, [a, b]) => set(a, i32(a.get() + b)));
  N(162, (s, [a, b]) => set(a, i32(a.get() - b)));
  N(163, (s, [a]) => set(a, i32(a.get() + 1)));
  N(164, (s, [a]) => set(a, i32(a.get() - 1)));
  N(165, (s, [a]) => { const v = a.get(); a.set(i32(v + 1)); return v; });
  N(166, (s, [a]) => { const v = a.get(); a.set(i32(v - 1)); return v; });
  N(167, (s, [m]) => m > 0 ? Math.floor(Math.random() * m) : 0);
  N(249, (s, [a, b]) => Math.min(a, b)); N(250, (s, [a, b]) => Math.max(a, b));
  N(251, (s, [v, a, b]) => Math.min(Math.max(v, a), b));
  // float
  N(169, (s, [a]) => -a);
  N(170, (s, [a, b]) => Math.pow(a, b));
  N(171, (s, [a, b]) => a * b);
  N(172, (s, [a, b]) => a / b); // no guard: x/0 is +-INF like the engine
  N(173, (s, [a, b]) => a % b); // fmod
  N(174, (s, [a, b]) => a + b); N(175, (s, [a, b]) => a - b);
  N(176, (s, [a, b]) => a < b); N(177, (s, [a, b]) => a > b); N(178, (s, [a, b]) => a <= b);
  N(179, (s, [a, b]) => a >= b); N(180, (s, [a, b]) => a === b);
  N(210, (s, [a, b]) => Math.abs(a - b) < 0.0001);
  N(181, (s, [a, b]) => a !== b);
  N(182, (s, [a, b]) => set(a, a.get() * b));
  N(183, (s, [a, b]) => set(a, a.get() / b));
  N(184, (s, [a, b]) => set(a, a.get() + b));
  N(185, (s, [a, b]) => set(a, a.get() - b));
  N(186, (s, [a]) => Math.abs(a)); N(187, (s, [a]) => Math.sin(a)); N(188, (s, [a]) => Math.cos(a));
  N(189, (s, [a]) => Math.tan(a)); N(190, (s, [a]) => Math.atan(a)); N(191, (s, [a]) => Math.exp(a));
  N(192, (s, [a]) => Math.log(a)); N(193, (s, [a]) => Math.sqrt(a)); N(194, (s, [a]) => a * a);
  N(195, () => Math.random());
  N(244, (s, [a, b]) => Math.min(a, b)); N(245, (s, [a, b]) => Math.max(a, b));
  N(246, (s, [v, a, b]) => Math.min(Math.max(v, a), b));
  N(247, (s, [t, a, b]) => a + (b - a) * t);
  N(248, (s, [t, a, b]) => a + (b - a) * (3 * t * t - 2 * t * t * t));
  N(1033, (s, [a, b]) => a + (b - a) * Math.random());
  // vector
  N(211, (s, [a]) => V(-a.X, -a.Y, -a.Z));
  N(212, (s, [a, b]) => V(a.X * b, a.Y * b, a.Z * b));
  N(213, (s, [a, b]) => V(b.X * a, b.Y * a, b.Z * a));
  N(296, (s, [a, b]) => V(a.X * b.X, a.Y * b.Y, a.Z * b.Z));
  N(214, (s, [a, b]) => { const k = 1 / b; return V(a.X * k, a.Y * k, a.Z * k); });
  N(215, (s, [a, b]) => V(a.X + b.X, a.Y + b.Y, a.Z + b.Z));
  N(216, (s, [a, b]) => V(a.X - b.X, a.Y - b.Y, a.Z - b.Z));
  N(275, (s, [a, b]) => vecRotInverse(a, b));
  N(276, (s, [a, b]) => vecRotForward(a, b));
  N(217, (s, [a, b]) => a.X === b.X && a.Y === b.Y && a.Z === b.Z);
  N(218, (s, [a, b]) => !(a.X === b.X && a.Y === b.Y && a.Z === b.Z));
  N(219, (s, [a, b]) => a.X * b.X + a.Y * b.Y + a.Z * b.Z);
  N(220, (s, [a, b]) => V(a.Y * b.Z - a.Z * b.Y, a.Z * b.X - a.X * b.Z, a.X * b.Y - a.Y * b.X));
  N(221, (s, [a, b]) => { const v = a.get(); return set(a, V(v.X * b, v.Y * b, v.Z * b)); });
  N(297, (s, [a, b]) => { const v = a.get(); return set(a, V(v.X * b.X, v.Y * b.Y, v.Z * b.Z)); });
  N(222, (s, [a, b]) => { const v = a.get(), k = 1 / b; return set(a, V(v.X * k, v.Y * k, v.Z * k)); });
  N(223, (s, [a, b]) => { const v = a.get(); return set(a, V(v.X + b.X, v.Y + b.Y, v.Z + b.Z)); });
  N(224, (s, [a, b]) => { const v = a.get(); return set(a, V(v.X - b.X, v.Y - b.Y, v.Z - b.Z)); });
  N(225, (s, [a]) => vs(a));
  N(226, (s, [a]) => safeNormal(a));
  N(227, (s, [x, y, z]) => { // Invert coordinate axes (transpose)
    const X = x.get(), Y = y.get(), Z = z.get();
    x.set(V(X.X, Y.X, Z.X)); y.set(V(X.Y, Y.Y, Z.Y)); z.set(V(X.Z, Y.Z, Z.Z));
  });
  N(252, () => { let v; do { v = V(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1); } while (vs(v) > 1 || vs(v) < 1e-4); const l = vs(v); return V(v.X / l, v.Y / l, v.Z / l); });
  N(300, (s, [v, n]) => { n = safeNormal(n); const d = 2 * (v.X * n.X + v.Y * n.Y + v.Z * n.Z); return V(v.X - d * n.X, v.Y - d * n.Y, v.Z - d * n.Z); });
  // rotator
  N(142, (s, [a, b]) => a.Pitch === b.Pitch && a.Yaw === b.Yaw && a.Roll === b.Roll);
  N(203, (s, [a, b]) => !(a.Pitch === b.Pitch && a.Yaw === b.Yaw && a.Roll === b.Roll));
  // FRotator * float rounds each component (appRound)
  const Rr = (p, y, r) => ({ Pitch: appRound(p), Yaw: appRound(y), Roll: appRound(r) });
  N(287, (s, [a, b]) => Rr(a.Pitch * b, a.Yaw * b, a.Roll * b));
  N(288, (s, [a, b]) => Rr(b.Pitch * a, b.Yaw * a, b.Roll * a));
  N(289, (s, [a, b]) => { const k = 1 / b; return Rr(a.Pitch * k, a.Yaw * k, a.Roll * k); });
  N(290, (s, [a, b]) => { const v = a.get(); return set(a, Rr(v.Pitch * b, v.Yaw * b, v.Roll * b)); });
  N(291, (s, [a, b]) => { const v = a.get(), k = 1 / b; return set(a, Rr(v.Pitch * k, v.Yaw * k, v.Roll * k)); });
  N(316, (s, [a, b]) => R(a.Pitch + b.Pitch, a.Yaw + b.Yaw, a.Roll + b.Roll));
  N(317, (s, [a, b]) => R(a.Pitch - b.Pitch, a.Yaw - b.Yaw, a.Roll - b.Roll));
  N(318, (s, [a, b]) => { const v = a.get(); return set(a, R(v.Pitch + b.Pitch, v.Yaw + b.Yaw, v.Roll + b.Roll)); });
  N(319, (s, [a, b]) => { const v = a.get(); return set(a, R(v.Pitch - b.Pitch, v.Yaw - b.Yaw, v.Roll - b.Roll)); });
  N(229, (s, [r, x, y, z]) => { const a = rotAxes(r); x.set(a.X); y.set(a.Y); z.set(a.Z); });
  N(230, (s, [r, x, y, z]) => { // GetUnAxes: transposed axes
    const a = rotAxes(r);
    x.set(V(a.X.X, a.Y.X, a.Z.X)); y.set(V(a.X.Y, a.Y.Y, a.Z.Y)); z.set(V(a.X.Z, a.Y.Z, a.Z.Z));
  });
  const rr = () => (2 * Math.floor(Math.random() * 32768)) % 65535; // the engine's (2*rand) % 65535
  N(320, (s, [roll]) => R(rr(), rr(), roll ? rr() : 0));
  // strings
  N(112, (s, [a, b]) => String(a ?? '') + String(b ?? ''));
  N(168, (s, [a, b]) => String(a ?? '') + ' ' + String(b ?? ''));
  N(115, (s, [a, b]) => a < b); N(116, (s, [a, b]) => a > b); N(120, (s, [a, b]) => a <= b);
  N(121, (s, [a, b]) => a >= b); N(122, (s, [a, b]) => a === b); N(123, (s, [a, b]) => a !== b);
  N(124, (s, [a, b]) => lc(a) === lc(b));
  N(125, (s, [a]) => String(a ?? '').length);
  N(126, (s, [a, b]) => String(a ?? '').indexOf(String(b ?? '')));
  // FString::Mid: start and end are clamped as unsigned, so a negative start gives ''
  N(127, (s, [a, i, j]) => {
    const str = String(a ?? ''), n = str.length;
    const st = (i | 0) >>> 0, en = (((i | 0) + (j === undefined ? 65535 : j | 0)) | 0) >>> 0;
    const b = Math.min(st, n), e = Math.min(Math.max(en, b), n);
    return str.slice(b, e);
  });
  N(128, (s, [a, i]) => String(a ?? '').substr(0, Math.max(0, i | 0)));
  N(234, (s, [a, i]) => { const str = String(a ?? ''); i = Math.max(0, i | 0); return i >= str.length ? str : str.substr(str.length - i); });
  N(235, (s, [a]) => String(a ?? '').toUpperCase());
  N(236, (s, [i]) => (i & 0xFFFF) ? String.fromCharCode(i & 0xFFFF) : '');
  N(237, (s, [a]) => { const str = String(a ?? ''); return str.length ? str.charCodeAt(0) : 0; });
  // object / name
  N(114, (s, [a, b]) => (a ?? null) === (b ?? null));
  N(119, (s, [a, b]) => (a ?? null) !== (b ?? null));
  N(254, (s, [a, b]) => lc(a) === lc(b));
  N(255, (s, [a, b]) => lc(a) !== lc(b));
  N(231, (s, [str, tag]) => { if (vm.verbose) vm.log((tag && tag !== 'None' ? tag + ': ' : '') + str); });
  N(232, (s, [str]) => vm.warnOnce('warn' + str, 'Warn:', str));
  N(113, (s, [st, label]) => { vm.gotoState(s, st, label); }); // no state given: the current one
  N(281, (s, [st]) => { for (let x = s.__state; x; x = x.superState) if (lc(x.name) === lc(st)) return true; return false; });
  N(284, s => s.__state ? s.__state.name : 'None');
  N(258, (s, [a, b]) => !!a && !!b && a.isChildOf(b));
  N(303, (s, [n]) => !!s.Class && s.Class.isA(String(n)));
  N(117, (s, [n]) => { s.__disabled?.delete(lc(n)); });
  N(118, (s, [n]) => { (s.__disabled ??= new Set()).add(lc(n)); });
  N(536, () => {});

  // Named (non-indexed) Object natives
  NN('object.dynamicloadobject', (s, [name, cls]) => {
    const str = String(name);
    // class'Class' is intrinsic (no script ClassInfo): resolve via the class table
    const asClass = !cls || (cls.__isClass ? cls.lname === 'class' : String(cls.Name || cls).toLowerCase() === 'class');
    if (asClass) { const c = vm.cls(str.split('.').pop()); if (c) return c; }
    return vm.findAsset(str, cls?.name) || null;
  });
  NN('object.getlanguage', () => vm.language || 'tra');
  NN('object.getenum', (s, [e, i]) => (Array.isArray(e?.names) && i >= 0 && i < e.names.length ? e.names[i] : 'None'));
  // OrthoRotation: pitch/yaw from X, roll from where Z points in the yawed/pitched frame
  NN('object.orthorotation', (s, [x, y, z]) => {
    const r = R(Math.trunc(Math.atan2(x.Z, Math.hypot(x.X, x.Y)) * 32768 / Math.PI), Math.trunc(Math.atan2(x.Y, x.X) * 32768 / Math.PI), 0);
    const ay = rotAxes(r).Y;
    r.Roll = Math.trunc(Math.atan2(z.X * ay.X + z.Y * ay.Y + z.Z * ay.Z, y.X * ay.X + y.Y * ay.Y + y.Z * ay.Z) * 32768 / Math.PI);
    return r;
  });
  const signed16 = v => { v &= 0xFFFF; return v > 32767 ? v - 0x10000 : v; };
  NN('object.normalize', (s, [r]) => R(signed16(r.Pitch), signed16(r.Yaw), signed16(r.Roll)));
  NN('object.saveconfig', () => {});
  NN('object.staticsaveconfig', () => {});
  NN('object.resetconfig', () => {});
  NN('object.localize', (s, [sec, key, pkg]) => vm.localize?.(String(sec), String(key), String(pkg)) ?? '');
  NN('object.getpropertytext', (s, [p]) => { const v = s[p]; return v === undefined ? '' : String(v); });
  NN('object.setpropertytext', (s, [p, v]) => {
    const prop = s.Class?.propByName.get(lc(p));
    if (!prop) return;
    if (prop.kind === 'IntProperty' || prop.kind === 'ByteProperty') s[prop.name] = parseInt(v) || 0;
    else if (prop.kind === 'FloatProperty') s[prop.name] = parseFloat(v) || 0;
    else if (prop.kind === 'BoolProperty') s[prop.name] = lc(v) === 'true';
    else s[prop.name] = v;
  });
  NN('object.getnextint', () => '');
  NN('object.getnextintdesc', () => {});
  NN('object.isinstate', (s, [st]) => !!s.__state && lc(s.__state.name) === lc(st));
}

export { V, R, vs };
