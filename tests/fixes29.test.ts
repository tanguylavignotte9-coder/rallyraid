/* Tests n°29 — audit : garde anti-re-ciblage générale (D4), fin de
   course malgré une survie figée (D3), réveil pendant dry (D6),
   ralenti coupé à l'arrêt (D5). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRace, addCar, stepRace, wakeSurvival, setPlan, newPlanId,
  DEFAULT_CONFIG, DRY_ASSIST_L, TANK_L,
  type RaceConfig,
} from '../core/race.ts';

const EPOCH = Date.UTC(2026, 9, 14, 10, 0, 0);
function cfg(seed: number, totalKm: number, extra: Partial<RaceConfig> = {}): RaceConfig {
  return { ...DEFAULT_CONFIG, seed, totalKm, startEpochMs: EPOCH, ...extra };
}
function run(race: ReturnType<typeof makeRace>, simSeconds: number) {
  stepRace(race, Math.ceil(simSeconds / (1 / 120)));
}

test('29 : tireWorn ne détourne JAMAIS un arrêt en cours (station incluse)', () => {
  const race = makeRace(cfg(401, 600));
  race.departed = true;
  const c = addCar(race, 'A', '#111111');
  /* en route vers SA station (règle fuelLow déjà consommée) */
  const st = race.trk.poisAhead(1, 600_000).find((pp) => pp.kind === 'station')!;
  c.st = 'toStop';
  c.stopKind = 'station';
  c.targetS = st.s;
  c.tireWear = 0.9;   // la règle voudrait engager un garage
  setPlan(c, { power: 1, actions: [{ id: newPlanId(), type: 'repair', ifTag: 'tireWorn', threshold: 0.5 }] });
  run(race, 120);
  assert.equal(c.targetS, st.s, 'targetS inchangé (pas de détournement)');
  assert.equal(c.stopKind, 'station', 'station conservée');
});

test('29 : une survie figée ne bloque plus la fin de course', () => {
  const race = makeRace(cfg(402, 300));
  race.departed = true;
  const a = addCar(race, 'A', '#111111');
  const b = addCar(race, 'B', '#222222');
  /* A survit figée ; B arrive (300 km de course) */
  a.survivalStop = true;
  a.st = 'stop';
  a.stopKind = 'roadside';
  a.stopUntil = Infinity;
  a.v = 0;
  b.v = 50;
  run(race, 4 * 3600);   // le temps que B arrive (300 km)
  assert.equal(race.phase, 'finished', 'la course se termine');
  assert.equal(a.st, 'finish', 'A classée au km atteint');
  assert.ok(a.finishedAt !== null, 'A a un finishedAt');
  /* garde : wakeSurvival ne relance pas une voiture dans une course finie */
  wakeSurvival(race, a);
  assert.equal(a.st, 'finish', 'pas de reprise dans une course terminée');
});

test('29 : réveil PENDANT une assistance sèche — carburant versé immédiatement', () => {
  const race = makeRace(cfg(403, 600));
  race.departed = true;
  const c = addCar(race, 'A', '#111111');
  c.owner = 'toto';
  stepRace(race, 1);
  /* survie + panne sèche en cours d'assistance */
  c.survivalStop = true;
  c.survivalKind = 'station';
  c.st = 'stop';
  c.stopKind = 'dry';
  c.fuel = 0;
  c.stopUntil = Infinity;   // en plein timer d'assistance
  wakeSurvival(race, c);
  assert.equal(c.fuel, DRY_ASSIST_L, 'assistance versée au réveil');
  assert.equal(c.st, 'run', 'la voiture repart');
  assert.equal(c.survivalStop, false, 'survie levée');
  /* au pas suivant elle n'est PAS retombée dry */
  stepRace(race, 4);
  assert.ok(c.st === 'run' || c.st === 'toStop', `pas de rechute dry : ${c.st}`);
  assert.ok(c.fuel > 0, 'carburant toujours présent');
});

test('29 : moteur coupé à l arrêt — réservoir intact après un hôtel', () => {
  const race = makeRace(cfg(404, 600));
  race.departed = true;
  const c = addCar(race, 'A', '#111111');
  c.st = 'stop';
  c.stopKind = 'hotel';
  c.stopHours = 7;
  c.stopUntil = Infinity;
  const fuel0 = c.fuel;
  run(race, 2 * 3600);   // 2 h d'hôtel
  assert.equal(c.fuel, fuel0, 'le réservoir est IDENTIQUE (moteur coupé)');
});
