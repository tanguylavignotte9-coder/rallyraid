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
  FATIGUE_EMERG_H, TANK_L,
} from '../core/race.ts';

const EPOCH = Date.UTC(2026, 9, 14, 10, 0, 0);

function race2cars(seed: number) {
  const race = makeRace(seed, 200, 1, EPOCH);
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
  const race = makeRace(23, 3, 1, EPOCH); // 3 km : très court
  addCar(race, 'A', '#111111');
  addCar(race, 'B', '#222222');
  run(race, 3600);
  const ranked = rankCars(race);
  assert.ok(race.cars.every((c) => c.st === 'finish'), `tous arrivés (${race.cars.map((c) => c.st)})`);
  assert.ok((ranked[0]!.finishedAt ?? 0) <= (ranked[1]!.finishedAt ?? 0), 'ordre au temps total');
});
