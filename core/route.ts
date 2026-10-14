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
   L'altitude dérive par bruit lissé avec un léger retour à la
   moyenne : des collines crédibles sur 20 000 km sans dérive folle.

   Points d'intérêt (station, hôtel, garage) : posés par un CURSEUR
   GLOBAL par type — continuité parfaite aux frontières de chunks,
   densité par biome (la plaine est riche, le désert est vide),
   espacements tirés du PRNG du chunk. C'est l'ossature des arrêts
   de la vision : pas de files, services à la carte. */

import { mulberry32, makeNoise, SEG, BIOMES, type Track } from './engine.ts';

export const RSAMP = 2600;            // échantillons par chunk
export const RCHUNK = SEG * RSAMP;    // 20 800 m — un chunk
export const BLEND = 250;             // fondu de biome : 2 km
export const MAX_CACHED = 32;         // fenêtre de chunks en mémoire (~666 km)

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
export type Bound = { x: number; y: number; hd: number; h: number };
export type PoiCursor = Record<PoiKind, number>; // prochain POI pend. par type

export type Route = {
  seed: number;
  poiDensity: number;
  totalKm: number;
  finishS: number;           // abscisse d'arrivée (m)
  nChunks: number;
  bound: Bound[];            // bound[k] = état d'entrée du chunk k
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
/* amplitude du relief (× le gradient de bruit) : le désert VALLONNE,
   l'altitude grimpe vers les cols */
export const BIOME_RELIEF = [1.0, 1.2, 2.2, 2.6];
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
  const s0 = k * RCHUNK;

  /* ---- paramètres de biome par échantillon (fondu 2 km) ---- */
  const w = new Float64Array(RSAMP);
  const h = new Float64Array(RSAMP);
  const mua = new Float64Array(RSAMP);
  const crrA = new Float64Array(RSAMP);
  const biome = new Float64Array(RSAMP);
  const grad = new Float64Array(RSAMP);
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
    grad[i] = lerp(A.grad, B.grad);
  }

  /* ---- plan de virages : LES MENUS DU PROTO, biome par biome.
     Identique à buildRoad : droites longues au désert, chicanes en
     forêt, épingles en altitude ; entrées/sorties par rampes de
     clothoïde ; le cap se contrebalance dans le chunk (l'itinéraire
     chemine sans spiraler sur 20 000 km). ---- */
  let pi = 0;
  let hdPlan = 0;
  const step = new Float64Array(RSAMP);
  const dir = () => (hdPlan > 0.5 ? -1 : hdPlan < -0.5 ? 1 : rand() < 0.5 ? -1 : 1);
  const writeCorner = (cvT: number, len: number, sgn: number) => {
    const ramp = 4;
    for (let q = 0; q < len && pi < RSAMP; q++, pi++) {
      const u = Math.min(1, (q + 1) / ramp, (len - q) / ramp);
      step[pi] = sgn * cvT * SEG * u;
      hdPlan += step[pi];
    }
  };
  const writeStraight = (len: number) => {
    for (let q = 0; q < len && pi < RSAMP; q++, pi++) step[pi] = 0;
  };
  while (pi < RSAMP - 30) {
    const zone = biomeBlendR(rt, k * RSAMP + Math.min(pi, RSAMP - 1)).a;
    const u = rand();
    let kind: string;
    /* MENUS par biome — le CARACTÈRE du tracé (design 2026-10-14) :
       plaine : fluide (grands courants, peu d'épingles) ;
       forêt : serré et « aveugle » — davantage de PETITS que de grands ;
       désert : LONGUES DROITES (jusqu'à ~0,5 km) ;
       altitude : lacets — épingles et S en grande courbure dominants. */
    if (zone === 0) kind = u < 0.42 ? 'droite' : u < 0.86 ? 'grand' : 's';
    else if (zone === 1) kind = u < 0.10 ? 'droite' : u < 0.62 ? 'petit' : u < 0.88 ? 's' : 'epingle';
    else if (zone === 2) kind = u < 0.55 ? 'droite' : u < 0.92 ? 'grand' : 'petit';
    else kind = u < 0.06 ? 'droite' : u < 0.30 ? 'petit' : u < 0.70 ? 's' : 'epingle';
    if (kind === 'droite') {
      /* désert : la dune creuse la pointe — droites de 208 à 496 m */
      writeStraight(zone === 2 ? 26 + Math.floor(rand() * 36) : 10 + Math.floor(rand() * 20));
    } else if (kind === 'grand') {
      writeCorner(1 / (280 + rand() * 280), 12 + Math.floor(rand() * 18), dir());
    } else if (kind === 'petit') {
      /* forêt : serré ; altitude : pierre — même courbure, plus vif */
      writeCorner(1 / (zone === 1 ? 110 + rand() * 90 : 140 + rand() * 130), 8 + Math.floor(rand() * 12), dir());
    } else if (kind === 's') {
      const cvS = 1 / (zone === 3 ? 90 + rand() * 70 : 150 + rand() * 130);
      const lS = 7 + Math.floor(rand() * 8);
      const sgn = dir();
      writeCorner(cvS, lS, sgn);
      writeCorner(cvS, lS, -sgn);
    } else {
      /* LACETS d'altitude : épingle franche (R 30-60 m), plus longue en
         altitude pour dessiner le lacet du col */
      writeCorner(1 / (30 + rand() * 30), zone === 3 ? 8 + Math.floor(rand() * 10) : 6 + Math.floor(rand() * 8), dir());
    }
  }
  writeStraight(RSAMP - pi);
  /* refermer le CAP sur le chunk : le contrebalancement garde le résidu
     petit, la détendance l'annule sans déformer des virages entiers */
  let hdAcc = 0;
  for (let i = 0; i < RSAMP; i++) hdAcc += step[i];
  const hdCorr = -hdAcc / RSAMP;
  for (let i = 0; i < RSAMP; i++) step[i] += hdCorr;

  /* ---- géométrie : cap, plan, altitude (bruit lissé + retour doux
     à la moyenne : des collines vivantes, sans dérive sur 20 000 km) ---- */
  const hd = new Float64Array(RSAMP);
  const xs = new Float64Array(RSAMP);
  const zs = new Float64Array(RSAMP);
  hd[0] = e.hd;
  xs[0] = 0;
  zs[0] = 0;
  h[0] = e.h;
  const inc = new Float64Array(RSAMP);
  const H_PULL = 2e-6; // retour à la moyenne : σ stationnaire ≈ 150 m
  /* le RELIEF suit le biome : le désert VALLONNE (la dune creuse la
     pointe en pleine ligne droite), l'altitude grimpe vers les cols.
     L'amplitude (BIOME_RELIEF) module le gradient fondu par échantillon. */
  const relief = new Float64Array(RSAMP);
  for (let i = 0; i < RSAMP; i++) {
    const bz = biomeBlendR(rt, k * RSAMP + i);
    relief[i] = bz.a + (bz.b - bz.a) * bz.t;
  }
  for (let i = 0; i < RSAMP; i++) {
    const rA = BIOME_RELIEF[Math.floor(relief[i])] ?? 1;
    inc[i] = grad[i] * rA * noise2(i * 0.02) * SEG;
  }
  const incS = new Float64Array(RSAMP);
  const KI = 4;
  for (let i = 0; i < RSAMP; i++) {
    let a3 = 0;
    let n = 0;
    for (let d = -KI; d <= KI; d++) {
      const j = i + d;
      if (j >= 0 && j < RSAMP) { a3 += inc[j]; n++; }
    }
    incS[i] = a3 / n;
  }
  for (let i = 0; i < RSAMP; i++) {
    if (i + 1 < RSAMP) {
      hd[i + 1] = hd[i] + step[i];
      xs[i + 1] = xs[i] + Math.cos(hd[i]) * SEG;
      zs[i + 1] = zs[i] + Math.sin(hd[i]) * SEG;
      h[i + 1] = h[i] + incS[i] - h[i] * H_PULL;
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
  };
  rt.poiCur[k + 1] = cursor;

  /* ---- PONTS et TUNNELS (altitude) : données du tracé par sample.
     En zone d'altitude, quand le tracé plonge (ravin) il passe sur un
     PONT — le terrain s'en écarte vers le bas ; quand il traverse une
     crête, un TUNNEL — le terrain monte au-dessus. Déterministe
     (PRNG du chunk), continu aux frontières (les segments sont
     intérieurs au chunk, jamais à cheval). ---- */
  const terr = new Float64Array(RSAMP);
  const segType = new Float64Array(RSAMP);
  for (let i = 0; i < RSAMP; i++) {
    const bz = biomeBlendR(rt, k * RSAMP + i);
    if (bz.a !== 3 && bz.b !== 3) { terr[i] = h[i]; segType[i] = SEG_GROUND; continue; }
    const slope = i > 0 ? (h[i] - h[i - 1]) / SEG : 0;
    /* tirage STABLE par (chunk, sample) — jamais un PRNG partagé qui
       dépendrait de l'ordre d'appel (déterminisme à la régénération) */
    const r = mulberry32(((rt.seed ^ 0x62726964) | 0) + Math.imul(k * RSAMP + i + 1, 2246822519) | 0)();
    /* pont sur les ravins (forte descente), tunnel sous les crêtes
       (forte montée) — seuils bas : ces passages sont FRÉQUENTS en
       altitude, c'est le caractère du biome (design 2026-10-14) */
    const isBridge = slope < -0.025 && r > 0.90;
    const isTunnel = slope > 0.02 && r > 0.90;
    if (isBridge) {
      segType[i] = SEG_BRIDGE;
      terr[i] = h[i] - 35 - (i % 12); // ravin visible sous l'arche
    } else if (isTunnel) {
      segType[i] = SEG_TUNNEL;
      terr[i] = h[i] + 40 + (i % 10); // roche au-dessus de la voûte
    } else {
      segType[i] = SEG_GROUND;
      terr[i] = h[i];
    }
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
    bound: [{ x: 0, y: 0, hd: 0, h: 0 }],
    poiDensity,
    poiCur: [{ station: 25_000 / poiDensity, hotel: 80_000 / poiDensity, garage: 110_000 / poiDensity }],
    chunks: new Map(),
    order: [],
    segs: buildSchedule(seed, totalKm),
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
