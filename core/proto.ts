/* ============================================================
   PROTOTYPE raid-3d (boucle fermée 20,8 km + rivale 4 états) —
   retiré du cœur au n°29 ; conservé comme référence jouable du duel
   à la corde, testé par tests/core.test.ts. Le cœur de course
   n'importe JAMAIS ce module.
   ============================================================ */
import {
  mulberry32, makeNoise, SEG, BIOMES,
  driveStep, lateralStep, cosmeticsStep,
  speedTarget, raceLineTarget, draftMul, FLAT, G,
  CAR_L, CAR_D, DT,
} from './engine.ts';
import type { KinCar, Track } from './engine.ts';

/* ============ Route procédurale (même générateur que raid-3d) ============ */

const NSAMP = 2600;   // (SEG vient d'engine.ts — la boucle fait 20,8 km)
const ROAD_W = 7.5;
export const L_METERS = SEG * NSAMP;

export type Road = {
  xs: Float64Array;
  zs: Float64Array;
  hd: Float64Array;
  cv: Float64Array;
  w: Float64Array;
  h: Float64Array;
  mua: Float64Array;
  crrA: Float64Array;
  paved: Float64Array;
  biome: Float64Array;
  lapOff: { x: number; y: number };
};

/* 0 plaine · 1 forêt · 2 désert (piste de terre) · 3 altitude (étroit, pentes) */
export const ZONES = [675, 1300, 1925, 2600];

export function biomeBlend(i: number): { a: number; b: number; t: number } {
  const BLEND = 24;
  let a = 3;
  for (let k = 0; k < ZONES.length; k++) {
    if (i < ZONES[k]) {
      a = k;
      break;
    }
  }
  const d = ZONES[a] - i;
  if (d >= BLEND) return { a, b: a, t: 0 };
  return { a, b: (a + 1) % 4, t: 1 - d / BLEND };
}

