# Aussteiger Band-App – Version 9.6.5

## Neu in Version 9.6.5
- Die Auto-Scroll-Geschwindigkeit wird jetzt pro Song gespeichert.
- Beim ersten Öffnen wird ein Startwert automatisch aus BPM und dem eingestellten Zeilenabstand berechnet.
- Eine manuelle Änderung am Geschwindigkeitsregler gilt nur für den aktuellen Song.
- Mit „Auto“ kann die individuelle Geschwindigkeit jederzeit wieder aus BPM + Zeilenabstand berechnet werden.
- Song-Geschwindigkeiten werden im Backup mitgesichert.


## Neu in Version 9.6.5

- PDFs können jetzt nachträglich an bereits bestehende Songs angehängt werden.
- Im Song-Editor: PDF hinzufügen, ersetzen oder entfernen.
- Im PDF-Reiter erscheint bei fehlendem PDF direkt „+ PDF hinzufügen“.
- PDF-Dateien bleiben lokal in IndexedDB gespeichert; Lyrics, Akkorde, Tabs und Notizen bleiben unverändert.

GitHub-Pages-kompatible Offline-PWA für Bandproben und Bühne.

## Neu in Version 9.6.2

- Tutorial-Overlay mit deutlich höherem Kontrast in der hellen Ansicht.
- Tutorial-Karte nutzt unabhängig vom App-Theme einen dunklen Hintergrund mit weißer Schrift.
- Der hervorgehobene Bereich bleibt im hellen Modus klar sichtbar; nur die Umgebung wird stark abgedunkelt.
- Blau/weißer Spotlight-Rahmen, im Modus „Hoher Kontrast“ gelb/weiß.
- Tutorial-Karte wechselt bei Bedienelementen am unteren Bildschirmrand automatisch nach oben.
- Fehlerhafte escaped Newlines im Tutorial-CSS wurden bereinigt.

## Neu in Version 9.6

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


## Version 9.6
- PDF-Songblätter lokal importieren und im Player anzeigen.
- Markdown-Dateien (.md/.markdown) importieren.
- ChordPro-Akkorde in eckigen Klammern werden über dem zugehörigen Songtext dargestellt.
- PDF-Dateien liegen lokal in IndexedDB und sind nicht Teil des JSON-Backups.


## Version 9.6
- Akkorde bleiben an ihrer tatsächlichen Textposition (Inline-Chords oder zweizeilige Akkordblätter).
- Freihand-Gesangsmarkierungen im Player (geschwungene Linien/Phrasierungszeichen), lokal pro Song gespeichert.
- Aktive Setliste teilen/exportieren; geteilte Setlisten enthalten die Songdaten.
- Universeller Import erkennt automatisch Song, Setliste oder Gesamt-Backup.


## Interaktives Tutorial (v9.6)
Beim ersten Start erscheint ein geführtes Overlay-Tutorial. Es kann jederzeit über „? App-Tutorial“ im Menü erneut gestartet werden.

## Version 9.6.5
- Metronom pro Song mit BPM, Tap Tempo, 3/4, 4/4 und 6/8 sowie optionalem Ton.
- PDF-Ansicht kann mit derselben Play/Scroll-Funktion automatisch weiterlaufen. Je nach Browser wird im eingebetteten PDF weich gescrollt oder seitenweise weitergeschaltet.
