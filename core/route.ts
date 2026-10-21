/* ============================================================
   ROUTE LINÉAIRE — l'itinéraire départ → arrivée, généré à la demande
   ============================================================
   Phase 1 : le générateur passe de la boucle fermée de 20,8 km à un
   itinéraire LINÉAIRE de 15-25 000 km, généré CHUNK PAR CHUNK au fil
   de la course. Un chunk = 2 600 échantillons de 8 m (la maille du
   moteur) = 20,8 km. Le contenu d'un chunk est 100 % déterministe
   depuis (graine, n° de chunk) + l'état d'entrée (cap, position,
   altitude) laissé par le chunk précédent — même graine ⇒ mêmes
   virages au bit près (ADR 0004). Les chunks anciens sont évictés
   (fenêtre mémoire) et se régénèrent À L'IDENTIQUE si on les
   redemande : c'est la garantie des replays et de la reprise serveur.

   n°43 — ROUTE ÉMERGENTE DE LA TOPOLOGIE (rework) :
   - les TABLES de virages (menus V2ter, courants, ψ de plate-forme,
     fastAt) sont RETIRÉES : à chaque pas de 8 m, un contrôleur
     choisit parmi 13 caps candidats simulés sur 192 m (limiteur
     d'altitude, budget 8 %) au moindre coût — écart route/sol,
     pente-max (contour), poursuite macro, régularité, laisse
     latérale, garde anti-croisement (proximité douce + intersection
     exacte interdite + évasion 2 passes).
   - ZÉRO PRNG dans la géométrie : le tracé est fonction pure de la
     topologie (ADR 0004 renforcé) ; le PRNG du chunk ne sert plus
     qu'aux POI. La mémoire anti-croisement (rt.hist, segments commis
     tagués par index absolu) rend la régénération d'un chunk ancien
     bit à bit identique (doublons neutres).
   - l'ALTITUDE vient du LIMITEUR : la route suit H (octaves fines
     n°43 du terrain — le relief à l'échelle de la voiture), causeway
     à seaLevel+3 m ; ponts/tunnels restent topographiques (gap vs H,
     seuil 18 m).
   n°33 — MONDE ÉMERGENT : le monde AVANT la route.
   - Les 4 biomes d'abscisse (buildSchedule/biomeBlendR) sont RETIRÉS :
     la famille GAMEPLAY (6 entrées, terrain.ts famAt) dérive du
     CHAMP à la position exacte — les frontières suivent les lignes
     d'altitude et d'humidité, plus les kilomètres.
   - WAYPOINTS à corridor : le coût altimétrique (n°25) gagne une
     pénalité douce de mer (700·wet/nP) — la route évite les grandes
     étendues sous SEA_SL, mais un bras de mer se traverse (HroadC
     causeway).
   - POURSUITE : pure pursuit sur la POLYLINE des waypoints (viser la
     projection avancée de LOOK m sur le segment actif) — l'ancien
     tracker visait le waypoint seul et laissait des décalages
     latéraux de 10-20 km (enveloppe 21 km, VIOLATION mesurée).
   - SURFACE CONTINUE : largeur/grip/roulement sont des fonctions
     LISSES des axes climatiques (surfParams) — plus de tables par
     étiquette.
   L'altitude vient du LIMITEUR n°43 (ci-dessous) : la route suit H
   à ±8 % de pente — HroadC ne sert plus qu'aux climats (surfParams,
   famAt), pas au tracé.
   Points d'intérêt (station, hôtel, garage) : posés par un CURSEUR
   GLOBAL par type — continuité parfaite aux frontières de chunks,
   densité par FAMILLE (la plaine est riche, le désert est vide),
   espacements tirés du PRNG du chunk. */

import { mulberry32, SEG, type Track } from './engine.ts';
import { H, HroadC, WP, tempAt, moistAt, coastAt, famAt, ss, obstCost } from './terrain.ts';

export const RSAMP = 2600;            // échantillons par chunk
export const RCHUNK = SEG * RSAMP;    // 20 800 m — un chunk
export const MAX_CACHED = 128;        // fenêtre de chunks en mémoire (~2 660 km) — n°27 :
                                      // étalement mesuré d'un peloton réel (540 km) + recherche
                                      // POI 200 km/voiture > 666 km → thrashing ×34 ; un chunk
                                      // ≈ 208 Ko → 128 chunks ≈ 27 Mo : négligeable.

export type PoiKind = 'station' | 'hotel' | 'garage';
export type Poi = { s: number; kind: PoiKind };

export type Chunk = {
  k: number;
  s0: number;                // abscisse absolue du 1er échantillon (m)
  hd: Float64Array;          // cap (rad) — continu avec l'entrée du chunk
  xs: Float64Array;          // plan (m), relatif à l'entrée du chunk
  zs: Float64Array;
  h: Float64Array;           // altitude (m), absolue
  terr: Float64Array;        // altitude du TERRAIN environnant (pont/tunnel)
  segType: Float64Array;     // 0 sol · 1 pont · 2 tunnel (par sample)
  w: Float64Array;           // demi-largeur de chaussée (m)
  mua: Float64Array;         // grip du biome
  crrA: Float64Array;        // roulement du biome
  biome: Float64Array;       // famille gameplay (famAt 0-5, n°33)
  pois: Poi[];               // points d'intérêt du chunk, triés par s
};

