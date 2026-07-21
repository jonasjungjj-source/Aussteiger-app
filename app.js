const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const STORAGE = {
  setlists: 'band-v4-setlists',
  activeSetlist: 'band-v4-active-setlist',
  current: 'band-current',
  speed: 'band-speed',
  display: 'band-display',
  overrides: 'band-song-overrides',
  favorites: 'band-v4-favorites',
  libraries: 'band-v6-libraries',
  importedSongs: 'band-v6-imported-songs'
};

const state = {
  songs: [], baseSongs: [], defaultSetlists: [], setlists: [], activeSetlistId: '',
  currentId: localStorage.getItem(STORAGE.current),
  scrollSpeed: Number(localStorage.getItem(STORAGE.speed) || 45),
  scrolling: false, lastTs: 0, overrides: {}, favorites: new Set(),
  libraries: [], importedSongs: []
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
      const text = await file.text();
      const lower = file.name.toLowerCase();
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
      } else if (lower.endsWith('.cho') || lower.endsWith('.crd') || lower.endsWith('.pro') || lower.endsWith('.chopro') || lower.endsWith('.txt')) {
        const song = parseChordProText(text, file.name);
        const id = uniqueSongId(slugify(`${song.title}-${song.artist}`));
        newSongs.push({ id, library: libraryId, ...song, tags: [] });
      } else { failCount += 1; }
    } catch (error) { failCount += 1; console.error(error); }
  }
  if (!newSongs.length) { alert('Keine passenden Songs gefunden. Unterstützt werden .json, .cho, .crd, .pro und .txt Dateien.'); return; }
  state.libraries.push({ id: libraryId, name: libraryName.trim(), importedAt: new Date().toISOString(), count: newSongs.length });
  state.importedSongs.push(...newSongs);
  saveLibraries(); renderAll(); renderLibraryFilterOptions();
  alert(`${newSongs.length} Song(s) in neue Bibliothek „${libraryName.trim()}“ importiert${failCount ? ` (${failCount} Datei(en) übersprungen)` : ''}.`);
}

function removeLibrary(libraryId) {
  const lib = state.libraries.find(item => item.id === libraryId); if (!lib) return;
  if (!confirm(`Bibliothek „${lib.name}“ und ihre ${lib.count} Song(s) wirklich löschen?`)) return;
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
    loadLocalState(); mergeSongs(); bindUI(); applySettings(); renderLibraryFilterOptions(); renderLibrariesManager(); renderAll();
    const initial = song(state.currentId) ? state.currentId : activeSetlist()?.songs.find(id => song(id)) || state.songs[0]?.id;
    if (initial) await openSong(initial, false);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register(new URL('./service-worker.js', document.baseURI), { scope: './' }).catch(console.error);
    dismissSplash();
  } catch (error) {
    $('#errorBanner').hidden = false;
    $('#errorBanner').textContent = `App konnte nicht geladen werden: ${error.message}`;
    console.error(error);
  }
}

function bindUI() {
  $('#menuBtn').onclick = openDrawer; $('#backdrop').onclick = closeDrawer;
  $$('.nav-item').forEach(button => button.onclick = () => switchView(button.dataset.view));
  $('#settingsBtn').onclick = () => $('#displaySettings').showModal();
  $('#setlistSelect').onchange = event => { state.activeSetlistId = event.target.value; saveSetlists(); renderAll(); };
  $('#newSetlistBtn').onclick = createSetlist; $('#renameSetlistBtn').onclick = renameSetlist; $('#deleteSetlistBtn').onclick = deleteSetlist;
  $('#addSongBtn').onclick = () => { renderPicker(); $('#songPicker').showModal(); };
  $('#resetSetlistBtn').onclick = resetActiveSetlist;
  $('#searchInput').oninput = renderLibrary; $('#libraryFilter').onchange = renderLibrary;
  $('#favoriteSearch').oninput = renderFavorites; $('#pickerSearch').oninput = renderPicker;
  $('#startStopBtn').onclick = toggleScroll; $('#toTopBtn').onclick = () => scrollTo({ top: 0, behavior: 'smooth' });
  $('#prevSongBtn').onclick = () => stepSong(-1); $('#nextSongBtn').onclick = () => stepSong(1);
  $('#favoriteCurrentBtn').onclick = () => toggleFavorite(state.currentId);
  $('#editSongBtn').onclick = openEditor; $('#saveSongBtn').onclick = saveEditedSong; $('#deleteOverrideBtn').onclick = deleteOverride;
  $('#exportBtn').onclick = exportData; $('#importFile').onchange = importData;
  $('#importSongsFile').onchange = event => { importSongFiles(event.target.files); event.target.value = ''; };
  $('#speedRange').value = state.scrollSpeed; $('#speedValue').textContent = `${state.scrollSpeed} px/s`;
  $('#speedRange').oninput = event => { state.scrollSpeed = Number(event.target.value); $('#speedValue').textContent = `${state.scrollSpeed} px/s`; localStorage.setItem(STORAGE.speed, String(state.scrollSpeed)); };
  ['darkToggle','contrastToggle','fontRange','lineRange'].forEach(id => $(`#${id}`).oninput = saveSettings);
  $('#fullscreenBtn').onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopScroll(); });
}

