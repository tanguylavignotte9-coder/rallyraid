/* ============================================================
   VUE 3D SPECTATEUR — client MINCE de world3d.js
   ============================================================
   Toute la 3D vit dans le module partagé (une seule scène WebGL,
   une seule instance par page). Ici : uniquement le chrome de la
   page spectateur — sélecteur de voiture, bandeau d'événements,
   plein écran, retour au poste de stratège. Aucune régression :
   mêmes éléments, même comportement. */

import * as W from './world3d.js';

const $ = (id) => document.getElementById(id);
let snap = null;
let prev = null;

/* ---- poll 1 s : LA source de vérité (même flux que le stratège) ;
   setData alimente le moteur 3D qui, lui, interpole entre les polls. */
async function api(path) {
  const r = await fetch(path);
  if (r.status === 401) { location.href = '/login.html'; return null; }
  return r;
}

let pollBusy = false;

async function poll() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    const r = await api('/api/state');
    if (!r) return;
    const d = await r.json();
    if (!d.cars?.length) return;
    prev = snap;
    snap = d;
    $('clock').textContent = d.clock;
    renderCarList();
    W.setData(d);
    /* bandeau d'événements en direct (même flux que le stratège) */
    const mine = d.me?.events ?? [];
    if (prev && mine.length) {
      const old = prev.me?.events ?? [];
      for (const e of mine.slice(-4)) {
        if (!old.some((o) => o.t === e.t && o.msg === e.msg)) flash(e.msg);
      }
    }
  } catch { /* silence — le prochain tick réessaie */ } finally {
    pollBusy = false;
  }
}

function flash(msg) {
  const b = document.createElement('div');
  b.className = 'flash';
  b.textContent = msg;
  $('flash').prepend(b);
  setTimeout(() => b.remove(), 8000);
  while ($('flash').children.length > 4) $('flash').lastChild.remove();
}

function renderCarList() {
  const sel = $('carSel');
  const ids = snap.cars.map((c) => c.id).join(',');
  if (sel.dataset.ids !== ids) {
    sel.dataset.ids = ids;
    sel.innerHTML = '';
    for (const c of snap.cars) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = `${c.rank}. ${c.name}`;
      sel.appendChild(o);
    }
  }
  sel.value = String(W.getFollow());
}

$('carSel').onchange = (e) => {
  W.setFollow(Number(e.target.value));
};
$('backBtn').onclick = () => location.href = '/';
$('fsBtn').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
};

/* ---- boot : init, premier poll, puis rafraîchissement du monde ---- */
(async () => {
  try {
    await W.init($('scene'));
  } catch (e) {
    $('err').style.display = 'grid';
    return;
  }
  await poll();
  await W.refreshWorldNow();
  setInterval(poll, 67);   /* ~15 Hz, même flux que le stratège */
  setInterval(() => W.refreshWorldNow(), 3000);
})();
