# Aussteiger Band-App – Version 9.4

GitHub-Pages-kompatible Offline-PWA für Bandproben und Bühne.

## Neu in Version 9.4

- Auto-Scroll bewegt nur noch das aktive Songblatt, nicht die Funktionsleisten.
- Auf Smartphones werden beim Start von Play Kopf- und Bedienleisten ausgeblendet.
- Ein Tap auf das Songblatt blendet die Bedienleisten während Play wieder ein bzw. aus.
- Start/Pause per Fußschalter funktioniert auch bei ausgeblendeten Leisten.


- Bluetooth-Fußschalter: Start/Pause, nächster Song und vorheriger Song
- Frei lernbare Pedaltasten; kompatibel mit Fußschaltern, die Tastaturbefehle senden
- Eigene mobile Tab-Ansicht mit horizontalem Scrollen
- Einklappbare Tab-Blöcke für Intro, Solo und Outro
- Eigener Notizen-Reiter pro Song
- Chordie-Referenz, lokaler Import und Transponierung bleiben erhalten

## Fußschalter einrichten

1. Fußschalter per Bluetooth mit Handy oder Tablet koppeln.
2. Aa-Menü öffnen und **Fußschalter** wählen.
3. Bei jeder Funktion **Taste lernen** drücken und anschließend das gewünschte Pedal betätigen.
4. Player öffnen und testen.

Standard: Leertaste = Start/Pause, Pfeil rechts = nächster Song, Pfeil links = vorheriger Song.

## Deployment

Alle Dateien und Ordner direkt in das Stammverzeichnis des GitHub-Pages-Repositories hochladen und vorhandene Dateien ersetzen. GitHub Actions deployt nach dem Commit automatisch.


## Version 9.4
- PDF-Songblätter lokal importieren und im Player anzeigen.
- Markdown-Dateien (.md/.markdown) importieren.
- ChordPro-Akkorde in eckigen Klammern werden über dem zugehörigen Songtext dargestellt.
- PDF-Dateien liegen lokal in IndexedDB und sind nicht Teil des JSON-Backups.


## Version 9.4
- Akkorde bleiben an ihrer tatsächlichen Textposition (Inline-Chords oder zweizeilige Akkordblätter).
- Freihand-Gesangsmarkierungen im Player (geschwungene Linien/Phrasierungszeichen), lokal pro Song gespeichert.
- Aktive Setliste teilen/exportieren; geteilte Setlisten enthalten die Songdaten.
- Universeller Import erkennt automatisch Song, Setliste oder Gesamt-Backup.
