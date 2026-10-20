/* Tests de la route linéaire — Phase 1.
   L'itinéraire départ→arrivée est généré à la demande, chunk par
   chunk ; ces tests verrouillent les trois garanties du design :
   déterminisme au bit près (replays, reprise serveur), continuité
   parfaite aux frontières de chunks (la voiture ne doit rien sentir),
   et génération à la demande sur des dizaines de milliers de km. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRoute, routeTrack, ensureChunk, buildChunk,
  RCHUNK, RSAMP, MAX_CACHED, type Route,
} from '../core/route.ts';
import { SEG } from '../core/engine.ts';
import { famAt } from '../core/terrain.ts';   // n°33 : familles gameplay (tests par PLAN)

/* espacement minimal plausible entre deux POI (800 m) */
const SEG_MIN_DIST = 800;

/* grappillage générique : quelques sondes d'un chunk, pour comparer */
function probe(rt: Route, k: number): number[] {
  const c = ensureChunk(rt, k);
  const out: number[] = [];
  for (const i of [0, 1, 37, 500, 1299, RSAMP - 2, RSAMP - 1]) {
    out.push(c.hd[i], c.h[i], c.w[i], c.mua[i], c.xs[i], c.zs[i]);
  }
  for (const p of c.pois) out.push(p.s, p.kind.length);
  return out;
}

test('route : déterminisme chunk par chunk, même après éviction', () => {
  const a = makeRoute(2024, 1000);
  const b = makeRoute(2024, 1000);
  for (const k of [0, 1, 2, 5, 12, 30]) {
    assert.deepEqual(probe(a, k), probe(b, k), `chunk ${k} doit être identique`);
  }
  /* éviction puis régénération : le chunk revient À L'IDENTIQUE
     (garantie reprise serveur / replay) */
  const trk = routeTrack(a);
  const before = probe(a, 3);
  a.chunks.delete(3);
  a.order = a.order.filter((k) => k !== 3);
  trk.cvAt(3 * RCHUNK + 100); // force la reconstruction des chunks intermédiaires
  assert.deepEqual(probe(a, 3), before, 'le chunk régénéré doit être identique');
});

test('route : continuité aux frontières de chunks (cap, plan, altitude, grip)', () => {
  const rt = makeRoute(77, 200);
  const trk = routeTrack(rt);
  for (const k of [0, 1, 2, 4, 7]) {
    const s = k * RCHUNK;
    /* le cap et l'altitude sont CONTINUS au raccord */
    assert.ok(Math.abs(trk.cvAt(s + 0.01) - trk.cvAt(s - 0.01)) < 0.02,
      `saut de courbure à la frontière du chunk ${k}`);
    assert.ok(Math.abs(trk.heightAt(s + 0.01) - trk.heightAt(s - 0.01)) < 0.01,
      `saut d altitude à la frontière du chunk ${k}`);
    assert.ok(Math.abs(trk.wAt(s + 0.01) - trk.wAt(s - 0.01)) < 0.01,
      `saut de largeur à la frontière du chunk ${k}`);
    assert.ok(Math.abs(trk.muAt(s + 0.01) - trk.muAt(s - 0.01)) < 0.05,
      `saut de grip à la frontière du chunk ${k}`);
    /* le plan XY aussi (pour la carte 2D) */
    const p1 = trk.roadPoint(s - 0.01);
    const p2 = trk.roadPoint(s + 0.01);
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    assert.ok(dist < 1.0, `saut de position (${dist} m) à la frontière du chunk ${k}`);
  }
});

test('route : génération à la demande + fenêtre mémoire respectée', () => {
  const rt = makeRoute(4242, 5000); // 5 000 km — une vraie étape-raid
  const trk = routeTrack(rt);
  const sFar = 2_345_678; // ~2 345 km : 113 chunks plus loin
  const h = trk.heightAt(sFar);
  const cv = trk.cvAt(sFar);
  assert.ok(Number.isFinite(h) && Number.isFinite(cv), 'sondes lointaines finies');
  assert.ok(rt.chunks.size <= MAX_CACHED + 2, 'la fenêtre mémoire ne doit pas exploser');
  /* la fin de course est propre : pas de NaN au-delà de l arrivée */
  assert.ok(Number.isFinite(trk.cvAt(rt.finishS + 500)), 'au-delà de l arrivée : sondes finies');
  /* un retour en arrière (voiture arrêtée, carte) relit des chunks évictés */
  assert.ok(Number.isFinite(trk.heightAt(8_000)), 'relecture arrière finie');
});

