/* ============================================================
   CHAMP DE MONDE — copie NAVIGATEUR de core/terrain.ts (n°26).
   Le navigateur ne strip pas le TypeScript : cette copie JS pure
   donne H/Hroad + les champs climatiques n°33 au rendu. Identique
   au cœur AU BIT PRÈS — garanti par tests/terrain-web.test.ts.
   SI core/terrain.ts CHANGE, cette copie change EN MÊME TEMPS
   (le test CI échoue sinon).
   ============================================================ */

/* n°42 — GÉNÉRATEUR DE MONDE PARAMÉTRABLE (page admin) : les constantes
   du champ deviennent des RÉGLAGES de course. WP est l'objet VIF : H lit
   WP en direct, setWorldParams l'écrase EN PLACE (Object.assign — jamais
   un remplacement d'objet, les imports vivants doivent suivre).
   Déterminisme ADR 0004 INTACT : le monde reste une fonction pure de
   (graine, x, y, world). Jumeau bit à bit de core/terrain.ts (n°26). */
export const WORLD_DEFAULT = {
  amp1: 550, lam1: 32000,
  amp2: 160, lam2: 8000,
  amp3: 45,  lam3: 2000,
  amp4: 22,  lam4: 520,
  seaLevel: -240,
  tempBase: 17, tempLat: 15,
  famAlt: 220, famCoast: 0.5, famDry: 0.30, famCold: 5, famWet: 0.62,
};
/* bornes de clamp (l'admin ne doit pas pouvoir délirer : lam1 petit =
   monde en escalier, seaLevel > 0 = monde englouti, etc.) */
export const WORLD_BOUNDS = {
  amp1: [0, 2000], lam1: [8000, 128000],
  amp2: [0, 600],  lam2: [2000, 32000],
  amp3: [0, 200],  lam3: [500, 8000],
  amp4: [0, 100],  lam4: [130, 2000],
  seaLevel: [-600, 0],
  tempBase: [-5, 35], tempLat: [0, 30],
  famAlt: [80, 600], famCoast: [0.1, 0.9], famDry: [0, 0.5],
  famCold: [-5, 15], famWet: [0.4, 0.9],
};
export const WP = { ...WORLD_DEFAULT };
export function setWorldParams(p) {
  Object.assign(WP, WORLD_DEFAULT, p ?? {});
  for (const k of Object.keys(WORLD_DEFAULT)) {
    const lo = WORLD_BOUNDS[k][0], hi = WORLD_BOUNDS[k][1];
    const v = WP[k];
    WP[k] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : WORLD_DEFAULT[k];
  }
}

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
const oct = (lam, amp, so, x, y, seed, k = 1) =>
  k * amp * (vnoise(x / lam, y / lam, seed, so) * 2 - 1);

/* n°43 — OCTAVES FINES DE TOPOLOGIE : le relief à l'échelle de la
   voiture (pente ~7,5 % > seuil doux 1 % du contrôleur de route →
   la route émergente TISSE, banc bench-n42-emergente). Ajoutées à
   H SEULEMENT : Hroad/Hmacro (donc famAt, climats, mer) ne les voient
   PAS — la classification gameplay est inchangée. Calibration proto
   n°42 : λ160×4 m + λ60×1,5 m — sous cette énergie la route
   émergente est une autoroute (volant 60°/km mesuré), au-dessus elle
   délire. Constantes en dur (PAS des réglages admin n°42). */
export const FINE1_LAM = 160, FINE1_AMP = 4.0, FINE1_SO = 505;
export const FINE2_LAM = 60, FINE2_AMP = 1.5, FINE2_SO = 606;

/* terrain environnant (m) */
export function H(x, y, seed) {
  return oct(WP.lam1, WP.amp1, 101, x, y, seed) + oct(WP.lam2, WP.amp2, 202, x, y, seed)
       + oct(WP.lam3, WP.amp3, 303, x, y, seed) + oct(WP.lam4, WP.amp4, 404, x, y, seed)
       + oct(FINE1_LAM, FINE1_AMP, FINE1_SO, x, y, seed)
       + oct(FINE2_LAM, FINE2_AMP, FINE2_SO, x, y, seed);
}

/* plateforme routière (m) — cf. core/terrain.ts. n°32 : O3 à 80 %,
   À L'IDENTIQUE du cœur (test CI d'égalité bit à bit). */
export function Hroad(x, y, seed) {
  return oct(WP.lam1, WP.amp1, 101, x, y, seed) + oct(WP.lam2, WP.amp2, 202, x, y, seed)
       + oct(WP.lam3, WP.amp3, 303, x, y, seed, 0.8);
}

/* ============================================================
   n°33 — CHAMPS CLIMATIQUES (copie navigateur, bit à bit identique)
   ============================================================ */

export const SEA_SL = -240;   // m : niveau DÉFAUT de la mer — le niveau ACTIF est
                             // WP.seaLevel (l'export reste : test terrain-web,
                             // compat)

const HUM1 = 140000, HUM2 = 480000, TN = 900000;
const TW = 5200000;
const TN_AMP = 3;
const ORO_D = 10000, ORO_K = 120, ORO_W = 0.22;
const COAST_W = 0.20, COAST_RISE = 60;

const shash = (seed, so) => ghash(0, 0, seed + so);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const ss = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export function Hmacro(x, y, seed) {
  return oct(WP.lam1, WP.amp1, 101, x, y, seed) + oct(WP.lam2, WP.amp2, 202, x, y, seed);
}

export function windAt(seed) {
  const a = shash(seed, 808) * Math.PI * 2;
  return { wx: Math.cos(a), wy: Math.sin(a) };
}

export function coastAt(x, y, seed) {
  return 1 - clamp01((Hmacro(x, y, seed) - WP.seaLevel) / COAST_RISE);
}

export function tempAt(x, y, seed) {
  const th = (shash(seed, 909) - 0.5) * 50 * Math.PI / 180;
  const u = x * Math.cos(th) + y * Math.sin(th);
  const wave = Math.cos(2 * Math.PI * u / TW + shash(seed, 919) * Math.PI * 2);
  const reg = vnoise(x / TN, y / TN, seed, 707) * 2 - 1;
  return WP.tempBase + WP.tempLat * wave + TN_AMP * reg
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
/* n°42 : les seuils de familles sont des RÉGLAGES (WP.famAlt, WP.famCoast,
   WP.famDry, WP.famCold, WP.famWet) — les anciennes constantes FAM_ALT,
   FAM_COAST, FAM_DRY, FAM_COLD, FAM_WET deviennent les DÉFAUTS de WP. */

export function famAt(x, y, seed) {
  if (Hroad(x, y, seed) > WP.famAlt) return 4;
  if (coastAt(x, y, seed) > WP.famCoast) return 5;
  const m = moistAt(x, y, seed);
  if (m < WP.famDry) return 1;
  if (tempAt(x, y, seed) < WP.famCold) return 3;
  if (m > WP.famWet) return 2;
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
  return Math.max(Hroad(x, y, seed), WP.seaLevel + CAUSEWAY_H);
}
