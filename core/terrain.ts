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
   web/terrain.js IDENTIQUE au bit près (terrain-web.test). */
export const LAKE_R = 600;          // m : rayon de sonde de fermeture
export const LAKE_D = 4;             // m : fermeture ≥ 4 m → lac
export const MARSH_D = 1;           // m : fermeture ≥ 1 m → marais (si humide)

export function HO4(x: number, y: number, seed: number): number {
  return oct(WP.lam1, WP.amp1, 101, x, y, seed) + oct(WP.lam2, WP.amp2, 202, x, y, seed)
       + oct(WP.lam3, WP.amp3, 303, x, y, seed) + oct(WP.lam4, WP.amp4, 404, x, y, seed);
}

export function closedAt(x: number, y: number, seed: number): number {
  const h0 = HO4(x, y, seed);
  let mn = Infinity;
  mn = Math.min(mn, HO4(x + LAKE_R, y, seed) - h0);
  mn = Math.min(mn, HO4(x - LAKE_R, y, seed) - h0);
  mn = Math.min(mn, HO4(x, y + LAKE_R, seed) - h0);
  mn = Math.min(mn, HO4(x, y - LAKE_R, seed) - h0);
  return mn;
}

export function obstCost(x: number, y: number, seed: number,
                        wLake: number, wMarsh: number, wFor: number, wRiv = 0): number {
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
   (design arbitré 2026-10-21, banc bench-n51). VILLAGES : le bourg
   devient un CHAMP DU MONDE (grille VILL_CELL, centre jitteré par
   ghash), CAUSAL — les portes du placement n°33 du rendu (famille du
   lieu, eau à proximité, température, ligne de neige, praticabilité)
   mais PUR de (graine, x, y) : le rendu dessine LES MÊMES villages
   (world3d lit le champ — plus jamais d'ancrage route). EAU : le
   rendu gatait par hydroAccMax (D8 de fenêtre) ; côté route un D8
   par chunk est hors budget → PROXY : vivre DANS la vallée
   [closedAt ∈ -14..+2 m] — près du thalweg sans être dedans (pas
   dans le lac, pas sur la crête). La cohérence route↔rendu vient du
   champ PARTAGÉ (les deux lisent villageCell — terrain-web.test).
   RIVIÈRE (gué) : vallée DIRECTIONNELLE — murs de part et d'autre
   (sondes E/W hautes OU N/S hautes) + exutoire dans l'axe + humidité
   (la même porte que les rivières du rendu n°33). Le coût wRiv paie
   le TEMPS DANS LE THALWEG : longer coûte cher, franchir 1-2
   échantillons → traversées courtes et perpendiculaires (gués).
   FORÊT MACRO : forestAt est le même signal que le wFor n°50
   (boqueteaux) lu à l'échelle des jambes de waypoints (18-45 km) :
   les MASSIFS climatiques (140-480 km) se skirtent sur plusieurs
   jambes. Tout est PUR — zéro PRNG (ADR 0004). Jumeau
   web/terrain.js IDENTIQUE au bit près (terrain-web.test).
   ============================================================ */

/* vallée directionnelle (mêmes sondes que closedAt) — privée */
function riverRaw(eU: number, wU: number, nU: number, sU: number, m: number): number {
  /* vallée N-S : murs E et W, exutoire dans l'axe N/S ;
     vallée E-W : murs N et S, exutoire dans l'axe E/W ;
     un lac fermé (les 4 sondes hautes) ne déclenche AUCUNE des
     deux ; une crête (les 4 basses) non plus. */
  const vNS = ss(6, 14, Math.min(eU, wU)) * ss(-1.5, -5, Math.min(nU, sU));
  const vEW = ss(6, 14, Math.min(nU, sU)) * ss(-1.5, -5, Math.min(eU, wU));
  return Math.max(vNS, vEW) * ss(0.30, 0.36, m);
}
export const RIV_R = 600;   // m : rayon de sonde (LAKE_R — les mêmes sondes)

export function riverAt(x: number, y: number, seed: number): number {
  const h0 = HO4(x, y, seed);
  const eU = HO4(x + RIV_R, y, seed) - h0;
  const wU = HO4(x - RIV_R, y, seed) - h0;
  const nU = HO4(x, y + RIV_R, seed) - h0;
  const sU = HO4(x, y - RIV_R, seed) - h0;
  return riverRaw(eU, wU, nU, sU, moistAt(x, y, seed));
}

/* ---- champ de villages : grille monde VILL_CELL (1 400 m) ---- */
export const VILL_CELL = 1400;
/* probabilité par cellule et par FAMILLE du lieu (banc n°51 : la
   plaine vit, le désert reste presque vide — calibration sur
   l'ancien placement n°33 du rendu, densité ~un bourg tous les
   10-15 km de corridor) */
export const VILL_P = [0.40, 0.09, 0.20, 0.056, 0.10, 0.32];
export const FARM_P = [0.14, 0.032, 0.072, 0.018, 0.036, 0.12];
export const VILL_COLD = -8;      // °C — la même porte que le rendu
export const VILL_SNOW = 300;    // m — la ligne de neige du rendu

export type Vill = { x: number; y: number; kind: 'village' | 'farm'; fam: number };

/* village d'une cellule (ix, iy) — PUR : null ou le lieu complet.
   - centre jitteré dans la cellule (marge 0.25..0.75 : le rayon du
     bourg 40-120 m + les maisons ne débordent jamais chez le voisin) ;
   - PORTE FAMILLE : VILL_P[famAt(site)] ;
   - PORTE EAU : closedAt(site) ∈ [-14, +2] m ;
   - TEMPÉRATURE ≥ -8 °C, plateforme Hroad ≤ 300 m ;
   - PRATICABILITÉ : (hMax - hMin)/100 ≤ 0.12 sur ±50 m (le test du
     rendu n°33) ;
   - FERME : deuxième tranche de ghash → kind='farm'. */
export function villageCell(ix: number, iy: number, seed: number): Vill | null {
  const jx = ghash(ix, iy, seed + 401), jy = ghash(ix, iy, seed + 402);
  const cx = (ix + 0.25 + 0.5 * jx) * VILL_CELL;
  const cy = (iy + 0.25 + 0.5 * jy) * VILL_CELL;
  const fam = famAt(cx, cy, seed);
  const u = ghash(ix, iy, seed + 403);
  let kind: 'village' | 'farm';
  if (u < VILL_P[fam]) kind = 'village';
  else if (u < VILL_P[fam] + FARM_P[fam]) kind = 'farm';
  else return null;
  /* eau : dans la vallée, pas dans le lac, pas sur la crête */
  const c = closedAt(cx, cy, seed);
  if (c > 2 || c < -14) return null;
  if (tempAt(cx, cy, seed) < VILL_COLD) return null;
  if (Hroad(cx, cy, seed) > VILL_SNOW) return null;
  /* praticabilité (le même test que le rendu n°33) */
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

/* distance au BOURG (kind='village') le plus proche — 3×3 cellules
   (±1 400 m : au-delà, la répulsion rocade est nulle par construction).
   memo : cache par clé de cellule — la fonction est PURE, le memo
   n'évite que de re-sonder les 25 H de praticabilité. */
export function villageNear(x: number, y: number, seed: number,
                            memo: Map<number, Vill | null>): number {
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

/* forêt dense (macro comme micro — le même signal, deux échelles de
   lecture : wFor n°50 dans les 13 caps, wForMac n°51 aux sondes des
   jambes de waypoints) */
export function forestAt(x: number, y: number, seed: number): number {
  return ss(0.78, 0.92, moistAt(x, y, seed)) * ss(2, 8, tempAt(x, y, seed));
}

/* ============================================================
   n°52 — PARCELLAIRE AGRICOLE (monde crédible P3) : la plaine
   cultivée est un DAMIER orthogonal orienté par ZONE — champ PUR
   de (graine, x, y) : chaque zone PAR_ZONE (12 km) tire l'axe de
   ses rangées par ghash (parAngle ∈ [0, π/2[), le damier tourne
   d'une zone à l'autre (rupture bocage/openfield aux frontières).
   La route paie le cap HORS-AXE (|sin 2Δ| dans le contrôleur, les
   deux axes du damier comptent) → en plaine cultivée, longues
   droites et angles droits ÉMERGENTS — la route suit les rangées,
   comme une vraie route d'openfield. parAt : le damier vit dans
   la PLAINE cultivée (famAt 0) sur la fenêtre d'humidité 0,35-0,75
   (ni désert, ni forêt, ni marais) — sigmoïdes continues. PAR_KEEP :
   distance aux bourgs où le damier se relâche (la rocade n'est pas
   un damier). ZÉRO PRNG (ADR 0004). Jumeau web/terrain.js
   IDENTIQUE au bit près (terrain-web.test).
   ============================================================ */
export const PAR_ZONE = 12000;   // m : zone d'orientation du damier
export const PAR_KEEP = 1400;    // m : relâchement du damier près des bourgs

/* axe du damier de la zone (rad, ∈ [0, π/2[) — orienté par hash pur */
export function parAngle(x: number, y: number, seed: number): number {
  const zx = Math.floor(x / PAR_ZONE), zy = Math.floor(y / PAR_ZONE);
  return ghash(zx, zy, seed + 411) * Math.PI / 2;
}

/* présence du parcellaire [0,1] : plaine + humidité cultivable */
export function parAt(x: number, y: number, seed: number): number {
  const m = moistAt(x, y, seed);
  return (famAt(x, y, seed) === 0 ? 1 : 0) * ss(0.35, 0.42, m) * ss(0.75, 0.68, m);
}

/* n°33 — plateforme routière CÔTIÈRE : la route ne plonge jamais
   sous la mer — HroadC remonte au-dessus du niveau marin
   (CAUSEWAY_H) : passages sur l'eau, lagunes et estuaires se
   traversent en causeway, comme les vraies routes côtières. */
export const CAUSEWAY_H = 12;

export function HroadC(x: number, y: number, seed: number): number {
  return Math.max(Hroad(x, y, seed), WP.seaLevel + CAUSEWAY_H);
}
