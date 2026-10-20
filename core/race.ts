/* ============================================================
   COURSE — la couche stratégique au-dessus du moteur
   ============================================================
   La voiture est autonome (ADR 0002) : le joueur n'écrit que des
   PLANS — actions planifiées (au km) ou règles conditionnelles
   (fatigue, carburant). L'exécuteur les applique en continu :
     - carburant : conso liée au curseur moteur, panne sèche
       possible (assistance lente sur place) ;
     - fatigue : compteur de veille en heures ; la NUIT bride la
       vitesse (22 h → 6 h, Paris) ; le sommeil à l'hôtel récupère
       minute pour minute ; au-delà de 30 h de veille, arrêt de
       survie en bord de route (récupération de moitié) ;
     - arrêts : station (plein), hôtel (sommeil à la minute près),
       garage (réparation) — services à la carte du point d'arrêt ;
     - duel : strictement par paires en chaîne (vision 2026-10-14) —
       chaque voiture n'arbitre qu'avec la suivante ; aspiration
       entre toutes, garde anti-collision dure.
   Le tout reste DÉTERMINISTE : pas fixe 1/120 s (ADR 0004), tout
   l'état est sérialisable pour la reprise serveur.
*/
import {
  speedTarget, driveStep, lateralStep, cosmeticsStep, raceLineTarget, draftMul,
  DT, CAR_L, CAR_D, V_LIM, FLAT, RW, FINAL, RATIOS, EDGE_MARGIN, mulberry32,
  type KinCar,
} from './engine.ts';
import {
  makeRoute, routeTrack, type Route, type RouteTrack, type PoiKind,
} from './route.ts';
import { FAM_NAMES } from './terrain.ts';   // n°33 : familles gameplay (6)

export const TANK_L = 520;
export const FUEL_K1 = 0.0025;   // L/s par 1000 tr/min (moteur qui tourne)
export const FUEL_K2 = 0.0137;   // L/s par (pédale × 1000 tr/min) (charge)
export const FUEL_IDLE_LPS = 0.00035; // moteur tournant à l'arrêt
export const FATIGUE_EMERG_H = 30;   // arrêt de survie en bord de route
export const REFUEL_MIN = 12;
export const REPAIR_MIN = 30;
export const DRY_ASSIST_MIN = 120;    // panne sèche : assistance lente
export const DRY_ASSIST_L = 150;
export const ROADSIDE_H = 8;          // sommeil de survie en bord de route
export const ROADSIDE_EFF = 0.5;     // récupération de moitié
export const POI_SEARCH_M = 200_000;  // recherche du prochain point d'arrêt
export const EVENTS_MAX = 60;

/* ============ MÉTÉO — déterministe par tronçon (grip seulement, vision) ============
   La pluie réduit μ du biome : la voiture ralentit toute seule. Tirée
   du PRNG semé par (graine, zone) — jamais de hasard de simulation,
   l'incertitude viendra de l'information non révélée (bulletins). */
export const WEATHER_ZONE_M = 50_000;  // tronçon météo : 50 km
export const RAIN_P = 0.25;            // probabilité d'un tronçon pluvieux
export const RAIN_MU = 0.75;           // μ × 0,75 sous la pluie
export function weatherRain(seed: number, s: number): boolean {
  const zone = Math.floor(Math.max(0, s) / WEATHER_ZONE_M);
  return mulberry32(((seed ^ 0x5ea7a11) | 0) + Math.imul(zone + 1, 2654435761) | 0)() < RAIN_P;
}

/* ============ GOMMES ============
   TENDRES : grip haut, usure rapide · DURES : grip moindre, usure lente
   · PLUIE : grip normal sous la pluie, dégradé sur sec. Le choix se
   fait à la préparation ; le changement se fait au garage. */
export type TireKind = 'tendres' | 'dures' | 'pluie';
export const TIRES: Record<TireKind, { grip: number; wetGrip: number; wear: number; price: number }> = {
  /* n°30 : wear calibré pour des vies ~6 h (tendres) · ~12 h (dures) · ~8 h
     (pluie) à l'usage moyen du peloton (grip sollicité ≈ 0,58, mesuré sur la
     course de référence n°27). Rapports exacts 2 : 1,5 : 1 — la dure est la
     référence wear = 1. Grip/wetGrip/prix inchangés : pure durabilité. */
  tendres: { grip: 1.06, wetGrip: 0.80, wear: 2.0, price: 900 },
  dures:   { grip: 0.96, wetGrip: 0.78, wear: 1.0, price: 700 },
  pluie:   { grip: 1.00, wetGrip: 1.02, wear: 1.5, price: 800 },
};
export const TIRE_WEAR_MAX = 1;         // jauge d'usure : 0 neuve → 1 morte
export const TIRE_WORN_MU = 0.85;       // grip résiduel d'une gomme usée
export const PUNCTURE_WORN_P = 0.05;   // à chaque PAS où la gomme est morte

/* ============ CONTACTS & FAUTES (le sel de la course) ============
   Chaque MANŒUVRE DE DOUBLAGE lancée porte un risque dosé : tirage
   via le PRNG semé du cœur (jamais Math.random — ADR 0004). Une
   course prudente ne produit presque rien ; attaquer souvent
   s'expose. JAMAIS de fin de course par accident. */
export const CONTACT_P = 0.10;          // risque de contact PAR MANŒUVRE de doublage
export const CONTACT_COOLDOWN_S = 120;  // délai mini entre deux manœuvres à risque
export const CONTACT_SEV_HEAVY = 0.35;  // part des contacts « lourds »
export const STOPANDGO_MIN = 2;         // pénalité stop-and-go (prochain POI)
export const FINE_HEAVY = 1500;         // amende (faute lourde)
/* n°29 : littéraux externalisés (AUCUNE valeur modifiée — preuve par
   re-simulation bit à bit, cf. commit séparé) */
export const DUEL_VISION_M = 40;        // vision du devancier (nearestAhead)
export const BRAKE_STYLE_PLAYER = 0.75; // style de freinage du pilote (speedTarget f)
export const FOLLOW_GAIN = 0.35;        // gain de la fermeture douce de suivi
export const LAT_DOOR_M = 1.9;          // porte latérale (duel + pincement + faute)
export const PARKED_PUSH_LAT_MIN = 1.4;// seuil de poussette d'une voiture garée
export const PARKED_PUSH_M = 2.2;      // poussée latérale de la garée (resolvePairs)
export const ROAD_USE_FRAC = 0.9;      // fraction de demi-largeur utilisable (garée)
export const PARKED_MIN_EDGE = 0.3;    // butée mini de la garée
export const TIRE_WEAR_FULL_H = 3600 * 7; // n°30 : heures à PLEIN GRIP (cercle saturé en continu) pour user une gomme wear=1 (dures) — à l'usage peloton (~0,58) : dures ~12 h, tendres ~6 h, pluie ~8 h
export const STRESS_FATIGUE = 0.5;     // poids fatigue dans la gravité contact
export const STRESS_NIGHT = 0.2;       // poids nuit
export const HEAVY_PUNCTURE_P = 0.5;   // crevaison vs dégât lourd (tirage)
export const APEX_MIN_OVERLAP = 1.2;   // avance mini à la corde (rétroviseur)
export const REG_THR_MIN = 0.15;       // régularité : pédale mini « stable »
export const REG_THR_MAX = 0.98;       // régularité : pédale maxi « stable »
export const REG_ACC_MAX = 0.6;        // régularité : accélération max « stable »
export const REG_V_MIN = 5;           // régularité : vitesse mini
export const SLEEP_DEFAULT_H = 7;      // heures de sommeil par défaut (sleep au km)
export const GEAR_DERIVE_MIN_RPM = 2500; // rpm mini de dérivation de rapport (reprise)
export const BULLETIN_STEP_M = 70_000; // bulletins : pas de tronçon
export const BULLETIN_AHEAD = 3;       // bulletins : nb de tronçons annoncés

