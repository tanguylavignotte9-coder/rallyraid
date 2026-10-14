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
  DT, CAR_L, type KinCar,
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
  | { id: number; type: 'power'; power: number };

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
};

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
    case 'station': return REFUEL_MIN * 60;
    case 'garage': return REPAIR_MIN * 60;
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
    car.fuel = TANK_L;
    log(car, race.simT, `Plein fait (${TANK_L} L) — repart`);
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
    log(car, race.simT, 'Réparation terminée — repart');
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
    } else if (a.atKm !== undefined) {
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
  const trk = race.trk;
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

  if (car.s >= trk.finishS) {
    car.s = trk.finishS;
    car.st = 'finish';
    car.v = 0;
    car.finishedAt = race.simT;
    log(car, race.simT, 'ARRIVÉE !');
  }
  return info;
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
