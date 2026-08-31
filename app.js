const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const STORAGE = {
  setlists: 'band-v4-setlists',
  activeSetlist: 'band-v4-active-setlist',
  current: 'band-current',
  speed: 'band-speed',
  songSpeeds: 'band-v964-song-speeds',
  display: 'band-display',
  overrides: 'band-song-overrides',
  favorites: 'band-v4-favorites',
  libraries: 'band-v6-libraries',
  importedSongs: 'band-v6-imported-songs',
  footswitch: 'band-v9-footswitch',
  annotations: 'band-v9-annotations',
  transportCollapsed: 'band-v9-transport-collapsed',
  metronome: 'band-v965-metronome',
  live: 'band-v966-live'
};

const state = {
  songs: [], baseSongs: [], defaultSetlists: [], setlists: [], activeSetlistId: '',
  currentId: localStorage.getItem(STORAGE.current),
  scrollSpeed: 45,
  songSpeeds: {},
  scrolling: false, lastTs: 0, overrides: {}, favorites: new Set(),
  libraries: [], importedSongs: [],
  footswitch: { play: 'Space', next: 'ArrowRight', prev: 'ArrowLeft' }, learningFootswitch: null,
  annotations: {}, annotationMode: false, activeStroke: null,
  metronomeSettings: {}, metronomeRunning: false, metronomeTimer: null, metronomeBeat: 0, metronomeAudio: null, tapTimes: [],
  pdfScroll: { page: 1, pages: 0, fallbackProgress: 0 },
  live: { gigMode:false, countInTimer:null, countInBeat:0, sectionIndex:0 }
};

