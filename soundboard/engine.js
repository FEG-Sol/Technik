// Audio-Engine: AudioContext, Ausgabegerät, Pads (Voice, Graph, Routing, Pegel).
import { Emitter, logError, logMsg, uid, withTimeout } from './util.js';

export const FADE = 0.008;       // 8 ms bei Start/Pause/Stop/Reset
export const PANIC_FADE = 0.020; // 20 ms
export const MAX_CH = 32;        // Grenze von createChannelSplitter/-Merger in Chrome
const START_DELAY = 0.005;       // Voice startet 5 ms in der Zukunft -> exakte Positionsrechnung
const key = (c, o) => (c << 6) | o;

function rampTo(param, target, t, dur) {
  if (typeof param.cancelAndHoldAtTime === 'function') {
    try { param.cancelAndHoldAtTime(t); } catch { param.cancelScheduledValues(t); param.setValueAtTime(param.value, t); }
  } else {
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
  }
  param.linearRampToValueAtTime(target, t + dur);
}

export function defaultRouting(nch) {
  if (nch === 1) return [[0, 0], [0, 1]]; // Mono auf Ausgang 1 und 2
  const r = [];
  for (let c = 0; c < nch; c++) r.push([c, c]);
  return r;
}

// ------------------------------------------------------------------ Pad
// Zustände: empty | loading | missing | error | stopped | playing | paused
export class Pad extends Emitter {
  constructor(engine, d = {}) {
    super();
    this.engine = engine;
    this.id = d.id || uid();
    this.name = d.name || 'Neues Pad';
    this.audioId = d.audioId || null;
    this.fileName = d.fileName || '';
    this.mime = d.mime || '';
    this.loop = !!d.loop;
    this.gate = !!d.gate;
    this.volume = typeof d.volume === 'number' ? d.volume : 100;
    this.routing = Array.isArray(d.routing) ? d.routing.map((c) => [c[0], c[1]]) : null;
    this.midi = { play: null, reset: null, volume: null, ...(d.midi || {}) };
    this.buffer = null;
    this.state = this.audioId ? 'loading' : 'empty';
    this.error = '';
    this.unsaved = false;
    this.interrupted = false;
    this.offset = 0;
    this.startedAt = 0;
    this.voice = null;
    this.nodes = null;
    this.cells = new Map();
    this._tbuf = new Float32Array(1024); // wiederverwendet, keine Allokation im Pegel-Pfad
    this.levels = new Float32Array(0);
  }

  toJSON() {
    return {
      id: this.id, name: this.name, audioId: this.audioId, fileName: this.fileName, mime: this.mime,
      loop: this.loop, gate: this.gate, volume: this.volume,
      routing: this.routing ? this.routing.map((c) => [c[0], c[1]]) : null,
      midi: { play: this.midi.play, reset: this.midi.reset, volume: this.midi.volume },
    };
  }

  get channels() { return this.buffer ? this.buffer.numberOfChannels : 0; }
  get duration() { return this.buffer ? this.buffer.duration : 0; }
  get ready() {
    return !!this.buffer && !!this.nodes && (this.state === 'stopped' || this.state === 'playing' || this.state === 'paused');
  }

  setState(s, err = '') { this.state = s; this.error = err; this.emit('state'); }
  setLoading() { this._releaseAudio(); this.setState('loading'); }
  markMissing() { this._releaseAudio(); this.setState('missing'); }
  markError(msg) { this._releaseAudio(); this.setState('error', msg); }
  _releaseAudio() { this._hardStop(); this._disposeGraph(); this.buffer = null; this.offset = 0; this.interrupted = false; }

  setBuffer(buf, resetRouting = true, extra = null) {
    this._hardStop();
    this._disposeGraph();
    this.buffer = buf;
    this.offset = 0;
    this.interrupted = false;
    if (extra) Object.assign(this, extra);
    if (resetRouting || !this.routing) this.routing = defaultRouting(buf.numberOfChannels);
    this.levels = new Float32Array(buf.numberOfChannels);
    this.buildGraph();
    if (this.nodes) this.setState('stopped');
    this.emit('data');
  }

