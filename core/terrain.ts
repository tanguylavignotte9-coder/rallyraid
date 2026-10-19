/* ============================================================
   CHAMP DE MONDE — fonction PURE de (graine, x, y), ADR 0004.
   Partagé par la route (altitude, ponts/tunnels) et le rendu 3D
   (relief, villages, eau). Aucun PRNG d'état : hash de grille →
   value-noise bilinéaire, 4 octaves.
   n°33 — MONDE ÉMERGENT : le champ ne fait plus que l'altitude ; il
   porte aussi le CLIMAT (température, humidité, vent, distance à
   la côte), la classification en FAMILLES gameplay (6, terrain.ts
   famAt), le niveau de la MER (SEA_SL) et l'hydrologie locale
   (flowAccum, accumulation D8 sur une fenêtre — l'eau descend le
   relief). TOUT est pur de (graine, x, y) : la même fenêtre
   régénérée redonne les mêmes rivières, les mêmes côtes.
   La copie NAVIGATEUR web/terrain.js est IDENTIQUE au bit près
   (tests/terrain-web.test.ts) — les deux fichiers changent ENSEMBLE.
   ============================================================ */

const O1 = { lam: 32000, amp: 550, so: 101 };  // relief macro (massifs, bassins)
const O2 = { lam: 8000,  amp: 160, so: 202 };  // moyennes collines
const O3 = { lam: 2000,  amp: 45,  so: 303 };  // collines locales
const O4 = { lam: 520,   amp: 22,  so: 404 };  // fin : ravins, creux de rivières

function ghash(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 974634733);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;   // [0, 1)
}
function sm(t: number): number { return t * t * (3 - 2 * t); }
function vnoise(x: number, y: number, seed: number, so: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = sm(x - ix), fy = sm(y - iy);
  const a = ghash(ix, iy, seed + so);
  const b = ghash(ix + 1, iy, seed + so);
  const c = ghash(ix, iy + 1, seed + so);
  const d = ghash(ix + 1, iy + 1, seed + so);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;  // [0, 1)
}
const oct = (o: { lam: number; amp: number; so: number }, x: number, y: number, seed: number, k = 1) =>
  k * o.amp * (vnoise(x / o.lam, y / o.lam, seed, o.so) * 2 - 1);

/* terrain environnant (m) */
export function H(x: number, y: number, seed: number): number {
  return oct(O1, x, y, seed) + oct(O2, x, y, seed) + oct(O3, x, y, seed) + oct(O4, x, y, seed);
}

/* plateforme routière (m), n°32 : la route suit les collines O3 à
   80 % (au lieu de 50 %) — l'écart route/terrain passait 15 m sur
   27 % des km (estrades noires) ; il passe > 15 m sur 14,5 % et
   > 20 m sur 3,7 % (mesuré, 3 graines × 1000 km). Seuls les vrais
   ravins/creux (O4, retiré) gardent un grand écart = ponts/tunnels.
   L'octave fine O4 reste retirée. Fonction PURE — le tracé
   horizontal est bit à bit inchangé. */
export function Hroad(x: number, y: number, seed: number): number {
  return oct(O1, x, y, seed) + oct(O2, x, y, seed) + oct(O3, x, y, seed, 0.8);
}

/* ============================================================
   n°33 — CHAMPS CLIMATIQUES (tous purs de (graine, x, y))
   ============================================================
   Cadre à axes (diagramme de Whittaker simplifié — émergence
   perçue, PAS une vraie simulation climatique, inadaptée à
   25 000 km) :
   - température : onde latitude le long d'un axe climatique tiré
     de la graine + région (900 km) − gradient adiabatique
     (−6,5 °C / 1 000 m) sur l'altitude réelle ;
   - humidité : deux octaves basse fréquence (140/480 km) + PLUIE
     D'OMBRE (le versant sous le vent du vent dominant se dessèche,
     approximation par différence de H le long du vent) + bonus de
     proximité côtière ;
   - mer : SEA_SL, courbes de niveau de Hmacro ; la plateforme
     routière HroadC remonte au-dessus de la mer (causeway). */

export const SEA_SL = -240;   // m : niveau de la mer (~10-18 % du champ sous l'eau selon la graine)

const HUM1 = 140000, HUM2 = 480000, TN = 900000;
const TW = 5200000;           // m : longueur d'onde latitude (~le 1/5 d'une course)
const TW_AMP = 15, TN_AMP = 3, T_BASE = 17;
const ORO_D = 10000, ORO_K = 120, ORO_W = 0.22;
const COAST_W = 0.20, COAST_RISE = 60;

const shash = (seed: number, so: number) => ghash(0, 0, seed + so);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* sigmoïde lisse — le primitif de toutes les transitions continues :
   les frontières de biomes sont des DÉGRADÉS dans le paysage */
export const ss = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/* relief macro (sans O3/O4) — la géographie qui compte pour le
   climat et la mer */
export function Hmacro(x: number, y: number, seed: number): number {
  return oct(O1, x, y, seed) + oct(O2, x, y, seed);
}

/* vent dominant de la graine (direction fixe — une seule valeur par
   course, pure) */
export function windAt(seed: number): { wx: number; wy: number } {
  const a = shash(seed, 808) * Math.PI * 2;
  return { wx: Math.cos(a), wy: Math.sin(a) };
}

/* proximité de la mer [0,1] : 1 = sous le niveau marin, 0 = haut
   sur le plateau intérieur (remontée COAST_RISE m au-dessus de
   SEA_SL) */
export function coastAt(x: number, y: number, seed: number): number {
  return 1 - clamp01((Hmacro(x, y, seed) - SEA_SL) / COAST_RISE);
}

/* température (°C) : latitude (onde TW le long d'un axe tiré de la
   graine) + région 900 km − 6,5 °C/1 000 m d'altitude réelle */
