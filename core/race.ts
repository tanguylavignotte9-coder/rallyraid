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
  speedTarget, driveStep, lateralStep, raceLineTarget, draftMul,
  DT, CAR_L, mulberry32,
  type KinCar,
} from './engine.ts';
import {
  makeRoute, routeTrack, type Route, type RouteTrack, type PoiKind,
} from './route.ts';

export const TANK_L = 520;
export const FUEL_BASE_LPS = 0.02;   // conso de croisière à curseur 0
export const FUEL_PWR_LPS = 0.08;    // conso ajoutée par unité de curseur
export const FUEL_IDLE_LPS = 0.00035; // moteur tournant à l'arrêt
export const V_CAP = 32;             // plafond aéro/développable (m/s)
export const NIGHT_CAP = 0.85;        // bride 22 h → 6 h (Paris)
export const FATIGUE_SOFT_H = 14;    // début de la dégradation
export const FATIGUE_EMERG_H = 30;   // arrêt de survie en bord de route
export const FATIGUE_FLOOR = 0.6;    // vitesse max résiduelle à fond de fatigue
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
  tendres: { grip: 1.06, wetGrip: 0.80, wear: 1.6, price: 900 },
  dures:   { grip: 0.96, wetGrip: 0.78, wear: 0.6, price: 700 },
  pluie:   { grip: 1.00, wetGrip: 1.02, wear: 1.0, price: 800 },
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
export const CONTACT_SLOW_S = 30;       // ralentissement après contact léger
export const PUNCTURE_CAP_KMH = 85;    // crevaison : mode dégradé (vision)

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
export const NIGHT_MODE_MUL = 'mul';  // 'mul' : multiplicateur · 'cap' : plafond km/h
export const NIGHT_MODE_CAP = 'cap';
export const NIGHT_CAP_KMH = 110;    // plafond nuit si mode 'cap'

export type NightMode = 'mul' | 'cap';

export type RaceConfig = {
  seed: number;
  totalKm: number;
  startEpochMs: number;     // date/heure réelle de départ (Paris affiché)
  prepMinutes: number;       // fenêtre de préparation avant départ
  endType: 'distance' | 'duration';
  endHours: number;         // durée de course si endType = 'duration'
  survivalHours: number;    // sans connexion → arrêt au POI (arrêt de survie)
  poiDensity: number;       // multiplicateur de densité des POI (1 = nominal)
  nightMode: NightMode;     // forme de la bride de nuit
  nightValue: number;       // ×0,85 en mode mul, km/h en mode cap
  maxCars: number;
};

export const DEFAULT_CONFIG: RaceConfig = {
  seed: 42,
  totalKm: 1000,
  startEpochMs: Date.now(),
  prepMinutes: 60,
  endType: 'distance',
  endHours: 24 * 7,
  survivalHours: SURVIVAL_DEFAULT_H,
  poiDensity: 1,
  nightMode: NIGHT_MODE_MUL,
  nightValue: NIGHT_CAP,
  maxCars: MAX_CARS,
};

/* ---- Déroulé de course : préparation (compte à rebours, grille
   ouverte) → course → fin (podium figé jusqu'au reset). ---- */
export type RacePhase = 'preparation' | 'racing' | 'finished';

export type PlanAction =
  | { id: number; type: 'refuel' | 'sleep' | 'repair'; atKm?: number }
  | { id: number; type: 'refuel'; ifTag: 'fuelLow'; threshold: number }
  | { id: number; type: 'sleep'; ifTag: 'fatigueHigh'; threshold: number; hours: number }
  | { id: number; type: 'power'; power: number }
  | { id: number; type: 'tires'; tire: TireKind };

export type Plan = { power: number; actions: PlanAction[] };

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
    actions: [
      { id: carId * 1000 + 1, type: 'refuel', ifTag: 'fuelLow', threshold: 0.18 },
      { id: carId * 1000 + 2, type: 'sleep', ifTag: 'fatigueHigh', threshold: 20, hours: 7 },
    ],
  };
}

export function makeCar(id: number, name: string, color: string, gridS: number): RaceCar {
  return {
    id, name, color,
    s: gridS, v: 0, d: 0, dSm: 0, dRate: 0, roll: 0, pitch: 0,
    acc: 0, thr: 0, brkCmd: 0, grip: 0, abs: 0, steer: 0, pwr: 1,
    fuel: TANK_L, fatigue: 0,
    st: 'run', stopKind: null, stopUntil: 0, stopHours: 0, targetS: null,
    plan: defaultPlan(id),
    finishedAt: null,
    events: [],
    owner: null,
    lastSeenSimT: 0,
    survivalStop: false,
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

export function parisHour(race: Race): number {
  const d = new Date(race.startEpochMs + race.simT * 1000);
  const h = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', hour: 'numeric', minute: 'numeric', hour12: false,
  }).format(d);
  return Number(h.split(':')[0]) + Number(h.split(':')[1]) / 60;
}

