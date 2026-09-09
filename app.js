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
  live: 'band-v966-live',
  newSongs: 'band-v9610-new-songs',
  pdfZoom: 'band-v970-pdf-zoom'
};

const VIEW_LABELS = {
  dashboard: 'Übersicht', setlists: 'Setlisten', library: 'Alle Songs', favorites: 'Favoriten',
  metronome: 'Metronom', tuner: 'Stimmgerät', import: 'Songs importieren', player: 'Player', about: 'Hinweise'
};
const VIEW_PARENTS = {
  dashboard: '', setlists: 'dashboard', library: 'dashboard', favorites: 'dashboard',
  metronome: 'dashboard', tuner: 'dashboard', import: 'dashboard', about: 'dashboard', player: 'setlists'
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
  pdfPanel: { songId: null, loaded: false, loading: false },
  pdfView: { doc: null, observer: null, tasks: [], sizes: [], zoom: 1 },
  nav: { current: 'dashboard', stack: [], playerOrigin: 'setlists', guarded: false },
  picker: { filter: 'all', added: 0 },
  lastImport: null,
  live: { gigMode:false, countInTimer:null, countInBeat:0, sectionIndex:0 },
  pendingSetlistSongId: null,
  newSongIds: new Set(),
  tuner: { stream:null, ctx:null, analyser:null, raf:null, buffer:null }
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
  state.newSongIds = new Set(safeParse(localStorage.getItem(STORAGE.newSongs), []));
  const storedZoom = Number(localStorage.getItem(STORAGE.pdfZoom));
  state.pdfView.zoom = storedZoom >= 0.75 && storedZoom <= 3 ? storedZoom : 1;
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
const PDFJS_BASE = './assets/vendor/pdfjs/';
let activePdfObjectUrl = '';
let pdfEnginePromise = null;

function isAppleTouchDevice() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
}

function vendorUrl(file) {
  return new URL(`${PDFJS_BASE}${file}`, document.baseURI).href;
}

// pdf.js wird erst geladen, wenn wirklich ein PDF angezeigt werden soll.
function loadPdfEngine() {
  if (!pdfEnginePromise) {
    pdfEnginePromise = import(vendorUrl('pdf.min.mjs'))
      .then(module => {
        const lib = module?.getDocument ? module : module?.default;
        if (!lib?.getDocument) throw new Error('PDF-Anzeige konnte nicht initialisiert werden.');
        try { lib.GlobalWorkerOptions.workerSrc = vendorUrl('pdf.worker.min.mjs'); }
        catch (error) { console.warn('PDF-Worker nicht setzbar, Hauptthread wird genutzt', error); }
        return lib;
      })
      .catch(error => { pdfEnginePromise = null; throw error; });
  }
  return pdfEnginePromise;
}

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

async function writePdfRecord(songId, record) {
  const db = await openPdfDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(PDF_STORE, 'readwrite');
    tx.objectStore(PDF_STORE).put(record, songId);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
  db.close();
}

// PDFs werden als Bytes gespeichert, nicht als File-Referenz.
// Auf iOS/iPadOS werden gespeicherte File-Objekte nach einem Neustart teils ungültig.
async function savePdfBlob(songId, file) {
  const buffer = await file.arrayBuffer();
  if (!buffer?.byteLength) throw new Error('Die Datei ist leer oder konnte nicht gelesen werden.');
  const record = {
    format: 'bytes-v1', data: buffer,
    type: file.type || 'application/pdf',
    name: file.name || 'Song.pdf',
    size: buffer.byteLength,
    savedAt: new Date().toISOString()
  };
  await writePdfRecord(songId, record);
  return record;
}

