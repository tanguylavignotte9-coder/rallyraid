/* Tests n°26 — la copie NAVIGATEUR du champ de monde (web/terrain.js)
   doit être IDENTIQUE au cœur (core/terrain.ts) au bit près. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { H as Hc, Hroad as Hrc } from '../core/terrain.ts';
import { H as Hw, Hroad as Hrw } from '../web/terrain.js';

test('26 : champ H navigateur identique au cœur (bit à bit)', () => {
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