export function parisClock(race: Race): string {
  const d = new Date(race.startEpochMs + race.simT * 1000);
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
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

/* bride de nuit — FORME paramétrable (admin) : multiplicateur ×0,85 ou
   plafond km/h ; la fenêtre 22 h → 6 h (Paris) ne change pas */
function nightCap(race: Race, hour: number): number {
  const night = hour >= 22 || hour < 6;
  if (!night) return V_CAP;
  if (race.config.nightMode === NIGHT_MODE_CAP) {
    return Math.min(V_CAP, race.config.nightValue / 3.6);
  }
  return V_CAP * race.config.nightValue;
}

function fatigueMul(fatigue: number): number {
  if (fatigue <= FATIGUE_SOFT_H) return 1;
  const k = Math.min(1, (fatigue - FATIGUE_SOFT_H) / (FATIGUE_EMERG_H - FATIGUE_SOFT_H));
  return 1 - (1 - FATIGUE_FLOOR) * k;
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
     aucun service ne s'applique, aucun faux message de reprise */
  if (car.survivalStop) return;
  if (car.stopKind === 'station') {
    /* dépense : carburant facturé au litre (vision : « dépenses :
       carburant, pneus, réparations, amendes ») */
    const litres = TANK_L - car.fuel;
    car.budget -= litres * FUEL_PRICE;
    car.fuel = TANK_L;
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
  car.survivalStop = false;
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
    } else if (a.type !== 'tires' && a.atKm !== undefined) {
      if (car.s / 1000 >= a.atKm) {
        const ok = engageStop(race, car, a.type as PoiKind, a.type === 'sleep' ? 7 : 0);
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
    if (gap > 0 && gap < 40 && gap < bestGap) { best = o; bestGap = gap; }
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
    car.fuel = Math.max(0, car.fuel - FUEL_IDLE_LPS * dt);
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
      car.stopUntil = race.simT + poiDuration(car);
      const label = car.stopKind === 'station' ? 'Ravitaillement' : car.stopKind === 'hotel' ? 'Coucher' : car.stopKind === 'garage' ? 'Au garage' : 'Arrêt';
      log(car, race.simT, `${label} — arrêt de ${Math.round(poiDuration(car) / 60)} min`);
      return info;
    }
  }

  if (car.fuel <= 0) {
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
      log(car, race.simT, 'ARRÊT DE SURVIE — joueur absent, la voiture dort à un point d\'arrêt');
    } else {
      car.survivalStop = true;
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

  car.pwr = car.plan.power;
  evalPlan(race, car);

  const cap = nightCap(race, hour) * fatigueMul(car.fatigue);
  const draft = front ? draftMul(car, front) : 1;
  const vT = speedTarget(trk, car.s, cap, 0.75);
  driveStep(trk, car, vT, dt, draft);

  let dT = raceLineTarget(trk, car.s);
  if (front) {
    const gap = front.s - car.s;
    if (gap < 12 && car.v > front.v - 0.5) {
      info.attackSide = front.d >= 0 ? 1 : -1;
      dT = front.d + info.attackSide * 2.2;
    }
    if (gap < CAR_L && Math.abs(front.d - car.d) < 1.9) {
      dT = front.d + (front.d >= car.d ? 1 : -1) * 2.15;
    }
  }
  const hw = trk.wAt(car.s) - 1.05;
  dT = Math.max(-hw, Math.min(hw, dT));
  lateralStep(car, dT, dt);
  car.s += car.v * dt;

  car.fatigue += dt / 3600;
  car.fuel = Math.max(0, car.fuel - (FUEL_IDLE_LPS + (FUEL_BASE_LPS + FUEL_PWR_LPS * car.pwr) * car.thr) * dt);

  /* USURE DES GOMMES : proportionnelle au grip sollicité (cercle de
     friction — la gomme travaille) × facteur d'usure du type monté */
  car.tireWear = Math.min(TIRE_WEAR_MAX, car.tireWear
    + car.grip * TIRES[car.tire].wear * dt / (TIRE_WEAR_MAX * 3600 * 2));
  /* crevaison surprise : gomme morte → risque par pas, PRNG semé */
  if (!car.punctured && car.tireWear >= TIRE_WEAR_MAX && race.rng() < PUNCTURE_WORN_P) {
    car.punctured = true;
    log(car, race.simT, 'CREVAISON — gommes mortes, mode dégradé jusqu\'au garage (85 km/h)');
  }

  /* MANŒUVRE DE DOUBLAGE = on attaque par le côté à moins de 12 m. Le
     risque est tiré UNE FOIS PAR MANŒUVRE (CONTACT_P), pas à chaque pas :
     une course prudente ne produit presque rien, attaquer souvent
     s'expose. Cooldown entre manœuvres ; la gravité monte avec le
     rythme du moment (fatigue + nuit + vitesse). */
  if (car.attackCooldown > 0) car.attackCooldown -= dt;
  const attacking = info.attackSide !== 0 && front;
  if (attacking && !car.attackMan && car.attackCooldown <= 0) {
    car.attackMan = true;                 // manœuvre lancée
    car.attackCooldown = CONTACT_COOLDOWN_S;
    if (race.rng() < CONTACT_P) applyContact(race, car, front, hour);
  }
  if (!attacking) car.attackMan = false;  // manœuvre terminée

  /* BUDGET — bonus de régularité (moitié) : rythme de croisière stable =
     vitesse qui ne s'écarte pas de plus de REG_SPEED_BAND m/s de la
     consigne ; l'absence d'incident (moitié) se lit sur car.incidents */
  const stable = Math.abs(car.v - cap) < REG_SPEED_BAND && car.v > 5;
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
    attacker.fatigue / FATIGUE_EMERG_H * 0.5
    + (night ? 0.2 : 0)
    + Math.min(0.3, attacker.v / V_CAP * 0.3));
  const heavy = race.rng() < CONTACT_SEV_HEAVY + stress * 0.2;

  /* attribution de la faute — règlement acté (vision.md) :
     INTÉRIEUR : l'attaquant doit placer son essieu avant au moins à
       hauteur du rétroviseur du défenseur AU POINT DE CORDE, sans
       brutalité → ici : assez loin à ses côtés pour avoir la place ;
     EXTÉRIEUR : à hauteur ou devant pour exiger la largeur ;
     côte à côte : espace dû.
     Sans faute claire : incident de course, pas de sanction. */
  const overlap = attacker.s - (defender.s - CAR_L); // avancée de l'attaquant
  const atApexOk = overlap > 1.2;                   // essieu avant ≥ rétroviseur
  const sideGap = Math.abs(attacker.d - defender.d);
  const spaceOk = sideGap >= 1.9;                    // largeur laissée
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
    if (frontStopped && latSep < 1.4) {
      front.d = front.d >= back.d ? Math.min(back.d + 1.4, 2.2) : Math.max(back.d - 1.4, -2.2);
      front.dSm = front.d;
    }
    if (!frontStopped && gap < CAR_L && latSep < 1.9) {
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
  const biomes: Record<number, string> = { 0: 'Plaine', 1: 'Forêt', 2: 'Désert', 3: 'Altitude' };
  let lead = 0;
  for (const c of race.cars) if (c.s > lead) lead = c.s;
  const parts: string[] = [];
  for (let d = 0; d < 3; d++) {
    const s = lead + d * 70_000; // 3 tronçons de 70 km devant la tête
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
    if (!race.finished && race.cars.length > 0 && race.cars.every((c) => c.st === 'finish')) {
      race.finished = true;
      race.phase = 'finished';
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
    if (a.st === 'finish' && b.st === 'finish') return (a.finishedAt ?? 0) - (b.finishedAt ?? 0);
    if (a.st === 'finish') return -1;
    if (b.st === 'finish') return 1;
    return b.s - a.s;
  });
}

type SerializedCar = Omit<RaceCar, never>;
type SerializedRace = Pick<Race, 'seed' | 'totalKm' | 'simT' | 'doneSteps' | 'startEpochMs' | 'timeScale' | 'finished' | 'endSimT'> & {
  cars: (SerializedCar & { plan: Plan })[];
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
  race.cars = d.cars.map((c) => ({ ...c })) as RaceCar[];
  planIdNext = Math.max(planIdNext, d.nextPlanId ?? 1000);
  return race;
}

export function setPlan(car: RaceCar, plan: Plan) {
  car.plan = {
    power: Math.max(0.3, Math.min(1, plan.power)),
    actions: plan.actions.filter((a) =>
      a.type === 'refuel' || a.type === 'sleep' || a.type === 'repair' || a.type === 'power'
    ).map((a) => ({ ...a, id: a.id ?? newPlanId() })),
  };
  if (car.st === 'run') car.pwr = car.plan.power;
}

export const RACE_CONST = {
  TANK_L, V_CAP, NIGHT_CAP, FATIGUE_SOFT_H, FATIGUE_EMERG_H,
  REFUEL_MIN, REPAIR_MIN, DRY_ASSIST_MIN,
};
