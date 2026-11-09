// Orchestrierung: Projektzustand, Autosave, Drag & Drop, Show-Modus, MIDI-Trigger, Robustheit.
import { $, h, debounce, uid, fmtBytes, logError, logMsg, log } from './util.js';
import {
  loadProject, saveProject, putAudio, getAudio, deleteAudio, listAudioKeys, clearAudio,
  requestPersist, storageEstimate,
} from './store.js';
import { Engine, Pad } from './engine.js';
import { Midi } from './midi.js';
import { serializeProject, sanitizeProject, exportProjectBlob, parseProjectFile } from './project.js';
import { PadView, toast, banner, clearBanner, confirmDialog, showOverlay, hideOverlay, hasFiles } from './ui.js';
import { openRouting, openSettings } from './dialogs.js';

// ---- Schwellen für die RAM-Warnung (anpassbar) ----
const WARN_BYTES = 1 * 1024 ** 3;
const CRIT_BYTES = 2 * 1024 ** 3;

const SETTINGS_KEY = 'soundboard.settings.v1';
const DEFAULTS = { sinkId: '', sinkLabel: '', midiInput: 'all', latency: 'balanced', shortcuts: false, exportAudio: true, showMode: false };
const FN_LABEL = { play: 'Play/Pause', reset: 'Reset', volume: 'Lautstärke' };
const LATENCIES = ['interactive', 'balanced', 'playback'];

function loadSettings() {
  try {
    const s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    if (!LATENCIES.includes(s.latency)) s.latency = 'balanced';
    s.showMode = s.showMode === true;
    s.shortcuts = s.shortcuts === true;
    s.exportAudio = s.exportAudio !== false;
    if (typeof s.midiInput !== 'string') s.midiInput = 'all';
    return s;
  } catch { return { ...DEFAULTS }; }
}
const settings = loadSettings();
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { logError('Einstellungen', e); } };

const engine = new Engine();
const midi = new Midi();
const views = new Map();
const grid = $('#grid');

let dirty = false;
let wakeLock = null;
let hiddenSince = 0;

const app = {
  engine, midi, settings, views, dragId: null,
  persisted: null, storageInfo: null, wakeLockActive: false,
  openRouting: (pad) => openRouting(app, pad),
  deletePad, movePad, addFiles, pickFile, startLearn, clearMapping, findDuplicates, describeMapping,
  copyRoutingToAll, changeSink, reconnectAudio, unlockDeviceLabels, updateErrChip,
  padAction, clearDropMarks,
  setMidiInput(id) { settings.midiInput = id; saveSettings(); midi.setSelected(id); },
  setLatency(v) { settings.latency = v; engine.cfg.latency = v; saveSettings(); reconnectAudio(); },
  setShortcuts(b) { settings.shortcuts = b; saveSettings(); },
  setExportAudio(b) { settings.exportAudio = b; saveSettings(); },
};
window.soundboard = app; // Debug-Zugriff über die Chrome-Konsole (F12)

// ------------------------------------------------------------------ Autosave
const doSave = async () => {
  try {
    await saveProject(serializeProject(engine));
    dirty = false;
    clearBanner('save-error');
  } catch (e) {
    logError('Autosave', e);
    banner('save-error', 'Autosave fehlgeschlagen: ' + (e.message || e) + ' – bitte Projekt manuell speichern!', { kind: 'error' });
  }
};
const autosave = debounce(doSave, 700);
function changed() { dirty = true; autosave(); }

// ------------------------------------------------------------------ Anzeige-Chips
const hint = $('#hint');
const updateHint = () => { hint.hidden = engine.pads.length > 0; };

function deviceLabel() {
  if (!engine.activeSinkId) return 'Standardgerät';
  const d = engine.devices.find((x) => x.deviceId === engine.activeSinkId);
  return (d && d.label) || settings.sinkLabel || 'Gewähltes Gerät';
}

