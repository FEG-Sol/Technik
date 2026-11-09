// Oberfläche: Toasts, Banner, Overlay, Bestätigungsdialog, Pad-Ansicht mit Pegelanzeigen.
import { h, $, fmtTime } from './util.js';

const STATE_TEXT = {
  empty: 'LEER', loading: 'LÄDT …', missing: 'DATEI FEHLT', error: 'FEHLER',
  stopped: 'GESTOPPT', playing: '▶ SPIELT', paused: '❚❚ PAUSE',
};

export const hasFiles = (e) => !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');

export function toast(msg, kind = 'info', ms = 4500) {
  const el = h('div', { class: 'toast ' + kind, text: msg });
  const box = $('#toasts');
  box.append(el);
  // Toasts sollen auch über geöffneten modalen Dialogen (Pad-Einstellungen, Einstellungen) sichtbar sein:
  // als Popover liegen sie im Top-Layer; erneutes Öffnen schiebt sie ganz nach oben.
  try {
    if (!box.hasAttribute('popover')) box.setAttribute('popover', 'manual');
    if (box.matches(':popover-open')) box.hidePopover();
    box.showPopover();
  } catch { /* Browser ohne Popover-API: Toast bleibt normal sichtbar */ }
  setTimeout(() => el.remove(), ms);
}

export function banner(id, text, { kind = 'warn', actions = [], dismissable = true } = {}) {
  const box = $('#banners');
  const old = box.querySelector(`[data-id="${id}"]`);
  const el = h('div', { class: 'banner ' + kind, dataset: { id } },
    h('span', { class: 'msg', text }),
    ...actions.map((a) => h('button', { text: a.label, onclick: a.fn })),
    dismissable ? h('button', { class: 'x', text: '✕', title: 'Ausblenden', onclick: () => el.remove() }) : null);
  if (old) old.replaceWith(el); else box.append(el);
}

export const clearBanner = (id) => { const el = $('#banners').querySelector(`[data-id="${id}"]`); if (el) el.remove(); };

export function confirmDialog(message, okLabel = 'OK', danger = false) {
  return new Promise((res) => {
    const d = h('dialog', { class: 'confirm' },
      h('div', { class: 'dlg-body' }, h('p', { text: message })),
      h('div', { class: 'dlg-foot' },
        h('button', { text: 'Abbrechen', onclick: () => d.close('no') }),
        h('button', { class: danger ? 'danger' : 'primary', text: okLabel, onclick: () => d.close('yes') })));
    d.addEventListener('close', () => { res(d.returnValue === 'yes'); d.remove(); });
    document.body.append(d);
    d.showModal();
  });
}

export function showOverlay(text) {
  if (text) $('#overlay-text').textContent = text;
  $('#overlay').classList.add('show');
  $('#overlay-btn').focus();
}
export const hideOverlay = () => $('#overlay').classList.remove('show');

// ------------------------------------------------------------------ Pad-Ansicht
const BAR_H = 40; // Höhe der Pegelbalken in px (muss zu .m-bar in style.css passen)
const FALL = 1.6, PEAK_FALL = 0.6, HOLD_MS = 1200; // Abfall in "Skala pro Sekunde"
const toNorm = (a) => (a <= 0.001 ? 0 : Math.min(1, (20 * Math.log10(a) + 60) / 60)); // -60..0 dBFS

