#!/bin/sh
# Startet einen lokalen Server und öffnet das Soundboard (Port bitte immer gleich lassen).
cd "$(dirname "$0")"
PORT=8080
echo "Soundboard läuft auf http://localhost:$PORT  (Beenden mit Strg+C)"
(sleep 1; (xdg-open "http://localhost:$PORT" || open "http://localhost:$PORT") >/dev/null 2>&1) &
exec python3 -m http.server $PORT --bind 127.0.0.1