export function tempAt(x: number, y: number, seed: number): number {
  const th = (shash(seed, 909) - 0.5) * 50 * Math.PI / 180;
  const u = x * Math.cos(th) + y * Math.sin(th);
  const wave = Math.cos(2 * Math.PI * u / TW + shash(seed, 919) * Math.PI * 2);
  const reg = vnoise(x / TN, y / TN, seed, 707) * 2 - 1;
  return T_BASE + TW_AMP * wave + TN_AMP * reg
       - 6.5 * Math.max(0, H(x, y, seed)) / 1000;
}

/* humidité [0,1] : deux octaves (140/480 km — traverser plusieurs
   zones sur 25 000 km) + pluie d'ombre (le vent SOUFFLE du quart
   amont : si le relief monte dans le sens du vent, le versant sous
   le vent s'assèche) + bonus côtier */
export function moistAt(x: number, y: number, seed: number): number {
  const v1 = vnoise(x / HUM1, y / HUM1, seed, 505);
  const v2 = vnoise(x / HUM2, y / HUM2, seed, 606);
  const w = windAt(seed);
  const oro = (H(x, y, seed) - H(x - w.wx * ORO_D, y - w.wy * ORO_D, seed)) / ORO_K;
  return clamp01(0.50 + (v1 - 0.5) * 0.72 + (v2 - 0.5) * 0.36
       + ORO_W * (oro < -1 ? -1 : oro > 1 ? 1 : oro)
       + COAST_W * coastAt(x, y, seed));
}

/* ============================================================
   n°33 — FAMILLES GAMEPLAY (le biome GROSSIER, 6 entrées)
   La richesse visuelle (palettes continues, fog, végétation) dérive
   des AXES (T, M, côte, altitude) ; la LECTURE STRATÈGE reste
   grossière : 6 familles de conduite, exactement comme les 4
   biomes d'avant — les menus de virages, largeurs, grip, densités
   POI se branchent ici. Ordre : altitude > côte > aride > froid >
   humide > défaut (plaine). */

export const FAM_NAMES = ['Plaine', 'Désert', 'Forêt', 'Boréal', 'Altitude', 'Littoral'];
export const FAM_ALT = 220;      // m (Hroad) : étage altitude — calibré ~10 % des km (mesuré 5,6-12,9 %, 4 graines)
export const FAM_COAST = 0.5;     // coastAt au-dessus duquel on est « Littoral »
export const FAM_DRY = 0.30;     // M sous : aride (désert/steppe)
export const FAM_COLD = 5;       // T sous : froid (boréal/taïga) — calibré 5 °C :
                                 // l'onde latitude (min ~2 °C sur plat) ne déclenche
                                 // JAMAIS le froid à 0 °C ; à 5 °C le boréal monte à
                                 // 8,5 % sur 10 000 km (mesuré, graine 12345) et
                                 // reste absent des tranches chaudes — une course
                                 // de 2 000 km ne traverse qu'une fraction de
                                 // l'onde climatique (λ 5 200 km) : VARIÉTÉ
                                 // ÉMERGENTE assumée, pas un bug.
export const FAM_WET = 0.62;     // M au-dessus : humide (forêt)

export function famAt(x: number, y: number, seed: number): number {
  if (Hroad(x, y, seed) > FAM_ALT) return 4;
  if (coastAt(x, y, seed) > FAM_COAST) return 5;
  const m = moistAt(x, y, seed);
  if (m < FAM_DRY) return 1;
  if (tempAt(x, y, seed) < FAM_COLD) return 3;
  if (m > FAM_WET) return 2;
  return 0;
}

/* ============================================================
   n°33 — HYDROLOGIE LOCALE
   L'écoulement est une propriété globale (l'eau vient de loin)
   alors que tout doit rester calculable à la demande : le compromis
   est une accumulation D8 DESCENDANTE calculée sur une FENÊTRE
   (grille de H remplie par l'appelant). Tri par altitude décroissante
   (l'amont verse avant l'aval), chaque cellule verse son
   accumulation à la plus basse de ses 8 voisines.
   PIÈGE (documenté, corrigé au banc) : initialiser acc[i] = 1 DANS
   le balayage efface les dépôts amont déjà versés (max acc = 1).
   Init séparée : TOUTES les cellules à 1, ordre complet, puis dépôt.
   Pur : aucune RNG, résultat fonction de la grille uniquement. */

export function flowAccum(grid: Float64Array, w: number, h: number): Int32Array {
  const n = w * h;
  const acc = new Int32Array(n);
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) { order[i] = i; acc[i] = 1; }
  const ord = Array.from(order).sort((a, b) => grid[b]! - grid[a]!);
  for (let k = 0; k < n; k++) {
    const i = ord[k]!;
    const x = i % w, y = (i / w) | 0;
    let best = -1, bh = grid[i]!;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx2 = x + dx, ny2 = y + dy;
      if (nx2 < 0 || ny2 < 0 || nx2 >= w || ny2 >= h) continue;
      const j = ny2 * w + nx2;
      if (grid[j]! < bh) { bh = grid[j]!; best = j; }
    }
    if (best >= 0) acc[best]! += acc[i]!;
  }
  return acc;
}

/* n°33 — plateforme routière CÔTIÈRE : la route ne plonge jamais
   sous la mer — HroadC remonte au-dessus du niveau marin
   (CAUSEWAY_H) : passages sur l'eau, lagunes et estuaires se
   traversent en causeway, comme les vraies routes côtières. */
export const CAUSEWAY_H = 12;

export function HroadC(x: number, y: number, seed: number): number {
  return Math.max(Hroad(x, y, seed), SEA_SL + CAUSEWAY_H);
}
