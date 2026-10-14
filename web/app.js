/* Poste de stratège — interface « une voiture ».
   Le joueur voit SA voiture (jauges, plan, journal) ; les autres en
   public (position, nom, km, état). Le super utilisateur a un
   sélecteur discret de participant — l'interface reste une-voiture.
   Avant configuration : écran de création de SA voiture (nom + livrée). */
const $ = (id) => document.getElementById(id);
const canvas = $('map');
const ctx = canvas.getContext('2d');
const ROAD_W = 7.5;

let snap = null;
let me = null;           // compte {user, level, carId}
let selCarId = null;     // voiture vue (super : sélecteur discret)
let draft = { power: 1, actions: [] };
let nextLocalId = -1;
let lastEvents = [];     // bandeau d'événements en direct

let routePts = [], trackS = -1;
let view = { cx: 0, cy: 0, scale: 0.02 };
let drag = null;

function resize() {
  const r = canvas.getBoundingClientRect();
  canvas.width = r.width * devicePixelRatio;
  canvas.height = r.height * devicePixelRatio;
}
addEventListener('resize', resize);
resize();

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  view.scale *= e.deltaY < 0 ? 1.15 : 1 / 1.15;
  draw();
}, { passive: false });
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy, moved: false };
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  view.cx = drag.cx - dx / view.scale;
  view.cy = drag.cy + dy / view.scale;
  draw();
});
canvas.addEventListener('pointerup', () => { drag = null; });

function w2s(x, y) {
  return [
    (x - view.cx) * view.scale + canvas.width / 2 / devicePixelRatio,
    -(y - view.cy) * view.scale + canvas.height / 2 / devicePixelRatio,
  ];
}

function draw() {
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!snap) return;
  const myCar = snap.me ?? null;
  if (myCar) {
    view.cx += (myCar.pos.x - view.cx) * 0.08;
    view.cy += (myCar.pos.y - view.cy) * 0.08;
  }
  ctx.strokeStyle = '#2f3b4c';
  ctx.lineWidth = Math.max(2, ROAD_W * view.scale * 1.2);
  ctx.lineJoin = 'round';
  if (routePts.length > 1) {
    ctx.beginPath();
    let started = false;
    for (const p of routePts) {
      const [sx, sy] = w2s(p.x, p.y);
      if (!started) { ctx.moveTo(sx, sy); started = true; } else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
  }
  for (const c of snap.cars) {
    const pos = (snap.me && c.id === snap.me.id) ? snap.me.pos : null;
    if (pos) {
      const [sx, sy] = w2s(pos.x, pos.y);
      ctx.beginPath(); ctx.arc(sx, sy, 7, 0, 7);
      ctx.fillStyle = c.color; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#dce3ec'; ctx.font = '11px system-ui';
      ctx.fillText(`${c.rank}. ${c.name}`, sx + 9, sy + 4);
    } else {
      // positions des autres : déduites du classement public (approximation
      // locale pour la carte — pas de positions exactes exposées hors snapshot)
      continue;
    }
  }
  // les autres voitures : le snapshot public ne donne pas pos ; on les
  // dessine depuis snap.cars si l'API les fournit (admin/super)
  for (const c of snap.cars ?? []) {
    if (snap.me && c.id === snap.me.id) continue;
    if (c.pos) {
      const [sx, sy] = w2s(c.pos.x, c.pos.y);
      ctx.beginPath(); ctx.arc(sx, sy, 5, 0, 7);
      ctx.fillStyle = c.color; ctx.fill();
      ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#9aa5b1'; ctx.font = '10px system-ui';
      ctx.fillText(`${c.rank}. ${c.name}`, sx + 8, sy + 3);
    }
  }
}

/* ---- polling ---- */
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (r.status === 401) { location.href = '/login.html'; return null; }
  return r;
}

async function poll() {
  try {
    let url = '/api/state';
    if (selCarId !== null) url += `?viewCar=${selCarId}`;
    const r = await api(url);
    if (!r) return;
    const d = await r.json();
    if (r.status !== 200) return;
    snap = d;
    $('conn').textContent = 'connecté'; $('conn').className = 'on';
    render();
    await fetchRoutePts();
    draw();
  } catch {
    $('conn').textContent = 'déconnecté'; $('conn').className = 'off';
  }
}