test('route : POI déterministes, triés, densité par biome', () => {
  const a = routeTrack(makeRoute(99, 600));
  const b = routeTrack(makeRoute(99, 600));
  const pa = a.poisAhead(0, 600_000);
  const pb = b.poisAhead(0, 600_000);
  assert.deepEqual(pa, pb, 'les POI doivent être déterministes');
  assert.ok(pa.length > 10, 'il doit y avoir des POI sur 600 km');
  for (let i = 1; i < pa.length; i++) {
    assert.ok(pa[i].s >= pa[i - 1].s, 'POI triés par abscisse');
  }
  const count = (kind: string) => pa.filter((p) => p.kind === kind).length;
  assert.ok(count('station') > count('hotel'), 'plus de stations que d hôtels');
  assert.ok(count('hotel') > count('garage'), 'plus d hôtels que de garages');
  /* tous les types sont représentés dans les 600 premiers km */
  for (const kind of ['station', 'hotel', 'garage']) {
    assert.ok(count(kind) >= 1, `${kind} présent`);
  }
  /* pas deux POI DU MÊME TYPE trop proches (des types différents peuvent
     se regrouper — un bourg avec station ET hôtel, c'est un village-étape) */
  for (const kind of ['station', 'hotel', 'garage']) {
    const of = pa.filter((p) => p.kind === kind);
    for (let i = 1; i < of.length; i++) {
      assert.ok(of[i].s - of[i - 1].s >= SEG_MIN_DIST, `POI ${kind} espacés`);
    }
  }
});

/* espacement minimal plausible entre deux POI (800 m) */

/* ============================================================
   V3 — WAYPOINTS MACRO + BRUIT LOCAL (n°21)
   L'ossature macro (waypoints purs de seed+totalKm, garde
   anti-croisement) et la couche locale (courants, sinuosité de
   portion) : le tracé a de la variété macro ET du bruit visible.
   ============================================================ */
import { buildWaypoints, type Waypoint } from '../core/route.ts';

const wrap = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

function trackPts(rt: Route, step = 100) {
  const trk = routeTrack(rt);
  const pts: { x: number; y: number }[] = [];
  for (let s = 0; s < rt.finishS; s += step) {
    const p = trk.roadPoint(s);
    pts.push({ x: p.x, y: p.y });
  }
  return pts;
}

/* distance mini entre échantillons séparés d'au moins 40 km d'arc */
function minSepDist(pts: { x: number; y: number }[], arcIdx: number): number {
  let minD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + arcIdx; j < pts.length; j++) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      if (d < minD) minD = d;
    }
  }
  return minD;
}

test('route V3 : waypoints macro purs de (seed, totalKm) + anti-croisement', () => {
  for (const seed of [12345, 777, 20261016, 424242]) {
    const a = buildWaypoints(seed, 2000);
    const b = buildWaypoints(seed, 2000);
    assert.deepEqual(a, b, `waypoints ${seed} déterministes`);
    /* anti-croisement de l'ossature : sommets jamais à moins de 10 km */
    let minD = Infinity;
    for (let i = 0; i < a.length; i++) {
      for (let j = i + 2; j < a.length; j++) {
        const d = Math.hypot(a[i]!.x - a[j]!.x, a[i]!.y - a[j]!.y);
        if (d < minD) minD = d;
      }
    }
    assert.ok(minD >= 10_000, `waypoints ${seed} : sommets écartés ≥ 10 km (${(minD / 1000).toFixed(1)} km)`);
  }
});

test('route V3 : anti-croisement du tracé (40 km d arc, 4 graines + 10 000 km)', () => {
  for (const seed of [12345, 777, 20261016, 424242]) {
    const rt = makeRoute(seed, 2000);
    const pts = trackPts(rt, 100);      // 100 m : 40 km d'arc = 400 échantillons
    const minD = minSepDist(pts, 401);
    assert.ok(minD >= 10_000, `tracé ${seed} : distance mini ${minD} m < 10 km`);
  }
  const rt = makeRoute(12345, 10_000);
  const pts = trackPts(rt, 200);        // 200 m : 40 km d'arc = 200 échantillons
  const minD = minSepDist(pts, 201);
  assert.ok(minD >= 10_000, `tracé 10 000 km : distance mini ${minD} m < 10 km`);
});