async function readPdfEntry(songId) {
  const db = await openPdfDb();
  const value = await new Promise((resolve, reject) => {
    const tx = db.transaction(PDF_STORE, 'readonly');
    const request = tx.objectStore(PDF_STORE).get(songId);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
  db.close(); return value;
}

function toArrayBuffer(data) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.byteLength !== 'number') return null;
  // TypedArray / DataView
  if (data.buffer && typeof data.byteOffset === 'number') {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  // ArrayBuffer
  if (typeof data.slice === 'function') return data;
  return null;
}

function isBlobLike(value) {
  return !!value && typeof value === 'object' && typeof value.arrayBuffer === 'function' && typeof value.size === 'number';
}

async function getPdfRecord(songId) {
  const raw = await readPdfEntry(songId);
  if (!raw) return null;
  if (isBlobLike(raw)) {
    // Altbestand: Blob/File direkt gespeichert -> einmalig in Bytes umschreiben.
    const buffer = await raw.arrayBuffer();
    const record = {
      format: 'bytes-v1', data: buffer,
      type: raw.type || 'application/pdf',
      name: raw.name || 'Song.pdf',
      size: buffer.byteLength,
      savedAt: new Date().toISOString()
    };
    try { await writePdfRecord(songId, record); } catch (error) { console.warn('PDF-Umwandlung fehlgeschlagen', error); }
    return record;
  }
  const data = toArrayBuffer(raw.data);
  if (!data?.byteLength) return null;
  return { ...raw, data };
}

async function getPdfBlob(songId) {
  const record = await getPdfRecord(songId);
  return record ? new Blob([record.data], { type: record.type || 'application/pdf' }) : null;
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
  const guessed = inferFilenameMetadata(filename);
  const fallbackName = guessed.title;
  if (!title) title = fallbackName;
  if (!artist) artist = guessed.artist;
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
  openDialog('#chordieImportDialog');
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
  const guessed = inferFilenameMetadata(filename);
  const fallbackName = guessed.title;
  if (!title) title = guessed.title;
  if (!artist) artist = guessed.artist;
  return { title: title || fallbackName, artist, key: key || undefined, capo: capo ? Number(capo) : undefined, content: content.join('\n').trim() };
}

async function importSongFiles(fileList, options={}) {
  const files=[...fileList]; if(!files.length) return [];
  let libraryName=options.libraryName;
  if(!libraryName){
    const fallback=files.length>1 ? `Import ${new Date().toLocaleDateString('de')}` : cleanImportFilename(files[0].name);
    libraryName=prompt('Name für diese Songbibliothek:',fallback);
    if(!libraryName?.trim()) return [];
  }
  const libraryId=`lib-${slugify(libraryName)}-${Date.now().toString(36)}`;
  const newSongs=[], failures=[], batchIds=new Set();
  const batchUniqueId=base=>{
    let id=uniqueSongId(base), n=2;
    while(batchIds.has(id)){ id=`${base}-${n++}`; }
    batchIds.add(id); return id;
  };
  for(const file of files){
    try{
      const lower=file.name.toLowerCase();
      if(lower.endsWith('.pdf')||file.type==='application/pdf'){
        const guessed=inferFilenameMetadata(file.name);
        const id=batchUniqueId(slugify(`${guessed.title}-${guessed.artist||'pdf'}`));
        await savePdfBlob(id,file);
        newSongs.push(enrichImportedSong({id,library:libraryId,title:guessed.title,artist:guessed.artist,tags:[],pdfAttachment:true,pdfOnly:true,pdfName:file.name,content:'[PDF-Liedblatt]\nDieser Song öffnet direkt das importierte Liedblatt.'},file.name,'PDF-Import'));
        continue;
      }
      const text=await file.text();
      if(lower.endsWith('.json')){
        const parsed=JSON.parse(text);
        const items=Array.isArray(parsed)?parsed:Array.isArray(parsed.songs)?parsed.songs:[parsed];
        let validInFile=0;
        items.forEach((item,index)=>{
          if(!item||(!item.title&&!item.content&&!item.lyrics)) return;
          const guessed=inferFilenameMetadata(file.name);
          const title=item.title|| (items.length===1?guessed.title:`${guessed.title} ${index+1}`);
          const id=batchUniqueId(item.id?String(item.id):slugify(`${title}-${item.artist||guessed.artist||''}`));
          newSongs.push(enrichImportedSong({
            id,library:libraryId,title:String(title),artist:String(item.artist||guessed.artist||''),
            genre:item.genre||'',tags:Array.isArray(item.tags)?item.tags:[],
            key:item.key||undefined,bpm:item.bpm?Number(item.bpm):undefined,
            capo:item.capo!==undefined&&item.capo!==''?Number(item.capo):undefined,
            singer:item.singer||'',notes:item.notes||'',content:String(item.content||item.lyrics||'')
          },file.name,'JSON-Import')); validInFile++;
        });
        if(!validInFile) throw new Error('Keine Songs im JSON erkannt');
      }else if(lower.endsWith('.md')||lower.endsWith('.markdown')){
        const parsed=parseMarkdownSong(text,file.name);
        const id=batchUniqueId(slugify(`${parsed.title}-${parsed.artist||'markdown'}`));
        newSongs.push(enrichImportedSong({id,library:libraryId,...parsed},file.name,'Markdown-Import'));
      }else if(/\.(cho|crd|pro|chopro|chordpro|txt)$/i.test(lower)){
        const parsed=parseChordProText(text,file.name);
        const id=batchUniqueId(slugify(`${parsed.title}-${parsed.artist||'text'}`));
        newSongs.push(enrichImportedSong({id,library:libraryId,...parsed},file.name,lower.endsWith('.txt')?'Text-Import':'ChordPro-Import'));
      }else{
        failures.push(`${file.name}: Format nicht unterstützt`);
      }
    }catch(error){
      failures.push(`${file.name}: ${error.message||'Importfehler'}`); console.error(error);
    }
  }
  if(!newSongs.length){
    const msg='Keine passenden Songs gefunden.'+(failures.length?`\n\n${failures.join('\n')}`:'');
    alert(msg); return [];
  }
  state.libraries.push({id:libraryId,name:libraryName.trim(),importedAt:new Date().toISOString(),count:newSongs.length});
  state.importedSongs.push(...newSongs);
  markSongsNew(newSongs.map(s=>s.id));
  saveLibraries();
  state.lastImport={libraryId,name:libraryName.trim(),ids:newSongs.map(s=>s.id),skipped:failures};
  renderLibraryFilterOptions(); renderLibrariesManager(); renderAll();
  const result=$('#importResult');
  if(result){
    result.innerHTML=`<strong>${newSongs.length} Song(s) importiert</strong><span>Bibliothek „${esc(libraryName.trim())}“</span>${failures.length?`<small>${failures.length} Datei(en) übersprungen: ${esc(failures.join(' · '))}</small>`:''}<button id="importShowSongsBtn" type="button" class="primary">Importierte Songs öffnen</button>`;
    const show=$('#importShowSongsBtn'); if(show) show.onclick=()=>showLibrary(libraryId);
  }
  if(!options.silent){
    showLibrary(libraryId);
    showToast(`${newSongs.length} Song(s) in „${libraryName.trim()}“ importiert`, 'success');
  }
  return newSongs;
}

// Öffnet „Alle Songs“ gefiltert auf eine importierte Bibliothek.
function showLibrary(libraryId) {
  renderLibraryFilterOptions();
  const select = $('#libraryFilter');
  if (select) select.value = libraryId ? `lib:${libraryId}` : 'all';
  const search = $('#searchInput'); if (search) search.value = '';
  switchView('library');
  renderLibrary();
}

function renameLibrary(libraryId) {
  const lib = state.libraries.find(item => item.id === libraryId);
  if (!lib) return;
  const name = prompt('Neuer Name der Bibliothek:', lib.name);
  if (!name?.trim()) return;
  lib.name = name.trim();
  saveLibraries(); renderLibraryFilterOptions(); renderLibrariesManager(); renderAll();
  showToast('Bibliothek umbenannt', 'success');
}

async function removeLibrary(libraryId) {
  const lib = state.libraries.find(item => item.id === libraryId); if (!lib) return;
  if (!confirm(`Bibliothek „${lib.name}“ und ihre ${lib.count} Song(s) wirklich löschen?`)) return;
  const removing = state.importedSongs.filter(item => item.library === libraryId);
  for (const item of removing) if (item.pdfAttachment) { try { await deletePdfBlob(item.id); } catch (error) { console.warn(error); } }
  state.libraries = state.libraries.filter(item => item.id !== libraryId);
  state.importedSongs = state.importedSongs.filter(item => item.library !== libraryId);
  if (state.lastImport?.libraryId === libraryId) state.lastImport = null;
  const select = $('#libraryFilter');
  if (select?.value === `lib:${libraryId}`) select.value = 'all';
  saveLibraries(); renderLibraryFilterOptions(); renderLibrariesManager(); renderAll();
  showToast(`Bibliothek „${lib.name}“ entfernt`);
}

function renderLibraryFilterOptions() {
  const select = $('#libraryFilter'); if (!select) return;
  const current = select.value;
  select.querySelector('optgroup[data-libraries]')?.remove();
  if (state.libraries.length) {
    const group = document.createElement('optgroup');
    group.label = 'Importierte Bibliotheken';
    group.dataset.libraries = '1';
    state.libraries.forEach(lib => {
      const option = document.createElement('option');
      option.value = `lib:${lib.id}`;
      option.textContent = `${lib.name} (${lib.count})`;
      group.append(option);
    });
    select.append(group);
  }
  if ([...select.options].some(option => option.value === current)) select.value = current;
}

function libraryFilterLabel(filter) {
  if (filter?.startsWith('lib:')) {
    const lib = state.libraries.find(item => `lib:${item.id}` === filter);
    return lib ? `Bibliothek „${lib.name}“` : 'Bibliothek';
  }
  return {
    all: 'Alle Songs', setlist: 'Aktive Setliste', favorites: 'Favoriten',
    new: 'Neu importiert', pdf: 'Songs mit Liedblatt', 'public-domain': 'Public Domain'
  }[filter] || 'Alle Songs';
}

function renderLibrariesManager() {
  ['#librariesManager', '#librariesManagerImport'].forEach(selector => {
    const host = $(selector);
    if (!host) return;
    host.innerHTML = '';
    if (!state.libraries.length) {
      host.innerHTML = '<p class="empty">Noch keine Songs importiert. Importierte Dateien werden hier als Bibliothek gesammelt.</p>';
      return;
    }
    state.libraries.forEach(lib => {
      const row = document.createElement('div');
      row.className = 'picker-item library-row';
      row.innerHTML = `<div><strong>${esc(lib.name)}</strong><small>${lib.count} Song(s) · importiert ${new Date(lib.importedAt).toLocaleDateString('de')}</small></div>`
        + '<div class="library-row-actions"><button type="button" data-act="show">Anzeigen</button><button type="button" data-act="rename">Umbenennen</button><button type="button" data-act="remove">Entfernen</button></div>';
      row.querySelector('[data-act="show"]').onclick = () => showLibrary(lib.id);
      row.querySelector('[data-act="rename"]').onclick = () => renameLibrary(lib.id);
      row.querySelector('[data-act="remove"]').onclick = () => removeLibrary(lib.id);
      host.append(row);
    });
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

function saveNewSongIds(){ localStorage.setItem(STORAGE.newSongs, JSON.stringify([...state.newSongIds])); }
function markSongsNew(ids){ ids.forEach(id=>state.newSongIds.add(id)); saveNewSongIds(); }
function markSongSeen(id){ if(state.newSongIds.delete(id)){ saveNewSongIds(); renderAll(); } }

function cleanImportFilename(filename='Song'){
  return String(filename).replace(/\.[^.]+$/,'').replace(/^\s*\d{1,3}\s*[-_. )]+\s*/,'').replace(/[_]+/g,' ').replace(/\s{2,}/g,' ').trim();
}
function inferFilenameMetadata(filename='Song'){
  const clean=cleanImportFilename(filename);
  const parts=clean.split(/\s+-\s+/).map(x=>x.trim()).filter(Boolean);
  if(parts.length>=2) return { artist:parts[0], title:parts.slice(1).join(' - ') };
  return { title:clean, artist:'' };
}
function enrichImportedSong(songData, filename, importTag){
  const guessed=inferFilenameMetadata(filename);
  const song={...songData};
  song.title=String(song.title||guessed.title||'Song').trim();
  song.artist=String(song.artist||guessed.artist||'').trim();
  song.genre=String(song.genre||'').trim();
  song.singer=String(song.singer||'').trim();
  song.tags=[...new Set([...(Array.isArray(song.tags)?song.tags:[]), importTag].filter(Boolean))];
  song.importedAt=new Date().toISOString();
  song.importFilename=filename;
  return song;
}


function activeSetlist() {
  return state.setlists.find(list => list.id === state.activeSetlistId) || state.setlists[0] || null;
}

function song(id) { return state.songs.find(item => item.id === id); }
function esc(value = '') { return String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[char])); }
function meta(item) { return [item.key && `Tonart ${item.key}`, item.bpm && `${item.bpm} BPM`, Number(item.capo) > 0 && `Capo ${item.capo}`].filter(Boolean).join(' · '); }
function searchable(item) { return [item.title, item.artist, item.genre, ...(item.tags || [])].join(' ').toLowerCase(); }
function isPublicDomain(item) { return item.tags?.some(tag => /public domain|gemeinfrei/i.test(tag)) || /public domain|gemeinfrei/i.test(item.source?.lyricsLicense || ''); }

// Kurze, nicht blockierende Rückmeldung – ersetzt Alert-Fenster.
let toastTimer = null;
function showToast(message, tone = 'info') {
  const host = $('#toast');
  if (!host) { console.info(message); return; }
  host.textContent = message;
  host.dataset.tone = tone;
  host.hidden = false;
  host.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    host.classList.remove('visible');
    setTimeout(() => { host.hidden = true; }, 260);
  }, 3200);
}

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
    loadLocalState(); mergeSongs(); bindUI(); setupBackNavigation(); applySettings(); setTransportCollapsed(localStorage.getItem(STORAGE.transportCollapsed) === '1', false); renderLibraryFilterOptions(); renderLibrariesManager(); renderAll();
    const initial = song(state.currentId) ? state.currentId : activeSetlist()?.songs.find(id => song(id)) || state.songs[0]?.id;
    if (initial) await openSong(initial, false);
    state.nav.stack = [];
    switchView('dashboard');
    updateBackButton();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register(new URL('./service-worker.js?v=9.7.0', document.baseURI), { scope: './', updateViaCache: 'none' }).then(registration => registration.update()).catch(console.error);
    dismissSplash();
  } catch (error) {
    $('#errorBanner').hidden = false;
    $('#errorBanner').textContent = `App konnte nicht geladen werden: ${error.message}`;
    console.error(error);
  }
}

