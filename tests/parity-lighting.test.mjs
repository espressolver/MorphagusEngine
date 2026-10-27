// Parity tests: static BSP lighting (UnLight.cpp) helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hsvColor, staticLightColor, filterShadow, luxelSpatial, toByte, LIGHT_DIST } from '../src/render/lighting.js';

test('FGetHSV and the light colour: hue/saturation at full value times LightBrightness/255', () => {
  const white = hsvColor(0, 255, 255);
  assert.ok(Math.abs(white[0] - 0.7 * 1.4 / (0.01 + Math.sqrt(1.4))) < 1e-6);
  const c = staticLightColor({ hue: 0, sat: 255, brightness: 64 });
  assert.ok(Math.abs(c[0] - white[0] * 64 / 255) < 1e-6, 'linear in brightness');
});

test('LightDist falloff 2s^3-3s^2+1; radial value = incidence x falloff; inner radius brightens and clamps', () => {
  const S = Math.sqrt(1024 / 4096);
  assert.ok(Math.abs(LIGHT_DIST[1023] - (2 * S ** 3 - 3 * S ** 2 + 1)) < 1e-6);
  const L = { radius: 1000, radiusInner: 0, effect: 0, source: 0, rot: { yaw: 0, pitch: 0 }, cone: 128 };
  // straight below the light at half radius: incidence 1, falloff at s = 0.5
  const f = luxelSpatial(L, 0, 0, -500, 500, [0, 0, 1]);
  assert.ok(Math.abs(f - 0.5) < 0.01, 'f ' + f);
  // 45 degrees: planeDot = d cos45
  const d = 500, g = luxelSpatial(L, d / Math.SQRT2, 0, -d / Math.SQRT2, d / Math.SQRT2, [0, 0, 1]);
  assert.ok(Math.abs(g - 0.5 * Math.SQRT1_2) < 0.01);
  assert.equal(luxelSpatial(L, 0, 0, -1001, 1001, [0, 0, 1]), 0, 'outside the radius');
  const inner = luxelSpatial({ ...L, radiusInner: 500 }, 0, 0, -300, 300, [0, 0, 1]);
  assert.equal(inner, 1, 'x R/(R-Ri), clamped');
});

test('shadow filter: fully lit 254, edges repeat, a lone lit luxel spreads 3x3', () => {
  const full = filterShadow(new Uint8Array([0xff, 0xff, 0xff, 0xff]), 0, 8, 4, 1);
  assert.ok(full.every(v => v === 254));
  const one = new Uint8Array(3); one[1] = 0b100; // luxel (2, 1) of an 8x3 map
  const f = filterShadow(one, 0, 8, 3, 1);
  assert.equal(f[1 * 8 + 2], Math.floor(64 * 255 / 320));
  assert.equal(f[1 * 8 + 1], Math.floor(40 * 255 / 320));
  assert.equal(f[0 * 8 + 1], Math.floor(24 * 255 / 320));
  assert.equal(f[1 * 8 + 5], 0);
  assert.equal(toByte(2.5), 2); assert.equal(toByte(3.5), 4);
});