test('route V3 : variété macro — caps fenêtrés 50 km et avancement net', () => {
  for (const seed of [12345, 777, 20261016, 424242]) {
    const rt = makeRoute(seed, 2000);
    const pts = trackPts(rt, 100);
    const caps: number[] = [];
    for (let i = 0; i + 500 < pts.length; i += 100) {
      const a = pts[i]!, b = pts[i + 500]!;
      caps.push(wrap(Math.atan2(b.y - a.y, b.x - a.x)));
    }
    /* moyenne circulaire puis écart-type / plage autour d'elle */
    let sx = 0, sy = 0;
    for (const c of caps) { sx += Math.cos(c); sy += Math.sin(c); }
    const ang = Math.atan2(sy, sx);
    let v = 0, lo = Infinity, hi = -Infinity;
    for (const c of caps) {
      const dd = wrap(c - ang) * 180 / Math.PI;
      v += dd * dd;
      if (dd < lo) lo = dd;
      if (dd > hi) hi = dd;
    }
    const sigma = Math.sqrt(v / caps.length);
    /* n°33 : le pure pursuit (polyline au lieu du waypoint seul) redresse
       la route — σ mesuré 25,5-32,4° (4 graines, 2000 km) : 24 garde la
       variété macro. L'ancien tracker versait un décalage latéral
       d'équilibre (jusqu'à 21 km hors polyline, enveloppe VIOLÉE). */
    assert.ok(sigma >= 24, `graine ${seed} : σ caps ${sigma.toFixed(0)}° < 24°`);
    assert.ok(lo <= -60 || hi >= 60, `graine ${seed} : plage [${lo.toFixed(0)}..${hi.toFixed(0)}] < ±60°`);
    const A = pts[0]!, B = pts[pts.length - 1]!;
    /* avancement net = corde A→B / distance XY réellement parcourue
       (le wiggle détend la corde : V1 mesuré 74-80 %, cible V3 55-70 %) —
       n°33 : 69,8-73,1 % mesuré → borne haute 75 % */
    let drivenXY = 0;
    for (let i = 1; i < pts.length; i++) {
      drivenXY += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    }
    const net = Math.hypot(B.x - A.x, B.y - A.y) / drivenXY;
    assert.ok(net >= 0.55 && net <= 0.75,
      `graine ${seed} : avancement net ${(net * 100).toFixed(0)}% hors [55..75]`);
  }
});

test('route V3 : enveloppe chemin vs polyline waypoints ≤ 9 km', () => {
  const segPD = (px: number, py: number, a: Waypoint, b: Waypoint) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    let t = L2 === 0 ? 0 : ((px - a.x) * dx + (py - a.y) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(a.x + dx * t - px, a.y + dy * t - py);
  };
  const envelope = (seed: number, km: number) => {
    const rt = makeRoute(seed, km);
    const pts = trackPts(rt, 500);
    let maxEnv = 0;
    for (const p of pts) {
      let best = Infinity;
      for (let j = 0; j + 1 < rt.wps.length; j++) {
        const d = segPD(p.x, p.y, rt.wps[j]!, rt.wps[j + 1]!);
        if (d < best) best = d;
      }
      if (best > maxEnv) maxEnv = best;
    }
    return maxEnv;
  };
  for (const seed of [12345, 777]) {
    const e = envelope(seed, 2000);
    assert.ok(e <= 9_000, `graine ${seed} : enveloppe ${(e / 1000).toFixed(1)} km > 9 km`);
  }
  const e10 = envelope(12345, 10_000);
  assert.ok(e10 <= 9_000, `10 000 km : enveloppe ${(e10 / 1000).toFixed(1)} km > 9 km`);
});