async function fetchRoutePts() {
  const ref = snap?.me ?? snap?.cars?.[0];
  if (!ref) return;
  const s0 = Math.max(0, ref.km * 1000 - 30000);
  if (Math.abs(s0 - trackS) < 5000) return;
  trackS = s0;
  const r = await api(`/api/track?s0=${s0}&len=60000&step=120`);
  if (!r) return;
  const d = await r.json();
  routePts = d.pts;
}

function stateLabel(c) {
  if (c.st === 'finish') return '🏁 arrivé';
  if (c.st === 'stop') {
    if (c.stopKind === 'hotel') return '😴 dort à l\'hôtel';
    if (c.stopKind === 'station') return '⛽ ravitaille';
    if (c.stopKind === 'garage') return '🔧 au garage';
    if (c.stopKind === 'dry') return '🆘 panne sèche';
    if (c.stopKind === 'roadside') return '🛏️ en bord de route';
    return '⏸️ arrêt';
  }
  if (c.st === 'toStop') return '→✋ rejoint un arrêt';
  return '🚗 roule';
}

function fmtDur(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h} h ${String(m).padStart(2, '0')}`;
}

function show(id) { for (const x of ['view-configure','view-prep','view-race','view-finish']) $(x).style.display = 'none'; $(id).style.display = 'block'; }

function render() {
  $('clock').textContent = snap.clock;
  $('raceInfo').textContent = `· ${snap.totalKm} km · ${snap.phase === 'preparation' ? 'préparation' : snap.phase === 'finished' ? 'terminée' : 'en course'}`;
  const carCount = snap.cars.length;
  $('gridInfo').textContent = `${carCount}/${snap.maxCars} inscrites`;

  // écran de fin : podium figé
  if (snap.phase === 'finished' && snap.me) { renderFinish(); return; }

  // pas de voiture configurée → écran de configuration (si grille ouverte)
  if (!snap.me) {
    if (snap.phase !== 'preparation') {
      $('configureMsg').textContent = 'La course est en cours et votre voiture n\'est pas inscrite — attendez le prochain reset (admin).';
    }
    show('view-configure');
    renderLiveries();
    return;
  }
  const me = snap.me;
  syncDraftFrom(me.plan);

  if (snap.phase === 'preparation') {
    const left = Math.max(0, snap.startEpochMs - Date.now());
    $('countdown').textContent = `Départ dans ${fmtDur(left / 1000)}`;
    show('view-prep');
    drawProfile();
  } else {
    show('view-race');
  }

  // classement public
  const tb = $('standings').querySelector('tbody');
  tb.innerHTML = '';
  for (const c of snap.cars) {
    const tr = document.createElement('tr');
    const mine = me && c.id === me.id;
    if (mine) tr.className = 'sel';
    tr.innerHTML = `<td>${c.rank}</td>
      <td><span class="dot" style="background:${c.color}"></span> ${c.name}</td>
      <td class="km">${c.km.toFixed(1)} km</td>
      <td class="mut">${stateLabel(c)}</td>`;
    tb.appendChild(tr);
  }

  // jauges SA voiture
  $('fuelTxt').textContent = `${me.fuel.toFixed(0)} L`;
  $('fuelBar').style.width = `${Math.min(100, me.fuel / 520 * 100)}%`;
  $('fatTxt').textContent = `${me.fatigue.toFixed(1)} h de veille`;
  $('fatBar').style.width = `${Math.min(100, me.fatigue / 30 * 100)}%`;
  $('spdTxt').textContent = `${me.v.toFixed(0)} km/h`;
  $('spdBar').style.width = `${Math.min(100, me.v / 200 * 100)}%`;
  $('budTxt').textContent = `${Math.round(me.budget)} €`;
  $('budBar').style.width = `${Math.min(100, Math.max(0, (me.budget / 40000) * 100))}%`;
  $('tireName').textContent = me.punctured ? '⚠ crevé !' : `(${me.tire})`;
  $('tireTxt').textContent = me.punctured ? 'mode dégradé' : `${Math.round(me.tireWear * 100)} % usé`;
  $('tireBar').style.width = `${Math.min(100, me.tireWear * 100)}%`;
  $('planTitle').textContent = `Stratégie — ${me.name}`;

  // voiture auto-attribuée : proposer la personnalisation (une fois)
  $('personalizeRow').style.display = me.autoCreated ? 'flex' : 'none';

  // journal complet + bandeau direct
  renderEvents(me.events);
  renderActions();
}

function renderEvents(events) {
  const ev = $('events');
  ev.innerHTML = '';
  for (const e of [...events].reverse()) {
    const p = document.createElement('p');
    p.innerHTML = `<b>${fmtClock(e.t)}</b> — ${e.msg}`;
    ev.appendChild(p);
  }
  const fresh = events.length > lastEvents.length;
  if (fresh && lastEvents.length > 0) {
    const diff = events.filter((x) => !lastEvents.some((y) => y.t === x.t && y.msg === x.msg));
    for (const e of diff.slice(0, 3)) {
      const b = document.createElement('div');
      b.className = 'flash';
      b.textContent = `${fmtClock(e.t)} — ${e.msg}`;
      $('flash').prepend(b);
      setTimeout(() => b.remove(), 8000);
    }
  }
  lastEvents = [...events];
}

function fmtClock(simT) {
  if (!snap) return '';
  const d = new Date(Date.now() - (snap.simT - simT) * 1000);
  return d.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
}

function renderFinish() {
  show('view-finish');
  const me = snap.me;
  $('finalRank').textContent = `${me.rank}${me.rank === 1 ? 'er' : 'e'}`;
  const tb = $('podium').querySelector('tbody');
  tb.innerHTML = '';
  for (const c of snap.cars.slice(0, 3)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${c.rank}</td><td><span class="dot" style="background:${c.color}"></span> ${c.name}</td><td class="km">${c.km.toFixed(1)} km</td>`;
    tb.appendChild(tr);
  }
  const sum = $('summary');
  sum.innerHTML = `<p><b>${me.name}</b> — ${fmtDur(me.finishedAt ?? 0)} de course, ${(me.km).toFixed(1)} km.</p>`;
  for (const e of me.events) {
    const p = document.createElement('p');
    p.textContent = `${fmtClock(e.t)} — ${e.msg}`;
    sum.appendChild(p);
  }
}