function updateAudioChip() {
  const c = $('#chip-audio');
  const st = engine.ctx ? engine.ctx.state : 'none';
  const stereo = engine.outputCount <= 2;
  c.textContent = `${st === 'running' ? '●' : '○'} ${deviceLabel()} · ${engine.outputCount} Ausg.${stereo ? ' (Stereo)' : ''}`;
  c.className = 'chip ' + (st !== 'running' ? 'bad' : stereo ? 'warn' : 'ok');
  c.title = `Zustand: ${st} · maxChannelCount: ${engine.maxChannels}`;
}

function updateMidiChip() {
  const c = $('#chip-midi');
  c.textContent = 'MIDI: ' + midi.status;
  c.className = 'chip ' + (midi.statusKind || '');
}

let memWarned = false;
function updateMemory() {
  const b = engine.memoryBytes();
  const c = $('#chip-mem');
  c.textContent = 'RAM ' + fmtBytes(b);
  c.className = 'chip ' + (b > CRIT_BYTES ? 'bad' : b > WARN_BYTES ? 'warn' : '');
  if (b > WARN_BYTES) {
    if (!memWarned || b > CRIT_BYTES) {
      memWarned = true;
      banner('mem', `Dekodierte Sounds belegen ${fmtBytes(b)} Arbeitsspeicher. Bei sehr großem Verbrauch kann Chrome den Tab beenden – ggf. Dateien kürzen oder Pads entfernen.`, { kind: b > CRIT_BYTES ? 'error' : 'warn' });
    }
  } else { memWarned = false; clearBanner('mem'); }
}

function updateErrChip() {
  const c = $('#chip-err');
  c.hidden = log.errors === 0;
  c.textContent = `Fehler ${log.errors}`;
}

function updateShowUi() {
  const on = settings.showMode;
  document.body.classList.toggle('show-mode', on);
  $('#chip-show').hidden = !on;
  $('#btn-show').textContent = on ? '🔓 Show-Modus beenden' : '🔒 Show-Modus';
  for (const v of views.values()) v.setShow(on);
}

function updateInterruptedBanner() {
  const list = engine.pads.filter((p) => p.interrupted && p.state === 'paused');
  if (!list.length) { clearBanner('interrupted'); return; }
  banner('interrupted', `${list.length} Sound${list.length === 1 ? '' : 's'} wurde${list.length === 1 ? '' : 'n'} durch einen Audio-Neuaufbau angehalten (Position gemerkt).`, {
    kind: 'warn',
    actions: [{ label: 'Alle fortsetzen', fn: () => { for (const p of list) p.play(); updateInterruptedBanner(); } }],
  });
}

// ------------------------------------------------------------------ Pads
function makePad(data) {
  const pad = new Pad(engine, data);
  engine.pads.push(pad);
  pad.on('data', changed);
  pad.on('state', () => { if (pad.interrupted || $('#banners [data-id="interrupted"]')) updateInterruptedBanner(); });
  const view = new PadView(pad, app);
  views.set(pad.id, view);
  grid.append(view.root);
  updateHint();
  return pad;
}

function removePadQuiet(pad) {
  pad.dispose();
  const i = engine.pads.indexOf(pad);
  if (i >= 0) engine.pads.splice(i, 1);
  const v = views.get(pad.id);
  if (v) v.root.remove();
  views.delete(pad.id);
}

async function deletePad(pad) {
  if (settings.showMode) return;
  if (!(await confirmDialog(`Pad „${pad.name}“ wirklich löschen?`, 'Löschen', true))) return;
  const id = pad.audioId;
  removePadQuiet(pad);
  if (id && !engine.pads.some((p) => p.audioId === id)) deleteAudio(id).catch((e) => logError('Audio löschen', e));
  changed();
  updateMemory();
  updateHint();
}

function movePad(id, targetId, after) {
  if (settings.showMode || id === targetId) return;
  const a = engine.pads.findIndex((p) => p.id === id);
  if (a < 0) return;
  const [pad] = engine.pads.splice(a, 1);
  let b = engine.pads.findIndex((p) => p.id === targetId);
  if (b < 0) b = engine.pads.length;
  engine.pads.splice(after ? b + 1 : b, 0, pad);
  grid.replaceChildren(...engine.pads.map((p) => views.get(p.id).root));
  changed();
}

function clearDropMarks() { for (const v of views.values()) v.root.classList.remove('drop-before', 'drop-after', 'drop-file'); }

