const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  songs: [],
  setlist: JSON.parse(localStorage.getItem('band-setlist') || 'null'),
  currentId: localStorage.getItem('band-current') || null,
  scrollSpeed: Number(localStorage.getItem('band-speed') || 45),
  scrolling: false,
  lastTs: 0,
};

async function init() {
  state.songs = await fetch('./songs/index.json').then(r => r.json());
  if (!state.setlist) {
    try {
      const initialSetlist = await fetch('./setlists/nadine-martin-2026.json').then(r => r.json());
      state.setlist = initialSetlist.songs.map(item => typeof item === 'string' ? item : item.id);
    } catch {
      state.setlist = state.songs.map(s => s.id);
    }
  }
  applySettings();
  bindUI();
  renderSetlist();
  renderLibrary();
  if (state.currentId) await openSong(state.currentId, false);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js');
}

function bindUI() {
  $('#menuBtn').onclick = openDrawer;
  $('#backdrop').onclick = closeDrawer;
  $$('.nav-item').forEach(b => b.onclick = () => switchView(b.dataset.view));
  $('#settingsBtn').onclick = () => $('#displaySettings').showModal();
  $('#addSongBtn').onclick = () => { renderPicker(); $('#songPicker').showModal(); };
  $('#resetSetlistBtn').onclick = async () => { if (confirm('Setliste auf Ausgangszustand zurücksetzen?')) { state.setlist = await loadDefaultSetlist(); saveSetlist(); renderSetlist(); } };
  $('#searchInput').oninput = renderLibrary;
  $('#pickerSearch').oninput = renderPicker;
  $('#startStopBtn').onclick = toggleScroll;
  $('#toTopBtn').onclick = () => window.scrollTo({top: 0, behavior: 'smooth'});
  $('#prevSongBtn').onclick = () => stepSong(-1);
  $('#nextSongBtn').onclick = () => stepSong(1);
  $('#speedRange').value = state.scrollSpeed;
  $('#speedValue').textContent = `${state.scrollSpeed} px/s`;
  $('#speedRange').oninput = e => { state.scrollSpeed = Number(e.target.value); $('#speedValue').textContent = `${state.scrollSpeed} px/s`; localStorage.setItem('band-speed', state.scrollSpeed); };
  $('#darkToggle').onchange = saveSettings;
  $('#contrastToggle').onchange = saveSettings;
  $('#fontRange').oninput = saveSettings;
  $('#lineRange').oninput = saveSettings;
  $('#fullscreenBtn').onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && document.activeElement?.tagName !== 'INPUT') { e.preventDefault(); toggleScroll(); }
    if (e.key === 'ArrowRight' && e.altKey) stepSong(1);
    if (e.key === 'ArrowLeft' && e.altKey) stepSong(-1);
  });
}

function openDrawer(){ $('#drawer').classList.add('open'); $('#backdrop').hidden = false; }
function closeDrawer(){ $('#drawer').classList.remove('open'); $('#backdrop').hidden = true; }
function switchView(name){
  $$('.view').forEach(v=>v.classList.remove('active'));
  $(`#${name}View`).classList.add('active');
  $$('.nav-item').forEach(b=>b.classList.toggle('active', b.dataset.view===name));
  const titles = {setlist:'Setliste',library:'Song-Bibliothek',player:'Player',about:'Hinweise'};
  $('#viewTitle').textContent = titles[name]; closeDrawer();
}


async function loadDefaultSetlist(){
  try {
    const data = await fetch('./setlists/nadine-martin-2026.json').then(r => r.json());
    return data.songs.map(item => typeof item === 'string' ? item : item.id);
  } catch {
    return state.songs.map(s => s.id);
  }
}

function renderSetlist(){
  const host = $('#setlist'); host.innerHTML='';
  state.setlist.forEach((id, index) => {
    const s = song(id); if(!s) return;
    const li = document.createElement('li'); li.className='song-row'; li.draggable=true; li.dataset.id=id;
    li.innerHTML = `<div class="drag">☰</div><div><h3>${index+1}. ${esc(s.title)}</h3><p>${esc(s.artist)}${meta(s)}</p></div><div class="row-actions"><button class="open">▶ <span class="label">Öffnen</span></button><button class="remove" aria-label="Entfernen">✕</button></div>`;
    li.querySelector('.open').onclick=()=>openSong(id);
    li.querySelector('.remove').onclick=()=>{ state.setlist=state.setlist.filter(x=>x!==id); saveSetlist(); renderSetlist(); };
    li.addEventListener('dragstart', e=>e.dataTransfer.setData('text/plain', id));
    li.addEventListener('dragover', e=>e.preventDefault());
    li.addEventListener('drop', e=>{ e.preventDefault(); const from=e.dataTransfer.getData('text/plain'); const to=id; reorder(from,to); });
    host.append(li);
  });
}

