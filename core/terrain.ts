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

/* n°42 — GÉNÉRATEUR DE MONDE PARAMÉTRABLE (page admin) : les constantes
   du champ deviennent des RÉGLAGES de course. WP est l'objet VIF : H lit
   WP en direct, setWorldParams l'écrase EN PLACE (Object.assign — jamais
   un remplacement d'objet, les imports vivants doivent suivre).
   Déterminisme ADR 0004 INTACT : le monde reste une fonction pure de
   (graine, x, y, world) — les paramètres font partie de la config
   persistée (race-state.json), pas du code. Les DÉFAUTS reproduisent AU
   BIT PRÈS le champ actuel (test terrain-web, route.test inchangés). */
export type WorldParams = {
  amp1: number; lam1: number;   // O1 relief macro (massifs, bassins)
  amp2: number; lam2: number;   // O2 moyennes collines
  amp3: number; lam3: number;   // O3 collines locales
  amp4: number; lam4: number;   // O4 fin : ravins, creux de rivières
  seaLevel: number;             // niveau de la mer (m)
  tempBase: number;             // température de base (°C)
  tempLat: number;              // amplitude de l'onde de latitude (°C)
  famAlt: number;               // étage Altitude (m, Hroad)
  famCoast: number;             // seuil coastAt : Littoral
  famDry: number;               // humidité sous : Désert
  famCold: number;              // température sous : Boréal
  famWet: number;               // humidité au-dessus : Forêt
};
export const WORLD_DEFAULT: WorldParams = {
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
export const WORLD_BOUNDS: Record<keyof WorldParams, [number, number]> = {
  amp1: [0, 2000], lam1: [8000, 128000],
  amp2: [0, 600],  lam2: [2000, 32000],
  amp3: [0, 200],  lam3: [500, 8000],
  amp4: [0, 100],  lam4: [130, 2000],
  seaLevel: [-600, 0],
  tempBase: [-5, 35], tempLat: [0, 30],
  famAlt: [80, 600], famCoast: [0.1, 0.9], famDry: [0, 0.5],
  famCold: [-5, 15], famWet: [0.4, 0.9],
};
export const WP: WorldParams = { ...WORLD_DEFAULT };
/* applique des paramètres PARTIELS (clampés aux bornes, NaN → défaut) ;
   undefined → retour aux défauts. Le serveur appelle ceci au démarrage
   (config persistée) et à chaque makeRace ; le navigateur à chaque
   snapshot reçu (setData). */
export function setWorldParams(p?: Partial<WorldParams>): void {
  Object.assign(WP, WORLD_DEFAULT, p ?? {});
  for (const k of Object.keys(WORLD_DEFAULT) as (keyof WorldParams)[]) {
    const [lo, hi] = WORLD_BOUNDS[k];
    const v = WP[k];
    WP[k] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : WORLD_DEFAULT[k];
  }
}

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
const oct = (lam: number, amp: number, so: number, x: number, y: number, seed: number, k = 1) =>
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
export function H(x: number, y: number, seed: number): number {
  return oct(WP.lam1, WP.amp1, 101, x, y, seed) + oct(WP.lam2, WP.amp2, 202, x, y, seed)
       + oct(WP.lam3, WP.amp3, 303, x, y, seed) + oct(WP.lam4, WP.amp4, 404, x, y, seed)
       + oct(FINE1_LAM, FINE1_AMP, FINE1_SO, x, y, seed)
       + oct(FINE2_LAM, FINE2_AMP, FINE2_SO, x, y, seed);
}

/* plateforme routière (m), n°32 : la route suit les collines O3 à
   80 % (au lieu de 50 %) — l'écart route/terrain passait 15 m sur
   27 % des km (estrades noires) ; il passe > 15 m sur 14,5 % et
   > 20 m sur 3,7 % (mesuré, 3 graines × 1000 km). Seuls les vrais
   ravins/creux (O4, retiré) gardent un grand écart = ponts/tunnels.
   L'octave fine O4 reste retirée. Fonction PURE — le tracé
   horizontal est bit à bit inchangé. */
export function Hroad(x: number, y: number, seed: number): number {
  return oct(WP.lam1, WP.amp1, 101, x, y, seed) + oct(WP.lam2, WP.amp2, 202, x, y, seed)
       + oct(WP.lam3, WP.amp3, 303, x, y, seed, 0.8);
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

export const SEA_SL = -240;   // m : niveau DÉFAUT de la mer — le niveau ACTIF est
                             // WP.seaLevel (l'export reste : test terrain-web,
                             // compat) ; ~10-18 % du champ sous l'eau selon la graine

const HUM1 = 140000, HUM2 = 480000, TN = 900000;
const TW = 5200000;           // m : longueur d'onde latitude (~le 1/5 d'une course)
const TN_AMP = 3;
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
  return oct(WP.lam1, WP.amp1, 101, x, y, seed) + oct(WP.lam2, WP.amp2, 202, x, y, seed);
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
  return 1 - clamp01((Hmacro(x, y, seed) - WP.seaLevel) / COAST_RISE);
}

/* température (°C) : latitude (onde TW le long d'un axe tiré de la
   graine) + région 900 km − 6,5 °C/1 000 m d'altitude réelle */
export function tempAt(x: number, y: number, seed: number): number {
  const th = (shash(seed, 909) - 0.5) * 50 * Math.PI / 180;
  const u = x * Math.cos(th) + y * Math.sin(th);
  const wave = Math.cos(2 * Math.PI * u / TW + shash(seed, 919) * Math.PI * 2);
  const reg = vnoise(x / TN, y / TN, seed, 707) * 2 - 1;
  return WP.tempBase + WP.tempLat * wave + TN_AMP * reg
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
/* n°42 : les seuils de familles sont des RÉGLAGES (WP.famAlt, WP.famCoast,
   WP.famDry, WP.famCold, WP.famWet) — les anciennes constantes FAM_ALT,
   FAM_COAST, FAM_DRY, FAM_COLD, FAM_WET deviennent les DÉFAUTS de WP
   (leurs commentaires de calibration sont conservés dans WORLD_DEFAULT). */

export function famAt(x: number, y: number, seed: number): number {
  if (Hroad(x, y, seed) > WP.famAlt) return 4;
  if (coastAt(x, y, seed) > WP.famCoast) return 5;
  const m = moistAt(x, y, seed);
  if (m < WP.famDry) return 1;
  if (tempAt(x, y, seed) < WP.famCold) return 3;
  if (m > WP.famWet) return 2;
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
  return Math.max(Hroad(x, y, seed), WP.seaLevel + CAUSEWAY_H);
}