/* ============ AGRESSIVITÉ DE CONDUITE (3 niveaux, plan du joueur) ============
   Réglage du programmateur, comme le curseur moteur. Le niveau modifie
   UNIQUEMENT la fréquence et l'audace des manœuvres — le risque de contact
   PAR MANŒUVRE (CONTACT_P) est IDENTIQUE pour tous (décision 2026-10-16) :
   l'agressif s'expose parce qu'il attaque plus souvent, dans des fenêtres
   plus serrées, en collant au devancier.
   gapMax (m)      : écart au devancier qui déclenche l'examen d'attaque ;
   dvReq (m/s)     : avantage de vitesse exigé pour attaquer
                     (peut être négatif : attaquer à vitesse égale) ;
   margin (m)      : marge latérale visée AU-DELÀ de CAR_D ;
   pressMps (m/s)  : bonus de vitesse pendant une manœuvre lancée ;
   followDead (m)  : bande morte de la garde de suivi — la pression
                     PERMANENTE : plus elle est petite, plus la voiture
                     colle au devancier hors attaque (exposition au
                     pincement resolvePairs) ;
   cooldownS (s)   : délai mini entre deux manœuvres à risque. */
export type Aggression = 'securite' | 'standard' | 'agressif';
export const AGG: Record<Aggression, {
  gapMax: number; dvReq: number; margin: number;
  pressMps: number; followDead: number; cooldownS: number;
}> = {
  securite: { gapMax: 6,  dvReq: 1.5,  margin: 0.40, pressMps: 1.5, followDead: 3.5, cooldownS: 180 },
  standard: { gapMax: 12, dvReq: -0.5, margin: 0.15, pressMps: 2.5, followDead: 2.0, cooldownS: CONTACT_COOLDOWN_S },
  agressif: { gapMax: 20, dvReq: -1.5, margin: 0.05, pressMps: 4.0, followDead: 0.8, cooldownS: 60 },
};

/* normalisation : un plan ancien (sérialisé avant ce champ) ou invalide
   conduit en 'standard' — JAMAIS de valeur par défaut cachée ailleurs */
export function aggrOf(car: RaceCar): Aggression {
  const a = (car.plan as { aggression?: Aggression }).aggression;
  return a !== undefined && a in AGG ? a : 'standard';
}
export const CONTACT_SLOW_S = 30;       // ralentissement après contact léger
export const PUNCTURE_CAP_KMH = 70;    // crevaison : mode dégradé bridé (n°27 : 85 → 70, décision Tanguy)
export const HEAVY_POWER = 0.3;        // dégât lourd : moteur à 30 % de capacité (n°27)

/* ============ BUDGET — revenu périodique, dépenses (vision) ============
   Base fixe + bonus position + bonus de régularité (moitié rythme de
   croisière stable, moitié absence d'incident). Formules en constantes :
   l'équilibrage se fera en course test. */
export const BUDGET_START = 20000;      // € de départ
export const BUDGET_BASE_H = 800;       // €/h de base
export const BUDGET_POS_H = 500;        // €/h max du bonus position
export const BUDGET_REG_H = 400;        // €/h max du bonus de régularité
export const REG_SPEED_BAND = 3;        // m/s : écart max à la croisière pour « stable »
export const REG_STABLE_T = 300;        // s : durée de stabilité requise
export const FUEL_PRICE = 1.9;         // €/L
export const REPAIR_PRICE = 2200;       // réparation dégât lourd au garage
export const BULLETIN_H = 3;            // bulletins d'étape : toutes les 3 h
/* ============ CB DE PROXIMITÉ — canal global, réception par distance ============
   Chaque équipe ne reçoit que les messages des équipes à ≤ CB_RANGE_KM.
   Anti-flood simple : CB_MIN_INTERVAL_S entre deux messages d'une même
   équipe. L'historique vit côté serveur (ordonnancement d'arrivée). */
export const CB_RANGE_KM = 100;         // portée de réception (km)
export const CB_MIN_INTERVAL_S = 5;     // anti-flood par équipe

/* ---- Paramétrage d'une course (page admin) : tout réglage a sa
   constante exportée nommée — l'équilibrage se règle en course test,
   jamais en dur dans la boucle (vision : « ces réglages se feront en
   condition réelle »). ---- */
export const MAX_CARS = 40;          // grille : premiers arrivés
export const SURVIVAL_DEFAULT_H = 24; // arrêt de survie sans connexion (h)
export type RaceConfig = {
  seed: number;
  totalKm: number;
  startEpochMs: number;     // date/heure réelle de départ (Paris affiché)
  prepMinutes: number;       // fenêtre de préparation avant départ
  endType: 'distance' | 'duration';
  endHours: number;         // durée de course si endType = 'duration'
  survivalHours: number;    // sans connexion → arrêt au POI (arrêt de survie)
  poiDensity: number;       // multiplicateur de densité des POI (1 = nominal)
  maxCars: number;
};

export const DEFAULT_CONFIG: RaceConfig = {
  seed: 42,
  totalKm: 1000,
  /* 0, pas Date.now() : le cœur ne lit JAMAIS l'horloge (ADR 0004) —
     le serveur et les tests écrasent toujours cette valeur */
  startEpochMs: 0,
  prepMinutes: 60,
  endType: 'distance',
  endHours: 24 * 7,
  survivalHours: SURVIVAL_DEFAULT_H,
  poiDensity: 1,
  maxCars: MAX_CARS,
};

/* ---- Déroulé de course : préparation (compte à rebours, grille
   ouverte) → course → fin (podium figé jusqu'au reset). ---- */
export type RacePhase = 'preparation' | 'racing' | 'finished';

export type PlanAction =
  | { id: number; type: 'refuel' | 'sleep' | 'repair'; atKm?: number; hours?: number }
  | { id: number; type: 'refuel'; ifTag: 'fuelLow'; threshold: number }
  | { id: number; type: 'sleep'; ifTag: 'fatigueHigh'; threshold: number; hours: number }
  | { id: number; type: 'repair'; ifTag: 'tireWorn'; threshold: number }
  | { id: number; type: 'power'; power: number }
  | { id: number; type: 'tires'; tire: TireKind };

export type Plan = { power: number; aggression?: Aggression; actions: PlanAction[] };

export type CarStatus = 'run' | 'toStop' | 'stop' | 'dry' | 'finish';

export type RaceEvent = { t: number; msg: string };

