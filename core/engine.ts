/* ============ PRNG & bruit ============ */

export function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeNoise(rand: () => number) {
  const g: number[] = [];
  for (let i = 0; i < 256; i++) g.push(rand() * 2 - 1);
  return (x: number) => {
    const i = Math.floor(x);
    const f = x - i;
    const a = g[((i % 256) + 256) % 256];
    const b = g[(((i + 1) % 256) + 256) % 256];
    const t = f * f * (3 - 2 * f);
    return a + (b - a) * t;
  };
}

export const SEG = 8;              // m entre échantillons de route (consommé par core/route.ts)

/* 0 plaine · 1 forêt · 2 désert (piste de terre) · 3 altitude (étroit, pentes) */
export const BIOMES = [
  { name: "Plaine", amp: 1.0, w: 3.75, mu: 1.12, crr: 1.0, paved: 1, grad: 0.008 },
  { name: "Forêt", amp: 1.15, w: 3.4, mu: 1.05, crr: 1.05, paved: 1, grad: 0.018 },
  { name: "Désert", amp: 0.9, w: 3.05, mu: 0.75, crr: 1.9, paved: 0, grad: 0.014 },
  { name: "Altitude", amp: 1.6, w: 3.2, mu: 0.95, crr: 1.15, paved: 1, grad: 0.08 },
];
/* ============ Voiture cinématique : moteur + adhérence, SANS corps rigide ============
   Philosophie du proto : la voiture n'est PAS un corps rigide simulé — c'est
   un point sur la route (abscisse s + écart latéral d) animé par des forces
   LONGITUDINALES réelles (couple moteur, traînée, roulement, pente) et une
   limite de virage par adhérence (v² ≤ μ·g/cv). Le résultat doit SEMBLER
   physique (elle freine avant les virages, s'ouvre, mord à l'apex, accélère
   en sortie) sans le moindre état instable à équilibrer. Le tangage/roulis
   sont des cosmétiques lissées, pas des intégrations de couples. */

export const M = 1400; // kg
export const G = 9.81;
/* ---- BOÎTE 6 : le régime moteur existe enfin — couple, rapports,
   passages, limiteur. La voiture n'a plus une courbe de puissance
   abstraite : elle a un moteur qui monte dans les tours, change de
   rapport (coupure 0,25 s) et plafonne au rupteur. ---- */
export const RW = 0.34;          // rayon de roue (m)
export const FINAL = 3.7;        // pont
export const RATIOS = [3.6, 2.45, 1.85, 1.43, 1.15, 0.92]; // 1re..6e
export const RPM_PEAK = 4500;    // couple max (décision Tanguy 2026-10-17)
export const RPM_MAX = 7000;    // rupteur
export const RPM_SHIFT_UP = 6400;
export const RPM_SHIFT_DN = 2400;
export const TMAX = 400;         // couple max (N·m)
/* vitesse du rupteur en 6e (référence de gravité contact) */
export const V_LIM = RPM_MAX / 60 * 2 * Math.PI * RW / (RATIOS[5] * FINAL); // ≈ 73,3 m/s

/* couple roue : T(rpm) × ratio × pont × rendement 0,9 / rayon */
export function torqueAt(rpm: number): number {
  /* montée linéaire 0,55@1000 -> 1@RPM_PEAK, plateau jusqu'à 5300,
     chute -> 0,72@RPM_MAX (rupteur) */
  if (rpm < IDLE_RPM) return TMAX * (0.35 + 0.2 * rpm / IDLE_RPM);
  if (rpm < RPM_PEAK) return TMAX * (0.55 + 0.45 * (rpm - IDLE_RPM) / (RPM_PEAK - IDLE_RPM));
  if (rpm < RPM_PLATEAU_END) return TMAX;
  return TMAX * Math.max(TORQUE_RUPT_FRAC, 1 - (rpm - RPM_PLATEAU_END) * 0.28 / (RPM_MAX - RPM_PLATEAU_END));
}
export function rpmOf(gear: number, v: number): number {
  const r = RATIOS[gear] * FINAL;
  return v <= 0.01 ? 1000 : Math.max(1000, Math.min(RPM_MAX, v / (2 * Math.PI * RW) * r * 60));
}
export const FMAX = 6000; // N (adhérence motrice max)
export const CDA = 0.39; // traînée aéro
export const CRR = 0.013; // roulement de base (× crrA du biome)
export const AMAX_BRAKE = 10.7; // m/s² — ≈ 1,09 g, AU PLAFOND du budget pneu (μ·g = 10,79) : en ligne droite le frein est à fond de grip, et dès qu'on tourne, l'ellipse kLong le rogne → trail braking, comme en vrai. Au-delà de μ·g la roue bloquerait
export const MU = 1.1; // référence de grip (échelle des freinages) — pneu rallye asphalte : freins ET virages plus forts ensemble
export const DT =  1 / 120;
export const KLAT = 520; // profondeur de coupe d'apex (corde ≈ KLAT × courbure signée)
export const FLAT = 1e9; // pas de plafond : la seule limite est la chaîne de freinage
                   // (v² ≤ μ·g/cv) et le moteur lui-même (couple, traînée)
