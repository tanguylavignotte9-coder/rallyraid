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
  };
}

export function makeRace(seed: number, totalKm: number, timeScale = 1, startEpochMs = Date.now()): Race {
  const route = makeRoute(seed, totalKm);
  return {
    seed, totalKm, route, trk: routeTrack(route),
    cars: [], simT: 0, doneSteps: 0,
    startEpochMs, timeScale, finished: false,
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

function nightMul(hour: number): number {
  return hour >= 22 || hour < 6 ? NIGHT_CAP : 1;
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

  const cap = V_CAP * nightMul(hour) * fatigueMul(car.fatigue);
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
    race.simT = (race.doneSteps + 1) * DT;
    race.doneSteps++;
    const hour = parisHour(race);
    for (const car of race.cars) stepCar(race, car, hour, DT);
    resolvePairs(race);
    if (!race.finished && race.cars.length > 0 && race.cars.every((c) => c.st === 'finish')) {
      race.finished = true;
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
type SerializedRace = Pick<Race, 'seed' | 'totalKm' | 'simT' | 'doneSteps' | 'startEpochMs' | 'timeScale' | 'finished'> & {
  cars: (SerializedCar & { plan: Plan })[];
  nextPlanId: number;
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
    cars: race.cars.map((c) => ({ ...c })),
    nextPlanId: planIdNext,
  } satisfies SerializedRace);
}

export function deserializeRace(raw: string): Race {
  const d = JSON.parse(raw) as SerializedRace;
  const race = makeRace(d.seed, d.totalKm, d.timeScale, d.startEpochMs);
  race.simT = d.simT;
  race.doneSteps = d.doneSteps;
  race.finished = d.finished;
  race.cars = d.cars.map((c) => ({ ...c })) as RaceCar[];
  planIdNext = d.nextPlanId ?? 1000;
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