export type RaceCar = KinCar & {
  id: number;
  name: string;
  color: string;
  fuel: number;        // litres
  fatigue: number;     // heures de veille
  st: CarStatus;
  stopKind: PoiKind | 'dry' | 'roadside' | null;
  stopUntil: number;   // simT de fin d'arrêt
  stopHours: number;   // sommeil en cours (h)
  targetS: number | null; // abscisse du point d'arrêt visé
  plan: Plan;
  finishedAt: number | null;
  events: RaceEvent[];
  owner: string | null;      // compte joueur propriétaire (null = non attribuée)
  lastSeenSimT: number;      // dernière connexion de SON joueur (arrêt de survie)
  survivalStop: boolean;     // vrai pendant l'arrêt de survie POI
  survivalKind: PoiKind | null;   // genre du POI de survie visé — reprise après dry (n°27)
  dryAssisted: boolean;           // une assistance sèche déjà versée pendant la survie (n°27)
  tire: TireKind;           // gommes montées
  tireWear: number;         // usure 0 (neuve) → 1 (morte)
  punctured: boolean;       // crevaison : mode dégradé jusqu'au garage
  budget: number;           // € (jauge : revenus − dépenses)
  incidents: number;        // incidents de course (bonus régularité)
  regTimer: number;        // secondes consécutives à rythme stable
  pendingSG: boolean;      // stop-and-go dû au prochain POI (faute)
  contactSlowT: number;    // ralentissement restant après contact léger
  attackMan: boolean;      // une MANŒUVRE de doublage est lancée (risque tiré 1 fois)
  attackCooldown: number;  // délai avant une nouvelle manœuvre à risque
  autoCreated: boolean;    // attribuée automatiquement au départ (personnalisable une fois)
  heavyDamage: boolean;     // dégât lourd : réparation obligatoire au garage
};

export type Race = {
  seed: number;
  totalKm: number;
  route: Route;
  trk: RouteTrack;
  cars: RaceCar[];
  simT: number;        // secondes de simulation écoulées
  doneSteps: number;
  startEpochMs: number; // epoch réelle correspondant à simT = 0
  timeScale: number;
  finished: boolean;
  config: RaceConfig;
  phase: RacePhase;      // préparation → course → fin
  departed: boolean;     // vrai dès que le départ a été donné (horloge serveur)
  endSimT: number;       // fin par durée (secondes sim)
  rng: CountedRng;      // PRNG semé des contacts (jamais Math.random), compté
  lastBulletinT: number; // heure du dernier bulletin d'étape
};

/* PRNG compté : même graine ⇒ même séquence (ADR 0004), et le nombre
   d'appels est sérialisé — la reprise rejoue exactement les tirages
   déjà consommés (replays, redémarrage serveur). */
export type CountedRng = { (): number; calls: number };
export function makeCountedRng(seed: number): CountedRng {
  const base = mulberry32(seed);
  const f = () => { f.calls++; return base(); };
  f.calls = 0;
  return f;
}

let planIdNext = 1;
export function newPlanId(): number {
  return planIdNext++;
}

export function defaultPlan(carId: number): Plan {
  /* IDs dérivés de la voiture : le plan par défaut est déterministe
     (même course ⇒ même sérialisation, garantie ADR 0004) */
  return {
    power: 1,
    aggression: 'standard',
    actions: [
      { id: carId * 1000 + 1, type: 'refuel', ifTag: 'fuelLow', threshold: 0.18 },
      { id: carId * 1000 + 2, type: 'sleep', ifTag: 'fatigueHigh', threshold: 20, hours: 7 },
      { id: carId * 1000 + 3, type: 'repair', ifTag: 'tireWorn', threshold: 0.85 },
    ],
  };
}

export function makeCar(id: number, name: string, color: string, gridS: number): RaceCar {
  return {
    id, name, color,
    s: gridS, v: 0, d: 0, dSm: 0, dRate: 0, roll: 0, pitch: 0,
    acc: 0, thr: 0, brkCmd: 0, grip: 0, abs: 0, steer: 0, pwr: 1,
    gear: 0, rpm: 1000, shiftT: 0,
    fuel: TANK_L, fatigue: 0,
    st: 'run', stopKind: null, stopUntil: 0, stopHours: 0, targetS: null,
    plan: defaultPlan(id),
    finishedAt: null,
    events: [],
    owner: null,
    lastSeenSimT: 0,
    survivalStop: false,
    survivalKind: null,
    dryAssisted: false,
    tire: 'dures',
    tireWear: 0,
    punctured: false,
    budget: BUDGET_START,
    incidents: 0,
    regTimer: 0,
    pendingSG: false,
    contactSlowT: 0,
    attackMan: false,
    attackCooldown: 0,
    autoCreated: false,
    heavyDamage: false,
  };
}

export function makeRace(cfg: RaceConfig, timeScale = 1): Race {
  const route = makeRoute(cfg.seed, cfg.totalKm, cfg.poiDensity);
  return {
    seed: cfg.seed, totalKm: cfg.totalKm, route, trk: routeTrack(route),
    cars: [], simT: 0, doneSteps: 0,
    startEpochMs: cfg.startEpochMs, timeScale, finished: false,
    config: cfg,
    /* phase initiale : PREPARATION si le départ est dans le futur, course
       sinon — MAIS la transition ne se fait que par horloge du SERVEUR
       (jamais Date.now() dans le cœur déterministe : un replay ou un test
       qui reconstruit la course au bit près doit retrouver la même phase ;
       c'est stepRace qui reçoit l'info « départ passé ») */
    phase: 'preparation',
    departed: false,
    rng: makeCountedRng(((cfg.seed ^ 0xc027ac7) | 0) + 0x9e37),
    lastBulletinT: 0,
    endSimT: cfg.endType === 'duration' ? cfg.endHours * 3600 : Infinity,
  };
}

export function addCar(race: Race, name: string, color: string): RaceCar {
  const car = makeCar(race.cars.length, name, color, race.cars.length * 6);
  race.cars.push(car);
  return car;
}

function log(car: RaceCar, t: number, msg: string) {
  car.events.push({ t, msg });
  if (car.events.length > EVENTS_MAX) car.events.shift();
}

/* Formatteurs Intl construits UNE FOIS : instanciés à chaque pas de
   simulation, ils explosaient la mémoire (~0,7 Mo par construction,
   120 appels/s). Pas de cache de valeur global : un cache partagé
   entre deux courses de même simT serait FAUX ; format() par pas
   reste trivial. */
const FMT_HM = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris', hour: 'numeric', minute: 'numeric', hour12: false,
});
const FMT_CLOCK = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});

export function parisHour(race: Race): number {
  const d = new Date(race.startEpochMs + race.simT * 1000);
  const h = FMT_HM.format(d);
  return Number(h.split(':')[0]) + Number(h.split(':')[1]) / 60;
}

export function parisClock(race: Race): string {
  const d = new Date(race.startEpochMs + race.simT * 1000);
  return FMT_CLOCK.format(d);
}

/* μ EFFECTIF du sol pour une voiture : biome × pluie (réduit μ, vision :
   « la voiture ralentit toute seule ») × gomme (secs vs pluie — les pluie
   compensent, les secs y perdent) × usure (jauge : grip résiduel). */
function muFactor(race: Race, car: RaceCar): number {
  const rain = weatherRain(race.seed, car.s);
  const tire = TIRES[car.tire];
  const wet = rain ? tire.wetGrip : tire.grip;
  const worn = TIRE_WORN_MU + (1 - TIRE_WORN_MU) * Math.max(0, 1 - car.tireWear);
  return rain ? RAIN_MU * wet * worn : wet * worn;
}

/* proxy Track par voiture : injecte le μ effectif (gomme + météo) dans
   le moteur — la physique (cercle de friction) ne change pas, seule la
   sonde μ est réécrite. */