function renderAll() { renderSetlistSelect(); renderSetlist(); renderLibrary(); renderFavorites(); updateFavoriteButton(); }
function openDrawer() { $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false'); $('#backdrop').hidden = false; }
function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); $('#backdrop').hidden = true; }
function switchView(name) {
  $$('.view').forEach(view => view.classList.remove('active')); $(`#${name}View`).classList.add('active');
  $$('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  $('#viewTitle').textContent = { setlists:'Setlisten', library:'Alle Songs', favorites:'Favoriten', player:'Player', about:'Hinweise' }[name]; closeDrawer();
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
    const item = song(id); const li = document.createElement('li'); li.className = 'song-row';
    li.innerHTML = `<button class="song-main"><span class="number">${index + 1}</span><span><strong>${esc(item.title)}</strong><small>${esc(item.artist)}${meta(item) ? ` · ${esc(meta(item))}` : ''}</small></span></button><div class="row-actions"><button class="favorite" aria-label="Favorit">${state.favorites.has(id) ? '★' : '☆'}</button><button class="move-up" aria-label="Nach oben">↑</button><button class="move-down" aria-label="Nach unten">↓</button><button class="remove" aria-label="Entfernen">✕</button></div>`;
    li.querySelector('.song-main').onclick = () => openSong(id); li.querySelector('.favorite').onclick = () => toggleFavorite(id);
    li.querySelector('.move-up').onclick = () => moveSong(index, -1); li.querySelector('.move-down').onclick = () => moveSong(index, 1);
    li.querySelector('.remove').onclick = () => { list.songs.splice(index, 1); saveSetlists(); renderAll(); };
    host.append(li);
  });
}

function moveSong(index, delta) { const list = activeSetlist(); const target = index + delta; if (!list || target < 0 || target >= list.songs.length) return; [list.songs[index], list.songs[target]] = [list.songs[target], list.songs[index]]; saveSetlists(); renderAll(); }

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
  $('#songTitle').textContent = item.title; $('#songMeta').textContent = [item.artist, item.genre, meta(item)].filter(Boolean).join(' · ');
  $('#songSheet').innerHTML = renderSong(item.content || item.lyrics || 'Noch kein Songblatt eingetragen. Tippe auf „Bearbeiten“.'); updateFavoriteButton(); scrollTo({ top: 0 }); if (changeView) switchView('player');
}