/* état d'entrée d'un chunk (position, cap, altitude du limiteur,
   braquage précédent) — n°43 : le contrôleur émergent remplace le
   plan de virages ; hdDev/hdPsi (wiggle/ψ des tables V4/V5)
   disparaissent, steerPrev arrive (la régularité du braquage est
   continue aux frontières). On garde TOUT l'historique — c'est
   minuscule et c'est ce qui rend la régénération d'un chunk ancien
   possible sans tout reconstruire. */
export type Bound = { x: number; y: number; hd: number; h: number; wpIdx: number; steerPrev: number };

/* ---- WAYPOINTS MACRO : l'ossature de l'itinéraire. Fonction PURE de
   (seed, totalKm) — mêmes waypoints au bit près. Tronçons de 18-45 km,
   cap jusqu'à ±120° (phases de retour arrière nettes), garde
   anti-croisement géométrique sur TOUS les segments. ---- */
const WP_D2R = Math.PI / 180;
const wpWrap = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};
export type Waypoint = { x: number; y: number; b: number };

const WP_DMIN_OLD = 14000;    // marge vs segments anciens
const WP_DMIN_RECENT = 12000; // marge vs les 2 segments précédents (retours tolérés)

function segPointDist(p: { x: number; y: number }, a: Waypoint, c: Waypoint): number {
  const dx = c.x - a.x, dy = c.y - a.y;
  const L2 = dx * dx + dy * dy;
  let t = L2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y);
}

export function buildWaypoints(seed: number, totalKm: number): Waypoint[] {
  const rand = mulberry32((seed ^ 0x77aa11) | 0);
  const wps: Waypoint[] = [{ x: 0, y: 0, b: 0 }];
  let x = 0, y = 0, bearing = 0;
  let driven = 0, net = 0;
  while (driven < totalKm * 1000 * 1.05) {
    const Lw = 18000 + rand() * 27000;
    let best: { b: number; x: number; y: number; cost: number } | null = null;
    for (let att = 0; att < 12; att++) {
      const u = rand();
      let db: number;
      if (u < 0.45) db = (rand() < 0.5 ? -1 : 1) * (8 + rand() * 17) * WP_D2R;
      else if (u < 0.78) db = (rand() < 0.5 ? -1 : 1) * (25 + rand() * 25) * WP_D2R;
      else db = (rand() < 0.5 ? -1 : 1) * (50 + rand() * 60) * WP_D2R;
      db *= 1 - att * 0.08;
      let bNew = wpWrap(bearing * 0.45 + db);
      const behind = net + Lw * Math.cos(bNew) - (driven + Lw) * 0.58;
      if (behind < -0.30 * Lw) bNew = wpWrap(bNew * 0.3);
      if (Math.abs(bNew) > 120 * WP_D2R) bNew = Math.sign(bNew) * 120 * WP_D2R;
      const nx = x + Lw * Math.cos(bNew), ny = y + Lw * Math.sin(bNew);
      let ok = true;
      for (let j = 0; j + 1 <= wps.length - 1 && ok; j++) {
        const margin = j >= wps.length - 3 ? WP_DMIN_RECENT : WP_DMIN_OLD;
        if (segPointDist({ x: nx, y: ny }, wps[j], wps[j + 1]) < margin) ok = false;
      }
      if (ok) {
        const mx = x + 0.5 * (nx - x), my = y + 0.5 * (ny - y);
        for (let j = 0; j + 1 <= wps.length - 2 && ok; j++) {
          const margin = j === wps.length - 3 ? 6000 : WP_DMIN_OLD * 0.85;
          if (segPointDist({ x: mx, y: my }, wps[j], wps[j + 1]) < margin) ok = false;
        }
      }
      if (!ok) continue;
      /* coût altimétrique (n°25) : altitude moyenne du tronçon (9 sondes)
         + préférence douce pour les caps peu changeants
         n°33 — CORRIDOR DE MER : pénalité douce proportionnelle aux
         sondes sous le niveau marin (700·wet/nP) — le fond de mer
         (altitude très négative) resterait « attractif » sans elle ;
         avec elle, traverser un bras de mer reste POSSIBLE (le
         causeway HroadC le permet), mais longer les grandes étendues
         est nettement préféré. */
      let hSum = 0, wet = 0;
      for (let q = 0; q <= 8; q++) {
        const qx = x + (nx - x) * q / 8, qy = y + (ny - y) * q / 8;
        const hv = H(qx, qy, seed);
        hSum += hv;
        if (hv < WP.seaLevel) wet++;
      }
      const cost = hSum / 9 + 40 * Math.abs(db) + 700 * wet / 9;
      if (!best || cost < best.cost) best = { b: bNew, x: nx, y: ny, cost };
    }
    if (best) { x = best.x; y = best.y; bearing = best.b; }
    else {
      /* dégagement : balayage ±120°, on RETIENT LE PLUS DÉGAGÉ (V2ter) */
      let bestB = 0, bestC = -1;
      for (const d of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7,
                       8, -8, 9, -9, 10, -10, 11, -11, 12, -12]) {
        const cand = d * 10 * WP_D2R;
        const cx = x + Lw * Math.cos(cand), cy = y + Lw * Math.sin(cand);
        let cmin = Infinity;
        for (let j = 0; j + 1 <= wps.length - 1; j++) {
          const dd = segPointDist({ x: cx, y: cy }, wps[j], wps[j + 1]);
          if (dd < cmin) cmin = dd;
        }
        if (cmin > bestC) { bestC = cmin; bestB = cand; }
      }
      bearing = bestB; x += Lw * Math.cos(bearing); y += Lw * Math.sin(bearing);
    }
    wps.push({ x, y, b: bearing });
    driven += Lw; net += Lw * Math.cos(bearing);
  }
  wps.push({ x: x + 120000 * Math.cos(bearing), y: y + 120000 * Math.sin(bearing), b: bearing });
  return wps;
}

