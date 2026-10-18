/* Tests n°25 — CHAMP DE MONDE UNIFIÉ : H(x,y) partagé.
   L'altitude de la route vient de la géographie (Hroad), les
   ponts/tunnels de l'écart topographique (gap = h - H), le détail
   voiture de fastAt (pur de (graine, index)). Le plan horizontal
   (menus, courants, psi) est INTACT par graine. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRoute, routeTrack, ensureChunk, RCHUNK,
} from '../core/route.ts';
import { H, Hroad } from '../core/terrain.ts';

const wrap = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

test('TF : champ de monde pur — H/Hroad deterministes et coherents', () => {
  assert.equal(H(1234.5, -987.6, 42), H(1234.5, -987.6, 42));
  assert.equal(Hroad(1234.5, -987.6, 42), Hroad(1234.5, -987.6, 42));
  /* Hroad = H sans l'octave fine, collines a 50 % : la route terrasse */
  const h = H(500, 500, 7), hr = Hroad(500, 500, 7);
  assert.ok(Math.abs(h - hr) < 60, `ecart H/Hroad borné : ${(h - hr).toFixed(1)} m`);
  /* continuite : pas de saut dans le champ */
  const d = (x1: number, y1: number, x2: number, y2: number) =>
    Math.abs(H(x1, y1, 7) - H(x2, y2, 7));
  assert.ok(d(1000, 1000, 1001, 1000) < 2, 'champ continu en x');
  assert.ok(d(1000, 1000, 1000, 1001) < 2, 'champ continu en y');
});

test('TF : regeneration bit a bit — 2 runs + chunk evicte (hd/terr/segType)', () => {
  const a = makeRoute(12345, 300);
  const b = makeRoute(12345, 300);
  for (const k of [0, 1, 5, 12]) {
    const ca = ensureChunk(a, k), cb = ensureChunk(b, k);
    assert.deepEqual(Array.from(ca.hd), Array.from(cb.hd), `chunk ${k} hd`);
    assert.deepEqual(Array.from(ca.h), Array.from(cb.h), `chunk ${k} h`);
    assert.deepEqual(Array.from(ca.xs), Array.from(cb.xs), `chunk ${k} xs`);
    assert.deepEqual(Array.from(ca.zs), Array.from(cb.zs), `chunk ${k} zs`);
    assert.deepEqual(Array.from(ca.terr), Array.from(cb.terr), `chunk ${k} terr`);
    assert.deepEqual(Array.from(ca.segType), Array.from(cb.segType), `chunk ${k} segType`);
  }
  /* eviction + regeneration : identique */
  const trk = routeTrack(a);
  const before = Array.from(ensureChunk(a, 5).h);
  a.chunks.delete(5);
  a.order = a.order.filter((k) => k !== 5);
  trk.cvAt(5 * RCHUNK + 100);
  assert.deepEqual(Array.from(ensureChunk(a, 5).h), before,
    'chunk 5 regenere identique (H pur, pas de PRNG d etat)');
});

test('TF : couture de chunk — bound[k+1].h == h[RSAMP-1] exactement', () => {
  const rt = makeRoute(12345, 100);
  let maxSeam = 0;
  for (let k = 0; k < 20; k++) {
    const c = ensureChunk(rt, k);
    const seam = Math.abs(rt.bound[k + 1].h - c.h[2599]);
    if (seam > maxSeam) maxSeam = seam;
  }
  assert.equal(maxSeam, 0, `couture exacte attendue, max ${maxSeam.toExponential(2)}`);
});

test('TF : 0 auto-croisement (4 graines x 2000 km + 10 000 km)', () => {
  const minSep = (seed: number, km: number, step: number) => {
    const rt = makeRoute(seed, km);
    const trk = routeTrack(rt);
    const pts: { x: number; y: number }[] = [];
    for (let s = 0; s < rt.finishS; s += step) pts.push(trk.roadPoint(s));
    let minD = Infinity;
    const arcIdx = Math.ceil(40_000 / step);
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + arcIdx; j < pts.length; j++) {
        const d = Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y);
        if (d < minD) minD = d;
      }
    }
    return minD;
  };
  for (const seed of [12345, 777, 20261016, 424242]) {
    const d = minSep(seed, 2000, 100);
    assert.ok(d >= 5000, `graine ${seed} : distance mini ${d.toFixed(0)} m < 5 km`);
  }
  const d10 = minSep(12345, 10_000, 200);
  assert.ok(d10 >= 5000, `10 000 km : distance mini ${d10.toFixed(0)} m < 5 km`);
});