function padAction(pad, act) {
  const run = () => { if (act === 'toggle') pad.toggle(); else if (act === 'reset') pad.reset(); };
  if (engine.ctx && engine.ctx.state === 'running') run();
  else engine.resume().then((ok) => { if (ok) run(); else showOverlay(); });
}

function copyRoutingToAll(pad) {
  confirmDialog(`Routing von „${pad.name}“ auf alle anderen Pads übertragen? Vorhandene Routings werden überschrieben (Dateikanäle, die ein Pad nicht hat, werden ignoriert).`, 'Kopieren').then((ok) => {
    if (!ok) return;
    for (const p of engine.pads) if (p !== pad) p.setRouting((pad.routing || []).map((c) => [c[0], c[1]]));
    toast('Routing auf alle Pads kopiert.');
  });
}

// ------------------------------------------------------------------ Dateien laden
const baseName = (n) => n.replace(/\.[^.]+$/, '');
function decodeMessage(e) {
  const m = (e && e.message) || String(e);
  if ((e && e.name === 'EncodingError') || /decode|unsupported|format/i.test(m)) return 'Chrome kann diese Datei nicht dekodieren (Format nicht unterstützt oder Datei beschädigt).';
  if ((e && (e.name === 'RangeError' || e.name === 'QuotaExceededError')) || /memory|alloc/i.test(m)) return 'Nicht genug Arbeitsspeicher zum Dekodieren dieser Datei.';
  return m;
}

async function loadFileIntoPad(pad, file) {
  pad.setLoading();
  try {
    const ab = await file.arrayBuffer();
    const newId = uid();
    // Der Blob kopiert die Bytes sofort; decodeAudioData darf danach den ArrayBuffer übernehmen.
    const put = putAudio({ id: newId, name: file.name, type: file.type, data: new Blob([ab], { type: file.type }) })
      .then(() => true, (e) => { logError('IndexedDB', e); return false; });
    let buf;
    try { buf = await engine.decode(ab); } catch (e) { await put; deleteAudio(newId).catch(() => {}); throw e; }
    const stored = await put;
    const oldId = pad.audioId;
    pad.setBuffer(buf, true, { audioId: stored ? newId : null, fileName: file.name, mime: file.type, unsaved: !stored });
    if (!stored) toast(`„${file.name}“ konnte nicht dauerhaft gespeichert werden (Speicher voll?). Läuft nur bis zum Schließen.`, 'error', 9000);
    if (oldId && oldId !== pad.audioId && !engine.pads.some((p) => p.audioId === oldId)) deleteAudio(oldId).catch(() => {});
  } catch (e) {
    pad.markError(decodeMessage(e));
    logError(`Datei ${file.name}`, e);
  }
  updateMemory();
  changed();
}

async function addFiles(files, target = null) {
  if (settings.showMode) { toast('Show-Modus: Hinzufügen gesperrt.', 'warn'); return; }
  const list = [...files].filter((f) => { if (f.size > 0) return true; toast(`„${f.name}“ ist leer.`, 'warn'); return false; });
  const jobs = [];
  list.forEach((f, i) => {
    let pad;
    if (i === 0 && target && ['empty', 'missing', 'error'].includes(target.state)) {
      pad = target;
      if (/^(Leeres Pad|Neues Pad)/.test(pad.name)) pad.setName(baseName(f.name));
    } else pad = makePad({ name: baseName(f.name) });
    pad.setLoading();
    jobs.push([pad, f]);
  });
  for (const [pad, f] of jobs) await loadFileIntoPad(pad, f);
}

function pickViaInput(accept, multiple = false) {
  return new Promise((res) => {
    const inp = h('input', { type: 'file', accept, multiple });
    inp.addEventListener('change', () => res([...inp.files]));
    inp.addEventListener('cancel', () => res([]));
    inp.click();
  });
}

async function pickFile(pad) {
  if (settings.showMode) return;
  const [f] = await pickViaInput('audio/*,.wav,.mp3,.flac,.ogg,.oga,.opus,.m4a,.aac,.aif,.aiff');
  if (!f) return;
  if (f.size === 0) { toast(`„${f.name}“ ist leer.`, 'warn'); return; }
  if (/^(Leeres Pad|Neues Pad)/.test(pad.name)) pad.setName(baseName(f.name));
  await loadFileIntoPad(pad, f);
}