/* ============================================================
   n°43 — CONTRÔLEUR ÉMERGENT : la route vient de la topologie
   ============================================================
   PILIERS (Tanguy) : (1) aucune typologie de virage forcée par
   table — si la route doit serpenter davantage, c'est la TOPOLOGIE
   qu'on enrichit (octaves fines du terrain) ; (2) la route SUIT le
   relief de façon cohérente, avec des OUVRAGES (pont/tunnel) sur
   les inclinaisons extrêmes seulement. À chaque pas de 8 m, le
   contrôleur choisit parmi 13 caps candidats simulés sur 192 m
   (limiteur d'altitude, budget de pente 8 %) au moindre coût :
   hug (écart route/sol, saturé 12 m = ouvrage), steep (pente-max
   de la fenêtre longue — contour), pur (poursuite macro pure
   pursuit), smooth (régularité du braquage), laisse latérale vs
   polyline, garde anti-croisement. ZÉRO PRNG dans la géométrie
   (ADR 0004 renforcé). Calibré au banc (bench-n42-emergente,
   config Z, 3 graines × 1000 km : 0 croisement exact, CI minSep
   ≥ 26 km, enveloppe ≤ 3,8 km, pentes p95 = max = 8 %). */
const ER = {
  budget: 0.08,      // pente max de la ligne de route (limiteur vertical)
  lookC: 24,         // sous-pas du lookahead (24 × 8 = 192 m)
  roughW: 12,        // fenêtre courte (tissage fin — inactivée, cf. wRough)
  cands: [-0.16, -0.10, -0.06, -0.03, -0.012, -0.006, 0,
          0.006, 0.012, 0.03, 0.06, 0.10, 0.16],  // Δcap par pas (rad)
  wHug: 1.0,         // poids écart route/sol
  wPur: 8.0,         // poids écart au cap macro (rad²)
  wSm: 9.0,          // poids régularité (dhd − dhdPrev)²
  wZero: 0.05,       // préférence douce du cap droit
  hugCap: 12,        // saturation du coût hug (m) — au-delà = ouvrage
  gentleS: 0.01,     // pente du sol « douce » (1 %) — au-delà, contourner
  wSteep: 600,       // poids pente-max fenêtre longue (traversée raide)
  wRough: 0,         // poids rugosité fenêtre courte (tissage fin)
  leash: 3000,       // laisse latérale max vs polyline waypoints (m)
  avoidR: 350,       // garde douce : rayon d'avertissement (m)
  wAvoid: 400,       // poids de la garde douce
  causeway: 3,       // hauteur de la route au-dessus de la mer (m) — n°43 :
                     // +3 remplace le +12 de HroadC (causeway bas)
  lookWP: 4000,      // pure pursuit waypoints (m)
  grace: 50,         // fenêtre de grâce anti-croisement (samples = 400 m d'arc)
  lookWater: 2000,   // lookahead de la garde sur l'eau (m)
  lookLand: 1600,    // lookahead de la garde à terre (m)
  /* n°50 — MONDE CRÉDIBLE P1 : obstacles naturels dans le coût.
     obstEvery : les signaux (lac/marais/forêt dense) sont échantillonnés
     tous les obstEvery sous-pas du lookahead 192 m (12 → 96 m : le signal
     est lisse à l'échelle de 100 m+ ; l'échantillonner à chaque sous-pas
     coûte ×6 sans gain, mesuré). Poids (calibration banc bench-n50,
     3 graines × 1000 km) : le lac est cher comme un ouvrage (wLake 12 →
     traversées 73/68/55 → 15/14/14 ; 8 laissait 22/17/17 ET cassait la
     4e ref POI), le marais paie ses fondations, la forêt dense son
     défrichement (les MASSIFS climatiques restent du ressort du futur
     P2 macro — le poids 1.5 ne vise que les boqueteaux). Signaux purs
     de (graine, x, y) — zéro PRNG, ADR 0004. */
  obstEvery: 12,
  wLake: 12,
  wMarsh: 3,
  wFor: 1.5,
};

/* ---- mémoire anti-croisement : buckets de 250 m des segments commis.
   Clé = bx·2²⁶ + by ; entrées plates [x0, y0, x1, y1, tag] où tag =
   l'index d'échantillon ABSOLU de l'ARRIVÉE du segment. Append-only
   (jamais évictée) : la régénération d'un chunk ancien réinsère des
   doublons NEUTRES (min de distance et booléens d'intersection
   inchangés), et les segments « futurs » sont ignorés par leur tag
   (tag > iNow − grace) — la régénération reste bit à bit identique. */
const AB = 250;
const abk = (bx: number, by: number): number => bx * 67108864 + by;
function pushSeg(hist: Map<number, number[]>, x0: number, y0: number, x1: number, y1: number, tag: number): void {
  const k0 = abk(Math.floor(x0 / AB), Math.floor(y0 / AB));
  const k1 = abk(Math.floor(x1 / AB), Math.floor(y1 / AB));
  for (const kk of new Set([k0, k1])) {
    let arr = hist.get(kk);
    if (!arr) { arr = []; hist.set(kk, arr); }
    arr.push(x0, y0, x1, y1, tag);
  }
}
/* proximité douce : min distance d'un point au chemin ancien (au-delà
   de la fenêtre de grâce en arrière ; le chemin récent — l'épingle —
   est légitime, il revient PRÈS de son tracé sans le couper) */