export function buildRoad(seed: number): Road {
  const rand = mulberry32(seed);
  const noise = makeNoise(rand);
  const noise2 = makeNoise(rand);
  const xs = new Float64Array(NSAMP);
  const zs = new Float64Array(NSAMP);
  const hd = new Float64Array(NSAMP);
  const cv = new Float64Array(NSAMP);
  const w = new Float64Array(NSAMP);
  const h = new Float64Array(NSAMP);
  const mua = new Float64Array(NSAMP);
  const crrA = new Float64Array(NSAMP);
  const paved = new Float64Array(NSAMP);
  const biome = new Float64Array(NSAMP);
  const step = new Float64Array(NSAMP);
  const grad = new Float64Array(NSAMP);
  for (let i = 0; i < NSAMP; i++) {
    const bz = biomeBlend(i);
    const A = BIOMES[bz.a];
    const B = BIOMES[bz.b];
    const t = bz.t;
    const lerp = (p: number, q: number) => p + (q - p) * t;
    biome[i] = bz.a + bz.t;
    w[i] = lerp(A.w, B.w);
    mua[i] = lerp(A.mu, B.mu);
    crrA[i] = lerp(A.crr, B.crr);
    paved[i] = lerp(A.paved, B.paved);
    grad[i] = lerp(A.grad, B.grad);
  }
  /* ---- plan de virages : de la VRAIE diversité au lieu d'un bruit uniforme.
     Chaque biome a son menu — plaine : lignes droites et grands courants ;
     forêt : petits virages, chicanes en S, une épingle de temps en temps ;
     désert : longues lignes droites et virages rapides ; altitude : épingles,
     S enchaînés et courtes droites. Chaque virage entre/sort par une rampe
     (clothoïde approchée), et son sens contrebalance le cap courant pour
     que la boucle se referme proprement. */
  let pi = 0;
  let hdPlan = 0;
  const dir = () => (hdPlan > 0.5 ? -1 : hdPlan < -0.5 ? 1 : rand() < 0.5 ? -1 : 1);
  const writeCorner = (cvT: number, len: number, sgn: number) => {
    const ramp = 4;
    for (let k = 0; k < len && pi < NSAMP; k++, pi++) {
      const q = Math.min(1, (k + 1) / ramp, (len - k) / ramp);
      step[pi] = sgn * cvT * SEG * q;
      hdPlan += step[pi];
    }
  };
  const writeStraight = (len: number) => {
    for (let k = 0; k < len && pi < NSAMP; k++, pi++) step[pi] = 0;
  };
  while (pi < NSAMP - 30) {
    const zone = biomeBlend(Math.min(pi, NSAMP - 1)).a;
    const u = rand();
    let kind: string;
    if (zone === 0) kind = u < 0.42 ? "droite" : u < 0.86 ? "grand" : "s";
    else if (zone === 1) kind = u < 0.14 ? "droite" : u < 0.52 ? "petit" : u < 0.84 ? "s" : "epingle";
    else if (zone === 2) kind = u < 0.5 ? "droite" : u < 0.9 ? "grand" : "petit";
    else kind = u < 0.1 ? "droite" : u < 0.42 ? "petit" : u < 0.74 ? "s" : "epingle";
    if (kind === "droite") {
      /* lignes droites : longues au désert (208-496 m), moyennes ailleurs */
      writeStraight(zone === 2 ? 26 + Math.floor(rand() * 36) : 10 + Math.floor(rand() * 20));
    } else if (kind === "grand") {
      /* grand courant rapide : R 280-560 m */
      writeCorner(1 / (280 + rand() * 280), 12 + Math.floor(rand() * 18), dir());
    } else if (kind === "petit") {
      /* petit virage : R 140-270 m */
      writeCorner(1 / (140 + rand() * 130), 8 + Math.floor(rand() * 12), dir());
    } else if (kind === "s") {
      /* chicane : deux virages de sens opposés, cap neutre */
      const cvS = 1 / (150 + rand() * 130);
      const lS = 7 + Math.floor(rand() * 8);
      const sgn = dir();
      writeCorner(cvS, lS, sgn);
      writeCorner(cvS, lS, -sgn);
    } else {
      /* épingle : R 30-60 m, 48-112 m d'arc — un VRAI freinage (95 → ~55 km/h) */
      writeCorner(1 / (30 + rand() * 30), 6 + Math.floor(rand() * 8), dir());
    }
  }
  writeStraight(NSAMP - pi);
  /* refermer la boucle en CAP : le contrebalancement garde le résidu petit,
     la détendance l'annule sans déformer des virages entiers */
  let hdAcc = 0;
  for (let i = 0; i < NSAMP; i++) hdAcc += step[i];
  const hdCorr = -hdAcc / NSAMP;
  for (let i = 0; i < NSAMP; i++) step[i] += hdCorr;
  /* (plus de lissage K=5 : le plan de virages entre/sort déjà par des rampes
     de clothoïde — le filtre laminait les épingles : R 55 → R 200) */
  const inc = new Float64Array(NSAMP);
  for (let i = 0; i < NSAMP; i++) inc[i] = grad[i] * noise2(i * 0.02) * SEG;
  const incS = new Float64Array(NSAMP);
  const KI = 4;
  for (let i = 0; i < NSAMP; i++) {
    let a3 = 0;
    for (let d = -KI; d <= KI; d++) a3 += inc[(((i + d) % NSAMP) + NSAMP) % NSAMP];
    incS[i] = a3 / (2 * KI + 1);
  }
  for (let i = 0; i < NSAMP; i++) {
    cv[i] = Math.abs(step[i]) / SEG;
    if (i + 1 < NSAMP) {
      hd[i + 1] = hd[i] + step[i];
      xs[i + 1] = xs[i] + Math.cos(hd[i]) * SEG;
      zs[i + 1] = zs[i] + Math.sin(hd[i]) * SEG;
      h[i + 1] = h[i] + incS[i];
    }
  }
  const hEnd = h[NSAMP - 1];
  for (let i = 0; i < NSAMP; i++) h[i] -= (hEnd * i) / (NSAMP - 1);
  const lapOff = { x: xs[NSAMP - 1], y: zs[NSAMP - 1] };
  return { xs, zs, hd, cv, w, h, mua, crrA, paved, biome, lapOff };
}

export function roadPoint(r: Road, sTot: number): { x: number; y: number; hd: number } {
  const lap = Math.floor(sTot / L_METERS);
  const sLoop = sTot - lap * L_METERS;
  const f = sLoop / SEG;
  const i0 = Math.floor(f) % NSAMP;
  const i1 = (i0 + 1) % NSAMP;
  const t = f - Math.floor(f);
  const ox = r.lapOff.x * lap;
  const oy = r.lapOff.y * lap;
  const jx = i0 === NSAMP - 1 ? r.lapOff.x : 0;
  const jy = i0 === NSAMP - 1 ? r.lapOff.y : 0;
  return {
    x: r.xs[i0] + (r.xs[i1] + jx - r.xs[i0]) * t + ox,
    y: r.zs[i0] + (r.zs[i1] + jy - r.zs[i0]) * t + oy,
    hd: r.hd[i0] + (r.hd[i1] - r.hd[i0]) * t,
  };
}