export const CAR_L = 4.6; // emprise longitudinale anti-collision (m)
export const CAR_D = 2.05; // séparation latérale minimale des centres (m)
export const EDGE_MARGIN = 1.05; // n°29 : marge d'accotement soustraite de la demi-largeur (partagée)
/* n°29 partie C : littéraux externalisés (AUCUNE valeur modifiée) */
export const DRAFT_RANGE_M = 30;       // aspiration : portée du sillage
export const DRAFT_LAT_MAX = 2.5;     // aspiration : déport latéral max (attaque n°19)
export const DRAFT_SIDE_MUL = 0.70;  // aspiration : sillage côte à côte
export const IDLE_RPM = 1000;         // ralenti moteur
export const RPM_PLATEAU_END = 5300;  // fin du plateau de couple
export const TORQUE_RUPT_FRAC = 0.72; // couple résiduel au rupteur
export const LIMITER_RAMP_RPM = 200; // rampe du limiteur (rupteur progressif)
export const RUSH_SHIFT_RPM = 5500;   // passage précipité : régime mini actuel
export const SHIFT_FALL_RPM = 3200;   // passage précipité : régime du rapport +1
export const SHIFT_CUT_S = 0.25;      // coupure de passage (s)
export const DEAD_BAND_STRAIGHT = 0.6; // bande morte en ligne droite (m/s)
export const DEAD_BAND_TURN = 0.75;   // resserrement de la bande en virage
export const IND_STEP_M = 10;          // chaîne de freinage : pas d'induction
export const CV_EPS = 1e-4;           // courbure quasi nulle (ligne droite)

export type KinCar = {
  s: number; // abscisse curviligne absolue (m, croît sans borne)
  v: number; // vitesse (m/s)
  d: number; // écart latéral (m, + = gauche de la route)
  dSm: number; // cible latérale LISSÉE (lag 1er ordre — la consigne brute saute à la corde)
  dRate: number; // vitesse latérale (m/s)
  roll: number; // roulis cosmétique (rad, + = gauche haut)
  pitch: number; // tangage cosmétique (rad, + = nez haut)
  acc: number; // télémétrie : accélération longitudinale EFFECTIVE (m/s²)
  thr: number; // télémétrie : PÉDALE DE GAZ du pilote 0..1 (1 = pied au plancher)
  brkCmd: number; // télémétrie : PÉDALE DE FREIN commandée 0..1 (exclusive du gaz)
  grip: number; // télémétrie : usage TOTAL du budget de grip — cercle de friction (latéral + gaz/frein)
  abs: number; // télémétrie : voyant ABS — 1 quand l'ellipse rogne le frein demandé (sans ce dosage, la roue bloquerait)
  steer: number; // télémétrie : saturation de direction −1..+1 (dRate/dRateMax)
  pwr: number; // bridage moteur 0..1 (curseur « Moteur » : 1 = pleine puissance)
  gear: number;   // 0..5 (1re..6e)
  rpm: number;    // régime (tr/min) — télémétrie + conso + son
  shiftT: number; // coupure de passage en cours (s, décrémente)
};

/* ============ Track : la route vue par la physique ============
   Toute la physique (chaîne de freinage, longitudinal, ligne de
   course, cosmétiques) ne lit la route qu'à travers ces CINQ sondes.
   La boucle du proto implémente Track via trackOf() ; la route
   LINÉAIRE de la Phase 1 (core/route.ts) l'implémente chunk par chunk.
   Même physique, même budget de grip, deux mondes. */