function avoidNear(hist: Map<number, number[]>, px: number, py: number, iNow: number, grace: number): number {
  const bx = Math.floor(px / AB), by = Math.floor(py / AB);
  let dmin = Infinity;
  for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
    const arr = hist.get(abk(bx + dx, by + dy));
    if (!arr) continue;
    for (let q = 0; q < arr.length; q += 5) {
      if (arr[q + 4]! > iNow - grace) continue;
      const d = Math.hypot(arr[q]! - px, arr[q + 1]! - py);
      if (d < dmin) dmin = d;
    }
  }
  return dmin;
}
/* intersection exacte du segment candidat (x0,y0)→(x1,y1) vs chemin
   ancien (au-delà de la fenêtre de grâce) — interdite. PIÈGES de
   calibration (mesurés, bench-n42-emergente) :
   - échantillonnage DENS (8 points) : un t=0.25 laissait un angle
     mort 0-125 m près de la position sur l'eau — croisement km 333,
     graine 42 ;
   - bornes en MÈTRES (tmin = 1/len), pas en fraction : un croisement
     rasant à 1-2 m de la position a tt≈0.0005 — exclu par l'ancien
     seuil 0.001, la garde devenait aveugle au dernier pas (km 255.7,
     graine 777). */
function avoidCross(hist: Map<number, number[]>, x0: number, y0: number, x1: number, y1: number, iNow: number, grace: number): boolean {
  const d1x = x1 - x0, d1y = y1 - y0;
  const len = Math.hypot(d1x, d1y);
  if (len < 0) return false;   // jamais
  const tmin = 1 / len;
  for (let t = 0.125; t <= 1.01; t += 0.125) {
    const px = x0 + d1x * t, py = y0 + d1y * t;
    const bx = Math.floor(px / AB), by = Math.floor(py / AB);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const arr = hist.get(abk(bx + dx, by + dy));
      if (!arr) continue;
      for (let q = 0; q < arr.length; q += 5) {
        if (arr[q + 4]! > iNow - grace) continue;
        const sx1 = arr[q]!, sy1 = arr[q + 1]!, sx2 = arr[q + 2]!, sy2 = arr[q + 3]!;
        const d2x = sx2 - sx1, d2y = sy2 - sy1;
        const den = d1x * d2y - d1y * d2x;
        if (Math.abs(den) < 1e-12) continue;
        const tt = ((sx1 - x0) * d2y - (sy1 - y0) * d2x) / den;
        const uu = ((sx1 - x0) * d1y - (sy1 - y0) * d1x) / den;
        if (tt > tmin && tt < 1 - tmin && uu > 0.001 && uu < 0.999) return true;
      }
    }
  }
  return false;
}

export type PoiCursor = Record<PoiKind, number>; // prochain POI pend. par type

export type Route = {
  seed: number;
  poiDensity: number;
  totalKm: number;
  finishS: number;           // abscisse d'arrivée (m)
  nChunks: number;
  bound: Bound[];            // bound[k] = état d'entrée du chunk k
  wps: Waypoint[];           // ossature macro (pure de seed+totalKm, jamais sérialisée)
  poiCur: PoiCursor[];       // poiCur[k] = curseurs POI à l'entrée du chunk k
  chunks: Map<number, Chunk>;
  order: number[];           // ordre d'insertion (éviction FIFO)
  hist: Map<number, number[]>;   // n°43 : segments commis (garde anti-croisement)
};

/* ============================================================
   n°33 — SURFACE CONTINUE (largeur, grip, roulement)
   La chaussée dérive du CLIMAT à la position exacte — des fonctions
   LISSES des axes (sigmoïdes ss), pas des tables par étiquette :
   les frontières de familles ne se VOIENT pas au revêtement.
   Cibles (calibrées sur les biomes n°31/n°32, 4 graines) :
   - demi-largeur (m) : plaine 3,75 · désert 3,0 · forêt 3,6 ·
     boréal 3,2 · altitude 1,6 (une file — CAR_D 2,05 m : le duel
     côte à côte y est physiquement impossible) · littoral 3,6 ;
   - grip μ : plaine 1,12 · désert 0,675 (sable) · forêt 0,945
     (terre) · boréal 0,90 (sol froid) · altitude 0,874 (pierre) ·
     littoral 0,98 ;
   - roulement crr : plaine 1,0 · désert 2,375 · forêt 1,21 ·
     boréal 1,40 · altitude 1,27 · littoral 1,15. */
function surfParams(x: number, y: number, seed: number): { w: number; mu: number; crr: number } {
  const hr = HroadC(x, y, seed);            // géographie (causeway inclus)
  const M = moistAt(x, y, seed);
  const T = tempAt(x, y, seed);
  const co = coastAt(x, y, seed);
  const alt = ss(150, 300, hr);              // étage alpin
  const arid = 1 - ss(0.16, 0.34, M);        // versant sec
  const wet = ss(0.52, 0.75, M);            // forêt
  const cold = ss(6, -6, T);                 // boréal (sigmoïde descendante)
  return {
    w: Math.max(1.6, 3.75 - 0.75 * arid - 0.15 * wet - 0.55 * cold - 2.15 * alt - 0.15 * co),
    mu: 1.12 - 0.445 * arid - 0.175 * wet - 0.22 * cold - 0.246 * alt - 0.14 * co,
    crr: 1.0 + 1.375 * arid + 0.21 * wet + 0.40 * cold + 0.27 * alt + 0.15 * co,
  };
}