  // ---- Graph
  buildGraph() {
    this._disposeGraph();
    const e = this.engine, ctx = e.ctx;
    if (!ctx || !this.buffer) return;
    const nch = this.buffer.numberOfChannels;
    try {
      const n = { analysers: [] };
      n.splitter = ctx.createChannelSplitter(nch);
      for (let c = 0; c < nch; c++) {
        const a = ctx.createAnalyser();
        a.fftSize = 1024;
        a.smoothingTimeConstant = 0;
        n.splitter.connect(a, c); // Pegel pro Dateikanal, vor der Matrix
        n.analysers.push(a);
      }
      n.merger = ctx.createChannelMerger(e.outputCount);
      n.gain = ctx.createGain();
      n.gain.channelCount = e.outputCount;
      n.gain.channelCountMode = 'explicit';
      n.gain.channelInterpretation = 'discrete';
      n.gain.gain.value = this.volume / 100;
      n.merger.connect(n.gain);
      n.gain.connect(ctx.destination);
      this.nodes = n;
      this.cells.clear();
      this.applyRouting();
    } catch (err) {
      this.nodes = null;
      logError(`Graph "${this.name}"`, err);
      this.markError('Audio-Graph konnte nicht aufgebaut werden: ' + err.message);
    }
  }

  applyRouting() {
    const n = this.nodes;
    if (!n || !this.buffer) return;
    const ctx = this.engine.ctx;
    const nch = this.buffer.numberOfChannels, nout = this.engine.outputCount;
    const want = new Set();
    for (const [c, o] of this.routing || []) if (c < nch && o < nout) want.add(key(c, o));
    const t = ctx.currentTime;
    for (const [k, g] of this.cells) {
      if (want.has(k)) continue;
      this.cells.delete(k);
      try { rampTo(g.gain, 0, t, 0.01); } catch { /* ignorieren */ }
      setTimeout(() => {
        try { n.splitter.disconnect(g, k >> 6); } catch { /* ignorieren */ }
        try { g.disconnect(); } catch { /* ignorieren */ }
      }, 60);
    }
    for (const k of want) {
      if (this.cells.has(k)) continue;
      const g = ctx.createGain();
      g.channelCount = 1;
      g.channelCountMode = 'explicit';
      n.splitter.connect(g, k >> 6);
      g.connect(n.merger, 0, k & 63);
      if (this.state === 'playing') { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + 0.01); }
      this.cells.set(k, g);
    }
  }

  _disposeGraph() {
    const n = this.nodes;
    this.nodes = null;
    this.cells.clear();
    if (!n) return;
    const all = [n.splitter, ...n.analysers, n.merger, n.gain];
    for (const x of all) { try { x.disconnect(); } catch { /* ignorieren */ } }
  }

  // ---- Voice
  _startVoice(offset) {
    const ctx = this.engine.ctx, n = this.nodes, nch = this.buffer.numberOfChannels;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = this.loop;
    const env = ctx.createGain();
    env.channelCount = nch;
    env.channelCountMode = 'explicit';
    env.channelInterpretation = 'discrete';
    src.connect(env);
    env.connect(n.splitter);
    const t = ctx.currentTime + START_DELAY;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + FADE);
    const v = { src, env, t0: t };
    src.onended = () => this._ended(v);
    const off = offset >= this.buffer.duration ? 0 : offset;
    src.start(t, off);
    this.voice = v;
    this.startedAt = t;
    this.offset = off;
  }

  _ended(v) {
    try { v.src.disconnect(); v.env.disconnect(); } catch { /* ignorieren */ }
    if (this.voice === v) { // natürliches Ende (Single-Shot)
      this.voice = null;
      this.offset = 0;
      if (this.state === 'playing') this.setState('stopped');
    }
  }

  _stopVoice(fade) {
    const v = this.voice;
    if (!v) return;
    this.voice = null;
    const ctx = this.engine.ctx;
    try {
      const t = ctx.currentTime;
      if (t <= v.t0) { v.src.stop(v.t0); return; } // noch nicht gestartet
      rampTo(v.env.gain, 0, t, fade);
      v.src.stop(t + fade + 0.005);
    } catch { try { v.src.stop(); } catch { /* ignorieren */ } }
  }

  _hardStop() {
    const v = this.voice;
    if (!v) return;
    this.voice = null;
    try { v.src.stop(); } catch { /* ignorieren */ }
    try { v.src.disconnect(); v.env.disconnect(); } catch { /* ignorieren */ }
  }

  // ---- Bedienung
  position() {
    if (this.state === 'playing' && this.voice && this.buffer) {
      const d = this.buffer.duration;
      const p = this.offset + Math.max(0, this.engine.ctx.currentTime - this.startedAt);
      return this.loop ? p % d : Math.min(p, d);
    }
    return this.offset;
  }

  play() {
    if (!this.ready) return false;
    if (this.state === 'playing') return true;
    const ctx = this.engine.ctx;
    if (ctx.state !== 'running') { this.engine.emit('blocked'); this.engine._tryResume(); return false; }
    try {
      this.interrupted = false;
      this._startVoice(this.state === 'paused' ? this.offset : 0);
      this.setState('playing');
      return true;
    } catch (e) {
      logError(`Play "${this.name}"`, e);
      this.engine.emit('message', 'error', `„${this.name}“ konnte nicht starten: ${e.message}`);
      return false;
    }
  }

  pause() {
    if (this.state !== 'playing') return;
    const pos = this.position();
    this._stopVoice(FADE);
    if (!this.loop && pos >= this.buffer.duration - 0.01) { this.offset = 0; this.setState('stopped'); return; }
    this.offset = pos;
    this.setState('paused');
  }

  toggle() { return this.state === 'playing' ? (this.pause(), true) : this.play(); }

  reset(fade = FADE) {
    this.interrupted = false;
    this._stopVoice(fade);
    this.offset = 0;
    if (this.buffer && this.nodes && this.state !== 'stopped') this.setState('stopped');
    else if (this.state === 'stopped') this.emit('state');
  }

  gateOn() { if (this.state === 'playing') return; this.reset(0.002); this.play(); }
  gateOff() { if (this.state === 'playing' || this.state === 'paused') this.reset(); }

  setLoop(b) {
    if (this.state === 'playing' && this.voice) {
      this.offset = this.position();
      this.startedAt = this.engine.ctx.currentTime;
      this.voice.src.loop = b;
    }
    this.loop = b;
    this.emit('data');
  }

  setGate(b) { this.gate = !!b; this.emit('data'); }
  setName(n) { this.name = n; this.emit('data'); }
  setMidi(fn, m) { this.midi[fn] = m; this.emit('data'); }

  setVolume(pct) {
    const v = Math.min(100, Math.max(0, Math.round(pct)));
    this.volume = v;
    if (this.nodes) this.nodes.gain.gain.setTargetAtTime(v / 100, this.engine.ctx.currentTime, 0.015);
    this.emit('data');
  }

  setRouting(arr) { this.routing = arr; this.applyRouting(); this.emit('data'); }

  toggleCell(c, o) {
    const r = (this.routing || []).slice();
    const i = r.findIndex((x) => x[0] === c && x[1] === o);
    if (i >= 0) r.splice(i, 1); else r.push([c, o]);
    this.setRouting(r);
  }

  readLevels() {
    const n = this.nodes;
    if (!n) return null;
    const buf = this._tbuf, lv = this.levels;
    for (let c = 0; c < n.analysers.length; c++) {
      n.analysers[c].getFloatTimeDomainData(buf);
      let m = 0;
      for (let i = 0; i < buf.length; i++) { const a = buf[i] < 0 ? -buf[i] : buf[i]; if (a > m) m = a; }
      lv[c] = m;
    }
    return lv;
  }

  // Für Context-Neuaufbau: laufenden Sound mit Position merken, alles hart abbauen
  _freezeForRebuild() {
    if (this.state === 'playing') {
      const pos = this.position();
      this._hardStop();
      this.offset = pos >= this.duration ? 0 : pos;
      this.interrupted = true;
      this.state = 'paused';
    } else this._hardStop();
    this._disposeGraph();
  }

  dispose() {
    this._stopVoice(FADE);
    setTimeout(() => this._disposeGraph(), 80);
    this.buffer = null;
    this.clear();
  }
}

