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

   Biomes : segments de 150-500 km qui s'enchaînent dans l'ordre du
   design (plaine → forêt → désert → altitude → …), transitions
   fondues sur 2 km. Le plan de virages garde les MENUS du proto par
   biome (droites longues au désert, épingles en altitude…) et le cap
   est refermé sur chaque chunk (l'itinéraire chemine sans spiraler).
   L'altitude vient du CHAMP DE MONDE (terrain.ts, n°25) : Hroad
   (géographie terrassée) + fastAt (détail voiture pur).

   Points d'intérêt (station, hôtel, garage) : posés par un CURSEUR
   GLOBAL par type — continuité parfaite aux frontières de chunks,
   densité par biome (la plaine est riche, le désert est vide),
   espacements tirés du PRNG du chunk. C'est l'ossature des arrêts
   de la vision : pas de files, services à la carte. */

import { mulberry32, makeNoise, SEG, BIOMES, type Track } from './engine.ts';
import { H, Hroad } from './terrain.ts';

export const RSAMP = 2600;            // échantillons par chunk
export const RCHUNK = SEG * RSAMP;    // 20 800 m — un chunk
export const BLEND = 250;             // fondu de biome : 2 km
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
  biome: Float64Array;       // biome (réel : a + t du fondu)
  pois: Poi[];               // points d'intérêt du chunk, triés par s
};

/* état d'entrée d'un chunk (cap, position, altitude au 1er échantillon) ;
   la hauteur porte le retour à la moyenne ; 4 nombres par chunk : on
   garde TOUT l'historique — c'est minuscule et c'est ce qui rend la
   régénération d'un chunk ancien possible sans tout reconstruire. */
export type Bound = { x: number; y: number; hd: number; h: number; wpIdx: number; hdDev: number; hdPsi: number };

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
      /* coût altimétrique : altitude moyenne du tronçon (9 sondes)
         + préférence douce pour les caps peu changeants */
      let hSum = 0;
      for (let q = 0; q <= 8; q++) {
        hSum += H(x + (nx - x) * q / 8, y + (ny - y) * q / 8, seed);
      }
      const cost = hSum / 9 + 40 * Math.abs(db);
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

/* SINUOSITÉ : 1 point de contrôle / 6,4 km, interpolation cosinus.
   Fonction PURE de (seed, index global) — ne consomme PAS de PRNG,
   identique à la régénération d'un chunk ancien. Portions calmes
   alternent avec des portions sinueuses : la route respire. */
const sinuHash = (seed: number, j: number) => {
  const v = Math.sin(j * 127.1 + seed * 0.618) * 43758.5453;
  return v - Math.floor(v);
};
function sinuAt(seed: number, gi: number): number {
  const per = 800; // 6,4 km
  const j0 = Math.floor(gi / per);
  const t = gi / per - j0;
  const w = (1 - Math.cos(Math.PI * t)) / 2;
  return sinuHash(seed, j0) * (1 - w) + sinuHash(seed, j0 + 1) * w;
}
/* ============================================================
   V4 — ONDULATION DE PLATE-FORME (l'échelle de la voiture)
   ============================================================
   Constat mesuré sur la V3 : le volant se retourne 1-6 fois par
   km seulement ; entre les items step = 0 EXACTEMENT et le relief
   vertical ne vit qu'à 400+ m. Depuis le cockpit (300 m
   visibles), la route est un arc uniforme : un fleuve tranquille.
   PSI corrige cela : un méandre CONTINU, bande limitée, PUR de
   (graine, index global) — PAS de PRNG (identique à la
   régénération d'un chunk ancien, ADR 0004). Deux composantes :
   lente (le serpent vu au loin, 0,5-0,7 km) + rapide (le grain
   de la piste, 0,12-0,17 km). Amplitude en MÈTRES LATÉRAUX par
   biome, modulée par la sinuosité de portion : les portions
   calmes ondulent aussi (c'est l'échelle voiture, pas la
   sinuosité macro).

   La correction de poursuite ne le voit PAS : psi est versé dans
   hd ET dans hdPsi (accumulateur séparé) — hdDev reste l'exact
   plan V3, donc menus et POI d'une même graine ne changent
   D'AUCUN BIT. */