async function loadStored(pad) {
  try {
    const rec = await getAudio(pad.audioId);
    if (!rec || !rec.data) { pad.markMissing(); return; }
    const ab = await (rec.data instanceof Blob ? rec.data.arrayBuffer() : Promise.resolve(rec.data));
    const buf = await engine.decode(ab);
    pad.setBuffer(buf, false);
  } catch (e) {
    pad.markError(decodeMessage(e));
    logError(`Pad „${pad.name}“ laden`, e);
  }
  updateMemory();
}

async function loadAllStored() {
  const todo = engine.pads.filter((p) => p.audioId && p.state === 'loading');
  let i = 0;
  for (const p of todo) {
    $('#chip-mem').textContent = `Lade ${++i}/${todo.length} …`;
    await loadStored(p);
  }
  updateMemory();
}

// ------------------------------------------------------------------ MIDI
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function describeMapping(m, short = false) {
  const n = m.type === 'note' ? `${short ? 'N' : 'Note '}${NOTES[m.number % 12]}${Math.floor(m.number / 12) - 1} (${m.number})` : `CC ${m.number}`;
  return `${n} · ${short ? 'Ch' : 'Kanal '}${m.channel}`;
}

function findDuplicates(pad, fn) {
  const m = pad.midi[fn];
  if (!m) return [];
  const out = [];
  for (const p of engine.pads) {
    for (const f of ['play', 'reset', 'volume']) {
      const o = p.midi[f];
      if ((p !== pad || f !== fn) && o && o.type === m.type && o.channel === m.channel && o.number === m.number) out.push(`${p.name} (${FN_LABEL[f]})`);
    }
  }
  return out;
}

function startLearn(pad, fn) {
  if (settings.showMode) return;
  if (!midi.access) { toast('MIDI ist nicht verfügbar (' + midi.status + ').', 'warn'); return; }
  if (midi.learn && midi.learn.padId === pad.id && midi.learn.fn === fn) { midi.cancelLearn(); return; }
  midi.startLearn(pad.id, fn);
}

function clearMapping(pad, fn) { if (!settings.showMode) pad.setMidi(fn, null); }

const ccState = new Map();
midi.handler = (m) => {
  for (const p of engine.pads) {
    for (const fn of ['play', 'reset', 'volume']) {
      const map = p.midi[fn];
      if (!map || map.type !== m.type || map.channel !== m.ch || map.number !== m.num) continue;
      if (fn === 'volume') { if (m.type === 'cc') p.setVolume((m.val / 127) * 100); continue; }
      let on, off = false;
      if (m.type === 'note') { on = m.on; off = !m.on; } else { // CC als Taster: Flanke bei 64
        const k = p.id + fn, was = ccState.get(k) || 0, now = m.val >= 64 ? 1 : 0;
        ccState.set(k, now);
        on = now === 1 && was === 0; off = now === 0 && was === 1;
      }
      if (fn === 'play') {
        if (p.gate) { if (on) p.gateOn(); else if (off) p.gateOff(); }
        else if (on) p.toggle();
      } else if (fn === 'reset' && on) p.reset();
    }
  }
};

midi.on('learn', (l) => {
  if (!l) { clearBanner('learn'); return; }
  const pad = engine.pads.find((p) => p.id === l.padId);
  banner('learn', `MIDI Learn: „${pad ? pad.name : '?'}“ · ${FN_LABEL[l.fn]} – jetzt Taste bzw. Regler am Controller betätigen (Esc = Abbruch)`, {
    kind: 'info', dismissable: false, actions: [{ label: 'Abbrechen', fn: () => midi.cancelLearn() }],
  });
});
midi.on('learn-done', (l, mapping) => {
  const pad = engine.pads.find((p) => p.id === l.padId);
  if (!pad) return;
  pad.setMidi(l.fn, mapping);
  const d = findDuplicates(pad, l.fn);
  toast(`${FN_LABEL[l.fn]}: ${describeMapping(mapping)} zugewiesen.` + (d.length ? ` ⚠ Bereits belegt mit: ${d.join(', ')}` : ''), d.length ? 'warn' : 'info', d.length ? 9000 : 4000);
});
midi.on('learn-warn', () => toast('Für die Lautstärke bitte einen Regler (CC) bewegen, keine Taste.', 'warn'));
midi.on('devices', updateMidiChip);