export function heightAt(r: Road, sTot: number): number {
  const sLoop = ((sTot % L_METERS) + L_METERS) % L_METERS;
  const f = sLoop / SEG;
  const i0 = Math.floor(f) % NSAMP;
  const i1 = (i0 + 1) % NSAMP;
  return r.h[i0] + (r.h[i1] - r.h[i0]) * (f - Math.floor(f));
}

export const ATTACK_GAP = 9; // m sous lesquels la rivale passe à l'attaque

/* ---- échantillonnage route sans allocation ---- */
export function idxAt(s: number): number {
  const sLoop = ((s % L_METERS) + L_METERS) % L_METERS;
  return Math.floor(sLoop / SEG) % NSAMP;
}
export function hdAt(r: Road, s: number): number {
  const f = (((s % L_METERS) + L_METERS) % L_METERS) / SEG;
  const i0 = Math.floor(f) % NSAMP;
  const i1 = (i0 + 1) % NSAMP;
  const t = f - Math.floor(f);
  return r.hd[i0] + (r.hd[i1] - r.hd[i0]) * t;
}
/* courbure SIGNÉE (rad/m) : + = virage à gauche, − = virage à droite */
export function cvAt(r: Road, s: number): number {
  return (hdAt(r, s + 4) - hdAt(r, s - 4)) / 8;
}
export function muAt(r: Road, s: number): number {
  return r.mua[idxAt(s)];
}
export function wAt(r: Road, s: number): number {
  return r.w[idxAt(s)];
}
export function crrAt(r: Road, s: number): number {
  return r.crrA[idxAt(s)];
}

export function trackOf(r: Road): Track {
  return {
    cvAt: (s) => cvAt(r, s),
    muAt: (s) => muAt(r, s),
    wAt: (s) => wAt(r, s),
    crrAt: (s) => crrAt(r, s),
    heightAt: (s) => heightAt(r, s),
  };
}

/* ============ Rivale & duel à la corde ============
   LA mécanique du proto : pas de physique multi-corps, et PLUS DE DÉ —
   la règle de course arbitre. La rivale est un fil sur la route avec
   une machine à états chorégraphiée : 0 chasse → 1 attaque (plongée à
   la corde ou drag race dans l'aspiration) → 2 passée (elle s'échappe
   puis relance) ou 3 recadrage (elle rend la place, wobble, ré-attaque
   après cooldown). LA RÈGLE : à la corde d'un virage, l'attaquant par
   l'INTÉRIEUR doit avoir son essieu avant au moins à la mi-hauteur du
   défenseur ; l'attaquant par l'EXTÉRIEUR doit être entièrement devant.
   Sinon la place est à LUI à rendre. Le joueur défend sa ligne à fond
   mais ne referme jamais la porte sur une rivale à hauteur. */
export type Rival = KinCar & {
  on: boolean;
  st: number; // 0 chasse · 1 attaque · 2 passée · 3 recadrage
  t: number; // temps dans l'état
  side: number; // +1 attaque à gauche · −1 à droite
  apexS: number; // s du point de corde qui arbitre le duel (−1 = aucun)
  won: boolean; // la corde lui a été acquise (règle, pas de dé)
  tries: number;
  wins: number;
  msg: string;
  msgT: number;
};

export const RV_STATE = ["chasse", "attaque", "devant", "recadrage"];

export function makeRival(seed: number, s: number, v: number): Rival {
  return {
    s, v, d: 0, dSm: 0, dRate: 0, roll: 0, pitch: 0, acc: 0, steer: 0, thr: 0, brkCmd: 0, grip: 0, abs: 0, pwr: 1, gear: 0, rpm: 1000, shiftT: 0,
    on: false, st: 0, t: 0, side: 1, apexS: -1, won: false,
    tries: 0, wins: 0, msg: "", msgT: 0,
  };
}

export type Game = {
  road: Road;
  trk: Track;
  pl: KinCar;
  rv: Rival;
};