/* écart d'altitude du TERRAIN environnant vs tracé : ravin sous un
   pont, roche au-dessus d'un tunnel (données du tracé, déterministes) */
export const SEG_GROUND = 0;    // route au sol
export const SEG_LIMIT = 18;     // m — n°32 : seuil pont/tunnel abaissé de 25 :
                                 // la bande 15-25 m (jupe en mur = estrade) devient
                                 // de vrais ponts/tunnels. Mesuré graine 12345,
                                 // 2000 km : ponts 3,6 % · tunnels 3,8 %, tous les
                                 // biomes ≥ 2,8 % (verrou TF ≥ 2 % OK).
export const SEG_BRIDGE = 1;    // pont : terrain = tracé - ravin
                                 // n°33 : le CAUSEWAY sur la mer est un pont —
                                 // gap = (SEA_SL + 12) − fond marin > SEG_LIMIT
export const SEG_TUNNEL = 2;    // tunnel : terrain = tracé + roche

/* ---- densité des POI par FAMILLE (km d'espacement de base × facteur) —
   n°33 : plaine riche, désert vide — la famille remplace le biome ---- */
const POI_BASE: Record<PoiKind, number> = { station: 30, hotel: 90, garage: 120 };
const POI_FAM = [0.8, 2.6, 1.0, 1.3, 1.4, 0.9]; // plaine riche · désert vide
export const POI_KINDS: PoiKind[] = ['station', 'hotel', 'garage'];

function chunkRand(seed: number, k: number): () => number {
  /* graine par chunk : mélange simple et déterministe */
  return mulberry32(((seed ^ 0x9e3779b9) | 0) + Math.imul(k + 1, 2654435761) | 0);
}

/* ============================================================
   Construction d'un chunk — CONTRÔLEUR ÉMERGENT (n°43)
   ============================================================ */
