/* Tests n°26/n°33 — la copie NAVIGATEUR du champ de monde (web/terrain.js)
   doit être IDENTIQUE au cœur (core/terrain.ts) au bit près — y compris
   les champs climatiques n°33 (tempAt, moistAt, coastAt, famAt, HroadC)
   que le rendu lit pour palettes, mer, rivières et végétation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  H as Hc, Hroad as Hrc, Hmacro as Hmc, HroadC as Hrcc,
  coastAt as cac, tempAt as tac, moistAt as mac, famAt as fac,
  ss as ssc, SEA_SL, windAt as wac, flowAccum as facc,
} from '../core/terrain.ts';
import {
  H as Hw, Hroad as Hrw, Hmacro as Hmw, HroadC as Hrcw,
  coastAt as caw, tempAt as taw, moistAt as maw, famAt as faw,
  ss as ssw, SEA_SL as SLw, windAt as waw, flowAccum as facw,
} from '../web/terrain.js';

test('26/33 : champs navigateur identiques au cœur (bit à bit)', () => {
  assert.equal(SLw, SEA_SL, 'SEA_SL');
  const wc = wac(12345), ww = waw(12345);
  assert.equal(ww.wx, wc.wx, 'windAt wx');
  assert.equal(ww.wy, wc.wy, 'windAt wy');
  /* LCG déterministe — pas de Math.random, même règle que le cœur */
  let s = 0x2f6e2b1;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return ((s >>> 8) & 0xffff) / 0x10000;
  };
  let n = 0;
  const check = (x: number, y: number, seed: number) => {
    assert.equal(Hw(x, y, seed), Hc(x, y, seed), `H(${x}, ${y}, ${seed})`);
    assert.equal(Hrw(x, y, seed), Hrc(x, y, seed), `Hroad(${x}, ${y}, ${seed})`);
    assert.equal(Hmw(x, y, seed), Hmc(x, y, seed), `Hmacro(${x}, ${y}, ${seed})`);
    assert.equal(Hrcw(x, y, seed), Hrcc(x, y, seed), `HroadC(${x}, ${y}, ${seed})`);
    assert.equal(caw(x, y, seed), cac(x, y, seed), `coastAt(${x}, ${y}, ${seed})`);
    assert.equal(taw(x, y, seed), tac(x, y, seed), `tempAt(${x}, ${y}, ${seed})`);
    assert.equal(maw(x, y, seed), mac(x, y, seed), `moistAt(${x}, ${y}, ${seed})`);
    assert.equal(faw(x, y, seed), fac(x, y, seed), `famAt(${x}, ${y}, ${seed})`);
    assert.equal(ssw(-100, 300, x), ssc(-100, 300, x), `ss(${x})`);
    n++;
  };
  /* le long de tracés réalistes (abscisse curviligne + méandre) */
  for (let gi = 0; gi < 3000; gi++) {
    const ang = gi * 0.37;
    check(gi * 8 * Math.cos(ang), gi * 8 * Math.sin(ang), 12345);
  }
  /* grille grossière ±20 km */
  for (let x = -20000; x <= 20000; x += 777)
    for (let y = -20000; y <= 20000; y += 777)
      check(x, y, 42);
  /* points pseudo-aléatoires, graines variées */
  for (let i = 0; i < 2000; i++)
    check((rnd() - 0.5) * 60000, (rnd() - 0.5) * 60000, Math.floor(rnd() * 1e9));
  assert.ok(n > 5000, `${n} points vérifiés`);
});

test('33 : flowAccum navigateur identique au cœur (bit à bit)', () => {
  /* grille 64×64 de H sur une fenêtre 10 km autour d'un rivage */
  const seed = 424242, cx = 150000, cy = -80000, N = 64, cell = 160;
  const grid = new Float64Array(N * N);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++)
      grid[j * N + i] = Hc(cx + i * cell, cy + j * cell, seed);
  const ac = facc(grid, N, N);
  const aw = facw(grid, N, N);
  assert.deepEqual(Array.from(aw), Array.from(ac), 'flowAccum identique');
  /* l'eau se rassemble : sur une fenêtre 10 km il existe des cellules
     qui portent l'écoulement de dizaines d'amonts (les rivières du
     rendu). NB : l'exutoire de la FENÊTRE n'est pas garanti — l'eau
     peut sortir par un bord (le vrai exutoire est la mer, hors
     fenêtre) ; on vérifie donc le MAX d'accumulation, pas le min. */
  let maxAcc = 0;
  for (let i = 0; i < N * N; i++) if (ac[i]! > maxAcc) maxAcc = ac[i]!;
  assert.ok(maxAcc > 20, `des cellules canalisent l'écoulement (max acc ${maxAcc})`);
});
