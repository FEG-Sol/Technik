# Soundboard Live

Mehrkanal-Soundboard für die Show. Läuft nur in Google Chrome (Desktop oder installierte PWA), reines HTML/CSS/JS, keine Abhängigkeiten, offline lauffähig.

## Lokal starten

Web MIDI, Service Worker und Speicher-Persistenz brauchen einen sicheren Kontext (`http://localhost` reicht). Im Ordner dieser Dateien einen der Befehle ausführen:

```
python3 -m http.server 8080        # macOS/Linux; unter Windows: py -m http.server 8080
npx serve -l 8080                  # alternativ mit Node
```

Oder einfach `start.bat` (Windows) bzw. `./start.sh` (macOS/Linux) starten. Dann in Chrome `http://localhost:8080` öffnen.

**Als App installieren (empfohlen für die Show):** In Chrome rechts in der Adresszeile auf das Installieren-Symbol klicken (oder Menü → „Soundboard Live installieren“). Nach dem ersten Laden läuft die App auch ohne den Server (Service Worker), solange man dieselbe Adresse/Port benutzt. Wichtig: **immer denselben Port** verwenden, sonst sieht Chrome einen anderen Speicher (IndexedDB gehört zur Adresse).

**Nach Code-Änderungen:** in `sw.js` die Zahl in `CACHE = 'soundboard-shell-v1'` erhöhen. Neue Versionen werden bewusst erst beim nächsten Start aktiv, nie mitten in einer Show.

Debug: In der Chrome-Konsole (F12) ist `soundboard` verfügbar (z. B. `soundboard.engine.outputCount`).

## Bedienung in Kürze

- **Sounds hinzufügen:** „＋ Sounds“ (Mehrfachauswahl) oder Dateien ins Fenster ziehen. Auf ein leeres Pad gezogen, füllt die Datei dieses Pad.
- **Pad:** großer Play/Pause- und Reset-Button, darunter eine Statuszeile (Loop, Lautstärke unter 100 %, MIDI-Zuweisungen). Das Zahnrad `⚙` öffnet die **Pad-Einstellungen**: Lautstärke in % (Doppelklick = 100 %), Single-Shot/Loop, Routing-Matrix, MIDI Learn und Gate. Griff `⠿` zum Umsortieren, `✕` löscht (mit Rückfrage).
- **Zustände:** grün + pulsierend = spielt, gelb gestrichelt = Pause, rot = Fehler, grau = gestoppt.
- **Routing:** (in den Pad-Einstellungen) pro Pad eigene Matrix (Zeilen = Ausgänge der Soundkarte, Spalten = Dateikanäle). Zellen auf Ausgänge, die das aktuelle Gerät nicht hat, bleiben gespeichert, sind ausgegraut und tun nichts.
- **MIDI Learn:** in den Pad-Einstellungen (Play/Pause, Reset, Lautstärke per CC). Controller betätigen, Esc bricht ab. Doppelte Belegungen werden angezeigt. Note Off wird ignoriert, außer das Pad steht auf **Gate**.
- **Show-Modus:** sperrt Bearbeiten, Löschen, Umsortieren, Routing, Loop, Mapping, Gerätewahl. Auch die Pad-Einstellungen (Zahnrad, inkl. Lautstärke, Loop, Routing, MIDI Learn) sind gesperrt. Nur Play/Pause, Reset und Panic bleiben bedienbar. Per MIDI zugewiesene Lautstärke-Regler (CC) wirken weiterhin. Beenden nur mit Rückfrage. Der Zustand bleibt nach Neustart erhalten.
- **Panic:** stoppt alles mit 20 ms Ausblendung.
- **Tastaturkürzel** (nur wenn in den Einstellungen aktiviert): 1–9/0 = Pad 1–10 Play/Pause, Shift+Ziffer = Reset, Esc = Panic.
- **Speichern:** Autosave in IndexedDB (inkl. Audio). „Speichern …“ schreibt eine `.sbproj`-Datei (versioniert, mit Audio, einstellbar), „Laden …“ liest sie validiert wieder ein. Beschädigte Dateien werden abgelehnt, ohne das Projekt zu verändern.

## Wichtige Hinweise

- Ob Chrome wirklich alle Kanäle der Soundkarte ausgibt, entscheidet das Betriebssystem. Unter Windows muss die Karte im Standardformat entsprechend viele Kanäle melden (Soundeinstellungen → Gerät → Eigenschaften → Erweitert; bei ASIO-only-Karten ggf. WASAPI-Treiber/Mixer der Karte nutzen). Im Einstellungsdialog zeigt „maxChannelCount“ den Wert, den Chrome sieht. Der Ausgangstest prüft die Reihenfolge.
- Maximal 32 Kanäle pro Datei und Ausgang (Grenze der Web-Audio-Knoten in Chrome).
- Alle Sounds liegen dekodiert (Float32) im RAM: Stereo, 48 kHz ≈ 23 MB pro Minute, 8 Kanäle ≈ 92 MB pro Minute. Die Kopfleiste zeigt den Verbrauch, ab 1 GB gibt es eine Warnung, ab 2 GB eine rote.
- Der Tab sollte im Vordergrund bleiben. Chrome drosselt Hintergrund-Tabs; Audio läuft zwar weiter, Anzeigen und Watchdog aber langsamer. Die App warnt, wenn der Tab im Hintergrund war.
- Dateien, die Chrome nicht dekodiert, werden am Pad als Fehler markiert (anderes Format/Codec nötig). Ein fehlerhaftes Pad wird nach Neustart zu einem leeren Platzhalter.