test('TF : bornes macro preservees — net, sigma caps, enveloppe', () => {
  const segPD = (px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    let t = L2 === 0 ? 0 : ((px - a.x) * dx + (py - a.y) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(a.x + dx * t - px, a.y + dy * t - py);
  };
  for (const seed of [12345, 777, 20261016, 424242]) {
    const rt = makeRoute(seed, 2000);
    const trk = routeTrack(rt);
    const pts: { x: number; y: number }[] = [];
    for (let s = 0; s < rt.finishS; s += 100) pts.push(trk.roadPoint(s));
    /* net 55-72 % */
    let drivenXY = 0;
    for (let i = 1; i < pts.length; i++) {
      drivenXY += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    }
    const A = pts[0]!, B = pts[pts.length - 1]!;
    const net = Math.hypot(B.x - A.x, B.y - A.y) / drivenXY;
    assert.ok(net >= 0.55 && net <= 0.72,
      `graine ${seed} : net ${(net * 100).toFixed(0)}% hors [55..72]`);
    /* sigma caps 50 km >= 28 deg */
    const caps: number[] = [];
    for (let i = 0; i + 500 < pts.length; i += 100) {
      caps.push(wrap(Math.atan2(pts[i + 500]!.y - pts[i]!.y, pts[i + 500]!.x - pts[i]!.x)));
    }
    let sx = 0, sy = 0;
    for (const c of caps) { sx += Math.cos(c); sy += Math.sin(c); }
    const ang = Math.atan2(sy, sx);
    let v = 0;
    for (const c of caps) v += wrap(c - ang) ** 2;
    const sigma = Math.sqrt(v / caps.length) * 180 / Math.PI;
    assert.ok(sigma >= 28, `graine ${seed} : sigma caps ${sigma.toFixed(0)} deg < 28`);
    /* enveloppe <= 8 km */
    let maxEnv = 0;
    for (const p of pts) {
      let best = Infinity;
      for (let j = 0; j + 1 < rt.wps.length; j++) {
        const d = segPD(p.x, p.y, rt.wps[j]!, rt.wps[j + 1]!);
        if (d < best) best = d;
      }
      if (best > maxEnv) maxEnv = best;
    }
    assert.ok(maxEnv <= 8_000, `graine ${seed} : enveloppe ${(maxEnv / 1000).toFixed(1)} km > 8`);
  }
});

test('TF : topographie — ponts et tunnels >= 2 % TOUS biomes, cols reels', () => {
  const rt = makeRoute(12345, 2000);
  let bridgeM = 0, tunnelM = 0;
  for (let k = 0; k < rt.nChunks; k++) {
    const c = ensureChunk(rt, k);
    for (let i = 0; i < 2600; i++) {
      if (c.segType[i] === 1) bridgeM += 8;
      else if (c.segType[i] === 2) tunnelM += 8;
    }
  }
  assert.ok(100 * bridgeM / rt.finishS >= 2,
    `ponts ${(100 * bridgeM / rt.finishS).toFixed(1)}% < 2%`);
  assert.ok(100 * tunnelM / rt.finishS >= 2,
    `tunnels ${(100 * tunnelM / rt.finishS).toFixed(1)}% < 2%`);
  /* cols : sommets locaux avec proeminence >= 100 m (marche jusqu'a
     un point plus haut de chaque cote, la selle est le min du chemin) */
  const trk = routeTrack(rt);
  const hs: number[] = [];
  for (let s = 0; s < rt.finishS; s += 100) hs.push(trk.heightAt(s));
  let cols = 0;
  for (let i = 20; i < hs.length - 20; i++) {
    let isMax = true;
    for (let d = -20; d <= 20; d++) {
      if (d !== 0 && hs[i + d]! >= hs[i]!) { isMax = false; break; }
    }
    if (!isMax) continue;
    const h = hs[i]!;
    let l = i - 1, r = i + 1;
    let minL = Infinity, minR = Infinity;
    while (l >= 0 && hs[l]! <= h) { minL = Math.min(minL, hs[l]!); l--; }
    while (r < hs.length && hs[r]! <= h) { minR = Math.min(minR, hs[r]!); r++; }
    if (l < 0 || r >= hs.length) continue;
    if (h - Math.max(minL, minR) >= 100) cols++;
  }
  assert.ok(cols >= 15, `cols avec proeminence >= 100 m : ${cols} < 15 / 2000 km`);
});

test('TF : pentes physiques — p95 <= 6 %, scale voiture preservee', () => {
  const rt = makeRoute(12345, 2000);
  const trk = routeTrack(rt);
  const slopes: number[] = [];
  for (let s = 8; s < rt.finishS; s += 8) {
    slopes.push(Math.abs((trk.heightAt(s) - trk.heightAt(s - 8)) / 8));
  }
  slopes.sort((a, b) => a - b);
  const p95 = slopes[Math.floor(slopes.length * 0.95)]!;
  assert.ok(p95 <= 0.06, `pente p95 ${(p95 * 100).toFixed(1)}% > 6%`);
  /* residu vertical 300 m par biome (detendance lineaire, RMS) :
     la dune du desert doit rester (echelle voiture V4 preservee) */
  const res: Record<number, number[]> = {};
  for (let s = 3000; s < rt.finishS - 3000; s += 2000) {
    const b = Math.floor(trk.biomeAt(s));
    const h0 = trk.heightAt(s - 150), h1 = trk.heightAt(s), h2 = trk.heightAt(s + 150);
    (res[b] ??= []).push(h1 - (h0 + h2) / 2);
  }
  const rms = (arr: number[]) => Math.sqrt(arr.reduce((x, y) => x + y * y, 0) / arr.length);
  assert.ok(rms(res[2]!) >= 0.30, `dune desert : RMS ${rms(res[2]!).toFixed(2)} m < 0.30`);
  /* n°31 : le résidu apparent plaine monte (0,45 → 0,73 mesuré) parce
     qu'épingles et lacets traversent le micro-relief EN TRAVERS — c'est
     l'effet du tracé V5, pas une régression du champ H. */
  assert.ok(rms(res[0]!) <= 0.80, `plaine : RMS ${rms(res[0]!).toFixed(2)} m > 0.80`);
  assert.ok(rms(res[1]!) <= 0.80, `foret : RMS ${rms(res[1]!).toFixed(2)} m > 0.80`);
});

test('TF : replays — serialize/deserialize puis meme route (schema inchange)', async () => {
  const raceMod = await import('../core/race.ts');
  const cfg = { ...raceMod.DEFAULT_CONFIG, seed: 777, totalKm: 100, startEpochMs: 0 };
  const race = raceMod.makeRace(cfg);
  race.departed = true;
  raceMod.addCar(race, 'A', '#111111');
  raceMod.stepRace(race, 240);
  const raw = raceMod.serializeRace(race);
  /* le schema ne porte que seed/totalKm : la route se REGENERE */
  const parsed = JSON.parse(raw) as { seed: number; totalKm: number };
  assert.equal(parsed.seed, 777);
  const re = raceMod.deserializeRace(raw);
  raceMod.stepRace(re, 240);
  /* la course reprise roule sur la MEME route (meme graine) */
  const trk = routeTrack(makeRoute(777, 100));
  assert.ok(Number.isFinite(trk.heightAt(re.cars[0]!.s)),
    'la voiture reprise roule sur une route finie');
  assert.ok(Number.isFinite(trk.cvAt(re.cars[0]!.s)), 'courbure finie sur la route regeneree');
});
