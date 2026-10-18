/* ============================================================
   CHAMP DE MONDE — fonction PURE de (graine, x, y), ADR 0004.
   Partagé par la route (altitude, ponts/tunnels) et, plus tard,
   par le rendu 3D (relief, villages, eau). Aucun PRNG d'état :
   hash de grille → value-noise bilinéaire, 4 octaves.
   ============================================================ */

const O1 = { lam: 32000, amp: 550, so: 101 };  // relief macro (massifs, bassins)
const O2 = { lam: 8000,  amp: 160, so: 202 };  // moyennes collines
const O3 = { lam: 2000,  amp: 45,  so: 303 };  // collines locales
const O4 = { lam: 520,   amp: 22,  so: 404 };  // fin : ravins, creux de rivières

function ghash(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 974634733);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;   // [0, 1)
}
function sm(t: number): number { return t * t * (3 - 2 * t); }
function vnoise(x: number, y: number, seed: number, so: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = sm(x - ix), fy = sm(y - iy);
  const a = ghash(ix, iy, seed + so);
  const b = ghash(ix + 1, iy, seed + so);
  const c = ghash(ix, iy + 1, seed + so);
  const d = ghash(ix + 1, iy + 1, seed + so);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;  // [0, 1)
}
const oct = (o: { lam: number; amp: number; so: number }, x: number, y: number, seed: number, k = 1) =>
  k * o.amp * (vnoise(x / o.lam, y / o.lam, seed, o.so) * 2 - 1);

/* terrain environnant (m) */
export function H(x: number, y: number, seed: number): number {
  return oct(O1, x, y, seed) + oct(O2, x, y, seed) + oct(O3, x, y, seed) + oct(O4, x, y, seed);
}
/* plateforme routière (m), n°32 : la route suit les collines O3 à
   80 % (au lieu de 50 %) — l'écart route/terrain passait 15 m sur
   27 % des km (estrades noires) ; il passe > 15 m sur 14,5 % et
   > 20 m sur 3,7 % (mesuré, 3 graines × 1000 km). Seuls les vrais
   ravins/creux (O4, retiré) gardent un grand écart = ponts/tunnels.
   L'octave fine O4 reste retirée. Fonction PURE — le tracé
   horizontal est bit à bit inchangé. */
export function Hroad(x: number, y: number, seed: number): number {
  return oct(O1, x, y, seed) + oct(O2, x, y, seed) + oct(O3, x, y, seed, 0.8);
}