## Checkliste: Test mit der echten Soundkarte

**Vorher:** Verstärker/Beschallung stumm bzw. leise, Testton ist −20 dBFS.

1. **Kanalzahl:** Soundkarte als Standardgerät setzen, Chrome neu starten. Kopfleiste zeigt „N Ausg.“. Stimmt N nicht (nur 2?), Windows-Soundeinstellungen/Treiber prüfen, in den Einstellungen „Audio neu verbinden“.
2. **Ausgangsreihenfolge:** Einstellungen → „Alle nacheinander“. Ausgang 1…N müssen nacheinander an den richtigen Buchsen/Kanälen erscheinen. Danach einzeln gegenprüfen.
3. **Mehrkanal-Datei:** 4-/6-/8-Kanal-WAV laden; es müssen genau so viele Pegelanzeigen erscheinen. Standard-Routing 1:1 prüfen, dann einzelne Zellen umlegen und mithören. Mono-Datei muss auf Ausgang 1 und 2 liegen.
4. **Geräteverlust:** Während ein Loop läuft das USB-Kabel der Karte ziehen. Erwartung: Meldung, Wechsel aufs Standardgerät, Pads angehalten mit Banner „Alle fortsetzen“ (Position gemerkt). Karte wieder einstecken: Banner „Gerät wieder verfügbar“, „Jetzt wechseln“.
5. **Gerätewechsel:** In den Einstellungen anderes Ausgabegerät wählen, Kanalzahl und Matrixzeilen passen sich an. Projekt auf anderem Rechner (weniger Ausgänge) laden: Zellen ausgegraut, keine Fehler.
6. **Dauerlauf:** Mehrere Loops (inkl. langer Datei) 2–4 Stunden laufen lassen. Beobachten: keine Aussetzer/Knackser, RAM-Anzeige stabil, Fehlerlog leer, Wake Lock aktiv (Einstellungen), Uhr/Position laufen.
7. **Großer RAM-Verbrauch:** Viele lange Mehrkanal-Dateien laden, bis die Warnung erscheint. Reload: Startzeit akzeptabel? Tab stürzt nicht ab? Im Zweifel Dateien kürzen oder Samplerate senken.
8. **MIDI-Hot-Plug:** Controller abziehen und wieder anstecken: Chip „MIDI: …“ wechselt, Mapping funktioniert ohne Neustart. Live-Monitor in den Einstellungen zeigt Nachrichten. Doppelbelegung testen, Learn mit Esc abbrechen.
9. **Persistenz:** App schließen, neu öffnen: Pads, Namen, Lautstärken, Routing, Mappings, Audio sind da. „Persistenter Speicher“ in den Einstellungen sollte „gewährt“ zeigen (bei installierter PWA meist ja).
10. **Projektdatei:** „Speichern …“, „Neu“, „Laden …“; zusätzlich auf zweitem Rechner importieren.
11. **Show-Modus:** aktivieren, prüfen dass nichts änderbar ist (Zahnrad ausgeblendet, Lautstärke gesperrt), Play/Reset/Panic und ein per MIDI belegter Lautstärke-Regler funktionieren. Fenster schließen: Warnung bei laufendem Sound.
12. **Offline:** Server beenden, installierte PWA bzw. Adresse neu öffnen: App startet, Projekt ist da.

## Dateien

| Datei | Zweck |
|---|---|
| `index.html`, `style.css` | Oberfläche (dunkles Theme, hoher Kontrast) |
| `app.js` | Orchestrierung: Autosave, Drag & Drop, Show-Modus, MIDI-Trigger, Wake Lock |
| `engine.js` | AudioContext, Ausgabegerät, Pad-Audio-Graph, Routing, Neuaufbau, Watchdog, Testton |
| `ui.js`, `dialogs.js` | Pad-Ansicht mit Pegelanzeigen, Banner, Routing-/Einstellungsdialog |
| `midi.js` | Web MIDI, Hot-Plug, Learn, Monitor |
| `store.js` | IndexedDB, `storage.persist()` |
| `project.js` | Projektformat (`.sbproj`), Validierung, Import/Export |
| `util.js` | DOM-Helfer, Fehlerlog |
| `sw.js`, `manifest.webmanifest` | PWA/Offline |
| `logo.svg` | Logo (Service-Klingel, transparenter Hintergrund) für Kopfzeilen, Dokumente, Folien |
| `icon.svg`, `icon-small.svg`, `icon-*.png` | App-Icon mit dunkler Kachel; `icon-small.svg` ohne Schallwellen als Favicon, `icon-maskable-512.png` für runde/ausgeschnittene Android-/Desktop-Icons |