export class PadView {
  constructor(pad, app) {
    this.pad = pad;
    this.app = app;
    this.nch = -1;
    this.mEls = [];
    this.disp = new Float32Array(0);
    this.peak = new Float32Array(0);
    this.peakT = new Float64Array(0);
    this.lastFr = -1;
    this.lastT = -1;
    const R = (this.r = {});
    this.root = h('div', { class: 'pad', dataset: { id: pad.id, state: pad.state } },
      h('div', { class: 'pad-top' },
        (R.grip = h('span', { class: 'grip edit-only', title: 'Ziehen zum Umsortieren', draggable: true, text: '⠿' })),
        (R.name = h('input', { type: 'text', class: 'name', maxLength: 80, spellcheck: false, title: 'Name (zum Umbenennen anklicken)' })),
        (R.gear = h('button', { class: 'icon edit-only', title:'Einstellungen: Lautstärke, Loop, Routing, MIDI Learn', text: '⚙' })),
        (R.del = h('button', { class: 'icon edit-only', title: 'Pad löschen', text: '✕' }))),
      h('div', { class: 'pad-meta' },
        (R.state = h('div', { class: 'pad-state' })),
        (R.info = h('div', { class: 'pad-info' })),
        (R.time = h('div', { class: 'time', text: '0:00.0 / 0:00.0' }))),
      (R.meters = h('div', { class: 'meters' })),
      h('div', { class: 'prog' }, (R.fill = h('div', { class: 'fill' }))),
      h('div', { class: 'row' },
        (R.play = h('button', { class: 'btn-play' })),
        (R.reset = h('button', { class: 'btn-reset', text: '⟲ Reset' }))),
      (R.midi = h('div', { class: 'midi-badges' })),
      (R.err = h('div', { class: 'pad-err' })),
      (R.assign = h('button', { class: 'btn-assign edit-only', text: 'Datei zuweisen …' })));
    this.bind();
    this.setShow(app.settings.showMode);
    pad.on('state', () => this.render());
    pad.on('data', () => this.render());
    this.render();
  }