export interface Track {
  cvAt(s: number): number;
  muAt(s: number): number;
  wAt(s: number): number;
  crrAt(s: number): number;
  heightAt(s: number): number;
}

/* ---- chaîne de freinage : vitesse cible en respectant TOUTES les limites
   de virage à venir (on remonte 360 m en budgete de freinage, comme le
   pilote du raid-3d mais sans cercle de friction — c'est une CIBLE, le
   véhicule la rejoint avec ses vraies forces) ---- */
export function speedTarget(r: Track, s: number, vCap: number, f = 0.75): number {
  let vNext = vCap;
  /* f = STYLE DE FREINAGE : 0,75 = pilote prudent (le joueur), 0,95 =
     freineur tardif (la rivale en attaque) — même physique, même budget
     de grip : elle plonge juste ~30 % plus profond dans la zone (f est
     la part du frein MAX que l'induction s'autorise à planifier ; le
     frein réel, lui, reste plafonné par le cercle de friction). */
  /* sondes tous les 4 m avec courbure en ENVELOPPE sur ±3 m : l'apex
     d'un virage serré tient sur UNE cellule de 8 m — une grille de 8 m
     l'aliase (la voit, la rate, la revoit), ce qui fait osciller la
     consigne de ±2 m/s et dépasser la limite d'adhérence de +9 % à
     l'apex. L'induction est ARRIÈRE stricte : la limite du point
     courant est respectée au point courant, le budget de freinage se
     consomme sur les segments qui y mènent. */
  const SEG2 = 4;
  for (let j = 90; j >= 0; j--) {
    const sj = s + j * SEG2;
    const muJ = r.muAt(sj);
    const cv = Math.max(Math.abs(r.cvAt(sj - 3)), Math.abs(r.cvAt(sj)), Math.abs(r.cvAt(sj + 3)));
    const vC = cv < CV_EPS ? 1e4 : Math.sqrt(muJ * G / cv);
    vNext = Math.min(vNext, vC);
    if (j > 0) {
      /* aBrake scalé par le grip LOCAL comme le frein réel (avant :
         budget constant → chaînes trop optimistes sur bas grip) */
      const aBrake = AMAX_BRAKE * f * (muJ / MU);
      /* cercle de friction, côté INDUCTION : le frein disponible sur le
         segment qui mène à cette cellule dépend de ce que le VIRAGE y
         consomme déjà. Subtilité : en freinant VERS vC, la voiture est
         plus rapide que vC sur la majorité du segment — le budget
         latéral y est plus entamé. Une itération de point fixe :
         latEst d'abord à vC, puis à la vitesse d'entrée vA qu'on
         venait d'autoriser, et on garde la version prudente. */
      const lat0 = muJ > 0 ? Math.min((vNext * vNext * cv) / (muJ * G), 0.98) : 0;
      const aEff0 = aBrake * Math.sqrt(Math.max(0, 1 - lat0 * lat0));
      const vA = Math.sqrt(vNext * vNext + 2 * aEff0 * SEG2);
      const lat1 = muJ > 0 ? Math.min((vA * vA * cv) / (muJ * G), 0.98) : 0;
      const aEff = Math.min(aEff0, aBrake * Math.sqrt(Math.max(0, 1 - lat1 * lat1)));
      vNext = Math.sqrt(vNext * vNext + 2 * aEff * SEG2);
    }
  }
  return Math.min(vNext, vCap);
}

/* ---- longitudinal : moteur, traînée, roulement, pente, frein ---- */
/* aspiration : derrière une autre voiture (≤ 30 m, à peu près alignée),
   la traînée aéro chute jusqu'à −30 % au pare-chocs — c'est L'ARME du
   poursuivant quand les deux moteurs sont égaux (curseurs de bridage) */
export function draftMul(behind: KinCar, front: KinCar): number {
  const ds = front.s - behind.s;
  const dd = Math.abs(front.d - behind.d);
  /* v2 (n°24) : le tow ne tombe plus à 1 pile au moment de passer —
     la fenêtre s'étend à l'entrefer (ds > -CAR_L) et au déport
     d'attaque (dd jusqu'à 2,5 = CAR_D + marge agressif n°19). Le
     rupteur borne le gain de vitesse (physique : le moteur ne peut
     pas dépasser le régime), l'aspiration agit par la traînée. */
  if (ds > DRAFT_RANGE_M || ds <= -CAR_L || dd > DRAFT_LAT_MAX) return 1;
  if (ds <= 0) return DRAFT_SIDE_MUL;   /* côte à côte : sillage plein */
  return 1 - 0.3 * (1 - ds / 30);
}