test('route V3 : bruit local — résidu corde 4 km σ ≥ 200 m', () => {
  for (const seed of [12345, 777]) {
    const rt = makeRoute(seed, 2000);
    const trk = routeTrack(rt);
    /* résidu : écart latéral du point à la corde [s-2km, s+2km],
       pour des cordes ≥ 2,5 km */
    const devs: number[] = [];
    for (let s = 2500; s < rt.finishS - 2500; s += 4000) {
      const p0 = trk.roadPoint(s - 2000), p1 = trk.roadPoint(s + 2000), pm = trk.roadPoint(s);
      const chord = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      if (chord < 2500) continue;
      const dx = p1.x - p0.x, dy = p1.y - p0.y;
      const L2 = dx * dx + dy * dy;
      let t = ((pm.x - p0.x) * dx + (pm.y - p0.y) * dy) / L2;
      t = Math.max(0, Math.min(1, t));
      devs.push(Math.hypot(p0.x + dx * t - pm.x, p0.y + dy * t - pm.y));
    }
    const mean = devs.reduce((x, y) => x + y, 0) / devs.length;
    const sd = Math.sqrt(devs.reduce((x, y) => x + (y - mean) ** 2, 0) / devs.length);
    assert.ok(sd >= 200, `graine ${seed} : σ résidu corde ${sd.toFixed(0)} m < 200 m`);
  }
});

test('route V3 : contraste portions 8 km — p90/p10 du σ local ≥ 2', () => {
  const rt = makeRoute(12345, 2000);
  const trk = routeTrack(rt);
  const sigmaAt = (s0: number, len: number) => {
    /* écart-type des déviations latérales sur une portion, par rapport
       à la corde locale (approximation du bruit de la portion) */
    const pts: { x: number; y: number }[] = [];
    for (let s = s0; s < s0 + len; s += 100) {
      const p = trk.roadPoint(s);
      pts.push({ x: p.x, y: p.y });
    }
    const a = pts[0]!, b = pts[pts.length - 1]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    let acc = 0, n = 0;
    for (const p of pts) {
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
      t = Math.max(0, Math.min(1, t));
      acc += Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y);
      n++;
    }
    return acc / n;   // déviation latérale moyenne de la portion
  };
  const locals: number[] = [];
  for (let s = 4000; s < rt.finishS - 8000; s += 8000) locals.push(sigmaAt(s, 8000));
  locals.sort((x, y) => x - y);
  const p10 = locals[Math.floor(locals.length * 0.1)]!;
  const p90 = locals[Math.floor(locals.length * 0.9)]!;
  assert.ok(p90 / p10 >= 2, `contraste portions p90/p10 = ${(p90 / p10).toFixed(2)} < 2 (${p10.toFixed(0)} → ${p90.toFixed(0)} m)`);
});

test('route V3 : volant — rotation cap dé-tendancée ≥ 140°/km', () => {
  for (const seed of [12345, 777]) {
    const rt = makeRoute(seed, 2000);
    const trk = routeTrack(rt);
    /* série dé-tendancée = cap SANS la correction macro (le wiggle
       seul) : on retire la composante lisse (poursuite du waypoint) par
       moyenne circulaire glissante sur ±1 km — reste le bruit local,
       dont la rotation doit être ≥ 140°/km */
    const raw: number[] = [];
    for (let s = 0; s < 200_000; s += 8) raw.push(trk.roadPoint(s).hd);
    const N = 125;   // ±1 km à 8 m
    let rot = 0;
    for (let i = N; i < raw.length - N; i++) {
      let sx = 0, sy = 0;
      for (let j = i - N; j <= i + N; j++) { sx += Math.cos(raw[j]!); sy += Math.sin(raw[j]!); }
      const sm = Math.atan2(sy, sx);
      rot += Math.abs(wrap(raw[i]! - sm));
    }
    const perKm = rot / ((raw.length - 2 * N) * 8 / 1000) * 180 / Math.PI;
    assert.ok(perKm >= 140, `graine ${seed} : volant dé-tendancé ${perKm.toFixed(0)}°/km < 140`);
  }
});

/* ============================================================
   V4 — ONDULATION DE PLATE-FORME (n°23)
   L'échelle de la voiture : le méandre continu ψ (pur de la
   graine, découplé du plan V3 via hdPsi) + l'octave verticale
   rapide. Les menus/courants/waypoints/POI d'une même graine ne
   changent d'aucun bit par rapport à la V3.
   ============================================================ */