function carTrack(race: Race, car: RaceCar): RouteTrack {
  const trk = race.trk;
  const f = muFactor(race, car);
  return {
    ...trk,
    muAt: (s: number) => trk.muAt(s) * f,
  };
}

function poiDuration(car: RaceCar): number {
  switch (car.stopKind) {
    case 'station': return REFUEL_MIN * 60 + (car.pendingSG ? STOPANDGO_MIN * 60 : 0);
    case 'garage': return REPAIR_MIN * 60 + (car.pendingSG ? STOPANDGO_MIN * 60 : 0);
    case 'hotel': return car.stopHours * 3600;
    case 'dry': return DRY_ASSIST_MIN * 60;
    case 'roadside': return ROADSIDE_H * 3600;
    default: return 0;
  }
}

function engageStop(race: Race, car: RaceCar, kind: PoiKind, hours: number) {
  const pois = race.trk.poisAhead(car.s + 1, POI_SEARCH_M).filter((p) => p.kind === kind);
  const poi = pois[0];
  if (!poi) return false;
  car.st = 'toStop';
  car.stopKind = kind;
  car.stopHours = hours;
  car.targetS = poi.s;
  log(car, race.simT, `Cap sur ${kind === 'station' ? 'la station' : kind === 'hotel' ? "l'hôtel" : 'le garage'} au km ${(poi.s / 1000).toFixed(1)}`);
  return true;
}

function endStop(race: Race, car: RaceCar) {
  /* arrêt de survie : figé jusqu'à la reconnexion de SON joueur —
     aucun service ne s'applique, aucun faux message de reprise.
     EXCEPTION n°27 : la panne sèche est une urgence mécanique —
     l'assistance se termine TOUJOURS, sinon la voiture reste figée à
     sec pour toujours et bloque la route derrière elle (mesuré). */
  if (car.survivalStop && car.stopKind !== 'dry') return;
  if (car.stopKind === 'station') {
    /* dépense : carburant facturé au litre (vision : « dépenses :
       carburant, pneus, réparations, amendes ») */
    const litres = TANK_L - car.fuel;
    car.budget -= litres * FUEL_PRICE;
    car.fuel = TANK_L;
    car.dryAssisted = false;
    log(car, race.simT, `Plein fait (${Math.round(litres)} L, ${Math.round(litres * FUEL_PRICE)} €) — repart`);
  } else if (car.stopKind === 'hotel') {
    car.fatigue = Math.max(0, car.fatigue - car.stopHours);
    log(car, race.simT, `Réveil — ${car.stopHours} h de sommeil à l'hôtel`);
  } else if (car.stopKind === 'dry') {
    car.fuel = DRY_ASSIST_L;
    log(car, race.simT, `Assistance terminée — ${DRY_ASSIST_L} L versés, repart`);
  } else if (car.stopKind === 'roadside') {
    car.fatigue = Math.max(0, car.fatigue - ROADSIDE_H * ROADSIDE_EFF);
    log(car, race.simT, 'Sommeil de survie en bord de route terminé');
  } else if (car.stopKind === 'garage') {
    /* garage : changement de gommes prévu au plan + réparations —
       la crevaison et le dégât lourd se réparent TOUJOURS (jamais de
       fin de course par accident), la gomme demandée est facturée */
    const tireAct = car.plan.actions.find((a) => a.type === 'tires');
    if (tireAct && tireAct.type === 'tires') {
      car.tire = tireAct.tire;
      car.budget -= TIRES[tireAct.tire].price;
      log(car, race.simT, `Gommes ${tireAct.tire} montées (${TIRES[tireAct.tire].price} €)`);
      car.plan.actions = car.plan.actions.filter((a) => a.id !== tireAct.id);
    } else if (car.tireWear >= TIRE_WEAR_MAX || car.punctured) {
      car.tire = 'dures';
      car.budget -= TIRES.dures.price;
      log(car, race.simT, `Gommes dures de secours montées (${TIRES.dures.price} €)`);
    }
    car.tireWear = 0;
    if (car.punctured) { car.punctured = false; log(car, race.simT, 'Crevaison réparée'); }
    if (car.heavyDamage) {
      car.heavyDamage = false;
      car.budget -= REPAIR_PRICE;
      log(car, race.simT, `Réparation terminée (${REPAIR_PRICE} €) — repart`);
    } else {
      log(car, race.simT, 'Au garage — repart');
    }
  }
  if (car.survivalStop) {
    /* n°27 : assistance sèche versée — la voiture rejoint SON point
       d'arrêt de survie (targetS conservé) et s'y fige jusqu'à la
       reconnexion. Déjà arrivée → figée sur place. */
    car.stopKind = car.survivalKind ?? 'station';
    car.dryAssisted = true;
    if (car.targetS !== null && car.s < car.targetS) {
      car.st = 'toStop';
    } else {
      car.st = 'stop';
      car.stopUntil = Infinity;
    }
    return;
  }
  if (car.pendingSG) {
    car.pendingSG = false;
    log(car, race.simT, `Stop-and-go effectué (${STOPANDGO_MIN} min) — repart`);
  }
  car.st = 'run';
  car.stopKind = null;
  car.targetS = null;
}

/* reconnexion du joueur : lève l'arrêt de survie (la voiture repart) */
export function wakeSurvival(race: Race, car: RaceCar) {
  if (!car.survivalStop) return;
  /* n°29 : course terminée → la voiture reste classée (elle ne repart
     pas dans une course finie) */
  if (race.phase === 'finished') return;
  /* n°29 : réveil PENDANT une assistance sèche — l'assistance se
     termine immédiatement (carburant versé), le timer ne repart pas
     de zéro et la voiture ne retombe pas dry à l'instant */
  if (car.st === 'stop' && car.stopKind === 'dry') {
    car.fuel = Math.max(car.fuel, DRY_ASSIST_L);
    car.survivalStop = false;
    car.survivalKind = null;
    car.dryAssisted = false;
    car.stopKind = null;
    car.stopUntil = 0;
    car.st = 'run';
    car.targetS = null;
    car.lastSeenSimT = race.simT;
    log(car, race.simT, `Reconnexion du pilote — assistance terminée (${DRY_ASSIST_L} L) — reprise`);
    return;
  }
  car.survivalStop = false;
  car.survivalKind = null;
  car.dryAssisted = false;
  car.stopKind = null;
  car.targetS = null;
  car.stopUntil = 0;
  car.st = 'run';
  car.lastSeenSimT = race.simT;
  log(car, race.simT, 'Reconnexion du pilote — reprise de la route');
}