export function driveStep(r: Track, c: KinCar, vT: number, dt: number, draft = 1) {
  const slope = (r.heightAt(c.s + 8) - r.heightAt(c.s)) / 8;
  const drag = draft * CDA * c.v * c.v + (c.v > 0.3 ? CRR * r.crrAt(c.s) * M * G : 0);
  let F = -drag - M * G * slope;
  /* PÉDALES (télémétrie pilote) : GAZ = ce que demande le pied — 1 =
     plancher ; en zone morte, la part de moteur juste nécessaire pour
     équilibrer traînée + pente (moins avec l'aspiration, draft < 1) ;
     0 dès que ça freine. FRN = pédale de frein commandée, EXCLUSIVE
     du gaz : plus jamais les deux affichés en même temps (le frein
     moteur + traînée d'un coasting ne sont pas un freinage). */
  /* CERCLE DE FRICTION : un pneu ne colle pas deux fois. Le latéral
     (v²·cv) et le longitudinal (gaz/frein) partagent le MÊME budget
     μ·M·g, en ellipse — le frein compte donc autant que l'accélération.
     La trajectoire a la priorité : le virage prend son morceau, le
     frein et le gaz prennent ce qui reste (freinage réduit en courbe =
     trail braking, gaz qui s'ouvre à la sortie). Ratio latéral clampé
     à 0,98 : au bord de la limite il reste ~20 % de longi pour le
     frein léger qui tient la voiture sur sa consigne. */
  const mu = r.muAt(c.s);
  const cv = Math.abs(r.cvAt(c.s));
  const latG = cv > 1e-5 && mu > 0 ? (c.v * c.v * cv) / (mu * G) : 0;
  const kLong = Math.sqrt(Math.max(0, 1 - Math.min(latG, 0.98) ** 2));
  const FBud = Math.max(mu * M * G, 1);
  /* BOÎTE 6 : régime réel, passages de vitesse, rupteur progressif.
     Pure fonction de (gear, v) -> déterministe (ADR 0004), replays
     identiques. Coupure 0,25 s au passage ; le rupteur coupe en douceur
     sur les 200 derniers tr/min (pas de cognement du flux 15 Hz). */
  const rpmRaw = c.v <= 0.01 ? 1000 : Math.max(1000, c.v / (2 * Math.PI * RW) * (RATIOS[c.gear] * FINAL) * 60);
  c.rpm = Math.min(rpmRaw, RPM_MAX);
  if (c.shiftT > 0) c.shiftT -= dt;
  else if (c.gear < 5 && (c.rpm >= RPM_SHIFT_UP || (c.rpm >= RUSH_SHIFT_RPM && rpmOf(c.gear + 1, c.v) >= SHIFT_FALL_RPM))) { c.gear++; c.shiftT = SHIFT_CUT_S; }
  else if (c.gear > 0 && c.rpm <= RPM_SHIFT_DN) { c.gear--; c.shiftT = SHIFT_CUT_S; }
  c.rpm = rpmOf(c.gear, c.v);
  const lim = Math.max(0, Math.min(1, 1 - (rpmRaw - (RPM_MAX - LIMITER_RAMP_RPM)) / LIMITER_RAMP_RPM));
  const FEng = c.shiftT > 0 ? 0 : torqueAt(c.rpm) * RATIOS[c.gear] * FINAL * 0.9 / RW * c.pwr * lim;
  let lonG = 0; // part du budget grippée par le gaz ou le frein
  c.brkCmd = 0;
  c.abs = 0;
  /* BANDE MORTE ADAPTATIVE : ±0,6 en ligne droite (pédales douces en
     croisière), resserrée à ±0,15 en virage — là où l'adhérence est
     déjà consommée par le latéral, une bande large relâcherait le
     frein PLEIN avant l'apex et le frein léger (rogne à ~20 % par
     l'ellipse) ne peut pas finir de descendre : la voiture entrait
     0,3 m/s trop vite et dépassait le budget de grip à l'apex. */
  const band = DEAD_BAND_STRAIGHT * (1 - DEAD_BAND_TURN * Math.min(latG, 1));
  if (vT > c.v + 0.6) {
    const Fd = Math.min(FMAX, FEng) * kLong;
    F += Fd;
    c.thr = 1;
    lonG = Fd / FBud;
  } else if (vT <= c.v - band) {
    const Fb = AMAX_BRAKE * (mu / MU) * M * kLong;
    F -= Fb;
    c.thr = 0;
    c.brkCmd = 1;
    /* VOYANT ABS : le frein DEMANDÉ (AMAX_BRAKE) dépasse ce que le
       virage laisse passer (kLong < 0,95) — le dosage de l'ellipse
       l'a rogné pour que la roue ne bloque pas : c'est ÇA, un ABS.
       En ligne droite kLong = 1, voyant éteint. */
    c.abs = kLong < 0.95 ? 1 : 0;
    lonG = Fb / FBud;
  } else if (vT < c.v) {
    /* tenue de limite : cible EN DESSOUS en zone morte (en plein virage
       vT = √(μg/cv)) — frein léger proportionnel qui colle la voiture
       à sa limite d'adhérence, sinon elle flotte au-dessus par la
       seule traînée (+~10 % sur v² ≤ μg/cv) */
    const Fb = Math.min(AMAX_BRAKE * (mu / MU) * M * kLong, M * (c.v - vT) * 3);
    F -= Fb;
    c.thr = 0;
    c.brkCmd = Math.min(1, (M * (c.v - vT) * 3) / Math.max(AMAX_BRAKE * (mu / MU) * M, 1));
    lonG = Fb / FBud;
  } else {
    /* PÉDALES PROPORTIONNELLES : l'ancien hystérésis ±0,15 tout-ou-rien
       faisait clignoter le gaz ~76 Hz autour de la vitesse cible en
       croisière (scie sur la télémétrie). Ici la force suit
       proportionnellement l'écart — la pédale devient un vrai
       curseur, vMoy inchangée. */
    const FdFull = Math.min(FMAX, FEng) * kLong;
    /* clamp du gaz dans le MÊME budget que le frein (le cercle de
       friction ne rognait que le frein) : la part latérale déjà
       consommée (latG) limite le longi restant — le grip total
       sqrt(latG² + lonG²) reste ≤ 1 */
    const lonRoom = Math.max(0, Math.sqrt(Math.max(0, 1 - Math.min(latG, 1) ** 2)));
    const Fd = Math.min(FdFull, M * (vT - c.v) * 3, lonRoom * FBud);
    F += Fd;
    c.thr = FdFull > 0 ? Math.max(0, Math.min(1, Fd / FdFull)) : 0;
    lonG = Math.max(0, Fd) / FBud;
  }
  c.grip = Math.sqrt(latG * latG + lonG * lonG);
  const vPrev = c.v;
  c.v = Math.max(0, c.v + (F / M) * dt);
  /* télémétrie : ce qui s'est réellement passé (freinage inclus, clamp 0 inclus) */
  c.acc = (c.v - vPrev) / dt;
}