test('route V4 : ψ découplé — POI et régénération identiques (ADR 0004)', () => {
  /* deux makeRoute même graine → chunks identiques au bit près */
  const a = makeRoute(12345, 1000);
  const b = makeRoute(12345, 1000);
  for (const k of [0, 1, 5, 20, 40]) {
    const ca = ensureChunk(a, k), cb = ensureChunk(b, k);
    assert.deepEqual(Array.from(ca.hd), Array.from(cb.hd), `chunk ${k} hd`);
    assert.deepEqual(Array.from(ca.xs), Array.from(cb.xs), `chunk ${k} xs`);
    assert.deepEqual(Array.from(ca.zs), Array.from(cb.zs), `chunk ${k} zs`);
    assert.deepEqual(Array.from(ca.h), Array.from(cb.h), `chunk ${k} h`);
  }
  /* construire 45 chunks puis redemander le 5e après éviction */
  const trk = routeTrack(a);
  const before = Array.from(ensureChunk(a, 5).hd);
  a.chunks.delete(5);
  a.order = a.order.filter((k) => k !== 5);
  trk.cvAt(5 * RCHUNK + 100);
  assert.deepEqual(Array.from(ensureChunk(a, 5).hd), before,
    'le chunk 5 régénéré doit être identique (ψ pur, pas de PRNG)');
  /* n°31 : V5 — le flux PRNG des menus a changé (épingles, lacets,
     rayons plaine/désert). n°33 : le monde émergent change le flux à
     nouveau (familles causales, POI_FAM) : les POI sont régénérés
     (positions mesurées, graine 12345, 600 km — 15 POI : la route
     traverse désormais des zones désertiques clairsemées, densité
     causale). C'est une NOUVELLE version de route : re-set des
     courses en cours (arbitrage assumé). */
  const pa = routeTrack(makeRoute(12345, 600)).poisAhead(0, 600_000);
  assert.equal(pa.length, 15, 'POI V5 (graine 12345, 600 km)');
  assert.deepEqual(pa.slice(0, 3).map((p) => `${p.s}:${p.kind}`),
    ['25000:station', '46184:station', '80000:hotel'], 'positions POI V5');
});

test('route V5 : échelle voiture — retournements, mort-droit < 5 %', () => {
  /* n°31 : V5 — plaine/désert relâchés à ≥ 6/km (mesuré V5.4 : plaine 6,8,
     désert 7,4) : droites plaine raccourcies + grand plaine resserré =
     moins de flips par km, mais le volant vit plus (ce sont les épingles
     qui comptent désormais). Forêt/altitude gardent ≥ 8 (11,6 / 10,3). */
  /* n°33 : FAMILLES gameplay (6, terrain.ts famAt, par LABEL = terrain
     réellement traversé) — mesuré 4 graines 2500 km : F0 7,5-8,7 ·
     F1 6,5-8,7 · F2 10,2-11,0 · F3 8,4-10,9 · F4 8,5-10,5 · F5 8,8-10,4.
     Une famille peu présente (< 100 km : la course ne traverse pas cette
     tranche de climat, émergence assumée) n'est pas testée sur cette graine. */
  const MIN_REV: Record<number, number> = { 0: 6, 1: 6, 2: 8, 3: 6, 4: 6, 5: 6 };
  const wrapL = (a: number) => {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  };
  for (const seed of [12345, 777, 20261016]) {
    const rt = makeRoute(seed, 2500);
    const trk = routeTrack(rt);
    const stats: Record<number, { rev: number; km: number; dead: number; n: number }> = {};
    let acc = 0, prevHd = trk.roadPoint(0).hd, prevSgn = 0;
    for (let s = 16; s < rt.finishS; s += 16) {
      const b = Math.floor(trk.biomeAt(s));
      const st = stats[b] ??= { rev: 0, km: 0, dead: 0, n: 0 };
      st.km += 0.016; st.n++;
      if (Math.abs(trk.cvAt(s)) < 2e-5) st.dead++;
      const hd = trk.roadPoint(s).hd;
      const d = wrapL(hd - prevHd);
      prevHd = hd;
      const sgn = d > 0 ? 1 : d < 0 ? -1 : 0;
      acc += Math.abs(d);
      if (sgn !== 0 && prevSgn !== 0 && sgn !== prevSgn && acc > 0.5 * Math.PI / 180) {
        st.rev++; acc = 0;
      }
      if (sgn !== 0) prevSgn = sgn;
    }
    for (const [b, st] of Object.entries(stats)) {
      if (st.km <= 100) continue;   // n°33 : tranche de climat non traversée
      assert.ok(st.rev / st.km >= MIN_REV[Number(b)] ?? 8,
        `graine ${seed} famille ${b} : ${(st.rev / st.km).toFixed(1)} retournements/km < ${MIN_REV[Number(b)] ?? 8}`);
      assert.ok(st.dead / st.n < 0.05,
        `graine ${seed} biome ${b} : mort-droit ${(100 * st.dead / st.n).toFixed(1)}% ≥ 5%`);
    }
  }
});

