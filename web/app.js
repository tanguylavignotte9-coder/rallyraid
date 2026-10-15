/* ============================================================
   POSTE DE STRATÈGE — COCKPIT 3D DIÉGÉTIQUE (refonte UI n°8)
   ============================================================
   La vue 3D (world3d.js, partagée avec le spectateur) est LA vue
   principale ; tout l'UI est diégétique :
   - #dash : tableau de bord LCD de la voiture (vitesse, carburant,
     gommes, veille, budget, position, horloge, bandeau, LED CB) ;
   - #copilot : l'ordinateur portable du copilote — carte, stratégie,
     classement, journal, CB (tout le code existant, déplacé).
   Le poll serveur (1 s) reste LA SEULE source de vérité : setData
   alimente la 3D, le dash lisse ses valeurs (lerp ~0,4 s), la
   mini-carte fait son dead reckoning dans sa propre boucle rAF —
   on ne lisse que l'affichage, jamais la simulation. */

import * as W from './world3d.js';

const $ = (id) => document.getElementById(id);
const canvas = $('map');
const ctx = canvas.getContext('2d');
const ROAD_W = 7.5;
const TANK = 520;

let snap = null;
let me = null;           // compte {user, level, carId}
let selCarId = null;     // voiture vue (super : sélecteur du bezel)
let draft = { power: 1, actions: [] };
let nextLocalId = -1;
let lastEvents = [];
let lastCbKeys = new Set();
let world3dReady = false;

/* ============================================================
   API — même session que le reste du jeu (401 → login)
   ============================================================ */
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (r.status === 401) { location.href = '/login.html'; return null; }
  return r;
}

/* ============================================================
   POLL 1 s — LA source de vérité unique.
   Pas de seconde boucle de données : setData alimente 3D + dash ;
   pollCb reste pour la CB.
   ============================================================ */
