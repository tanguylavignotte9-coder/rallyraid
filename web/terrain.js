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

/* ============================================================
   n°50 — MONDE CRÉDIBLE P1 : signaux d'obstacles NATURELS.
   Le contrôleur de route n°43 ne lit que le relief — terrain plat =
   droite. Ces signaux donnent au coût des 13 caps des RAISONS
   D'ESQUIVER issues des champs existants (design arbitré 2026-10-21,
   banc bench-n50) :
   - HO4 = relief GÉOGRAPHIQUE (O1..O4, SANS les octaves fines) : les
     creux O4 (λ520) sont les vrais lacs du rendu (scan fin n°26,
     creux p50 ~5 m). SANS les octaves fines : une bosse λ160 (±4 m)
     ne doit pas fermer un faux lac, et le grain de la voiture ne
     doit pas polluer le centre ;
   - closedAt = profondeur du BASSIN FERMÉ : min des 4 sondes N/E/S/W
     à LAKE_R, moins HO4 du point. > 0 : cuvette sans exutoire (une
     vallée ouverte a toujours une sonde aval plus basse → ≤ 0) ;
   - obstCost combine aux poids du contrôleur : lac (fermeture ≥ 4 m),
     marais (fermeture ≥ 1 m + humidité — cohérent avec les cellules
     hydro du rendu : acc ≥ 60, humidité ≥ 0,30), forêt dense
     (humidité très haute + tempéré ; la taïga reste franchissable).
   Sigmoïdes ss : champs CONTINUS — la route voit l'obstacle VENIR
   de loin, pas un mur binaire. obstCost PARTAGE closedAt/moistAt
   entre les signaux (~1 H + 5 HO4 + 1 tempAt par évaluation).
   PUREMENT de (graine, x, y) — zéro PRNG (ADR 0004). Jumeau
   core/terrain.ts IDENTIQUE au bit près (terrain-web.test). */
export const LAKE_R = 600;          // m : rayon de sonde de fermeture
export const LAKE_D = 4;             // m : fermeture ≥ 4 m → lac
export const MARSH_D = 1;           // m : fermeture ≥ 1 m → marais (si humide)

export function HO4(x, y, seed) {
  return oct(WP.lam1, WP.amp1, 101, x, y, seed) + oct(WP.lam2, WP.amp2, 202, x, y, seed)
       + oct(WP.lam3, WP.amp3, 303, x, y, seed) + oct(WP.lam4, WP.amp4, 404, x, y, seed);
}

export function closedAt(x, y, seed) {
  const h0 = HO4(x, y, seed);
  let mn = Infinity;
  mn = Math.min(mn, HO4(x + LAKE_R, y, seed) - h0);
  mn = Math.min(mn, HO4(x - LAKE_R, y, seed) - h0);
  mn = Math.min(mn, HO4(x, y + LAKE_R, seed) - h0);
  mn = Math.min(mn, HO4(x, y - LAKE_R, seed) - h0);
  return mn;
}

export function obstCost(x, y, seed, wLake, wMarsh, wFor, wRiv = 0) {
  /* n°51 — les 4 sondes de closedAt servent AUSSI la vallée
     directionnelle (gué) : une seule passe de 5 HO4 + moistAt + tempAt.
     wRiv = 0 par défaut → les appels 4-args du n°50 restent inchangés
     au bit près (le terme riv est exactement 0). */
  const h0 = HO4(x, y, seed);
  const eU = HO4(x + LAKE_R, y, seed) - h0;
  const wU = HO4(x - LAKE_R, y, seed) - h0;
  const nU = HO4(x, y + LAKE_R, seed) - h0;
  const sU = HO4(x, y - LAKE_R, seed) - h0;
  const c = Math.min(eU, wU, nU, sU);
  const lake = ss(LAKE_D, LAKE_D + 6, c);
  const m = moistAt(x, y, seed);
  const marsh = ss(MARSH_D, MARSH_D + 3, c) * ss(0.62, 0.78, m);
  const forest = ss(0.78, 0.92, m) * ss(2, 8, tempAt(x, y, seed));
  const riv = riverRaw(eU, wU, nU, sU, m);
  return wLake * lake + wMarsh * marsh + wFor * forest + wRiv * riv;
}