/* ---- configuration de la voiture (première fois) ---- */
let liveries = { palette: [], taken: [] };
/* la sélection vit dans cette variable : renderLiveries() reconstruit
   la grille à chaque poll (1 s) et le DOM est donc effacé en permanence —
   une sélection portée par le seul DOM est toujours perdue avant validation */
let selectedColor = null;

async function renderLiveries() {
  const r = await api('/api/liveries');
  if (!r) return;
  liveries = await r.json();
  const box = $('liveryGrid');
  box.innerHTML = '';
  for (const col of liveries.palette) {
    const taken = liveries.taken.includes(col);
    /* ré-applique la sélection précédente si la couleur est toujours
       libre — la sélection survit aux re-rendus */
    const stillSel = col === selectedColor && !taken;
    if (col === selectedColor && taken) {
      selectedColor = null; /* quelqu'un l'a prise entre-temps */
    }
    const d = document.createElement('div');
    d.className = 'swatch' + (taken ? ' taken' : '') + (stillSel ? ' sel' : '');
    d.style.background = col;
    d.title = taken ? 'livrée déjà prise' : '';
    d.dataset.color = col;
    d.onclick = () => {
      if (taken) return;
      selectedColor = col;
      for (const s of box.children) s.classList.remove('sel');
      d.classList.add('sel');
    };
    box.appendChild(d);
  }
}

/* ---- fenêtre de préparation : carte complète + profil d'altitude +
   bandes de biomes (un seul graphique clair, mobile first ; POI non
   marqués — design 2026-10-14) ---- */
const BIOME_COLORS = ['#7cb342', '#2e7d32', '#e0a96d', '#90a4ae'];
const BIOME_NAMES = ['Plaine', 'Forêt', 'Désert', 'Altitude'];
let profData = null;

