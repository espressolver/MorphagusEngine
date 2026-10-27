// UE1-style audio: PlaySound slots, 3D positional sounds, ambient sounds and music (WAV / MPEG Layer II).
import { MPEGDecoder } from 'mpg123-decoder';
import { readSound, readMusic } from '../engine/uobject.js';

const SLOT_None = 0;

// MPEG audio frame header parsing (for durations)
const MP_BITRATES = {
  1: { 1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], 2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], 3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] },
  2: { 1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], 3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] },
};
const MP_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };

export function mpegDuration(data) {
  let i = 0, samples = 0, rate = 0;
  const n = data.length;
  while (i + 4 <= n) {
    if (data[i] !== 0xff || (data[i + 1] & 0xe0) !== 0xe0) { i++; continue; }
    const verBits = (data[i + 1] >> 3) & 3, layerBits = (data[i + 1] >> 1) & 3;
    const ver = verBits === 3 ? 1 : verBits === 2 ? 2 : verBits === 0 ? 2.5 : 0;
    const layer = 4 - layerBits;
    const brI = data[i + 2] >> 4, srI = (data[i + 2] >> 2) & 3, pad = (data[i + 2] >> 1) & 1;
    if (!ver || layer > 3 || brI === 0 || brI === 15 || srI === 3) { i++; continue; }
    const br = MP_BITRATES[ver === 1 ? 1 : 2][layer][brI] * 1000;
    rate = MP_RATES[ver][srI];
    let len, spf;
    if (layer === 1) { len = (Math.floor(12 * br / rate) + pad) * 4; spf = 384; }
    else { spf = (layer === 3 && ver !== 1) ? 576 : 1152; len = Math.floor(spf / 8 * br / rate) + pad; }
    if (len <= 4) { i++; continue; }
    samples += spf; i += len;
  }
  return rate ? samples / rate : 0;
}

export function wavDuration(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let p = 12, byteRate = 0, dataLen = 0;
  while (p + 8 <= data.length) {
    const id = String.fromCharCode(data[p], data[p + 1], data[p + 2], data[p + 3]);
    const sz = dv.getUint32(p + 4, true);
    if (id === 'fmt ') byteRate = dv.getUint32(p + 12, true);
    if (id === 'data') { dataLen = sz; break; }
    p += 8 + sz + (sz & 1);
  }
  return byteRate ? dataLen / byteRate : 0;
}

export class AudioSystem {
  constructor(engine) {
    this.engine = engine;
    this.ctx = null;
    this.buffers = new Map();    // exp -> Promise<AudioBuffer>
    this.decoded = new Map();    // exp -> AudioBuffer
    this.raw = new Map();        // exp -> {format, data}
    this.playing = new Set();    // active voices
    this.slots = new Map();      // actor -> Map(slot -> voice)
    this.ambient = new Map();    // actor -> voice
    this.music = null;
    this.listener = { X: 0, Y: 0, Z: 0, yaw: 0, pitch: 0 };
    // Galaxy volumes from the ini (0..255; defaults SoundVolume 200, MusicVolume 128)
    const gx = engine?.ini?.['Galaxy.GalaxyAudioSubsystem'] || {};
    this.masterVolume = 1; this.soundVolume = (+(gx.SoundVolume ?? 200)) / 255; this.musicVolume = (+(gx.MusicVolume ?? 128)) / 255;
    this.mpeg = new MPEGDecoder();
    this.mpegReady = this.mpeg.ready;
    this.enabled = typeof AudioContext !== 'undefined';
  }

