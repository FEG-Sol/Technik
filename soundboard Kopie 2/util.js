// Gemeinsame Helfer: DOM, Events, Log, Formatierung.

export const $ = (sel, root = document) => root.querySelector(sel);

export function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k in e) e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of kids.flat()) {
    if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const t = Math.floor(s * 10);
  const m = Math.floor(t / 600);
  const sec = Math.floor((t % 600) / 10);
  return `${m}:${sec < 10 ? '0' : ''}${sec}.${t % 10}`;
}

export function fmtBytes(b) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (i === 0 ? b.toFixed(0) : b.toFixed(b < 10 ? 2 : 1)) + ' ' + u[i];
}

export function debounce(fn, ms) {
  let t = null;
  const f = () => {
    clearTimeout(t);
    t = setTimeout(() => { t = null; fn(); }, ms);
  };
  f.flush = () => { if (t !== null) { clearTimeout(t); t = null; fn(); } };
  f.pending = () => t !== null;
  return f;
}

export const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((r) => setTimeout(r, ms, undefined))]);

// ---- Fehlerlog (sichtbar im Einstellungsdialog, unterbricht nie die Wiedergabe) ----
export const log = { entries: [], subs: new Set(), errors: 0 };

export function logMsg(level, where, msg) {
  const e = { t: Date.now(), level, where, msg: String(msg) };
  log.entries.push(e);
  if (log.entries.length > 300) log.entries.shift();
  if (level === 'error') log.errors++;
  for (const f of log.subs) { try { f(e); } catch { /* ignorieren */ } }
}

export function logError(where, err) {
  const m = err && err.message ? err.message : String(err);
  logMsg('error', where, m);
  try { console.error(where, err); } catch { /* ignorieren */ }
}

export class Emitter {
  constructor() { this._h = new Map(); }
  on(ev, fn) {
    let s = this._h.get(ev);
    if (!s) this._h.set(ev, (s = new Set()));
    s.add(fn);
    return () => s.delete(fn);
  }
  emit(ev, ...a) {
    const s = this._h.get(ev);
    if (!s) return;
    for (const f of s) {
      try { f(...a); } catch (e) { logError('event ' + ev, e); }
    }
  }
  clear() { this._h.clear(); }
}