// ------------------------------------------------------------------ Engine
export class Engine extends Emitter {
  constructor() {
    super();
    this.ctx = null;
    this.pads = [];
    this.cfg = { sinkId: '', sinkLabel: '', latency: 'balanced' };
    this.outputCount = 2;
    this.maxChannels = 2;
    this.activeSinkId = '';
    this.devices = [];
    this._tests = new Set();
    this._stall = 0;
    this._lastTime = -1;
    this._lastResume = 0;
    this._forceDefault = false;
    this._rebuilding = false;
    this._watching = false;
  }

  async start(cfg) {
    Object.assign(this.cfg, cfg);
    await this._create();
    this._watch();
  }

  async listOutputs() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      this.devices = all.filter((d) => d.kind === 'audiooutput');
    } catch (e) { logError('enumerateDevices', e); }
    return this.devices;
  }

  async _resolveSink() {
    if (this._forceDefault) return '';
    const want = this.cfg.sinkId;
    if (!want) return '';
    const outs = await this.listOutputs();
    if (outs.some((d) => d.deviceId === want)) return want;
    if (this.cfg.sinkLabel) {
      const m = outs.find((d) => d.label && d.label === this.cfg.sinkLabel);
      if (m) { this.cfg.sinkId = m.deviceId; return m.deviceId; }
    }
    this.emit('message', 'warn', 'Gespeichertes Ausgabegerät nicht gefunden – Standardgerät ist aktiv.');
    return '';
  }

  async _create() {
    const target = await this._resolveSink();
    const ctx = new AudioContext({ latencyHint: this.cfg.latency || 'balanced' });
    this.ctx = ctx;
    ctx.onstatechange = () => {
      this.emit('state', ctx.state);
      if (ctx.state !== 'running') this._tryResume();
    };
    ctx.addEventListener('sinkchange', () => this._onSinkChange(ctx));
    this.activeSinkId = '';
    if (target && typeof ctx.setSinkId === 'function') {
      try { await ctx.setSinkId(target); this.activeSinkId = target; } catch (e) {
        logError('setSinkId', e);
        this.emit('message', 'warn', 'Ausgabegerät konnte nicht gesetzt werden (' + e.message + ') – Standardgerät aktiv.');
      }
    }
    this._configureOutputs();
    // Kanalzahl kann sich kurz nach dem Gerätewechsel noch ändern: einmal nachprüfen
    setTimeout(() => {
      if (this.ctx !== ctx) return;
      const max = Math.min(MAX_CH, Math.max(1, ctx.destination.maxChannelCount || 2));
      if (max !== this.outputCount && !this._rebuilding) {
        logMsg('warn', 'engine', `Kanalzahl hat sich geändert (${this.outputCount} -> ${max}), baue neu auf.`);
        this.rebuild('channels-changed');
      }
    }, 1200);
  }

  _configureOutputs() {
    const d = this.ctx.destination;
    const max = Math.max(1, d.maxChannelCount || 2);
    this.maxChannels = max;
    const n = Math.min(max, MAX_CH);
    try {
      d.channelCount = n;
      d.channelCountMode = 'explicit';
      d.channelInterpretation = 'discrete';
    } catch (e) { logError('destination.channelCount', e); }
    this.outputCount = Math.max(1, Math.min(d.channelCount || n, MAX_CH));
  }

  _onSinkChange(ctx) {
    if (ctx !== this.ctx || this._rebuilding) return;
    const prev = this.outputCount;
    this._configureOutputs();
    if (this.outputCount !== prev) this.rebuild('sinkchange'); else this.emit('outputs');
  }

  async rebuild(reason, opts = {}) {
    if (this._rebuilding) return;
    this._rebuilding = true;
    this._forceDefault = !!opts.fallback;
    try {
      logMsg('info', 'engine', 'Audio-Neuaufbau: ' + reason);
      const old = this.ctx;
      for (const p of this.pads) p._freezeForRebuild();
      if (old) {
        old.onstatechange = null;
        await withTimeout(old.close().catch(() => {}), 1500);
      }
      await this._create();
      for (const p of this.pads) if (p.buffer) p.buildGraph();
      for (const p of this.pads) p.emit('state');
      this.emit('rebuilt', reason);
      this.emit('state', this.ctx.state);
    } catch (e) {
      logError('rebuild', e);
      this.emit('message', 'error', 'Audio-Neuaufbau fehlgeschlagen: ' + e.message);
    } finally {
      this._forceDefault = false;
      this._rebuilding = false;
    }
  }

  async setSink(id, label) {
    this.cfg.sinkId = id;
    this.cfg.sinkLabel = label || '';
    await this.rebuild('sink');
  }

  _tryResume() {
    const now = performance.now();
    if (!this.ctx || now - this._lastResume < 1000) return;
    this._lastResume = now;
    this.ctx.resume().catch(() => {});
  }

  async resume() {
    if (!this.ctx) return false;
    if (this.ctx.state === 'running') return true;
    try { await this.ctx.resume(); } catch (e) { logError('resume', e); }
    return this.ctx.state === 'running';
  }

  _watch() {
    if (this._watching) return;
    this._watching = true;
    try { navigator.mediaDevices.addEventListener('devicechange', () => this._onDeviceChange()); } catch (e) { logError('devicechange', e); }
    setInterval(() => this._tick(), 1000); // Watchdog, nicht zeitkritisch
    this.listOutputs();
  }

  async _onDeviceChange() {
    const outs = await this.listOutputs();
    this.emit('devices', outs);
    const want = this.cfg.sinkId;
    if (!want || this._rebuilding) return;
    const present = outs.some((d) => d.deviceId === want);
    if (!present && this.activeSinkId === want) {
      this.emit('message', 'error', 'Ausgabegerät verschwunden – wechsle auf das Standardgerät.');
      await this.rebuild('device-lost', { fallback: true });
    } else if (present && this.activeSinkId !== want) {
      if (this.pads.some((p) => p.state === 'playing')) this.emit('device-back');
      else {
        this.emit('message', 'info', 'Ausgabegerät ist wieder da – verbinde neu.');
        await this.rebuild('device-back');
      }
    }
  }

  _tick() {
    const ctx = this.ctx;
    if (!ctx || this._rebuilding) return;
    if (ctx.state !== 'running') { this._tryResume(); this._stall = 0; return; }
    const playing = this.pads.some((p) => p.state === 'playing');
    if (playing && ctx.currentTime === this._lastTime) {
      if (++this._stall >= 3) {
        this._stall = 0;
        logMsg('warn', 'engine', 'Audio-Uhr steht still – Neuaufbau.');
        this.emit('message', 'error', 'Audio hängt (Uhr steht) – baue Audio neu auf.');
        this.rebuild('stall');
      }
    } else this._stall = 0;
    this._lastTime = ctx.currentTime;
  }

  decode(ab) {
    return this.ctx.decodeAudioData(ab).then((buf) => {
      if (buf.numberOfChannels > MAX_CH) throw new Error(`Datei hat ${buf.numberOfChannels} Kanäle (max. ${MAX_CH} unterstützt).`);
      return buf;
    });
  }

  panic() {
    for (const p of this.pads) {
      try { if (p.state === 'playing' || p.state === 'paused') p.reset(PANIC_FADE); } catch (e) { logError('panic', e); }
    }
    for (const o of this._tests) { try { o.stop(); } catch { /* ignorieren */ } }
    this._tests.clear();
  }

  memoryBytes() {
    let b = 0;
    for (const p of this.pads) if (p.buffer) b += p.buffer.length * p.buffer.numberOfChannels * 4;
    return b;
  }

  // Testton (440 Hz, -20 dBFS) auf genau einen Ausgang, direkt am destination, unabhängig von den Pads
  testTone(out, when, dur = 1.0) {
    const ctx = this.ctx;
    if (!ctx || out >= this.outputCount) return;
    const t = when ?? ctx.currentTime + 0.05;
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.1, t + 0.01);
    g.gain.setValueAtTime(0.1, t + dur - 0.02);
    g.gain.linearRampToValueAtTime(0, t + dur);
    const m = ctx.createChannelMerger(this.outputCount);
    osc.connect(g);
    g.connect(m, 0, out);
    m.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.01);
    this._tests.add(osc);
    osc.onended = () => {
      this._tests.delete(osc);
      try { osc.disconnect(); g.disconnect(); m.disconnect(); } catch { /* ignorieren */ }
    };
  }

  testSweep() {
    const step = 1.4, t0 = this.ctx.currentTime + 0.1;
    for (let o = 0; o < this.outputCount; o++) this.testTone(o, t0 + o * step, 1.0);
    return { t0, step, n: this.outputCount };
  }
}