function bindUI() {
  $('#menuBtn').onclick = openDrawer; $('#backdrop').onclick = closeDrawer;
  $('#backBtn').onclick = () => handleBack();
  $('#dashboardSetlistBtn').onclick = () => switchView('setlists');
  $('#dashboardOpenSetlistBtn').onclick = () => switchView('setlists');
  $('#dashboardLibraryBtn').onclick = () => switchView('library');
  $('#dashboardFavoritesBtn').onclick = () => switchView('favorites');
  $('#dashboardContinueBtn').onclick = () => switchView('player');
  $('#dashboardGigBtn').onclick = openGigStartDialog;
  $('#insertSotBtn').onclick = () => insertEditorText('{sot: Intro}\n');
  $('#insertEotBtn').onclick = () => insertEditorText('\n{eot}');
  $('#insertTabBlockBtn').onclick = () => insertEditorText('{sot: Intro}\ne|----------------|\nB|----------------|\nG|----------------|\nD|----------------|\nA|----------------|\nE|----------------|\n{eot}\n');

  $$('.nav-item').forEach(button => button.onclick = () => switchView(button.dataset.view, { root: true }));
  $('#settingsBtn').onclick = () => openDialog('#displaySettings');
  $('#tutorialBtn').onclick = () => { closeDrawer(); startTutorial(true); };
  $('#setlistSelect').onchange = event => { state.activeSetlistId = event.target.value; saveSetlists(); renderAll(); };
  $('#playerSetlistBtn').onclick = () => switchView('setlists');
  $('#newSetlistBtn').onclick = createSetlist; $('#renameSetlistBtn').onclick = renameSetlist; $('#deleteSetlistBtn').onclick = deleteSetlist;
  $('#exportSetlistBtn').onclick = exportActiveSetlist;
  $('#addSongBtn').onclick = () => openSongPicker();
  $('#pickerSetlistSelect').onchange = renderPicker;
  $('#confirmSongToSetlistBtn').onclick = confirmSongToSetlist;
  $('#gigSetlistSelect').onchange = updateGigSetlistInfo;
  $('#confirmGigStartBtn').onclick = confirmGigStart;
  $('#endGigBtn').onclick = endGig;
  $('#resetSetlistBtn').onclick = resetActiveSetlist;
  $('#searchInput').oninput = renderLibrary; $('#libraryFilter').onchange = renderLibrary;
  $('#librarySearchClearBtn').onclick = () => { $('#searchInput').value = ''; $('#libraryFilter').value = 'all'; renderLibrary(); $('#searchInput').focus(); };
  $('#openImportViewBtn').onclick = () => switchView('import');
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
  $('#mainImportSongsFile').onchange=async event=>{ await importSongFiles(event.target.files); event.target.value=''; };
  const dropzone=$('#mainImportDropzone');
  ['dragenter','dragover'].forEach(type=>dropzone.addEventListener(type,e=>{e.preventDefault();dropzone.classList.add('dragover');}));
  ['dragleave','drop'].forEach(type=>dropzone.addEventListener(type,e=>{e.preventDefault();dropzone.classList.remove('dragover');}));
  dropzone.addEventListener('drop',e=>importSongFiles(e.dataTransfer.files));
  dropzone.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();$('#mainImportSongsFile').click();}});
  dropzone.onclick=()=>$('#mainImportSongsFile').click();
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
  $('#toolMetronomeStartBtn').onclick=toggleMetronome;
  $('#toolMetronomeTapBtn').onclick=tapTempoTool;
  $('#toolMetronomeBpm').oninput=updateMetronomeFromTool;
  $('#toolMetronomeMeter').onchange=updateMetronomeFromTool;
  $('#toolMetronomeSound').onchange=updateMetronomeFromTool;
  $('#tunerStartBtn').onclick=startTuner;
  $('#tunerStopBtn').onclick=stopTuner;
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

function renderAll() { renderSetlistSelect(); renderSetlist(); renderLibrary(); renderFavorites(); updateFavoriteButton(); renderDashboard(); updateSetlistTargetControls(); syncMetronomeTool(); requestAnimationFrame(updatePlayerLayout); }
function openDrawer() { $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false'); $('#backdrop').hidden = false; syncHistoryGuard(); }
function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); $('#backdrop').hidden = true; }
function switchView(name, options = {}) {
  const view = $(`#${name}View`);
  if (!view) return;
  const previous = state.nav.current;
  const changed = previous !== name;
  if (options.root) {
    // Sprung über das Hauptmenü: Zurück führt danach eine Ebene nach oben.
    state.nav.stack = [];
  } else if (changed && !options.fromBack) {
    state.nav.stack.push(previous);
    if (state.nav.stack.length > 25) state.nav.stack.shift();
  }
  state.nav.current = name;
  $$('.view').forEach(item => item.classList.remove('active')); view.classList.add('active');
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  $('#viewTitle').textContent = VIEW_LABELS[name] || '';
  document.body.classList.toggle('player-mode', name === 'player');
  if (name !== 'player') {
    setPlaybackChromeHidden(false);
    if (state.scrolling) stopScroll();
  }
  if (name !== 'tuner' && state.tuner?.stream) stopTuner();
  if (name === 'player' && activePanelName() === 'pdf') ensurePdfLoaded();
  updateBackButton();
  syncHistoryGuard();
  if (changed) window.scrollTo({ top: 0 });
  requestAnimationFrame(updatePlayerLayout);
  closeDrawer();
}

// „Eine Ebene nach oben“: zuletzt besuchte Ansicht, sonst die übergeordnete Ansicht.
function backTarget() {
  const current = state.nav.current;
  for (let index = state.nav.stack.length - 1; index >= 0; index -= 1) {
    const candidate = state.nav.stack[index];
    if (candidate && candidate !== current && $(`#${candidate}View`)) return { name: candidate, index };
  }
  if (current === 'player') return { name: state.nav.playerOrigin || 'setlists', index: -1 };
  return { name: VIEW_PARENTS[current] || 'dashboard', index: -1 };
}

function updateBackButton() {
  const button = $('#backBtn');
  if (!button) return;
  const isRoot = state.nav.current === 'dashboard';
  button.hidden = isRoot;
  if (isRoot) return;
  const label = VIEW_LABELS[backTarget().name] || 'Übersicht';
  button.setAttribute('aria-label', `Zurück zu ${label}`);
  button.title = `Zurück zu ${label}`;
  const text = button.querySelector('.back-label');
  if (text) text.textContent = label;
}

function anyLayerOpen() {
  return !!($('#drawer')?.classList.contains('open')
    || document.querySelector('dialog[open]')
    || ($('#tutorialOverlay') && !$('#tutorialOverlay').hidden));
}

function closeTopLayer() {
  const tutorial = $('#tutorialOverlay');
  if (tutorial && !tutorial.hidden) { finishTutorial(); return true; }
  if ($('#drawer')?.classList.contains('open')) { closeDrawer(); return true; }
  const dialogs = [...document.querySelectorAll('dialog')].filter(item => item.open);
  if (dialogs.length) { dialogs[dialogs.length - 1].close('cancel'); return true; }
  if (state.live.gigMode) { endGig(); return true; }
  if (document.body.classList.contains('playback-focus')) { setPlaybackChromeHidden(false); return true; }
  return false;
}

// Ein Rücksprung: erst offene Ebenen schließen, dann eine Ansicht nach oben.
function handleBack() {
  if (closeTopLayer()) return true;
  if (state.nav.current === 'dashboard') return false;
  const target = backTarget();
  state.nav.stack.length = target.index >= 0 ? target.index : 0;
  switchView(target.name, { fromBack: true });
  return true;
}

function openDialog(selector) {
  const dialog = typeof selector === 'string' ? $(selector) : selector;
  if (!dialog) return null;
  if (!dialog.open) {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }
  syncHistoryGuard();
  return dialog;
}

// Hält einen History-Eintrag vor, damit die Gerätetaste/Wischgeste „zurück“
// in der App navigiert statt die App zu verlassen.
function syncHistoryGuard() {
  if (typeof history === 'undefined') return;
  const needsGuard = state.nav.current !== 'dashboard' || anyLayerOpen();
  if (needsGuard && !state.nav.guarded) {
    try { history.pushState({ appGuard: true, view: state.nav.current }, ''); state.nav.guarded = true; }
    catch (error) { /* History nicht verfügbar */ }
  }
}

