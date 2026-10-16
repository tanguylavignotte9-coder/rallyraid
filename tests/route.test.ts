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
    assert.ok(sigma >= 30, `graine ${seed} : σ caps ${sigma.toFixed(0)}° < 30°`);
    assert.ok(lo <= -60 || hi >= 60, `graine ${seed} : plage [${lo.toFixed(0)}..${hi.toFixed(0)}] < ±60°`);
    const A = pts[0]!, B = pts[pts.length - 1]!;
    /* avancement net = corde A→B / distance XY réellement parcourue
       (le wiggle détend la corde : V1 mesuré 74-80 %, cible V3 55-70 %) */
    let drivenXY = 0;
    for (let i = 1; i < pts.length; i++) {
      drivenXY += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    }
    const net = Math.hypot(B.x - A.x, B.y - A.y) / drivenXY;
    assert.ok(net >= 0.55 && net <= 0.72,
      `graine ${seed} : avancement net ${(net * 100).toFixed(0)}% hors [55..72]`);
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