const PSI_LAT1 = [2.2, 3.0, 1.6, 2.4];      // m, composante lente
const PSI_L1 = [600, 500, 700, 460];         // m, longueur d'onde lente
const PSI_LAT2 = [0.8, 1.2, 0.6, 1.0];      // m, composante rapide
const PSI_L2 = [150, 120, 170, 120];        // m, longueur d'onde rapide
const psiPhase = (seed: number, c: number) => {
  const v = Math.sin(c * 91.7 + seed * 0.318) * 43758.5453;
  return (v - Math.floor(v)) * Math.PI * 2;
};
function psiAt(rt: Route, gi: number): number {
  const bz = biomeBlendR(rt, gi);
  const lerpB = (p: number[]) => p[bz.a] + (p[bz.b] - p[bz.a]) * bz.t;
  const m = 0.6 + 0.8 * sinuAt(rt.seed, gi);
  const lat1 = lerpB(PSI_LAT1) * m, L1 = lerpB(PSI_L1);
  const lat2 = lerpB(PSI_LAT2) * m, L2 = lerpB(PSI_L2);
  const s = gi * SEG;
  return lat1 * (Math.PI * 2 / L1) * Math.sin(s * (Math.PI * 2 / L1) + psiPhase(rt.seed, 1))
       + lat2 * (Math.PI * 2 / L2) * Math.sin(s * (Math.PI * 2 / L2) + psiPhase(rt.seed, 2));
}

/* TF — OCTAVE VERTICALE RAPIDE PURE (détail voiture, style biome) :
   valeur ABSOLUE pure de (graine, index global) — continue aux
   frontières de chunks, identique à la régénération (ADR 0004), sans
   dérive. Amplitude recalibrée sur la V4 (résidu vertical 300 m :
   plaine ~0,1 m, désert ~0,4-0,5 m). */
const FAST_AMP = [0.010, 0.014, 0.100, 0.028]; // par biome — recalibré valeur absolue
const FAST_SCALE = 21;
const fastHash = (seed: number, j: number) => {
  const v = Math.sin(j * 269.5 + seed * 0.913) * 43758.5453;
  return (v - Math.floor(v)) * 2 - 1;   // [-1, 1]
};
function fastAt(rt: Route, gi: number): number {
  const bz = biomeBlendR(rt, gi);
  const fk = FAST_AMP[bz.a] + (FAST_AMP[bz.b] - FAST_AMP[bz.a]) * bz.t;
  const x = gi / 16.7;   // période ~134 m
  const j0 = Math.floor(x);
  const f = x - j0;
  const t = f * f * (3 - 2 * f);
  const a = fastHash(rt.seed, j0), b = fastHash(rt.seed, j0 + 1);
  return fk * FAST_SCALE * (a + (b - a) * t);
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
  segs: { b: number; from: number; to: number }[]; // biomes, en samples globaux
};

/* ---- planning des biomes : 150-500 km par biome, cycle du design ---- */
export function buildSchedule(seed: number, totalKm: number): Route['segs'] {
  const rand = mulberry32((seed ^ 0x51ed270b) | 0);
  const segs: Route['segs'] = [];
  const end = Math.ceil((totalKm * 1000) / SEG);
  let pos = 0;
  let b = 0; // on démarre en plaine : un départ de course se joue sur du rapide
  while (pos < end) {
    /* longueur 150-500 km (en échantillons de 8 m) */
    const len = Math.ceil(((150 + rand() * 350) * 1000) / SEG);
    segs.push({ b, from: pos, to: pos + len });
    pos += len;
    b = (b + 1) % BIOMES.length;
  }
  return segs;
}

/* fondu de biome à l'échantillon global gi (recherche dichotomique) */
export function biomeBlendR(rt: Route, gi: number): { a: number; b: number; t: number } {
  const segs = rt.segs;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].from <= gi) lo = mid;
    else hi = mid - 1;
  }
  const seg = segs[lo];
  const d = seg.to - gi; // samples restants avant le biome suivant
  if (d >= BLEND || lo === segs.length - 1) return { a: seg.b, b: seg.b, t: 0 };
  return { a: seg.b, b: segs[Math.min(lo + 1, segs.length - 1)].b, t: 1 - d / BLEND };
}

