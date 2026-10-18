/* Tests n°28 — règle gommes conditionnelle (tireWorn) + dégât lourd
   visible. Les gommes sont une jauge comme le carburant et la
   fatigue : la réparation se déclenche sur l'USURE, avec garde
   anti-re-ciblage pendant un trajet garage déjà engagé. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRace, addCar, stepRace, serializeRace, deserializeRace,
  setPlan, newPlanId, defaultPlan,
  DEFAULT_CONFIG, PUNCTURE_CAP_KMH,
  type RaceConfig, type RaceCar,
} from '../core/race.ts';

const EPOCH = Date.UTC(2026, 9, 14, 10, 0, 0);
function cfg(seed: number, totalKm: number, extra: Partial<RaceConfig> = {}): RaceConfig {
  return { ...DEFAULT_CONFIG, seed, totalKm, startEpochMs: EPOCH, ...extra };
}
function run(race: ReturnType<typeof makeRace>, simSeconds: number) {
  stepRace(race, Math.ceil(simSeconds / (1 / 120)));
}

test('28 : tireWorn declenche — garage, gommes montees, regle consommee', () => {
  const race = makeRace(cfg(301, 600));
  race.departed = true;
  const c = addCar(race, 'A', '#111111');
  const g = race.trk.poisAhead(1, 600_000).find((pp) => pp.kind === 'garage')!;
  c.s = Math.max(0, g.s - 2000);
  setPlan(c, {
    power: 1,
    actions: [
      { id: newPlanId(), type: 'tires', tire: 'dures' },
      { id: newPlanId(), type: 'repair', ifTag: 'tireWorn', threshold: 0.5 },
    ],
  });
  c.tireWear = 0.9;
  run(race, 300);
  assert.ok(c.st === 'toStop' || c.st === 'stop', `en route vers le garage : ${c.st}`);
  assert.equal(c.stopKind, 'garage', 'cible garage');
  /* arrivee + arret (REPAIR_MIN 30 min) + reprise : gommes neuves,
     usure nulle, regle consommee du plan */
  run(race, 7200);
  assert.ok(c.st === 'run' || c.st === 'toStop', `repartie : ${c.st}`);
  assert.equal(c.tire, 'dures', 'gommes dures montees');
  assert.ok(c.tireWear < 0.5, `usure repartie bas : ${c.tireWear.toFixed(2)}`);
  assert.ok(!c.plan.actions.some((a) => a.ifTag === 'tireWorn'),
    'la regle tireWorn a ete consommee');
  assert.ok(c.events.some((e) => e.msg.includes('Gommes dures montées')),
    'montage facture au journal');
});

test('28 : sous le seuil — aucune arret, la regle reste au plan', () => {
  const race = makeRace(cfg(302, 600));
  race.departed = true;
  const c = addCar(race, 'A', '#111111');
  setPlan(c, { power: 1, actions: [{ id: newPlanId(), type: 'repair', ifTag: 'tireWorn', threshold: 0.5 }] });
  c.tireWear = 0.3;
  run(race, 600);
  assert.equal(c.st, 'run', 'aucun arret');
  assert.ok(c.plan.actions.some((a) => a.ifTag === 'tireWorn'),
    'la regle reste dans le plan');
});

test('28 : crevee (wear 1) — la regle mene AU garage et repare', () => {
  const race = makeRace(cfg(303, 600));
  race.departed = true;
  const c = addCar(race, 'A', '#111111');
  const g = race.trk.poisAhead(1, 600_000).find((pp) => pp.kind === 'garage')!;
  c.s = Math.max(0, g.s - 2000);
  setPlan(c, { power: 1, actions: [{ id: newPlanId(), type: 'repair', ifTag: 'tireWorn', threshold: 0.85 }] });
  c.punctured = true;    // implique usure extreme
  c.tireWear = 1;
  run(race, 900);
  assert.ok(c.st === 'toStop' || c.st === 'stop', `cap garage : ${c.st}`);
  assert.equal(c.stopKind, 'garage', 'cible garage');
  run(race, 7200);
  assert.equal(c.punctured, false, 'crevaison reparee au garage');
  assert.ok(c.st === 'run' || c.st === 'toStop');
  /* la voiture n'est plus plafonnee : stabilisation plaine > cap */
  run(race, 900);
  assert.ok(c.v * 3.6 > PUNCTURE_CAP_KMH,
    `rythme libre repris : ${(c.v * 3.6).toFixed(0)} km/h > ${PUNCTURE_CAP_KMH}`);
});

test('28 : garde anti-re-ciblage — pas de re-engageStop vers un autre garage', () => {
  const race = makeRace(cfg(304, 600));
  race.departed = true;
  const c = addCar(race, 'A', '#111111');
  /* deja en route vers SON garage */
  const g = race.trk.poisAhead(1, 600_000).find((pp) => pp.kind === 'garage')!;
  c.st = 'toStop';
  c.stopKind = 'garage';
  c.targetS = g.s;
  c.stopHours = 0;
  c.tireWear = 1;   // usure maximale : la regle voudrait re-engager
  setPlan(c, { power: 1, actions: [{ id: newPlanId(), type: 'repair', ifTag: 'tireWorn', threshold: 0.5 }] });
  run(race, 120);
  assert.equal(c.targetS, g.s, 'targetS inchangé (pas de re-ciblage)');
  assert.equal(c.stopKind, 'garage', 'garage conserve');
});

test('28 : setPlan accepte la regle + defaultPlan l embarque a 0.85', () => {
  const race = makeRace(cfg(305, 200));
  race.departed = true;
  const c = addCar(race, 'A', '#111111');
  setPlan(c, { power: 1, actions: [
    { id: newPlanId(), type: 'repair', ifTag: 'tireWorn', threshold: 0.6 },
  ] });
  assert.ok(c.plan.actions.some((a) => a.ifTag === 'tireWorn' && (a as { threshold: number }).threshold === 0.6),
    'setPlan garde la regle tireWorn');
  /* plan par defaut : regle a l id carId*1000+3, seuil 0.85 */
  const dp = defaultPlan(7);
  const rule = dp.actions.find((a) => a.ifTag === 'tireWorn');
  assert.ok(rule, 'defaultPlan contient la regle');
  assert.equal(rule!.id, 7 * 1000 + 3, 'id deterministe carId*1000+3');
  assert.equal((rule as { threshold: number }).threshold, 0.85, 'seuil 0.85');
});

test('28 : serialisation additive — la regle survit, un etat ancien se charge', () => {
  const race = makeRace(cfg(306, 300));
  race.departed = true;
  const c = addCar(race, 'A', '#111111');
  setPlan(c, { power: 1, actions: [
    { id: newPlanId(), type: 'repair', ifTag: 'tireWorn', threshold: 0.7 },
  ] });
  const re = deserializeRace(serializeRace(race));
  const rule = (re.cars[0] as RaceCar).plan.actions.find((a) => a.ifTag === 'tireWorn');
  assert.ok(rule, 'la regle survit a serialize/deserialize');
  assert.equal((rule as { threshold: number }).threshold, 0.7, 'seuil identique');
  /* etat ANCIEN (sans la regle, sans le champ) : se charge sans erreur */
  const raw = JSON.parse(serializeRace(race));
  raw.cars[0].plan.actions = [];
  assert.doesNotThrow(() => {
    const re2 = deserializeRace(JSON.stringify(raw));
    stepRace(re2, 240);
  }, 'un plan sans la regle fonctionne');
});
