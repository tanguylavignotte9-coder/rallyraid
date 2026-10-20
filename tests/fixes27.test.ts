/* Tests n°27 — corrections de la simulation de partie + malus :
   actions au km mappées aux genres de POI, survie + panne sèche (fin
   du gel permanent), dépassement d'un arrêté par TOUS les profils,
   classement de fin par durée au kilomètre, crevaison bridée 70 km/h,
   dégât lourd moteur 30 %. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRace, addCar, stepRace, rankCars, serializeRace, deserializeRace,
  setPlan, newPlanId, wakeSurvival,
  DEFAULT_CONFIG, TANK_L, DRY_ASSIST_MIN, PUNCTURE_CAP_KMH, HEAVY_POWER,
  FATIGUE_EMERG_H,
  type RaceConfig, type RaceCar,
} from '../core/race.ts';
import { CAR_L } from '../core/engine.ts';

const EPOCH = Date.UTC(2026, 9, 14, 10, 0, 0);
function cfg(seed: number, totalKm: number, extra: Partial<RaceConfig> = {}): RaceConfig {
  return { ...DEFAULT_CONFIG, seed, totalKm, startEpochMs: EPOCH, ...extra };
}
function race1(seed: number, extra: Partial<RaceConfig> = {}) {
  const race = makeRace(cfg(seed, extra.totalKm ?? 400, extra));
  race.departed = true;
  return race;
}
function run(race: ReturnType<typeof makeRace>, simSeconds: number) {
  stepRace(race, Math.ceil(simSeconds / (1 / 120)));
}

test('27 : actions au km — mapping repair->garage, refuel->station, sleep->hotel', () => {
  /* repair au km 20 : l'action DOIT mener a un arret garage */
  const race = race1(201);
  const c = addCar(race, 'A', '#111111');
  c.s = 19_000;
  setPlan(c, { power: 1, actions: [{ id: newPlanId(), type: 'repair', atKm: 20 }] });
  run(race, 900);   // 15 min : cap sur le garage puis arret
  assert.ok(c.st === 'toStop' || c.st === 'stop', `etat ${c.st}`);
  assert.equal(c.stopKind, 'garage', 'repair au km => garage');
  /* refuel au km : station */
  const race2 = race1(202);
  const c2 = addCar(race2, 'B', '#222222');
  c2.s = 5_000;
  setPlan(c2, { power: 1, actions: [{ id: newPlanId(), type: 'refuel', atKm: 6 }] });
  run(race2, 900);
  assert.ok(c2.st === 'toStop' || c2.st === 'stop', `etat ${c2.st}`);
  assert.equal(c2.stopKind, 'station', 'refuel au km => station');
  /* sleep au km avec duree : hotel + heures memorisees */
  const race3 = race1(203);
  const c3 = addCar(race3, 'C', '#333333');
  c3.s = 5_000;
  setPlan(c3, { power: 1, actions: [{ id: newPlanId(), type: 'sleep', atKm: 6, hours: 2 }] });
  run(race3, 900);
  assert.ok(c3.st === 'toStop' || c3.st === 'stop', `etat ${c3.st}`);
  assert.equal(c3.stopKind, 'hotel', 'sleep au km => hotel');
  assert.equal(c3.stopHours, 2, 'duree 2 h memorisee');
});

test('27 : garage fonctionnel de bout en bout (gommes + usure + crevaison)', () => {
  const race = race1(204, { totalKm: 600 });
  const c = addCar(race, 'A', '#111111');
  /* posée a 1 km du premier garage : le trajet est court, l'arret
     (REPAIR_MIN 30 min) tient dans les 2 h simulees */
  const g = race.trk.poisAhead(1, 600_000).find((pp) => pp.kind === 'garage')!;
  c.s = Math.max(0, g.s - 1000);
  const budget0 = c.budget;
  setPlan(c, {
    power: 1,
    actions: [
      { id: newPlanId(), type: 'tires', tire: 'tendres' },
      { id: newPlanId(), type: 'repair', atKm: Math.ceil(c.s / 1000) },
    ],
  });
  c.tireWear = 1;        // gommes mortes
  c.punctured = true;    // crevée
  run(race, 7200);       // 2 h : cap, arret, REPAIR_MIN au garage, repart
  assert.ok(c.st === 'run' || c.st === 'toStop',
    `la voiture a repris la route (etat ${c.st})`);
  assert.ok(c.tire === 'tendres', `gommes tendres montees : ${c.tire}`);
  /* l'usure a ete remise a zero AU garage, puis la voiture a roule :
     le journal prouve le garage passe (evenement de montage) */
  assert.ok(c.events.some((e) => e.msg.includes('Gommes tendres montées')),
    'l evenement de montage est present');
  assert.equal(c.punctured, false, 'crevaison reparee');
  /* le budget est NET (revenus - depenses) : le DEBIT de 900 € est
     prouve par le journal, pas par le delta (les revenus ~3 000 €/2 h
     dominent — mesuré) */
  assert.ok(c.events.some((e) => e.msg.includes('900 €')), 'gommes facturees 900 €');
  void budget0;
});