test('route V4 : gardes macro intactes + volant borné', () => {
  const segPD = (px: number, py: number, a: Waypoint, b: Waypoint) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    let t = L2 === 0 ? 0 : ((px - a.x) * dx + (py - a.y) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(a.x + dx * t - px, a.y + dy * t - py);
  };
  for (const seed of [12345, 777]) {
    const rt = makeRoute(seed, 2000);
    const trk = routeTrack(rt);
    const pts: { x: number; y: number }[] = [];
    for (let s = 0; s < rt.finishS; s += 100) pts.push(trk.roadPoint(s));
    /* 0 auto-croisement (≥ 40 km d'arc, ≥ 30 m) */
    let minD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 401; j < pts.length; j++) {
        const d = Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y);
        if (d < minD) minD = d;
      }
    }
    assert.ok(minD >= 30, `graine ${seed} : distance mini ${minD.toFixed(0)} m`);
    /* enveloppe vs polyline waypoints ≤ 9 km */
    let maxEnv = 0;
    for (const p of pts) {
      let best = Infinity;
      for (let j = 0; j + 1 < rt.wps.length; j++) {
        const d = segPD(p.x, p.y, rt.wps[j]!, rt.wps[j + 1]!);
        if (d < best) best = d;
      }
      if (best > maxEnv) maxEnv = best;
    }
    assert.ok(maxEnv <= 9_000, `graine ${seed} : enveloppe ${(maxEnv / 1000).toFixed(1)} km`);
    /* volant total ≤ 245°/km — n°33 : menus F2 forêt/F3 taïga resserrés (mesuré 183-236, 4 graines) */
    let rot = 0, prev = trk.roadPoint(0).hd;
    for (let s = 8; s < 300_000; s += 8) {
      const hd = trk.roadPoint(s).hd;
      rot += Math.abs(wrap(hd - prev));
      prev = hd;
    }
    const perKm = rot / 300 * 180 / Math.PI;
    assert.ok(perKm <= 245, `graine ${seed} : volant total ${perKm.toFixed(0)}°/km > 245`);
  }
});

test('route V5 : épingles par biome — ≥150° rares sauf altitude, borne ≤ 181°', () => {
  /* n°31 : détecteur — un cœur d'épingle a une courbure qu'aucun autre
     item n'atteint : |Δhd| par sample > 0,104 rad (R < 77 m ; les 's'
     altitude R 90-160 plafonnent à 0,089). La déflexion du cœur est
     intégrée sur le run ; corr de poursuite + ψ s'annulent au cœur du
     virage. Attendus (graine 12345, 1000 km) : plaine ~0,6, forêt ~1,3,
     altitude ~150 (lacets), désert 0 par 100 km — le désert reste le
     royaume de la pointe. Garde-fou : la borne uBound doit tenir —
     déflexion max d'un cœur ≤ 181° (les lacets sont des ENFILADES
     d'items bornés : la somme d'une enfilade dépasse 360° sans
     qu'aucun item ne dépasse 180,5°). */
  const CORE = 0.104;              // rad/sample : signature d'épingle
  const EPINGLE = 150 * Math.PI / 180;
  const rt = makeRoute(12345, 1000);
  const perFam: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const kmPer: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let maxDefl = 0;
  const nChunks = Math.ceil(rt.finishS / RCHUNK);
  for (let k = 0; k < nChunks; k++) {
    const c = ensureChunk(rt, k);
    /* n°33 : comptage PAR PLAN (famille à l'entrée du chunk, zf = le menu
       réellement tiré) — le comptage par label mélange les épingles
       d'altitude débordant sur les terrains voisins des frontières
       naturelles (11 ép/100 km labellisées désert alors que le menu
       désert en produit 0-1,9). */
    const zf = famAt(rt.bound[k]!.x, rt.bound[k]!.y, rt.seed);
    kmPer[zf] = (kmPer[zf] ?? 0) + RSAMP * SEG / 1000;
    let i = 1;
    while (i < RSAMP) {
      if (Math.abs(c.hd[i]! - c.hd[i - 1]!) > CORE) {
        let j = i, sum = 0;
        while (j < RSAMP && Math.abs(c.hd[j]! - c.hd[j - 1]!) > CORE) {
          sum += c.hd[j]! - c.hd[j - 1]!;
          j++;
        }
        const defl = Math.abs(sum);
        if (defl >= EPINGLE) perFam[zf] = (perFam[zf] ?? 0) + 1;
        if (defl > maxDefl) maxDefl = defl;
        i = j;
      } else {
        i++;
      }
    }
  }
  const per100km = (b: number) => 100 * (perFam[b] ?? 0) / (kmPer[b] || 1);
  /* n°33 : mesuré (graine 12345, 1000 km, 4 graines en banc) :
     F0 0-0,7 · F1 0-1,9 · F2 0,6-1,9 · F3 0-1,5 · F5 0 — rares hors
     altitude ; F4 (lacets) 138-164. */
  assert.ok(per100km(0) <= 2,
    `plaine : ${per100km(0).toFixed(1)} épingles/100 km (rares attendues)`);
  assert.ok(per100km(1) <= 3,
    `désert : ${per100km(1).toFixed(1)} épingles/100 km (pointe préservée)`);
  assert.ok(per100km(2) <= 4 && per100km(3) <= 4,
    `forêt/taïga : ${per100km(2).toFixed(1)}/${per100km(3).toFixed(1)} épingles/100 km (rares)`);
  assert.ok(per100km(5) <= 1,
    `littoral : ${per100km(5).toFixed(1)} épingles/100 km (coulé attendu)`);
  assert.ok(per100km(4) >= 100,
    `altitude : ${per100km(4).toFixed(1)} épingles/100 km (lacets attendus ~150)`);
  assert.ok(maxDefl <= 181 * Math.PI / 180,
    `déflexion max d'un cœur ${(maxDefl * 180 / Math.PI).toFixed(1)}° > 181° (borne uBound)`);
});

