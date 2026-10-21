import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRoute, ensureChunk, RCHUNK, RSAMP } from '../core/route.ts';
import { obstCost, closedAt, LAKE_D, ss } from '../core/terrain.ts';

test('n°50 : obstCost pur de (graine, x, y)', () => {
  for (const seed of [42, 12345, 777]) {
    for (let i = 0; i < 50; i++) {
      const x = i * 977, y = i * 1319;
      assert.equal(obstCost(x, y, seed, 12, 3, 1.5), obstCost(x, y, seed, 12, 3, 1.5));
      assert.equal(obstCost(x, y, seed, 0, 0, 0), 0, 'poids nuls → coût nul');
    }
  }
});

test('n°50 : la route esquive les lacs (calibration banc)', () => {
  /* AVANT n°50 : 1,41-1,54 % des échantillons DANS un lac (graine 42,
     73 traversées/1000 km). APRÈS : ~0,18-0,21 %. Porte large (×2,5 la
     valeur mesurée) : elle verrouille le MÉCANISME, pas la virgule. */
  const rt = makeRoute(42, 300);
  let inLake = 0, n = 0, runs = 0, was = false;
  for (let k = 0; k < rt.nChunks; k++) {
    const c = ensureChunk(rt, k);
    const b = rt.bound[k];
    for (let i = 0; i < RSAMP; i += 4) {
      const lake = ss(LAKE_D, LAKE_D + 6, closedAt(b.x + c.xs[i], b.y + c.zs[i], 42));
      n++;
      if (lake > 0.5) { inLake++; if (!was) { runs++; was = true; } } else was = false;
    }
  }
  assert.ok(inLake / n < 0.006, `exposition lac ${(100 * inLake / n).toFixed(2)}% ≥ 0,6%`);
  assert.ok(runs <= 15, `${runs} traversées de lac sur 300 km`);
});