// ------------------------------------------------------------------ Audio-Verwaltung
async function changeSink(id, label) {
  if (settings.showMode) return;
  if (engine.pads.some((p) => p.state === 'playing') &&
      !(await confirmDialog('Es laufen Sounds. Beim Gerätewechsel werden sie angehalten (Position bleibt erhalten). Fortfahren?', 'Wechseln'))) return;
  settings.sinkId = id;
  settings.sinkLabel = label || '';
  saveSettings();
  await engine.setSink(id, settings.sinkLabel);
}

async function reconnectAudio() {
  if (engine.pads.some((p) => p.state === 'playing') &&
      !(await confirmDialog('Es laufen Sounds. Beim Neuverbinden werden sie angehalten (Position bleibt erhalten). Fortfahren?', 'Neu verbinden'))) return;
  await engine.rebuild('manuell');
}

async function unlockDeviceLabels() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    await engine.listOutputs();
    engine.emit('devices', engine.devices);
  } catch (e) { toast('Berechtigung nicht erteilt: ' + e.message, 'warn'); }
}

async function acquireWakeLock() {
  try {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    wakeLock = await navigator.wakeLock.request('screen');
    app.wakeLockActive = true;
    wakeLock.addEventListener('release', () => { app.wakeLockActive = false; });
  } catch (e) { app.wakeLockActive = false; logError('Wake Lock', e); }
}

// ------------------------------------------------------------------ Projekt: neu / speichern / laden
async function gcAudio(keep) {
  try { for (const k of await listAudioKeys()) if (!keep.has(k)) await deleteAudio(k); } catch (e) { logError('Audio-Aufräumen', e); }
}

async function newProject() {
  if (settings.showMode) return;
  if (!(await confirmDialog('Neues leeres Projekt anlegen? Alle Pads, Routings, Mappings und gespeicherten Audiodateien in diesem Browser werden gelöscht. (Vorher ggf. „Speichern …“.)', 'Alles löschen', true))) return;
  engine.panic();
  for (const p of [...engine.pads]) removePadQuiet(p);
  try { await clearAudio(); } catch (e) { logError('clearAudio', e); }
  changed();
  autosave.flush();
  updateMemory();
  updateHint();
}

async function replaceProject(project) {
  engine.panic();
  for (const p of [...engine.pads]) removePadQuiet(p);
  project.pads.forEach((d) => makePad(d));
  updateHint();
  await gcAudio(new Set(project.pads.map((p) => p.audioId).filter(Boolean)));
  changed();
  autosave.flush();
  await loadAllStored();
}

async function importProject() {
  if (settings.showMode) return;
  let file;
  try {
    if (window.showOpenFilePicker) {
      const [fh] = await window.showOpenFilePicker({
        types: [{ description: 'Soundboard-Projekt', accept: { 'application/octet-stream': ['.sbproj'], 'application/json': ['.json'] } }],
      });
      file = await fh.getFile();
    } else [file] = await pickViaInput('.sbproj,.json');
  } catch (e) { if (e.name !== 'AbortError') { toast('Datei konnte nicht geöffnet werden: ' + e.message, 'error'); } return; }
  if (!file) return;
  let parsed;
  try { parsed = await parseProjectFile(file); } catch (e) {
    logError('Import', e);
    toast('Import fehlgeschlagen: ' + e.message, 'error', 9000);
    return;
  }
  const { project, audio } = parsed;
  const ok = await confirmDialog(`Projekt „${file.name}“ mit ${project.pads.length} Pads (${audio.length} Audiodateien) laden? Das aktuelle Projekt wird ersetzt.`, 'Laden');
  if (!ok) return;
  try { for (const a of audio) await putAudio({ id: a.id, name: a.name, type: a.type, data: a.blob }); } catch (e) {
    logError('Import Audio', e);
    toast('Audiodaten konnten nicht gespeichert werden (Speicher voll?): ' + e.message + ' – aktuelles Projekt bleibt unverändert.', 'error', 10000);
    return;
  }
  await replaceProject(project);
  toast('Projekt geladen.');
}

