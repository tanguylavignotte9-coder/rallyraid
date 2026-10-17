/* Page admin (accès level admin) : comptes + reset de course. */
const $ = (id) => document.getElementById(id);
const err = (m) => { $('msg').textContent = m || ''; };

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (r.status === 401) { location.href = '/login.html'; return null; }
  if (r.status === 403) { err('Accès réservé aux administrateurs.'); return null; }
  return r;
}

async function loadAccounts() {
  const r = await api('/api/admin/accounts');
  if (!r) return;
  const d = await r.json();
  const tb = $('accounts').querySelector('tbody');
  tb.innerHTML = '';
  for (const a of d.accounts) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${a.username}</td>
      <td>${a.level}</td>
      <td>${a.disabled ? 'désactivé' : 'actif'}</td>
      <td>${a.carId ?? '—'}</td>
      <td>
        <button data-user="${a.username}" data-act="reset-pass">mdp</button>
        <button data-user="${a.username}" data-act="level">${a.level === 'super' ? 'retirer super' : 'super'}</button>
        <button data-user="${a.username}" data-act="disable">${a.disabled ? 'activer' : 'désactiver'}</button>
      </td>`;
    tb.appendChild(tr);
  }
  for (const b of tb.querySelectorAll('button')) {
    b.onclick = () => accountAction(b.dataset.user, b.dataset.act, b.textContent);
  }
}

async function accountAction(user, act, label) {
  err('');
  if (act === 'reset-pass') {
    const pass = prompt(`Nouveau mot de passe pour « ${user} » (6 caractères min.) :`);
    if (!pass) return;
    const r = await api('/api/admin/reset-pass', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user, pass }),
    });
    if (r && r.status === 200) err(`Mot de passe de « ${user} » réinitialisé.`);
    else err('Échec de la réinitialisation.');
  } else if (act === 'level') {
    const level = label === 'super' ? 'super' : 'player';
    const r = await api('/api/admin/level', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user, level }),
    });
    if (r && r.status === 200) err(`Niveau de « ${user} » modifié (${level}).`);
  } else if (act === 'disable') {
    const disabled = label === 'désactiver';
    const r = await api('/api/admin/disable', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user, disabled }),
    });
    if (r && r.status === 200) err(`Compte « ${user} » ${disabled ? 'désactivé' : 'réactivé'}.`);
  }
  loadAccounts();
}

$('createForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  err('');
  const r = await api('/api/admin/accounts', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user: $('newUser').value, pass: $('newPass').value,
      level: $('newLevel').value,
    }),
  });
  if (!r) return;
  const d = await r.json();
  if (r.status === 200) {
    err(`Compte « ${$('newUser').value} » créé.`);
    $('createForm').reset();
    loadAccounts();
  } else err(d.error ?? 'échec');
});

/* ---- reset de course ---- */
async function loadRace() {
  const r = await api('/api/admin/race');
  if (!r) return;
  const d = await r.json();
  const c = d.config;
  $('cfgSeed').value = c.seed;
  $('cfgKm').value = c.totalKm;
  const pad = (n) => String(n).padStart(2, '0');
  /* préremplissage FUTUR : si la course en cours est partie, sa date
     de départ est dans le passé — la renvoyer telle quelle faisait
     repartir la nouvelle course immédiatement (reset « sans effet »).
     On propose : la date configurée si elle est encore à venir,
     sinon maintenant + 60 min. */
  const startMs = c.startEpochMs > Date.now() ? c.startEpochMs : Date.now() + 60 * 60_000;
  const dStart = new Date(startMs);
  $('cfgStart').value = `${dStart.getFullYear()}-${pad(dStart.getMonth() + 1)}-${pad(dStart.getDate())}T${pad(dStart.getHours())}:${pad(dStart.getMinutes())}`;
  $('cfgPrep').value = c.prepMinutes;
  $('cfgEnd').value = c.endType;
  $('cfgEndHours').value = c.endHours;
  $('cfgSurvival').value = c.survivalHours;
  $('cfgPoi').value = c.poiDensity;
  $('cfgMaxCars').value = c.maxCars;
  $('racePhase').textContent = d.phase;
  $('raceCars').textContent = d.cars;
  /* le bouton de départ immédiat n'a de sens qu'en préparation */
  $('departNow').style.display = d.phase === 'preparation' ? 'block' : 'none';
}

$('cfgEnd').onchange = () => {
  $('cfgEndHours').disabled = $('cfgEnd').value !== 'duration';
};

$('resetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  err('');
  if (!$('resetConfirm').checked) { err('Cochez la case de confirmation.'); return; }
  const body = {
    seed: Number($('cfgSeed').value),
    totalKm: Number($('cfgKm').value),
    prepMinutes: Number($('cfgPrep').value),
    endType: $('cfgEnd').value,
    endHours: Number($('cfgEndHours').value),
    survivalHours: Number($('cfgSurvival').value),
    poiDensity: Number($('cfgPoi').value),
    maxCars: Number($('cfgMaxCars').value),
  };
  /* date sûre : un champ vide/invalide faisait JETER une exception à
     toISOString() → POST jamais envoyé, clic muet. On n'envoie
     startIso que si la date se parse, sinon le serveur applique son
     défaut (maintenant + fenêtre de préparation). */
  const t = Date.parse($('cfgStart').value);
  if (!Number.isNaN(t)) body.startIso = new Date(t).toISOString();
  const r = await api('/api/admin/reset', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r) return;
  const d = await r.json();
  if (r.status === 200) {
    $('resetConfirm').checked = false;   /* re-confirmation obligatoire au prochain reset */
    err('Nouvelle course créée — départ le ' + new Date(d.startEpochMs).toLocaleString('fr-FR'));
  }
  else err(d.error ?? 'échec du reset');
  loadRace();
});

$('departNow').onclick = async () => {
  if (!confirm('Donner le départ maintenant ? La grille est figée et les absents partent avec le plan par défaut.')) return;
  const r = await api('/api/admin/depart', { method: 'POST' });
  if (!r) return;
  if (!r.ok) {
    const d = await r.json();
    err(d.error ?? 'départ impossible');
    return;
  }
  err('Départ donné.');
  loadRace();
};

$('logoutBtn').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
};

/* ---- explorateur de graines : mini-carte vue de dessus (couleurs par
   biome), profil d'altitude, stats — calculé par le même code serveur
   que la course (aucune divergence possible) ---- */
const BIOME_COLORS = ['#7cb342', '#2e7d32', '#e0a96d', '#90a4ae'];
const BIOME_NAMES = ['Plaine', 'Forêt', 'Désert', 'Altitude'];

$('seedGo').onclick = loadSeedMap;

async function loadSeedMap() {
  const seed = Number($('seedProbe').value);
  const r = await api(`/api/admin/seedmap?seed=${seed}&km=${$('cfgKm').value || 1000}`);
  if (!r) return;
  const d = await r.json();
  drawSeedMap(d);
  drawSeedAlt(d);
  const t = d.turns;
  $('seedStats').innerHTML =
    `<b>Graine ${d.seed}</b> — ${d.totalKm} km · alt. ${Math.round(d.altMin)}–${Math.round(d.altMax)} m<br>` +
    `Biomes : ${d.kmBiome.map((k, i) => `${BIOME_NAMES[i]} ${Math.round(k)} km`).join(' · ')}<br>` +
    `Virages : ${t.epingles} épingles · ${t.serres} serrés · ${t.rapides} rapides — plus longue droite ${t.plusLongueDroite} m<br>` +
    `POI : ${d.poiPer100km} / 100 km`;
}

function drawSeedMap(d) {
  const cv = $('seedMap');
  cv.style.display = 'block';
  const r = cv.getBoundingClientRect();
  cv.width = r.width * devicePixelRatio; cv.height = r.height * devicePixelRatio;
  const ctx = cv.getContext('2d');
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  const xs = d.pts.map(p => p.x), ys = d.pts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const sc = Math.min((r.width - 20) / (maxX - minX || 1), (r.height - 20) / (maxY - minY || 1));
  const px = x => 10 + (x - minX) * sc;
  const py = y => r.height - 10 - (y - minY) * sc;
  for (let i = 1; i < d.pts.length; i++) {
    ctx.strokeStyle = BIOME_COLORS[d.pts[i].b] ?? '#888';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(px(d.pts[i - 1].x), py(d.pts[i - 1].y));
    ctx.lineTo(px(d.pts[i].x), py(d.pts[i].y));
    ctx.stroke();
  }
}

function drawSeedAlt(d) {
  const cv = $('seedAlt');
  cv.style.display = 'block';
  const r = cv.getBoundingClientRect();
  cv.width = r.width * devicePixelRatio; cv.height = r.height * devicePixelRatio;
  const ctx = cv.getContext('2d');
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  const hs = d.pts.map(p => p.h);
  const minH = Math.min(...hs), maxH = Math.max(...hs);
  const n = d.pts.length;
  for (let i = 1; i < n; i++) {
    ctx.strokeStyle = BIOME_COLORS[d.pts[i].b] ?? '#888';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo((i - 1) / n * r.width, r.height - 4 - (d.pts[i - 1].h - minH) / (maxH - minH || 1) * (r.height - 8));
    ctx.lineTo(i / n * r.width, r.height - 4 - (d.pts[i].h - minH) / (maxH - minH || 1) * (r.height - 8));
    ctx.stroke();
  }
}

loadAccounts();
loadRace();
setInterval(loadRace, 10000);