export function buildChunk(rt: Route, k: number): Chunk {
  const e = rt.bound[k]!;
  const rand = chunkRand(rt.seed, k);   // n°43 : les POI sont le SEUL consommateur
  const s0 = k * RCHUNK;

  /* ---- paramètres de surface PAR ÉCHANTILLON (calculés dans la
     boucle du contrôleur, où la position est connue) ---- */
  const w = new Float64Array(RSAMP);
  const h = new Float64Array(RSAMP);
  const mua = new Float64Array(RSAMP);
  const crrA = new Float64Array(RSAMP);
  const biome = new Float64Array(RSAMP);
  const hd = new Float64Array(RSAMP);
  const xs = new Float64Array(RSAMP);
  const zs = new Float64Array(RSAMP);
  hd[0] = e.hd;
  xs[0] = 0;
  zs[0] = 0;
  h[0] = e.h;
  biome[0] = famAt(e.x, e.y, rt.seed);
  {
    const sp = surfParams(e.x, e.y, rt.seed);
    w[0] = sp.w; mua[0] = sp.mu; crrA[0] = sp.crr;
  }

  /* ---- état du contrôleur (continué du chunk précédent via Bound) ---- */
  const wps = rt.wps;
  const hist = rt.hist;
  const sea = WP.seaLevel;
  let x = e.x, y = e.y, alt = e.h, hdC = e.hd, steerPrev = e.steerPrev ?? 0;
  let wpIdx = e.wpIdx;

  /* la cible d'altitude du limiteur : le relief RÉEL (H, octaves fines
     n°43 comprises), causeway à seaLevel+3 m sur l'eau */
  const target = (px: number, py: number): number => {
    const t = H(px, py, rt.seed);
    return t < sea ? sea + ER.causeway : t;
  };
  /* avance le limiteur d'un pas de 8 m le long d'un cap ; renvoie le
     coût hug (écart route/cible), l'altitude limiteur, la pente du sol
     rencontrée (pas de pente sous l'eau : le causeway est à part) */
  const simSeg = (cx: number, cy: number, hd2: number, a: number, prevT: number | null) => {
    const nx = cx + Math.cos(hd2) * SEG, ny = cy + Math.sin(hd2) * SEG;
    const t = target(nx, ny);
    const na = a + Math.max(-ER.budget * SEG, Math.min(ER.budget * SEG, t - a));
    const slope = prevT !== null && t >= sea && prevT >= sea ? Math.abs(t - prevT) / SEG : 0;
    return { cost: Math.abs(t - na), a: na, nx, ny, slope, t };
  };

  for (let i = 0; i < RSAMP; i++) {
    const gi = k * RSAMP + i;   // index d'échantillon GLOBAL (tags hist)

    /* ---- avancement du waypoint cible : 3 tests, du proche au
       géométrique (n°33, inchangé — ne PAS simplifier en dot<0 seul) ---- */
    while (wpIdx < wps.length - 1) {
      const cur = wps[wpIdx]!, nxt = wps[wpIdx + 1]!;
      const dcx = cur.x - x, dcy = cur.y - y;
      const d2 = dcx * dcx + dcy * dcy;
      let adv = d2 < 5000 * 5000;
      if (!adv && wpIdx > 0 && d2 < 15000 * 15000) {
        const inx = cur.x - wps[wpIdx - 1]!.x, iny = cur.y - wps[wpIdx - 1]!.y;
        if ((x - cur.x) * inx + (y - cur.y) * iny > 0) adv = true;
      }
      if (!adv && d2 < 8000 * 8000 &&
          (nxt.x - x) * dcx + (nxt.y - y) * dcy < 0) adv = true;
      if (adv) wpIdx++; else break;
    }
    /* ---- pure pursuit sur le segment actif (n°33, inchangé) ---- */
    let tx: number, ty: number;
    if (wpIdx === 0) { tx = wps[0]!.x; ty = wps[0]!.y; }
    else {
      const a = wps[wpIdx - 1]!, b2 = wps[wpIdx]!;
      const dx = b2.x - a.x, dy = b2.y - a.y;
      const L = Math.hypot(dx, dy) || 1;
      let t = ((x - a.x) * dx + (y - a.y) * dy) / (L * L);
      t = Math.max(0, Math.min(1, t + ER.lookWP / L));
      tx = a.x + dx * t; ty = a.y + dy * t;
    }
    const hdMac = Math.atan2(ty - y, tx - x);
    /* ---- laisse latérale vs polyline (le couloir ne se referme pas
       hors des plis de waypoints) ---- */
    let leashPen = 0;
    {
      const a = wps[Math.max(0, wpIdx - 1)]!, b2 = wps[Math.min(wps.length - 1, wpIdx)]!;
      const dx = b2.x - a.x, dy = b2.y - a.y, L2 = dx * dx + dy * dy;
      let t = L2 === 0 ? 0 : ((x - a.x) * dx + (y - a.y) * dy) / L2;
      t = Math.max(0, Math.min(1, t));
      const dLat = Math.hypot(a.x + dx * t - x, a.y + dy * t - y);
      if (dLat > ER.leash) leashPen = 400 * (dLat - ER.leash);
    }
    /* ---- choix du cap candidat au moindre coût ---- */
    let best: { cost: number; d: number } | null = null;
    const dOld = new Float64Array(ER.cands.length);
    const overWater = H(x, y, rt.seed) < sea;
    const gl = overWater ? ER.lookWater : ER.lookLand;
    for (let ci = 0; ci < ER.cands.length; ci++) {
      const d = ER.cands[ci]!;
      const hd2 = hdC + d;
      let cx = x, cy = y, a = alt, hug = 0, steep = 0, prevT = target(x, y);
      for (let j = 0; j < ER.lookC; j++) {
        const r = simSeg(cx, cy, hd2, a, prevT);
        cx = r.nx; cy = r.ny; a = r.a; prevT = r.t;
        hug += Math.min(r.cost, ER.hugCap);
        if (r.slope > steep) steep = r.slope;
      }
      /* n°50 — obstacles naturels : le cap candidat GOÛTE le monde le
         long de son lookahead. Le cap est CONSTANT sur le lookahead →
         la position au sous-pas j = x + cap·j·8 m, EXACTE. */
      let obst = 0;
      for (let j = ER.obstEvery; j <= ER.lookC; j += ER.obstEvery) {
        obst += obstCost(x + Math.cos(hd2) * j * SEG, y + Math.sin(hd2) * j * SEG,
                         rt.seed, ER.wLake, ER.wMarsh, ER.wFor);
      }
      const pur = wpWrap(hd2 - hdMac);
      const steepPen = Math.max(0, steep - ER.gentleS) ** 2 * ER.wSteep;
      /* garde anti-croisement, deux niveaux :
         - intersection exacte du LOOKAHEAD vs chemin ancien : interdit
           (1e7). Le lookahead est LONG (2 km sur l'eau, 1,6 km à
           terre) : sans signal de relief, la poursuite macro piège à
           l'échelle du km — l'échappatoire de 192 m arrive trop tard
           (30 croisements mesurés graine 42) et un pli qui se referme
           doit être vu AVANT la boucle (poche km 250, graine 777) ;
         - proximité douce (rayon avoidR) : avertit TÔT, la route dérive
           loin de son ancien tracé avant d'être piégée. La fenêtre de
           grâce (grace = 400 m d'arc) couvre les épingles. */
      let avoidPen = 0;
      const lx = x + Math.cos(hd2) * gl, ly = y + Math.sin(hd2) * gl;
      if (avoidCross(hist, x, y, lx, ly, gi, ER.grace)) avoidPen += 1e7;
      const dOld1 = avoidNear(hist, x + Math.cos(hd2) * 96, y + Math.sin(hd2) * 96, gi, ER.grace);
      dOld[ci] = dOld1;
      if (dOld1 < ER.avoidR) avoidPen += ER.wAvoid * (1 - dOld1 / ER.avoidR);
      const cost = ER.wHug * hug / ER.lookC + ER.wPur * pur * pur
                 + ER.wSm * (d - steerPrev) ** 2 + ER.wZero * Math.abs(d)
                 + steepPen + leashPen * pur * pur + avoidPen + obst;
      if (!best || cost < best.cost) best = { cost, d };
    }
    /* évasion en 2 passes : si TOUS les candidats coupent (best ≥ 1e7),
       on ne départage PAS au coût global (il choisit mal — mesuré) :
       on prend le cap qui s'éloigne le PLUS du chemin ancien. PAS de
       récompense : la pénalité 1e7 reste, les autres candidats
       redeviennent interdits dès qu'un non-coupant réapparaît. */
    if (best && best.cost >= 1e7) {
      let esc = -1, dMax = -1;
      for (let ci = 0; ci < ER.cands.length; ci++) {
        if (dOld[ci]! > dMax) { dMax = dOld[ci]!; esc = ci; }
      }
      if (esc >= 0) best = { cost: 0, d: ER.cands[esc]! };
    }
    /* ---- commit : un pas de 8 m ; le segment commis entre dans la
       mémoire anti-croisement (tag = index ABSOLU d'arrivée) ---- */
    const d = best!.d;
    const r = simSeg(x, y, hdC + d, alt, null);
    pushSeg(hist, x, y, r.nx, r.ny, gi + 1);
    hdC += d;
    alt = r.a;
    x = r.nx; y = r.ny;
    if (i + 1 < RSAMP) {
      hd[i + 1] = hdC;
      xs[i + 1] = x - e.x;
      zs[i + 1] = y - e.y;
      h[i + 1] = alt;
      biome[i + 1] = famAt(x, y, rt.seed);
      const sp = surfParams(x, y, rt.seed);
      w[i + 1] = sp.w; mua[i + 1] = sp.mu; crrA[i + 1] = sp.crr;
    } else {
      /* l'état de SORTIE (après le pas RSAMP-1 → RSAMP) est l'entrée du
         chunk suivant — le contrôleur est CONTINU aux frontières */
      rt.bound[k + 1] = { x, y, hd: hdC, h: alt, wpIdx, steerPrev: d };
    }
    steerPrev = d;
  }

  /* ---- POI : le curseur global de chaque type avance dans le chunk ---- */
  const cursor: PoiCursor = { ...rt.poiCur[k]! };
  const poiDensity = rt.poiDensity ?? 1;
  const end = s0 + RCHUNK;
  const pois: Poi[] = [];
  for (const kind of POI_KINDS) {
    let s = cursor[kind];
    while (s < end) {
      if (s >= s0) pois.push({ s: Math.floor(s / SEG) * SEG, kind });
      /* n°33 : la densité se lit à la famille du point le plus proche
         (l'étiquette du chunk est continue — plaine riche, désert vide) */
      const i2 = Math.max(0, Math.min(RSAMP - 1, Math.floor((s - s0) / SEG)));
      const fac = POI_FAM[Math.min(5, Math.max(0, Math.floor(biome[i2]!)))];
      s += (POI_BASE[kind]! * 1000 / Math.max(0.2, poiDensity)) * fac * (0.7 + 0.6 * rand());
    }
    cursor[kind] = s;
  }
  pois.sort((a, b) => a.s - b.s);

  /* ---- état de sortie POI : le curseur du chunk suivant (l'état du
     contrôleur — position, cap, altitude, braquage — est passé dans
     rt.bound[k+1] PAR LA BOUCLE, au dernier pas commis) ---- */
  rt.poiCur[k + 1] = cursor;

  /* ---- PONTS et TUNNELS TOPOGRAPHIQUES (n°25) : l'écart route/terrain
     décide — gap lissé > +18 m → PONT (vraie vallée), < −18 m → TUNNEL
     (vraie crête), toutes familles, SANS PRNG. Un run PEUT être à cheval
     sur deux chunks : le gap est pur de la position. n°33 : le CAUSEWAY
     de mer est un PONT (gap = niveau causeway − fond marin). ---- */
  const terr = new Float64Array(RSAMP);
  const segType = new Float64Array(RSAMP);
  /* écart route/terrain (m) : > 0 = terrain SOUS la route (vallée → PONT),
     < 0 = terrain AU-DESSUS (crête → TUNNEL). Lissé ±6 samples pour des
     runs propres. SANS PRNG : la topographie décide, toutes familles. */
  const gap = new Float64Array(RSAMP);
  for (let i = 0; i < RSAMP; i++) gap[i] = h[i]! - H(e.x + xs[i]!, e.y + zs[i]!, rt.seed);
  const gapS = new Float64Array(RSAMP);
  for (let i = 0; i < RSAMP; i++) {
    let a = 0, n = 0;
    for (let d = -6; d <= 6; d++) {
      const j = i + d;
      if (j >= 0 && j < RSAMP) { a += gap[j]!; n++; }
    }
    gapS[i] = a / n;
  }
  for (let i = 0; i < RSAMP; i++) {
    terr[i] = h[i]! - gap[i]!;   // = H exact : le serveur connaît le terrain
    segType[i] = gapS[i]! > SEG_LIMIT ? SEG_BRIDGE : gapS[i]! < -SEG_LIMIT ? SEG_TUNNEL : SEG_GROUND;
  }
  return { k, s0, hd, xs, zs, h, terr, segType, w, mua, crrA, biome, pois };
}