async function exportProject() {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1-');
  const name = `soundboard-${stamp}.sbproj`;
  let handle = null;
  try {
    if (window.showSaveFilePicker) { // zuerst, solange die Benutzeraktion noch gültig ist
      handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Soundboard-Projekt', accept: { 'application/octet-stream': ['.sbproj'] } }] });
    }
    const { blob, missing } = await exportProjectBlob(engine, settings.exportAudio);
    if (handle) {
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
    } else {
      const a = h('a', { href: URL.createObjectURL(blob), download: name });
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 10000);
    }
    toast(`Projekt gespeichert (${fmtBytes(blob.size)}).` + (missing.length ? ` Audio fehlt für: ${missing.join(', ')}` : ''), missing.length ? 'warn' : 'info', missing.length ? 9000 : 4000);
  } catch (e) {
    if (e.name === 'AbortError') return;
    logError('Export', e);
    toast('Speichern fehlgeschlagen: ' + e.message, 'error', 9000);
  }
}

// ------------------------------------------------------------------ Show-Modus
async function setShowMode(on) {
  if (!on && !(await confirmDialog('Show-Modus beenden? Bearbeiten, Löschen, Routing und Mapping werden wieder freigegeben.', 'Beenden'))) return;
  settings.showMode = on;
  saveSettings();
  if (on) {
    midi.cancelLearn();
    for (const id of ['dlg-routing']) { const d = $('#' + id); if (d.open) d.close(); }
  }
  updateShowUi();
}

// ------------------------------------------------------------------ Start
function wireUi() {
  $('#panic').addEventListener('click', () => { engine.panic(); });
  $('#btn-add').addEventListener('click', async () => { addFiles(await pickViaInput('audio/*,.wav,.mp3,.flac,.ogg,.oga,.opus,.m4a,.aac,.aif,.aiff', true)); });
  $('#btn-empty').addEventListener('click', () => { if (!settings.showMode) { makePad({ name: 'Leeres Pad' }); changed(); } });
  $('#btn-new').addEventListener('click', newProject);
  $('#btn-load').addEventListener('click', importProject);
  $('#btn-save').addEventListener('click', exportProject);
  $('#btn-show').addEventListener('click', () => setShowMode(!settings.showMode));
  $('#btn-settings').addEventListener('click', () => openSettings(app));
  $('#chip-err').addEventListener('click', () => openSettings(app));
  $('#overlay-btn').addEventListener('click', activateAudio);

  // Chrome darf nie zur Datei navigieren, wenn sie danebenfällt
  window.addEventListener('dragover', (e) => { e.preventDefault(); if (hasFiles(e) && !app.dragId) document.body.classList.add('dropping'); });
  window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dropping');
    if (app.dragId || !e.dataTransfer || !e.dataTransfer.files.length) return;
    addFiles([...e.dataTransfer.files]);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && midi.learn) { e.preventDefault(); midi.cancelLearn(); return; } // Esc bricht nur Learn ab, der offene Dialog bleibt
    if (!settings.shortcuts || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape') { engine.panic(); e.preventDefault(); return; }
    const m = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
    if (!m) return;
    const pad = engine.pads[m[1] === '0' ? 9 : +m[1] - 1];
    if (!pad) return;
    e.preventDefault();
    padAction(pad, e.shiftKey ? 'reset' : 'toggle');
  });

  // jede Benutzeraktion darf einen suspendierten AudioContext fortsetzen
  const unlock = () => { if (engine.ctx && engine.ctx.state !== 'running') engine.resume().then((ok) => { if (ok) hideOverlay(); }); };
  document.addEventListener('pointerdown', unlock, true);
  document.addEventListener('keydown', unlock, true);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenSince = Date.now(); autosave.flush(); return; }
    if (!app.wakeLockActive) acquireWakeLock();
    if (hiddenSince && Date.now() - hiddenSince > 2000) {
      const s = Math.round((Date.now() - hiddenSince) / 1000);
      banner('background', `Dieser Tab war ${s} s im Hintergrund. Chrome drosselt dort Timer und Anzeigen – bitte Wiedergabe und Audio-Status prüfen.`, { kind: 'warn' });
      logMsg('warn', 'Tab', `Hintergrund für ${s} s`);
    }
    hiddenSince = 0;
  });

  window.addEventListener('pagehide', () => autosave.flush());
  window.addEventListener('beforeunload', (e) => {
    if (engine.pads.some((p) => p.state === 'playing') || dirty || autosave.pending()) { e.preventDefault(); e.returnValue = ''; }
  });

  window.addEventListener('error', (e) => logError('window.onerror', e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => logError('unhandledrejection', e.reason));
  log.subs.add(updateErrChip);
}

