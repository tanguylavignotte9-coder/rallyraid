/* ============================================================
   CHAMP DE MONDE — copie NAVIGATEUR de core/terrain.ts (n°26).
   Le navigateur ne strip pas le TypeScript : cette copie JS pure
   donne H/Hroad au rendu. Identique au cœur AU BIT PRÈS — garanti
   par tests/terrain-web.test.ts. SI core/terrain.ts CHANGE, cette
   copie change EN MÊME TEMPS (le test CI échoue sinon).
   ============================================================ */

const O1 = { lam: 32000, amp: 550, so: 101 };  // relief macro (massifs, bassins)
const O2 = { lam: 8000,  amp: 160, so: 202 };  // moyennes collines
const O3 = { lam: 2000,  amp: 45,  so: 303 };  // collines locales
const O4 = { lam: 520,   amp: 22,  so: 404 };  // fin : ravins, creux de rivières

function ghash(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 974634733);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;   // [0, 1)
}
function sm(t) { return t * t * (3 - 2 * t); }
function vnoise(x, y, seed, so) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = sm(x - ix), fy = sm(y - iy);
  const a = ghash(ix, iy, seed + so);
  const b = ghash(ix + 1, iy, seed + so);
  const c = ghash(ix, iy + 1, seed + so);
  const d = ghash(ix + 1, iy + 1, seed + so);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;  // [0, 1)
}
const oct = (o, x, y, seed, k = 1) =>
  k * o.amp * (vnoise(x / o.lam, y / o.lam, seed, o.so) * 2 - 1);

/* terrain environnant (m) */
export function H(x, y, seed) {
  return oct(O1, x, y, seed) + oct(O2, x, y, seed) + oct(O3, x, y, seed) + oct(O4, x, y, seed);
}
/* plateforme routière (m) — cf. core/terrain.ts. n°32 : O3 à 80 %,
   À L'IDENTIQUE du cœur (test CI d'égalité bit à bit). */
export function Hroad(x, y, seed) {
  return oct(O1, x, y, seed) + oct(O2, x, y, seed) + oct(O3, x, y, seed, 0.8);
}