/* ============================================================
   CARACTÈRE DU TRACÉ PAR BIOME (design du 2026-10-14)
   ============================================================
   La GÉOMÉTRIE change par biome, pas seulement μ/crr :
   - PLAINE  : asphalte, route large, rythme fluide — le royaume du duel ;
   - FORÊT  : revêtement terre, virages serrés et « aveugles », brume ;
   - DÉSERT  : longues droites VALLONNÉES (la dune creuse la pointe),
               sable (μ réduit, crr accru), larges sections ;
   - ALTITUDE: route ÉTROITE à 1 file (le duel côte à côte y est
               physiquement impossible), pierre, cols marqués avec
               LACETS, PONTS sur les ravins et TUNNELS sous la roche.
   Largeurs en demi-chaussée (m) — constants exportés, l'équilibrage
   se fera en course test. */

/* demi-largeur de chaussée par biome (m) : plaine/désert larges,
   forêt moyenne, altitude ÉTROITE — 1,6 m : deux voitures ne
   tiennent pas côte à côte (CAR_D = 2,05 m) */
export const BIOME_W = [3.75, 3.0, 3.6, 1.6];
/* modulation de grip du REVÊTEMENT (× biome μ) : terre en forêt,
   sable au désert, pierre en altitude — μ plus bas même à sec */
export const BIOME_SURF_MU = [1.0, 0.9, 0.9, 0.92];
/* rugosité du revêtement (× crr du biome) */
export const BIOME_SURF_CRR = [1.0, 1.25, 1.15, 1.1];
/* écart d'altitude du TERRAIN environnant vs tracé : ravin sous un
   pont, roche au-dessus d'un tunnel (données du tracé, déterministes) */
export const SEG_GROUND = 0;    // route au sol
export const SEG_BRIDGE = 1;    // pont : terrain = tracé - ravin
export const SEG_TUNNEL = 2;    // tunnel : terrain = tracé + roche

/* ---- densité des POI par biome (km d'espacement de base × facteur) ---- */
const POI_BASE: Record<PoiKind, number> = { station: 30, hotel: 90, garage: 120 };
const POI_BIOME = [0.8, 1.0, 2.6, 1.4]; // plaine riche · désert vide
export const POI_KINDS: PoiKind[] = ['station', 'hotel', 'garage'];

function chunkRand(seed: number, k: number): () => number {
  /* graine par chunk : mélange simple et déterministe */
  return mulberry32(((seed ^ 0x9e3779b9) | 0) + Math.imul(k + 1, 2654435761) | 0);
}

/* ============================================================
   Construction d'un chunk — même générateur de virages que le proto
   ============================================================ */