function evalPlan(race: Race, car: RaceCar) {
  const acts = car.plan.actions;
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i]!;
    if (a.type === 'power') {
      car.plan.power = a.power;
      car.pwr = a.power;
      acts.splice(i, 1);
      log(car, race.simT, `Curseur moteur réglé à ${Math.round(a.power * 100)} %`);
      return;
    }
    if (a.type === 'sleep' && 'ifTag' in a && a.ifTag === 'fatigueHigh') {
      if (car.fatigue > a.threshold) {
        if (engageStop(race, car, 'hotel', a.hours)) acts.splice(i, 1);
        return;
      }
    } else if (a.type === 'refuel' && 'ifTag' in a && a.ifTag === 'fuelLow') {
      if (car.fuel / TANK_L < a.threshold) {
        if (engageStop(race, car, 'station', 0)) acts.splice(i, 1);
        return;
      }
    } else if (a.type === 'repair' && 'ifTag' in a && a.ifTag === 'tireWorn') {
      /* n°28 : les gommes sont une jauge comme le carburant et la
         fatigue — la réparation se déclenche sur l'USURE (mesurable),
         pas sur un kilomètre deviné à la préparation. Une voiture
         déjà en route vers SON garage ne re-cible pas (un plan
         réarmé à la connexion ne doit pas détourner l'arrêt en
         cours) ; la règle consommée se réarme à l'actualisation
         suivante du plan, comme les deux autres règles. */
      /* n°29 : la garde anti-re-ciblage couvre TOUT arrêt en cours (la
         version n°28 ne protégeait que le garage — une voiture en route
         vers sa station pouvait être détournée vers un garage plus
         loin et rater son plein → panne sèche) */
      if (car.tireWear >= a.threshold && car.st !== 'toStop') {
        if (engageStop(race, car, 'garage', 0)) acts.splice(i, 1);
        return;
      }
    } else if (a.type !== 'tires' && a.atKm !== undefined) {
      if (car.s / 1000 >= a.atKm) {
        /* n°27 : le type d'action n'est PAS un genre de POI — mapping
           explicite. L'ancien `a.type as PoiKind` ne matchait JAMAIS
           ('repair' ≠ 'garage') : aucun arrêt garage possible. */
        const kind: PoiKind = a.type === 'refuel' ? 'station'
          : a.type === 'sleep' ? 'hotel' : 'garage';
        const hours = a.type === 'sleep' ? ((a as { hours?: number }).hours ?? SLEEP_DEFAULT_H) : 0;
        const ok = engageStop(race, car, kind, hours);
        if (ok) acts.splice(i, 1);
        return;
      }
    }
  }
}

type DuelInfo = { front: RaceCar | null; attackSide: number };

function nearestAhead(race: Race, car: RaceCar): RaceCar | null {
  let best: RaceCar | null = null;
  let bestGap = Infinity;
  for (const o of race.cars) {
    if (o.id === car.id) continue;
    const gap = o.s - car.s;
    if (gap > 0 && gap < DUEL_VISION_M && gap < bestGap) { best = o; bestGap = gap; }
  }
  return best;
}

