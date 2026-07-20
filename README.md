# Band Setlist PWA

## Starten
Eine PWA sollte über einen lokalen Webserver geöffnet werden, nicht direkt per Doppelklick.

### Python
```bash
cd band-pwa
python3 -m http.server 8080
```
Dann im Browser öffnen: `http://localhost:8080`

Auf iPhone/iPad in Safari: Teilen -> Zum Home-Bildschirm.

## Songs bearbeiten
- Markdown-Dateien liegen unter `songs/`.
- Neue Datei anlegen.
- Eintrag in `songs/index.json` ergänzen.
- Eigene Lyrics, Akkorde und Songstruktur in die jeweilige `.md`-Datei schreiben.

## Bedienung
- Setliste per Drag & Drop sortieren.
- Songs hinzufügen/entfernen.
- Player mit Start/Stopp und variabler Scrollgeschwindigkeit.
- Leertaste startet/stoppt Autoscroll.
- Alt + Pfeil links/rechts wechselt den Song.
- Dark Mode, hoher Kontrast, Schriftgröße, Zeilenabstand und Vollbild.