export function buildChunk(rt: Route, k: number): Chunk {
  const e = rt.bound[k];
  const rand = chunkRand(rt.seed, k);
  const noise = makeNoise(rand);
  const noise2 = makeNoise(rand);
  /* octave verticale RAPIDE (crêtes / creux à ~130 m) : la dune creuse
     la pointe au désert, la tête de piste ondule en plaine. PRNG
     SÉPARÉ du flux des menus : les items et POI d'une même graine ne
     changent D'AUCUN BIT par rapport à la V3 — le diff V4 est purement
     additif. */
  const noise3 = makeNoise(mulberry32(((rt.seed ^ 0x70731733) | 0) + Math.imul(k + 1, 2246822519) | 0));
  const s0 = k * RCHUNK;

  /* ---- paramètres de biome par échantillon (fondu 2 km) ---- */
  const w = new Float64Array(RSAMP);
  const h = new Float64Array(RSAMP);
  const mua = new Float64Array(RSAMP);
  const crrA = new Float64Array(RSAMP);
  const biome = new Float64Array(RSAMP);
  for (let i = 0; i < RSAMP; i++) {
    const bz = biomeBlendR(rt, k * RSAMP + i);
    const A = BIOMES[bz.a];
    const B = BIOMES[bz.b];
    const t = bz.t;
    const lerp = (p: number, q: number) => p + (q - p) * t;
    biome[i] = bz.a + bz.t;
    /* largeur par biome (BIOME_W) — l'altitude ÉTROITE à 1,6 m rend le
       duel côte à côte physiquement impossible : la garde
       anti-collision sépare en LONG */
    w[i] = lerp(BIOME_W[bz.a], BIOME_W[bz.b]);
    /* revêtement : modulation μ/crr du sol (terre/sable/pierre) */
    mua[i] = lerp(A.mu * BIOME_SURF_MU[bz.a], B.mu * BIOME_SURF_MU[bz.b]);
    crrA[i] = lerp(A.crr * BIOME_SURF_CRR[bz.a], B.crr * BIOME_SURF_CRR[bz.b]);
  }

  /* ---- plan de virages : LES MENUS DU PROTO, biome par biome.
     Identique à buildRoad : droites longues au désert, chicanes en
     forêt, épingles en altitude ; entrées/sorties par rampes de
     clothoïde ; le cap se contrebalance dans le chunk (l'itinéraire
     chemine sans spiraler sur 20 000 km). ---- */
  let pi = 0;
  let hdDev = e.hdDev;   // wiggle cumulé GLOBAL (borne par la bande dir())
  const WP_WIGGLE_MAX = 1.10;   // borne de magnitude du wiggle (bande ±0,40 + débord)
  const step = new Float64Array(RSAMP);
  const dir = () => (hdDev > 0.40 ? -1 : hdDev < -0.40 ? 1 : rand() < 0.5 ? -1 : 1);
  const writeCorner = (cvT: number, len: number, sgn: number, uBound = 0) => {
    const ramp = 4;
    /* uBound > 0 = DEMI-TOUR : la borne s'applique à la déflexion de l'ITEM
       (une épingle = un objet borné en soi) ; sinon borne de POSITION wiggle */
    let defl = 0;
    /* BORNE DE WIGGLE : la bande dir() agit sur le wiggle TOTAL — un
       item isolé (angle jusqu'à ~1,7 rad) ne doit pas emporter hdDev
       au-delà de la bande, sinon la dérive latérale explose l'enveloppe
       macro. Troncature du virage, AUCUN tirage PRNG modifié. */
    for (let q = 0; q < len && pi < RSAMP; q++, pi++) {
      const u = Math.min(1, (q + 1) / ramp, (len - q) / ramp);
      const d = sgn * cvT * SEG * u;
      if (uBound > 0 ? Math.abs(defl + d) > uBound
                     : (Math.abs(hdDev + d) > WP_WIGGLE_MAX && hdDev * sgn > 0)) break;
      step[pi] = d;
      hdDev += d;
      defl += d;
    }
  };
  const writeStraight = (len: number) => {
    for (let q = 0; q < len && pi < RSAMP; q++, pi++) step[pi] = 0;
  };
  /* COURANT : virage intermédiaire VISIBLE AU ZOOM (26-46° sur 0,5-1,2 km,
     sagitta 100-400 m), longueur bornée pour ne pas vider le budget micro */
  const writeCourant = (z: number) => {
    const turn = 0.45 + rand() * 0.35;
    const R = z === 0 ? 430 + rand() * 470
          : z === 1 ? 400 + rand() * 350
          : z === 2 ? 560 + rand() * 590
          : 350 + rand() * 300;
    const len = Math.max(60, Math.min(150, Math.round(turn * R / SEG)));
    writeCorner(1 / R, len, dir());
  };
  while (pi < RSAMP - 30) {
    const z = biomeBlendR(rt, k * RSAMP + Math.min(pi, RSAMP - 1)).a;
    const sinu = sinuAt(rt.seed, k * RSAMP + pi);
    const u = rand();
    /* courant : tirage SÉPARÉ, fréquence modulée par la sinuosité —
       les épingles du menu ne sont jamais remplacées */
    const pCur = z === 2 ? 0.05 + 0.22 * sinu
               : z === 0 ? 0.05 + 0.22 * sinu
               : 0.04 + 0.16 * sinu;
    const uCur = rand();
    if (uCur < pCur) { writeCourant(z); continue; }
    let kind: string;
    /* MENUS par biome — V2ter, avec droites resserrées plaine/désert
       pour compenser la longueur mangée par les courants */
    if (z === 0) kind = u < 0.10 ? 'droite' : u < 0.30 ? 'grand' : u < 0.54 ? 'petit' : u < 0.80 ? 's' : u < 0.98 ? 'angle' : 'epingle';
    else if (z === 1) kind = u < 0.08 ? 'droite' : u < 0.46 ? 'petit' : u < 0.74 ? 's' : u < 0.98 ? 'angle' : 'epingle';
    else if (z === 2) kind = u < 0.42 ? 'droite' : u < 0.62 ? 'grand' : 'angle';
    else kind = u < 0.06 ? 'droite' : u < 0.26 ? 'petit' : u < 0.50 ? 's' : u < 0.74 ? 'epingle' : 'lacets';
    if (kind === 'droite') {
      /* portion calme → lignes plus LONGUES (×1 à ×1,6) */
      const long = Math.round((z === 2 ? 26 + Math.floor(rand() * 36)
                                       : z === 0 ? 8 + Math.floor(rand() * 12)
                                                 : 10 + Math.floor(rand() * 20)) * (1 + 0.6 * (1 - sinu)));
      writeStraight(long);
    }
    else if (kind === 'grand') writeCorner(1 / (z === 0 ? 150 + rand() * 170 : 145 + rand() * 135), 12 + Math.floor(rand() * 18), dir());
    else if (kind === 'petit') writeCorner(1 / (z === 0 ? 120 + rand() * 100 : z === 1 ? 110 + rand() * 90 : 140 + rand() * 130), 8 + Math.floor(rand() * 12), dir());
    else if (kind === 's') {
      const cvS = 1 / (z === 3 ? 90 + rand() * 70 : z === 0 ? 120 + rand() * 100 : 150 + rand() * 130);
      const lS = 7 + Math.floor(rand() * 8);
      const sgn = dir(); writeCorner(cvS, lS, sgn); writeCorner(cvS, lS, -sgn);
    } else if (kind === 'angle') writeCorner(1 / (90 + rand() * 90), 14 + Math.floor(rand() * 12), dir());
    else if (kind === 'lacets') {
      const n = 2 + Math.floor(rand() * 2);        // 2-3 épingles en enfilade
      let last = dir();
      for (let u0 = 0; u0 < n && pi < RSAMP - 30; u0++) {
        const R = 25 + rand() * 15;                // 25-40 m — l'apex à ~55-65 km/h
        const tgt = 2.45 + rand() * 0.7;
        const len = Math.ceil(tgt * R / SEG) + 4;  // 140-180° + les rampes
        writeCorner(1 / R, len, last, tgt);
        last = -last;                              // alternance gauche/droite
        if (u0 < n - 1) writeStraight(4 + Math.floor(rand() * 8));  // 32-96 m entre épingles
      }
    }
    else writeCorner(1 / (28 + rand() * 22), z === 3 ? 11 + Math.floor(rand() * 11) : 9 + Math.floor(rand() * 9), dir(), 2.45 + rand() * 0.7);
  }
  writeStraight(RSAMP - pi);

  /* ---- géométrie : cap, plan, altitude (bruit lissé + retour doux
     à la moyenne : des collines vivantes, sans dérive sur 20 000 km) ---- */
  const hd = new Float64Array(RSAMP);
  const xs = new Float64Array(RSAMP);
  const zs = new Float64Array(RSAMP);
  hd[0] = e.hd;
  xs[0] = 0;
  zs[0] = 0;
  h[0] = e.h;
  /* n°25 : l'altitude = Hroad(position) + fastAt — l'ancien accumulateur
     de bruit d'abscisse (inc/incS, H_PULL) a été supprimé au n°26. */
  const wps = rt.wps;
  const KH = 0.12, CMAX = 0.008;   // gain de poursuite / virage max par pas (R ≈ 1 km)
  let wpIdx = e.wpIdx;
  /* la phase de plan a accumulé le wiggle PRÉVISIONNEL du chunk (bande
     dir()) ; l'intégration repart de l'état d'ENTRÉE et le re-accumule
     échantillon par échantillon — pas de double comptage */
  hdDev = e.hdDev;
  /* V4 : l'offset psi cumulé se porte dans un accumulateur SÉPARÉ —
     hdDev reste l'exact plan V3 (menus + POI d'une même graine ne
     changent D'AUCUN BIT), la correction voit le cap macro seul. */
  let hdPsi = e.hdPsi ?? 0;   // ?? 0 : robustesse
  for (let i = 0; i < RSAMP; i++) {
    /* ---- avancement du waypoint cible : 3 tests, du proche au géométrique.
       NE PAS « simplifier » en un seul test dot<0 : le test dot<0 nu
       déclenche jusqu'à 26 km AVANT les sommets serrés et fait couper le
       coin à 11 km de la polyline (mesuré) — bug historique. */
    while (wpIdx < wps.length - 1) {
      const cur = wps[wpIdx], nxt = wps[wpIdx + 1];
      const px = e.x + xs[i], py = e.y + zs[i];
      const dcx = cur.x - px, dcy = cur.y - py;
      const d2 = dcx * dcx + dcy * dcy;
      let adv = d2 < 5000 * 5000;                                   // 1. dist < 5 km
      if (!adv && wpIdx > 0 && d2 < 25000 * 25000) {                 // 2. plan du sommet franchi
        const inx = cur.x - wps[wpIdx - 1].x, iny = cur.y - wps[wpIdx - 1].y;
        if ((px - cur.x) * inx + (py - cur.y) * iny > 0) adv = true;
      }
      if (!adv && d2 < 8000 * 8000 &&
          (nxt.x - px) * dcx + (nxt.y - py) * dcy < 0) adv = true;   // 3. repli borné
      if (adv) wpIdx++; else break;
    }
    const tw = wps[wpIdx];
    const hdT = Math.atan2(tw.y - (e.y + zs[i]), tw.x - (e.x + xs[i]));
    /* DÉ-COUPLAGE : la correction voit le cap MACRO (hd - hdDev), PAS le
       cap total — le wiggle ondole librement autour de l'axe macro sans
       être écrasé par le tracker (mesuré : bruit local +40 %). */
    let corr = wpWrap(hdT - (hd[i] - hdDev - hdPsi)) * KH;
    if (corr > CMAX) corr = CMAX; else if (corr < -CMAX) corr = -CMAX;
    if (i + 1 < RSAMP) {
      /* V4 : le méandre psi est versé dans hd ET dans hdPsi — la
         correction macro ne le voit pas, il ondule librement. Pur de
         (graine, gi) : régénération d'un chunk ancien identique. */
      const dpsi = psiAt(rt, k * RSAMP + i + 1) - psiAt(rt, k * RSAMP + i);
      hd[i + 1] = hd[i] + step[i] + corr + dpsi;
      xs[i + 1] = xs[i] + Math.cos(hd[i]) * SEG;
      zs[i + 1] = zs[i] + Math.sin(hd[i]) * SEG;
      h[i + 1] = Hroad(e.x + xs[i + 1], e.y + zs[i + 1], rt.seed) + fastAt(rt, k * RSAMP + i + 1);
      hdDev += step[i];
      hdPsi += dpsi;
    } else {
      hdDev += step[i];
    }
  }

  /* ---- POI : le curseur global de chaque type avance dans le chunk ---- */
  const cursor: PoiCursor = { ...rt.poiCur[k] };
  const poiDensity = rt.poiDensity ?? 1;
  const end = s0 + RCHUNK;
  const pois: Poi[] = [];
  for (const kind of POI_KINDS) {
    let s = cursor[kind];
    while (s < end) {
      if (s >= s0) pois.push({ s: Math.floor(s / SEG) * SEG, kind });
      const fac = POI_BIOME[biomeBlendR(rt, s / SEG).a];
      s += (POI_BASE[kind] * 1000 / Math.max(0.2, poiDensity)) * fac * (0.7 + 0.6 * rand());
    }
    cursor[kind] = s;
  }
  pois.sort((a, b) => a.s - b.s);

  /* ---- état de sortie : l'entrée du chunk suivant (gardé pour toujours) ---- */
  rt.bound[k + 1] = {
    x: e.x + xs[RSAMP - 1],
    y: e.y + zs[RSAMP - 1],
    hd: hd[RSAMP - 1],
    h: h[RSAMP - 1],
    wpIdx,
    hdDev,
    hdPsi,
  };
  rt.poiCur[k + 1] = cursor;

  /* ---- PONTS et TUNNELS TOPOGRAPHIQUES (n°25) : l'écart route/terrain
     décide — gap lissé > +25 m → PONT (vraie vallée), < −25 m → TUNNEL
     (vraie crête), tous biomes, SANS PRNG. Un run PEUT être à cheval
     sur deux chunks : le gap est pur de la position. ---- */
  const terr = new Float64Array(RSAMP);
  const segType = new Float64Array(RSAMP);
  /* écart route/terrain (m) : > 0 = terrain SOUS la route (vallée → PONT),
     < 0 = terrain AU-DESSUS (crête → TUNNEL). Lissé ±6 samples pour des
     runs propres. SANS PRNG : la topographie décide, tous biomes. */
  const gap = new Float64Array(RSAMP);
  for (let i = 0; i < RSAMP; i++) gap[i] = h[i] - H(e.x + xs[i], e.y + zs[i], rt.seed);
  const gapS = new Float64Array(RSAMP);
  for (let i = 0; i < RSAMP; i++) {
    let a = 0, n = 0;
    for (let d = -6; d <= 6; d++) {
      const j = i + d;
      if (j >= 0 && j < RSAMP) { a += gap[j]; n++; }
    }
    gapS[i] = a / n;
  }
  for (let i = 0; i < RSAMP; i++) {
    terr[i] = h[i] - gap[i];   // = H exact : le serveur connaît le terrain
    segType[i] = gapS[i] > 25 ? SEG_BRIDGE : gapS[i] < -25 ? SEG_TUNNEL : SEG_GROUND;
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
    bound: [{ x: 0, y: 0, hd: 0, h: Hroad(0, 0, seed), wpIdx: 0, hdDev: 0, hdPsi: 0 }],
    wps: buildWaypoints(seed, totalKm),
    poiDensity,
    poiCur: [{ station: 25_000 / poiDensity, hotel: 80_000 / poiDensity, garage: 110_000 / poiDensity }],
    chunks: new Map(),
    order: [],
    segs: buildSchedule(seed, totalKm),
  };
  rt.bound[0].h = Hroad(0, 0, seed) + fastAt(rt, 0); // géographie + détail voiture dès le mètre 0
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
      const nxt = k + 1 < rt.nChunks ? rt.bound[k + 1].hd : c.hd[RSAMP - 1];
      return c.hd[RSAMP - 1] + (nxt - c.hd[RSAMP - 1]) * (f - i0);
    }
    return c.hd[i0] + (c.hd[i0 + 1] - c.hd[i0]) * (f - i0);
  };
  const hAt = (s: number): number => {
    const sc = clampS(rt, s);
    const k = Math.min(rt.nChunks - 1, Math.floor(sc / RCHUNK));
    const c = ensureChunk(rt, k);
    const f = (sc - c.s0) / SEG;
    const i0 = Math.min(RSAMP - 1, Math.floor(f));
    if (i0 === RSAMP - 1) {
      const nxt = k + 1 < rt.nChunks ? rt.bound[k + 1].h : c.h[RSAMP - 1];
      return c.h[RSAMP - 1] + (nxt - c.h[RSAMP - 1]) * (f - i0);
    }
    return c.h[i0] + (c.h[i0 + 1] - c.h[i0]) * (f - i0);
  };
  return {
    finishS: rt.finishS,
    cvAt: (s: number) => (hdAt(s + 4) - hdAt(s - 4)) / 8,
    muAt: (s: number) => { const { c, i } = loc(s); return c.mua[i]; },
    wAt: (s: number) => { const { c, i } = loc(s); return c.w[i]; },
    crrAt: (s: number) => { const { c, i } = loc(s); return c.crrA[i]; },
    heightAt: hAt,
    biomeAt: (s: number) => { const { c, i } = loc(s); return c.biome[i]; },
    roadPoint: (s: number) => {
      const sc = clampS(rt, s);
      const k = Math.min(rt.nChunks - 1, Math.floor(sc / RCHUNK));
      const c = ensureChunk(rt, k);
      const b = rt.bound[k];
      const f = (sc - c.s0) / SEG;
      const i0 = Math.min(RSAMP - 1, Math.floor(f));
      const t = f - i0;
      const x1 = i0 === RSAMP - 1 ? rt.bound[k + 1].x - b.x : c.xs[i0 + 1];
      const y1 = i0 === RSAMP - 1 ? rt.bound[k + 1].y - b.y : c.zs[i0 + 1];
      return {
        x: b.x + c.xs[i0] + (x1 - c.xs[i0]) * t,
        y: b.y + c.zs[i0] + (y1 - c.zs[i0]) * t,
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