export function makeGame(seed: number): Game {
  const road = buildRoad(seed);
  return {
    road,
    trk: trackOf(road),
    pl: { s: 500, v: 0, d: 0, dSm: 0, dRate: 0, roll: 0, pitch: 0, acc: 0, steer: 0, thr: 0, brkCmd: 0, grip: 0, abs: 0, pwr: 1, gear: 0, rpm: 1000, shiftT: 0 },
    rv: makeRival(seed * 7919 + 13, 350, 0),
  };
}

export function stepPlayer(g: Game, dt: number) {
  const r: Track = g.trk;
  const c = g.pl;
  const rv = g.rv;
  /* à FOND : la seule limite est la chaîne de freinage — la voiture
     donne tout ce que moteur (bridé au curseur), adhérence et aéro
     lui permettent ; l'aspiration compte quand la rivale est devant */
  driveStep(r, c, speedTarget(r, c.s, FLAT), dt, rv.on ? draftMul(c, rv) : 1);
  let dT = raceLineTarget(r, c.s);
  /* la règle de la corde, côté défenseur : il fait sa route au max,
     mais si la rivale a conquis la place à ses côtés il LUI LAISSE une
     largeur de voiture tant que le recouvrement dure — il ne referme
     jamais la porte, collision interdite */
  if (rv.on && rv.st >= 1 && Math.abs(c.s - rv.s) < CAR_L + 0.5) {
    const hwP = r.wAt(c.s) - 1.05;
    if (rv.d - c.d >= 0) dT = Math.min(dT, Math.max(-hwP, rv.d - 2.1));
    else dT = Math.max(dT, Math.min(hwP, rv.d + 2.1));
  }
  lateralStep(c, dT, dt);
  c.s += c.v * dt;
  /* NB : la garde anti-collision DURE est en fin de stepRival, sur les
     positions finales des DEUX voitures (une garde par voiture aurait
     une fenêtre aveugle d'un pas — 0,3 m à 200 km/h) */
  cosmeticsStep(r, c, dt);
}

/* le POINT DE CORDE du prochain virage : là où s'arbitre le duel. C'est
   le maximum de courbure du premier VRAI virage à venir (|cv| > 0,004,
   R < 250 m) ; −1 s'il n'y en a pas à portée (drag race en ligne
   droite, l'aspiration fait le travail) */
export function nextApex(r: Track, s: number, maxD: number): number {
  let best = -1;
  let cvB = 0;
  for (let i = s + 12; i < s + maxD; i += 4) {
    const cv = Math.abs(r.cvAt(i));
    if (cv > 0.004) {
      if (cv > cvB) { cvB = cv; best = i; }
      /* la courbure retombe après l'apex : la corde est trouvée */
      if (cvB > 0 && Math.abs(r.cvAt(i + 24)) < 0.002) break;
    }
  }
  return best;
}