async function getJSON(path) {
  const response = await fetch(new URL(path, document.baseURI), { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const data = await response.json();
  return data;
}

function safeParse(value, fallback) {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
}

function normalizeSongIds(items = []) {
  return items.map(item => typeof item === 'string' ? item : item?.id).filter(Boolean);
}

function normalizeSetlists(lists = []) {
  return lists.map((list, index) => ({
    id: String(list.id || `setlist-${index + 1}`),
    name: String(list.name || `Setliste ${index + 1}`),
    description: String(list.description || ''),
    songs: normalizeSongIds(list.songs)
  }));
}

function loadLocalState() {
  state.overrides = safeParse(localStorage.getItem(STORAGE.overrides), {});
  state.favorites = new Set(safeParse(localStorage.getItem(STORAGE.favorites), []));
  const storedLists = safeParse(localStorage.getItem(STORAGE.setlists), null);
  state.setlists = Array.isArray(storedLists) ? normalizeSetlists(storedLists) : structuredClone(state.defaultSetlists);
  state.activeSetlistId = localStorage.getItem(STORAGE.activeSetlist) || state.setlists[0]?.id || '';
  if (!state.setlists.some(list => list.id === state.activeSetlistId)) state.activeSetlistId = state.setlists[0]?.id || '';
  state.libraries = safeParse(localStorage.getItem(STORAGE.libraries), []);
  state.importedSongs = safeParse(localStorage.getItem(STORAGE.importedSongs), []);
  state.footswitch = { ...state.footswitch, ...safeParse(localStorage.getItem(STORAGE.footswitch), {}) };
  state.annotations = safeParse(localStorage.getItem(STORAGE.annotations), {});
  state.songSpeeds = safeParse(localStorage.getItem(STORAGE.songSpeeds), {});
  state.metronomeSettings = safeParse(localStorage.getItem(STORAGE.metronome), {});
  state.footswitch.actions = { scroll:'scroll', next:'next', prev:'prev', ...(state.footswitch.actions || {}) };
}

function mergeSongs() {
  const base = state.baseSongs.map(item => ({ ...item, library: 'core' }));
  const imported = state.importedSongs.map(item => ({ ...item }));
  state.songs = [...base, ...imported].map(item => ({ ...item, ...(state.overrides[item.id] || {}) }));
}

function saveLibraries() {
  localStorage.setItem(STORAGE.libraries, JSON.stringify(state.libraries));
  localStorage.setItem(STORAGE.importedSongs, JSON.stringify(state.importedSongs));
  mergeSongs();
}

function slugify(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '') || 'song';
}

function uniqueSongId(baseId) {
  const existing = new Set([...state.baseSongs, ...state.importedSongs].map(item => item.id));
  if (!existing.has(baseId)) return baseId;
  let index = 2; let candidate = `${baseId}-${index}`;
  while (existing.has(candidate)) { index += 1; candidate = `${baseId}-${index}`; }
  return candidate;
}


const PDF_DB = 'aussteiger-bandapp-files-v1';
const PDF_STORE = 'pdfs';
let activePdfObjectUrl = '';

function openPdfDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PDF_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PDF_STORE)) db.createObjectStore(PDF_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function savePdfBlob(songId, file) {
  const db = await openPdfDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(PDF_STORE, 'readwrite');
    tx.objectStore(PDF_STORE).put(file, songId);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function getPdfBlob(songId) {
  const db = await openPdfDb();
  const value = await new Promise((resolve, reject) => {
    const tx = db.transaction(PDF_STORE, 'readonly');
    const request = tx.objectStore(PDF_STORE).get(songId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  db.close(); return value;
}

async function deletePdfBlob(songId) {
  const db = await openPdfDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(PDF_STORE, 'readwrite');
    tx.objectStore(PDF_STORE).delete(songId);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
  db.close();
}

function parseMarkdownSong(text, filename) {
  let source = String(text || '').replace(/\r\n?/g, '\n');
  let title = '', artist = '', key = '', capo = '', bpm = '', singer = '';
  if (source.startsWith('---\n')) {
    const end = source.indexOf('\n---', 4);
    if (end >= 0) {
      const frontmatter = source.slice(4, end).split('\n');
      for (const line of frontmatter) {
        const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (!match) continue;
        const name = match[1].toLowerCase(), value = match[2].trim().replace(/^['\"]|['\"]$/g, '');
        if (name === 'title') title = value;
        else if (name === 'artist') artist = value;
        else if (name === 'key') key = value;
        else if (name === 'capo') capo = value;
        else if (name === 'bpm' || name === 'tempo') bpm = value;
        else if (name === 'singer') singer = value;
      }
      source = source.slice(end + 4).replace(/^\s+/, '');
    }
  }
  const lines = source.split('\n');
  const body = [];
  for (const raw of lines) {
    const line = raw.trim();
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      const value = heading[1].trim();
      if (!title) { title = value; continue; }
      if (!artist && body.length === 0) { artist = value; continue; }
      body.push(`[${value}]`); continue;
    }
    body.push(raw);
  }
  const fallbackName = filename.replace(/\.[^.]+$/, '');
  if (!title) title = fallbackName;
  return { title, artist, key: key || undefined, capo: capo ? Number(capo) : undefined, bpm: bpm ? Number(bpm) : undefined, singer, content: normalizePastedSongText(body.join('\n')) };
}

function isChordToken(token) {
  return /^[A-G](?:#|b)?(?:(?:m|min|maj|dim|aug|sus|add)?\d*)?(?:\/[A-G](?:#|b)?)?$/.test(token);
}


const NOTE_NAMES_SHARP = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const NOTE_NAMES_FLAT = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
const NOTE_INDEX = { C:0, 'C#':1, Db:1, D:2, 'D#':3, Eb:3, E:4, F:5, 'F#':6, Gb:6, G:7, 'G#':8, Ab:8, A:9, 'A#':10, Bb:10, B:11 };

function transposeNote(note, semitones, preferFlats = false) {
  const index = NOTE_INDEX[note];
  if (index === undefined) return note;
  const names = preferFlats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP;
  return names[(index + semitones + 120) % 12];
}

function transposeChord(chord, semitones) {
  if (!semitones) return chord;
  const match = String(chord).match(/^([A-G](?:#|b)?)(.*?)(?:\/([A-G](?:#|b)?))?$/);
  if (!match) return chord;
  const preferFlats = chord.includes('b') || semitones < 0;
  const root = transposeNote(match[1], semitones, preferFlats);
  const bass = match[3] ? `/${transposeNote(match[3], semitones, preferFlats)}` : '';
  return `${root}${match[2] || ''}${bass}`;
}

function chordieSearchUrl(item) {
  const query = [item?.title, item?.artist].filter(Boolean).join(' ');
  return `https://www.chordie.com/results.php?q=${encodeURIComponent(query)}&np=0&ps=10`;
}

function songChordieUrl(item) {
  const url = item?.source?.url || item?.chordieUrl || '';
  return /^https:\/\/(?:www\.)?chordie\.com\//i.test(url) ? url : chordieSearchUrl(item);
}

function normalizePastedSongText(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  return lines.map(raw => {
    const line = raw.trim();
    if (!line) return '';
    if (/^https?:\/\//i.test(line)) return '';
    const tokens = line.split(/\s+/).filter(Boolean);
    const chordCount = tokens.filter(token => isChordToken(token.replace(/[|:(),]/g, ''))).length;
    if (tokens.length && chordCount / tokens.length >= 0.65) {
      return tokens.map(token => {
        const clean = token.replace(/[|:(),]/g, '');
        return isChordToken(clean) ? `[${clean}]` : token;
      }).join(' ');
    }
    return raw.replace(/(^|\s)([A-G](?:#|b)?(?:(?:m|min|maj|dim|aug|sus|add)?\d*)?(?:\/[A-G](?:#|b)?)?)(?=\s|$)/g, '$1[$2]');
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function ensureClipboardLibrary() {
  let lib = state.libraries.find(item => item.id === 'lib-clipboard-imports');
  if (!lib) {
    lib = { id: 'lib-clipboard-imports', name: 'Chordie / Zwischenablage', importedAt: new Date().toISOString(), count: 0 };
    state.libraries.push(lib);
  }
  return lib;
}

function openChordieImport() {
  const current = song(state.currentId);
  $('#chordieSongTitle').value = current?.title || '';
  $('#chordieArtist').value = current?.artist || '';
  $('#chordiePasteText').value = '';
  $('#chordieImportStatus').textContent = '';
  $('#chordieImportDialog').showModal();
}

function searchChordie() {
  const title = $('#chordieSongTitle').value.trim();
  const artist = $('#chordieArtist').value.trim();
  const query = [title, artist].filter(Boolean).join(' ');
  if (!query) { $('#chordieImportStatus').textContent = 'Bitte zuerst einen Songtitel eingeben.'; return; }
  const url = `https://www.chordie.com/results.php?q=${encodeURIComponent(query)}&np=0&ps=10`;
  window.open(url, '_blank', 'noopener,noreferrer');
  $('#chordieImportStatus').textContent = 'Chordie wurde geöffnet. Dort eine Fassung auswählen und den Songtext mit Akkorden kopieren.';
}

async function readClipboardIntoImporter() {
  const status = $('#chordieImportStatus');
  try {
    if (!navigator.clipboard?.readText) throw new Error('Zwischenablage-API nicht verfügbar');
    const text = await navigator.clipboard.readText();
    if (!text.trim()) throw new Error('Zwischenablage ist leer');
    $('#chordiePasteText').value = text;
    status.textContent = `${text.length} Zeichen eingefügt. Bitte kurz prüfen und dann importieren.`;
  } catch (error) {
    status.textContent = 'Automatisches Einfügen wurde blockiert. Tippe in das Textfeld und wähle manuell „Einfügen“.';
    $('#chordiePasteText').focus();
  }
}

function saveClipboardSong() {
  const title = $('#chordieSongTitle').value.trim();
  const artist = $('#chordieArtist').value.trim();
  const raw = $('#chordiePasteText').value;
  const status = $('#chordieImportStatus');
  if (!title) { status.textContent = 'Bitte einen Songtitel eingeben.'; return; }
  if (!raw.trim()) { status.textContent = 'Bitte zuerst Lyrics und Akkorde einfügen.'; return; }
  const content = normalizePastedSongText(raw);
  const library = ensureClipboardLibrary();
  const id = uniqueSongId(slugify(`${title}-${artist || 'import'}`));
  state.importedSongs.push({ id, library: library.id, title, artist, tags: ['Zwischenablage-Import'], source: { site: 'Chordie', importedByUser: true, url: chordieSearchUrl({ title, artist }) }, content });
  library.count = state.importedSongs.filter(item => item.library === library.id).length;
  library.importedAt = new Date().toISOString();
  saveLibraries(); renderLibraryFilterOptions(); renderLibrariesManager(); renderAll();
  $('#chordieImportDialog').close();
  openSong(id);
}

function parseChordProText(text, filename) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let title = '', artist = '', key = '', capo = '';
  const content = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const directive = line.match(/^\{\s*([a-z_]+)\s*:?\s*(.*?)\s*\}$/i);
    if (directive) {
      const name = directive[1].toLowerCase(); const value = directive[2].trim();
      if (['title', 't'].includes(name)) title = value;
      else if (['artist', 'subtitle', 'st'].includes(name)) artist = value;
      else if (name === 'key') key = value;
      else if (name === 'capo') capo = value;
      continue;
    }
    if (/^\{(start_of|end_of|soc|eoc|sot|eot|comment)/i.test(line)) continue;
    content.push(rawLine);
  }
  const fallbackName = filename.replace(/\.[^.]+$/, '');
  if (!title) {
    const guess = fallbackName.split(/\s*-\s*/);
    if (guess.length >= 2) { artist = artist || guess[0].trim(); title = guess.slice(1).join(' - ').trim(); }
    else title = fallbackName;
  }
  return { title: title || fallbackName, artist, key: key || undefined, capo: capo ? Number(capo) : undefined, content: content.join('\n').trim() };
}

async function importSongFiles(fileList) {
  const files = [...fileList]; if (!files.length) return;
  const libraryName = prompt('Name für diese Songbibliothek (z. B. „Hochzeitsband Setlist“):', files[0].name.replace(/\.[^.]+$/, ''));
  if (!libraryName?.trim()) return;
  const libraryId = `lib-${slugify(libraryName)}-${Date.now().toString(36)}`;
  const newSongs = [];
  let failCount = 0;
  for (const file of files) {
    try {
      const lower = file.name.toLowerCase();
      if (lower.endsWith('.pdf') || file.type === 'application/pdf') {
        const title = file.name.replace(/\.pdf$/i, '');
        const id = uniqueSongId(slugify(`${title}-pdf`));
        await savePdfBlob(id, file);
        newSongs.push({ id, library: libraryId, title, artist: '', tags: ['PDF-Import'], pdfAttachment: true, pdfName: file.name, content: `[PDF]\nOriginal-Songblatt ist im Reiter „PDF“ gespeichert.` });
        continue;
      }
      const text = await file.text();
      if (lower.endsWith('.json')) {
        const parsed = JSON.parse(text);
        const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed.songs) ? parsed.songs : [parsed];
        items.forEach(item => {
          if (!item || (!item.title && !item.content && !item.lyrics)) return;
          const id = uniqueSongId(item.id ? String(item.id) : slugify(`${item.title || 'song'}-${item.artist || ''}`));
          newSongs.push({
            id, library: libraryId,
            title: String(item.title || id), artist: String(item.artist || ''),
            genre: item.genre || '', tags: Array.isArray(item.tags) ? item.tags : [],
            key: item.key || undefined, bpm: item.bpm ? Number(item.bpm) : undefined,
            capo: item.capo !== undefined ? Number(item.capo) : undefined, singer: item.singer || '',
            content: String(item.content || item.lyrics || '')
          });
        });
      } else if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
        const song = parseMarkdownSong(text, file.name);
        const id = uniqueSongId(slugify(`${song.title}-${song.artist || 'markdown'}`));
        newSongs.push({ id, library: libraryId, ...song, tags: ['Markdown-Import'] });
      } else if (lower.endsWith('.cho') || lower.endsWith('.crd') || lower.endsWith('.pro') || lower.endsWith('.chopro') || lower.endsWith('.chordpro') || lower.endsWith('.txt')) {
        const song = parseChordProText(text, file.name);
        const id = uniqueSongId(slugify(`${song.title}-${song.artist}`));
        newSongs.push({ id, library: libraryId, ...song, tags: [] });
      } else { failCount += 1; }
    } catch (error) { failCount += 1; console.error(error); }
  }
  if (!newSongs.length) { alert('Keine passenden Songs gefunden. Unterstützt werden JSON, Markdown, ChordPro/Text und PDF.'); return; }
  state.libraries.push({ id: libraryId, name: libraryName.trim(), importedAt: new Date().toISOString(), count: newSongs.length });
  state.importedSongs.push(...newSongs);
  saveLibraries(); renderAll(); renderLibraryFilterOptions();
  alert(`${newSongs.length} Song(s) in neue Bibliothek „${libraryName.trim()}“ importiert${failCount ? ` (${failCount} Datei(en) übersprungen)` : ''}.`);
}

async function removeLibrary(libraryId) {
  const lib = state.libraries.find(item => item.id === libraryId); if (!lib) return;
  if (!confirm(`Bibliothek „${lib.name}“ und ihre ${lib.count} Song(s) wirklich löschen?`)) return;
  const removing = state.importedSongs.filter(item => item.library === libraryId);
  for (const item of removing) if (item.pdfAttachment) { try { await deletePdfBlob(item.id); } catch (error) { console.warn(error); } }
  state.libraries = state.libraries.filter(item => item.id !== libraryId);
  state.importedSongs = state.importedSongs.filter(item => item.library !== libraryId);
  saveLibraries(); renderAll(); renderLibraryFilterOptions(); renderLibrariesManager();
}

function renderLibraryFilterOptions() {
  const select = $('#libraryFilter'); if (!select) return;
  const current = select.value;
  [...select.querySelectorAll('option[data-library]')].forEach(option => option.remove());
  state.libraries.forEach(lib => {
    const option = document.createElement('option');
    option.value = `lib:${lib.id}`; option.dataset.library = '1';
    option.textContent = `Bibliothek: ${lib.name} (${lib.count})`;
    select.append(option);
  });
  if ([...select.options].some(option => option.value === current)) select.value = current;
}

function renderLibrariesManager() {
  const host = $('#librariesManager'); if (!host) return; host.innerHTML = '';
  if (!state.libraries.length) { host.innerHTML = '<p class="empty">Noch keine Songbibliotheken importiert.</p>'; return; }
  state.libraries.forEach(lib => {
    const row = document.createElement('div'); row.className = 'picker-item';
    row.innerHTML = `<div><strong>${esc(lib.name)}</strong><small>${lib.count} Song(s) · importiert ${new Date(lib.importedAt).toLocaleDateString('de')}</small></div><button type="button">Entfernen</button>`;
    row.querySelector('button').onclick = () => removeLibrary(lib.id);
    host.append(row);
  });
}

function saveSongSpeeds() {
  localStorage.setItem(STORAGE.songSpeeds, JSON.stringify(state.songSpeeds));
}

function recommendedScrollSpeed(item) {
  const settings = safeParse(localStorage.getItem(STORAGE.display), {});
  const lineSpacing = (Number(settings.line) || 160) / 100;
  const bpm = Math.max(30, Math.min(240, Number(item?.bpm) || 100));
  // Heuristik: bei 120 BPM und 1.6 Zeilenabstand etwa 45 px/s.
  return Math.max(5, Math.min(180, Math.round((bpm * lineSpacing) / 4.25)));
}

function applySpeedForSong(item = song(state.currentId)) {
  if (!item) return;
  const saved = Number(state.songSpeeds[item.id]);
  const isCustom = Number.isFinite(saved) && saved >= 5;
  state.scrollSpeed = isCustom ? saved : recommendedScrollSpeed(item);
  const range = $('#speedRange');
  const output = $('#speedValue');
  if (range) range.value = state.scrollSpeed;
  if (output) output.textContent = `${state.scrollSpeed} px/s${isCustom ? '' : ' · Auto'}`;
}

function resetCurrentSongSpeedToAuto() {
  if (!state.currentId) return;
  delete state.songSpeeds[state.currentId];
  saveSongSpeeds();
  applySpeedForSong();
}

function saveSetlists() {
  localStorage.setItem(STORAGE.setlists, JSON.stringify(state.setlists));
  localStorage.setItem(STORAGE.activeSetlist, state.activeSetlistId);
}

function saveOverrides() {
  localStorage.setItem(STORAGE.overrides, JSON.stringify(state.overrides));
  mergeSongs();
}

function saveFavorites() {
  localStorage.setItem(STORAGE.favorites, JSON.stringify([...state.favorites]));
}

function activeSetlist() {
  return state.setlists.find(list => list.id === state.activeSetlistId) || state.setlists[0] || null;
}

function song(id) { return state.songs.find(item => item.id === id); }
function esc(value = '') { return String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char])); }
function meta(item) { return [item.key && `Tonart ${item.key}`, item.bpm && `${item.bpm} BPM`, Number(item.capo) > 0 && `Capo ${item.capo}`].filter(Boolean).join(' · '); }
function searchable(item) { return [item.title, item.artist, item.genre, ...(item.tags || [])].join(' ').toLowerCase(); }
function isPublicDomain(item) { return item.tags?.some(tag => /public domain|gemeinfrei/i.test(tag)) || /public domain|gemeinfrei/i.test(item.source?.lyricsLicense || ''); }

function dismissSplash() {
  const splash = $('#splash'); if (!splash) return;
  let dismissed = false;
  const hide = () => { if (dismissed) return; dismissed = true; splash.classList.add('hide'); setTimeout(() => splash.remove(), 550); };
  splash.addEventListener('click', hide, { once: true });
  setTimeout(hide, 2200);
}

async function init() {
  try {
    state.baseSongs = await getJSON('./songs.json');
    state.defaultSetlists = normalizeSetlists(await getJSON('./setlists.json'));
    loadLocalState(); mergeSongs(); bindUI(); applySettings(); setTransportCollapsed(localStorage.getItem(STORAGE.transportCollapsed) === '1', false); renderLibraryFilterOptions(); renderLibrariesManager(); renderAll();
    const initial = song(state.currentId) ? state.currentId : activeSetlist()?.songs.find(id => song(id)) || state.songs[0]?.id;
    if (initial) await openSong(initial, false);
    switchView('dashboard');
    if ('serviceWorker' in navigator) navigator.serviceWorker.register(new URL('./service-worker.js?v=9.6.8', document.baseURI), { scope: './', updateViaCache: 'none' }).then(registration => registration.update()).catch(console.error);
    dismissSplash();
  } catch (error) {
    $('#errorBanner').hidden = false;
    $('#errorBanner').textContent = `App konnte nicht geladen werden: ${error.message}`;
    console.error(error);
  }
}

function bindUI() {
  $('#menuBtn').onclick = openDrawer; $('#backdrop').onclick = closeDrawer;
  $('#dashboardSetlistBtn').onclick = () => switchView('setlists');
  $('#dashboardOpenSetlistBtn').onclick = () => switchView('setlists');
  $('#dashboardLibraryBtn').onclick = () => switchView('library');
  $('#dashboardFavoritesBtn').onclick = () => switchView('favorites');
  $('#dashboardContinueBtn').onclick = () => switchView('player');
  $('#dashboardGigBtn').onclick = () => { switchView('player'); if(!state.live.gigMode) toggleGigMode(); };
  $('#insertSotBtn').onclick = () => insertEditorText('{sot: Intro}\n');
  $('#insertEotBtn').onclick = () => insertEditorText('\n{eot}');
  $('#insertTabBlockBtn').onclick = () => insertEditorText('{sot: Intro}\ne|----------------|\nB|----------------|\nG|----------------|\nD|----------------|\nA|----------------|\nE|----------------|\n{eot}\n');

  $$('.nav-item').forEach(button => button.onclick = () => switchView(button.dataset.view));
  $('#settingsBtn').onclick = () => $('#displaySettings').showModal();
  $('#tutorialBtn').onclick = () => { closeDrawer(); startTutorial(true); };
  $('#setlistSelect').onchange = event => { state.activeSetlistId = event.target.value; saveSetlists(); renderAll(); };
  $('#newSetlistBtn').onclick = createSetlist; $('#renameSetlistBtn').onclick = renameSetlist; $('#deleteSetlistBtn').onclick = deleteSetlist;
  $('#exportSetlistBtn').onclick = exportActiveSetlist;
  $('#addSongBtn').onclick = () => { renderPicker(); $('#songPicker').showModal(); };
  $('#resetSetlistBtn').onclick = resetActiveSetlist;
  $('#searchInput').oninput = renderLibrary; $('#libraryFilter').onchange = renderLibrary;
  $('#favoriteSearch').oninput = renderFavorites; $('#pickerSearch').oninput = renderPicker;
  $('#startStopBtn').onclick = toggleScroll; $('#toTopBtn').onclick = scrollActiveToTop;
  $('#transportToggleBtn').onclick = () => setTransportCollapsed(!document.body.classList.contains('transport-collapsed'), true);
  $('#miniStartStopBtn').onclick = toggleScroll; $('#miniPrevBtn').onclick = () => stepSong(-1); $('#miniNextBtn').onclick = () => stepSong(1); $('#miniTransposeDownBtn').onclick = () => changeTranspose(-1); $('#miniTransposeUpBtn').onclick = () => changeTranspose(1);
  $('#lyricsTabBtn').onclick = () => setPlayerPanel('lyrics'); $('#tabsTabBtn').onclick = () => setPlayerPanel('tabs'); $('#notesTabBtn').onclick = () => setPlayerPanel('notes'); $('#pdfTabBtn').onclick = () => setPlayerPanel('pdf');
  $('#prevSongBtn').onclick = () => stepSong(-1); $('#nextSongBtn').onclick = () => stepSong(1);
  $('#favoriteCurrentBtn').onclick = () => toggleFavorite(state.currentId);
  $('#editSongBtn').onclick = openEditor; $('#annotationBtn').onclick = toggleAnnotationMode; $('#clearAnnotationsBtn').onclick = clearCurrentAnnotations; $('#transposeDownBtn').onclick = () => changeTranspose(-1); $('#transposeResetBtn').onclick = resetTranspose; $('#transposeUpBtn').onclick = () => changeTranspose(1); $('#openSongChordieBtn').onclick = openCurrentSongOnChordie; $('#saveSongBtn').onclick = saveEditedSong; $('#deleteOverrideBtn').onclick = deleteOverride;
  $('#attachPdfBtn').onclick = promptPdfForCurrentSong; $('#removePdfBtn').onclick = removePdfFromCurrentSong; $('#attachPdfInput').onchange = handlePdfAttachmentSelection;
  $('#exportBtn').onclick = exportData; $('#importFile').onchange = importUniversalFile;
  $('#importSongsFile').onchange = event => { importSongFiles(event.target.files); event.target.value = ''; };
  $('#openChordieImportBtn').onclick = openChordieImport;
  $('#searchChordieBtn').onclick = searchChordie;
  $('#readClipboardBtn').onclick = readClipboardIntoImporter;
  $('#saveClipboardSongBtn').onclick = saveClipboardSong;
  applySpeedForSong();
  $('#speedRange').oninput = event => {
    state.scrollSpeed = Number(event.target.value);
    $('#speedValue').textContent = `${state.scrollSpeed} px/s`;
    if (state.currentId) { state.songSpeeds[state.currentId] = state.scrollSpeed; saveSongSpeeds(); }
  };
  $('#speedAutoBtn').onclick = resetCurrentSongSpeedToAuto;
  $('#metronomeStartBtn').onclick = toggleMetronome; $('#miniMetronomeBtn').onclick = toggleMetronome; $('#metronomeTapBtn').onclick = tapTempo;
  $('#miniMoreBtn').onclick = () => {
    document.body.classList.remove('playback-focus');
    setTransportCollapsed(false, true);
    updatePlayerLayout();
  };

  $('#metronomeBpm').onchange = saveCurrentMetronomeSettings; $('#metronomeMeter').onchange = saveCurrentMetronomeSettings; $('#metronomeSound').onchange = saveCurrentMetronomeSettings;
  $('#gigModeBtn').onclick = toggleGigMode; $('#countInBtn').onclick = startCountIn;
  ['Play','Next','Prev'].forEach(k => { const el=$(`#footAction${k}`); if(el) el.onchange=saveFootswitchActions; });

  ['darkToggle','contrastToggle','uiFontRange','fontRange','lineRange','chordColor'].forEach(id => $(`#${id}`).oninput = saveSettings);
  $('#resetDisplayBtn').onclick = resetDisplaySettings;
  $('#footswitchSettingsBtn').onclick = openFootswitchSettings; $('#learnPlayKeyBtn').onclick = () => beginFootswitchLearning('play'); $('#learnNextKeyBtn').onclick = () => beginFootswitchLearning('next'); $('#learnPrevKeyBtn').onclick = () => beginFootswitchLearning('prev'); $('#resetFootswitchBtn').onclick = resetFootswitch;
  document.addEventListener('keydown', handleFootswitchKey);
  $('#fullscreenBtn').onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopScroll(); });
  $$('.player-panel').forEach(panel => panel.addEventListener('click', handlePlayerPanelTap));
}

function renderAll() { renderSetlistSelect(); renderSetlist(); renderLibrary(); renderFavorites(); updateFavoriteButton(); renderDashboard(); requestAnimationFrame(updatePlayerLayout); }
function openDrawer() { $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false'); $('#backdrop').hidden = false; }
function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); $('#backdrop').hidden = true; }
function switchView(name) {
  $$('.view').forEach(view => view.classList.remove('active')); $(`#${name}View`).classList.add('active');
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  $('#viewTitle').textContent = { dashboard:'Übersicht', setlists:'Setlisten', library:'Alle Songs', favorites:'Favoriten', player:'Player', about:'Hinweise' }[name];
  document.body.classList.toggle('player-mode', name === 'player');
  if (name !== 'player') setPlaybackChromeHidden(false);
  requestAnimationFrame(updatePlayerLayout);
  closeDrawer();
}


function renderDashboard() {
  const list = activeSetlist();
  const current = song(state.currentId);
  if ($('#dashboardSetlistName')) $('#dashboardSetlistName').textContent = list?.name || 'Keine Setliste';
  if ($('#dashboardSetlistCount')) $('#dashboardSetlistCount').textContent = `${(list?.songs || []).filter(id=>song(id)).length} Songs`;
  if ($('#dashboardSongName')) $('#dashboardSongName').textContent = current?.title || 'Kein Song gewählt';
  if ($('#dashboardSongMeta')) $('#dashboardSongMeta').textContent = current ? ([current.artist, meta(current)].filter(Boolean).join(' · ') || 'Im Player öffnen') : 'Song öffnen';
  if ($('#dashboardLibraryCount')) $('#dashboardLibraryCount').textContent = `${state.songs.length} Songs`;
  if ($('#dashboardFavoriteCount')) $('#dashboardFavoriteCount').textContent = String(state.favorites.size);
  const host=$('#dashboardNextSongs'); if(host){
    const ids=(list?.songs||[]).filter(id=>song(id));
    const currentIndex=Math.max(0,ids.indexOf(state.currentId));
    const next=ids.slice(currentIndex, currentIndex+5);
    host.innerHTML=next.length?next.map((id,i)=>{const s=song(id);return `<li><button type="button" data-song="${esc(id)}"><span>${currentIndex+i+1}</span><strong>${esc(s.title)}</strong><small>${esc(s.artist||'')}</small></button></li>`}).join(''):'<li class="empty">Noch keine Songs in der aktiven Setliste.</li>';
    host.querySelectorAll('button[data-song]').forEach(b=>b.onclick=()=>openSong(b.dataset.song));
  }
}

function renderSetlistSelect() {
  const select = $('#setlistSelect'); select.innerHTML = '';
  state.setlists.forEach(list => { const option = document.createElement('option'); option.value = list.id; option.textContent = `${list.name} (${list.songs.length})`; option.selected = list.id === state.activeSetlistId; select.append(option); });
}

function renderSetlist() {
  const list = activeSetlist(); const host = $('#setlist'); host.innerHTML = '';
  if (!list) { $('#setlistSummary').textContent = 'Noch keine Setliste vorhanden.'; return; }
  const validIds = list.songs.filter(id => song(id));
  $('#setlistSummary').textContent = `${list.name}: ${validIds.length} Songs${list.description ? ` · ${list.description}` : ''}`;
  validIds.forEach((id, index) => {
    const item = song(id); const li = document.createElement('li'); li.className = 'song-row'; li.dataset.songId = id;
    li.innerHTML = `<button class="drag-handle" type="button" aria-label="${esc(item.title)} verschieben. Gedrückt halten und ziehen." title="Zum Verschieben ziehen">⠿</button><button class="song-main"><span class="number">${index + 1}</span><span><strong>${esc(item.title)}</strong><small>${esc(item.artist)}${meta(item) ? ` · ${esc(meta(item))}` : ''}</small></span></button><div class="row-actions"><button class="favorite" aria-label="Favorit">${state.favorites.has(id) ? '★' : '☆'}</button><button class="move-up" aria-label="Nach oben">↑</button><button class="move-down" aria-label="Nach unten">↓</button><button class="remove" aria-label="Entfernen">✕</button></div>`;
    li.querySelector('.song-main').onclick = () => openSong(id); li.querySelector('.favorite').onclick = () => toggleFavorite(id);
    li.querySelector('.move-up').onclick = () => moveSong(index, -1); li.querySelector('.move-down').onclick = () => moveSong(index, 1);
    li.querySelector('.remove').onclick = () => { const pos = list.songs.indexOf(id); if (pos >= 0) list.songs.splice(pos, 1); saveSetlists(); renderAll(); };
    bindSetlistDrag(li, li.querySelector('.drag-handle'));
    host.append(li);
  });
}

function moveSong(index, delta) { const list = activeSetlist(); const target = index + delta; if (!list || target < 0 || target >= list.songs.length) return; [list.songs[index], list.songs[target]] = [list.songs[target], list.songs[index]]; saveSetlists(); renderAll(); }

function reorderSetlistSong(sourceId, targetId, placeAfter = false) {
  const list = activeSetlist();
  if (!list || !sourceId || !targetId || sourceId === targetId) return false;
  const sourceIndex = list.songs.indexOf(sourceId);
  const targetIndexBeforeRemoval = list.songs.indexOf(targetId);
  if (sourceIndex < 0 || targetIndexBeforeRemoval < 0) return false;
  list.songs.splice(sourceIndex, 1);
  let targetIndex = list.songs.indexOf(targetId);
  if (targetIndex < 0) targetIndex = list.songs.length;
  list.songs.splice(targetIndex + (placeAfter ? 1 : 0), 0, sourceId);
  saveSetlists();
  return true;
}

function bindSetlistDrag(row, handle) {
  if (!row || !handle || !window.PointerEvent) return;
  let dragging = false;
  let pointerId = null;
  let targetRow = null;
  let placeAfter = false;
  let ghost = null;

  const clearTarget = () => {
    $$('.song-row.drag-target-before,.song-row.drag-target-after').forEach(el => el.classList.remove('drag-target-before','drag-target-after'));
    targetRow = null;
  };

  const cleanup = () => {
    clearTarget();
    row.classList.remove('dragging');
    ghost?.remove(); ghost = null;
    dragging = false; pointerId = null;
    document.body.classList.remove('setlist-dragging');
  };

  handle.addEventListener('pointerdown', event => {
    if (event.button !== undefined && event.button !== 0) return;
    pointerId = event.pointerId;
    dragging = true;
    handle.setPointerCapture?.(pointerId);
    row.classList.add('dragging');
    document.body.classList.add('setlist-dragging');
    const rect = row.getBoundingClientRect();
    ghost = row.cloneNode(true); ghost.className = 'song-row drag-ghost';
    ghost.style.width = `${rect.width}px`; ghost.style.left = `${rect.left}px`; ghost.style.top = `${rect.top}px`;
    document.body.append(ghost);
    event.preventDefault();
  });

  handle.addEventListener('pointermove', event => {
    if (!dragging || event.pointerId !== pointerId) return;
    if (ghost) ghost.style.transform = `translateY(${event.clientY - row.getBoundingClientRect().top - row.getBoundingClientRect().height / 2}px)`;
    clearTarget();
    const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest('.song-row');
    if (!hit || hit === row || !hit.dataset.songId) return;
    const rect = hit.getBoundingClientRect();
    placeAfter = event.clientY > rect.top + rect.height / 2;
    targetRow = hit;
    hit.classList.add(placeAfter ? 'drag-target-after' : 'drag-target-before');
  });

  const finish = event => {
    if (!dragging || (event.pointerId !== undefined && pointerId !== null && event.pointerId !== pointerId)) return;
    const sourceId = row.dataset.songId;
    const targetId = targetRow?.dataset.songId;
    const after = placeAfter;
    cleanup();
    if (sourceId && targetId && reorderSetlistSong(sourceId, targetId, after)) renderAll();
  };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', cleanup);
}

function songCard(item) {
  const card = document.createElement('article'); card.className = 'card'; const inList = activeSetlist()?.songs.includes(item.id);
  card.innerHTML = `<div class="card-title"><div><h3>${esc(item.title)}</h3><p>${esc(item.artist)}</p></div><button class="star" aria-label="Favorit">${state.favorites.has(item.id) ? '★' : '☆'}</button></div><small>${esc([item.genre, meta(item)].filter(Boolean).join(' · '))}</small><div class="card-actions"><button class="primary open">Öffnen</button><button class="add">${inList ? '✓ In Setliste' : '+ Setliste'}</button></div>`;
  card.querySelector('.open').onclick = () => openSong(item.id); card.querySelector('.star').onclick = () => toggleFavorite(item.id);
  card.querySelector('.add').onclick = () => addToSetlist(item.id); return card;
}

function filteredSongs(query, filter) {
  let items = state.songs; const q = query.trim().toLowerCase();
  if (filter === 'setlist') { const ids = new Set(activeSetlist()?.songs || []); items = items.filter(item => ids.has(item.id)); }
  if (filter === 'public-domain') items = items.filter(isPublicDomain);
  if (filter === 'favorites') items = items.filter(item => state.favorites.has(item.id));
  if (filter?.startsWith('lib:')) { const libId = filter.slice(4); items = items.filter(item => item.library === libId); }
  if (q) items = items.filter(item => searchable(item).includes(q));
  return [...items].sort((a, b) => a.title.localeCompare(b.title, 'de'));
}

function renderLibrary() {
  const items = filteredSongs($('#searchInput').value || '', $('#libraryFilter').value); const host = $('#library'); host.innerHTML = '';
  $('#librarySummary').textContent = `${items.length} von ${state.songs.length} Songs angezeigt`;
  if (!items.length) host.innerHTML = '<p class="empty">Keine Songs gefunden.</p>'; else items.forEach(item => host.append(songCard(item)));
}

function renderFavorites() {
  const q = ($('#favoriteSearch').value || '').toLowerCase(); const items = state.songs.filter(item => state.favorites.has(item.id) && searchable(item).includes(q)).sort((a,b) => a.title.localeCompare(b.title, 'de'));
  $('#favoriteSummary').textContent = `${items.length} Favorit${items.length === 1 ? '' : 'en'}`; const host = $('#favorites'); host.innerHTML = '';
  if (!items.length) host.innerHTML = '<p class="empty">Noch keine Favoriten markiert.</p>'; else items.forEach(item => host.append(songCard(item)));
}

function renderPicker() {
  const q = ($('#pickerSearch').value || '').toLowerCase(); const host = $('#pickerList'); host.innerHTML = '';
  filteredSongs(q, 'all').forEach(item => { const row = document.createElement('div'); row.className = 'picker-item'; const exists = activeSetlist()?.songs.includes(item.id); row.innerHTML = `<div><strong>${esc(item.title)}</strong><small>${esc(item.artist)}</small></div><button type="button">${exists ? '✓' : 'Hinzufügen'}</button>`; row.querySelector('button').disabled = exists; row.querySelector('button').onclick = () => { addToSetlist(item.id); renderPicker(); }; host.append(row); });
}

function addToSetlist(id) { const list = activeSetlist(); if (!list) return; if (!list.songs.includes(id)) { list.songs.push(id); saveSetlists(); renderAll(); } }
function toggleFavorite(id) { if (!id || !song(id)) return; state.favorites.has(id) ? state.favorites.delete(id) : state.favorites.add(id); saveFavorites(); renderAll(); }
function updateFavoriteButton() { const active = state.currentId && state.favorites.has(state.currentId); $('#favoriteCurrentBtn').textContent = active ? '★ Favorit' : '☆ Favorit'; }

function createSetlist() { const name = prompt('Name der neuen Setliste:'); if (!name?.trim()) return; const id = `custom-${Date.now()}`; state.setlists.push({ id, name: name.trim(), description: 'Lokale Setliste', songs: [] }); state.activeSetlistId = id; saveSetlists(); renderAll(); }
function renameSetlist() { const list = activeSetlist(); if (!list) return; const name = prompt('Neuer Name:', list.name); if (!name?.trim()) return; list.name = name.trim(); saveSetlists(); renderAll(); }
function deleteSetlist() { const list = activeSetlist(); if (!list || state.setlists.length <= 1) { alert('Mindestens eine Setliste muss bestehen bleiben.'); return; } if (!confirm(`Setliste „${list.name}“ löschen?`)) return; state.setlists = state.setlists.filter(item => item.id !== list.id); state.activeSetlistId = state.setlists[0].id; saveSetlists(); renderAll(); }
function resetActiveSetlist() { const list = activeSetlist(); if (!list || !confirm(`„${list.name}“ zurücksetzen?`)) return; const original = state.defaultSetlists.find(item => item.id === list.id); list.songs = original ? [...original.songs] : []; saveSetlists(); renderAll(); }

async function openSong(id, changeView = true) {
  const item = song(id); if (!item) return; stopScroll(); state.currentId = id; localStorage.setItem(STORAGE.current, id);
  applySpeedForSong(item);
  applyMetronomeForSong(item);
  const semitones = Number(item.transpose || 0);
  $('#songTitle').textContent = item.title;
  $('#songMeta').textContent = [item.artist, item.genre, meta(item), semitones ? `Transponiert ${semitones > 0 ? '+' : ''}${semitones}` : ''].filter(Boolean).join(' · ');
  $('#songSheet').innerHTML = `<div class="song-render-content">${renderSong(item.content || item.lyrics || 'Noch kein Songblatt eingetragen. Tippe auf „Bearbeiten“.', semitones)}</div><svg id="annotationLayer" class="annotation-layer" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label="Gesangsmarkierungen"></svg>`;
  renderAnnotations(item.id); setupAnnotationLayer();
  renderTabs(item, semitones); renderSectionJumps();
  await renderPdf(item);
  $('#notesSheet').innerHTML = item.notes?.trim() ? `<div class="notes-content">${esc(item.notes).replace(/\n/g, '<br>')}</div>` : '<p class="empty">Für diesen Song sind noch keine Notizen gespeichert.</p>';
  setPlayerPanel('lyrics');
  $('#transposeResetBtn').textContent = semitones ? `${semitones > 0 ? '+' : ''}${semitones}` : '0';
  const directRef = /^https:\/\/(?:www\.)?chordie\.com\//i.test(item?.source?.url || item?.chordieUrl || '');
  $('#songSourceStatus').textContent = directRef ? 'Chordie-Referenz gespeichert.' : 'Chordie öffnet eine Suche nach Titel und Interpret.';
  updateFavoriteButton(); scrollTo({ top: 0 }); if (changeView) switchView('player');
}

function isChordOnlySourceLine(line) {
  const cleaned = String(line).trim();
  if (!cleaned || /^\[[^\]]+\]$/.test(cleaned)) return false;
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const chordToken = /^[A-G][#b]?(?:m|maj|min|sus|dim|aug|add)?\d*(?:\/[A-G][#b]?)?$/;
  const noteToken = /^(?:\([^)]*\)|mute|hold|stop|let|ring|gesprochen|x\d+)$/i;
  return tokens.some(token => chordToken.test(token)) && tokens.every(token => chordToken.test(token) || noteToken.test(token));
}

function transposeChordTextPreserveSpacing(line, semitones = 0) {
  return esc(String(line).replace(/\b([A-G][#b]?(?:m|maj|min|sus|dim|aug|add)?\d*(?:\/[A-G][#b]?)?)(?=\s|$|\s*\()/g, chord => transposeChord(chord, semitones)));
}

function renderAlignedChordPair(chordLine, lyricLine, semitones = 0) {
  return `<div class="aligned-chord-pair"><div class="positioned-chord-line">${transposeChordTextPreserveSpacing(chordLine, semitones)}</div><div class="positioned-lyric-line">${esc(lyricLine)}</div></div>`;
}

function renderSongLine(line, semitones = 0) {
  const chordPattern = /\[([A-G][#b]?(?:m|maj|min|sus|dim|aug|add)?\d*(?:\/[A-G][#b]?)?)\]/g;
  const matches = [...String(line).matchAll(chordPattern)];
  if (!matches.length) return `<div class="lyric-line">${esc(line)}</div>`;
  const withoutChords = String(line).replace(chordPattern, '').trim();
  if (!withoutChords) {
    const chords = matches.map(match => `<span class="chord">${esc(transposeChord(match[1], semitones))}</span>`).join(' ');
    return `<div class="chord-only-line">${chords}</div>`;
  }
  const units = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index > cursor) units.push({ text: line.slice(cursor, match.index), chord: '' });
    const nextStart = match.index + match[0].length;
    units.push({ text: '', chord: transposeChord(match[1], semitones), chordAt: nextStart });
    cursor = nextStart;
  }
  if (cursor < line.length) units.push({ text: line.slice(cursor), chord: '' });

  // Convert markers into segments where the chord is anchored directly above the
  // first lyric characters following its [Chord] marker.
  const segments = [];
  let pendingChord = '';
  for (const unit of units) {
    if (unit.chord) { pendingChord = unit.chord; continue; }
    if (!unit.text) continue;
    const words = unit.text.match(/^\s+|\S+\s*/g) || [unit.text];
    words.forEach((word, index) => {
      segments.push({ chord: index === 0 ? pendingChord : '', text: word });
      if (index === 0) pendingChord = '';
    });
  }
  if (pendingChord) segments.push({ chord: pendingChord, text: ' ' });
  return `<div class="chord-lyric-line">${segments.map(part => `<span class="chord-lyric-segment"><span class="chord-above">${part.chord ? esc(part.chord) : '&nbsp;'}</span><span class="lyric-below">${esc(part.text) || '&nbsp;'}</span></span>`).join('')}</div>`;
}


function stripTabBlocksFromSongText(text) {
  const lines=String(text||'').split('\n'), out=[]; let inTab=false; let autoTabRun=[];
  const isTabLine=line=>/^\s*(?:e|B|G|D|A|E)\s*\|/.test(line);
  const flushAuto=()=>{ if(autoTabRun.length){ if(autoTabRun.filter(isTabLine).length<3) out.push(...autoTabRun); autoTabRun=[]; } };
  for(const line of lines){
    if(/^\s*\{(?:sot|start_of_tab)(?::\s*[^}]*)?\}\s*$/i.test(line)){ flushAuto(); inTab=true; continue; }
    if(/^\s*\{(?:eot|end_of_tab)\}\s*$/i.test(line)){ inTab=false; continue; }
    if(inTab) continue;
    if(isTabLine(line) || (autoTabRun.length && /^\s*$/.test(line))){ autoTabRun.push(line); continue; }
    flushAuto(); out.push(line);
  }
  flushAuto();
  return out.join('\n');
}

function renderSong(text, semitones = 0) {
  const lines = stripTabBlocksFromSongText(text).split('\n');
  const output = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { output.push('<div class="blank"></div>'); continue; }
    if (/^\[.+\]$/.test(trimmed) && !/^\[[A-G][#b]?/.test(trimmed)) { output.push(`<h3 class="section-label">${esc(trimmed.slice(1, -1))}</h3>`); continue; }
    if (isChordOnlySourceLine(line) && i + 1 < lines.length && lines[i + 1].trim() && !isChordOnlySourceLine(lines[i + 1])) {
      output.push(renderAlignedChordPair(line, lines[i + 1], semitones)); i += 1; continue;
    }
    output.push(renderSongLine(line, semitones));
  }
  return output.join('');
}

async function renderPdf(item) {
  const host = $('#pdfSheet');
  const button = $('#pdfTabBtn');
  if (activePdfObjectUrl) { URL.revokeObjectURL(activePdfObjectUrl); activePdfObjectUrl = ''; }
  button.disabled = false; button.setAttribute('aria-disabled', 'false');
  if (!item?.pdfAttachment) {
    host.innerHTML = '<div class="empty pdf-empty-state"><p>Für diesen Song ist kein PDF gespeichert.</p><button id="addPdfFromPlayerBtn" type="button" class="primary">+ PDF hinzufügen</button></div>';
    $('#addPdfFromPlayerBtn').onclick = promptPdfForCurrentSong;
    return;
  }
  try {
    const blob = await getPdfBlob(item.id);
    if (!blob) throw new Error('PDF-Datei nicht mehr im lokalen Speicher gefunden');
    activePdfObjectUrl = URL.createObjectURL(blob);
    state.pdfScroll.pages = await estimatePdfPageCount(blob); state.pdfScroll.page = 1; state.pdfScroll.fallbackProgress = 0;
    host.innerHTML = `<div class="pdf-actions"><a class="pdf-open-link" href="${activePdfObjectUrl}" target="_blank" rel="noopener">📄 PDF separat öffnen</a><small>${esc(item.pdfName || 'Song-PDF')}</small></div><div class="pdf-scroll-status"><span>▶ Auto-Scroll funktioniert auch in der PDF-Ansicht.</span><strong id="pdfPageStatus">Seite 1${state.pdfScroll.pages ? ` / ${state.pdfScroll.pages}` : ''}</strong></div><div class="pdf-scroll-viewer" id="pdfScrollViewer"><iframe id="pdfFrame" class="pdf-frame" title="${esc(item.title)} PDF" src="${activePdfObjectUrl}#page=1&view=FitH"></iframe></div>`;
  } catch (error) {
    host.innerHTML = `<p class="empty">PDF konnte nicht geladen werden: ${esc(error.message)}</p>`;
  }
}



function saveAnnotations() { localStorage.setItem(STORAGE.annotations, JSON.stringify(state.annotations)); }
function currentStrokes() { return state.currentId ? (state.annotations[state.currentId] || []) : []; }
function strokePath(points) {
  if (!points?.length) return '';
  if (points.length === 1) return `M ${points[0][0]} ${points[0][1]} l .1 .1`;
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1], cur = points[i];
    const mx = (prev[0] + cur[0]) / 2, my = (prev[1] + cur[1]) / 2;
    d += ` Q ${prev[0]} ${prev[1]} ${mx} ${my}`;
  }
  const last = points[points.length - 1]; return `${d} L ${last[0]} ${last[1]}`;
}
function renderAnnotations(songId = state.currentId) {
  const layer = $('#annotationLayer'); if (!layer || !songId) return;
  layer.innerHTML = (state.annotations[songId] || []).map(stroke => `<path d="${strokePath(stroke.points)}" vector-effect="non-scaling-stroke"></path>`).join('');
  layer.classList.toggle('editing', state.annotationMode);
}
function setupAnnotationLayer() {
  const layer = $('#annotationLayer'); if (!layer || layer.dataset.bound) return; layer.dataset.bound = '1';
  const point = event => { const r = layer.getBoundingClientRect(); return [Math.max(0, Math.min(1000, (event.clientX-r.left)/r.width*1000)), Math.max(0, Math.min(1000, (event.clientY-r.top)/r.height*1000))]; };
  layer.addEventListener('pointerdown', event => { if (!state.annotationMode) return; event.preventDefault(); layer.setPointerCapture?.(event.pointerId); state.activeStroke = { points:[point(event)] }; });
  layer.addEventListener('pointermove', event => { if (!state.annotationMode || !state.activeStroke) return; event.preventDefault(); state.activeStroke.points.push(point(event)); const temp = [...currentStrokes(), state.activeStroke]; layer.innerHTML = temp.map(stroke => `<path d="${strokePath(stroke.points)}" vector-effect="non-scaling-stroke"></path>`).join(''); });
  const finish = () => { if (!state.activeStroke || !state.currentId) return; if (state.activeStroke.points.length > 1) { state.annotations[state.currentId] = [...currentStrokes(), state.activeStroke]; saveAnnotations(); } state.activeStroke = null; renderAnnotations(); };
  layer.addEventListener('pointerup', finish); layer.addEventListener('pointercancel', finish);
}
function toggleAnnotationMode() {
  state.annotationMode = !state.annotationMode; stopScroll();
  $('#annotationBtn').classList.toggle('active', state.annotationMode); $('#annotationBtn').textContent = state.annotationMode ? '✓ Markieren' : '✍ Markieren';
  renderAnnotations();
}
function clearCurrentAnnotations() {
  if (!state.currentId || !currentStrokes().length) return;
  if (!confirm('Alle Gesangsmarkierungen für diesen Song löschen?')) return;
  delete state.annotations[state.currentId]; saveAnnotations(); renderAnnotations();
}

function setPlayerPanel(name) {
  const names = ['lyrics', 'tabs', 'notes', 'pdf'];
  if (state.scrolling && !['lyrics','pdf'].includes(name)) stopScroll();
  names.forEach(panel => {
    const element = document.querySelector(`[data-panel="${panel}"]`);
    const button = $(`#${panel === 'lyrics' ? 'lyricsTabBtn' : panel === 'tabs' ? 'tabsTabBtn' : panel === 'notes' ? 'notesTabBtn' : 'pdfTabBtn'}`);
    const active = panel === name;
    if (element) { element.hidden = !active; element.classList.toggle('active', active); }
    if (button) { button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); }
  });
  requestAnimationFrame(updatePlayerLayout);
}

function activeScrollPanel() {
  const active = document.querySelector('#playerView .player-panel.active:not([hidden])');
  if (!active) return $('#songSheet');
  if (active.dataset.panel === 'pdf') return $('#pdfScrollViewer') || active;
  return active;
}

function activePanelName() {
  return document.querySelector('#playerView .player-panel.active:not([hidden])')?.dataset?.panel || 'lyrics';
}

function isCompactPlayback() {
  return window.matchMedia?.('(max-width: 700px)').matches;
}

function setTransportCollapsed(collapsed, persist = false) {
  const isCollapsed = !!collapsed;
  document.body.classList.toggle('transport-collapsed', isCollapsed);
  const full = $('#transportFull'); const mini = $('#transportMini'); const toggle = $('#transportToggleBtn');
  if (full) full.hidden = isCollapsed;
  if (mini) mini.hidden = !isCollapsed;
  if (toggle) {
    toggle.setAttribute('aria-expanded', String(!isCollapsed));
    toggle.textContent = isCollapsed ? '▴ Bedienung anzeigen' : '▾ Bedienung ausblenden';
  }
  if (persist) localStorage.setItem(STORAGE.transportCollapsed, isCollapsed ? '1' : '0');
  requestAnimationFrame(updatePlayerLayout);
}


function updatePlayerLayout() {
  const player = $('#playerView');
  if (!player || !player.classList.contains('active')) return;
  const panels = $$('#playerView .player-panel');
  if (!isCompactPlayback()) {
    panels.forEach(panel => { panel.style.removeProperty('height'); panel.style.removeProperty('max-height'); panel.style.removeProperty('min-height'); });
    return;
  }
  const active = document.querySelector('#playerView .player-panel.active:not([hidden])');
  if (!active) return;
  const topbar = document.querySelector('.topbar');
  const head = $('#playerView .player-head');
  const tabs = $('#playerView .player-tabs');
  const transport = $('#playerTransport');
  const visibleHeight = el => (!el || getComputedStyle(el).display === 'none') ? 0 : el.getBoundingClientRect().height;
  const chrome = visibleHeight(topbar) + visibleHeight(head) + visibleHeight(tabs) + visibleHeight(transport);
  const safe = 18;
  const available = Math.max(220, window.innerHeight - chrome - safe);
  active.style.height = `${available}px`;
  active.style.maxHeight = `${available}px`;
  active.style.minHeight = `${Math.min(available, 320)}px`;
}

function syncMiniPlayerButtons() {
  const mini = $('#miniStartStopBtn');
  if (mini) mini.textContent = state.scrolling ? '⏸' : '▶';
}

function setPlaybackChromeHidden(hidden) {
  const focus = !!hidden && isCompactPlayback() && state.scrolling;
  document.body.classList.toggle('playback-focus', focus);
  if (focus) setTransportCollapsed(true, false);
  else if (state.scrolling && isCompactPlayback()) setTransportCollapsed(false, false);
  requestAnimationFrame(updatePlayerLayout);
}

function handlePlayerPanelTap(event) {
  if (!state.scrolling || !isCompactPlayback() || state.annotationMode) return;
  if (event.target.closest('button,a,input,summary,details')) return;
  const enteringFocus = !document.body.classList.contains('playback-focus');
  setPlaybackChromeHidden(enteringFocus);
}

function extractTabBlocks(text) {
  const lines = String(text || '').split('\n');
  const blocks = [];
  let current = null;
  const tabLine = /^\s*(?:e|B|G|D|A|E)\s*\|/i;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const start = line.match(/^\s*\{(?:sot|start_of_tab)(?::\s*([^}]+))?\}\s*$/i);
    if (start) { current = { name: start[1]?.trim() || `Tab ${blocks.length + 1}`, lines: [] }; continue; }
    if (/^\s*\{(?:eot|end_of_tab)\}\s*$/i.test(line)) { if (current?.lines.length) blocks.push(current); current = null; continue; }
    if (current) { current.lines.push(line); continue; }
    if (tabLine.test(line)) {
      const group = [];
      let j = i;
      while (j < lines.length && (tabLine.test(lines[j]) || /^\s*$/.test(lines[j]))) { group.push(lines[j]); j += 1; }
      const clean = group.filter(Boolean);
      if (clean.length >= 3) {
        const previous = lines[i - 1]?.trim();
        blocks.push({ name: previous && previous.length < 40 && !tabLine.test(previous) ? previous : `Tab ${blocks.length + 1}`, lines: group });
        i = j - 1;
      }
    }
  }
  if (current?.lines.length) blocks.push(current);
  return blocks;
}

function renderTabs(item, semitones = 0) {
  const blocks = Array.isArray(item.tabs) && item.tabs.length
    ? item.tabs.map((block, index) => ({ name: block.name || `Tab ${index + 1}`, lines: String(block.content || '').split('\n') }))
    : extractTabBlocks(item.content || item.lyrics || '');
  const host = $('#tabSheet');
  if (!blocks.length) {
    host.innerHTML = '<div class="empty"><p>Für diesen Song sind noch keine Tabs gespeichert.</p><p>Im Editor kannst du <code>{sot: Intro}</code> … <code>{eot}</code> verwenden.</p></div>';
    return;
  }
  host.innerHTML = `<div class="tab-view-toolbar"><strong>🎸 Tabs</strong><span>Seitlich wischen zum Lesen</span><div><button type="button" id="tabFontDown" aria-label="Tab-Schrift kleiner">A−</button><button type="button" id="tabFontUp" aria-label="Tab-Schrift größer">A+</button></div></div>` +
    blocks.map((block, index) => `<details class="tab-block" ${index === 0 ? 'open' : ''}><summary>${esc(block.name)}</summary><div class="tab-scroll" tabindex="0" aria-label="${esc(block.name)} Tabulatur – horizontal scrollbar"><pre>${esc(block.lines.join('\n'))}</pre></div></details>`).join('');
  const change = delta => {
    const current = Number(getComputedStyle(host).getPropertyValue('--tab-font').replace('px','')) || 14;
    host.style.setProperty('--tab-font', `${Math.max(10,Math.min(22,current+delta))}px`);
  };
  $('#tabFontDown').onclick=()=>change(-1); $('#tabFontUp').onclick=()=>change(1);
}

function footswitchLabel(code) {
  return ({ Space:'Leertaste', ArrowRight:'Pfeil rechts', ArrowLeft:'Pfeil links', ArrowDown:'Pfeil unten', ArrowUp:'Pfeil oben', PageDown:'Bild ab', PageUp:'Bild auf', Enter:'Enter' })[code] || code || 'Nicht belegt';
}
function saveFootswitch() { localStorage.setItem(STORAGE.footswitch, JSON.stringify(state.footswitch)); updateFootswitchUI(); }
function updateFootswitchUI() { $('#footswitchPlayValue').textContent = footswitchLabel(state.footswitch.play); $('#footswitchNextValue').textContent = footswitchLabel(state.footswitch.next); $('#footswitchPrevValue').textContent = footswitchLabel(state.footswitch.prev); if($('#footActionPlay')) $('#footActionPlay').value=state.footswitch.actions?.scroll||'scroll'; if($('#footActionNext')) $('#footActionNext').value=state.footswitch.actions?.next||'next'; if($('#footActionPrev')) $('#footActionPrev').value=state.footswitch.actions?.prev||'prev'; }
function openFootswitchSettings() { state.learningFootswitch = null; updateFootswitchUI(); $('#footswitchStatus').textContent = 'Zum Testen Player öffnen und Pedal drücken.'; $('#footswitchDialog').showModal(); }
function beginFootswitchLearning(action) { state.learningFootswitch = action; $('#footswitchStatus').textContent = `Jetzt die Pedaltaste für ${action === 'play' ? 'Start / Pause' : action === 'next' ? 'Nächster Song' : 'Vorheriger Song'} drücken …`; }
function resetFootswitch() { state.footswitch = { play:'Space', next:'ArrowRight', prev:'ArrowLeft' }; saveFootswitch(); $('#footswitchStatus').textContent = 'Standardbelegung wiederhergestellt.'; }
function handleFootswitchKey(event) {
  if (state.learningFootswitch) return;
  if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return;
  const map = [['play','scroll'],['next','next'],['prev','prev']];
  const found = map.find(([slot]) => state.footswitch[slot] === event.code);
  if (!found) return;
  event.preventDefault();
  runFootAction(state.footswitch.actions?.[found[0]] || found[1]);
}

function changeTranspose(delta) {
  const item = song(state.currentId); if (!item) return;
  const current = Number(item.transpose || 0);
  state.overrides[item.id] = { ...(state.overrides[item.id] || {}), transpose: Math.max(-11, Math.min(11, current + delta)) };
  saveOverrides(); renderAll(); openSong(item.id, false);
}
function resetTranspose() {
  const item = song(state.currentId); if (!item) return;
  state.overrides[item.id] = { ...(state.overrides[item.id] || {}), transpose: 0 };
  saveOverrides(); renderAll(); openSong(item.id, false);
}
function openCurrentSongOnChordie() {
  const item = song(state.currentId); if (!item) return;
  window.open(songChordieUrl(item), '_blank', 'noopener,noreferrer');
}

function stepSong(delta) { const order = activeSetlist()?.songs.filter(id => song(id)) || []; const fallback = state.songs.map(item => item.id); const ids = order.includes(state.currentId) ? order : fallback; if (!ids.length) return; let index = ids.indexOf(state.currentId); if (index < 0) index = 0; openSong(ids[(index + delta + ids.length) % ids.length]); }


function insertEditorText(text) {
  const field=$('#editContent'); if(!field) return;
  const start=field.selectionStart ?? field.value.length, end=field.selectionEnd ?? start;
  field.setRangeText(text,start,end,'end'); field.focus();
}

function openEditor() { const item = song(state.currentId); if (!item) return; $('#editTitle').value = item.title || ''; $('#editArtist').value = item.artist || ''; $('#editChordieUrl').value = item.source?.url || item.chordieUrl || ''; $('#editBpm').value = item.bpm || ''; $('#editCapo').value = item.capo ?? ''; $('#editSinger').value = item.singer || ''; $('#editNotes').value = item.notes || ''; $('#editContent').value = item.content || item.lyrics || ''; updateEditorPdfStatus(item); $('#songEditor').showModal(); }

function updateEditorPdfStatus(item = song(state.currentId)) {
  const status = $('#editPdfStatus'), remove = $('#removePdfBtn'), attach = $('#attachPdfBtn');
  if (!status || !remove || !attach) return;
  const hasPdf = !!item?.pdfAttachment;
  status.textContent = hasPdf ? `Gespeichert: ${item.pdfName || 'Song-PDF'}` : 'Kein PDF hinterlegt.';
  remove.disabled = !hasPdf;
  attach.textContent = hasPdf ? 'PDF ersetzen' : '+ PDF hinzufügen';
}

function promptPdfForCurrentSong() {
  if (!state.currentId || !song(state.currentId)) { alert('Bitte zuerst einen Song öffnen.'); return; }
  const input = $('#attachPdfInput');
  if (!input) return;
  input.value = '';
  input.click();
}

async function handlePdfAttachmentSelection(event) {
  const file = event.target.files?.[0];
  const id = state.currentId;
  if (!file || !id) return;
  if (!(file.type === 'application/pdf' || /\.pdf$/i.test(file.name))) { alert('Bitte eine PDF-Datei auswählen.'); event.target.value = ''; return; }
  try {
    await savePdfBlob(id, file);
    state.overrides[id] = { ...(state.overrides[id] || {}), pdfAttachment: true, pdfName: file.name };
    saveOverrides();
    const updated = song(id);
    updateEditorPdfStatus(updated);
    await renderPdf(updated);
    $('#pdfTabBtn').disabled = false;
    if (!$('#songEditor').open) setPlayerPanel('pdf');
  } catch (error) {
    alert(`PDF konnte nicht gespeichert werden: ${error.message}`);
  } finally {
    event.target.value = '';
  }
}

async function removePdfFromCurrentSong() {
  const id = state.currentId, item = song(id);
  if (!id || !item?.pdfAttachment) return;
  if (!confirm(`PDF „${item.pdfName || 'Song-PDF'}“ von diesem Song entfernen?`)) return;
  try {
    await deletePdfBlob(id);
    state.overrides[id] = { ...(state.overrides[id] || {}), pdfAttachment: false, pdfName: undefined };
    saveOverrides();
    const updated = song(id);
    updateEditorPdfStatus(updated);
    await renderPdf(updated);
    setPlayerPanel('lyrics');
  } catch (error) {
    alert(`PDF konnte nicht entfernt werden: ${error.message}`);
  }
}

function saveEditedSong() { const id = state.currentId; if (!id) return; const current = song(id); const chordieUrl = $('#editChordieUrl').value.trim(); state.overrides[id] = { ...(state.overrides[id] || {}), title: $('#editTitle').value.trim(), artist: $('#editArtist').value.trim(), bpm: Number($('#editBpm').value) || undefined, capo: $('#editCapo').value === '' ? undefined : Number($('#editCapo').value), singer: $('#editSinger').value.trim(), notes: $('#editNotes').value.trim(), content: $('#editContent').value, source: { ...(current?.source || {}), site: chordieUrl ? 'Chordie' : current?.source?.site, url: chordieUrl || undefined } }; saveOverrides(); $('#songEditor').close(); renderAll(); openSong(id, false); }
function deleteOverride() { const id = state.currentId; if (!id || !state.overrides[id] || !confirm('Lokale Änderungen für diesen Song löschen?')) return; delete state.overrides[id]; saveOverrides(); $('#songEditor').close(); renderAll(); openSong(id, false); }

function cleanSongForShare(item) {
  if (!item) return null;
  const { library, ...copy } = item;
  if (state.annotations[item.id]?.length) copy._annotations = state.annotations[item.id];
  if (copy.pdfAttachment) { copy.pdfAttachment = false; copy.pdfMissingFromShare = true; }
  return copy;
}
async function exportActiveSetlist() {
  const list = activeSetlist(); if (!list) return;
  const packageData = { type:'aussteiger-setlist', formatVersion:1, appVersion:'9.2', exportedAt:new Date().toISOString(), setlist:{ name:list.name, description:list.description || '', songs:list.songs.map(id => cleanSongForShare(song(id))).filter(Boolean) } };
  const filename = `${slugify(list.name)}.aussteiger-setlist.json`;
  const file = new File([JSON.stringify(packageData, null, 2)], filename, { type:'application/json' });
  try {
    if (navigator.canShare?.({ files:[file] }) && navigator.share) { await navigator.share({ title:`Setliste ${list.name}`, text:`Aussteiger-Setliste: ${list.name}`, files:[file] }); return; }
  } catch (error) { if (error?.name === 'AbortError') return; console.warn(error); }
  const url = URL.createObjectURL(file); const link = document.createElement('a'); link.href=url; link.download=filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function importSharedSetlist(data, filename='Setliste') {
  const payload = data?.type === 'aussteiger-setlist' ? data.setlist : data?.setlist;
  if (!payload || !Array.isArray(payload.songs)) throw new Error('Setlisten-Datei enthält keine Songs.');
  const libraryId = `lib-shared-${Date.now().toString(36)}`;
  const importedIds = [];
  const imported = [];
  payload.songs.forEach(entry => {
    if (typeof entry === 'string') { if (song(entry)) importedIds.push(entry); return; }
    if (!entry || !entry.title) return;
    const existing = state.songs.find(item => item.id === entry.id && item.title === entry.title);
    if (existing) { importedIds.push(existing.id); return; }
    const id = uniqueSongId(entry.id ? String(entry.id) : slugify(`${entry.title}-${entry.artist || ''}`));
    const { _annotations, ...songData } = entry; imported.push({ ...songData, id, library:libraryId, pdfAttachment:false }); importedIds.push(id); if (_annotations?.length) state.annotations[id] = _annotations;
  });
  if (imported.length) { saveAnnotations(); state.libraries.push({ id:libraryId, name:`Geteilt: ${payload.name || filename}`, importedAt:new Date().toISOString(), count:imported.length }); state.importedSongs.push(...imported); saveLibraries(); }
  const baseId = `shared-${slugify(payload.name || filename)}-${Date.now().toString(36)}`;
  state.setlists.push({ id:baseId, name:payload.name || filename.replace(/\.json$/i,''), description:payload.description || 'Importierte geteilte Setliste', songs:importedIds }); state.activeSetlistId=baseId; saveSetlists(); renderLibraryFilterOptions(); renderLibrariesManager(); renderAll();
  alert(`Setliste „${payload.name || filename}“ mit ${importedIds.length} Song(s) importiert.`);
}
function importSongJsonObject(data, filename='Song') {
  const items = Array.isArray(data) ? data : [data];
  const valid = items.filter(item => item && item.title && (item.content || item.lyrics || item.pdfAttachment)); if (!valid.length) throw new Error('Kein Songformat erkannt.');
  const libraryId=`lib-import-${Date.now().toString(36)}`; const songs=valid.map(item => ({...item, id:uniqueSongId(item.id?String(item.id):slugify(`${item.title}-${item.artist||''}`)), library:libraryId, pdfAttachment:false}));
  state.libraries.push({id:libraryId,name:`Import: ${filename.replace(/\.json$/i,'')}`,importedAt:new Date().toISOString(),count:songs.length}); state.importedSongs.push(...songs); saveLibraries(); renderLibraryFilterOptions(); renderLibrariesManager(); renderAll(); alert(`${songs.length} Song(s) importiert.`);
}
async function importUniversalFile(event) {
  const file=event.target.files?.[0]; if (!file) return;
  try {
    const lower=file.name.toLowerCase();
    if (!lower.endsWith('.json')) { await importSongFiles([file]); return; }
    const data=JSON.parse(await file.text());
    if (data?.type === 'aussteiger-setlist' || (data?.setlist && Array.isArray(data.setlist.songs) && !data.overrides)) { importSharedSetlist(data,file.name); return; }
    if (data?.type === 'aussteiger-song' || data?.title || (Array.isArray(data) && data.some(item => item?.title))) { importSongJsonObject(data,file.name); return; }
    if (data?.overrides || Array.isArray(data?.setlists) || data?.version) { importBackupData(data); return; }
    throw new Error('Dateityp konnte nicht als Song, Setliste oder Backup erkannt werden.');
  } catch(error) { alert(`Import fehlgeschlagen: ${error.message}`); } finally { event.target.value=''; }
}
function importBackupData(data) {
  if (data.overrides && typeof data.overrides === 'object') state.overrides=data.overrides;
  if (data.annotations && typeof data.annotations === 'object') { state.annotations=data.annotations; saveAnnotations(); }
  if (Array.isArray(data.setlists)) state.setlists=normalizeSetlists(data.setlists); else if (Array.isArray(data.setlist)) activeSetlist().songs=data.setlist;
  if (Array.isArray(data.favorites)) state.favorites=new Set(data.favorites);
  if (data.activeSetlistId && state.setlists.some(list=>list.id===data.activeSetlistId)) state.activeSetlistId=data.activeSetlistId;
  if (data.display) localStorage.setItem(STORAGE.display,JSON.stringify(data.display));
  if (data.songSpeeds && typeof data.songSpeeds === 'object') { state.songSpeeds = data.songSpeeds; saveSongSpeeds(); } if (data.metronomeSettings && typeof data.metronomeSettings === 'object') { state.metronomeSettings = data.metronomeSettings; localStorage.setItem(STORAGE.metronome, JSON.stringify(state.metronomeSettings)); }
  saveOverrides();saveSetlists();saveFavorites();applySettings();renderAll();alert('Backup importiert.');
}

function exportData() { const data = { version: "9.6.8", annotations: state.annotations, exportedAt: new Date().toISOString(), overrides: state.overrides, setlists: state.setlists, activeSetlistId: state.activeSetlistId, favorites: [...state.favorites], display: safeParse(localStorage.getItem(STORAGE.display), {}), songSpeeds: state.songSpeeds, metronomeSettings: state.metronomeSettings, speed: state.scrollSpeed }; const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'aussteiger-bandapp-v9-6-8-backup.json'; link.click(); URL.revokeObjectURL(link.href); }
async function importData(event) { const file = event.target.files?.[0]; if (!file) return; try { const data = JSON.parse(await file.text()); if (data.overrides && typeof data.overrides === 'object') state.overrides = data.overrides; if (Array.isArray(data.setlists)) state.setlists = normalizeSetlists(data.setlists); else if (Array.isArray(data.setlist)) activeSetlist().songs = data.setlist; if (Array.isArray(data.favorites)) state.favorites = new Set(data.favorites); if (data.activeSetlistId && state.setlists.some(list => list.id === data.activeSetlistId)) state.activeSetlistId = data.activeSetlistId; if (data.display) localStorage.setItem(STORAGE.display, JSON.stringify(data.display)); if (data.songSpeeds && typeof data.songSpeeds === 'object') { state.songSpeeds = data.songSpeeds; saveSongSpeeds(); } if (data.metronomeSettings && typeof data.metronomeSettings === 'object') { state.metronomeSettings = data.metronomeSettings; localStorage.setItem(STORAGE.metronome, JSON.stringify(state.metronomeSettings)); } saveOverrides(); saveSetlists(); saveFavorites(); applySettings(); renderAll(); alert('Import erfolgreich.'); } catch (error) { alert(`Import fehlgeschlagen: ${error.message}`); } finally { event.target.value = ''; } }

async function estimatePdfPageCount(blob) {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const sample = new TextDecoder('latin1').decode(bytes);
    const matches = sample.match(/\/Type\s*\/Page\b/g);
    return Math.max(0, matches?.length || 0);
  } catch { return 0; }
}

function updatePdfPageStatus() {
  const status = $('#pdfPageStatus');
  if (status) status.textContent = `Seite ${state.pdfScroll.page}${state.pdfScroll.pages ? ` / ${state.pdfScroll.pages}` : ''}`;
}

function setPdfPage(page) {
  const frame = $('#pdfFrame'); if (!frame || !activePdfObjectUrl) return;
  const max = state.pdfScroll.pages || 100;
  state.pdfScroll.page = Math.max(1, Math.min(max, page));
  frame.src = `${activePdfObjectUrl}#page=${state.pdfScroll.page}&view=FitH`;
  updatePdfPageStatus();
}

function scrollPdfBy(distance) {
  const frame = $('#pdfFrame');
  if (!frame) return true;
  // On Safari and some Android viewers the PDF frame can be scrolled directly.
  try {
    const win = frame.contentWindow;
    const doc = win?.document;
    const root = doc?.scrollingElement || doc?.documentElement;
    if (win && root && root.scrollHeight > root.clientHeight + 2) {
      win.scrollBy(0, distance);
      return root.scrollTop + root.clientHeight >= root.scrollHeight - 3;
    }
  } catch (_) { /* Browser PDF viewer is isolated; use page-advance fallback below. */ }
  // Chrome often isolates its built-in PDF viewer. In that case advance pages
  // after roughly one visible-page worth of auto-scroll distance.
  state.pdfScroll.fallbackProgress += distance;
  const pageDistance = Math.max(520, ($('#pdfScrollViewer')?.clientHeight || 700) * 0.92);
  if (state.pdfScroll.fallbackProgress >= pageDistance) {
    state.pdfScroll.fallbackProgress = 0;
    if (state.pdfScroll.pages && state.pdfScroll.page >= state.pdfScroll.pages) return true;
    setPdfPage(state.pdfScroll.page + 1);
  }
  return false;
}

function scrollActiveToTop() {
  if (activePanelName() === 'pdf') { state.pdfScroll.fallbackProgress = 0; setPdfPage(1); try { $('#pdfFrame')?.contentWindow?.scrollTo(0, 0); } catch (_) {} return; }
  const panel = activeScrollPanel(); if (panel) panel.scrollTo({ top: 0, behavior: 'smooth' });
}

function currentMetronomeSettings(item = song(state.currentId)) {
  const saved = state.metronomeSettings[item?.id] || {};
  return { bpm: Math.max(30, Math.min(260, Number(saved.bpm || item?.bpm || 100))), meter: [3,4,6].includes(Number(saved.meter)) ? Number(saved.meter) : 4, sound: saved.sound !== false };
}
function saveMetronomeState() { localStorage.setItem(STORAGE.metronome, JSON.stringify(state.metronomeSettings)); }
function applyMetronomeForSong(item = song(state.currentId)) {
  if (!item) return; const m = currentMetronomeSettings(item);
  if ($('#metronomeBpm')) $('#metronomeBpm').value = m.bpm;
  if ($('#metronomeMeter')) $('#metronomeMeter').value = String(m.meter);
  if ($('#metronomeSound')) $('#metronomeSound').checked = m.sound;
  renderMetronomeBeats(m.meter, 0);
}
function saveCurrentMetronomeSettings() {
  const item = song(state.currentId); if (!item) return;
  const bpm = Math.max(30, Math.min(260, Number($('#metronomeBpm').value) || Number(item.bpm) || 100));
  const meter = [3,4,6].includes(Number($('#metronomeMeter').value)) ? Number($('#metronomeMeter').value) : 4;
  const sound = $('#metronomeSound').checked;
  state.metronomeSettings[item.id] = { bpm, meter, sound }; saveMetronomeState(); renderMetronomeBeats(meter, state.metronomeBeat);
  if (state.metronomeRunning) { stopMetronome(); startMetronome(); }
}
function renderMetronomeBeats(meter, active = 0) {
  const host = $('#metronomeBeatDisplay'); if (!host) return;
  host.innerHTML = Array.from({length: meter}, (_, i) => `<i class="${i === active ? 'active' : ''}"></i>`).join('');
}
function ensureMetronomeAudio() {
  if (!state.metronomeAudio) { const Ctx = window.AudioContext || window.webkitAudioContext; if (Ctx) state.metronomeAudio = new Ctx(); }
  if (state.metronomeAudio?.state === 'suspended') state.metronomeAudio.resume();
  return state.metronomeAudio;
}
function metronomeClick(accent = false) {
  const settings = currentMetronomeSettings(); if (!settings.sound) return; const ctx = ensureMetronomeAudio(); if (!ctx) return;
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.frequency.value = accent ? 1250 : 880; gain.gain.setValueAtTime(accent ? 0.16 : 0.09, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.055);
  osc.connect(gain).connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.06);
}
function metronomeTick() {
  if (!state.metronomeRunning) return; const m = currentMetronomeSettings();
  renderMetronomeBeats(m.meter, state.metronomeBeat); metronomeClick(state.metronomeBeat === 0);
  state.metronomeBeat = (state.metronomeBeat + 1) % m.meter;
  state.metronomeTimer = setTimeout(metronomeTick, 60000 / m.bpm);
}
function startMetronome() {
  if (state.metronomeRunning) return; ensureMetronomeAudio(); state.metronomeRunning = true; state.metronomeBeat = 0; metronomeTick();
  $('#metronomeStartBtn').textContent = '⏸ Metronom'; $('#miniMetronomeBtn').textContent = '⏸'; $('#miniMetronomeBtn').classList.add('primary');
}
function stopMetronome() {
  state.metronomeRunning = false; clearTimeout(state.metronomeTimer); state.metronomeTimer = null;
  $('#metronomeStartBtn').textContent = '▶ Metronom'; $('#miniMetronomeBtn').textContent = '♩'; $('#miniMetronomeBtn').classList.remove('primary'); renderMetronomeBeats(currentMetronomeSettings().meter, 0);
}
function toggleMetronome() { state.metronomeRunning ? stopMetronome() : startMetronome(); }
function tapTempo() {
  const now = performance.now(); state.tapTimes = [...state.tapTimes.filter(t => now - t < 2500), now].slice(-5);
  if (state.tapTimes.length >= 2) { const intervals = state.tapTimes.slice(1).map((t,i)=>t-state.tapTimes[i]); const avg = intervals.reduce((a,b)=>a+b,0)/intervals.length; const bpm = Math.max(30, Math.min(260, Math.round(60000/avg))); $('#metronomeBpm').value=bpm; saveCurrentMetronomeSettings(); }
}


function saveFootswitchActions(){
  state.footswitch.actions = {
    scroll: $('#footActionPlay')?.value || 'scroll',
    next: $('#footActionNext')?.value || 'next',
    prev: $('#footActionPrev')?.value || 'prev'
  };
  saveFootswitch();
}
function runFootAction(action){
  if(action==='scroll') toggleScroll();
  else if(action==='next') nextSong(1);
  else if(action==='prev') nextSong(-1);
  else if(action==='metronome') toggleMetronome();
  else if(action==='countin') startCountIn();
  else if(action==='sectionNext') jumpRelativeSection(1);
  else if(action==='sectionPrev') jumpRelativeSection(-1);
  else if(action==='pdfNext') pdfPageStep(1);
  else if(action==='pdfPrev') pdfPageStep(-1);
}
function toggleGigMode(){
  state.live.gigMode=!state.live.gigMode;
  document.body.classList.toggle('gig-mode', state.live.gigMode);
  $('#gigModeBtn').textContent=state.live.gigMode?'Gig-Modus beenden':'Gig-Modus';
  if(state.live.gigMode) switchView('player');
}
function songSections(){
  const item=song(state.currentId); if(!item) return [];
  const text=String(item.content||item.lyrics||'');
  const re=/^\s*(?:\[([^\]]+)\]|\{(?:start_of_)?(?:section|chorus|verse|bridge|solo|intro|outro)(?::\s*([^}]+))?\})\s*$/gim;
  const out=[]; let m;
  while((m=re.exec(text))) { const name=(m[1]||m[2]||'Abschnitt').trim(); if(!out.some(x=>x.name===name)) out.push({name}); }
  return out;
}
function renderSectionJumps(){
  const host=$('#sectionJumpBar'); if(!host) return; const sections=songSections();
  host.innerHTML=sections.length?sections.map((s,i)=>`<button type="button" data-section-index="${i}">${esc(s.name)}</button>`).join(''):'<span class="hint">Sprungmarken entstehen automatisch aus Abschnittsüberschriften wie [Intro], [Refrain], [Solo] oder [Outro].</span>';
  host.querySelectorAll('button').forEach(b=>b.onclick=()=>jumpToSection(Number(b.dataset.sectionIndex)));
}
function jumpToSection(index){
  const sections=songSections(); if(!sections.length) return; index=Math.max(0,Math.min(sections.length-1,index)); state.live.sectionIndex=index;
  const labels=[...$('#songSheet').querySelectorAll('.section-label,h2,h3,strong')]; const name=sections[index].name.toLowerCase();
  const el=labels.find(x=>x.textContent.trim().toLowerCase().includes(name));
  if(el) el.scrollIntoView({block:'start',behavior:'smooth'}); else $('#songSheet').scrollTop=($('#songSheet').scrollHeight/sections.length)*index;
  renderSectionJumps();
}
function jumpRelativeSection(delta){ const s=songSections(); if(s.length) jumpToSection((state.live.sectionIndex+delta+s.length)%s.length); }
function pdfPageStep(delta){
  if(activePanelName()!=='pdf') setPlayerPanel('pdf');
  state.pdfScroll.page=Math.max(1,Math.min(state.pdfScroll.pages||999,state.pdfScroll.page+delta));
  const frame=$('#pdfFrame'); if(frame?.src){ const base=frame.src.split('#')[0]; frame.src=`${base}#page=${state.pdfScroll.page}&view=FitH`; }
}
function cancelCountIn(){
  clearTimeout(state.live.countInTimer); state.live.countInTimer=null; state.live.countInBeat=0;
  const o=$('#countInStatus'); if(o) o.textContent='';
}
function startCountIn(){
  cancelCountIn(); ensureMetronomeAudio();
  const m=currentMetronomeSettings(), bars=Number($('#countInBars')?.value||2), total=bars*m.meter;
  let beat=0; const status=$('#countInStatus');
  const tick=()=>{
    const inBar=beat%m.meter; if(status) status.textContent=`${Math.floor(beat/m.meter)+1}/${bars} · ${inBar+1}`;
    metronomeClick(inBar===0); renderMetronomeBeats(m.meter,inBar); beat++;
    if(beat<total) state.live.countInTimer=setTimeout(tick,60000/m.bpm);
    else state.live.countInTimer=setTimeout(()=>{ cancelCountIn(); if($('#countInAutoScroll')?.checked&&!state.scrolling) startScroll(); },60000/m.bpm);
  }; tick();
}

function toggleScroll() { state.scrolling ? stopScroll() : startScroll(); }
function startScroll() {
  const name = activePanelName();
  if (!['lyrics','pdf'].includes(name)) setPlayerPanel('lyrics');
  const panel = activeScrollPanel();
  if (!panel) return;
  state.scrolling = true;
  state.lastTs = performance.now();
  $('#startStopBtn').textContent = name === 'pdf' ? '⏸ PDF Pause' : '⏸ Pause';
  syncMiniPlayerButtons();
  setPlaybackChromeHidden(true);
  requestAnimationFrame(scrollFrame);
}
function stopScroll() {
  state.scrolling = false;
  $('#startStopBtn').textContent = '▶ Start';
  syncMiniPlayerButtons();
  setPlaybackChromeHidden(false);
  setTransportCollapsed(localStorage.getItem(STORAGE.transportCollapsed) === '1', false);
}
function scrollFrame(timestamp) {
  if (!state.scrolling) return;
  const delta = Math.min((timestamp - state.lastTs) / 1000, 0.1);
  state.lastTs = timestamp;
  const distance = state.scrollSpeed * delta;
  if (activePanelName() === 'pdf') {
    if (scrollPdfBy(distance)) { stopScroll(); return; }
  } else {
    const panel = activeScrollPanel();
    if (!panel) { stopScroll(); return; }
    panel.scrollTop += distance;
    if (panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 3) { stopScroll(); return; }
  }
  requestAnimationFrame(scrollFrame);
}

function applySettings() {
  const settings = safeParse(localStorage.getItem(STORAGE.display), {});
  const font = Number(settings.font) || 26;
  const line = Number(settings.line) || 160;
  const uiFont = Number(settings.uiFont) || 100;
  const chord = /^#[0-9a-f]{6}$/i.test(settings.chord || '') ? settings.chord : '#2563eb';
  document.documentElement.classList.toggle('dark', !!settings.dark);
  document.documentElement.classList.toggle('contrast', !!settings.contrast);
  document.documentElement.style.setProperty('--sheet-font', `${font}px`);
  document.documentElement.style.setProperty('--ui-scale', String(uiFont / 100));
  document.documentElement.style.setProperty('--sheet-line', String(line / 100));
  document.documentElement.style.setProperty('--chord', settings.contrast ? '#ffeb00' : chord);
  $('#darkToggle').checked = !!settings.dark;
  $('#contrastToggle').checked = !!settings.contrast;
  $('#uiFontRange').value = uiFont;
  $('#fontRange').value = font;
  $('#lineRange').value = line;
  $('#chordColor').value = chord;
  $('#uiFontValue').textContent = `${uiFont} %`;
  $('#fontValue').textContent = `${font} px`;
  $('#lineValue').textContent = String(line / 100);
  $('#chordColorValue').textContent = chord.toUpperCase();
  applySpeedForSong();
  const themeColor = settings.contrast ? '#000000' : settings.dark ? '#121212' : '#f3f4f6';
  $('#themeColorMeta')?.setAttribute('content', themeColor);
}
function saveSettings() {
  const settings = {
    dark: $('#darkToggle').checked,
    contrast: $('#contrastToggle').checked,
    uiFont: Number($('#uiFontRange').value),
    font: Number($('#fontRange').value),
    line: Number($('#lineRange').value),
    chord: $('#chordColor').value
  };
  localStorage.setItem(STORAGE.display, JSON.stringify(settings));
  applySettings();
}
function resetDisplaySettings() {
  localStorage.setItem(STORAGE.display, JSON.stringify({ dark: false, contrast: false, uiFont: 100, font: 26, line: 160, chord: '#2563eb' }));
  applySettings();
}



document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (document.body.classList.contains('playback-focus') || state.live.gigMode) {
    document.body.classList.remove('playback-focus');
    if (state.live.gigMode) toggleGigMode();
    setTransportCollapsed(false, false);
    updatePlayerLayout();
  }
});

const TUTORIAL_KEY = 'band-v966-tutorial-seen';
const TUTORIAL_STEPS = [
  { view:'dashboard', target:'#dashboardView', icon:'🏠', title:'Übersicht', text:'Die App startet jetzt auf dem Dashboard. Hier siehst du aktive Setliste, letzten Song, Bibliothek, Favoriten und die nächsten Songs.' },
  { view:'dashboard', target:'#dashboardGigBtn', icon:'🎤', title:'Gig direkt starten', text:'Mit Gig starten wechselst du unmittelbar in den reduzierten Live-Player.' },
  { view:'setlists', target:'#setlistSelect', icon:'📋', title:'Setlisten', text:'Wähle deine aktive Setliste und verschiebe Songs am Griff ⠿ per Drag & Drop.' },
  { view:'setlists', target:'#exportSetlistBtn', icon:'↗', title:'Setliste teilen', text:'Teile eine Setliste als Datei. Beim Import erkennt die App automatisch Song, Setliste oder Backup.' },
  { view:'library', target:'#searchInput', icon:'🔎', title:'Bibliothek', text:'Hier suchst du nach Titel, Interpret, Genre oder Tags und öffnest einen Song.' },
  { view:'player', target:'.player-tabs', icon:'🎤', title:'Player-Ansichten', text:'Song, Tabs, Notizen und PDF haben getrennte Seiten. Das verhindert, dass breite Tabs den Liedtext auf dem Handy zerstören.' },
  { view:'player', panel:'tabs', target:'#tabSheet', icon:'🎸', title:'Optimierte Tabs', text:'Tabs werden in einer eigenen Monospace-Ansicht dargestellt. Du kannst horizontal wischen und die Tab-Schrift mit A−/A+ anpassen.' },
  { view:'player', panel:'lyrics', target:'#editSongBtn', icon:'✎', title:'Song bearbeiten', text:'Im Editor kannst du Lyrics, Akkorde, Tabs, Notizen und PDF eines bestehenden Songs bearbeiten.' },
  { view:'player', panel:'lyrics', target:'.song-tools', icon:'♯', title:'Akkorde & Markierungen', text:'Transponiere Akkorde oder zeichne Gesangsphrasierungen direkt auf das Songblatt.' },
  { view:'player', target:'#liveTools', icon:'🎤', title:'Live Performance', text:'Gig-Modus, Count-in und Sprungmarken bündeln die wichtigsten Bühnenfunktionen.' },
  { view:'player', target:'#countInControls', icon:'⏱', title:'Count-in', text:'Einzählen mit 1, 2 oder 4 Takten und optional danach automatisch Autoscroll starten.' },
  { view:'player', target:'#sectionJumpBar', icon:'📍', title:'Sprungmarken', text:'Intro, Refrain, Solo und Outro können als schnelle Sprungziele erscheinen.' },
  { view:'player', target:'.metronome', icon:'♩', title:'Metronom', text:'Metronom, Tap Tempo, Taktart und BPM funktionieren unabhängig vom Autoscroll.' },
  { view:'player', target:'#startStopBtn', icon:'▶️', title:'Autoscroll', text:'Die Scrollgeschwindigkeit wird pro Song gespeichert und aus BPM plus Zeilenabstand vorbelegt.' },
  { view:'player', panel:'pdf', target:'#pdfSheet', icon:'📄', title:'PDF', text:'PDFs können an bestehende Songs gehängt und ebenfalls automatisch gescrollt werden.' },
  { view:'player', target:'#footswitchSettingsBtn', action:'footswitch', icon:'🦶', title:'Fußschalter', text:'Pedaltasten können Aktionen wie Play, Songwechsel, Metronom, Count-in, Abschnitt oder PDF-Seite auslösen.' }
];
let tutorialIndex = 0;
function startTutorial(force=false){
  if(!force && localStorage.getItem(TUTORIAL_KEY)) return;
  tutorialIndex=0; $('#tutorialOverlay').hidden=false; document.body.classList.remove('playback-focus'); showTutorialStep();
}
function tutorialTarget(step){ return step.target ? document.querySelector(step.target) : null; }
function showTutorialStep(){
  const step=TUTORIAL_STEPS[tutorialIndex]; if(!step) return finishTutorial();
  document.querySelectorAll('dialog[open]').forEach(d=>d.close());
  if(step.view) switchView(step.view);
  if(step.panel) setPlayerPanel(step.panel);
  if(step.action==='footswitch') { openFootswitchSettings(); }
  $$('.tutorial-highlight').forEach(el=>el.classList.remove('tutorial-highlight'));
  $('#tutorialIcon').textContent=step.icon; $('#tutorialTitle').textContent=step.title; $('#tutorialText').textContent=step.text;
  $('#tutorialStepLabel').textContent=`${tutorialIndex+1} / ${TUTORIAL_STEPS.length}`;
  $('#tutorialBackBtn').disabled=tutorialIndex===0; $('#tutorialNextBtn').textContent=tutorialIndex===TUTORIAL_STEPS.length-1?'Fertig':'Weiter';
  requestAnimationFrame(()=>{
    const el=tutorialTarget(step), spot=$('#tutorialSpotlight'), overlay=$('#tutorialOverlay'), card=$('#tutorialCard');
    overlay.classList.toggle('has-target', !!el);
    card.classList.remove('tutorial-card-top');
    if(!el){ spot.style.cssText='opacity:0;left:50%;top:20%;width:0;height:0'; return; }
    el.classList.add('tutorial-highlight'); el.scrollIntoView({block:'center',behavior:'smooth'});
    setTimeout(()=>{
      const r=el.getBoundingClientRect(), pad=8;
      const left=Math.max(6,r.left-pad), top=Math.max(6,r.top-pad);
      const right=Math.min(innerWidth-6,r.right+pad), bottom=Math.min(innerHeight-6,r.bottom+pad);
      spot.style.opacity='1';
      spot.style.left=`${left}px`; spot.style.top=`${top}px`;
      spot.style.width=`${Math.max(0,right-left)}px`; spot.style.height=`${Math.max(0,bottom-top)}px`;
      card.classList.toggle('tutorial-card-top', r.top > innerHeight * .54);
    },180);
  });
}
function finishTutorial(){ localStorage.setItem(TUTORIAL_KEY,'1'); const overlay=$('#tutorialOverlay'); overlay.hidden=true; overlay.classList.remove('has-target'); $('#tutorialCard')?.classList.remove('tutorial-card-top'); $$('.tutorial-highlight').forEach(el=>el.classList.remove('tutorial-highlight')); switchView('setlists'); }
window.addEventListener('resize',()=>{ updatePlayerLayout(); if(!$('#tutorialOverlay')?.hidden) showTutorialStep(); });
window.addEventListener('orientationchange',()=>setTimeout(updatePlayerLayout,120));
document.addEventListener('click',e=>{ if(e.target?.id==='tutorialNextBtn'){ tutorialIndex++; showTutorialStep(); } if(e.target?.id==='tutorialBackBtn'){ tutorialIndex=Math.max(0,tutorialIndex-1); showTutorialStep(); } if(e.target?.id==='tutorialSkipBtn') finishTutorial(); });
setTimeout(()=>startTutorial(false),2600);

init();