function renderLibrary(){
  const q=($('#searchInput').value||'').toLowerCase(); const host=$('#library'); host.innerHTML='';
  state.songs.filter(s=>(s.title+' '+s.artist).toLowerCase().includes(q)).forEach(s=>{
    const card=document.createElement('div'); card.className='card';
    card.innerHTML=`<h3>${esc(s.title)}</h3><p>${esc(s.artist)}</p><p>${meta(s).replace(' · ','')}</p><button class="primary">Öffnen</button> <button class="add">Zur Setliste</button>`;
    card.querySelector('.primary').onclick=()=>openSong(s.id);
    card.querySelector('.add').onclick=()=>addToSetlist(s.id);
    host.append(card);
  });
}

function renderPicker(){
  const q=($('#pickerSearch').value||'').toLowerCase(); const host=$('#pickerList'); host.innerHTML='';
  state.songs.filter(s=>(s.title+' '+s.artist).toLowerCase().includes(q)).forEach(s=>{
    const row=document.createElement('div'); row.className='picker-item';
    row.innerHTML=`<div><strong>${esc(s.title)}</strong><div class="subtle">${esc(s.artist)}</div></div><button type="button">Hinzufügen</button>`;
    row.querySelector('button').onclick=()=>{ addToSetlist(s.id); row.querySelector('button').textContent='✓'; };
    host.append(row);
  });
}

async function openSong(id, changeView=true){
  const s=song(id); if(!s) return;
  state.currentId=id; localStorage.setItem('band-current',id);
  $('#songTitle').textContent=s.title;
  $('#songMeta').textContent=`${s.artist}${meta(s)}`;
  const md=await fetch(`./songs/${s.file}`).then(r=>r.text());
  $('#songSheet').innerHTML=renderMarkdown(stripFrontmatter(md));
  stopScroll(); window.scrollTo({top:0});
  if(changeView) switchView('player');
}

function renderMarkdown(md){
  return md.split('\n').map(line=>{
    if(line.startsWith('### ')) return `<h3>${esc(line.slice(4))}</h3>`;
    if(line.startsWith('## ')) return `<h2>${esc(line.slice(3))}</h2>`;
    if(line.startsWith('# ')) return `<h1>${esc(line.slice(2))}</h1>`;
    if(/^\[.+\]$/.test(line.trim())) return `<strong>${esc(line)}</strong>`;
    if(!line.trim()) return '<br>';
    return `<div>${esc(line)}</div>`;
  }).join('');
}
function stripFrontmatter(md){ return md.replace(/^---[\s\S]*?---\s*/, ''); }
function song(id){ return state.songs.find(s=>s.id===id); }
function meta(s){ return [s.bpm?`${s.bpm} BPM`:'', s.capo?`Capo ${s.capo}`:'', s.singer||''].filter(Boolean).map(x=>` · ${x}`).join(''); }
function esc(s=''){ return s.replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function saveSetlist(){ localStorage.setItem('band-setlist',JSON.stringify(state.setlist)); }
function addToSetlist(id){ if(!state.setlist.includes(id)){ state.setlist.push(id); saveSetlist(); renderSetlist(); } }
function reorder(from,to){ const a=[...state.setlist]; const fi=a.indexOf(from), ti=a.indexOf(to); if(fi<0||ti<0)return; a.splice(ti,0,a.splice(fi,1)[0]); state.setlist=a; saveSetlist(); renderSetlist(); }
function stepSong(delta){ const list=state.setlist; let i=list.indexOf(state.currentId); if(i<0)i=0; i=(i+delta+list.length)%list.length; openSong(list[i]); }

function toggleScroll(){ state.scrolling ? stopScroll() : startScroll(); }
function startScroll(){ state.scrolling=true; state.lastTs=performance.now(); $('#startStopBtn').textContent='⏸ Stopp'; requestAnimationFrame(scrollFrame); }
function stopScroll(){ state.scrolling=false; $('#startStopBtn').textContent='▶ Start'; }
function scrollFrame(ts){
  if(!state.scrolling)return;
  const dt=Math.min((ts-state.lastTs)/1000,.05); state.lastTs=ts;
  window.scrollBy(0,state.scrollSpeed*dt);
  if(window.innerHeight+window.scrollY>=document.documentElement.scrollHeight-2) return stopScroll();
  requestAnimationFrame(scrollFrame);
}

function applySettings(){
  const s=JSON.parse(localStorage.getItem('band-display')||'{}');
  $('#darkToggle').checked=s.dark!==false; $('#contrastToggle').checked=!!s.contrast;
  $('#fontRange').value=s.font||24; $('#lineRange').value=s.line||160;
  saveSettings();
}
function saveSettings(){
  const s={dark:$('#darkToggle').checked,contrast:$('#contrastToggle').checked,font:Number($('#fontRange').value),line:Number($('#lineRange').value)};
  document.documentElement.classList.toggle('dark',s.dark); document.documentElement.classList.toggle('contrast',s.contrast);
  document.documentElement.style.setProperty('--sheet-font',`${s.font}px`); document.documentElement.style.setProperty('--sheet-line',String(s.line/100));
  $('#fontValue').textContent=`${s.font} px`; $('#lineValue').textContent=(s.line/100).toFixed(1);
  localStorage.setItem('band-display',JSON.stringify(s));
}

init();
