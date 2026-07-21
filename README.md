# Band App

Private PWA fuer Setlisten, Songblaetter und automatisches Scrollen.

## Struktur

- `index.html` – App-Oberflaeche
- `app.js` – Navigation, Setliste, Player und Autoscroll
- `styles.css` – responsives Layout, Dark Mode und Kontrastmodus
- `manifest.json` – PWA-Metadaten
- `service-worker.js` – Offline-Cache
- `songs/` – Markdown-Songblaetter und `index.json`
- `setlists/` – gespeicherte Ausgangssetlisten
- `assets/icons/` – App-Symbole
- `assets/images/` – optionale Bilder
- `settings/` – Standardwerte

## Lokal starten

```bash
python3 -m http.server 8080
```

Danach `http://localhost:8080` oeffnen.

## GitHub Pages

Den Inhalt dieses Ordners in das Stammverzeichnis eines Repositorys hochladen und GitHub Pages fuer den Hauptbranch aktivieren.