async function drawProfile() {
  const r = await api('/api/profile');
  if (!r) return;
  profData = await r.json();
  if (profData.phase !== 'preparation') return;
  const d = profData;
  // carte vue de dessus
  const cv = $('profMap'), ctx = cv.getContext('2d');
  const rect = cv.getBoundingClientRect();
  cv.width = rect.width * devicePixelRatio; cv.height = rect.height * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  const xs = d.pts.map(p => p.x), ys = d.pts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const sc = Math.min((rect.width - 20) / (maxX - minX || 1), (rect.height - 20) / (maxY - minY || 1));
  for (let i = 1; i < d.pts.length; i++) {
    ctx.strokeStyle = BIOME_COLORS[d.pts[i].b] ?? '#888';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(10 + (d.pts[i - 1].x - minX) * sc, rect.height - 10 - (d.pts[i - 1].y - minY) * sc);
    ctx.lineTo(10 + (d.pts[i].x - minX) * sc, rect.height - 10 - (d.pts[i].y - minY) * sc);
    ctx.stroke();
  }
  // profil d'altitude avec bandes de biome
  const av = $('profAlt'), actx = av.getContext('2d');
  const arect = av.getBoundingClientRect();
  av.width = arect.width * devicePixelRatio; av.height = arect.height * devicePixelRatio;
  actx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  const hs = d.pts.map(p => p.h);
  const minH = Math.min(...hs), maxH = Math.max(...hs);
  const n = d.pts.length;
  // bandes de biome
  for (let i = 1; i < n; i++) {
    actx.fillStyle = (BIOME_COLORS[d.pts[i].b] ?? '#555') + '44';
    actx.fillRect((i - 1) / n * arect.width, 0, arect.width / n + 1, arect.height);
  }
  // ligne d'altitude
  actx.strokeStyle = '#dce3ec';
  actx.lineWidth = 1.5;
  actx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = i / n * arect.width;
    const y = arect.height - 6 - (d.pts[i].h - minH) / (maxH - minH || 1) * (arect.height - 12);
    i === 0 ? actx.moveTo(x, y) : actx.lineTo(x, y);
  }
  actx.stroke();
  // légende
  const kmB = [0, 0, 0, 0];
  for (let i = 1; i < n; i++) kmB[d.pts[i].b] += (d.pts[i].s - d.pts[i - 1].s) / 1000;
  $('profLegend').innerHTML = kmB.map((k, i) =>
    `<span style="color:${BIOME_COLORS[i]}">■</span> ${BIOME_NAMES[i]} ${Math.round(k)} km`).join(' · ');
}

$('personalizeBtn').onclick = async () => {
  /* personnalisation différée d'une voiture auto-attribuée : nom + livrée
     (les gommes sont un réglage de préparation — ignorées en course) */
  const name = prompt('Nom d\'équipe :', me.user);
  if (name === null) return;
  const r = await api('/api/configure', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, color: snap.me.color }),
  });
  const d = await r.json();
  if (r.status !== 200) alert(d.error ?? 'erreur');
  else poll();
};

$('configureBtn').onclick = async () => {
  const name = $('teamName').value.trim();
  if (name.length < 2) { $('configureErr').textContent = 'Nom d\'équipe trop court.'; return; }
  if (!selectedColor) { $('configureErr').textContent = 'Choisissez une livrée.'; return; }
  const r = await api('/api/configure', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, color: selectedColor, tire: $('tireChoice').value }),
  });
  const d = await r.json();
  if (r.status === 200) { $('configureErr').textContent = ''; poll(); }
  else $('configureErr').textContent = d.error ?? 'erreur';
};

/* ---- plan ---- */
function syncDraftFrom(plan) {
  if (!syncedWithCarId || syncedWithCarId !== snap.me.id) {
    draft = JSON.parse(JSON.stringify(plan));
    $('power').value = draft.power;
    syncedWithCarId = snap.me.id;
  }
}
let syncedWithCarId = null;

function renderActions() {
  const box = $('actions');
  box.innerHTML = '';
  for (const a of draft.actions) {
    const div = document.createElement('div');
    div.className = 'action-item';
    let txt;
    if (a.type === 'refuel' && a.ifTag === 'fuelLow') txt = `Règle : plein si réservoir < ${Math.round(a.threshold * 100)} %`;
    else if (a.type === 'sleep' && a.ifTag === 'fatigueHigh') txt = `Règle : dormir ${a.hours} h si veille > ${a.threshold} h`;
    else if (a.type === 'refuel' && a.atKm !== undefined) txt = `Plein au km ${a.atKm}`;
    else if (a.type === 'sleep' && a.atKm !== undefined) txt = `Dormir au km ${a.atKm}`;
    else if (a.type === 'repair' && a.atKm !== undefined) txt = `Garage au km ${a.atKm}`;
    else if (a.type === 'tires') txt = `Monter des gommes ${a.tire} au prochain garage`;
    else txt = JSON.stringify(a);
    div.innerHTML = `<span style="flex:1">${txt}</span>`;
    const del = document.createElement('button');
    del.textContent = '✕';
    del.onclick = () => { draft.actions = draft.actions.filter((x) => x.id !== a.id); renderActions(); };
    div.appendChild(del);
    box.appendChild(div);
  }
}

