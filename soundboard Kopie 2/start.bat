@echo off
cd /d "%~dp0"
echo Soundboard laeuft auf http://localhost:8080  (Beenden mit Strg+C)
start "" http://localhost:8080
py -m http.server 8080 --bind 127.0.0.1 || python -m http.server 8080 --bind 127.0.0.1