export function stepRival(g: Game, dt: number) {
  if (!g.rv.on) return;
  const r: Track = g.trk;
  const rv = g.rv;
  const pl = g.pl;
  rv.t += dt;
  rv.msgT = Math.max(0, rv.msgT - dt);
  const gap = pl.s - rv.s;
  const hw = r.wAt(rv.s) - 0.97;
  let vT: number;
  let dT: number;
  /* la « haie » : la ligne de la rivale quand elle vit à côté du joueur.
     Déport ADAPTATIF : 2,6 m quand la chaussée le permet, sinon elle se
     serre contre le bord — jamais sous 2,06 m entre centres (deux voitures
     de 1,94 m se toucheraient). */
  const lane = (wob = 0) => Math.max(-hw, Math.min(hw, pl.d + rv.side * 2.6 + wob));
  /* la haie est-elle tenable sur ce côté : le déport réel (après clamp au
     bord) laisse-t-il ≥ 2,06 m entre les centres ? */
  const fits = (sgn: number, dPl: number, h: number) =>
    Math.abs(Math.max(-h, Math.min(h, dPl + sgn * 2.6)) - dPl) >= 2.06;

  if (rv.st === 0) {
    /* chasse : jamais plus lent que le joueur, jamais plus vite que +7 m/s.
       Elle tient une DISTANCE DE SUIVI (jamais < 7 m) tant que la place
       n'existe pas — chaussée large ET pas en pleine épingle, comme en
       vrai ; dès qu'il y a la place, elle se faufile dans la fenêtre
       d'attaque et saute sur l'occasion. */
    const chain = speedTarget(r, rv.s, FLAT, 0.85);
    /* site d'attaque : comme un vrai pilote, elle ne s'engage que si la
       place existe sur TOUTE la manœuvre. À vitesse pleine, la manœuvre
       dure ~5 s — la fenêtre s'étend avec la vitesse (4,5 s de route
       devant, jusqu'à ~330 m), et le seuil de courbure se relâche au
       loin : un grand courant (R > 360 m) laisse la haie tenir, la
       place reste vérifiée par fits à chaque sonde. */
    const reach = Math.min(400, 20 + pl.v * 5.5);
    const room =
      Math.abs(r.cvAt(rv.s)) < 0.005 &&
      [0, 30, 60, 90, 120, 160, 200, 240, 280, 320, 360].filter((o) => o <= reach).every((o) => {
        const sj = rv.s + o;
        const hj = r.wAt(sj) - 0.97;
        const dj = raceLineTarget(r, sj);
        return Math.abs(r.cvAt(sj)) < (o <= 90 ? 0.0015 : 0.0028) && (fits(1, dj, hj) || fits(-1, dj, hj));
      });
    /* suivi proportionnel : la vitesse relative vise l'écart de 8 m.
       Avant : « jamais plus lent que le joueur » (max(chain, pl.v)) la
       jetait au-dessus de SA chaîne à chaque sortie de virage (grip
       1,68, frein gratuit). Elle suit désormais SA chaîne — mais une
       chaîne de CHASSE un peu plus mordante (f = 0,85 : elle freine
       plus tard que lui) et un rattrapage à deux régimes : +7 m/s à
       portée d'aspiration, +15 m/s quand elle est décrochée — sinon
       chaque sortie de virage lui coûte 50-100 m que la droite ne
       rembourse jamais, et elle finissait 4 km derrière. */
    const follow = Math.max(-2.5, Math.min(gap > 30 ? 15 : 7, (gap - 8) * 0.9));
    vT = Math.min(pl.v + follow, chain);
    dT = raceLineTarget(r, rv.s);
    /* pré-positionnement : une fenêtre d'attaque qui se profile (et un
       écart < 20 m), elle glisse déjà sur le côté du futur doublage —
       la pointe partira haie en place, pare-chocs propres. Le côté suit
       la même règle qu'au déclenchement (extérieur du virage à venir,
       sinon là où le joueur n'est pas) : préparation = engagement. */
    if (room && gap < 20) {
      const cvNx = r.cvAt(rv.s + 60);
      let pref = Math.abs(cvNx) > 0.002 ? (cvNx > 0 ? -1 : 1) : pl.d > 0.3 ? -1 : pl.d < -0.3 ? 1 : rv.d >= pl.d ? 1 : -1;
      if (!fits(pref, pl.d, hw) && fits(-pref, pl.d, hw)) pref = -pref;
      if (fits(pref, pl.d, hw)) {
        rv.side = pref;
        dT = lane();
      }
    }
    /* engagement : À LA CORDE dès qu'un virage arbitre se profile — la
       plongée INTÉRIEURE, l'arme de la règle (essieu avant à mi-hauteur
       du défenseur au plus tard à la corde). Faisable si, à ~+2,4 m/s
       de vitesse relative, elle peut combler (gap − 2,3) m avant l'apex
       et si la place existe à mi-corde (le défenseur qui perd laisse
       une largeur : sa ligne d'apex décalée de 2,1 m). Sans corde à
       portée : drag race en ligne droite, vitesse pure. */
    const apexS = nextApex(r, rv.s, 400);
    const dApex = apexS - rv.s;
    const wApex = Math.max(60, pl.v * 5.5);
    if (apexS > 0 && dApex > 40 && dApex < wApex && gap < 22 && gap > -1) {
      const sideIn = r.cvAt(apexS) > 0 ? 1 : -1;
      const tApex = dApex / Math.max(pl.v, 10);
      const hj = r.wAt(apexS) - 0.97;
      const dj = raceLineTarget(r, apexS) - sideIn * 2.1;
      const corridor =
        fits(sideIn, pl.d, hw) &&
        fits(sideIn, dj, hj) &&
        fits(sideIn, raceLineTarget(r, apexS - 40) - sideIn, r.wAt(apexS - 40) - 0.97);
      if (tApex >= (gap - 2.3) / 2.4 && tApex > 1.2 && corridor) {
        rv.side = sideIn;
        rv.st = 1;
        rv.t = 0;
        rv.apexS = apexS;
        rv.msg = "⚔️ la rivale plonge à la corde…";
        rv.msgT = 4.4;
      }
    } else if (gap < ATTACK_GAP && room) {
      /* drag race : pas de corde à l'horizon, elle passe par vitesse
         pure ; côté : là où le joueur n'est pas, validé comme l'abort */
      const cvNext = r.cvAt(rv.s + 60);
      const pref = Math.abs(cvNext) > 0.002 ? (cvNext > 0 ? -1 : 1) : pl.d > 0.3 ? -1 : pl.d < -0.3 ? 1 : rv.d >= pl.d ? 1 : -1;
      const okAhead = (sgn: number) =>
        fits(sgn, pl.d, hw) && fits(sgn, raceLineTarget(r, pl.s + 30), r.wAt(pl.s + 30) - 0.97);
      let side = 0;
      if (okAhead(pref)) side = pref;
      else if (okAhead(-pref)) side = -pref;
      if (side !== 0) {
        rv.side = side;
        rv.st = 1;
        rv.t = 0;
        rv.apexS = -1;
        rv.msg = "💨 la rivale sort de l'aspiration…";
        rv.msgT = 4.4;
      }
    }
  } else if (rv.st === 1) {
    /* attaque : un VRAI doublage — 2,6 m entre les centres (deux voitures
       de 1,94 m tiennent dans la chaussée), déportage, portée à hauteur,
       côte à côte. Vitesses RELATIVES au joueur : la chorégraphie tient
       même s'il freine en plein duel. L'ISSUE SE LIT À LA CORDE, pas au
       dés :
       — entièrement devant avant la corde : gagné par vitesse pure ;
       — à la corde, INTÉRIEUR : essieu avant à mi-hauteur du défenseur
         au plus tard au point de corde → la place lui est due ;
       — à la corde, EXTÉRIEUR : entièrement devant, sinon rien ;
       — pas le niveau : elle rend la place (état 3), côté gelé. */
    if (rv.apexS < 0) {
      const a = nextApex(r, rv.s, 400);
      if (a > 0 && a - rv.s < Math.max(60, pl.v * 5.5)) {
        /* elle n'ADOPTE une corde que si la place y existe vraiment
           (même arbitre que l'abort noAhead) : une chaussée qui ne
           tient pas à l'apex n'est pas une corde à gagner. Avant ce
           garde-fou, un drag race adoptait une corde condamnée et
           avortait dans la seconde — 34 plongées mortes par demi-heure
           à égalité. Corridor absent → le drag race continue et se
           jugera par la ligne à +30 m (vitesse pure ou recadrage). */
        if (fits(rv.side, raceLineTarget(r, a) - rv.side * 2.1, r.wAt(a) - 0.97)) rv.apexS = a;
      }
    }
    let done = false;
    if (rv.s >= pl.s) {
      /* entièrement devant (son essieu avant au-delà de l'essieu avant
         du défenseur) : le doublage est consommé, plus rien à arbitrer */
      rv.tries++;
      rv.won = true;
      rv.st = 2;
      rv.t = 0;
      rv.wins++;
      rv.msg = "✅ DOUBLAGE — passée devant";
      rv.msgT = 2.5;
      done = true;
    } else if (rv.apexS > 0 && pl.s >= rv.apexS) {
      /* le défenseur atteint la corde : LA règle s'applique, maintenant */
      const inside = rv.side === (r.cvAt(rv.apexS) > 0 ? 1 : -1);
      rv.tries++;
      rv.won = inside ? rv.s + CAR_L / 2 >= pl.s - 0.05 : rv.s >= pl.s - 0.05;
      if (rv.won) {
        rv.st = 2;
        rv.t = 0;
        rv.wins++;
        rv.msg = "✅ la corde est à elle — le joueur s'écarte";
        rv.msgT = 2.5;
      } else {
        rv.st = 3;
        rv.t = 0;
        rv.msg = inside ? "❌ pas à hauteur à la corde — elle rend la place" : "❌ l'extérieur ne paye pas — elle se rabat";
        rv.msgT = 2.5;
      }
      done = true;
    } else if (rv.t > (rv.apexS > 0 ? 13 : 9)) {
      /* garde-fou : trop longtemps sans trancher — pas de dés, elle
         se rabat et retentera au virage suivant */
      rv.tries++;
      rv.won = false;
      rv.st = 3;
      rv.t = 0;
      rv.msg = "⏱️ trop long — elle se rabat";
      rv.msgT = 2.5;
      done = true;
    }
    /* la place est REVÉRIFIÉE à chaque image, mais selon le DUEL :
       — PLONGÉE À LA CORDE : l'entrée du virage est à elle (le joueur
         est à l'extérieur) ; le seul arbitre est la place À L'APEX,
         avec la largeur due si elle est quasi à mi-hauteur (le
         défenseur qui perd la règle cédera) ;
       — DRAG RACE : la haie doit tenir contre la ligne du joueur
         maintenant ET 30 m plus loin (une chaussée étroite avorte —
         en vrai, on ne roule pas côte à côte sur un désert de 6 m). */
    const owed = rv.apexS > 0 && rv.apexS - rv.s < 130 && gap < 4.6;
    const y = owed ? 2.1 : 0;
    let abort = false;
    if (!done) {
      /* le joueur ne peut pas bouger instantanément : sa position actuelle
         ET sa ligne 12 m plus loin (0,25 s) doivent toutes deux bloquer
         le côté pour avorter — souvent sa ligne libère l'entrée */
      const dPl12 = raceLineTarget(r, pl.s + 12);
      const noNow =
        !fits(rv.side, pl.d - rv.side * y, hw) &&
        !fits(rv.side, dPl12 - rv.side * y, hw);
      const noAhead =
        rv.apexS > 0
          ? !fits(rv.side, raceLineTarget(r, rv.apexS) - rv.side * 2.1, r.wAt(rv.apexS) - 0.97)
          : !fits(rv.side, raceLineTarget(r, pl.s + 30), r.wAt(pl.s + 30) - 0.97);
      if (noNow || noAhead) {
        rv.tries++;
        rv.st = 3;
        rv.t = 0;
        rv.msg = "↩️ pas de place — elle se rabat";
        rv.msgT = 2.5;
        abort = true;
      }
    }
    if (abort) {
      dT = rv.d;
      vT = pl.v - 7;
    } else if (done) {
      if (rv.st === 2) {
        dT = lane();
        vT = pl.v + 4;
      } else {
        dT = rv.d;
        vT = pl.v - 7;
      }
    } else {
      dT = lane();
      if (rv.apexS > 0) {
        /* FREINEUSE TARDIVE : sa consigne de plongée n'est plus une
           marge figée % joueur — c'est SA chaîne de freinage en style
           agressif (f = 0,95 : ~30 % de frein en plus à planifier que
           le joueur). Dans la zone de freinage sa chaîne est 3 à 5 m/s
           AU-DESSUS de la sienne → l'écart se referme SOUS LE FREIN :
           le vrai out-braking. Et comme 0,95 < 1, le cercle de
           friction taille ce qu'elle surestime — aucun grip gratuit,
           elle reste dans son budget (avec l'ellipse qui rogne en
           corbe : ABS, trail braking). ANTI-CIPATION : la consigne
           descend de la chaîne, pas du pare-chocs — elle a lu le
           virage 300 m plus tôt. */
        vT = speedTarget(r, rv.s, FLAT, 0.95);
      } else {
        /* drag race en ligne droite : marge franche % joueur — ici
           kLong = 1 (pas de virage), le cercle ne mord pas ; c'est
           l'aspiration + la puissance qui font le travail */
        vT = pl.v + (rv.t < 1.2 ? 3.5 : 2.2);
      }
    }
  } else if (rv.st === 2) {
    /* passée : la FUSION (2,5 s) fait partie de la chorégraphie — vitesses
       relatives, on ne laisse pas la chaîne de virage la faire retomber au
       niveau du joueur au moment où elle vient de le déborder. Puis ligne
       de course normale, s'échappe, et nouvelle vague à −50 m. */
    /* fusion plafonnée par SA chaîne tardive : pl.v + 4 en plein
       virage la jetait 6 m/s au-dessus de la corde suivante et le
       cercle de friction l'y laissait plantée (grip 1,55 mesuré,
       ABS allumé, la voiture « survivait » cinématiquement). Elle
       s échappe, mais dans son budget. */
    vT = rv.t < 2.5 ? Math.min(pl.v + 4, speedTarget(r, rv.s, FLAT, 0.95)) : Math.min(speedTarget(r, rv.s, FLAT, 0.95), pl.v + 3);
    dT = gap > -CAR_L ? lane() : raceLineTarget(r, rv.s);
    if (rv.t > 7) {
      rv.s = pl.s - 50;
      /* TÉLÉPORTATION DANS LE BUDGET : atterrir à pl.v peut la jeter
         en plein virage à une vitesse PHYSIQUEMENT au-delà de la
         corde (grip 1,11 mesuré : atterrissage en épingle à 38,8 m/s
         pour une corde à 37,1). La nouvelle vague démarre à SA
         vitesse de chaîne au point d'arrivée — comme un pilote qui
         rejoint la piste, pas qui s'y téléporte à fond. */
      rv.v = Math.min(pl.v, speedTarget(r, rv.s, FLAT, 0.95));
      rv.st = 0;
      rv.t = 0;
      rv.apexS = -1;
      rv.msg = "🔄 nouvelle tentative";
      rv.msgT = 2;
    }
  } else {
    /* recadrage / rabattement : tant qu'elle se recouvre avec le joueur,
       son côté est GELÉ — aucun mouvement latéral tant que les voitures
       ne sont pas séparées en long (on ne « traverse » jamais l'autre).
       Le wobble (l'embardée du geste raté) ne se joue que si la marge
       latérale le permet. Une fois ressortie derrière : ligne de course
       normale, puis retour à la chasse — jamais avant d'être dégagée. */
    vT = pl.v - (gap < CAR_L + 2 ? 7 : 1);
    const ddNow = Math.abs(rv.d - pl.d);
    const wob = rv.t < 1.2 && ddNow > 2.3 ? Math.sin(rv.t * 16) * 0.4 * (1.2 - rv.t) : 0;
    dT = gap < CAR_L ? rv.d + wob : raceLineTarget(r, rv.s);
    if (rv.t > 5.5 && gap > CAR_L) {
      rv.st = 0;
      rv.t = 0;
    }
  }

  driveStep(r, rv, vT, dt, draftMul(rv, pl));
  lateralStep(rv, dT, dt);

  /* anti-collision DURE, SYMÉTRIQUE, sur les positions FINALES du pas :
     jamais deux voitures dans la même case route, quel que soit le
     verdict de la corde. Une garde par voiture aurait une fenêtre
     aveugle d'un pas (0,3 m à 200 km/h) — on écarte donc ici, à la fin,
     celle des deux qui peut l'être (la rivale d'abord, le joueur s'il
     n'y a vraiment pas d'autre choix) ; sinon on sépare en LONG. */
  if (rv.st === 0) {
    /* en chasse, la rivale n'est JAMAIS à côté : elle rend la distance
       de suivi (pas d'écartement magique) */
    if (Math.abs(pl.s - rv.s) < CAR_L && Math.abs(pl.d - rv.d) < CAR_D) {
      rv.v = Math.min(rv.v, pl.v - 3.0);
    }
  }

  rv.s += rv.v * dt;

  const dsF = Math.abs(pl.s - rv.s);
  if (rv.on && rv.st >= 1 && dsF < CAR_L && Math.abs(pl.d - rv.d) < CAR_D) {
    const sgn = rv.d >= pl.d ? 1 : -1;
    const wantR = pl.d + sgn * CAR_D;
    const wantP = rv.d - sgn * CAR_D;
    const hwP = r.wAt(pl.s) - 1.05;
    if (Math.abs(wantR) <= hw) {
      /* on écarte la rivale — c'est à l'attaquante de gérer sa marge
         (dSm synchronisé : la cible lissée ne doit pas lutter contre
         la garde) */
      rv.d = wantR;
      rv.dSm = wantR;
      if (rv.dRate * sgn < 0) rv.dRate = 0;
    } else if (Math.abs(wantP) <= hwP) {
      /* le défenseur doit céder la largeur à la main : la règle de la
         corde lui interdit de refermer, même physiquement */
      pl.d = wantP;
      pl.dSm = wantP;
      if (pl.dRate * sgn > 0) pl.dRate = 0;
    } else if (rv.st === 2) {
      /* plus de place latérale nulle part : on sépare en LONG, fort,
         dans le sens de la manœuvre (elle est devant → elle s'échappe) */
      rv.v = Math.max(rv.v, pl.v + 5);
    } else {
      rv.v = Math.min(rv.v, pl.v - 5);
    }
  }
  cosmeticsStep(r, rv, dt);
}

export function advance(g: Game, dt: number) {
  stepPlayer(g, dt);
  stepRival(g, dt);
}