/* ============================================================
   n°51 — MONDE CRÉDIBLE P2 : VILLAGES D'ABORD, GUÉS, FORÊT MACRO
   Jumeau JS de core/terrain.ts — IDENTIQUE au bit près
   (tests/terrain-web.test.ts). La description complète est dans
   core/terrain.ts.
   ============================================================ */

/* vallée directionnelle (mêmes sondes que closedAt) — privée */
function riverRaw(eU, wU, nU, sU, m) {
  const vNS = ss(6, 14, Math.min(eU, wU)) * ss(-1.5, -5, Math.min(nU, sU));
  const vEW = ss(6, 14, Math.min(nU, sU)) * ss(-1.5, -5, Math.min(eU, wU));
  return Math.max(vNS, vEW) * ss(0.30, 0.36, m);
}
export const RIV_R = 600;

export function riverAt(x, y, seed) {
  const h0 = HO4(x, y, seed);
  const eU = HO4(x + RIV_R, y, seed) - h0;
  const wU = HO4(x - RIV_R, y, seed) - h0;
  const nU = HO4(x, y + RIV_R, seed) - h0;
  const sU = HO4(x, y - RIV_R, seed) - h0;
  return riverRaw(eU, wU, nU, sU, moistAt(x, y, seed));
}

export const VILL_CELL = 1400;
export const VILL_P = [0.40, 0.09, 0.20, 0.056, 0.10, 0.32];
export const FARM_P = [0.14, 0.032, 0.072, 0.018, 0.036, 0.12];
export const VILL_COLD = -8;
export const VILL_SNOW = 300;

export function villageCell(ix, iy, seed) {
  const jx = ghash(ix, iy, seed + 401), jy = ghash(ix, iy, seed + 402);
  const cx = (ix + 0.25 + 0.5 * jx) * VILL_CELL;
  const cy = (iy + 0.25 + 0.5 * jy) * VILL_CELL;
  const fam = famAt(cx, cy, seed);
  const u = ghash(ix, iy, seed + 403);
  let kind;
  if (u < VILL_P[fam]) kind = 'village';
  else if (u < VILL_P[fam] + FARM_P[fam]) kind = 'farm';
  else return null;
  const c = closedAt(cx, cy, seed);
  if (c > 2 || c < -14) return null;
  if (tempAt(cx, cy, seed) < VILL_COLD) return null;
  if (Hroad(cx, cy, seed) > VILL_SNOW) return null;
  let hMin = Infinity, hMax = -Infinity;
  for (let a = -50; a <= 50; a += 25)
    for (let b = -50; b <= 50; b += 25) {
      const v = H(cx + a, cy + b, seed);
      if (v < hMin) hMin = v;
      if (v > hMax) hMax = v;
    }
  if ((hMax - hMin) / 100 > 0.12) return null;
  return { x: cx, y: cy, kind, fam };
}

export function villageNear(x, y, seed, memo) {
  const ix = Math.floor(x / VILL_CELL), iy = Math.floor(y / VILL_CELL);
  let dmin = Infinity;
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
    const key = (ix + di) * 67108864 + (iy + dj);
    let v = memo.get(key);
    if (v === undefined) { v = villageCell(ix + di, iy + dj, seed); memo.set(key, v); }
    if (v && v.kind === 'village') {
      const d = Math.hypot(v.x - x, v.y - y);
      if (d < dmin) dmin = d;
    }
  }
  return dmin;
}

export function forestAt(x, y, seed) {
  return ss(0.78, 0.92, moistAt(x, y, seed)) * ss(2, 8, tempAt(x, y, seed));
}

export const CAUSEWAY_H = 12;

export function HroadC(x, y, seed) {
  return Math.max(Hroad(x, y, seed), WP.seaLevel + CAUSEWAY_H);
}
