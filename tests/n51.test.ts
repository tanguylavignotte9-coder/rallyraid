/* Tests n°51 — MONDE CRÉDIBLE P2 : villages d'abord (rocades), gués,
   forêt macro, POI diégétiques. Refs mesurées au banc bench-n51
   (drivers measure51.mjs, graines 42/12345/777) :
   - traversées de bourg (< 300 m du centre) : 0.41 km (g42, 600 km),
     0 (g12345, 600 km) — baseline n°50 : 8.5 km ;
   - médiane d'approche route↔bourg : 747 / 731 m (rocades visibles) ;
   - POI diégétiques : 50 % des POI à < 800 m d'un bourg (g12345,
     600 km ; baseline n°50 : 3 %, médiane 8.6 km) ;
   - gué : exposition thalweg 3.0 % (g42, 300 km), médiane des runs
     160 m — franchir, jamais longer ;
   - forêt macro : 14.95 % (g42, 600 km ; baseline n°50 : 21.2 %) ;
   - champ de villages : 360 bourgs + 116 fermes sur 10 000 cellules
     (g42) — le champ vit sans la route. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRoute, ensureChunk, RCHUNK, RSAMP } from '../core/route.ts';
import { SEG } from '../core/engine.ts';
import {
  villageCell, villageNear, riverAt, forestAt, VILL_CELL, type Vill,
} from '../core/terrain.ts';

/* bourgs (kind='village') des cellules couvrant le couloir du chunk
   (+ 2 200 m de marge, comme le banc) — memo partagé entre chunks */
function chunkVillages(
  b: { x: number; y: number }, c: { xs: ArrayLike<number>; zs: ArrayLike<number> },
  seed: number, memo: Map<number, Vill | null>,
): Array<[number, Vill]> {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < RSAMP; i += 12) {
    const px = b.x + c.xs[i]!, py = b.y + c.zs[i]!;
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
  }
  const x0 = Math.floor((minX - 2200) / VILL_CELL), x1 = Math.floor((maxX + 2200) / VILL_CELL);
  const y0 = Math.floor((minY - 2200) / VILL_CELL), y1 = Math.floor((maxY + 2200) / VILL_CELL);
  const out: Array<[number, Vill]> = [];
  for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) {
    const key = ix * 67108864 + iy;
    let v = memo.get(key);
    if (v === undefined) { v = villageCell(ix, iy, seed); memo.set(key, v); }
    if (v && v.kind === 'village') out.push([key, v]);
  }
  return out;
}

test('51 : champ de villages pur — déterminisme + densité', () => {
  /* PUR de (graine, x, y) : deux appels identiques, zéro PRNG */
  for (const [ix, iy, seed] of [[37, 41, 42], [-12, 205, 12345], [7, -7, 777]] as const) {
    const a = villageCell(ix, iy, seed);
    const b = villageCell(ix, iy, seed);
    assert.equal(JSON.stringify(b), JSON.stringify(a),
      `villageCell déterministe (${ix}, ${iy}, ${seed})`);
  }
  /* densité : 10 000 cellules (196 km de côté) graine 42 → mesuré
     360 bourgs + 116 fermes ; le champ vit SANS la route */
  let nv = 0, nf = 0;
  let first: Vill | null = null;
  for (let ix = 0; ix < 100; ix++) for (let iy = 0; iy < 100; iy++) {
    const v = villageCell(ix, iy, 42);
    if (!v) continue;
    if (v.kind === 'village') { nv++; if (!first) first = v; } else nf++;
  }
  assert.ok(nv >= 200, `${nv} bourgs sur 10 000 cellules (≥ 200, mesuré 360)`);
  assert.ok(nf >= 30, `${nf} fermes (≥ 30, mesuré 116)`);
  /* villageNear lit le MÊME champ : distance nulle au centre du bourg */
  assert.ok(first, 'au moins un bourg dans la zone scannée');
  if (first)
    assert.ok(villageNear(first.x, first.y, 42, new Map()) < 1,
      'villageNear(v.x, v.y) < 1 m au centre du bourg');
});

test('51 : rocades — la route évite les bourgs (600 km, graines 42 + 12345)', () => {
  /* VILLAGES D'ABORD : la répulsion (wVill 35, villKeep 300, villR 700)
     garde les traversées de bourg marginales — résiduel = laisse macro
     (3 bourgs serrés g42), comme les lacs résiduels n°50 */
  for (const seed of [42, 12345]) {
    const rt = makeRoute(seed, 600);
    const nChunks = Math.ceil(rt.finishS / RCHUNK);
    const memo = new Map<number, Vill | null>();
    let cross = 0, expN = 0;
    const seen = new Map<number, number>(); // cellule → approche min
    for (let k = 0; k < nChunks; k++) {
      const c = ensureChunk(rt, k);
      const b = rt.bound[k]!;
      const vills = chunkVillages(b, c, seed, memo);
      for (let i = 0; i < RSAMP; i += 4) {
        const px = b.x + c.xs[i]!, py = b.y + c.zs[i]!;
        expN++;
        let dv = Infinity, dvK = 0;
        for (const [key, v] of vills) {
          const d = Math.hypot(v.x - px, v.y - py);
          if (d < dv) { dv = d; dvK = key; }
        }
        if (dv < 300) cross++;
        if (dv < 1500) {
          const prev = seen.get(dvK);
          if (prev === undefined || dv < prev) seen.set(dvK, dv);
        }
      }
    }
    const km = rt.finishS / 1000;
    const crossKm = cross / expN * km;
    assert.ok(crossKm <= 1.5,
      `graine ${seed} : ${crossKm.toFixed(2)} km à < 300 m d'un centre de bourg (≤ 1.5, mesuré 0.41 / 0 ; baseline n°50 : 8.5)`);
    /* les bourgs du couloir sont APPROCHÉS (rocades visibles) mais pas
       traversés : médiane d'approche ~730 m */
    const appr = Array.from(seen.values()).sort((a, b) => a - b);
    assert.ok(appr.length >= 40,
      `graine ${seed} : ${appr.length} bourgs approchés < 1500 m (≥ 40, mesuré 63 / 50)`);
    const med = appr[Math.floor(appr.length / 2)]!;
    assert.ok(med <= 1200,
      `graine ${seed} : médiane d'approche ${med.toFixed(0)} m (≤ 1200, mesuré 747 / 731)`);
  }
});

