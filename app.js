const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const STORAGE = { setlist:'band-setlist', current:'band-current', speed:'band-speed', display:'band-display', overrides:'band-song-overrides' };
const state = { songs: [], baseSongs: [], setlist: [], currentId: localStorage.getItem(STORAGE.current), scrollSpeed: Number(localStorage.getItem(STORAGE.speed) || 45), scrolling: false, lastTs: 0, overrides: {} };

async function getJSON(path) { const r = await fetch(path, { cache: 'no-store' }); if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`); return r.json(); }
function loadOverrides(){ try { state.overrides = JSON.parse(localStorage.getItem(STORAGE.overrides) || '{}') || {}; } catch { state.overrides = {}; } }
function mergeSongs(){ state.songs = state.baseSongs.map(s => ({...s, ...(state.overrides[s.id] || {})})); }
function saveOverrides(){ localStorage.setItem(STORAGE.overrides, JSON.stringify(state.overrides)); mergeSongs(); }

async function init() {
  try {
    state.baseSongs = await getJSON('./songs.json'); loadOverrides(); mergeSongs();
    const lists = await getJSON('./setlists.json');
    const saved = JSON.parse(localStorage.getItem(STORAGE.setlist) || 'null');
    state.setlist = Array.isArray(saved) ? saved : lists[0].songs.map(x => typeof x === 'string' ? x : x.id);
    bindUI(); applySettings(); renderSetlist(); renderLibrary();
    await openSong(state.currentId && song(state.currentId) ? state.currentId : state.setlist[0], false);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js');
  } catch (err) { const b = $('#errorBanner'); b.hidden = false; b.textContent = `App konnte nicht geladen werden: ${err.message}`; console.error(err); }
}

function bindUI() {
  $('#menuBtn').onclick = openDrawer; $('#backdrop').onclick = closeDrawer;
  $$('.nav-item').forEach(b => b.onclick = () => switchView(b.dataset.view));
  $('#settingsBtn').onclick = () => $('#displaySettings').showModal();
  $('#addSongBtn').onclick = () => { renderPicker(); $('#songPicker').showModal(); };
  $('#resetSetlistBtn').onclick = async () => { if (!confirm('Setliste zurücksetzen?')) return; const lists = await getJSON('./setlists.json'); state.setlist = lists[0].songs.map(x => typeof x === 'string' ? x : x.id); saveSetlist(); renderSetlist(); };
  $('#searchInput').oninput = renderLibrary; $('#pickerSearch').oninput = renderPicker;
  $('#startStopBtn').onclick = toggleScroll; $('#toTopBtn').onclick = () => scrollTo({ top: 0, behavior: 'smooth' });
  $('#prevSongBtn').onclick = () => stepSong(-1); $('#nextSongBtn').onclick = () => stepSong(1);
  $('#editSongBtn').onclick = openEditor; $('#saveSongBtn').onclick = saveEditedSong; $('#deleteOverrideBtn').onclick = deleteOverride;
  $('#exportBtn').onclick = exportData; $('#importFile').onchange = importData;
  $('#speedRange').value = state.scrollSpeed; $('#speedValue').textContent = `${state.scrollSpeed} px/s`;
  $('#speedRange').oninput = e => { state.scrollSpeed = Number(e.target.value); $('#speedValue').textContent = `${state.scrollSpeed} px/s`; localStorage.setItem(STORAGE.speed, state.scrollSpeed); };
  ['darkToggle','contrastToggle','fontRange','lineRange'].forEach(id => $(`#${id}`).oninput = saveSettings);
  $('#fullscreenBtn').onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopScroll(); });
}
function openDrawer(){ $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden','false'); $('#backdrop').hidden=false; }
function closeDrawer(){ $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden','true'); $('#backdrop').hidden=true; }
function switchView(name){ $$('.view').forEach(v=>v.classList.remove('active')); $(`#${name}View`).classList.add('active'); $$('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===name)); $('#viewTitle').textContent={setlist:'Setliste',library:'Song-Bibliothek',player:'Player',about:'Hinweise'}[name]; closeDrawer(); }
function song(id){ return state.songs.find(s=>s.id===id); }
function esc(v=''){ return String(v).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function meta(s){ return [s.bpm&&`${s.bpm} BPM`, Number.isFinite(Number(s.capo))&&Number(s.capo)>0&&`Capo ${s.capo}`, s.singer].filter(Boolean).join(' · '); }
function saveSetlist(){ localStorage.setItem(STORAGE.setlist,JSON.stringify(state.setlist)); }

function renderSetlist(){ const host=$('#setlist'); host.innerHTML=''; state.setlist.forEach((id,index)=>{ const s=song(id); if(!s)return; const li=document.createElement('li'); li.className='song-row'; li.innerHTML=`<button class="song-main" aria-label="${esc(s.title)} öffnen"><span class="number">${index+1}</span><span><strong>${esc(s.title)}</strong><small>${esc(s.artist)}${meta(s)?` · ${esc(meta(s))}`:''}</small></span></button><div class="row-actions"><button class="move-up" aria-label="Nach oben">↑</button><button class="move-down" aria-label="Nach unten">↓</button><button class="remove" aria-label="Entfernen">✕</button></div>`; li.querySelector('.song-main').onclick=()=>openSong(id); li.querySelector('.move-up').onclick=()=>move(index,-1); li.querySelector('.move-down').onclick=()=>move(index,1); li.querySelector('.remove').onclick=()=>{ state.setlist.splice(index,1); saveSetlist(); renderSetlist(); }; host.append(li); }); }
function move(index,delta){ const to=index+delta; if(to<0||to>=state.setlist.length)return; [state.setlist[index],state.setlist[to]]=[state.setlist[to],state.setlist[index]]; saveSetlist(); renderSetlist(); }
function renderLibrary(){ const q=($('#searchInput').value||'').toLowerCase(); const host=$('#library'); host.innerHTML=''; state.songs.filter(s=>(s.title+' '+s.artist).toLowerCase().includes(q)).forEach(s=>{ const c=document.createElement('article'); c.className='card'; c.innerHTML=`<h3>${esc(s.title)}</h3><p>${esc(s.artist)}</p><small>${esc(meta(s))}</small><div><button class="primary open">Öffnen</button><button class="add">+ Setliste</button></div>`; c.querySelector('.open').onclick=()=>openSong(s.id); c.querySelector('.add').onclick=()=>addToSetlist(s.id); host.append(c); }); }
function renderPicker(){ const q=($('#pickerSearch').value||'').toLowerCase(); const host=$('#pickerList'); host.innerHTML=''; state.songs.filter(s=>(s.title+' '+s.artist).toLowerCase().includes(q)).forEach(s=>{ const r=document.createElement('div'); r.className='picker-item'; r.innerHTML=`<div><strong>${esc(s.title)}</strong><small>${esc(s.artist)}</small></div><button type="button">Hinzufügen</button>`; r.querySelector('button').onclick=()=>{addToSetlist(s.id);r.querySelector('button').textContent='✓';}; host.append(r); }); }
function addToSetlist(id){ if(!state.setlist.includes(id)){state.setlist.push(id);saveSetlist();renderSetlist();} }

async function openSong(id,changeView=true){ const s=song(id); if(!s)return; stopScroll(); state.currentId=id; localStorage.setItem(STORAGE.current,id); $('#songTitle').textContent=s.title; $('#songMeta').textContent=[s.artist,meta(s)].filter(Boolean).join(' · '); $('#songSheet').innerHTML=renderSong(s.content||'Noch kein Songblatt eingetragen. Tippe auf „Bearbeiten“.'); scrollTo({top:0}); if(changeView)switchView('player'); }
function renderSong(text){ return text.split('\n').map(line=>{ const t=line.trim(); if(!t)return '<div class="blank"></div>'; if(/^\[.+\]$/.test(t))return `<h3 class="section-label">${esc(t.slice(1,-1))}</h3>`; const rendered=esc(line).replace(/\[([A-G][#b]?(?:m|maj|min|sus|dim|aug|add)?\d*(?:\/[A-G][#b]?)?)\]/g,'<span class="chord">$1</span>'); return `<div class="lyric-line">${rendered}</div>`; }).join(''); }
function stepSong(delta){ if(!state.setlist.length)return; let i=state.setlist.indexOf(state.currentId); if(i<0)i=0; openSong(state.setlist[(i+delta+state.setlist.length)%state.setlist.length]); }

function openEditor(){ const s=song(state.currentId); if(!s)return; $('#editTitle').value=s.title||''; $('#editArtist').value=s.artist||''; $('#editBpm').value=s.bpm||''; $('#editCapo').value=s.capo||''; $('#editSinger').value=s.singer||''; $('#editContent').value=s.content||''; $('#songEditor').showModal(); }
function saveEditedSong(){ const id=state.currentId; if(!id)return; state.overrides[id]={ title:$('#editTitle').value.trim(), artist:$('#editArtist').value.trim(), bpm:Number($('#editBpm').value)||undefined, capo:$('#editCapo').value===''?undefined:Number($('#editCapo').value), singer:$('#editSinger').value.trim(), content:$('#editContent').value }; saveOverrides(); $('#songEditor').close(); renderSetlist(); renderLibrary(); openSong(id,false); }
function deleteOverride(){ const id=state.currentId; if(!id||!state.overrides[id]) return; if(!confirm('Lokale Änderungen für diesen Song löschen?'))return; delete state.overrides[id]; saveOverrides(); $('#songEditor').close(); renderSetlist(); renderLibrary(); openSong(id,false); }
function exportData(){ const data={version:1, exportedAt:new Date().toISOString(), overrides:state.overrides, setlist:state.setlist, display:JSON.parse(localStorage.getItem(STORAGE.display)||'{}'), speed:state.scrollSpeed}; const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='aussteiger-bandapp-backup.json'; a.click(); URL.revokeObjectURL(a.href); }
async function importData(e){ const file=e.target.files?.[0]; if(!file)return; try{ const data=JSON.parse(await file.text()); if(data.overrides&&typeof data.overrides==='object')state.overrides=data.overrides; if(Array.isArray(data.setlist))state.setlist=data.setlist; saveOverrides(); saveSetlist(); if(data.display)localStorage.setItem(STORAGE.display,JSON.stringify(data.display)); if(data.speed){state.scrollSpeed=Number(data.speed);localStorage.setItem(STORAGE.speed,state.scrollSpeed);} renderSetlist(); renderLibrary(); applySettings(); openSong(state.currentId||state.setlist[0],false); alert('Import abgeschlossen.'); }catch(err){ alert(`Import fehlgeschlagen: ${err.message}`); } finally { e.target.value=''; } }

function toggleScroll(){ state.scrolling?stopScroll():startScroll(); }
function startScroll(){ state.scrolling=true; state.lastTs=performance.now(); $('#startStopBtn').textContent='⏸ Stopp'; requestAnimationFrame(scrollFrame); }
function stopScroll(){ state.scrolling=false; const b=$('#startStopBtn'); if(b)b.textContent='▶ Start'; }
function scrollFrame(ts){ if(!state.scrolling)return; const dt=Math.min((ts-state.lastTs)/1000,.05); state.lastTs=ts; scrollBy(0,state.scrollSpeed*dt); if(innerHeight+scrollY>=document.documentElement.scrollHeight-3)return stopScroll(); requestAnimationFrame(scrollFrame); }
function applySettings(){ const s=JSON.parse(localStorage.getItem(STORAGE.display)||'{}'); $('#darkToggle').checked=s.dark!==false; $('#contrastToggle').checked=!!s.contrast; $('#fontRange').value=s.font||26; $('#lineRange').value=s.line||160; saveSettings(); }
function saveSettings(){ const s={dark:$('#darkToggle').checked,contrast:$('#contrastToggle').checked,font:Number($('#fontRange').value),line:Number($('#lineRange').value)}; document.documentElement.classList.toggle('dark',s.dark); document.documentElement.classList.toggle('contrast',s.contrast); document.documentElement.style.setProperty('--sheet-font',`${s.font}px`); document.documentElement.style.setProperty('--sheet-line',String(s.line/100)); $('#fontValue').textContent=`${s.font} px`; $('#lineValue').textContent=(s.line/100).toFixed(1); localStorage.setItem(STORAGE.display,JSON.stringify(s)); }
init();