async function activateAudio() {
  const ok = await engine.resume();
  if (ok) {
    hideOverlay();
    acquireWakeLock();
    requestPersist().then((p) => { app.persisted = p; });
  } else toast('Chrome hat Audio noch nicht freigegeben – bitte noch einmal klicken.', 'warn');
}

function frameLoop() {
  let last = performance.now();
  const loop = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    for (const v of views.values()) {
      try { v.tick(now, dt); } catch (e) { logError('tick', e); }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

async function main() {
  wireUi();
  updateShowUi();

  engine.on('message', (kind, text) => {
    toast(text, kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : 'info', 8000);
    logMsg(kind === 'error' ? 'error' : 'info', 'Audio', text);
  });
  engine.on('state', (s) => {
    updateAudioChip();
    if (s === 'running') { hideOverlay(); clearBanner('audio-state'); }
    else setTimeout(() => { if (engine.ctx && engine.ctx.state !== 'running') showOverlay(); }, 600);
  });
  engine.on('blocked', () => showOverlay());
  engine.on('rebuilt', () => {
    updateAudioChip();
    updateInterruptedBanner();
    if (engine.ctx.state !== 'running') showOverlay();
  });
  engine.on('outputs', updateAudioChip);
  engine.on('devices', updateAudioChip);
  engine.on('device-back', () => banner('device-back', 'Das gewählte Ausgabegerät ist wieder verfügbar. Zum Zurückwechseln werden laufende Sounds kurz angehalten.', {
    kind: 'info', actions: [{ label: 'Jetzt wechseln', fn: async () => { clearBanner('device-back'); await engine.rebuild('device-back'); } }],
  }));

  // Gespeicherten Stand laden
  let proj = null;
  try {
    const raw = await loadProject();
    if (raw) proj = sanitizeProject(raw);
  } catch (e) {
    logError('Projekt laden', e);
    banner('load-error', 'Der gespeicherte Stand war beschädigt und wurde nicht geladen: ' + e.message, { kind: 'error' });
  }

  try {
    await engine.start({ sinkId: settings.sinkId, sinkLabel: settings.sinkLabel, latency: settings.latency });
  } catch (e) {
    logError('Audio-Start', e);
    banner('audio-fatal', 'Audio konnte nicht gestartet werden: ' + e.message, { kind: 'error', dismissable: false });
  }
  if (proj) proj.pads.forEach((d) => makePad(d));
  updateHint();
  updateAudioChip();
  updateMidiChip();
  updateErrChip();
  frameLoop();

  if (engine.ctx && engine.ctx.state !== 'running') showOverlay('Chrome verlangt einen Klick, bevor Ton ausgegeben werden darf. Danach ist die Show bereit.');

  requestPersist().then((p) => { app.persisted = p; if (p === false) toast('Persistenter Speicher wurde nicht gewährt – Chrome dürfte Daten bei Platzmangel löschen. Projekt zusätzlich als Datei sichern!', 'warn', 9000); });
  storageEstimate().then((s) => { app.storageInfo = s; });
  acquireWakeLock();
  midi.setSelected(settings.midiInput);
  midi.init();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => logError('Service Worker', e));

  await loadAllStored();
}

main().catch((e) => { logError('Start', e); banner('fatal', 'Startfehler: ' + e.message, { kind: 'error', dismissable: false }); });