function stepCar(race: Race, car: RaceCar, hour: number, dt: number): DuelInfo {
  const trk = carTrack(race, car);
  const front = nearestAhead(race, car);
  const info: DuelInfo = { front, attackSide: 0 };

  if (car.st === 'finish') {
    car.v = 0;
    return info;
  }

  if (car.st === 'stop') {
    car.v = 0;
    car.thr = 0; car.brkCmd = 0;
    /* n°29 : moteur COUPÉ à l'arrêt (hôtel, survie, garage) — l'ancien
       ralenti vidait ~30 L/jour une voiture garée, et une survie longue
       revenait avec un réservoir entamé sans que le joueur ait roulé */
    if (car.stopKind === 'hotel') {
      car.fatigue = Math.max(0, car.fatigue - dt / 3600);
    } else {
      car.fatigue += dt / 3600;
    }
    if (race.simT >= car.stopUntil) endStop(race, car);
    return info;
  }

  if (car.st === 'toStop') {
    if (car.targetS !== null && car.s >= car.targetS) {
      car.st = 'stop';
      car.s = car.targetS;
      car.v = 0;
      car.stopUntil = car.survivalStop ? Infinity : race.simT + poiDuration(car);
      if (car.survivalStop) {
        log(car, race.simT, 'ARRÊT DE SURVIE — la voiture dort ici jusqu\'à la reconnexion de son pilote');
      } else {
        const label = car.stopKind === 'station' ? 'Ravitaillement' : car.stopKind === 'hotel' ? 'Coucher' : car.stopKind === 'garage' ? 'Au garage' : 'Arrêt';
        log(car, race.simT, `${label} — arrêt de ${Math.round(poiDuration(car) / 60)} min`);
      }
      return info;
    }
  }

  if (car.fuel <= 0) {
    /* n°27 : pendant un arrêt de survie, une SEULE assistance sèche —
       une deuxième panne fige la voiture en bord de route (jamais de
       cycle d'assistance sans fin). */
    if (car.survivalStop && (car.dryAssisted ?? false)) {
      car.st = 'stop';
      car.stopKind = 'roadside';
      car.v = 0;
      car.stopUntil = Infinity;
      log(car, race.simT, 'ARRÊT DE SURVIE — joueur absent, immobilisée en bord de route (plus de carburant)');
      return info;
    }
    car.st = 'stop';
    car.stopKind = 'dry';
    car.v = 0;
    car.stopUntil = race.simT + DRY_ASSIST_MIN * 60;
    log(car, race.simT, 'PANNE SÈCHE — assistance en route (2 h)');
    return info;
  }

  /* ARRÊT DE SURVIE (vision, amendement ADR 0002) : sans connexion de
     SON joueur depuis config.survivalHours, la voiture s'arrête au
     prochain POI (station de préférence) et ne repart qu'à SA
     reconnexion. Distinct de l'arrêt bord de route pour fatigue. */
  if (!car.survivalStop && race.phase === 'racing' && car.owner !== null
      && race.simT - car.lastSeenSimT > race.config.survivalHours * 3600) {
    const kinds: PoiKind[] = ['station', 'hotel', 'garage'];
    let engaged = false;
    for (const k of kinds) {
      if (engageStop(race, car, k, 0)) { engaged = true; break; }
    }
    if (engaged) {
      car.survivalStop = true;
      car.survivalKind = car.stopKind;    // n°27 : mémorisé pour reprendre après une panne sèche
      log(car, race.simT, 'ARRÊT DE SURVIE — joueur absent, la voiture dort à un point d\'arrêt');
    } else {
      car.survivalStop = true;
      car.survivalKind = null;
      car.st = 'stop';
      car.stopKind = 'roadside';
      car.v = 0;
      car.stopUntil = Infinity;
      log(car, race.simT, 'ARRÊT DE SURVIE — joueur absent, arrêt en bord de route (aucun POI)');
    }
  }
  if (car.fatigue > FATIGUE_EMERG_H) {
    car.st = 'stop';
    car.stopKind = 'roadside';
    car.v = 0;
    car.stopUntil = race.simT + ROADSIDE_H * 3600;
    log(car, race.simT, 'FATIGUE CRITIQUE — sommeil de survie en bord de route (8 h, moitié efficace)');
    return info;
  }

  /* n°27 : dégât lourd = moteur bridé à HEAVY_POWER (30 %) — la
     réparation au garage (endStop) rend la pleine puissance. Le
     curseur joueur reste la référence, le facteur est multiplicatif. */
  car.pwr = car.plan.power * (car.heavyDamage ? HEAVY_POWER : 1);
  evalPlan(race, car);

  /* n°24 : PLUS DE PLAFOND — la vitesse est purement physique
     (chaîne de freinage inductive + boîte 6 + rupteur). La fatigue ne
     bride plus la vitesse (l'arrêt de survie 30 h reste) ; la nuit
     reste la nuit pour le rendu et la gravité de contact. */
  const draft = front ? draftMul(car, front) : 1;
  let vT = speedTarget(trk, car.s, FLAT, BRAKE_STYLE_PLAYER);
  /* SUIVI ANTICIPATIF + DUEL CÔTÉ LIBRE — la décision se prend AVANT
     driveStep (elle ne dépend que de front.d/hwDuel/gap/car.v) :
     - côté d'attaque : on essaie d'abord le côté OPPOSÉ à celui où
       est le meneur, puis l'autre ; on n'attaque QUE si la chaussée
       offre réellement CAR_D de séparation (sinon : on suit, le
       dépassement attend une zone assez large) ;
     - cap de suivi : vitesse cible qui ferme l'écart en douceur et
       tombe à zéro derrière un arrêt (stop/dry/finish), avec un petit
       bonus si une manœuvre est engagée. Remplace le suiveur aveugle
       qui fonçait dans le pare-chocs et se faisait pincer. */
  let dT = raceLineTarget(trk, car.s);
  const A = AGG[aggrOf(car)];
  if (front) {
    const gap = front.s - car.s;
    const hwDuel = Math.min(trk.wAt(car.s), trk.wAt(front.s)) - EDGE_MARGIN;
    /* n°27 : une voiture ARRÊTÉE n'est pas un duel — l'examen
       d'attaque passe pour TOUS les profils (dvReq forcé ≤ −0,5),
       sinon le profil sécurité ne dépasse jamais un arrêté :
       file d'attente infinie (15 h mesurées). Le vrai garde-fou reste
       la porte de largeur n°16 (CAR_D de séparation réelle). */
    const frontStopped = front.st === 'stop' || front.st === 'dry' || front.st === 'finish';
    const dvReqEff = frontStopped ? Math.min(A.dvReq, -0.5) : A.dvReq;
    if (gap < A.gapMax && car.v - front.v > dvReqEff) {
      const want = CAR_D + A.margin;
      for (const sgn of [front.d >= 0 ? -1 : 1, front.d >= 0 ? 1 : -1]) {
        const t = Math.max(-hwDuel, Math.min(hwDuel, front.d + sgn * want));
        if (Math.abs(t - front.d) >= CAR_D) {
          info.attackSide = sgn;
          dT = t;
          break;
        }
      }
    }
    if (gap < CAR_L && info.attackSide !== 0 && Math.abs(front.d - car.d) < LAT_DOOR_M) {
      const t = Math.max(-hwDuel, Math.min(hwDuel, front.d + info.attackSide * (CAR_D + A.margin)));
      if (Math.abs(t - front.d) >= CAR_D) dT = t;
    }
    const freeGap = gap - CAR_L;
    const vFront = frontStopped ? 0 : front.v;
    vT = Math.min(vT, vFront + Math.max(0, freeGap - A.followDead) * FOLLOW_GAIN
      + (info.attackSide !== 0 ? A.pressMps : 0));
  }
  /* n°27 : crevaison = consigne plafonnée à PUNCTURE_CAP_KMH — la
     chaîne de freinage déccélère proprement, la voiture roule mais
     ne peut plus tenir le rythme. Réparable au garage (endStop).
     APRÈS la garde de suivi : le devant peut réduire davantage,
     jamais augmenter au-delà du cap. */
  if (car.punctured) vT = Math.min(vT, PUNCTURE_CAP_KMH / 3.6);
  driveStep(trk, car, vT, dt, draft);
  const hw = trk.wAt(car.s) - EDGE_MARGIN;
  dT = Math.max(-hw, Math.min(hw, dT));
  lateralStep(car, dT, dt);
  /* ROULIS/TANGAGE : sans cosmeticsStep, roll/pitch restent à 0 et
     la voiture ne penche JAMAIS en virage ni au freinage — le rendu
     3D lit ces champs (suspension cosmétique). Juste après
     lateralStep : le roulis dépend de la consigne latérale, le
     tangage de l'accélération/freinage. Déterministe, sérialisation
     inchangée (roll/pitch déjà persistés). */
  cosmeticsStep(trk, car, dt);
  car.s += car.v * dt;

  car.fatigue += dt / 3600;
  /* CONSO RÉGIME : L/s = ralenti + moteur qui tourne + charge.
     Le curseur pwr ne multiplie plus la formule : il agit PAR LA
     PHYSIQUE (moins de couple -> plus de pédale à v égale -> plus de
     conso). Calibrée sur banc route réelle : plaine ~131 L/100 km
     (autonomie 520 L ≈ 398 km), forêt ~130, aspiration −9 % à v égale. */
  car.fuel = Math.max(0, car.fuel - (FUEL_IDLE_LPS
    + (FUEL_K1 * car.rpm / 1000 + FUEL_K2 * car.thr * car.rpm / 1000)) * dt);

  /* USURE DES GOMMES : proportionnelle au grip sollicité (cercle de
     friction — la gomme travaille) × facteur d'usure du type monté */
  car.tireWear = Math.min(TIRE_WEAR_MAX, car.tireWear
    + car.grip * TIRES[car.tire].wear * dt / (TIRE_WEAR_MAX * TIRE_WEAR_FULL_H));
  /* crevaison surprise : gomme morte → risque par pas, PRNG semé */
  if (!car.punctured && car.tireWear >= TIRE_WEAR_MAX && race.rng() < PUNCTURE_WORN_P) {
    car.punctured = true;
    log(car, race.simT, `CREVAISON — gommes mortes, mode dégradé jusqu\'au garage (${PUNCTURE_CAP_KMH} km/h)`);
  }

  /* MANŒUVRE DE DOUBLAGE = on attaque par le côté à moins de 12 m. Le
     risque est tiré UNE FOIS PAR MANŒUVRE (CONTACT_P), pas à chaque pas :
     une course prudente ne produit presque rien, attaquer souvent
     s'expose. Cooldown entre manœuvres ; la gravité monte avec le
     rythme du moment (fatigue + nuit + vitesse). */
  if (car.attackCooldown > 0) car.attackCooldown -= dt;
  /* n°27 : pas de tirage de contact pour dépasser un ARRÊTÉ —
     le RNG des contacts appartient aux duels entre voitures en mouvement */
  const attacking = info.attackSide !== 0 && front
    && !(front.st === 'stop' || front.st === 'dry' || front.st === 'finish');
  if (attacking && !car.attackMan && car.attackCooldown <= 0) {
    car.attackMan = true;                 // manœuvre lancée
    car.attackCooldown = A.cooldownS;
    if (race.rng() < CONTACT_P) applyContact(race, car, front, hour);
  }
  if (!attacking) car.attackMan = false;  // manœuvre terminée

  /* BUDGET — bonus de régularité (moitié) : rythme de croisière stable =
     vitesse qui ne s'écarte pas de plus de REG_SPEED_BAND m/s de la
     consigne ; l'absence d'incident (moitié) se lit sur car.incidents */
  /* régularité : la consigne de croisière est la vitesse EFFECTIVE
     stable (n°24 : plus de cap — la référence est la vitesse tenue) */
  const stable = car.thr > REG_THR_MIN && car.thr < REG_THR_MAX && Math.abs(car.acc) < REG_ACC_MAX && car.v > REG_V_MIN;
  car.regTimer = stable ? car.regTimer + dt : 0;

  if (car.s >= trk.finishS) {
    car.s = trk.finishS;
    car.st = 'finish';
    car.v = 0;
    car.finishedAt = race.simT;
    log(car, race.simT, 'ARRIVÉE !');
  }
  return info;
}