  resume() {
    if (!this.enabled) return;
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain(); this.master.gain.value = this.masterVolume; this.master.connect(this.ctx.destination);
      this.sfxBus = this.ctx.createGain(); this.sfxBus.gain.value = this.soundVolume; this.sfxBus.connect(this.master);
      this.musicBus = this.ctx.createGain(); this.musicBus.gain.value = this.musicVolume; this.musicBus.connect(this.master);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  // ---------------------------------------------------------------- decoding
  rawOf(ref) {
    if (!ref || !ref.exp) return null;
    let r = this.raw.get(ref.exp);
    if (!r) {
      try { r = ref.exp.className === 'Music' ? readMusic(ref.pkg, ref.exp) : readSound(ref.pkg, ref.exp); }
      catch (e) { r = null; }
      this.raw.set(ref.exp, r);
    }
    return r;
  }

  duration(ref) {
    const r = this.rawOf(ref);
    if (!r) return 0;
    if (r.duration !== undefined) return r.duration;
    const f = String(r.format).toLowerCase();
    r.duration = f === 'wav' ? wavDuration(r.data) : mpegDuration(r.data);
    return r.duration;
  }

  buffer(ref) {
    if (!ref || !ref.exp || !this.ctx) return null;
    const key = ref.exp;
    if (this.decoded.has(key)) return Promise.resolve(this.decoded.get(key));
    let p = this.buffers.get(key);
    if (!p) {
      p = this._decode(ref).then(b => { this.decoded.set(key, b); return b; }).catch(e => { console.warn('audio decode', ref.Name, e); return null; });
      this.buffers.set(key, p);
    }
    return p;
  }

  async _decode(ref) {
    const r = this.rawOf(ref);
    if (!r) return null;
    const f = String(r.format).toLowerCase();
    if (f === 'wav') return this.ctx.decodeAudioData(r.data.slice().buffer);
    // one decoder instance: serialize decodes, and reset() is async
    const run = async () => {
      await this.mpegReady;
      await this.mpeg.reset();
      return this.mpeg.decode(r.data);
    };
    const job = (this.mpegQueue || Promise.resolve()).then(run, run);
    this.mpegQueue = job.catch(() => {});
    const out = await job;
    if (!out.samplesDecoded) return null;
    const ch = out.channelData.length;
    const buf = this.ctx.createBuffer(ch, out.samplesDecoded, out.sampleRate);
    for (let c = 0; c < ch; c++) buf.copyToChannel(out.channelData[c].subarray(0, out.samplesDecoded), c);
    return buf;
  }

  // ---------------------------------------------------------------- voices
  makeVoice(actor, ref, { volume = 1, radius = 0, pitch = 1, loop = false, positional = true, bus } = {}) {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, Math.min(1, volume));
    let panner = null;
    if (positional) {
      panner = ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'linear';
      panner.refDistance = 1; // volume x (1 - d/R)
      panner.maxDistance = Math.max(64, radius);
      panner.rolloffFactor = 1;
      gain.connect(panner); panner.connect(bus || this.sfxBus);
    } else gain.connect(bus || this.sfxBus);
    const v = { actor, ref, gain, panner, src: null, loop, pitch, ended: false, startTime: ctx.currentTime };
    this.buffer(ref)?.then(buf => {
      if (!buf || v.ended) return;
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = loop;
      src.playbackRate.value = Math.max(0.1, pitch);
      src.connect(gain);
      src.onended = () => { if (!loop) this.endVoice(v); };
      src.start();
      v.src = src;
    });
    this.playing.add(v);
    if (panner) this.placeVoice(v);
    return v;
  }

  endVoice(v) {
    if (v.ended) return;
    v.ended = true;
    if (v.timer) clearTimeout(v.timer);
    try { v.src?.stop(); } catch { /* already stopped */ }
    try { v.gain.disconnect(); v.panner?.disconnect(); } catch { /* ignore */ }
    this.playing.delete(v);
  }

  placeVoice(v) {
    const a = v.actor;
    if (!v.panner || !a || !a.Location) return;
    const p = v.panner;
    // Unreal -> three-style coordinates (x, z, y), consistent with listener
    const t = this.ctx.currentTime;
    p.positionX.setValueAtTime(a.Location.X, t);
    p.positionY.setValueAtTime(a.Location.Z, t);
    p.positionZ.setValueAtTime(a.Location.Y, t);
  }

  // first-person sounds (the player's own, or its owned actors') and actorless ones play without 3D;
  // HUD/console actors count as the player's interface
  isUISound(actor, slot) {
    const e = this.engine, p = e.player;
    if (!actor || !actor.Location || slot === 6 || actor === p?.myHUD) return true;
    for (let a = actor; a; a = a.Owner) if (a === p) return true;
    return false;
  }

  // the playing voice of an actor in a slot (SLOT_None voices each get their own slot)
  voiceIn(actor, slot) {
    const v = slot === SLOT_None ? null : this.slots.get(actor)?.get(slot);
    return v && !v.ended ? v : null;
  }

  // ALAudio PlaySound: a voice in the same actor slot is replaced, unless the new sound is bNoOverride;
  // volume clamped to [0.01, 1], pitch to [0.1, 2]
  playSound(actor, ref, slot, volume, noOverride, radius, pitch) {
    if (!ref || !ref.exp) return;
    if (actor?.__deleted) actor = null;
    const cur = actor ? this.voiceIn(actor, slot) : null;
    if (cur) {
      if (noOverride) return;
      this.endVoice(cur);
    }
    const v = this.ctx && this.ctx.state === 'running'
      ? this.makeVoice(actor, ref, { volume: Math.min(1, Math.max(0.01, volume)), radius: radius || 1600, pitch: Math.min(2, Math.max(0.1, pitch)), positional: !this.isUISound(actor, slot) })
      : this.silentVoice(actor, ref);
    v.slot = slot;
    if (actor && slot !== SLOT_None) {
      let map = this.slots.get(actor);
      if (!map) { map = new Map(); this.slots.set(actor, map); }
      map.set(slot, v);
    }
    return v;
  }

  // without a running audio context sounds still occupy their slot for their duration, so
  // bNoOverride / ModifySound behave as when audible
  silentVoice(actor, ref) {
    const v = { actor, ref, ended: false, silent: true };
    const d = this.duration(ref);
    this.playing.add(v);
    v.timer = setTimeout(() => this.endVoice(v), Math.max(0, d) * 1000);
    v.timer.unref?.();
    return v;
  }