$('addAction').onclick = () => {
  const kind = $('newAction').value;
  const id = nextLocalId--;
  if (kind === 'refuelLow') draft.actions.push({ id, type: 'refuel', ifTag: 'fuelLow', threshold: 0.18 });
  else if (kind === 'sleepFat') draft.actions.push({ id, type: 'sleep', ifTag: 'fatigueHigh', threshold: 20, hours: 7 });
  else {
    const km = prompt('Au kilomètre :');
    if (km === null) return;
    const atKm = Number(km);
    if (!Number.isFinite(atKm)) return;
    if (kind === 'refuelKm') draft.actions.push({ id, type: 'refuel', atKm });
    else if (kind === 'sleepKm') draft.actions.push({ id, type: 'sleep', atKm });
    else if (kind === 'repairKm') draft.actions.push({ id, type: 'repair', atKm });
  }
  renderActions();
};

$('addTire').onclick = () => {
  const t = $('tireChange').value;
  if (!t) return;
  draft.actions = draft.actions.filter((a) => a.type !== 'tires');
  draft.actions.push({ id: nextLocalId--, type: 'tires', tire: t });
  renderActions();
};

$('power').oninput = (e) => { draft.power = Number(e.target.value); };

$('savePlan').onclick = async () => {
  const r = await api('/api/plan', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plan: draft }),
  });
  if (r.status === 200) { $('savePlan').textContent = 'Plan appliqué ✓'; setTimeout(() => $('savePlan').textContent = 'Appliquer le plan', 1200); }
};

/* ---- sélecteur discret super utilisateur ---- */
async function initMe() {
  const r = await fetch('/api/me');
  if (r.status === 401) { location.href = '/login.html'; return null; }
  me = await r.json();
  if (me.level !== 'player') {
    $('superBar').style.display = 'flex';
    const cr = await api('/api/cars');
    if (cr) {
      const d = await cr.json();
      const sel = $('viewCar');
      sel.innerHTML = '<option value="">— ma voiture —</option>';
      for (const c of d.cars) {
        const o = document.createElement('option');
        o.value = c.id; o.textContent = c.name;
        sel.appendChild(o);
      }
    }
  }
  if (me.level === 'admin') $('adminLink').style.display = 'inline';
  return me;
}

$('viewCar').onchange = (e) => {
  selCarId = e.target.value === '' ? null : Number(e.target.value);
  lastEvents = [];
  syncedWithCarId = null;
  poll();
};

$('logoutBtn').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
};

$('cbSend').onclick = async () => {
  const msg = $('cbMsg').value.trim();
  if (!msg) return;
  const r = await api('/api/cb', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msg }),
  });
  if (r.status === 200) $('cbMsg').value = '';
  else if (r.status === 429) $('cbMsg').placeholder = 'Trop de messages — patientez 5 s';
};

async function pollCb() {
  if (!snap?.me) return;
  try {
    const r = await api('/api/cb');
    if (!r) return;
    const d = await r.json();
    const box = $('cbBox');
    const seen = new Set([...box.children].map((c) => c.dataset.key));
    for (const m of d.msgs) {
      const key = `${m.t}|${m.carId}|${m.msg}`;
      if (seen.has(key)) continue;
      const p = document.createElement('p');
      p.dataset.key = key;
      p.innerHTML = `<b>${m.from} :</b> ${m.msg}`;
      box.appendChild(p);
      const b = document.createElement('div');
      b.className = 'flash';
      b.textContent = `📻 ${m.from} : ${m.msg}`;
      $('flash').prepend(b);
      setTimeout(() => b.remove(), 8000);
    }
    while (box.children.length > 30) box.firstChild.remove();
  } catch {}
}

(async () => {
  if (!(await initMe())) return;
  setInterval(poll, 1000);
  setInterval(pollCb, 2000);
  poll();
})();