  bind() {
    const { pad, app, r: R } = this;
    R.play.addEventListener('click', () => app.padAction(pad, 'toggle'));
    R.reset.addEventListener('click', () => pad.reset());
    R.gear.addEventListener('click', () => app.openRouting(pad));
    R.del.addEventListener('click', () => app.deletePad(pad));
    R.assign.addEventListener('click', () => app.pickFile(pad));
    R.name.addEventListener('change', () => { if (!app.settings.showMode) pad.setName(R.name.value.trim() || 'Pad'); });
    R.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') R.name.blur(); });

    // Umsortieren per Drag & Drop (nur über den Griff)
    R.grip.addEventListener('dragstart', (e) => {
      if (app.settings.showMode) { e.preventDefault(); return; }
      app.dragId = pad.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', pad.id);
      e.dataTransfer.setDragImage(this.root, 30, 20);
      this.root.classList.add('dragging');
    });
    R.grip.addEventListener('dragend', () => { app.dragId = null; this.root.classList.remove('dragging'); app.clearDropMarks(); });
    this.root.addEventListener('dragover', (e) => {
      if (app.dragId) {
        if (app.dragId === pad.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rc = this.root.getBoundingClientRect();
        const after = e.clientX > rc.left + rc.width / 2;
        this.root.classList.toggle('drop-before', !after);
        this.root.classList.toggle('drop-after', after);
      } else if (hasFiles(e) && !app.settings.showMode) {
        e.preventDefault();
        this.root.classList.add('drop-file');
      }
    });
    this.root.addEventListener('dragleave', () => this.root.classList.remove('drop-before', 'drop-after', 'drop-file'));
    this.root.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const after = this.root.classList.contains('drop-after');
      this.root.classList.remove('drop-before', 'drop-after', 'drop-file');
      document.body.classList.remove('dropping');
      if (app.dragId) { app.movePad(app.dragId, pad.id, after); app.dragId = null; }
      else if (!app.settings.showMode && e.dataTransfer.files.length) app.addFiles([...e.dataTransfer.files], pad);
    });
  }

  setShow(on) {
    this.r.name.readOnly = on;
    this.r.grip.draggable = !on;
  }

  buildMeters(n) {
    this.nch = n;
    this.mEls = [];
    this.disp = new Float32Array(n);
    this.peak = new Float32Array(n);
    this.peakT = new Float64Array(n);
    this.r.meters.replaceChildren();
    for (let c = 0; c < n; c++) {
      const cover = h('div', { class: 'm-cover' });
      const pk = h('div', { class: 'm-peak' });
      this.r.meters.append(h('div', { class: 'meter' }, h('div', { class: 'm-bar' }, cover, pk), h('div', { class: 'm-label', text: String(c + 1) })));
      this.mEls.push({ cover, pk, d: 1, p: 0 });
    }
  }

  render() {
    const { pad: p, r: R, app } = this;
    this.root.dataset.state = p.state;
    R.state.textContent = STATE_TEXT[p.state] || p.state;
    const ready = p.ready;
    R.play.disabled = !ready;
    R.reset.disabled = !ready;
    R.play.textContent = p.state === 'playing' ? '❚❚ PAUSE' : '▶ PLAY';
    if (document.activeElement !== R.name) R.name.value = p.name;
    R.name.title = p.fileName ? `Datei: ${p.fileName}` : 'Name';

    if (p.buffer) {
      const n = p.buffer.numberOfChannels;
      R.info.textContent = `${n} ${n === 1 ? 'Kanal' : 'Kanäle'}`;
      R.info.title = `Dauer ${fmtTime(p.buffer.duration)} · ${n} ${n === 1 ? 'Kanal' : 'Kanäle'} · ${Math.round(p.buffer.sampleRate)} Hz` + (p.fileName ? ` · ${p.fileName}` : '');
    } else {
      R.info.textContent = p.state === 'loading' ? 'Lade …' : p.fileName || '';
      R.info.title = p.fileName || '';
      R.fill.style.transform = 'scaleX(0)';
      R.time.textContent = '0:00.0 / 0:00.0';
      this.lastFr = -1;
    }
    this.lastT = -1;
    R.err.textContent = p.error
      || (p.state === 'missing' ? 'Audiodatei nicht im Speicher – Datei zuweisen oder Projekt mit Audiodaten laden.' : '')
      || (p.unsaved ? '⚠ Nicht dauerhaft gespeichert (Speicher voll?) – Projekt als Datei sichern.' : '');
    R.assign.hidden = !(p.state === 'empty' || p.state === 'missing' || p.state === 'error');

    const nch = p.buffer ? p.buffer.numberOfChannels : 0;
    if (nch !== this.nch) this.buildMeters(nch);

    // Statuszeile: zeigt nur Abweichendes vom Standard (Loop, Lautstärke unter 100 %, MIDI-Zuweisungen, Gate)
    const fm = (fn, sym) => (p.midi[fn] ? `${sym} ${app.describeMapping(p.midi[fn], true)}` : '');
    R.midi.textContent = [
      p.loop ? '⟳ Loop' : '',
      p.volume < 100 ? `Vol ${p.volume} %` : '',
      fm('play', '▶'), fm('reset', '⟲'), fm('volume', 'CC-Vol'),
      p.gate ? '[Gate]' : '',
    ].filter(Boolean).join('  |  ');
  }

  // pro Animationsframe
  tick(now, dt) {
    const p = this.pad, R = this.r;
    if (p.buffer) {
      const pos = p.position(), dur = p.buffer.duration;
      const fr = dur > 0 ? pos / dur : 0;
      if (Math.abs(fr - this.lastFr) > 0.0005) { this.lastFr = fr; R.fill.style.transform = `scaleX(${fr})`; }
      const t = Math.floor(pos * 10);
      if (t !== this.lastT) { this.lastT = t; R.time.textContent = `${fmtTime(pos)} / ${fmtTime(dur)}`; }
    }
    const lv = p.state === 'playing' ? p.readLevels() : null;
    for (let c = 0; c < this.nch; c++) {
      const raw = lv ? toNorm(lv[c]) : 0;
      let d = this.disp[c];
      d = raw >= d ? raw : Math.max(raw, d - FALL * dt);
      this.disp[c] = d;
      let pk = this.peak[c];
      if (d >= pk) { pk = d; this.peakT[c] = now; } else if (now - this.peakT[c] > HOLD_MS) pk = Math.max(d, pk - PEAK_FALL * dt);
      this.peak[c] = pk;
      const m = this.mEls[c];
      if (Math.abs(d - m.d) > 0.004 || (d === 0 && m.d !== 0)) { m.d = d; m.cover.style.transform = `scaleY(${1 - d})`; }
      if (Math.abs(pk - m.p) > 0.004 || (pk === 0 && m.p !== 0)) {
        m.p = pk;
        m.pk.style.transform = `translateY(${(1 - pk) * (BAR_H - 2)}px)`;
        m.pk.style.background = pk >= 0.995 ? '#ff3b47' : '#fff';
      }
    }
  }
}
