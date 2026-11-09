// Web MIDI: Hot-Plug, Eingangsauswahl, MIDI Learn, Live-Monitor.
import { Emitter, logError } from './util.js';

export class Midi extends Emitter {
  constructor() {
    super();
    this.access = null;
    this.selected = 'all';
    this.status = 'nicht initialisiert';
    this.statusKind = '';
    this.inputs = [];
    this.learn = null;     // { padId, fn }
    this.monitor = false;
    this.handler = null;   // (msg) => void, für normale Trigger
    this.supported = typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess;
  }

  async init() {
    if (!this.supported) { this._setStatus('nicht unterstützt', 'bad'); return; }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.access.onstatechange = () => this._sync();
      this._sync();
    } catch (e) {
      logError('MIDI', e);
      this._setStatus('Zugriff verweigert', 'bad');
    }
  }

  _setStatus(s, kind) {
    this.status = s;
    this.statusKind = kind;
    this.emit('devices');
  }

  _sync() {
    const list = [];
    for (const inp of this.access.inputs.values()) {
      list.push({ id: inp.id, name: inp.name || inp.id, manufacturer: inp.manufacturer || '', state: inp.state });
      if (inp.state === 'connected') {
        inp.onmidimessage = (ev) => this._onMsg(inp, ev);
        try { const p = inp.open && inp.open(); if (p && p.catch) p.catch(() => {}); } catch { /* ignorieren */ }
      }
    }
    this.inputs = list;
    const conn = list.filter((i) => i.state === 'connected');
    if (this.selected !== 'all' && !conn.some((i) => i.id === this.selected)) {
      this._setStatus('gewählter Eingang fehlt', 'warn');
    } else if (!conn.length) this._setStatus('kein Eingang verbunden', 'warn');
    else this._setStatus(`${conn.length} Eingang${conn.length === 1 ? '' : 'e'}`, 'ok');
  }

  setSelected(id) { this.selected = id || 'all'; if (this.access) this._sync(); }

  _onMsg(inp, ev) {
    if (this.selected !== 'all' && inp.id !== this.selected) return;
    const d = ev.data;
    if (!d || d.length < 2) return;
    const st = d[0];
    if (st >= 0xf0) return; // Realtime/Sysex ignorieren
    const kind = st & 0xf0, ch = (st & 0x0f) + 1;
    let msg;
    if (kind === 0x90 && d[2] > 0) msg = { type: 'note', ch, num: d[1], val: d[2], on: true };
    else if (kind === 0x80 || kind === 0x90) msg = { type: 'note', ch, num: d[1], val: 0, on: false };
    else if (kind === 0xb0) msg = { type: 'cc', ch, num: d[1], val: d[2] };
    else return;
    if (this.monitor) this.emit('monitor', inp.name, msg);
    if (this.learn) { this._learnMsg(msg); return; }
    if (this.handler) this.handler(msg);
  }

  startLearn(padId, fn) { this.learn = { padId, fn }; this.emit('learn', this.learn); }
  cancelLearn() { if (!this.learn) return; this.learn = null; this.emit('learn', null); }

  _learnMsg(m) {
    if (m.type === 'note' && !m.on) return;
    if (this.learn.fn === 'volume' && m.type === 'note') { this.emit('learn-warn'); return; }
    const l = this.learn;
    this.learn = null;
    this.emit('learn-done', l, { type: m.type, channel: m.ch, number: m.num });
    this.emit('learn', null);
  }
}