test('route V4 : le ψ ne bride pas — cv p95 dans l ordre de grandeur V3', () => {
  /* le méandre ψ est un offset de cap borné (lat·(2π/L) par composante) :
     il ne peut pas créer d'épingles. Vérifié EMPIRIQUEMENT : le cv p95
     par biome (graine 777, 2500 km) reste dans le même ordre de grandeur
     que la V3 (références mesurées sur le code V3 poussé) — la forêt
     prend +16 % (ses 'petit' dominaient déjà), les autres ≤ +5 %. */
  /* n°31 : V5 — références mesurées sur V5.4 (graine 777, 2500 km) :
     épingles 140-180° en plaine/forêt, lacets en altitude, courants
     resserrés plaine/désert. Tolérance ±25 % comme avant. */
  /* n°33 : références PAR PLAN (famille du chunk = menu réellement tiré),
     mesurées sur le banc (graine 777) : F0 0,00812 · F1 0,00787 ·
     F2 0,00971 · F3 0,00934 · F4 0,03449 (lacets — l'ordre de grandeur
     du V3 altitude 0,03371 est conservé) · F5 0,00574. Tolérance ±25 %
     comme avant : le ψ ne bride pas, il reste dans l'ordre de grandeur. */
  const REF: Record<number, number> = { 0: 0.00812, 1: 0.00787, 2: 0.00971, 3: 0.00934, 4: 0.03449, 5: 0.00574 };
  const rt = makeRoute(777, 2500);
  const trk = routeTrack(rt);
  const stats: Record<number, number[]> = {};
  for (let s = 16; s < rt.finishS; s += 16) {
    const k = Math.floor(s / RCHUNK);
    const zf = famAt(rt.bound[k]!.x, rt.bound[k]!.y, rt.seed);
    (stats[zf] ??= []).push(Math.abs(trk.cvAt(s)));
  }
  for (const [b, arr] of Object.entries(stats)) {
    const sorted = arr.slice().sort((x, y) => x - y);
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    const ref = REF[Number(b)]!;
    assert.ok(p95 <= ref * 1.25,
      `famille ${b} : cv p95 ${p95.toFixed(5)} > ref ${ref.toFixed(5)} × 1.25`);
    assert.ok(p95 >= ref * 0.75,
      `famille ${b} : cv p95 ${p95.toFixed(5)} < ref ${ref.toFixed(5)} × 0.75`);
  }
});