async function poll() {
  try {
    let url = '/api/state';
    if (selCarId !== null) url += `?viewCar=${selCarId}`;
    const r = await api(url);
    if (!r) return;
    const d = await r.json();
    if (r.status !== 200) return;
    snap = d;
    snapAt = performance.now();   /* pour l'extrapolation de la mini-carte */
    $('conn').textContent = 'connecté'; $('conn').className = 'on';
    await fetchRoutePts();
    /* 3D : la voiture suivie est ma voiture (ou celle du sélecteur super) */
    if (world3dReady && snap.cars?.length) {
      W.setData(snap);
      W.refreshWorldNow();
    }
    render();
    dashTick(1);
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
let routePts = [], trackS = -1;

/* ============================================================
   PHASES — cockpit unique ; configure et podium en overlay
   ============================================================ */
function show(id) {
  for (const x of ['view-configure', 'view-finish']) $(x).style.display = 'none';
  if (id) $(id).style.display = 'block';
}

function stateLabel(c) {
  if (c.st === 'finish') return '🏁 arrivé';
  if (c.st === 'stop') {
    if (c.stopKind === 'hotel') return '😴 dort à l\'hôtel';
    if (c.stopKind === 'station') return '⛽ ravitaille';
    if (c.stopKind === 'garage') return '🔧 au garage';
    if (c.stopKind === 'dry') return '🛑 panne sèche';
    if (c.stopKind === 'roadside') return '🛣️ en bord de route';
    return '⏸️ arrêt';
  }
  if (c.st === 'toStop') return '→✋ rejoint un arrêt';
  return '🚗 roule';
}

function fmtDur(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h} h ${String(m).padStart(2, '0')}`;
}

/* Télémétrie debug admin : valeurs de la voiture VUE (moi par défaut,
   ou la cible de viewCar — l'admin peut auditer la conduite d'une
   autre voiture). SOURCE : /api/telemetry pollé à ~150 ms (8 Hz) —
   le poll 1 s reste LA source de vérité pour tout le reste ; la map
   live est alimentée par pollTele, avec FALLBACK sur les champs du
   snapshot 1 s (avant le premier pollTele, ou si le réseau 403). */
const teleMap = new Map();   /* id -> {thr, brk, grip, abs, steer, lat, v, roll, pitch} */
let teleBusy = false;        /* GARDE anti-empilement : jamais deux
                                requêtes télémétrie en vol — si le RTT
                                dépasse 33 ms (réseau lent), on SAUTE le
                                tick au lieu d'empiler */

async function pollTele() {
  if (teleBusy) return;
  teleBusy = true;
  try {
    const r = await api('/api/telemetry');
    if (!r || r.status !== 200) return;
    const d = await r.json();
    teleMap.clear();
    for (const c of d.cars) teleMap.set(c.id, c);
    /* la 3D anime braquage/roulis/tangage/stop à la même cadence */
    if (world3dReady) W.setTele(teleMap);
  } catch { /* silence — on garde la dernière map */ } finally {
    teleBusy = false;
  }
  renderTele();
}

function renderTele() {
  if (me?.level !== 'admin') return;
  const viewed = snap.me ?? null;
  if (!viewed) { $('tele').style.display = 'none'; return; }
  /* 8 Hz si la map live existe, sinon champs publics du snapshot 1 s */
  const t = teleMap.get(viewed.id) ?? viewed;
  $('tele').style.display = 'block';
  $('tThr').firstElementChild.style.width = `${Math.min(1, Math.max(0, t.thr ?? 0)) * 100}%`;
  $('tBrk').firstElementChild.style.width = `${Math.min(1, Math.max(0, t.brk ?? 0)) * 100}%`;
  /* DIR zéro-centrée : part du centre vers la gauche (steer < 0) ou
     la droite (steer > 0) */
  const st = Math.min(1, Math.max(-1, t.steer ?? 0));
  const si = $('tSteer').firstElementChild;
  si.style.left = st < 0 ? `${50 + st * 50}%` : '50%';
  si.style.width = `${Math.abs(st) * 50}%`;
  const gr = Math.min(1, Math.max(0, t.grip ?? 0));
  const gi = $('tGrip').firstElementChild;
  gi.style.width = `${gr * 100}%`;
  gi.classList.toggle('hot', gr > 0.9);
  $('tAbs').classList.toggle('on', !!t.abs);
  $('tLat').textContent = `lat ${(t.lat ?? 0).toFixed(1).replace('.', ',')} m`;
}

function render() {
  const carCount = snap.cars.length;
  $('gridInfo').textContent = `${carCount}/${snap.maxCars} inscrites · ${snap.totalKm} km`;

  /* écran de fin : podium en overlay par-dessus la 3D figée */
  if (snap.phase === 'finished' && snap.me) { renderFinish(); return; }

  /* pas de voiture configurée → écran de configuration (inchangé) */
  if (!snap.me) {
    if (snap.phase !== 'preparation') {
      $('configureMsg').textContent = 'La course est en cours et votre voiture n\'est pas inscrite — attendez le prochain reset (admin).';
    }
    show('view-configure');
    $('cockpit').style.display = 'none';
    renderLiveries();
    return;
  }

  const me = snap.me;
  syncDraftFrom(me.plan);
  show(null);
  $('cockpit').style.display = 'block';

  /* préparation : bouton ORDINATEUR clignotant (le plan se règle là) */
  $('copBtn').classList.toggle('pulse', snap.phase === 'preparation');

  /* classement public (onglet CLASSEMENT) */
  const tb = $('standings').querySelector('tbody');
  tb.innerHTML = '';
  for (const c of snap.cars) {
    const tr = document.createElement('tr');
    if (me && c.id === me.id) tr.className = 'sel';
    tr.innerHTML = `<td>${c.rank}</td>
      <td><span class="dot" style="background:${c.color}"></span> ${c.name}</td>
      <td class="km">${c.km.toFixed(1)} km</td>
      <td class="mut">${stateLabel(c)}</td>`;
    tb.appendChild(tr);
  }

  $('personalizeRow').style.display = me.autoCreated ? 'flex' : 'none';
  renderTele();
  renderEvents(me.events);
  renderActions();
  if (snap.phase === 'preparation') drawProfile();
  else $('profWrap').style.display = 'none';
}

function renderEvents(events) {
  const ev = $('events');
  ev.innerHTML = '';
  for (const e of [...events].reverse()) {
    const p = document.createElement('p');
    p.innerHTML = `<b>${fmtClock(e.t)}</b> — ${e.msg}`;
    ev.appendChild(p);
  }
  /* bandeau + pastille non-lue JOURNAL : le point ambre marque
     l'onglet à chaque nouvel événement */
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
    setUnread('pgJournal');
  }
  lastEvents = [...events];
  /* bandeau défilant du dash : le dernier événement, défilement lent */
  const last = events[events.length - 1];
  $('lcdScrollTxt').textContent = last ? `${fmtClock(last.t)} — ${last.msg}` : '—';
}

function fmtClock(simT) {
  if (!snap) return '';
  const d = new Date(Date.now() - (snap.simT - simT) * 1000);
  return d.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
}

function renderFinish() {
  show('view-finish');
  $('cockpit').style.display = 'block';
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

/* ============================================================
   MINI-CARTE — dead reckoning du correctif 2 : entre deux polls,
   le point avance le long du cap (hd de la voiture publique), puis
   converge vers snap.me.pos. draw() tourne à CHAQUE frame (rAF)
   et lit posRender pour le point ET le recentrage de la vue.
   ============================================================ */
let view = { cx: 0, cy: 0, scale: 0.02 };
let drag = null;
let posRender = { x: 0, y: 0, has: false };
let snapAt = 0;   /* horodatage du snapshot : même extrapolation que la 3D */
let lastMapT = performance.now();

function resize() {
  const r = canvas.getBoundingClientRect();
  if (r.width === 0) return;
  canvas.width = r.width * devicePixelRatio;
  canvas.height = r.height * devicePixelRatio;
}
addEventListener('resize', resize);

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  view.scale *= e.deltaY < 0 ? 1.15 : 1 / 1.15;
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
});
canvas.addEventListener('pointerup', () => { drag = null; });

function w2s(x, y) {
  return [
    (x - view.cx) * view.scale + canvas.width / 2 / devicePixelRatio,
    -(y - view.cy) * view.scale + canvas.height / 2 / devicePixelRatio,
  ];
}

function animMap(now) {
  requestAnimationFrame(animMap);
  const dt = Math.min(0.1, (now - lastMapT) / 1000);
  lastMapT = now;
  const me = snap?.me;
  if (me) {
    if (!posRender.has) { posRender.x = me.pos.x; posRender.y = me.pos.y; posRender.has = true; }
    /* avance extrapolée le long du cap, v en m/s */
    const hd = me.hd ?? 0;
    posRender.x += Math.cos(hd) * (me.v / 3.6) * dt;
    posRender.y += Math.sin(hd) * (me.v / 3.6) * dt;
    /* convergence vers la position EXTRAPOLÉE (échantillon + v×âge) :
       converger vers l'échantillon gelé du poll faisait osciller le
       point exactement comme la 3D avant le même correctif */
    const age = Math.max(0, (now - snapAt) / 1000);
    const px = me.pos.x + Math.cos(me.hd) * (me.v / 3.6) * age;
    const py = me.pos.y + Math.sin(me.hd) * (me.v / 3.6) * age;
    const k = 1 - Math.exp(-dt / 0.7);
    posRender.x += (px - posRender.x) * k;
    posRender.y += (py - posRender.y) * k;
    if (!drag) {
      view.cx += (posRender.x - view.cx) * k;
      view.cy += (posRender.y - view.cy) * k;
    }
  }
  draw();
}

function draw() {
  const r = canvas.getBoundingClientRect();
  if (r.width === 0) return;
  if (canvas.width !== r.width * devicePixelRatio) resize();
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  if (!snap) return;
  if (routePts.length > 1) {
    ctx.strokeStyle = '#2f3b4c';
    ctx.lineWidth = Math.max(2, ROAD_W * view.scale * 1.2);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    for (const p of routePts) {
      const [sx, sy] = w2s(p.x, p.y);
      if (!started) { ctx.moveTo(sx, sy); started = true; } else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
  }
  /* autres voitures si l'API expose leur pos (admin/super) */
  for (const c of snap.cars ?? []) {
    if (snap.me && c.id === snap.me.id) continue;
    if (c.pos3) {
      const [sx, sy] = w2s(c.pos3.x, c.pos3.y);
      ctx.beginPath(); ctx.arc(sx, sy, 5, 0, 7);
      ctx.fillStyle = c.color; ctx.fill();
      ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#9aa5b1'; ctx.font = '10px system-ui';
      ctx.fillText(`${c.rank}. ${c.name}`, sx + 8, sy + 3);
    }
  }
  /* MA voiture : position interpolée (dead reckoning) */
  if (posRender.has) {
    const [sx, sy] = w2s(posRender.x, posRender.y);
    ctx.beginPath(); ctx.arc(sx, sy, 7, 0, 7);
    ctx.fillStyle = snap.me?.color ?? '#fff'; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#dce3ec'; ctx.font = '11px system-ui';
    ctx.fillText(`${snap.me.rank}. ${snap.me.name}`, sx + 9, sy + 4);
  }
}
requestAnimationFrame(animMap);

/* ============================================================
   TABLEAU DE BORD LCD — valeurs LISSÉES (lerp ~0,4 s) : pas
   d'à-coups ; les bargraphs changent de pas par segments (rendu
   LCD crédible, gratuit en perf).
   ============================================================ */
const sm = { v: null, fuel: null, fat: null, bud: null, wear: null, rank: null, gap: null };
function lerp(cur, tgt, k) { return cur === null ? tgt : cur + (tgt - cur) * k; }

function segBar(el, ratio, warnFrom) {
  /* ratio ∈ [0,1] ; les <i> sont créés une fois, seuls les pas
     allumés changent — pas de reflow à chaque frame */
  const N = 12;
  if (el.children.length !== N) {
    el.innerHTML = '';
    for (let i = 0; i < N; i++) el.appendChild(document.createElement('i'));
  }
  const on = Math.round(Math.min(1, Math.max(0, ratio)) * N);
  const warn = warnFrom !== undefined && ratio <= warnFrom;
  for (let i = 0; i < N; i++) {
    const seg = el.children[i];
    seg.className = i < on ? (warn ? 'warn' : 'on') : '';
  }
}

function fmtHMS(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function dashTick(pollK) {
  const me = snap?.me;
  if (!me) return;
  /* lissage : au poll, on tire vers la cible ; entre les polls la
     boucle rAF du dash continue de converger */
  const k = 1 - Math.exp(-(pollK ? 1.6 : 0.4) / 0.4);
  sm.v = lerp(sm.v, me.v, k);
  sm.fuel = lerp(sm.fuel, me.fuel, k);
  sm.fat = lerp(sm.fat, me.fatigue, k);
  sm.bud = lerp(sm.bud, me.budget, k);
  sm.wear = lerp(sm.wear, me.tireWear, k);
  sm.rank = me.rank;
  const prep = snap.phase === 'preparation';

  /* VITESSE — remplacée par le compte à rebours en préparation */
  if (prep) {
    const left = snap.startEpochMs - Date.now();
    $('cellSpd').querySelector('.lcdlabel').textContent = 'DÉPART DANS';
    const el = $('lcdSpd');
    el.classList.remove('amber', 'alert');
    el.innerHTML = `${fmtHMS(left)}`;
  } else {
    $('cellSpd').querySelector('.lcdlabel').textContent = 'VITESSE';
    $('lcdSpd').innerHTML = `${Math.round(sm.v)}<span class="u"> km/h</span>`;
  }

  /* CARBURANT : bargraph + litres ; alerte ambre sous 15 % */
  const fuelEl = $('lcdFuel');
  fuelEl.innerHTML = `${Math.round(sm.fuel)}<span class="u"> L</span>`;
  fuelEl.classList.toggle('amber', me.fuel < TANK * 0.15);
  segBar($('fuelSeg'), sm.fuel / TANK, TANK * 0.15);

  /* GOMMES : type + usure ; CREVÉE clignotante */
  const tireEl = $('lcdTire');
  if (me.punctured) {
    tireEl.textContent = 'CREVÉE';
    tireEl.className = 'lcdnum alert';
  } else {
    tireEl.textContent = `${me.tire.toUpperCase()} · ${Math.round(sm.wear * 100)}%`;
    tireEl.className = 'lcdnum' + (sm.wear > 0.85 ? ' amber' : '');
  }
  segBar($('tireSeg'), 1 - sm.wear, 0.15);

  /* VEILLE PILOTE : zone d'alerte au-delà de 20 h */
  const fatEl = $('lcdFat');
  fatEl.innerHTML = `${sm.fat.toFixed(1)}<span class="u"> h</span>`;
  fatEl.classList.toggle('amber', me.fatigue > 20);
  segBar($('fatSeg'), 1 - Math.min(1, sm.fat / 30), -1);
  $('fatSeg').querySelectorAll('i.on').forEach((i) => {
    if (me.fatigue > 20) i.className = 'warn';
  });

  /* BUDGET */
  $('lcdBud').innerHTML = `${Math.round(sm.bud).toLocaleString('fr-FR')}<span class="u"> €</span>`;

  /* POSITION : P{rank} + écart au leader en km */
  const leader = snap.cars[0];
  let posTxt = `P${sm.rank}`;
  if (sm.rank === 1) posTxt += ' LEADER';
  else if (snap.phase === 'finished' && me.finishedAt) posTxt += ` · ${fmtDur(me.finishedAt)}`;
  else posTxt += ` −${Math.max(0, (leader?.km ?? me.km) - me.km).toFixed(1)} km`;
  $('lcdPos').textContent = posTxt;

  /* HORLOGE de Paris */
  $('lcdClock').textContent = snap.clock ?? '—';
}

/* boucle rAF du dash : lissage continu entre les polls */
let lastDashT = performance.now();
function dashLoop(now) {
  requestAnimationFrame(dashLoop);
  const dt = Math.min(0.1, (now - lastDashT) / 1000);
  lastDashT = now;
  /* compte à rebours : il boucle à chaque frame, sinon il saute d'1 s */
  if (snap?.phase === 'preparation') dashTick(1);
  else if (dt) dashTick(0);
}
requestAnimationFrame(dashLoop);

/* ============================================================
   ORDINATEUR DU COPILOTE — fenêtre diégétique
   ============================================================ */
/* état persistant d'une visite à l'autre (ouverte/fermée, onglet) */
const copState = JSON.parse(localStorage.getItem('copilot') ?? '{"open":false,"tab":"pgMap"}');
let copOpen = copState.open;
let copTab = copState.tab;
const unread = new Set();

function saveCopState() {
  localStorage.setItem('copilot', JSON.stringify({ open: copOpen, tab: copTab }));
}

function copToggle(force) {
  copOpen = force !== undefined ? force : !copOpen;
  $('copilot').classList.toggle('open', copOpen);
  if (copOpen) {
    clearUnread(copTab);
    resize();
    if (snap?.phase === 'preparation') drawProfile();
  }
  saveCopState();
}

function copSelect(tab) {
  copTab = tab;
  for (const b of document.querySelectorAll('.copTab')) b.classList.toggle('act', b.dataset.page === tab);
  for (const p of document.querySelectorAll('.copPage')) p.classList.toggle('act', p.id === tab);
  clearUnread(tab);
  resize();
  if (snap?.phase === 'preparation') drawProfile();
  saveCopState();
}

function setUnread(page) {
  if (copOpen && copTab === page) return;
  unread.add(page);
  $(`button[data-page="${page}"]`)?.classList.add('unread');
}
function clearUnread(page) {
  unread.delete(page);
  $(`button[data-page="${page}"]`)?.classList.remove('unread');
}

$('copBtn').onclick = () => copToggle();
$('copClose').onclick = () => copToggle(false);
for (const b of document.querySelectorAll('.copTab')) {
  b.onclick = () => copSelect(b.dataset.page);
}

/* drag par la barre de titre + redimensionnement par le coin */
(function initCopilotWindow() {
  const win = $('copilot');
  const title = $('copTitle');
  const grip = $('copGrip');
  let st = null;
  title.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, select')) return;
    const r = win.getBoundingClientRect();
    st = { x: e.clientX, y: e.clientY, l: r.left, t: r.top, right: r.right, bottom: r.bottom };
    title.setPointerCapture(e.pointerId);
  });
  title.addEventListener('pointermove', (e) => {
    if (!st) return;
    const dx = e.clientX - st.x, dy = e.clientY - st.y;
    win.style.left = `${Math.max(0, st.l + dx)}px`;
    win.style.top = `${Math.max(0, st.t + dy)}px`;
    win.style.right = 'auto';
    win.style.bottom = 'auto';
  });
  title.addEventListener('pointerup', () => { st = null; });
  grip.addEventListener('pointerdown', (e) => {
    const r = win.getBoundingClientRect();
    st = { resize: true, x: e.clientX, y: e.clientY, w: r.width, h: r.height };
    grip.setPointerCapture(e.pointerId);
    e.stopPropagation();
  });
  grip.addEventListener('pointermove', (e) => {
    if (!st?.resize) return;
    win.style.width = `${Math.max(320, st.w + e.clientX - st.x)}px`;
    win.style.height = `${Math.max(240, st.h + e.clientY - st.y)}px`;
    resize();
    if (snap?.phase === 'preparation') drawProfile();
  });
  grip.addEventListener('pointerup', () => { st = null; });
})();

/* ============================================================
   PRÉPARATION — profil d'altitude complet dans l'onglet CARTE
   (drawProfile existant, POI non marqués)
   ============================================================ */
const BIOME_COLORS = ['#7cb342', '#2e7d32', '#e0a96d', '#90a4ae'];
const BIOME_NAMES = ['Plaine', 'Forêt', 'Désert', 'Altitude'];
let profData = null;

async function drawProfile() {
  if (!copOpen || copTab !== 'pgMap') return;
  const r = await api('/api/profile');
  if (!r) return;
  profData = await r.json();
  if (profData.phase !== 'preparation') return;
  $('profWrap').style.display = 'block';
  const d = profData;
  const cv = $('profMap'), c1 = cv.getContext('2d');
  const rect = cv.getBoundingClientRect();
  if (rect.width === 0) return;
  cv.width = rect.width * devicePixelRatio; cv.height = rect.height * devicePixelRatio;
  c1.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  const xs = d.pts.map(p => p.x), ys = d.pts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const sc = Math.min((rect.width - 20) / (maxX - minX || 1), (rect.height - 20) / (maxY - minY || 1));
  for (let i = 1; i < d.pts.length; i++) {
    c1.strokeStyle = BIOME_COLORS[d.pts[i].b] ?? '#888';
    c1.lineWidth = 3;
    c1.beginPath();
    c1.moveTo(10 + (d.pts[i - 1].x - minX) * sc, rect.height - 10 - (d.pts[i - 1].y - minY) * sc);
    c1.lineTo(10 + (d.pts[i].x - minX) * sc, rect.height - 10 - (d.pts[i].y - minY) * sc);
    c1.stroke();
  }
  const av = $('profAlt'), c2 = av.getContext('2d');
  const arect = av.getBoundingClientRect();
  av.width = arect.width * devicePixelRatio; av.height = arect.height * devicePixelRatio;
  c2.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  const hs = d.pts.map(p => p.h);
  const minH = Math.min(...hs), maxH = Math.max(...hs);
  const n = d.pts.length;
  for (let i = 1; i < n; i++) {
    c2.fillStyle = (BIOME_COLORS[d.pts[i].b] ?? '#555') + '44';
    c2.fillRect((i - 1) / n * arect.width, 0, arect.width / n + 1, arect.height);
  }
  c2.strokeStyle = '#dce3ec';
  c2.lineWidth = 1.5;
  c2.beginPath();
  for (let i = 0; i < n; i++) {
    const x = i / n * arect.width;
    const y = arect.height - 6 - (d.pts[i].h - minH) / (maxH - minH || 1) * (arect.height - 12);
    i === 0 ? c2.moveTo(x, y) : c2.lineTo(x, y);
  }
  c2.stroke();
  const kmB = [0, 0, 0, 0];
  for (let i = 1; i < n; i++) kmB[d.pts[i].b] += (d.pts[i].s - d.pts[i - 1].s) / 1000;
  $('profLegend').innerHTML = kmB.map((k, i) =>
    `<span style="color:${BIOME_COLORS[i]}">■</span> ${BIOME_NAMES[i]} ${Math.round(k)} km`).join(' · ');
}

/* ============================================================
   CONFIGURATION (inchangé) — la sélection vit dans une variable :
   la grille est reconstruite à chaque poll et le DOM effacé.
   ============================================================ */
let liveries = { palette: [], taken: [] };
let selectedColor = null;

async function renderLiveries() {
  const r = await api('/api/liveries');
  if (!r) return;
  liveries = await r.json();
  const box = $('liveryGrid');
  box.innerHTML = '';
  for (const col of liveries.palette) {
    const taken = liveries.taken.includes(col);
    const stillSel = col === selectedColor && !taken;
    if (col === selectedColor && taken) selectedColor = null;
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

$('personalizeBtn').onclick = async () => {
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

/* ============================================================
   PLAN (code existant, déplacé dans l'onglet STRATÉGIE)
   ============================================================ */
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

/* ============================================================
   CB (code existant, déplacé dans l'onglet CB) + LED du dash
   ============================================================ */
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
    let fresh = false;
    const seen = new Set([...box.children].map((c) => c.dataset.key));
    for (const m of d.msgs) {
      const key = `${m.t}|${m.carId}|${m.msg}`;
      if (seen.has(key)) { lastCbKeys.add(key); continue; }
      if (lastCbKeys.has(key)) continue;
      lastCbKeys.add(key);
      fresh = true;
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
    if (fresh) {
      /* LED CB sur le dash + pastille non-lue sur l'onglet CB */
      const led = $('cbLed');
      led.className = 'on';
      setUnread('pgCb');
      clearTimeout(led._t);
      led._t = setTimeout(() => { led.className = 'blink'; setTimeout(() => led.className = '', 4000); }, 1500);
    }
  } catch {}
}

/* ============================================================
   Sélecteur super utilisateur (bezel) + sortie
   ============================================================ */
async function initMe() {
  const r = await fetch('/api/me');
  if (r.status === 401) { location.href = '/login.html'; return null; }
  me = await r.json();
  /* accès admin-only : le bouton du bezel + les liens discrets des
     overlays (configuration, podium) — jamais visibles d'un joueur
     ou d'un super (display='' retire le display:none inline) */
  if (me.level === 'admin') {
    /* télémétrie debug : visible du seul COMPTE admin — un joueur qui
       regarde une voiture admin ne doit rien voir (me = le compte) */
    /* debug 8 Hz : interval lancé UNIQUEMENT pour le compte admin —
       joueur/super ne doivent AUCUN polling supplémentaire (l'endpoint
       les 403 de toute façon) */
    setInterval(pollTele, 33);   /* ~30 Hz : la simulation serveur tourne en rafales de 33 ms */
    $('tele').style.display = 'block';
    for (const id of ['adminLink', 'adminLinkCfg', 'adminLinkFin']) {
      const el = $(id);
      if (el) el.style.display = '';
    }
  }
  if (me.level !== 'player') {
    const sel = $('viewCar');
    sel.style.display = 'block';
    const cr = await api('/api/cars');
    if (cr) {
      const d = await cr.json();
      sel.innerHTML = '<option value="">— ma voiture —</option>';
      for (const c of d.cars) {
        const o = document.createElement('option');
        o.value = c.id; o.textContent = c.name;
        sel.appendChild(o);
      }
    }
  }
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

/* ============================================================
   Boot — une seule instance WebGL, une seule source de vérité
   ============================================================ */
(async () => {
  if (!(await initMe())) return;
  /* le moteur 3D peut échouer (CDN) : le poste reste utilisable
     (dash + ordinateur) — la 3D est la vue principale, pas un
     prérequis dur */
  try {
    await W.init($('scene3d'));
    world3dReady = true;
  } catch (e) { /* CDN three indisponible : cockpit sans 3D */ }
  resize();
  setInterval(poll, 1000);
  setInterval(pollCb, 2000);
  poll();
  if (copOpen) copToggle(true);
  copSelect(copTab);
})();
