/* Tests de la couche course (Phase 3) : déterminisme bit à bit de la
   simulation, exécution des plans (règle conditionnelle → arrêt au POI),
   panne sèche (immobilisation + assistance), fatigue (arrêt de survie),
   sérialisation/reprise (la garantie serveur de l'ADR 0004).
   Pour rester rapides, les tests téléportent les voitures près des POI
   et raccourcissent les arrêts au lieu de simuler des heures. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRace, addCar, stepRace, rankCars,
  serializeRace, deserializeRace, setPlan, newPlanId,
  FATIGUE_EMERG_H, TANK_L, DEFAULT_CONFIG, wakeSurvival,
  type RaceConfig,
} from '../core/race.ts';

const EPOCH = Date.UTC(2026, 9, 14, 10, 0, 0);

function cfg(seed: number, totalKm: number, extra: Partial<RaceConfig> = {}): RaceConfig {
  /* départ dans le passé : la course démarre immédiatement en 'racing'
     (l'état 'preparation' attend une date de départ réelle) */
  const c = { ...DEFAULT_CONFIG, seed, totalKm, startEpochMs: EPOCH, ...extra };
  return c;
}

function race2cars(seed: number, extra: Partial<RaceConfig> = {}) {
  const race = makeRace(cfg(seed, 200, extra));
  race.departed = true; // départ immédiat : on teste la course, pas le compte à rebours
  addCar(race, 'A', '#111111');
  addCar(race, 'B', '#222222');
  return race;
}

function run(race: ReturnType<typeof race2cars>, simSeconds: number) {
  const n = Math.ceil(simSeconds / (1 / 120));
  stepRace(race, n);
}

function firstPoi(race: ReturnType<typeof race2cars>, kind: 'station' | 'hotel' | 'garage') {
  return race.trk.poisAhead(0, 200_000).find((p) => p.kind === kind)!;
}

test('course : déterminisme bit à bit de la simulation', () => {
  const a = race2cars(7);
  const b = race2cars(7);
  run(a, 600);
  run(b, 600);
  assert.equal(serializeRace(a), serializeRace(b), 'deux courses de la même graine sont identiques');
});

test('course : la voiture roule et consomme', () => {
  const race = race2cars(3);
  run(race, 300);
  const c = race.cars[0]!;
  assert.ok(c.s > 1000, `la voiture a avancé (s=${c.s.toFixed(0)})`);
  assert.ok(c.v > 10, 'la voiture a de la vitesse');
  assert.ok(c.fuel < TANK_L, 'la voiture a consommé');
  assert.ok(c.fatigue > 0, 'la fatigue compte');
});

test('course : panne sèche → assistance lente puis repart', () => {
  const race = race2cars(5);
  const c = race.cars[0]!;
  c.plan = { power: 1, actions: [] };
  run(race, 120);
  c.fuel = 0.01;
  run(race, 30);
  assert.equal(c.st, 'stop');
  assert.equal(c.stopKind, 'dry');
  assert.ok(c.events.some((e) => e.msg.includes('PANNE SÈCHE')), 'journalisé');
  c.stopUntil = race.simT + 10; // on avance la fin d'assistance
  run(race, 30);
  assert.equal(c.st, 'run', 'la voiture a repris la route après assistance');
  assert.ok(c.fuel > 0);
});

test("course : règle fatigue → coucher à l'hôtel et récupération", () => {
  const race = race2cars(11);
  const c = race.cars[0]!;
  const hotel = firstPoi(race, 'hotel');
  setPlan(c, {
    power: 1,
    actions: [{ id: newPlanId(), type: 'sleep', ifTag: 'fatigueHigh', threshold: 3, hours: 4 }],
  });
  c.fatigue = 3.5;
  c.s = hotel.s - 60; // juste avant l'hôtel
  run(race, 60);
  assert.ok(c.st === 'toStop' || c.st === 'stop', `l'hôtel est visé (st=${c.st})`);
  run(race, 60);
  assert.equal(c.st, 'stop');
  c.stopUntil = race.simT + 10; // on avance le réveil
  run(race, 30);
  assert.ok(c.fatigue < 0.5, `fatigue après sommeil : ${c.fatigue.toFixed(2)} h`);
  assert.equal(c.st, 'run');
  assert.ok(c.events.some((e) => e.msg.includes('Réveil')), 'journalisé');
});

test('course : règle carburant → plein à la station', () => {
  const race = race2cars(13);
  const c = race.cars[0]!;
  const station = firstPoi(race, 'station');
  c.plan = { power: 1, actions: [{ id: newPlanId(), type: 'refuel', ifTag: 'fuelLow', threshold: 0.99 }] };
  c.fuel = TANK_L * 0.5; // sous le seuil → la règle se déclenche
  c.s = station.s - 60;
  run(race, 60);
  assert.ok(c.st === 'toStop' || c.st === 'stop');
  run(race, 60);
  c.stopUntil = race.simT + 10;
  run(race, 30);
  assert.ok(c.fuel > TANK_L * 0.9, 'réservoir plein après station');
  assert.equal(c.st, 'run');
});

