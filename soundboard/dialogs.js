// Einstellungsdialog pro Pad und globaler Einstellungsdialog.
import { h, $, fmtBytes, log } from './util.js';
import { toast } from './ui.js';

// replaceChildren(null) würde den Text "null" einfügen – leere Einträge deshalb herausfiltern.
const setBody = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));

const FN = [['play', 'Play / Pause'], ['reset', 'Reset'], ['volume', 'Lautstärke (CC-Regler)']];

// Einstellungsdialog eines Pads: Lautstärke, Single-Shot/Loop, Routing-Matrix, MIDI Learn.
// Im Show-Modus ist er komplett gesperrt (Zahnrad ausgeblendet, Öffnen wird verweigert, Steuerelemente deaktiviert).
export function openRouting(app, pad) {
  const { engine, midi } = app;
  const dlg = $('#dlg-routing');
  if (dlg.open || app.settings.showMode) return;
  const locked = () => app.settings.showMode;
  const title = h('span');
  const head = h('div', { class: 'dlg-head' }, title, h('button', { text: '✕', onclick: () => dlg.close() }));
  const body = h('div', { class: 'dlg-body' });
  const foot = h('div', { class: 'dlg-foot' }, h('button', { class: 'primary', text: 'Schließen', onclick: () => dlg.close() }));

  // Lautstärke-Elemente werden nur einmal erzeugt: ein Neuaufbau des Dialogs würde das Ziehen am Regler abbrechen.
  const volRange = h('input', { type: 'range', min: 0, max: 100, step: 1, title: 'Doppelklick = 100 %', 'aria-label': 'Lautstärke in Prozent' });
  const volNum = h('input', { type: 'number', min: 0, max: 100, step: 1, title: 'Doppelklick = 100 %', 'aria-label': 'Lautstärke in Prozent' });
  const volRow = h('div', { class: 'vol-row' }, volRange, volNum, h('span', { text: '%' }));
  let fromVol = false;
  const setVol = (v) => {
    fromVol = true;
    try { pad.setVolume(v); } finally { fromVol = false; }
    volRange.value = pad.volume;
    volNum.value = pad.volume;
  };
  volRange.addEventListener('input', () => setVol(+volRange.value));
  volRange.addEventListener('dblclick', () => setVol(100));
  volNum.addEventListener('change', () => setVol(+volNum.value || 0));
  volNum.addEventListener('dblclick', () => setVol(100));

  const render = () => {
    const lock = locked();
    title.textContent = `Einstellungen: ${pad.name}`;
    volRange.value = pad.volume;
    if (document.activeElement !== volNum) volNum.value = pad.volume;
    volRange.disabled = lock;
    volNum.disabled = lock;

    const routing = pad.routing || [];
    const nch = pad.channels;
    const maxRef = routing.reduce((m, c) => Math.max(m, c[1] + 1), 0);
    const nout = Math.min(32, Math.max(engine.outputCount, maxRef, 1));
    const has = (c, o) => routing.some((x) => x[0] === c && x[1] === o);

    let matrix;
    if (!nch) {
      matrix = h('div', { class: 'warn-box', text: 'Dieses Pad hat noch keine Audiodatei – das Routing erscheint, sobald eine Datei geladen ist.' });
    } else {
      const rows = [];
      for (let o = 0; o < nout; o++) {
        const na = o >= engine.outputCount;
        rows.push(h('tr', {},
          h('th', { class: na ? 'na' : '', text: `Ausgang ${o + 1}${na ? ' (nicht vorhanden)' : ''}` }),
          ...Array.from({ length: nch }, (_, c) => h('td', {},
            h('button', {
              class: 'cell' + (has(c, o) ? ' on' : '') + (na ? ' na' : ''),
              disabled: na || lock,
              'aria-pressed': String(has(c, o)),
              title: `Dateikanal ${c + 1} → Ausgang ${o + 1}`,
              text: has(c, o) ? '●' : '',
              onclick: () => pad.toggleCell(c, o),
            })))));
      }
      matrix = h('div', { class: 'matrix-wrap' }, h('table', { class: 'matrix' },
        h('thead', {}, h('tr', {}, h('th', { text: 'Ausgang ↓ / Dateikanal →' }),
          ...Array.from({ length: nch }, (_, c) => h('th', { text: `K${c + 1}` })))),
        h('tbody', {}, ...rows)));
    }

    const all = (arr) => () => pad.setRouting(arr);
    const oneToOne = [];
    for (let c = 0; c < Math.min(nch, engine.outputCount); c++) oneToOne.push([c, c]);
    const monoAll = [];
    for (let o = 0; o < engine.outputCount; o++) monoAll.push([0, o]);

    const midiRows = FN.map(([fn, label]) => {
      const m = pad.midi[fn];
      const dups = app.findDuplicates(pad, fn);
      const learning = midi.learn && midi.learn.padId === pad.id && midi.learn.fn === fn;
      return h('div', { class: 'midi-row' },
        h('b', { text: label }),
        h('span', { class: 'map', text: m ? app.describeMapping(m) : '— nicht zugewiesen —' }),
        h('button', { class: learning ? 'primary' : '', text: learning ? 'Warte … (Esc)' : 'Learn', disabled: lock, onclick: () => app.startLearn(pad, fn) }),
        h('button', { text: '✕', title: 'Zuweisung löschen', disabled: !m || lock, onclick: () => app.clearMapping(pad, fn) }),
        dups.length ? h('div', { class: 'dup', text: '⚠ Doppelt belegt mit: ' + dups.join(', ') }) : null);
    });

    const seg = h('div', { class: 'seg' },
      h('button', { class: pad.loop ? '' : 'on', text: '→ Single-Shot (einmal)', disabled: lock, 'aria-pressed': String(!pad.loop), onclick: () => pad.setLoop(false) }),
      h('button', { class: pad.loop ? 'on' : '', text: '⟳ Repeat (Loop)', disabled: lock, 'aria-pressed': String(pad.loop), onclick: () => pad.setLoop(true) }));

    setBody(body,
      lock ? h('div', { class: 'warn-box', text: 'Show-Modus aktiv: Alle Einstellungen (auch die Lautstärke) sind gesperrt.' }) : null,
      h('h3', { text: 'Wiedergabe' }),
      h('div', { class: 'kv' },
        h('span', { text: 'Lautstärke' }), volRow,
        h('span', { text: 'Ablauf' }), seg),
      h('h3', { text: 'Routing-Matrix' }),
      h('div', { class: 'kv' },
        h('span', { text: 'Datei' }), h('b', { text: nch ? `${nch} ${nch === 1 ? 'Kanal' : 'Kanäle'}` : '—' }),
        h('span', { text: 'Gerät' }), h('b', { text: `${engine.outputCount} Ausgänge` + (engine.outputCount <= 2 ? ' (Stereo!)' : '') })),
      matrix,
      h('div', { class: 'btns' },
        h('button', { text: 'Alle löschen', disabled: lock, onclick: all([]) }),
        h('button', { text: '1:1', onclick: all(oneToOne), disabled: !nch || lock }),
        h('button', { text: 'Mono auf alle Ausgänge (Kanal 1)', onclick: all(monoAll), disabled: !nch || lock }),
        h('button', { text: 'Matrix auf alle Pads kopieren', disabled: lock, onclick: () => app.copyRoutingToAll(pad) }),
        h('button', { text: 'Datei ersetzen …', disabled: lock, onclick: () => app.pickFile(pad) })),
      h('h3', { text: 'MIDI' }),
      ...midiRows,
      h('label', { class: 'chk' },
        h('input', { type: 'checkbox', checked: pad.gate, disabled: lock, onchange: (e) => pad.setGate(e.target.checked) }),
        h('span', { text: 'Gate-Modus: Sound läuft nur, solange die Taste (Note) gehalten wird' })));
  };

  const onData = () => { if (!fromVol) render(); }; // beim Ziehen am Regler nicht neu aufbauen
  const offs = [pad.on('data', onData), pad.on('state', render), midi.on('learn', render), engine.on('rebuilt', render)];
  dlg.addEventListener('close', () => offs.forEach((f) => f()), { once: true });
  dlg.replaceChildren(head, body, foot);
  render();
  dlg.showModal();
}