test('51 : POI diégétiques — les POI vivent près des bourgs (12345, 600 km)', () => {
  /* causalité inversée : le POI se snappe au point d'approche maximale
     route↔bourg (entrée de rocade) quand un bourg est à < 2200 m */
  const seed = 12345;
  const rt = makeRoute(seed, 600);
  const nChunks = Math.ceil(rt.finishS / RCHUNK);
  const memo = new Map<number, Vill | null>();
  let poiN = 0, snap = 0;
  for (let k = 0; k < nChunks; k++) {
    const c = ensureChunk(rt, k);
    const b = rt.bound[k]!;
    const vills = chunkVillages(b, c, seed, memo);
    for (const p of c.pois) {
      const i = Math.floor((p.s - c.s0) / SEG);
      if (i < 0 || i >= RSAMP) continue;
      const px = b.x + c.xs[i]!, py = b.y + c.zs[i]!;
      let dv = Infinity;
      for (const [, v] of vills)
        dv = Math.min(dv, Math.hypot(v.x - px, v.y - py));
      poiN++;
      if (dv < 800) snap++;
    }
  }
  const pct = 100 * snap / Math.max(1, poiN);
  assert.ok(pct >= 25,
    `${pct.toFixed(0)} % des POI à < 800 m d'un bourg (≥ 25 %, mesuré 50 % ; baseline n°50 : 3 %, médiane 2754 m)`);
});

test('51 : gués — traversées de thalweg courtes et rares (42, 300 km)', () => {
  /* le coût wRiv paie le TEMPS DANS LE THALWEG : longer coûte cher,
     franchir 1-2 échantillons → traversées courtes et perpendiculaires */
  const seed = 42;
  const rt = makeRoute(seed, 300);
  const nChunks = Math.ceil(rt.finishS / RCHUNK);
  let expN = 0, inRiv = 0, rivRuns = 0, runLen = 0;
  const lens: number[] = [];
  for (let k = 0; k < nChunks; k++) {
    const c = ensureChunk(rt, k);
    const b = rt.bound[k]!;
    for (let i = 0; i < RSAMP; i += 4) {
      const px = b.x + c.xs[i]!, py = b.y + c.zs[i]!;
      expN++;
      if (riverAt(px, py, seed) > 0.5) {
        inRiv++; runLen++;
      } else if (runLen > 0) {
        lens.push(runLen * 4 * SEG);
        runLen = 0;
      }
    }
  }
  if (runLen > 0) lens.push(runLen * 4 * SEG);
  rivRuns = lens.length;
  const pct = 100 * inRiv / expN;
  assert.ok(pct <= 4,
    `exposition thalweg ${pct.toFixed(2)} % (≤ 4 %, mesuré 3.02)`);
  assert.ok(rivRuns >= 10,
    `${rivRuns} traversées de rivière (≥ 10 — la route traverse bien des vallées, mesuré 48)`);
  lens.sort((a, b) => a - b);
  const med = lens[Math.floor(lens.length / 2)] ?? 0;
  assert.ok(med <= 400,
    `médiane des traversées ${med.toFixed(0)} m (≤ 400, mesuré 160 — des gués, pas des longages)`);
});

test('51 : forêt macro — les jambes de waypoints skirtent les massifs (42, 600 km)', () => {
  /* wForMac 100 aux sondes des jambes de waypoints : les massifs
     climatiques (140-480 km) se contourent sur plusieurs jambes */
  const seed = 42;
  const rt = makeRoute(seed, 600);
  const nChunks = Math.ceil(rt.finishS / RCHUNK);
  let expN = 0, nFor = 0;
  for (let k = 0; k < nChunks; k++) {
    const c = ensureChunk(rt, k);
    const b = rt.bound[k]!;
    for (let i = 0; i < RSAMP; i += 4) {
      const px = b.x + c.xs[i]!, py = b.y + c.zs[i]!;
      expN++;
      if (forestAt(px, py, seed) > 0.5) nFor++;
    }
  }
  const pct = 100 * nFor / expN;
  assert.ok(pct <= 17,
    `exposition forêt ${pct.toFixed(2)} % (≤ 17, mesuré 14.95 ; baseline n°50 même distance : 21.2)`);
});
