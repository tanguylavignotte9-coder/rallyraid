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
  const dStart = new Date(c.startEpochMs);
  const pad = (n) => String(n).padStart(2, '0');
  $('cfgStart').value = `${dStart.getFullYear()}-${pad(dStart.getMonth() + 1)}-${pad(dStart.getDate())}T${pad(dStart.getHours())}:${pad(dStart.getMinutes())}`;
  $('cfgPrep').value = c.prepMinutes;
  $('cfgEnd').value = c.endType;
  $('cfgEndHours').value = c.endHours;
  $('cfgSurvival').value = c.survivalHours;
  $('cfgPoi').value = c.poiDensity;
  $('cfgNightMode').value = c.nightMode;
  $('cfgNightValue').value = c.nightValue;
  $('cfgMaxCars').value = c.maxCars;
  $('racePhase').textContent = d.phase;
  $('raceCars').textContent = d.cars;
}

$('cfgEnd').onchange = () => {
  $('cfgEndHours').disabled = $('cfgEnd').value !== 'duration';
};
$('cfgNightMode').onchange = () => {
  if ($('cfgNightMode').value === 'cap') {
    $('cfgNightValue').value = 110;
  } else {
    $('cfgNightValue').value = 0.85;
  }
};

$('resetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  err('');
  if (!$('resetConfirm').checked) { err('Cochez la case de confirmation.'); return; }
  const body = {
    seed: Number($('cfgSeed').value),
    totalKm: Number($('cfgKm').value),
    startIso: new Date($('cfgStart').value).toISOString(),
    prepMinutes: Number($('cfgPrep').value),
    endType: $('cfgEnd').value,
    endHours: Number($('cfgEndHours').value),
    survivalHours: Number($('cfgSurvival').value),
    poiDensity: Number($('cfgPoi').value),
    nightMode: $('cfgNightMode').value,
    nightValue: Number($('cfgNightValue').value),
    maxCars: Number($('cfgMaxCars').value),
  };
  const r = await api('/api/admin/reset', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r) return;
  const d = await r.json();
  if (r.status === 200) err('Nouvelle course créée — phase « préparation ».');
  else err(d.error ?? 'échec du reset');
  loadRace();
});

$('logoutBtn').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
};

loadAccounts();
loadRace();
setInterval(loadRace, 10000);