export function openSettings(app) {
  const { engine, midi, settings } = app;
  const dlg = $('#dlg-settings');
  if (dlg.open) return;
  const locked = () => settings.showMode;
  const head = h('div', { class: 'dlg-head' }, h('span', { text: 'Einstellungen' }),
    h('button', { text: '✕', onclick: () => dlg.close() }));
  const body = h('div', { class: 'dlg-body' });
  const foot = h('div', { class: 'dlg-foot' }, h('button', { class: 'primary', text: 'Schließen', onclick: () => dlg.close() }));
  const mon = { lines: [], pre: h('pre', { class: 'mono', text: '(MIDI-Nachrichten erscheinen hier)' }), raf: 0 };
  const testStatus = h('div', { class: 'map', text: '' });
  const logPre = h('pre', { class: 'mono' });
  let sweepRaf = 0;

  const fillLog = () => {
    logPre.textContent = log.entries.slice(-80).map((e) => `${new Date(e.t).toLocaleTimeString()} [${e.level}] ${e.where}: ${e.msg}`).join('\n') || '(leer)';
  };

  const render = () => {
    const ctx = engine.ctx;
    const dev = engine.devices;
    const devLabel = (d, i) => d.label || `Ausgabegerät ${i + 1} (${d.deviceId.slice(0, 8)}…)`;
    const sinkSel = h('select', { disabled: locked(), onchange: (e) => {
      const o = e.target.selectedOptions[0];
      app.changeSink(e.target.value, o ? o.dataset.label || '' : '');
    } },
    h('option', { value: '', text: 'Standardgerät (System)' }),
    ...dev.map((d, i) => h('option', { value: d.deviceId, selected: d.deviceId === settings.sinkId, dataset: { label: d.label }, text: devLabel(d, i) })));

    const tests = h('div', { class: 'btns tests' },
      ...Array.from({ length: engine.outputCount }, (_, o) => h('button', {
        text: `Ausgang ${o + 1}`, disabled: locked(),
        onclick: async () => {
          if (!(await engine.resume())) { toast('Audio ist gesperrt – bitte zuerst „Audio aktivieren“ klicken.', 'warn'); return; }
          engine.testTone(o);
          testStatus.textContent = `Testton auf Ausgang ${o + 1} (440 Hz, −20 dBFS, 1 s)`;
        },
      })),
      h('button', {
        class: 'primary', text: 'Alle nacheinander', disabled: locked(),
        onclick: async () => {
          if (!(await engine.resume())) { toast('Audio ist gesperrt.', 'warn'); return; }
          const s = engine.testSweep();
          cancelAnimationFrame(sweepRaf);
          const loop = () => {
            const k = Math.floor((engine.ctx.currentTime - s.t0) / s.step);
            if (k >= s.n) { testStatus.textContent = 'Durchlauf beendet.'; return; }
            testStatus.textContent = k < 0 ? 'Start …' : `Ausgang ${k + 1} von ${s.n} …`;
            sweepRaf = requestAnimationFrame(loop);
          };
          loop();
        },
      }));

    const conn = midi.inputs.filter((i) => i.state === 'connected');
    const midiSel = h('select', { disabled: locked(), onchange: (e) => app.setMidiInput(e.target.value) },
      h('option', { value: 'all', text: 'Alle Eingänge', selected: settings.midiInput === 'all' }),
      ...conn.map((i) => h('option', { value: i.id, selected: i.id === settings.midiInput, text: i.name })));

    const rows = [];
    for (const p of engine.pads) {
      for (const [fn, label] of FN) {
        const m = p.midi[fn];
        if (!m) continue;
        const d = app.findDuplicates(p, fn);
        rows.push(h('tr', {},
          h('td', { text: p.name }), h('td', { text: label }), h('td', { text: app.describeMapping(m) }),
          h('td', { style: 'color:#ffb21e', text: d.length ? '⚠ doppelt: ' + d.join(', ') : '' }),
          h('td', {}, h('button', { text: '✕', disabled: locked(), onclick: () => app.clearMapping(p, fn) }))));
      }
    }

    const est = app.storageInfo;
    setBody(body,
      h('h3', { text: 'Audio-Ausgabe' }),
      h('div', { class: 'kv' },
        h('span', { text: 'Status' }), h('b', { text: ctx ? ctx.state : '—' }),
        h('span', { text: 'Ausgänge (genutzt)' }), h('b', { text: String(engine.outputCount) }),
        h('span', { text: 'maxChannelCount (Gerät)' }), h('b', { text: String(engine.maxChannels) }),
        h('span', { text: 'Samplerate' }), h('b', { text: ctx ? `${ctx.sampleRate} Hz` : '—' }),
        h('span', { text: 'Latenz (base / output)' }),
        h('b', { text: ctx ? `${(ctx.baseLatency * 1000).toFixed(1)} ms / ${ctx.outputLatency != null ? (ctx.outputLatency * 1000).toFixed(1) + ' ms' : 'n/a'}` : '—' })),
      engine.outputCount <= 2 ? h('div', { class: 'warn-box', text: 'Nur 2 Ausgänge (Stereo) verfügbar. Für Mehrkanal muss das Betriebssystem/der Treiber mehr Kanäle für dieses Gerät melden (z. B. Standardformat in den Windows-Soundeinstellungen). Mit dem Ausgangstest unten prüfen.' }) : null,
      h('div', { class: 'btns' }, sinkSel,
        h('button', { text: 'Gerätenamen freischalten', title: 'Chrome zeigt Namen erst nach Mikrofon-Berechtigung', disabled: locked(), onclick: () => app.unlockDeviceLabels() }),
        navigator.mediaDevices && navigator.mediaDevices.selectAudioOutput
          ? h('button', { text: 'Gerät per Chrome-Dialog wählen', disabled: locked(), onclick: async () => {
            try { const d = await navigator.mediaDevices.selectAudioOutput(); app.changeSink(d.deviceId, d.label); } catch (e) { if (e.name !== 'NotAllowedError') toast(e.message, 'warn'); }
          } }) : null,
        h('button', { text: 'Audio neu verbinden', onclick: () => app.reconnectAudio() })),
      h('label', { class: 'chk' }, h('span', { text: 'Latenz-Modus (Neuaufbau nötig):' }),
        h('select', { disabled: locked(), onchange: (e) => app.setLatency(e.target.value) },
          ...[['interactive', 'interactive (am schnellsten)'], ['balanced', 'balanced (Standard)'], ['playback', 'playback (am stabilsten)']]
            .map(([v, t]) => h('option', { value: v, text: t, selected: settings.latency === v })))),

      h('h3', { text: 'Ausgangstest' }),
      h('div', { class: 'map', text: 'Je ein Testton auf genau einem Ausgang – prüft, ob alle Kanäle in der richtigen Reihenfolge ankommen. Vorsicht bei angeschlossener Beschallung.' }),
      tests, testStatus,

      h('h3', { text: 'MIDI' }),
      h('div', { class: 'kv' }, h('span', { text: 'Status' }), h('b', { text: midi.status })),
      h('div', { class: 'btns' }, midiSel),
      h('div', { class: 'map', text: 'Live-Monitor (Notes und CC):' }), mon.pre,
      h('div', { class: 'map', text: 'Zuweisungen:' }),
      rows.length ? h('table', { class: 'list' }, h('thead', {}, h('tr', {}, ...['Pad', 'Funktion', 'Zuweisung', 'Hinweis', ''].map((t) => h('th', { text: t })))), h('tbody', {}, ...rows))
        : h('div', { class: 'map', text: 'Noch keine MIDI-Zuweisungen.' }),

      h('h3', { text: 'Allgemein' }),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: settings.shortcuts, onchange: (e) => app.setShortcuts(e.target.checked) }),
        h('span', { text: 'Tastaturkürzel aktivieren (1–9/0 = Pad 1–10 Play/Pause, Shift+Ziffer = Reset, Esc = Panic)' })),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: settings.exportAudio, onchange: (e) => app.setExportAudio(e.target.checked) }),
        h('span', { text: 'Audiodaten in die Projektdatei einschließen (größere Datei, dafür vollständig portabel)' })),
      h('div', { class: 'kv' },
        h('span', { text: 'Wake Lock (Bildschirm bleibt an)' }), h('b', { text: app.wakeLockActive ? 'aktiv' : 'nicht aktiv' }),
        h('span', { text: 'Persistenter Speicher' }), h('b', { text: app.persisted === true ? 'gewährt' : app.persisted === false ? 'NICHT gewährt (Browser darf Daten löschen)' : 'unbekannt' }),
        h('span', { text: 'Speichernutzung' }), h('b', { text: est ? `${fmtBytes(est.usage || 0)} von ${fmtBytes(est.quota || 0)}` : 'unbekannt' }),
        h('span', { text: 'RAM dekodierter Sounds' }), h('b', { text: fmtBytes(engine.memoryBytes()) })),

      h('h3', { text: 'Fehlerlog' }),
      logPre,
      h('div', { class: 'btns' }, h('button', { text: 'Log leeren', onclick: () => { log.entries.length = 0; log.errors = 0; app.updateErrChip(); fillLog(); } })));
    fillLog();
  };

  const offs = [
    engine.on('rebuilt', render), engine.on('devices', render), engine.on('state', render),
    midi.on('devices', render), midi.on('learn-done', render),
    midi.on('monitor', (name, m) => {
      const t = m.type === 'note' ? `Note ${m.on ? 'ON ' : 'OFF'} ${m.num} vel ${m.val}` : `CC ${m.num} = ${m.val}`;
      mon.lines.push(`${name} · Kanal ${m.ch} · ${t}`);
      if (mon.lines.length > 14) mon.lines.shift();
      if (!mon.raf) mon.raf = requestAnimationFrame(() => { mon.raf = 0; mon.pre.textContent = mon.lines.join('\n'); });
    }),
  ];
  const onLog = () => fillLog();
  log.subs.add(onLog);
  midi.monitor = true;
  dlg.addEventListener('close', () => {
    offs.forEach((f) => f());
    log.subs.delete(onLog);
    midi.monitor = false;
    cancelAnimationFrame(sweepRaf);
  }, { once: true });
  dlg.replaceChildren(head, body, foot);
  render();
  dlg.showModal();
  engine.listOutputs().then(render);
}