test('27 : survie + panne seche pendant le trajet — plus de gel permanent', () => {
  /* n°29 : une DEUXIÈME voiture roule (course longue) — depuis le
     n°29 une seule voiture figée-survie CLÔT la course ; ici on teste
     le gel, pas la clôture */
  const race = race1(205, { survivalHours: 1, totalKm: 2000 });
  const c = addCar(race, 'A', '#111111');
  const other = addCar(race, 'Z', '#999999');
  void other;
  c.owner = 'toto';
  /* stepRace remet lastSeenSimT a 0 au passage en racing : on amorce
     la course, PUIS on marque le pilote absent */
  stepRace(race, 1);
  c.lastSeenSimT = race.simT - 10 * 3600;   // absent depuis longtemps
  run(race, 60);
  assert.ok(c.survivalStop, 'arret de survie engage');
  assert.ok(c.st === 'toStop', 'cap sur son POI de survie');
  assert.ok(c.survivalKind !== null, 'genre de POI memorise');
  c.fuel = 0;                    // panne seche pendant le trajet
  stepRace(race, 1);
  assert.equal(c.stopKind, 'dry', 'panne seche declenchee');
  /* l'assistance SE TERMINE (fin du bug du gel permanent) */
  run(race, DRY_ASSIST_MIN * 60 + 60);
  assert.ok(c.st === 'toStop' || c.st === 'stop',
    `l'assistance dry s'est terminee (etat ${c.st})`);
  assert.ok(c.fuel > 0, 'carburant verse');
  assert.equal(c.dryAssisted, true, 'assistance comptee');
  /* arrivee au POI de survie : gel explicite */
  run(race, 7200);
  if (c.st === 'stop') {
    assert.equal(c.stopUntil, Infinity, 'gele a son POI jusqu a la reconnexion');
  }
  /* reconnexion : repart, compteurs remis */
  wakeSurvival(race, c);
  assert.equal(c.st, 'run', 'repart a la reconnexion');
  assert.equal(c.survivalKind, null, 'survivalKind remis');
  assert.equal(c.dryAssisted, false, 'dryAssisted remis');
  /* deuxieme panne seche pendant la survie : gel roadside definitif */
  c.survivalStop = true;
  c.dryAssisted = true;
  c.fuel = 0;
  stepRace(race, 1);
  assert.equal(c.stopKind, 'roadside', 'deuxieme panne => bord de route');
  assert.equal(c.stopUntil, Infinity, 'gel definitif');
});

test('27 : profil securite depasse une voiture garée (route large)', () => {
  /* A garée sur la route, B derriere en securite : B DOIT passer
     (poussee latérale resolvePairs + attaque) ou au moins ne jamais
     rester collee. Sur 20 km de course B finit devant.
     n°33 : le départ de la graine 206 est désormais en FAMILLE ALTITUDE
     (chaussée 1,6 m : côte à côte impossible — B file derrière, n°16
     correct) : la fenêtre du test déménage au km 61-64, une section
     PLAINE émergente (largeur ~3,5 m, mesurée sur le banc). */
  const race = makeRace(cfg(206, 300));
  race.departed = true;
  const a = addCar(race, 'A', '#111111');
  const b = addCar(race, 'B', '#222222');
  setPlan(b, { power: 1, aggression: 'securite', actions: [] });
  a.st = 'stop'; a.v = 0; a.s = 62_000; a.stopKind = 'roadside'; a.stopUntil = Infinity;
  b.s = 61_000; b.v = 30;
  run(race, 1200);   // 20 min a ~180 km/h = ~60 km
  assert.ok(b.s > a.s + 5, `B a depasse A : ${((b.s - a.s) / 1000).toFixed(1)} km d ecart`);
});