function renderSong(text) { return String(text).split('\n').map(line => { const trimmed = line.trim(); if (!trimmed) return '<div class="blank"></div>'; if (/^\[.+\]$/.test(trimmed)) return `<h3 class="section-label">${esc(trimmed.slice(1, -1))}</h3>`; const rendered = esc(line).replace(/\[([A-G][#b]?(?:m|maj|min|sus|dim|aug|add)?\d*(?:\/[A-G][#b]?)?)\]/g, '<span class="chord">$1</span>'); return `<div class="lyric-line">${rendered}</div>`; }).join(''); }
function stepSong(delta) { const order = activeSetlist()?.songs.filter(id => song(id)) || []; const fallback = state.songs.map(item => item.id); const ids = order.includes(state.currentId) ? order : fallback; if (!ids.length) return; let index = ids.indexOf(state.currentId); if (index < 0) index = 0; openSong(ids[(index + delta + ids.length) % ids.length]); }

function openEditor() { const item = song(state.currentId); if (!item) return; $('#editTitle').value = item.title || ''; $('#editArtist').value = item.artist || ''; $('#editBpm').value = item.bpm || ''; $('#editCapo').value = item.capo ?? ''; $('#editSinger').value = item.singer || ''; $('#editContent').value = item.content || item.lyrics || ''; $('#songEditor').showModal(); }
function saveEditedSong() { const id = state.currentId; if (!id) return; state.overrides[id] = { title: $('#editTitle').value.trim(), artist: $('#editArtist').value.trim(), bpm: Number($('#editBpm').value) || undefined, capo: $('#editCapo').value === '' ? undefined : Number($('#editCapo').value), singer: $('#editSinger').value.trim(), content: $('#editContent').value }; saveOverrides(); $('#songEditor').close(); renderAll(); openSong(id, false); }
function deleteOverride() { const id = state.currentId; if (!id || !state.overrides[id] || !confirm('Lokale Änderungen für diesen Song löschen?')) return; delete state.overrides[id]; saveOverrides(); $('#songEditor').close(); renderAll(); openSong(id, false); }

function exportData() { const data = { version: 4, exportedAt: new Date().toISOString(), overrides: state.overrides, setlists: state.setlists, activeSetlistId: state.activeSetlistId, favorites: [...state.favorites], display: safeParse(localStorage.getItem(STORAGE.display), {}), speed: state.scrollSpeed }; const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'aussteiger-bandapp-v4-backup.json'; link.click(); URL.revokeObjectURL(link.href); }
async function importData(event) { const file = event.target.files?.[0]; if (!file) return; try { const data = JSON.parse(await file.text()); if (data.overrides && typeof data.overrides === 'object') state.overrides = data.overrides; if (Array.isArray(data.setlists)) state.setlists = normalizeSetlists(data.setlists); else if (Array.isArray(data.setlist)) activeSetlist().songs = data.setlist; if (Array.isArray(data.favorites)) state.favorites = new Set(data.favorites); if (data.activeSetlistId && state.setlists.some(list => list.id === data.activeSetlistId)) state.activeSetlistId = data.activeSetlistId; if (data.display) localStorage.setItem(STORAGE.display, JSON.stringify(data.display)); if (data.speed) { state.scrollSpeed = Number(data.speed); localStorage.setItem(STORAGE.speed, String(state.scrollSpeed)); } saveOverrides(); saveSetlists(); saveFavorites(); applySettings(); renderAll(); alert('Import erfolgreich.'); } catch (error) { alert(`Import fehlgeschlagen: ${error.message}`); } finally { event.target.value = ''; } }

function toggleScroll() { state.scrolling ? stopScroll() : startScroll(); }
function startScroll() { state.scrolling = true; state.lastTs = performance.now(); $('#startStopBtn').textContent = '⏸ Pause'; requestAnimationFrame(scrollFrame); }
function stopScroll() { state.scrolling = false; $('#startStopBtn').textContent = '▶ Start'; }
function scrollFrame(timestamp) { if (!state.scrolling) return; const delta = Math.min((timestamp - state.lastTs) / 1000, 0.1); state.lastTs = timestamp; scrollBy(0, state.scrollSpeed * delta); if (innerHeight + scrollY >= document.documentElement.scrollHeight - 4) { stopScroll(); return; } requestAnimationFrame(scrollFrame); }

function applySettings() { const settings = safeParse(localStorage.getItem(STORAGE.display), {}); document.documentElement.classList.toggle('dark', !!settings.dark); document.documentElement.classList.toggle('contrast', !!settings.contrast); document.documentElement.style.setProperty('--sheet-font', `${settings.font || 26}px`); document.documentElement.style.setProperty('--sheet-line', String((settings.line || 160) / 100)); $('#darkToggle').checked = !!settings.dark; $('#contrastToggle').checked = !!settings.contrast; $('#fontRange').value = settings.font || 26; $('#lineRange').value = settings.line || 160; $('#fontValue').textContent = `${settings.font || 26} px`; $('#lineValue').textContent = String((settings.line || 160) / 100); $('#speedRange').value = state.scrollSpeed; $('#speedValue').textContent = `${state.scrollSpeed} px/s`; }
function saveSettings() { const settings = { dark: $('#darkToggle').checked, contrast: $('#contrastToggle').checked, font: Number($('#fontRange').value), line: Number($('#lineRange').value) }; localStorage.setItem(STORAGE.display, JSON.stringify(settings)); applySettings(); }

init();