/* ---- génération à la demande : les chunks se construisent EN ORDRE
   (chacun a besoin de la sortie du précédent), se mettent en cache,
   et les plus anciens sont évictés au-delà de la fenêtre mémoire. ---- */
export function ensureChunk(rt: Route, k: number): Chunk {
  const hit = rt.chunks.get(k);
  if (hit) return hit;
  /* bornes manquantes ? on construit tout ce qui précède (une seule fois) */
  while (rt.bound.length <= k) {
    const j = rt.bound.length - 1;
    const c = buildChunk(rt, j);
    rt.chunks.set(j, c);
    rt.order.push(j);
  }
  const c = buildChunk(rt, k);
  rt.chunks.set(k, c);
  rt.order.push(k);
  while (rt.order.length > MAX_CACHED) {
    const old = rt.order.shift()!;
    rt.chunks.delete(old);
  }
  return c;
}

/* densité des POI : la course la reçoit du paramétrage admin (page
   admin) — les espacements de base sont divisés par le facteur (2 =
   deux fois plus dense), bornés à la construction, déterministes */
export function makeRoute(seed: number, totalKm: number, poiDensity = 1): Route {
  const nChunks = Math.ceil((totalKm * 1000) / RCHUNK);
  const rt: Route = {
    seed,
    totalKm,
    finishS: totalKm * 1000,
    nChunks,
    bound: [{ x: 0, y: 0, hd: 0, h: Math.max(H(0, 0, seed), WP.seaLevel + ER.causeway), wpIdx: 1, steerPrev: 0 }],
    wps: buildWaypoints(seed, totalKm),
    poiDensity,
    poiCur: [{ station: 25_000 / poiDensity, hotel: 80_000 / poiDensity, garage: 110_000 / poiDensity }],
    chunks: new Map(),
    order: [],
    hist: new Map(),
  };
  return rt;
}