function setupBackNavigation() {
  try { history.replaceState({ appRoot: true }, ''); } catch (error) { /* ignorieren */ }
  window.addEventListener('popstate', () => {
    state.nav.guarded = false;
    if (handleBack()) syncHistoryGuard();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if ($('#drawer')?.classList.contains('open')) { closeDrawer(); return; }
    if (!document.querySelector('dialog[open]') && state.nav.current !== 'dashboard') handleBack();
  });
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


function fillSetlistSelect(select, selectedId = state.activeSetlistId) {
  if (!select) return;
  select.innerHTML = '';
  state.setlists.forEach(list => {
    const option=document.createElement('option');
    option.value=list.id; option.textContent=`${list.name} (${list.songs.filter(id=>song(id)).length})`;
    option.selected=list.id===selectedId; select.append(option);
  });
}
function updateSetlistTargetControls(){
  fillSetlistSelect($('#pickerSetlistSelect'));
  fillSetlistSelect($('#gigSetlistSelect'));
  fillSetlistSelect($('#songTargetSetlistSelect'));
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
  if (!validIds.length) {
    host.innerHTML = `<li class="setlist-empty"><strong>„${esc(list.name)}“ ist noch leer</strong><p>Songs kommen aus der Liste „Alle Songs“.</p><button id="setlistEmptyAddBtn" type="button" class="primary">+ Songs auswählen</button></li>`;
    const add = $('#setlistEmptyAddBtn');
    if (add) add.onclick = () => openSongPicker(list.id);
    return;
  }
  validIds.forEach((id, index) => {
    const item = song(id); const li = document.createElement('li'); li.className = 'song-row'; li.dataset.songId = id;
    li.innerHTML = `<button class="drag-handle" type="button" aria-label="${esc(item.title)} verschieben. Gedrückt halten und ziehen." title="Zum Verschieben ziehen">⠿</button><button class="song-main"><span class="number">${index + 1}</span><span><strong>${esc(item.title)}${item.pdfAttachment ? ' <span class="row-pdf-mark" title="Liedblatt vorhanden">📄</span>' : ''}</strong><small>${esc(item.artist)}${meta(item) ? ` · ${esc(meta(item))}` : ''}</small></span></button><div class="row-actions"><button class="favorite" aria-label="Favorit">${state.favorites.has(id) ? '★' : '☆'}</button><button class="move-up" aria-label="Nach oben">↑</button><button class="move-down" aria-label="Nach unten">↓</button><button class="remove" aria-label="Entfernen">✕</button></div>`;
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
  const card = document.createElement('article'); card.className = 'card';
  const inList = activeSetlist()?.songs.includes(item.id);
  const isNew = state.newSongIds.has(item.id);
  const badges = [
    isNew ? '<span class="new-song-badge">NEU</span>' : '',
    item.pdfAttachment ? '<span class="pdf-song-badge">Liedblatt</span>' : ''
  ].join('');
  card.innerHTML = `<div class="card-title"><div class="song-badges">${badges}</div><div><h3>${esc(item.title)}</h3><p>${esc(item.artist)}</p></div><button class="star" aria-label="Favorit">${state.favorites.has(item.id) ? '★' : '☆'}</button></div>`
    + `<small>${esc([item.genre, meta(item)].filter(Boolean).join(' · '))}</small>`
    + `<div class="card-actions"><button class="primary open" type="button">Öffnen</button><button class="add" type="button">${inList ? '✓ In Setliste' : '+ Setliste'}</button></div>`;
  card.querySelector('.open').onclick = () => openSong(item.id);
  card.querySelector('.star').onclick = () => toggleFavorite(item.id);
  card.querySelector('.add').onclick = () => openSongToSetlist(item.id);
  return card;
}

function filteredSongs(query, filter) {
  let items = state.songs; const q = query.trim().toLowerCase();
  if (filter === 'setlist') { const ids = new Set(activeSetlist()?.songs || []); items = items.filter(item => ids.has(item.id)); }
  if (filter === 'public-domain') items = items.filter(isPublicDomain);
  if (filter === 'favorites') items = items.filter(item => state.favorites.has(item.id));
  if (filter === 'new') items = items.filter(item => state.newSongIds.has(item.id));
  if (filter === 'pdf') items = items.filter(item => item.pdfAttachment);
  if (filter?.startsWith('lib:')) { const libId = filter.slice(4); items = items.filter(item => item.library === libId); }
  if (q) items = items.filter(item => searchable(item).includes(q));
  return [...items].sort((a, b) => a.title.localeCompare(b.title, 'de'));
}

function renderLibrary() {
  const filter = $('#libraryFilter').value;
  const items = filteredSongs($('#searchInput').value || '', filter);
  const host = $('#library'); host.innerHTML = '';
  $('#librarySummary').textContent = `${libraryFilterLabel(filter)}: ${items.length} von ${state.songs.length} Songs`;
  renderImportBanner();
  if (!items.length) {
    host.innerHTML = filter === 'all'
      ? '<p class="empty">Keine Songs gefunden. Suchbegriff ändern oder im Menü unter „Songs importieren“ neue Dateien laden.</p>'
      : `<p class="empty">In „${esc(libraryFilterLabel(filter))}“ passt gerade kein Song. <button id="libraryShowAllBtn" type="button">Alle Songs zeigen</button></p>`;
    const showAll = $('#libraryShowAllBtn');
    if (showAll) showAll.onclick = () => { $('#libraryFilter').value = 'all'; renderLibrary(); };
    return;
  }
  items.forEach(item => host.append(songCard(item)));
}

// Zeigt direkt nach einem Import, welche Songs angekommen sind.
function renderImportBanner() {
  const host = $('#importedBanner');
  if (!host) return;
  const info = state.lastImport;
  const items = (info?.ids || []).map(id => song(id)).filter(Boolean);
  if (!items.length) { host.hidden = true; host.innerHTML = ''; return; }
  host.hidden = false;
  host.innerHTML = `<div class="import-banner-head"><div><strong>${items.length} Song(s) importiert</strong><small>Bibliothek „${esc(info.name)}“</small></div><button id="importBannerCloseBtn" type="button" class="icon-btn" aria-label="Hinweis ausblenden">✕</button></div>`
    + `<ul class="import-banner-list">${items.map(item => `<li><span><strong>${esc(item.title)}</strong><small>${esc(item.artist || '')}${item.pdfAttachment ? ' · Liedblatt' : ''}</small></span><button type="button" data-open-song="${esc(item.id)}">Öffnen</button></li>`).join('')}</ul>`
    + '<div class="import-banner-actions"><button id="importAddAllBtn" type="button" class="primary">Alle zur aktiven Setliste</button></div>';
  host.querySelectorAll('[data-open-song]').forEach(button => { button.onclick = () => openSong(button.dataset.openSong); });
  $('#importBannerCloseBtn').onclick = () => { state.lastImport = null; renderImportBanner(); };
  $('#importAddAllBtn').onclick = () => {
    const added = addSongsToSetlist(items.map(item => item.id));
    const list = activeSetlist();
    showToast(added ? `${added} Song(s) zu „${list?.name || 'Setliste'}“ hinzugefügt` : 'Alle Songs sind schon in der Setliste', added ? 'success' : 'info');
  };
}

function renderFavorites() {
  const q = ($('#favoriteSearch').value || '').toLowerCase(); const items = state.songs.filter(item => state.favorites.has(item.id) && searchable(item).includes(q)).sort((a,b) => a.title.localeCompare(b.title, 'de'));
  $('#favoriteSummary').textContent = `${items.length} Favorit${items.length === 1 ? '' : 'en'}`; const host = $('#favorites'); host.innerHTML = '';
  if (!items.length) host.innerHTML = '<p class="empty">Noch keine Favoriten markiert.</p>'; else items.forEach(item => host.append(songCard(item)));
}

function pickerTarget() {
  const targetId = $('#pickerSetlistSelect')?.value || state.activeSetlistId;
  return state.setlists.find(list => list.id === targetId) || activeSetlist();
}

function openSongPicker(targetId = state.activeSetlistId) {
  state.picker.filter = 'all';
  state.picker.added = 0;
  const search = $('#pickerSearch'); if (search) search.value = '';
  fillSetlistSelect($('#pickerSetlistSelect'), targetId);
  renderPickerChips();
  renderPicker();
  openDialog('#songPicker');
  setTimeout(() => { const list = $('#pickerList'); if (list) list.scrollTop = 0; }, 40);
}

function renderPickerChips() {
  const host = $('#pickerChips');
  if (!host) return;
  const chips = [
    { value: 'all', label: 'Alle Songs' },
    { value: 'favorites', label: '★ Favoriten' },
    { value: 'new', label: 'Neu importiert' },
    { value: 'pdf', label: 'Mit Liedblatt' },
    ...state.libraries.slice(-3).reverse().map(lib => ({ value: `lib:${lib.id}`, label: lib.name }))
  ];
  host.innerHTML = chips
    .map(chip => `<button type="button" class="chip${state.picker.filter === chip.value ? ' active' : ''}" data-picker-filter="${esc(chip.value)}">${esc(chip.label)}</button>`)
    .join('');
  host.querySelectorAll('[data-picker-filter]').forEach(button => {
    button.onclick = () => {
      state.picker.filter = button.dataset.pickerFilter;
      renderPickerChips(); renderPicker();
    };
  });
}

function renderPicker() {
  const host = $('#pickerList');
  if (!host) return;
  const query = ($('#pickerSearch').value || '').toLowerCase();
  const target = pickerTarget();
  const items = filteredSongs(query, state.picker.filter || 'all');
  const inList = new Set(target?.songs || []);
  const targetName = $('#pickerTargetName');
  if (targetName) targetName.textContent = target ? `Ziel: ${target.name} · ${inList.size} Songs` : 'Keine Setliste vorhanden';
  const summary = $('#pickerSummary');
  if (summary) summary.textContent = `${items.length} Song(s) zur Auswahl`;
  host.innerHTML = '';
  if (!items.length) {
    host.innerHTML = '<p class="empty">Kein Song passt zur Suche.</p>';
  } else {
    items.forEach(item => {
      const row = document.createElement('div');
      const exists = inList.has(item.id);
      row.className = `picker-item${exists ? ' in-list' : ''}`;
      row.innerHTML = `<div><strong>${esc(item.title)}</strong><small>${esc(item.artist || '')}${item.pdfAttachment ? ' · Liedblatt' : ''}</small></div>`
        + `<button type="button" class="${exists ? '' : 'primary'}">${exists ? '✓ Entfernen' : '+ Hinzufügen'}</button>`;
      row.querySelector('button').onclick = () => {
        if (exists) { removeFromSetlist(item.id, target?.id); state.picker.added = Math.max(0, state.picker.added - 1); }
        else { if (addToSetlist(item.id, target?.id)) state.picker.added += 1; }
        renderPicker();
      };
      host.append(row);
    });
  }
  const count = $('#pickerCount');
  if (count) {
    count.textContent = state.picker.added
      ? `${state.picker.added} Song(s) hinzugefügt`
      : 'Tippe auf „Hinzufügen“, um Songs aufzunehmen.';
  }
  const addVisible = $('#pickerAddVisibleBtn');
  if (addVisible) {
    const missing = items.filter(item => !inList.has(item.id));
    addVisible.hidden = missing.length < 2;
    addVisible.textContent = `Alle ${missing.length} hinzufügen`;
    addVisible.onclick = () => {
      const added = addSongsToSetlist(missing.map(item => item.id), target?.id);
      state.picker.added += added;
      renderPicker();
    };
  }
}

function addToSetlist(id, setlistId = state.activeSetlistId) {
  return addSongsToSetlist([id], setlistId) > 0;
}

function addSongsToSetlist(ids = [], setlistId = state.activeSetlistId) {
  const list = state.setlists.find(item => item.id === setlistId) || activeSetlist();
  if (!list) return 0;
  let added = 0;
  ids.filter(id => song(id)).forEach(id => {
    if (list.songs.includes(id)) return;
    list.songs.push(id); added += 1;
  });
  if (added) { saveSetlists(); renderAll(); }
  return added;
}

function removeFromSetlist(id, setlistId = state.activeSetlistId) {
  const list = state.setlists.find(item => item.id === setlistId) || activeSetlist();
  if (!list) return false;
  const position = list.songs.indexOf(id);
  if (position < 0) return false;
  list.songs.splice(position, 1); saveSetlists(); renderAll(); return true;
}
function openSongToSetlist(id){
  const item=song(id); if(!item) return;
  state.pendingSetlistSongId=id;
  $('#songToSetlistName').textContent=`${item.title}${item.artist ? ` · ${item.artist}` : ''}`;
  fillSetlistSelect($('#songTargetSetlistSelect'));
  openDialog('#songToSetlistDialog');
}
function confirmSongToSetlist(){
  const id=state.pendingSetlistSongId, target=$('#songTargetSetlistSelect').value;
  if(!id||!target) return;
  const list=state.setlists.find(x=>x.id===target);
  const added=addToSetlist(id,target);
  $('#songToSetlistDialog').close();
  state.pendingSetlistSongId=null;
  if(added) showToast(`Zu „${list?.name || 'Setliste'}“ hinzugefügt`, 'success');
  else showToast('Dieser Song ist in der Setliste schon enthalten');
}
function toggleFavorite(id) { if (!id || !song(id)) return; state.favorites.has(id) ? state.favorites.delete(id) : state.favorites.add(id); saveFavorites(); renderAll(); }
function updateFavoriteButton() { const active = state.currentId && state.favorites.has(state.currentId); $('#favoriteCurrentBtn').textContent = active ? '★ Favorit' : '☆ Favorit'; }

function createSetlist() { const name = prompt('Name der neuen Setliste:'); if (!name?.trim()) return; const id = `custom-${Date.now()}`; state.setlists.push({ id, name: name.trim(), description: 'Lokale Setliste', songs: [] }); state.activeSetlistId = id; saveSetlists(); renderAll(); }
function renameSetlist() { const list = activeSetlist(); if (!list) return; const name = prompt('Neuer Name:', list.name); if (!name?.trim()) return; list.name = name.trim(); saveSetlists(); renderAll(); }
function deleteSetlist() { const list = activeSetlist(); if (!list || state.setlists.length <= 1) { showToast('Mindestens eine Setliste muss bestehen bleiben'); return; } if (!confirm(`Setliste „${list.name}“ löschen?`)) return; state.setlists = state.setlists.filter(item => item.id !== list.id); state.activeSetlistId = state.setlists[0].id; saveSetlists(); renderAll(); }
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
  preparePdfPanel(item);
  $('#notesSheet').innerHTML = item.notes?.trim() ? `<div class="notes-content">${esc(item.notes).replace(/\n/g, '<br>')}</div>` : '<p class="empty">Für diesen Song sind noch keine Notizen gespeichert.</p>';
  if (changeView && state.nav.current !== 'player') state.nav.playerOrigin = state.nav.current;
  $('#transposeResetBtn').textContent = semitones ? `${semitones > 0 ? '+' : ''}${semitones}` : '0';
  const directRef = /^https:\/\/(?:www\.)?chordie\.com\//i.test(item?.source?.url || item?.chordieUrl || '');
  $('#songSourceStatus').textContent = directRef ? 'Chordie-Referenz gespeichert.' : 'Chordie öffnet eine Suche nach Titel und Interpret.';
  updateFavoriteButton(); markSongSeen(id); scrollTo({ top: 0 });
  if (changeView) { switchView('player'); setPlayerPanel(isPdfOnlySong(item) ? 'pdf' : 'lyrics'); }
  else setPlayerPanel(activePanelName());
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

function isPdfOnlySong(item) {
  if (!item?.pdfAttachment) return false;
  if (item.pdfOnly) return true;
  const text = String(item.content || item.lyrics || '')
    .replace(/\[PDF[^\]]*\]/gi, '').replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length < 90;
}

function releasePdfViewer() {
  state.pdfView.tasks.forEach(task => { try { task.cancel(); } catch (error) { /* egal */ } });
  state.pdfView.tasks = [];
  if (state.pdfView.observer) { try { state.pdfView.observer.disconnect(); } catch (error) { /* egal */ } }
  state.pdfView.observer = null;
  if (state.pdfView.doc) { try { state.pdfView.doc.destroy(); } catch (error) { /* egal */ } }
  state.pdfView.doc = null;
  state.pdfView.sizes = [];
  if (activePdfObjectUrl) { URL.revokeObjectURL(activePdfObjectUrl); activePdfObjectUrl = ''; }
}

// Setzt den PDF-Reiter für einen Song auf, lädt aber noch nichts.
function preparePdfPanel(item) {
  releasePdfViewer();
  state.pdfPanel = { songId: item?.id || null, loaded: false, loading: false };
  state.pdfScroll = { page: 1, pages: 0, fallbackProgress: 0 };
  const button = $('#pdfTabBtn');
  if (button) {
    button.disabled = false; button.setAttribute('aria-disabled', 'false');
    button.classList.toggle('has-pdf', !!item?.pdfAttachment);
    button.textContent = item?.pdfAttachment ? '📄 PDF ●' : '📄 PDF';
    button.title = item?.pdfAttachment ? `PDF vorhanden: ${item.pdfName || 'Song-PDF'}` : 'Kein PDF hinterlegt';
  }
  const host = $('#pdfSheet');
  if (!host) return;
  if (!item?.pdfAttachment) {
    host.innerHTML = '<div class="empty pdf-empty-state"><p>Für diesen Song ist kein PDF gespeichert.</p><button id="addPdfFromPlayerBtn" type="button" class="primary">+ PDF hinzufügen</button></div>';
    const add = $('#addPdfFromPlayerBtn'); if (add) add.onclick = promptPdfForCurrentSong;
    return;
  }
  host.innerHTML = `<div class="pdf-standby"><strong>📄 ${esc(item.pdfName || 'Song-PDF')}</strong><button id="pdfLoadBtn" type="button" class="primary">Liedblatt anzeigen</button></div>`;
  const load = $('#pdfLoadBtn'); if (load) load.onclick = () => ensurePdfLoaded(true);
}

async function ensurePdfLoaded(force = false) {
  const item = song(state.currentId);
  if (!item?.pdfAttachment) return;
  if (state.pdfPanel.songId !== item.id) preparePdfPanel(item);
  if (state.pdfPanel.loading) return;
  if (state.pdfPanel.loaded && !force) return;
  if (!force && !$('#playerView')?.classList.contains('active')) return;
  state.pdfPanel.loading = true;
  try { await renderPdf(item); } finally { state.pdfPanel.loading = false; }
}

async function renderPdf(item) {
  const host = $('#pdfSheet');
  if (!host || !item?.pdfAttachment) return;
  const songId = item.id;
  releasePdfViewer();
  host.innerHTML = '<p class="empty">Liedblatt wird geladen …</p>';
  try {
    const record = await getPdfRecord(songId);
    if (!record?.data?.byteLength) throw new Error('Die PDF-Datei liegt nicht mehr im Speicher dieses Geräts.');
    if (state.currentId !== songId) return;
    activePdfObjectUrl = URL.createObjectURL(new Blob([record.data], { type: record.type || 'application/pdf' }));
    let doc = null;
    try {
      const pdfjs = await loadPdfEngine();
      doc = await pdfjs.getDocument({
        data: new Uint8Array(record.data.slice(0)),
        standardFontDataUrl: vendorUrl('standard_fonts/'),
        isEvalSupported: false
      }).promise;
    } catch (engineError) {
      console.warn('PDF-Anzeige nicht verfügbar, einfache Ansicht wird genutzt', engineError);
    }
    if (state.currentId !== songId) { if (doc) { try { doc.destroy(); } catch (error) { /* egal */ } } return; }
    if (doc) await buildPdfCanvasViewer(item, doc);
    else buildPdfFallbackViewer(item);
    state.pdfPanel = { songId, loaded: true, loading: false };
    requestAnimationFrame(updatePlayerLayout);
  } catch (error) {
    console.error(error);
    host.innerHTML = `<div class="pdf-error"><strong>Liedblatt lässt sich nicht öffnen</strong><p>${esc(error.message || 'Unbekannter Fehler')}</p><div class="pdf-error-actions"><button id="pdfRetryBtn" type="button">Erneut laden</button><button id="pdfReplaceBtn" type="button" class="primary">PDF neu hinzufügen</button></div></div>`;
    const retry = $('#pdfRetryBtn'); if (retry) retry.onclick = () => ensurePdfLoaded(true);
    const replace = $('#pdfReplaceBtn'); if (replace) replace.onclick = promptPdfForCurrentSong;
  }
}

// Alle Seiten werden als Bilder gezeichnet. Das funktioniert auch dort,
// wo eingebettete PDF-Rahmen blockiert sind (iPhone/iPad).
async function buildPdfCanvasViewer(item, doc) {
  const host = $('#pdfSheet');
  const pages = doc.numPages || 0;
  state.pdfView.doc = doc;
  state.pdfScroll = { page: 1, pages, fallbackProgress: 0 };
  const sizes = [];
  const measured = Math.min(pages, 60);
  for (let number = 1; number <= measured; number += 1) {
    try {
      const page = await doc.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      sizes.push({ width: viewport.width, height: viewport.height });
      page.cleanup?.();
    } catch (error) { sizes.push({ width: 595, height: 842 }); }
  }
  while (sizes.length < pages) sizes.push(sizes[0] || { width: 595, height: 842 });
  state.pdfView.sizes = sizes;
  const zoom = state.pdfView.zoom || 1;
  const cards = Array.from({ length: pages }, (_, index) => {
    const size = sizes[index] || { width: 595, height: 842 };
    const ratio = (size.height / size.width) || 1.414;
    return `<section class="pdf-page-card" data-pdf-page="${index + 1}" style="--pdf-ratio:${ratio.toFixed(4)}">`
      + `<div class="pdf-page-label">Seite ${index + 1} / ${pages}</div>`
      + '<div class="pdf-page-slot"><span class="pdf-page-note">wird gezeichnet …</span></div></section>';
  }).join('');
  host.innerHTML = `<div class="pdf-toolbar">
      <div class="pdf-toolbar-info"><strong>${esc(item.pdfName || 'Song-PDF')}</strong><small id="pdfPageStatus">${pages} Seite${pages === 1 ? '' : 'n'}</small></div>
      <div class="pdf-toolbar-actions">
        <button id="pdfPrevPageBtn" type="button" aria-label="Vorige Seite">◀</button>
        <button id="pdfNextPageBtn" type="button" aria-label="Nächste Seite">▶</button>
        <button id="pdfZoomOutBtn" type="button" aria-label="Kleiner darstellen">−</button>
        <output id="pdfZoomValue">${Math.round(zoom * 100)} %</output>
        <button id="pdfZoomInBtn" type="button" aria-label="Größer darstellen">+</button>
        <a class="pdf-open-link" href="${activePdfObjectUrl}" target="_blank" rel="noopener">↗ Original</a>
      </div>
    </div>
    <div class="pdf-scroll-viewer pdf-pages-stack" id="pdfScrollViewer" style="--pdf-zoom:${zoom}">${cards}</div>`;
  bindPdfViewerControls();
  observePdfPages();
}

function buildPdfFallbackViewer(item) {
  const host = $('#pdfSheet');
  const apple = isAppleTouchDevice();
  state.pdfScroll = { page: 1, pages: 1, fallbackProgress: 0 };
  const body = apple
    ? '<p class="empty">Diese Seite kann das Liedblatt gerade nicht selbst zeichnen. Mit „Original öffnen“ erscheint es im PDF-Viewer des Geräts.</p>'
    : `<div class="pdf-scroll-viewer pdf-pages-stack" id="pdfScrollViewer"><section class="pdf-page-card" data-pdf-page="1"><iframe class="pdf-page-frame pdf-full-document" title="${esc(item.title)} PDF" src="${activePdfObjectUrl}#view=FitH"></iframe></section></div>`;
  host.innerHTML = `<div class="pdf-toolbar">
      <div class="pdf-toolbar-info"><strong>${esc(item.pdfName || 'Song-PDF')}</strong><small>Einfache Ansicht</small></div>
      <div class="pdf-toolbar-actions">
        <a class="pdf-open-link" href="${activePdfObjectUrl}" target="_blank" rel="noopener">↗ Original öffnen</a>
        <button id="pdfRetryBtn" type="button">Erneut laden</button>
      </div>
    </div>${body}`;
  const retry = $('#pdfRetryBtn');
  if (retry) retry.onclick = () => { pdfEnginePromise = null; ensurePdfLoaded(true); };
}

function bindPdfViewerControls() {
  const zoomOut = $('#pdfZoomOutBtn'); if (zoomOut) zoomOut.onclick = () => changePdfZoom(-0.25);
  const zoomIn = $('#pdfZoomInBtn'); if (zoomIn) zoomIn.onclick = () => changePdfZoom(0.25);
  const prev = $('#pdfPrevPageBtn'); if (prev) prev.onclick = () => setPdfPage(state.pdfScroll.page - 1);
  const next = $('#pdfNextPageBtn'); if (next) next.onclick = () => setPdfPage(state.pdfScroll.page + 1);
  const viewer = $('#pdfScrollViewer');
  if (viewer) viewer.onscroll = () => updatePdfPageFromScroll();
}

function changePdfZoom(delta) {
  const next = Math.min(3, Math.max(0.75, Math.round((state.pdfView.zoom + delta) * 4) / 4));
  if (next === state.pdfView.zoom) return;
  state.pdfView.zoom = next;
  localStorage.setItem(STORAGE.pdfZoom, String(next));
  const value = $('#pdfZoomValue'); if (value) value.textContent = `${Math.round(next * 100)} %`;
  const viewer = $('#pdfScrollViewer');
  if (!viewer) return;
  viewer.style.setProperty('--pdf-zoom', String(next));
  refreshPdfPages();
}

function refreshPdfPages() {
  const viewer = $('#pdfScrollViewer');
  if (!viewer || !state.pdfView.doc) return;
  state.pdfView.tasks.forEach(task => { try { task.cancel(); } catch (error) { /* egal */ } });
  state.pdfView.tasks = [];
  viewer.querySelectorAll('[data-pdf-page]').forEach(card => {
    card.dataset.state = '';
    const slot = card.querySelector('.pdf-page-slot');
    if (slot) slot.innerHTML = '<span class="pdf-page-note">wird gezeichnet …</span>';
  });
  observePdfPages();
}

function observePdfPages() {
  const viewer = $('#pdfScrollViewer');
  if (!viewer) return;
  const cards = [...viewer.querySelectorAll('[data-pdf-page]')];
  if (!cards.length) return;
  if (state.pdfView.observer) { try { state.pdfView.observer.disconnect(); } catch (error) { /* egal */ } }
  if (typeof IntersectionObserver === 'undefined') {
    cards.slice(0, 4).forEach(card => renderPdfPage(Number(card.dataset.pdfPage)));
    return;
  }
  const observer = new IntersectionObserver(entries => {
    entries.filter(entry => entry.isIntersecting).forEach(entry => {
      const number = Number(entry.target.dataset.pdfPage) || 1;
      renderPdfPage(number);
      renderPdfPage(number + 1);
    });
  }, { root: viewer, rootMargin: '500px 0px' });
  cards.forEach(card => observer.observe(card));
  state.pdfView.observer = observer;
  renderPdfPage(1);
}

async function renderPdfPage(number) {
  const doc = state.pdfView.doc;
  if (!doc || number < 1 || number > (doc.numPages || 0)) return;
  const viewer = $('#pdfScrollViewer');
  const card = viewer?.querySelector(`[data-pdf-page="${number}"]`);
  if (!card || card.dataset.state === 'ready' || card.dataset.state === 'rendering') return;
  card.dataset.state = 'rendering';
  const slot = card.querySelector('.pdf-page-slot') || card;
  let task = null;
  try {
    const page = await doc.getPage(number);
    const base = page.getViewport({ scale: 1 });
    const cssWidth = Math.max(200, slot.clientWidth || card.clientWidth || 640);
    const density = Math.min(window.devicePixelRatio || 1, 2);
    let scale = (cssWidth / base.width) * density;
    const maxPixels = 5.2e6;
    const pixels = base.width * scale * base.height * scale;
    if (pixels > maxPixels) scale *= Math.sqrt(maxPixels / pixels);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-page-canvas';
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    task = page.render({ canvasContext: context, viewport });
    state.pdfView.tasks.push(task);
    await task.promise;
    slot.replaceChildren(canvas);
    card.dataset.state = 'ready';
    page.cleanup?.();
  } catch (error) {
    if (error?.name === 'RenderingCancelledException') { card.dataset.state = ''; return; }
    console.warn(`Seite ${number} konnte nicht gezeichnet werden`, error);
    card.dataset.state = 'error';
    slot.innerHTML = '<span class="pdf-page-note">Diese Seite lässt sich nicht darstellen.</span>';
  } finally {
    if (task) state.pdfView.tasks = state.pdfView.tasks.filter(entry => entry !== task);
  }
}

function updatePdfPageFromScroll() {
  const viewer = $('#pdfScrollViewer');
  if (!viewer) return;
  const cards = [...viewer.querySelectorAll('[data-pdf-page]')];
  if (!cards.length) return;
  const center = viewer.scrollTop + viewer.clientHeight * 0.35;
  const current = cards.reduce((best, card) => Math.abs(card.offsetTop - center) < Math.abs(best.offsetTop - center) ? card : best, cards[0]);
  state.pdfScroll.page = Number(current.dataset.pdfPage) || 1;
  updatePdfPageStatus();
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
  if (name === 'pdf') ensurePdfLoaded();
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
function openFootswitchSettings() { state.learningFootswitch = null; updateFootswitchUI(); $('#footswitchStatus').textContent = 'Zum Testen Player öffnen und Pedal drücken.'; openDialog('#footswitchDialog'); }
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

function openEditor() { const item = song(state.currentId); if (!item) return; $('#editTitle').value = item.title || ''; $('#editArtist').value = item.artist || ''; $('#editChordieUrl').value = item.source?.url || item.chordieUrl || ''; $('#editBpm').value = item.bpm || ''; $('#editCapo').value = item.capo ?? ''; $('#editSinger').value = item.singer || ''; $('#editNotes').value = item.notes || ''; $('#editContent').value = item.content || item.lyrics || ''; updateEditorPdfStatus(item); openDialog('#songEditor'); }

function updateEditorPdfStatus(item = song(state.currentId)) {
  const status = $('#editPdfStatus'), remove = $('#removePdfBtn'), attach = $('#attachPdfBtn');
  if (!status || !remove || !attach) return;
  const hasPdf = !!item?.pdfAttachment;
  status.textContent = hasPdf ? `Gespeichert: ${item.pdfName || 'Song-PDF'}` : 'Kein PDF hinterlegt.';
  remove.disabled = !hasPdf;
  attach.textContent = hasPdf ? 'PDF ersetzen' : '+ PDF hinzufügen';
}

function promptPdfForCurrentSong() {
  if (!state.currentId || !song(state.currentId)) { showToast('Bitte zuerst einen Song öffnen'); return; }
  const input = $('#attachPdfInput');
  if (!input) return;
  input.value = '';
  input.click();
}

async function handlePdfAttachmentSelection(event) {
  const file = event.target.files?.[0];
  const id = state.currentId;
  if (!file || !id) return;
  if (!(file.type === 'application/pdf' || /\.pdf$/i.test(file.name))) { showToast('Bitte eine PDF-Datei auswählen', 'error'); event.target.value = ''; return; }
  try {
    await savePdfBlob(id, file);
    state.overrides[id] = { ...(state.overrides[id] || {}), pdfAttachment: true, pdfName: file.name };
    saveOverrides();
    const updated = song(id);
    updateEditorPdfStatus(updated);
    preparePdfPanel(updated);
    if (!$('#songEditor').open) setPlayerPanel('pdf');
    showToast(`Liedblatt „${file.name}“ gespeichert`, 'success');
  } catch (error) {
    showToast(`PDF konnte nicht gespeichert werden: ${error.message}`, 'error');
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
    preparePdfPanel(updated);
    setPlayerPanel('lyrics');
    showToast('Liedblatt entfernt');
  } catch (error) {
    showToast(`PDF konnte nicht entfernt werden: ${error.message}`, 'error');
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
  const items=Array.isArray(data)?data:[data];
  const valid=items.filter(item=>item&&item.title&&(item.content||item.lyrics||item.pdfAttachment));
  if(!valid.length) throw new Error('Kein Songformat erkannt.');
  const libraryId=`lib-import-${Date.now().toString(36)}`;
  const songs=valid.map(item=>{
    const id=uniqueSongId(item.id?String(item.id):slugify(`${item.title}-${item.artist||''}`));
    return enrichImportedSong({...item,id,library:libraryId,pdfAttachment:false},filename,'JSON-Import');
  });
  state.libraries.push({id:libraryId,name:`Import: ${cleanImportFilename(filename)}`,importedAt:new Date().toISOString(),count:songs.length});
  state.importedSongs.push(...songs); markSongsNew(songs.map(s=>s.id)); saveLibraries(); renderLibraryFilterOptions(); renderLibrariesManager(); renderAll();
  alert(`${songs.length} Song(s) importiert. Neue Songs sind mit „NEU“ markiert.`);
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
  if (data.songSpeeds && typeof data.songSpeeds === 'object') { state.songSpeeds = data.songSpeeds; saveSongSpeeds(); } if (data.metronomeSettings && typeof data.metronomeSettings === 'object') { state.metronomeSettings = data.metronomeSettings; localStorage.setItem(STORAGE.metronome, JSON.stringify(state.metronomeSettings)); } if(Array.isArray(data.newSongIds)){state.newSongIds=new Set(data.newSongIds);saveNewSongIds();}
  saveOverrides();saveSetlists();saveFavorites();applySettings();renderAll();showToast('Backup importiert', 'success');
}

function exportData() { const data = { version: "9.7.0", annotations: state.annotations, exportedAt: new Date().toISOString(), overrides: state.overrides, setlists: state.setlists, activeSetlistId: state.activeSetlistId, favorites: [...state.favorites], display: safeParse(localStorage.getItem(STORAGE.display), {}), songSpeeds: state.songSpeeds, metronomeSettings: state.metronomeSettings, newSongIds:[...state.newSongIds], speed: state.scrollSpeed }; const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'aussteiger-bandapp-v9-7-0-backup.json'; link.click(); URL.revokeObjectURL(link.href); showToast('Backup wurde erstellt', 'success'); }
async function importData(event) { const file = event.target.files?.[0]; if (!file) return; try { const data = JSON.parse(await file.text()); if (data.overrides && typeof data.overrides === 'object') state.overrides = data.overrides; if (Array.isArray(data.setlists)) state.setlists = normalizeSetlists(data.setlists); else if (Array.isArray(data.setlist)) activeSetlist().songs = data.setlist; if (Array.isArray(data.favorites)) state.favorites = new Set(data.favorites); if (data.activeSetlistId && state.setlists.some(list => list.id === data.activeSetlistId)) state.activeSetlistId = data.activeSetlistId; if (data.display) localStorage.setItem(STORAGE.display, JSON.stringify(data.display)); if (data.songSpeeds && typeof data.songSpeeds === 'object') { state.songSpeeds = data.songSpeeds; saveSongSpeeds(); } if (data.metronomeSettings && typeof data.metronomeSettings === 'object') { state.metronomeSettings = data.metronomeSettings; localStorage.setItem(STORAGE.metronome, JSON.stringify(state.metronomeSettings)); } if(Array.isArray(data.newSongIds)){state.newSongIds=new Set(data.newSongIds);saveNewSongIds();} saveOverrides(); saveSetlists(); saveFavorites(); applySettings(); renderAll(); showToast('Import erfolgreich', 'success'); } catch (error) { alert(`Import fehlgeschlagen: ${error.message}`); } finally { event.target.value = ''; } }

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
  if (!status) return;
  status.textContent = state.pdfScroll.pages
    ? `Seite ${state.pdfScroll.page} / ${state.pdfScroll.pages}`
    : `Seite ${state.pdfScroll.page}`;
}

function setPdfPage(page) {
  const max=state.pdfScroll.pages||1;
  state.pdfScroll.page=Math.max(1,Math.min(max,page));
  const viewer=$('#pdfScrollViewer'), el=viewer?.querySelector(`[data-pdf-page="${state.pdfScroll.page}"]`);
  if(el) viewer.scrollTo({top:el.offsetTop-viewer.offsetTop,behavior:'smooth'});
  updatePdfPageStatus();
}

function scrollPdfBy(distance) {
  const viewer=$('#pdfScrollViewer'); if(!viewer) return true;
  const before=viewer.scrollTop; viewer.scrollTop+=distance;
  const cards=[...viewer.querySelectorAll('[data-pdf-page]')];
  if(cards.length){
    const center=viewer.scrollTop+viewer.clientHeight*.35;
    const current=cards.reduce((best,el)=>Math.abs(el.offsetTop-center)<Math.abs(best.offsetTop-center)?el:best,cards[0]);
    state.pdfScroll.page=Number(current.dataset.pdfPage)||1;
  }
  return viewer.scrollTop+viewer.clientHeight>=viewer.scrollHeight-3 || (viewer.scrollTop===before && distance>0);
}

function scrollActiveToTop() {
  if (activePanelName() === 'pdf') { state.pdfScroll.fallbackProgress = 0; state.pdfScroll.page=1; $('#pdfScrollViewer')?.scrollTo({top:0,behavior:'smooth'}); return; }
  const panel = activeScrollPanel(); if (panel) panel.scrollTo({ top: 0, behavior: 'smooth' });
}


function syncMetronomeTool(){
  const m=currentMetronomeSettings();
  if($('#toolMetronomeBpm')) $('#toolMetronomeBpm').value=m.bpm;
  if($('#toolMetronomeBpmValue')) $('#toolMetronomeBpmValue').textContent=m.bpm;
  if($('#toolMetronomeMeter')) $('#toolMetronomeMeter').value=String(m.meter);
  if($('#toolMetronomeSound')) $('#toolMetronomeSound').checked=m.sound;
  if($('#toolMetronomeSong')) {
    const item=song(state.currentId);
    $('#toolMetronomeSong').textContent=item ? `Aktueller Song: ${item.title}${item.artist?` · ${item.artist}`:''}` : 'Kein Song geöffnet.';
  }
  renderToolMetronomeBeats(m.meter,state.metronomeBeat);
  if($('#toolMetronomeStartBtn')) $('#toolMetronomeStartBtn').textContent=state.metronomeRunning?'⏸ Stop':'▶ Start';
}
function renderToolMetronomeBeats(meter,active=0){
  const host=$('#toolMetronomeBeatDisplay'); if(!host) return;
  host.innerHTML=Array.from({length:meter},(_,i)=>`<i class="${i===active?'active':''}"></i>`).join('');
}
function updateMetronomeFromTool(){
  const item=song(state.currentId);
  const bpm=Math.max(30,Math.min(260,Number($('#toolMetronomeBpm').value)||100));
  const meter=[3,4,6].includes(Number($('#toolMetronomeMeter').value))?Number($('#toolMetronomeMeter').value):4;
  const sound=$('#toolMetronomeSound').checked;
  if(item){ state.metronomeSettings[item.id]={bpm,meter,sound}; saveMetronomeState(); }
  if($('#metronomeBpm')) $('#metronomeBpm').value=bpm;
  if($('#metronomeMeter')) $('#metronomeMeter').value=String(meter);
  if($('#metronomeSound')) $('#metronomeSound').checked=sound;
  $('#toolMetronomeBpmValue').textContent=bpm;
  if(state.metronomeRunning){ stopMetronome(); startMetronome(); }
  syncMetronomeTool();
}
function tapTempoTool(){
  const now=performance.now(); state.tapTimes=[...state.tapTimes.filter(t=>now-t<2500),now].slice(-5);
  if(state.tapTimes.length>=2){
    const intervals=state.tapTimes.slice(1).map((t,i)=>t-state.tapTimes[i]);
    const avg=intervals.reduce((a,b)=>a+b,0)/intervals.length;
    $('#toolMetronomeBpm').value=Math.max(30,Math.min(260,Math.round(60000/avg)));
    updateMetronomeFromTool();
  }
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
  renderMetronomeBeats(m.meter, state.metronomeBeat); renderToolMetronomeBeats(m.meter,state.metronomeBeat); metronomeClick(state.metronomeBeat === 0);
  state.metronomeBeat = (state.metronomeBeat + 1) % m.meter;
  state.metronomeTimer = setTimeout(metronomeTick, 60000 / m.bpm);
}
function startMetronome() {
  if (state.metronomeRunning) return; ensureMetronomeAudio(); state.metronomeRunning = true; state.metronomeBeat = 0; metronomeTick();
  $('#metronomeStartBtn').textContent = '⏸ Metronom'; $('#miniMetronomeBtn').textContent = '⏸'; $('#miniMetronomeBtn').classList.add('primary'); syncMetronomeTool();
}
function stopMetronome() {
  state.metronomeRunning = false; clearTimeout(state.metronomeTimer); state.metronomeTimer = null;
  $('#metronomeStartBtn').textContent = '▶ Metronom'; $('#miniMetronomeBtn').textContent = '♩'; $('#miniMetronomeBtn').classList.remove('primary'); renderMetronomeBeats(currentMetronomeSettings().meter, 0); syncMetronomeTool();
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
function openGigStartDialog(){
  fillSetlistSelect($('#gigSetlistSelect'));
  updateGigSetlistInfo();
  openDialog('#gigStartDialog');
}
function updateGigSetlistInfo(){
  const list=state.setlists.find(x=>x.id===$('#gigSetlistSelect')?.value);
  if($('#gigSetlistInfo')) $('#gigSetlistInfo').textContent=list ? `${list.songs.filter(id=>song(id)).length} Songs · ${list.description || 'keine Beschreibung'}` : '';
}
async function confirmGigStart(){
  const id=$('#gigSetlistSelect').value;
  const list=state.setlists.find(x=>x.id===id);
  if(!list) return;
  state.activeSetlistId=id; saveSetlists(); renderAll();
  const first=list.songs.find(song);
  if(first) await openSong(first,false);
  $('#gigStartDialog').close();
  state.live.gigMode=true;
  document.body.classList.add('gig-mode');
  $('#gigModeBtn').textContent='⏹ Gig beenden';
  $('#gigExitBar').hidden=false;
  switchView('player');
  setPlayerPanel(isPdfOnlySong(song(first)) ? 'pdf' : 'lyrics');
  setTransportCollapsed(true,false);
  updatePlayerLayout();
}
function endGig(){
  state.live.gigMode=false;
  document.body.classList.remove('gig-mode','playback-focus');
  $('#gigModeBtn').textContent='Gig-Modus';
  $('#gigExitBar').hidden=true;
  stopScroll();
  setTransportCollapsed(false,false);
  switchView('dashboard');
}
function toggleGigMode(){
  if(state.live.gigMode) endGig();
  else openGigStartDialog();
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
  setPdfPage((state.pdfScroll.page||1)+delta);
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


const TUNER_NOTES=['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
function autoCorrelate(buffer,sampleRate){
  let rms=0; for(let i=0;i<buffer.length;i++) rms+=buffer[i]*buffer[i];
  rms=Math.sqrt(rms/buffer.length); if(rms<0.012) return -1;
  let r1=0,r2=buffer.length-1,threshold=.2;
  for(let i=0;i<buffer.length/2;i++){ if(Math.abs(buffer[i])<threshold){r1=i;break;} }
  for(let i=1;i<buffer.length/2;i++){ if(Math.abs(buffer[buffer.length-i])<threshold){r2=buffer.length-i;break;} }
  const buf=buffer.slice(r1,r2), c=new Array(buf.length).fill(0);
  for(let lag=0;lag<buf.length;lag++) for(let i=0;i<buf.length-lag;i++) c[lag]+=buf[i]*buf[i+lag];
  let d=0; while(d+1<c.length && c[d]>c[d+1]) d++;
  let max=-1,maxpos=-1; for(let i=d;i<c.length;i++){if(c[i]>max){max=c[i];maxpos=i;}}
  if(maxpos<=0) return -1;
  return sampleRate/maxpos;
}
function updateTunerDisplay(freq){
  if(!(freq>20&&freq<2000)){ $('#tunerStatus').textContent='Saite anschlagen …'; return; }
  const midi=69+12*Math.log2(freq/440), rounded=Math.round(midi), cents=Math.round((midi-rounded)*100);
  const note=TUNER_NOTES[(rounded%12+12)%12], octave=Math.floor(rounded/12)-1;
  $('#tunerNote').textContent=`${note}${octave}`;
  $('#tunerFrequency').textContent=freq.toFixed(1);
  $('#tunerCents').textContent=`${cents>0?'+':''}${cents} Cent`;
  $('#tunerNeedle').style.transform=`translateX(${Math.max(-50,Math.min(50,cents))}%)`;
  $('#tunerStatus').textContent=Math.abs(cents)<=5?'✓ Sauber gestimmt':cents<0?'Zu tief – höher stimmen':'Zu hoch – tiefer stimmen';
  $('.tuner-card')?.classList.toggle('in-tune',Math.abs(cents)<=5);
}
async function startTuner(){
  if(state.tuner.stream) return;
  if(!navigator.mediaDevices?.getUserMedia){ $('#tunerStatus').textContent='Mikrofonzugriff wird von diesem Browser nicht unterstützt.'; return; }
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
    const Ctx=window.AudioContext||window.webkitAudioContext, ctx=new Ctx(), analyser=ctx.createAnalyser();
    analyser.fftSize=2048; ctx.createMediaStreamSource(stream).connect(analyser);
    state.tuner={stream,ctx,analyser,raf:null,buffer:new Float32Array(analyser.fftSize)};
    $('#tunerStartBtn').disabled=true; $('#tunerStopBtn').disabled=false; $('#tunerStatus').textContent='Mikrofon aktiv – Saite anschlagen.';
    const loop=()=>{ if(!state.tuner.analyser)return; state.tuner.analyser.getFloatTimeDomainData(state.tuner.buffer); updateTunerDisplay(autoCorrelate(state.tuner.buffer,ctx.sampleRate)); state.tuner.raf=requestAnimationFrame(loop); };
    loop();
  }catch(error){ $('#tunerStatus').textContent=`Mikrofon nicht verfügbar: ${error.message}`; }
}
function stopTuner(){
  if(state.tuner.raf) cancelAnimationFrame(state.tuner.raf);
  state.tuner.stream?.getTracks().forEach(t=>t.stop()); state.tuner.ctx?.close?.();
  state.tuner={stream:null,ctx:null,analyser:null,raf:null,buffer:null};
  $('#tunerStartBtn').disabled=false; $('#tunerStopBtn').disabled=true; $('#tunerStatus').textContent='Mikrofon ist noch nicht aktiv.';
  $('#tunerNote').textContent='–'; $('#tunerFrequency').textContent='–'; $('#tunerCents').textContent='0 Cent'; $('#tunerNeedle').style.transform='translateX(0)';
}

const TUTORIAL_KEY = 'band-v970-tutorial-seen';
const TUTORIAL_STEPS = [
  { view:'dashboard', target:'#dashboardView', icon:'🏠', title:'Übersicht', text:'Die App startet auf dem Dashboard. Hier findest du Setliste, letzten Song, Bibliothek, Favoriten und den Gig-Start.' },
  { view:'dashboard', target:'#dashboardGigBtn', icon:'🎤', title:'Gig starten', text:'Beim Gig-Start wählst du zuerst die Setliste. Danach öffnet die App deren ersten Song im reduzierten Live-Modus.' },
  { view:'library', target:'#backBtn', icon:'↩', title:'Immer eine Ebene zurück', text:'Oben links führt der Zurück-Pfeil von jeder Seite eine Ebene nach oben. Er schließt auch offene Fenster und funktioniert zusammen mit der Zurück-Taste bzw. Wischgeste des Geräts.' },
  { view:'setlists', target:'#setlistSelect', icon:'📋', title:'Setlisten', text:'Wähle eine aktive Setliste und ändere die Reihenfolge per Drag & Drop.' },
  { view:'setlists', target:'#addSongBtn', icon:'➕', title:'Songs in die Setliste', text:'„+ Song hinzufügen“ öffnet direkt die Liste aller Songs. Dort suchen, filtern und antippen – ein zweiter Tipp entfernt den Song wieder.' },
  { view:'library', target:'#library', icon:'➕', title:'Song zu einer Setliste', text:'Bei + Setliste wählst du jetzt immer die gewünschte Ziel-Setliste – unabhängig davon, welche gerade aktiv ist.' },
  { view:'setlists', target:'#exportSetlistBtn', icon:'↗', title:'Setliste teilen', text:'Setlisten können als Datei weitergegeben und auf anderen Geräten wieder importiert werden.' },
  { view:'player', target:'.player-tabs', icon:'🎤', title:'Player', text:'Song, Tabs, Notizen und PDF sind getrennte Ansichten für eine mobile, übersichtliche Darstellung.' },
  { view:'player', panel:'tabs', target:'#tabSheet', icon:'🎸', title:'Tabs', text:'Tabs bleiben in Monospace-Schrift, lassen sich seitlich wischen und werden nicht mehr in den Lyrics umgebrochen.' },
  { view:'player', panel:'pdf', target:'#pdfSheet', icon:'📄', title:'PDF-Liedblätter', text:'Liedblätter werden direkt in der App gezeichnet – alle Seiten untereinander, mit Zoom und Autoscroll. Songs, die nur aus einem PDF bestehen, öffnen sofort in diesem Reiter.' },
  { view:'player', panel:'lyrics', target:'#liveTools', icon:'🎤', title:'Live Performance', text:'Gig-Modus, Count-in und Sprungmarken bündeln die Bühnensteuerung.' },
  { view:'player', target:'#gigModeBtn', icon:'⏹', title:'Gig beenden', text:'Im Gig-Modus gibt es zusätzlich einen deutlich sichtbaren „Gig beenden“-Button in der reduzierten Player-Steuerung.' },
  { view:'player', target:'#countInControls', icon:'⏱', title:'Count-in', text:'Einzählen mit 1, 2 oder 4 Takten; optional startet danach automatisch der Autoscroll.' },
  { view:'player', target:'#sectionJumpBar', icon:'📍', title:'Sprungmarken', text:'Springe schnell zu Intro, Refrain, Solo, Bridge oder Outro.' },
  { view:'player', target:'#startStopBtn', icon:'▶️', title:'Autoscroll', text:'Die Scrollgeschwindigkeit wird für jeden Song individuell gespeichert.' },
  { view:'metronome', target:'#metronomeView', icon:'♩', title:'Metronom als Tool', text:'Das Metronom ist jetzt direkt im Hauptmenü erreichbar. BPM, Tap Tempo, Taktart und Ton können hier unabhängig vom Player bedient werden.' },
  { view:'tuner', target:'#tunerView', icon:'🎸', title:'Stimmgerät', text:'Das chromatische Stimmgerät nutzt nach deiner Freigabe das Mikrofon und zeigt Note, Frequenz und Cent-Abweichung.' },
  { view:'player', panel:'lyrics', target:'.song-tools', icon:'♯', title:'Akkorde', text:'Akkorde lassen sich live transponieren und farblich anpassen.' },
  { view:'player', target:'#editSongBtn', icon:'✎', title:'Song bearbeiten', text:'Lyrics, Akkorde, SOT/EOT-Tabs, Notizen, BPM, Capo und PDF können direkt am Song bearbeitet werden.' },
  { view:'player', target:'#footswitchSettingsBtn', action:'footswitch', icon:'🦶', title:'Fußschalter', text:'Pedaltasten können Play, Songwechsel, Metronom, Count-in, Abschnitte und PDF-Seiten steuern.' },
  { view:'import', target:'#importView', icon:'📥', title:'Songs importieren', text:'Der Import ist jetzt eine eigene Hauptmenü-Seite. Du kannst mehrere Dateien gleichzeitig auswählen oder hineinziehen.' },
  { view:'import', target:'#mainImportSongsFile', icon:'🆕', title:'Neue Songs', text:'Für jede erkannte Datei wird ein Song angelegt. Titel und Metadaten werden soweit möglich automatisch übernommen. Neu importierte Songs tragen „NEU“, bis du sie erstmals öffnest.' },
  { view:'dashboard', target:'#dashboardView', icon:'✅', title:'Bereit', text:'Damit sind die wichtigsten Probe- und Bühnenfunktionen eingerichtet. Das Tutorial kannst du jederzeit im Menü erneut starten.' }
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
function finishTutorial(){ localStorage.setItem(TUTORIAL_KEY,'1'); const overlay=$('#tutorialOverlay'); overlay.hidden=true; overlay.classList.remove('has-target'); $('#tutorialCard')?.classList.remove('tutorial-card-top'); $$('.tutorial-highlight').forEach(el=>el.classList.remove('tutorial-highlight')); switchView('dashboard'); }
let pdfResizeTimer = null;
window.addEventListener('resize',()=>{
  updatePlayerLayout();
  if(!$('#tutorialOverlay')?.hidden) showTutorialStep();
  if(state.pdfView.doc){
    clearTimeout(pdfResizeTimer);
    pdfResizeTimer = setTimeout(() => { if (state.pdfView.doc) refreshPdfPages(); }, 320);
  }
});
window.addEventListener('orientationchange',()=>setTimeout(updatePlayerLayout,120));
document.addEventListener('click',e=>{ if(e.target?.id==='tutorialNextBtn'){ tutorialIndex++; showTutorialStep(); } if(e.target?.id==='tutorialBackBtn'){ tutorialIndex=Math.max(0,tutorialIndex-1); showTutorialStep(); } if(e.target?.id==='tutorialSkipBtn') finishTutorial(); });
setTimeout(()=>startTutorial(false),2600);

init();