  // the voices StopSound / ModifySound address: the actor's, in that slot (SLOT_None: any played in
  // SLOT_None), of that sound when one is given
  addressed(actor, ref, slot) {
    return [...this.playing].filter(v => v.actor === actor && !v.isMusic && v.slot !== undefined && v.slot === slot && (!ref || v.ref === ref));
  }

  stopSound(actor, ref, slot = 1) {
    const vs = this.addressed(actor, ref, slot);
    for (const v of vs) this.endVoice(v);
    return vs.length > 0;
  }

  // SOUND_Volume (clamped 0.01..1), SOUND_Radius, SOUND_Pitch (clamped 0.1..2)
  modifySound(actor, ref, slot, param, value) {
    const vs = this.addressed(actor, ref, slot);
    for (const v of vs) {
      if (param === 0) { v.volume = Math.min(1, Math.max(0.01, value)); if (v.gain) v.gain.gain.value = v.volume; }
      else if (param === 1) { v.radius = value; if (v.panner) v.panner.maxDistance = Math.max(64, value); }
      else if (param === 2) { v.pitch = Math.min(2, Math.max(0.1, value)); if (v.src) v.src.playbackRate.value = v.pitch; }
    }
    return vs.length > 0;
  }

  // ---------------------------------------------------------------- music
  playMusic(ref, transition = 1) {
    if (!this.ctx) return;
    if (this.music && this.music.ref === ref) return;
    const old = this.music;
    if (old) {
      const t = this.ctx.currentTime;
      const fade = transition === 1 ? 0.05 : transition === 4 ? 0.5 : transition === 5 ? 3 : 1.5;
      old.gain.gain.setTargetAtTime(0, t, fade / 3);
      setTimeout(() => this.endVoice(old), fade * 1000 + 200);
    }
    if (!ref || !ref.exp) { this.music = null; return; }
    const p = this.engine.player;
    const v = this.makeVoice(null, ref, { volume: 1, positional: false, loop: !(p && p.bDontLoopSong), bus: this.musicBus });
    v.isMusic = true;
    this.music = v;
  }

  // ---------------------------------------------------------------- per frame
  update(view) {
    if (!this.ctx) return;
    const e = this.engine;
    const L = this.ctx.listener;
    if (view) {
      const t = this.ctx.currentTime;
      const RU = Math.PI / 32768;
      const yaw = view.rot.Yaw * RU, pitch = view.rot.Pitch * RU;
      const fx = Math.cos(pitch) * Math.cos(yaw), fy = Math.sin(pitch), fz = Math.cos(pitch) * Math.sin(yaw);
      if (L.positionX) {
        L.positionX.setValueAtTime(view.loc.X, t); L.positionY.setValueAtTime(view.loc.Z, t); L.positionZ.setValueAtTime(view.loc.Y, t);
        L.forwardX.setValueAtTime(fx, t); L.forwardY.setValueAtTime(fy, t); L.forwardZ.setValueAtTime(fz, t);
        L.upX.setValueAtTime(0, t); L.upY.setValueAtTime(1, t); L.upZ.setValueAtTime(0, t);
      }
    }
    for (const v of this.playing) {
      if (v.actor && v.actor.__deleted && !v.loop) continue;
      if (v.panner) this.placeVoice(v);
    }
    // ambient sounds
    const lvl = e.level;
    if (lvl && view) {
      const seen = new Set();
      for (const a of lvl.actors) {
        const snd = a.AmbientSound;
        if (!snd || !snd.exp || a.__deleted) continue;
        const radius = 25 * ((a.SoundRadius ?? 32) + 1);
        const dx = a.Location.X - view.loc.X, dy = a.Location.Y - view.loc.Y, dz = a.Location.Z - view.loc.Z;
        if (dx * dx + dy * dy + dz * dz > radius * radius * 1.2) continue;
        seen.add(a);
        let v = this.ambient.get(a);
        if (v && v.ref !== snd) { this.endVoice(v); v = null; }
        if (!v) {
          v = this.makeVoice(a, snd, { volume: (a.SoundVolume ?? 128) / 255, radius, pitch: (a.SoundPitch ?? 64) / 64, loop: true, positional: true });
          this.ambient.set(a, v);
        } else v.gain.gain.value = (a.SoundVolume ?? 128) / 255;
      }
      for (const [a, v] of this.ambient) if (!seen.has(a)) { this.endVoice(v); this.ambient.delete(a); }
    }
    // music transitions requested by script (PlayerPawn.Song / Transition)
    const p = e.player;
    if (p && p.Transition) {
      const tr = p.Transition;
      p.Transition = 0;
      this.playMusic(p.Song, tr);
    }
  }

  stopAll() {
    for (const v of [...this.playing]) this.endVoice(v);
    this.ambient.clear(); this.slots.clear(); this.music = null;
  }
}
