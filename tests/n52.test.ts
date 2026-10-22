/* Tests n°52 — PARCELLAIRE AGRICOLE (monde crédible P3) : le damier
   oriente la route en plaine cultivée. Refs mesurées au banc bench-n52
   (drivers measure52, graines 42/12345/777, 600 km) :
   - couverture damier (parAt > 0.5) : 20.7 % (g42) / 23.6 % (g12345) /
     19.1 % (g777) de la route ;
   - alignement au damier (|sin 2Δcap| < 0.5) : 86.2 % des échantillons
     damier vs 34.8 % hors damier (g12345, tronçon 166-250 km ; base
     aléatoire ~33 % — deux fois mieux, la route SUIT les rangées) ;
   - droites du damier : médiane 2304/2432/2304 m, max 18816/20224/
     23488 m (3 graines) ; meilleure droite alignée mesurée 5280 m sur
     un seul tronçon de 83 km (g12345) ;
   - calibration : wPar 12 (banc : 6 ne marquait pas assez, 25 cassait
     les gates de variété), PAR_ZONE 12000 m (le damier tourne d'une
     zone à l'autre), PAR_KEEP 1400 m (relâché près des bourgs — la
     rocade n'est pas un damier) ;
   - POI g12345 600 km : 17, les 3 premiers 22312/53984/81280:station
     (refs route.test.ts n°52). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRoute, ensureChunk, RCHUNK, RSAMP } from '../core/route.ts';
import { SEG } from '../core/engine.ts';
import {
  parAngle, parAt, PAR_ZONE, PAR_KEEP, famAt, moistAt, VILL_CELL,
} from '../core/terrain.ts';

test('52 : parcellaire pur — déterminisme, zones, plaine cultivée', () => {
  /* PUR de (graine, x, y) : deux appels identiques, zéro PRNG (ADR 0004) */
  for (const [x, y, seed] of [[12034, -8712, 42], [-45021, 998, 12345], [77000, 77000, 777]] as const) {
    assert.equal(parAngle(x, y, seed), parAngle(x, y, seed), 'parAngle déterministe');
    assert.equal(parAt(x, y, seed), parAt(x, y, seed), 'parAt déterministe');
  }
  /* calibration du banc n° 52, verrouillée */
  assert.equal(PAR_ZONE, 12000, 'PAR_ZONE = 12 km');
  assert.equal(PAR_KEEP, 1400, 'PAR_KEEP = 1 400 m (> villR 700 : la rocade n\'est pas un damier)');
  assert.ok(PAR_KEEP >= VILL_CELL, 'PAR_KEEP relâche le damier sur toute une cellule de bourg');
  /* l'axe est CONSTANT dans une zone et VARIE d'une zone à l'autre */
  const angles = new Set<number>();
  for (let zx = -3; zx <= 3; zx++) for (let zy = -3; zy <= 3; zy++) {
    const a = parAngle(zx * PAR_ZONE + 100, zy * PAR_ZONE + 100, 42);
    assert.ok(a >= 0 && a < Math.PI / 2, `parAngle ∈ [0, π/2[ (${a})`);
    assert.equal(parAngle(zx * PAR_ZONE + 11900, zy * PAR_ZONE + 9500, 42), a,
      'parAngle constant dans toute la zone');
    angles.add(a);
  }
  assert.ok(angles.size >= 20, `${angles.size} axes distincts sur 49 zones (≥ 20 — le damier tourne)`);
  /* parAt vit dans la PLAINE cultivée sur la fenêtre d'humidité :
     > 0 ⇒ famille Plaine ; > 0.9 ⇒ humidité ∈ [0.40, 0.70] */
  let nIn = 0;
  for (let i = 0; i < 4000; i++) {
    const x = (i * 173) % 40000 - 20000 + (i % 7) * 53;
    const y = (i * 311) % 40000 - 20000 + (i % 11) * 97;
    const p = parAt(x, y, 12345);
    assert.ok(p >= 0 && p <= 1, 'parAt ∈ [0, 1]');
    if (p > 0) {
      assert.equal(famAt(x, y, 12345), 0, 'parAt > 0 ⇒ famille Plaine');
      nIn++;
    }
    if (p > 0.9) {
      const m = moistAt(x, y, 12345);
      assert.ok(m >= 0.40 && m <= 0.70, `parAt > 0.9 ⇒ humidité cultivable (${m})`);
    }
  }
  assert.ok(nIn > 200, `${nIn} points de damier sur la grille (≥ 200 — le champ vit sans la route)`);
});