/* ---- CONTACT : gravité croissante avec le rythme (fatigue + nuit +
   vitesse) ; léger = échange de peinture + ralenti, lourd = crevaison ou
   dégât réparable. JAMAIS de fin de course par accident. ---- */
function applyContact(race: Race, attacker: RaceCar, defender: RaceCar, hour: number) {
  const night = hour >= 22 || hour < 6;
  /* gravité : fatigue + nuit + vitesse haute poussent vers le lourd */
  const stress = Math.min(1,
    attacker.fatigue / FATIGUE_EMERG_H * STRESS_FATIGUE
    + (night ? STRESS_NIGHT : 0)
    /* V_LIM (rupteur 6e ≈ 73,3 m/s = 264 km/h) est la référence
       physique : le terme module la gravité sur toute la plage. */
    + Math.min(0.3, attacker.v / V_LIM * 0.3));
  const heavy = race.rng() < CONTACT_SEV_HEAVY + stress * 0.2;

  /* attribution de la faute — règlement acté (vision.md) :
     INTÉRIEUR : l'attaquant doit placer son essieu avant au moins à
       hauteur du rétroviseur du défenseur AU POINT DE CORDE, sans
       brutalité → ici : assez loin à ses côtés pour avoir la place ;
     EXTÉRIEUR : à hauteur ou devant pour exiger la largeur ;
     côte à côte : espace dû.
     Sans faute claire : incident de course, pas de sanction. */
  const overlap = attacker.s - (defender.s - CAR_L); // avancée de l'attaquant
  const atApexOk = overlap > APEX_MIN_OVERLAP;                   // essieu avant ≥ rétroviseur
  const sideGap = Math.abs(attacker.d - defender.d);
  /* espace dû RELATIF : en forêt/altitude l'écart 1,9 m est
     géométriquement irréalisable (max 1,8 / 1,1 m) — tout contact y
     était une faute automatique ; la place due est plafonnée par la
     chaussée elle-même */
  const hwDuel = Math.min(race.trk.wAt(attacker.s), race.trk.wAt(defender.s)) - EDGE_MARGIN;
  const spaceOk = sideGap >= Math.min(1.9, hwDuel);
  const fault = !atApexOk || !spaceOk;

  if (fault) {
    /* pénalité du fautif : stop-and-go au prochain POI + amende si lourde */
    attacker.pendingSG = true;
    attacker.incidents++;
    if (heavy) attacker.budget -= FINE_HEAVY;
    const msg = heavy
      ? `${attacker.name} pénalisé pour contact sur ${defender.name} — règle de la corde (faute lourde, ${FINE_HEAVY} € d'amende)`
      : `${attacker.name} pénalisé pour contact sur ${defender.name} — règle de la corde`;
    logPublic(race, attacker, defender, msg);
    /* effets physiques du lourd : dégât réparable ou crevaison */
    if (heavy) {
      if (race.rng() < 0.5) {
        attacker.punctured = true;
        logPublic(race, attacker, defender, `${attacker.name} crevé dans le contact`);
      } else {
        attacker.heavyDamage = true;
        logPublic(race, attacker, defender, `${attacker.name} endommagé dans le contact — réparation au garage`);
      }
    }
  } else {
    attacker.incidents++;
    defender.incidents++;
    attacker.contactSlowT = CONTACT_SLOW_S;
    defender.contactSlowT = CONTACT_SLOW_S;
    logPublic(race, attacker, defender, `${attacker.name} et ${defender.name} se touchent — incident de course`);
  }
}

/* journal PUBLIC : un événement de duel va dans le journal des DEUX */
function logPublic(race: Race, a: RaceCar, b: RaceCar, msg: string) {
  log(a, race.simT, msg);
  log(b, race.simT, msg);
}

function resolvePairs(race: Race) {
  const cars = [...race.cars].sort((a, b) => b.s - a.s);
  for (let i = 0; i + 1 < cars.length; i++) {
    const front = cars[i]!;
    const back = cars[i + 1]!;
    const gap = front.s - back.s;
    if (gap < 0) continue;
    const latSep = Math.abs(front.d - back.d);
    const frontStopped = front.st === 'stop' || front.st === 'dry' || front.st === 'finish';
    if (frontStopped && latSep < PARKED_PUSH_LAT_MIN) {
      /* clamp RELATIF : la voiture garée doit rester SUR la chaussée
         (90 % de la demi-largeur utilisable) — l'ancien clamp absolu
         ±2,2 la plaçait hors route en altitude (hw 0,55). Poussée à
         2,2 m : 1,4 ne séparait pas assez pour laisser passer le
         coureur (besoin réel ≈ CAR_D) */
      const lim = Math.max(PARKED_MIN_EDGE, ROAD_USE_FRAC * (race.trk.wAt(front.s) - EDGE_MARGIN));
      front.d = front.d >= back.d ? Math.min(back.d + PARKED_PUSH_M, lim) : Math.max(back.d - PARKED_PUSH_M, -lim);
      front.dSm = front.d;
    }
    /* pincement : TOUTE voiture (y compris garée) — défense dernière :
       avec le suivi anticipatif du stepCar l'écart ne doit jamais s'y
       retrouver, mais si ça arrive, on ne peut plus TRAVERSER une
       voiture arrêtée (l'ancien !frontStopped laissait le coureur
       passer au travers, gap mesuré à -3,6 km) */
    if (gap < CAR_L && latSep < LAT_DOOR_M) {
      back.s = front.s - CAR_L;
      back.v = Math.min(back.v, front.v);
    }
  }
}

/* BUDGET PÉRIODIQUE : base + bonus position + bonus régularité — versé
   en continu (€/h en constantes, équilibrage plus tard en course test). */
export function budgetStep(race: Race, dt: number) {
  if (race.phase !== 'racing') return;
  const ranked = rankCars(race);
  const n = ranked.length || 1;
  for (let i = 0; i < ranked.length; i++) {
    const car = ranked[i]!;
    const posBonus = BUDGET_POS_H * (1 - i / n);            // 1er au max
    const stable = car.regTimer >= REG_STABLE_T ? 0.5 : 0;   // moitié régularité
    const clean = car.incidents === 0 ? 0.5 : 0;            // moitié sans incident
    car.budget += (BUDGET_BASE_H + posBonus + BUDGET_REG_H * (stable + clean)) * dt / 3600;
  }
}

/* BULLETINS D'ÉTAPE : toutes les BULLETIN_H heures de simulation, lu sur
   l'état de la course (biomes + météo des prochains tronçons) —
   déterministe, pas de RNG dédié. Renvoie le texte à diffuser, ou null. */
/* BULLETINS D'ÉTAPE — toutes les BULLETIN_H heures sim, texte lu sur
   l'état de la course (biomes + météo des tronçons devant la tête de
   course) : déterministe, aucun RNG dédié (ADR 0004). Émis dans le
   journal PUBLIC (toutes les voitures). */
