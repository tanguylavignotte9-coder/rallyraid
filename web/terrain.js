/* ============================================================
   CHAMP DE MONDE — copie NAVIGATEUR de core/terrain.ts (n°26).
   Le navigateur ne strip pas le TypeScript : cette copie JS pure
   donne H/Hroad + les champs climatiques n°33 au rendu. Identique
   au cœur AU BIT PRÈS — garanti par tests/terrain-web.test.ts.
   SI core/terrain.ts CHANGE, cette copie change EN MÊME TEMPS
   (le test CI échoue sinon).
   ============================================================ */

const O1 = { lam: 32000, amp: 550, so: 101 };  // relief macro (massifs, bassins)
const O2 = { lam: 8000,  amp: 160, so: 202 };  // moyennes collines
const O3 = { lam: 2000,  amp: 45,  so: 303 };  // collines locales
const O4 = { lam: 520,   amp: 22,  so: 404 };  // fin : ravins, creux de rivières

function ghash(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 974634733);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;   // [0, 1)
}
function sm(t) { return t * t * (3 - 2 * t); }
function vnoise(x, y, seed, so) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = sm(x - ix), fy = sm(y - iy);
  const a = ghash(ix, iy, seed + so);
  const b = ghash(ix + 1, iy, seed + so);
  const c = ghash(ix, iy + 1, seed + so);
  const d = ghash(ix + 1, iy + 1, seed + so);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;  // [0, 1)
}
const oct = (o, x, y, seed, k = 1) =>
  k * o.amp * (vnoise(x / o.lam, y / o.lam, seed, o.so) * 2 - 1);

/* terrain environnant (m) */
export function H(x, y, seed) {
  return oct(O1, x, y, seed) + oct(O2, x, y, seed) + oct(O3, x, y, seed) + oct(O4, x, y, seed);
}

/* plateforme routière (m) — cf. core/terrain.ts. n°32 : O3 à 80 %,
   À L'IDENTIQUE du cœur (test CI d'égalité bit à bit). */
export function Hroad(x, y, seed) {
  return oct(O1, x, y, seed) + oct(O2, x, y, seed) + oct(O3, x, y, seed, 0.8);
}

/* ============================================================
   n°33 — CHAMPS CLIMATIQUES (copie navigateur, bit à bit identique)
   ============================================================ */

export const SEA_SL = -240;   // m : niveau de la mer

const HUM1 = 140000, HUM2 = 480000, TN = 900000;
const TW = 5200000;
const TW_AMP = 15, TN_AMP = 3, T_BASE = 17;
const ORO_D = 10000, ORO_K = 120, ORO_W = 0.22;
const COAST_W = 0.20, COAST_RISE = 60;

const shash = (seed, so) => ghash(0, 0, seed + so);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const ss = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export function Hmacro(x, y, seed) {
  return oct(O1, x, y, seed) + oct(O2, x, y, seed);
}

export function windAt(seed) {
  const a = shash(seed, 808) * Math.PI * 2;
  return { wx: Math.cos(a), wy: Math.sin(a) };
}

export function coastAt(x, y, seed) {
  return 1 - clamp01((Hmacro(x, y, seed) - SEA_SL) / COAST_RISE);
}

export function tempAt(x, y, seed) {
  const th = (shash(seed, 909) - 0.5) * 50 * Math.PI / 180;
  const u = x * Math.cos(th) + y * Math.sin(th);
  const wave = Math.cos(2 * Math.PI * u / TW + shash(seed, 919) * Math.PI * 2);
  const reg = vnoise(x / TN, y / TN, seed, 707) * 2 - 1;
  return T_BASE + TW_AMP * wave + TN_AMP * reg
       - 6.5 * Math.max(0, H(x, y, seed)) / 1000;
}

export function moistAt(x, y, seed) {
  const v1 = vnoise(x / HUM1, y / HUM1, seed, 505);
  const v2 = vnoise(x / HUM2, y / HUM2, seed, 606);
  const w = windAt(seed);
  const oro = (H(x, y, seed) - H(x - w.wx * ORO_D, y - w.wy * ORO_D, seed)) / ORO_K;
  return clamp01(0.50 + (v1 - 0.5) * 0.72 + (v2 - 0.5) * 0.36
       + ORO_W * (oro < -1 ? -1 : oro > 1 ? 1 : oro)
       + COAST_W * coastAt(x, y, seed));
}

export const FAM_NAMES = ['Plaine', 'Désert', 'Forêt', 'Boréal', 'Altitude', 'Littoral'];
export const FAM_ALT = 220;
export const FAM_COAST = 0.5;
export const FAM_DRY = 0.30;
export const FAM_COLD = 5;   // °C — cf. core/terrain.ts (calibré, mesuré)
export const FAM_WET = 0.62;

export function famAt(x, y, seed) {
  if (Hroad(x, y, seed) > FAM_ALT) return 4;
  if (coastAt(x, y, seed) > FAM_COAST) return 5;
  const m = moistAt(x, y, seed);
  if (m < FAM_DRY) return 1;
  if (tempAt(x, y, seed) < FAM_COLD) return 3;
  if (m > FAM_WET) return 2;
  return 0;
}

export function flowAccum(grid, w, h) {
  const n = w * h;
  const acc = new Int32Array(n);
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) { order[i] = i; acc[i] = 1; }
  const ord = Array.from(order).sort((a, b) => grid[b] - grid[a]);
  for (let k = 0; k < n; k++) {
    const i = ord[k];
    const x = i % w, y = (i / w) | 0;
    let best = -1, bh = grid[i];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx2 = x + dx, ny2 = y + dy;
      if (nx2 < 0 || ny2 < 0 || nx2 >= w || ny2 >= h) continue;
      const j = ny2 * w + nx2;
      if (grid[j] < bh) { bh = grid[j]; best = j; }
    }
    if (best >= 0) acc[best] += acc[i];
  }
  return acc;
}

export const CAUSEWAY_H = 12;

export function HroadC(x, y, seed) {
  return Math.max(Hroad(x, y, seed), SEA_SL + CAUSEWAY_H);
}
