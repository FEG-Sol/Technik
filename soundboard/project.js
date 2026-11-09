// Projektmodell, Validierung und Dateicontainer (.sbproj).
// Container: "SBP1" | uint32 LE Headerlänge | JSON-Header | rohe Audio-Blobs (Reihenfolge/Größen laut Header)
import { getAudio } from './store.js';
import { uid } from './util.js';

export const FORMAT = 'soundboard-project';
export const VERSION = 1;
const MAGIC = 'SBP1';
const MAX_HEADER = 64 * 1024 * 1024;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, d = '', max = 200) => (typeof v === 'string' ? v.slice(0, max) : d);
const int = (v, lo, hi) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};

export function sanitizeMapping(m) {
  if (!isObj(m)) return null;
  const type = m.type === 'cc' ? 'cc' : m.type === 'note' ? 'note' : null;
  const channel = int(m.channel, 1, 16), number = int(m.number, 0, 127);
  if (!type || channel === null || number === null) return null;
  return { type, channel, number };
}

export function sanitizePad(p) {
  if (!isObj(p)) return null;
  let routing = null;
  if (Array.isArray(p.routing)) {
    routing = [];
    const seen = new Set();
    for (const cell of p.routing.slice(0, 4096)) {
      if (!Array.isArray(cell)) continue;
      const c = int(cell[0], 0, 31), o = int(cell[1], 0, 31);
      if (c === null || o === null || seen.has(c * 64 + o)) continue;
      seen.add(c * 64 + o);
      routing.push([c, o]);
    }
  }
  const vol = Number(p.volume);
  const mi = isObj(p.midi) ? p.midi : {};
  return {
    id: str(p.id, '', 64) || uid(),
    name: str(p.name, 'Pad', 120) || 'Pad',
    audioId: str(p.audioId, '', 64) || null,
    fileName: str(p.fileName, '', 260),
    mime: str(p.mime, '', 100),
    loop: p.loop === true,
    gate: p.gate === true,
    volume: Number.isFinite(vol) ? Math.min(100, Math.max(0, Math.round(vol))) : 100,
    routing,
    midi: { play: sanitizeMapping(mi.play), reset: sanitizeMapping(mi.reset), volume: sanitizeMapping(mi.volume) },
  };
}

export function sanitizeProject(raw) {
  if (!isObj(raw)) throw new Error('Kein gültiges Projekt.');
  if (raw.format !== undefined && raw.format !== FORMAT) throw new Error('Unbekanntes Projektformat.');
  const v = raw.version;
  if (!Number.isInteger(v) || v < 1) throw new Error('Projektversion fehlt oder ist ungültig.');
  if (v > VERSION) throw new Error(`Projektversion ${v} ist neuer als diese App (${VERSION}). Bitte App aktualisieren.`);
  if (!Array.isArray(raw.pads)) throw new Error('Projekt enthält keine Pad-Liste.');
  if (raw.pads.length > 500) throw new Error('Zu viele Pads (max. 500).');
  const ids = new Set();
  const pads = [];
  for (const p of raw.pads) {
    const sp = sanitizePad(p);
    if (!sp) continue;
    while (ids.has(sp.id)) sp.id = uid();
    ids.add(sp.id);
    pads.push(sp);
  }
  const mv = Number(isObj(raw.settings) ? raw.settings.masterVolume : 100);
  return {
    format: FORMAT,
    version: VERSION,
    savedAt: str(raw.savedAt, '', 40),
    settings: { masterVolume: Number.isFinite(mv) ? Math.min(100, Math.max(0, Math.round(mv))) : 100 },
    pads,
  };
}

export function serializeProject(engine) {
  return {
    format: FORMAT,
    version: VERSION,
    savedAt: new Date().toISOString(),
    settings: { masterVolume: engine.cfg.masterVolume ?? 100 },
    pads: engine.pads.map((p) => p.toJSON()),
  };
}

// records: [{id, name, type, data: Blob}]
export function buildProjectBlob(project, records) {
  const enc = new TextEncoder();
  const header = enc.encode(JSON.stringify({
    format: FORMAT,
    version: VERSION,
    savedAt: project.savedAt,
    project,
    audio: records.map((r) => ({ id: r.id, name: r.name, type: r.type, size: r.data.size })),
  }));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, header.length, true);
  return new Blob([enc.encode(MAGIC), len, header, ...records.map((r) => r.data)], { type: 'application/octet-stream' });
}

export async function exportProjectBlob(engine, includeAudio) {
  const project = serializeProject(engine);
  const records = [];
  const missing = [];
  if (includeAudio) {
    const seen = new Set();
    for (const p of project.pads) {
      if (!p.audioId || seen.has(p.audioId)) continue;
      seen.add(p.audioId);
      const r = await getAudio(p.audioId);
      if (r && r.data) records.push({ ...r, data: r.data instanceof Blob ? r.data : new Blob([r.data]) });
      else missing.push(p.name);
    }
  }
  return { blob: buildProjectBlob(project, records), missing };
}

// Liest und validiert eine Projektdatei, ohne irgendetwas zu verändern.
export async function parseProjectFile(file) {
  if (!file || file.size < 2) throw new Error('Datei ist leer.');
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const audio = [];
  let project;
  if (head.length >= 8 && String.fromCharCode(head[0], head[1], head[2], head[3]) === MAGIC) {
    const len = new DataView(head.buffer).getUint32(4, true);
    if (len < 2 || len > MAX_HEADER || 8 + len > file.size) throw new Error('Dateikopf ist beschädigt.');
    let raw;
    try { raw = JSON.parse(await file.slice(8, 8 + len).text()); } catch { throw new Error('Dateikopf enthält kein gültiges JSON.'); }
    if (!isObj(raw)) throw new Error('Dateikopf ist ungültig.');
    project = sanitizeProject(raw.project);
    let off = 8 + len;
    for (const a of Array.isArray(raw.audio) ? raw.audio : []) {
      if (!isObj(a)) continue;
      const id = str(a.id, '', 64), size = Number(a.size);
      if (!id || !Number.isInteger(size) || size < 0) throw new Error('Audio-Verzeichnis ist beschädigt.');
      if (off + size > file.size) throw new Error('Datei ist abgeschnitten (Audiodaten unvollständig).');
      const type = str(a.type, '', 100);
      audio.push({ id, name: str(a.name, '', 260), type, blob: file.slice(off, off + size, type) });
      off += size;
    }
  } else if (head[0] === 0x7b) { // '{' -> reines JSON ohne Audio
    if (file.size > MAX_HEADER) throw new Error('JSON-Datei ist zu groß.');
    let raw;
    try { raw = JSON.parse(await file.text()); } catch { throw new Error('JSON ist beschädigt.'); }
    project = sanitizeProject(isObj(raw) && isObj(raw.project) ? raw.project : raw);
  } else {
    throw new Error('Unbekanntes Dateiformat (kein Soundboard-Projekt).');
  }
  return { project, audio };
}