test('27 : classement fin de duree — departage au kilometre', () => {
  const race = makeRace(cfg(207, 1000, { endType: 'duration', endHours: 1 }));
  race.departed = true;
  const a = addCar(race, 'A', '#111111');
  const b = addCar(race, 'B', '#222222');
  const c = addCar(race, 'C', '#333333');
  a.s = 50_000; b.s = 80_000; c.s = 60_000;   // km differents
  run(race, 3660);   // 1 h : fin par duree
  assert.equal(race.phase, 'finished');
  assert.ok(a.st === 'finish' && b.st === 'finish' && c.st === 'finish');
  assert.ok(a.finishedAt === b.finishedAt, 'meme finishedAt');
  const ranked = rankCars(race);
  assert.equal(ranked[0]!.name, 'B', 'le plus loin premier');
  assert.equal(ranked[1]!.name, 'C');
  assert.equal(ranked[2]!.name, 'A', 'jamais l ordre d insertion');
});

test('27 : crevaison bridée a 70 km/h, reparee au garage', () => {
  const race = race1(208, { totalKm: 600 });
  const c = addCar(race, 'A', '#111111');
  c.punctured = true;
  run(race, 600);   // 10 min : stabilisation au cap
  assert.ok(c.v <= PUNCTURE_CAP_KMH / 3.6 + 0.3,
    `crevee bridée : ${(c.v * 3.6).toFixed(1)} km/h <= ${PUNCTURE_CAP_KMH}`);
  /* reparation au garage : rythme normal repris */
  const b0 = c.budget;
  setPlan(c, { power: 1, actions: [{ id: newPlanId(), type: 'repair', atKm: Math.ceil(c.s / 1000) }] });
  run(race, 7200);
  assert.equal(c.punctured, false, 'reparee');
  run(race, 600);
  assert.ok(c.v * 3.6 > PUNCTURE_CAP_KMH, `rythme repris : ${(c.v * 3.6).toFixed(0)} km/h`);
});

test('27 : degat lourd — moteur a 30 %', () => {
  const race = race1(209);
  const c = addCar(race, 'A', '#111111');
  c.heavyDamage = true;
  stepRace(race, 2);
  assert.ok(Math.abs(c.pwr - HEAVY_POWER) < 1e-9, `pwr = ${c.pwr} (plan 1 x 0.3)`);
  setPlan(c, { power: 0.8, actions: [] });
  assert.ok(Math.abs(c.pwr - 0.8 * HEAVY_POWER) < 1e-9, `pwr = ${c.pwr} (plan 0.8 x 0.3)`);
  /* reparation garage : pleine puissance */
  setPlan(c, { power: 0.8, actions: [{ id: newPlanId(), type: 'repair', atKm: Math.ceil(c.s / 1000) }] });
  run(race, 7200);
  assert.equal(c.heavyDamage, false, 'reparee');
  assert.ok(Math.abs(c.pwr - 0.8) < 1e-9, `pleine puissance : ${c.pwr}`);
});

test('27 : compatibilite descendante — etat sans survivalKind/dryAssisted', () => {
  const race = race1(210);
  const c = addCar(race, 'A', '#111111');
  run(race, 120);
  const raw = JSON.parse(serializeRace(race));
  /* simule un vieux fichier : les champs n°27 absents */
  for (const car of raw.cars) {
    delete car.survivalKind;
    delete car.dryAssisted;
  }
  assert.doesNotThrow(() => {
    const re = deserializeRace(JSON.stringify(raw));
    stepRace(re, 240);
  }, 'un etat pre-n°27 se charge et roule');
});

test('27 : perf — 10 voitures etalées, pas de thrashing de chunks', () => {
  const race = makeRace(cfg(211, 1500));
  race.departed = true;
  for (let i = 0; i < 10; i++) {
    const c = addCar(race, `V${i}`, '#111111');
    c.s = i * 70_000;    // etalées sur 700 km
    c.v = 40;
  }
  const t0 = performance.now();
  run(race, 5_000 / 120);   // ~5 000 pas = ~41 s de course
  const dt = performance.now() - t0;
  /* garde anti-regression perf : 5 000 pas de 10 voitures etalées
     doivent rester rapides (fenetre 128 chunks > étalement + POI) */
  assert.ok(dt < 30_000, `5 000 pas en ${dt.toFixed(0)} ms (< 30 s)`);
});