test('52 : le damier porte la route — couverture par graine (600 km × 3 graines)', () => {
  /* la plaine cultivée couvre ~19-24 % de la route (banc bench-n52) ;
     le couloir traverse plusieurs zones PAR_ZONE (le damier tourne le
     long de la course) */
  for (const seed of [42, 12345, 777]) {
    const rt = makeRoute(seed, 600);
    const nChunks = Math.ceil(rt.finishS / RCHUNK);
    let expN = 0, parN = 0;
    const zones = new Set<string>();
    for (let k = 0; k < nChunks; k++) {
      const c = ensureChunk(rt, k);
      const b = rt.bound[k]!;
      for (let i = 0; i < RSAMP; i += 4) {
        const px = b.x + c.xs[i]!, py = b.y + c.zs[i]!;
        expN++;
        if (parAt(px, py, seed) > 0.5) parN++;
        zones.add(`${Math.floor(px / PAR_ZONE)},${Math.floor(py / PAR_ZONE)}`);
      }
    }
    const pct = 100 * parN / expN;
    assert.ok(pct >= 12 && pct <= 32,
      `graine ${seed} : damier ${pct.toFixed(1)} % de la route (attendu 12-32, mesuré banc 20.7 / 23.6 / 19.1)`);
    assert.ok(zones.size >= 5,
      `graine ${seed} : ${zones.size} zones PAR_ZONE traversées (≥ 5)`);
  }
});

test('52 : la route suit les rangées — alignement au damier (12345, 600 km)', () => {
  /* en damier, le contrôleur paie le cap HORS-AXE (wPar 12) : la part
     des échantillons alignés (|sin 2Δcap| < 0.5, base aléatoire ~33 %)
     doit être NETTEMENT supérieure dedans que dehors, avec de longues
     droites alignées — mesuré g12345 : 86.2 % dedans vs 34.8 % dehors,
     meilleure droite 5280 m (banc : médiane 2432 m, max 20224 m) */
  const seed = 12345;
  const rt = makeRoute(seed, 600);
  const nChunks = Math.ceil(rt.finishS / RCHUNK);
  let alIn = 0, nIn = 0, alOut = 0, nOut = 0;
  let run = 0, bestRun = 0, runN = 0;
  for (let k = 0; k < nChunks; k++) {
    const c = ensureChunk(rt, k);
    const b = rt.bound[k]!;
    for (let i = 0; i + 4 < RSAMP; i += 4) {
      const px = b.x + c.xs[i]!, py = b.y + c.zs[i]!;
      const qx = b.x + c.xs[i + 4]!, qy = b.y + c.zs[i + 4]!;
      const hd = Math.atan2(qy - py, qx - px);
      const pa = parAngle(px, py, seed);
      const s2 = Math.abs(Math.sin(2 * (hd - pa)));
      if (parAt(px, py, seed) > 0.5) {
        nIn++;
        if (s2 < 0.5) alIn++;
        if (s2 < 0.25) { run++; if (run > bestRun) bestRun = run; }
        else { if (run >= 5) runN++; run = 0; }
      } else {
        nOut++;
        if (s2 < 0.5) alOut++;
        if (run >= 5) runN++;
        run = 0;
      }
    }
  }
  if (run >= 5) runN++;
  const inPct = 100 * alIn / Math.max(1, nIn);
  const outPct = 100 * alOut / Math.max(1, nOut);
  assert.ok(inPct >= 55,
    `alignement damier ${inPct.toFixed(1)} % (≥ 55, mesuré 86.2 sur tronçon dense ; base aléatoire ~33)`);
  assert.ok(inPct - outPct >= 20,
    `contraste damier/hors-damier ${(inPct - outPct).toFixed(1)} points (≥ 20, mesuré 51.4)`);
  assert.ok(bestRun * 4 * SEG >= 800,
    `meilleure droite alignée ${bestRun * 4 * SEG} m (≥ 800, mesuré 5280 sur 83 km)`);
  assert.ok(runN >= 5,
    `${runN} droites alignées ≥ 5 échantillons ~160 m (≥ 5, mesuré 17 sur 83 km)`);
});