/* ---- latéral : la vraie ligne de course, ouverture → corde → sortie ----
   d cible = KLAT × courbure 28 m devant (la corde, intérieur du virage)
   − 170 × courbure 70 m devant (l'ouverture d'entrée, extérieur)
   − 170 × courbure 26 m derrière (le retour de sortie, extérieur).
   Le déplacement latéral est borné en vitesse (crédibilité : un changement
   de ligne à 90 km/h ne se fait pas en 0,1 s) et amorti en accélération —
   le suiveur se pose sur sa ligne sans jamais toupiller autour. */
export function raceLineTarget(r: Track, s: number): number {
  const hw = r.wAt(s) - EDGE_MARGIN;
  /* la VRAIE trajectoire : extérieur à l'engagement, intérieur à la
     corde, extérieur à la sortie. La corde se prend sur la courbure
     proche (10 m devant — turn-in tardif : la corde se prend EN entrant
     dans le virage), l'ouverture d'entrée sur la courbure lointaine
     (70 m devant), le retour de sortie sur la courbure derrière (26 m). */
  const near = r.cvAt(s + 10);
  const far = r.cvAt(s + 70);
  /* double sonde arrière : la sortie extérieure se prolonge ~45 m après
     le virage (on ne se recentre pas en un claquement de doigts) */
  const past = r.cvAt(s - 20) + r.cvAt(s - 45);
  /* porte DOUCE (sigmoïde) : la porte binaire collait la cible à la
     butée d'un bord puis basculait instantanément sur l'autre — ce
     sont les « murs invisibles ». La sigmoïde fond les transitions
     ouverture → corde → sortie en un seul geste continu. */
  const g = 1 / (1 + Math.pow(Math.abs(near) / 0.004, 4));
  const th = Math.tanh;
  /* amplitude RELATIVE à la largeur utilisable : KLAT·cv vaut jusqu'à
     17 m — 9× la demi-chaussée de forêt ; chaque terme est borné à
     90 % de hw : la corde ne « roule » plus sur le bord, elle le
     touche à l'apex. KLAT reste le réglage de forme (à quelle
     courbure la corde se creuse). */
  const f = 0.9 * th((KLAT * near) / hw)
    - 0.9 * th((170 * far) / hw) * g
    - 0.9 * th((190 * past) / hw) * g;
  return Math.max(-0.9, Math.min(0.9, f)) * hw;
}
export function lateralStep(c: KinCar, dT: number, dt: number) {
  /* LISSAGE DE LA CONSIGNE (le « mur invisible » de la corde) : au
     moment où la porte s'échappe (|near| sous 0,003), le terme de
     sortie (190 × past — jusqu'à 10 m en épingle) fait traverser à
     la cible TOUTE la chaussée en 2-3 images (+2,15 → −2,15 mesuré
     en 0,15 s à la corde s=17871). Le contrôleur sature et la voiture
     SAUTE latéralement. Un pilote déplace ses mains en continu : la
     cible passe par un lag du premier ordre (τ = 0,12 s). La LIGNE
     (raceLineTarget) ne change pas d'un mètre — corde, fits et
     anti-collision la lisent comme avant ; seul le suivi est lissé. */
  c.dSm += (dT - c.dSm) * Math.min(1, dt / 0.15);
  dT = c.dSm;
  /* plafond latérale relevé : la capacité d'AVANT (3,2 m/s, acc ±7)
  était étranglée sous la demande du contrôleur ζ=1 (~18 m/s²) dans
  les transitions ouverture→corde→ sortie — la voiture traversait
  les bascules en retard, direction saturée 12 % du temps en forêt
  à 190 km/h. 5 m/s et ±12 laissent enfin la voiture suivre sa
  ligne sans patiner hors de celle-ci à basse vitesse. */
  const dRateMax = Math.max(0.4, Math.min(5, 0.15 * c.v));
  /* retour d'état CRITIQUEMENT AMORTI : acc = err/T² − 2·dRate/T (T = 0,3 s)
     → ζ = 1 exactement : zéro dépassement, zéro toupillage — la voiture
     se pose sur sa ligne et y reste. */
  const T = 0.3;
  const acc = Math.max(-12, Math.min(12, (dT - c.d) / (T * T) - (2 * c.dRate) / T));
  c.dRate = Math.max(-dRateMax, Math.min(dRateMax, c.dRate + acc * dt));
  c.d += c.dRate * dt;
  /* télémétrie : |steer| = 1 → la direction est saturée, la voiture ne
     peut pas suivre sa ligne plus vite (c'est LA de la glisse en épingle) */
  c.steer = c.dRate / dRateMax;
}

/* ---- télémétrie HUD : le grip est maintenant calculé dans driveStep
   (c.grip = cercle de friction, latéral + gaz/frein, 1 = budget pneu
   saturé) et les pédales commandées y sont posées (c.thr / c.brkCmd,
   exclusives l'une de l'autre) — rien à déduire ici. */

/* ---- cosmétiques : tangage de pente + roulis de virage, lissés ---- */
export function cosmeticsStep(r: Track, c: KinCar, dt: number) {
  const pT = Math.atan2(r.heightAt(c.s + 4) - r.heightAt(c.s - 4), 8);
  const rT = Math.max(-0.1, Math.min(0.1, 0.03 * r.cvAt(c.s) * c.v * c.v));
  c.pitch += (pT - c.pitch) * Math.min(1, dt * 8);
  c.roll += (rT - c.roll) * Math.min(1, dt * 7);
}