export function bulletinsStep(race: Race) {
  if (race.phase !== 'racing') return;
  if (race.simT - race.lastBulletinT < BULLETIN_H * 3600) return;
  race.lastBulletinT = race.simT;
  /* n°33 : les noms de FAMILLES gameplay viennent du champ (terrain.ts
     FAM_NAMES) — les 4 biomes d'abscisse (BIOMES engine.ts) sont
     retirés : le bulletin décrit le monde émergent, pas une étiquette */
  const biomes: Record<number, string> = Object.fromEntries(FAM_NAMES.map((n, i) => [i, n]));
  let lead = 0;
  for (const c of race.cars) if (c.s > lead) lead = c.s;
  const parts: string[] = [];
  for (let d = 0; d < BULLETIN_AHEAD; d++) {
    const s = lead + d * BULLETIN_STEP_M; // tronçons devant la tête
    const rain = weatherRain(race.seed, s);
    const b = Math.floor(race.trk.biomeAt(Math.min(s, race.trk.finishS - 1)));
    parts.push(`${Math.round(s / 1000)} km ${biomes[b] ?? '?'}${rain ? ' (pluie)' : ''}`);
  }
  const msg = `BULLETIN D'ÉTAPE — prochains tronçons : ${parts.join(' · ')}`;
  for (const c of race.cars) log(c, race.simT, msg);
}

export function stepRace(race: Race, nSteps: number) {
  for (let n = 0; n < nSteps; n++) {
    /* déroulé : preparation = compte à rebours réel ; on ne simule pas
       encore ; racing = simulation ; finished = figé (jusqu'au reset) */
    if (race.phase === 'preparation') {
      /* départ donné si la date réelle a passé startEpochMs — testé par
         le SERVEUR (déterminisme : le cœur ne lit jamais l'horloge) */
      if (race.departed) {
        race.phase = 'racing';
        for (const c of race.cars) c.lastSeenSimT = 0;
      } else {
        return;
      }
    }
    if (race.phase === 'finished') return;
    race.simT = (race.doneSteps + 1) * DT;
    race.doneSteps++;
    const hour = parisHour(race);
    for (const car of race.cars) stepCar(race, car, hour, DT);
    resolvePairs(race);
    budgetStep(race, DT);
    bulletinsStep(race);
    /* n°29 : une voiture FIGÉE en arrêt de survie (joueur absent) ne
       doit pas empêcher la course de se terminer — elle est classée au
       kilomètre atteint (vision : « non-arrivés classés au kilomètre
       atteint »). Fin = tout le monde arrivé OU figé-survie. */
    if (!race.finished && race.cars.length > 0 && race.cars.every((c) =>
      c.st === 'finish' || (c.survivalStop && (c.st === 'stop' || c.st === 'toStop')))) {
      race.finished = true;
      race.phase = 'finished';
      for (const c of race.cars) {
        if (c.st !== 'finish') {
          c.st = 'finish';
          c.v = 0;
          c.finishedAt = race.simT;
          log(c, race.simT, 'Fin de course — classé au kilomètre atteint (pilote absent)');
        }
      }
    }
    /* fin par DURÉE : les non-arrivés sont classés au kilomètre atteint */
    if (race.phase === 'racing' && race.simT >= race.endSimT) {
      race.finished = true;
      race.phase = 'finished';
      for (const c of race.cars) {
        if (c.st !== 'finish') {
          c.st = 'finish';
          c.v = 0;
          c.finishedAt = race.simT;
          log(c, race.simT, 'Fin de course (durée) — classé au kilomètre atteint');
        }
      }
    }
  }
}

export function rankCars(race: Race): RaceCar[] {
  return [...race.cars].sort((a, b) => {
    if (a.st === 'finish' && b.st === 'finish') {
      /* n°27 : fin par durée → même finishedAt pour tous les classés :
         on départage au KILOMÈTRE ATTEINT (vision : « non-arrivés
         classés au kilomètre atteint ») — jamais l'ordre d'insertion */
      const d = (a.finishedAt ?? 0) - (b.finishedAt ?? 0);
      if (d !== 0) return d;
      return b.s - a.s;
    }
    if (a.st === 'finish') return -1;
    if (b.st === 'finish') return 1;
    return b.s - a.s;
  });
}

type SerializedRace = Pick<Race, 'seed' | 'totalKm' | 'simT' | 'doneSteps' | 'startEpochMs' | 'timeScale' | 'finished' | 'endSimT'> & {
  cars: RaceCar[];
  nextPlanId: number;
  config: RaceConfig;
  phase: RacePhase;
  departed: boolean;
  rngCalls: number;
  lastBulletinT: number;
};

export function serializeRace(race: Race): string {
  return JSON.stringify({
    seed: race.seed,
    totalKm: race.totalKm,
    simT: race.simT,
    doneSteps: race.doneSteps,
    startEpochMs: race.startEpochMs,
    timeScale: race.timeScale,
    finished: race.finished,
    endSimT: race.endSimT,
    config: race.config,
    phase: race.phase,
    departed: race.departed,
    rngCalls: race.rng.calls,
    lastBulletinT: race.lastBulletinT,
    cars: race.cars.map((c) => ({ ...c })),
    nextPlanId: planIdNext,
  } satisfies SerializedRace);
}

export function deserializeRace(raw: string): Race {
  const d = JSON.parse(raw) as SerializedRace;
  const race = makeRace({ ...DEFAULT_CONFIG, ...d.config, startEpochMs: d.startEpochMs, seed: d.seed, totalKm: d.totalKm }, d.timeScale);
  race.simT = d.simT;
  race.doneSteps = d.doneSteps;
  race.finished = d.finished;
  race.phase = d.phase ?? (d.simT > 0 ? 'racing' : 'preparation');
  race.departed = d.departed ?? race.phase !== 'preparation';
  race.lastBulletinT = d.lastBulletinT ?? 0;
  /* reprise bit à bit : on rejoue les tirages déjà consommés (ADR 0004) */
  const calls = d.rngCalls ?? 0;
  for (let i = 0; i < calls; i++) race.rng();
  race.endSimT = d.endSimT ?? Infinity;
  race.cars = d.cars.map((c) => {
    const car = { ...c } as RaceCar;
    /* état sérialisé AVANT la boîte (n°24) : la clé gear manque — on
       dérive le rapport plausible (le plus haut g tel que rpmOf(g, v)
       >= 2500, sinon 0) et la logique de vitesse se stabilise
       d'elle-même en quelques pas */
    if (car.gear === undefined || car.gear === null) {
      let g = 0;
      for (let q = 5; q >= 0; q--) {
        const r = RATIOS[q] * FINAL;
        if (car.v / (2 * Math.PI * RW) * r * 60 >= GEAR_DERIVE_MIN_RPM) { g = q; break; }
      }
      car.gear = g;
      car.rpm = 1000;
      car.shiftT = 0;
    }
    return car;
  }) as RaceCar[];
  planIdNext = Math.max(planIdNext, d.nextPlanId ?? 1000);
  return race;
}

export function setPlan(car: RaceCar, plan: Plan) {
  /* 'tires' DOIT survivre ici : l'action est consommée au GARAGE
     (endStop), pas au passage d'un km — evalPlan ne la touche pas.
     La valeur est validée (clé de TIRES), sinon l'action est rejetée. */
  car.plan = {
    power: Math.max(0.3, Math.min(1, plan.power)),
    aggression: plan.aggression !== undefined && plan.aggression in AGG ? plan.aggression : 'standard',
    actions: plan.actions.filter((a) =>
      a.type === 'refuel' || a.type === 'sleep' || a.type === 'repair'
      || a.type === 'power'
      || (a.type === 'tires' && a.tire in TIRES)
    ).map((a) => ({ ...a, id: a.id ?? newPlanId() })),
  };
  if (car.st === 'run') car.pwr = car.plan.power * (car.heavyDamage ? HEAVY_POWER : 1);
}