test('course : fatigue critique → sommeil de survie en bord de route', () => {
  const race = race2cars(17);
  const c = race.cars[0]!;
  c.plan = { power: 1, actions: [] };
  c.fatigue = FATIGUE_EMERG_H + 0.01;
  run(race, 10);
  assert.equal(c.stopKind, 'roadside');
  assert.ok(c.events.some((e) => e.msg.includes('FATIGUE CRITIQUE')), 'journalisé');
  c.stopUntil = race.simT + 10;
  run(race, 30);
  assert.equal(c.st, 'run');
  assert.ok(c.fatigue < FATIGUE_EMERG_H, 'récupéré');
});

test('course : sérialisation → reprise identique (garantie serveur)', () => {
  const a = race2cars(21);
  run(a, 1200);
  const b = deserializeRace(serializeRace(a));
  run(a, 600);
  run(b, 600);
  assert.equal(serializeRace(a), serializeRace(b), 'la course reprise est identique au bit près');
});

test('course : arrivée → classement au temps total', () => {
  const race = makeRace(cfg(23, 3)); // 3 km : très court
  race.departed = true;
  addCar(race, 'A', '#111111');
  addCar(race, 'B', '#222222');
  run(race, 3600);
  const ranked = rankCars(race);
  assert.ok(race.cars.every((c) => c.st === 'finish'), `tous arrivés (${race.cars.map((c) => c.st)})`);
  assert.ok((ranked[0]!.finishedAt ?? 0) <= (ranked[1]!.finishedAt ?? 0), 'ordre au temps total');
});

test('course : déroulé — préparation puis course', () => {
  const race = makeRace(cfg(31, 50, { startEpochMs: Date.now() + 3600_000 }));
  addCar(race, 'A', '#111111');
  assert.equal(race.phase, 'preparation');
  run(race, 300);
  assert.equal(race.phase, 'preparation', 'rien ne bouge pendant la préparation');
  assert.equal(race.simT, 0);
  // le serveur donne le départ (horloge réelle passée)
  race.departed = true;
  run(race, 300);
  assert.equal(race.phase, 'racing');
  assert.ok(race.cars[0]!.s > 100);
});

test('course : arrêt de survie — stop sans connexion, repart à la reconnexion', () => {
  const race = race2cars(37, { survivalHours: 1 });
  const c = race.cars[0]!;
  c.owner = 'joueurA';
  run(race, 60);
  run(race, 3700); // > 1 h de veille simulée sans connexion
  assert.ok(c.survivalStop, 'arrêt de survie engagé');
  assert.ok(c.events.some((e) => e.msg.includes('ARRÊT DE SURVIE')));
  /* la voiture ROULE jusqu'au POI visé (comportement voulu : elle rejoint
     le point d'arrêt), puis s'y fige jusqu'à la reconnexion */
  run(race, 3600);
  assert.ok(c.st === 'stop' || c.st === 'toStop', 'en route vers le point d\'arrêt');
  run(race, 4 * 3600);
  assert.equal(c.st, 'stop', 'arrivée au POI, à l\'arrêt');
  const sBefore = c.s;
  run(race, 600);
  assert.equal(c.s, sBefore, 'la voiture reste figée sans son joueur');
  wakeSurvival(race, c);
  run(race, 60);
  assert.ok(c.s > sBefore, 'la voiture repart à la reconnexion');
  assert.equal(c.st, 'run');
});

test('course : fin par durée — tous classés au kilomètre atteint', () => {
  const race = race2cars(41, { endType: 'duration', endHours: 1 });
  run(race, 3620);
  assert.equal(race.phase, 'finished');
  assert.ok(race.cars.every((c) => c.st === 'finish'));
  assert.ok(race.cars.every((c) => c.finishedAt !== null));
});

test('course : bride de nuit — plafond km/h (mode cap)', () => {
  // départ à 23 h UTC = 1 h du matin Paris (heure d'été) : pleine nuit
  const nightEpoch = Date.UTC(2026, 9, 14, 23, 0, 0);
  const race = makeRace(cfg(43, 200, { nightMode: 'cap', nightValue: 90, startEpochMs: nightEpoch }));
  race.departed = true;
  const c = addCar(race, 'A', '#111111');
  run(race, 600);
  assert.ok(c.v * 3.6 <= 91, `vitesse respecte le plafond nuit : ${(c.v * 3.6).toFixed(0)} km/h`);
  assert.ok(c.v * 3.6 > 10, 'la voiture roule (bridée mais pas bloquée)');
});