/* ============================================================
   LA VUE PHYSIQUE : RouteTrack implémente l'interface Track du moteur
   (cvAt/muAt/wAt/crrAt/heightAt) + les services de la course
   ============================================================ */
export type RouteTrack = Track & {
  roadPoint(s: number): { x: number; y: number; hd: number };
  biomeAt(s: number): number;
  poisAhead(s: number, radius: number): Poi[];
  finishS: number;
};

/* clamp : au-delà de l'arrivée, on lit le dernier échantillon (la
   course s'arrête là — jamais de NaN dans le moteur) */
function clampS(rt: Route, s: number): number {
  return Math.max(0, Math.min(s, rt.finishS - 0.001));
}

export function routeTrack(rt: Route): RouteTrack {
  /* chunk + indice local pour une abscisse (échantillon au sol, 8 m) */
  const loc = (s: number): { c: Chunk; i: number } => {
    const sc = clampS(rt, s);
    const k = Math.min(rt.nChunks - 1, Math.floor(sc / RCHUNK));
    const c = ensureChunk(rt, k);
    const i = Math.min(RSAMP - 1, Math.max(0, Math.floor((sc - c.s0) / SEG)));
    return { c, i };
  };
  /* cap interpolé — la frontière de chunk lit le cap d'entrée suivant */
  const hdAt = (s: number): number => {
    const sc = clampS(rt, s);
    const k = Math.min(rt.nChunks - 1, Math.floor(sc / RCHUNK));
    const c = ensureChunk(rt, k);
    const f = (sc - c.s0) / SEG;
    const i0 = Math.min(RSAMP - 1, Math.floor(f));
    if (i0 === RSAMP - 1) {
      const nxt = k + 1 < rt.nChunks ? rt.bound[k + 1]!.hd : c.hd[RSAMP - 1]!;
      return c.hd[RSAMP - 1]! + (nxt - c.hd[RSAMP - 1]!) * (f - i0);
    }
    return c.hd[i0]! + (c.hd[i0 + 1]! - c.hd[i0]!) * (f - i0);
  };
  const hAt = (s: number): number => {
    const sc = clampS(rt, s);
    const k = Math.min(rt.nChunks - 1, Math.floor(sc / RCHUNK));
    const c = ensureChunk(rt, k);
    const f = (sc - c.s0) / SEG;
    const i0 = Math.min(RSAMP - 1, Math.floor(f));
    if (i0 === RSAMP - 1) {
      const nxt = k + 1 < rt.nChunks ? rt.bound[k + 1]!.h : c.h[RSAMP - 1]!;
      return c.h[RSAMP - 1]! + (nxt - c.h[RSAMP - 1]!) * (f - i0);
    }
    return c.h[i0]! + (c.h[i0 + 1]! - c.h[i0]!) * (f - i0);
  };
  return {
    finishS: rt.finishS,
    cvAt: (s: number) => (hdAt(s + 4) - hdAt(s - 4)) / 8,
    muAt: (s: number) => { const { c, i } = loc(s); return c.mua[i]!; },
    wAt: (s: number) => { const { c, i } = loc(s); return c.w[i]!; },
    crrAt: (s: number) => { const { c, i } = loc(s); return c.crrA[i]!; },
    heightAt: hAt,
    biomeAt: (s: number) => { const { c, i } = loc(s); return c.biome[i]!; },
    roadPoint: (s: number) => {
      const sc = clampS(rt, s);
      const k = Math.min(rt.nChunks - 1, Math.floor(sc / RCHUNK));
      const c = ensureChunk(rt, k);
      const b = rt.bound[k]!;
      const f = (sc - c.s0) / SEG;
      const i0 = Math.min(RSAMP - 1, Math.floor(f));
      const t = f - i0;
      const x1 = i0 === RSAMP - 1 ? rt.bound[k + 1]!.x - b.x : c.xs[i0 + 1]!;
      const y1 = i0 === RSAMP - 1 ? rt.bound[k + 1]!.y - b.y : c.zs[i0 + 1]!;
      return {
        x: b.x + c.xs[i0]! + (x1 - c.xs[i0]!) * t,
        y: b.y + c.zs[i0]! + (y1 - c.zs[i0]!) * t,
        hd: hdAt(sc),
      };
    },
    /* POI dans [s, s+radius] — peut générer les chunks intermédiaires */
    poisAhead: (s: number, radius: number): Poi[] => {
      const out: Poi[] = [];
      const sEnd = clampS(rt, s + radius);
      const k0 = Math.floor(clampS(rt, s) / RCHUNK);
      const k1 = Math.min(rt.nChunks - 1, Math.floor(sEnd / RCHUNK));
      for (let k = k0; k <= k1; k++) {
        const c = ensureChunk(rt, k);
        for (const p of c.pois) if (p.s >= s && p.s <= sEnd) out.push(p);
      }
      return out;
    },
  };
}
