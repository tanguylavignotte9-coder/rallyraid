/* Poste de stratège : lit le snapshot serveur (1 s), dessine la carte de
   l'itinéraire autour de la voiture sélectionnée, et édite son plan. */
const $ = (id) => document.getElementById(id);
const canvas = $('map');
const ctx = canvas.getContext('2d');
const ROAD_W = 7.5;

let snap = null;
let selId = 0;
let draft = { power: 1, actions: [] };
let nextLocalId = -1;

/* ---- carte : la géométrie vient du serveur (points de la voiture + un
   tracé local reconstruit par polling autour de la sélection) ---- */
let routePts = [];        // points du tracé [{x,y}]
let view = { cx: 0, cy: 0, scale: 0.02 }; // scale: px par mètre
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
  const k = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  view.scale *= k;
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
canvas.addEventListener('pointerup', (e) => {
  if (drag && !drag.moved) {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    for (const c of snap?.cars ?? []) {
      const sx = (c.pos.x - view.cx) * view.scale + canvas.width / 2 / devicePixelRatio;
      const sy = -(c.pos.y - view.cy) * view.scale + canvas.height / 2 / devicePixelRatio;
      if (Math.hypot(px - sx, py - sy) < 14) { selId = c.id; syncDraft(); break; }
    }
    draw();
  }
  drag = null;
});

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
  const sel = snap.cars.find((c) => c.id === selId) ?? snap.cars[0];
  if (sel) {
    view.cx += (sel.pos.x - view.cx) * 0.08;
    view.cy += (sel.pos.y - view.cy) * 0.08;
  }
  // tracé
  ctx.strokeStyle = '#2f3b4c';
  ctx.lineWidth = Math.max(2, ROAD_W * view.scale * 1.2);
  ctx.lineJoin = 'round';
  if (routePts.length > 1) {
    ctx.beginPath();
    let started = false;
    for (const p of routePts) {
      const [sx, sy] = w2s(p.x, p.y);
      if (!started) { ctx.moveTo(sx, sy); started = true; }
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
  }
  // voitures
  for (const c of snap.cars) {
    const [sx, sy] = w2s(c.pos.x, c.pos.y);
    if (sx < -30 || sy < -30 || sx > canvas.width + 30 || sy > canvas.height + 30) continue;
    const r = c.id === selId ? 7 : 5;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, 7);
    ctx.fillStyle = c.color;
    ctx.fill();
    ctx.strokeStyle = c.id === selId ? '#fff' : '#000';
    ctx.lineWidth = c.id === selId ? 2 : 1;
    ctx.stroke();
    ctx.fillStyle = '#dce3ec';
    ctx.font = '11px system-ui';
    ctx.fillText(`${c.rank}. ${c.name}`, sx + 9, sy + 4);
  }
}

/* ---- polling serveur ---- */
async function poll() {
  try {
    const r = await fetch('/api/state');
    snap = await r.json();
    $('conn').textContent = 'connecté';
    $('conn').className = 'on';
    render();
    await fetchRoutePts();
    draw();
  } catch {
    $('conn').textContent = 'déconnecté';
    $('conn').className = 'off';
  }
}

let trackS = -1;
async function fetchRoutePts() {
  const sel = snap?.cars.find((c) => c.id === selId) ?? snap?.cars[0];
  if (!sel) return;
  const s0 = Math.max(0, sel.km * 1000 - 30_000);
  if (Math.abs(s0 - trackS) < 5_000) return;
  trackS = s0;
  const r = await fetch(`/api/track?s0=${s0}&len=60000&step=120`);
  const d = await r.json();
  routePts = d.pts;
}

function fmtDur(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h} h ${String(m).padStart(2, '0')}`;
}

function render() {
  $('clock').textContent = snap.clock;
  $('raceInfo').textContent = `· ${snap.totalKm} km · graine ${snap.seed}`;
  const tb = $('standings').querySelector('tbody');
  tb.innerHTML = '';
  for (const c of snap.cars) {
    const tr = document.createElement('tr');
    tr.className = c.id === selId ? 'sel' : '';
    const state = c.st === 'finish' ? '🏁'
      : c.st === 'stop' ? (c.stopKind === 'hotel' ? '😴' : c.stopKind === 'station' ? '⛽' : c.stopKind === 'dry' ? '🆘' : c.stopKind === 'roadside' ? '🛏️' : '🔧')
      : c.st === 'toStop' ? '→✋' : '';
    tr.innerHTML = `<td>${c.rank}</td>
      <td><span class="dot" style="background:${c.color}"></span> ${c.name}</td>
      <td class="km">${c.km.toFixed(1)} km</td>
      <td>${state}</td>`;
    tr.onclick = () => { selId = c.id; syncDraft(); render(); draw(); };
    tb.appendChild(tr);
  }
  const sel = snap.cars.find((c) => c.id === selId) ?? snap.cars[0];
  if (!sel) return;
  $('carName').textContent = sel.name;
  $('fuelTxt').textContent = `${sel.fuel.toFixed(0)} L`;
  $('fuelBar').style.width = `${Math.min(100, sel.fuel / 520 * 100)}%`;
  $('fatTxt').textContent = `${sel.fatigue.toFixed(1)} h de veille`;
  $('fatBar').style.width = `${Math.min(100, sel.fatigue / 30 * 100)}%`;
  $('spdTxt').textContent = `${sel.v.toFixed(0)} km/h`;
  $('spdBar').style.width = `${Math.min(100, sel.v / 198 * 100)}%`;
  $('planTitle').textContent = `Stratégie — ${sel.name}`;
  const ev = $('events');
  ev.innerHTML = '';
  for (const e of [...sel.events].reverse()) {
    const p = document.createElement('p');
    const t = new Date(snap.simT ? 0 : 0);
    p.innerHTML = `<b>${fmtClock(e.t)}</b> — ${e.msg}`;
    ev.appendChild(p);
  }
  renderActions();
}

function fmtClock(simT) {
  if (!snap) return '';
  const d = new Date(Date.now() - (snap.simT - simT) * 1000);
  return d.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
}

function syncDraft() {
  const sel = snap?.cars.find((c) => c.id === selId);
  if (sel) {
    draft = JSON.parse(JSON.stringify(sel.plan));
    $('power').value = draft.power;
  }
  renderActions();
}

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
    else txt = JSON.stringify(a);
    div.innerHTML = `<span style="flex:1">${txt}</span>`;
    const del = document.createElement('button');
    del.textContent = '✕';
    del.onclick = () => {
      draft.actions = draft.actions.filter((x) => x.id !== a.id);
      renderActions();
    };
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

$('power').oninput = (e) => { draft.power = Number(e.target.value); };

$('savePlan').onclick = async () => {
  const sel = snap.cars.find((c) => c.id === selId);
  if (!sel) return;
  const r = await fetch('/api/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ carId: sel.id, plan: draft }),
  });
  if (r.ok) { $('savePlan').textContent = 'Plan appliqué ✓'; setTimeout(() => $('savePlan').textContent = 'Appliquer le plan', 1200); }
};

setInterval(poll, 1000);
poll();
