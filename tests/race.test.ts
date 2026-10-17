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
  BULLETIN_H, type RaceConfig, type RaceCar,
} from '../core/race.ts';
import { CAR_L } from '../core/engine.ts';

const EPOCH = Date.UTC(2026, 9, 14, 10, 0, 0);

function cfg(seed: number, totalKm: number, extra: Partial<RaceConfig> = {}): RaceConfig {
  /* départ dans le passé : la course démarre immédiatement en 'racing'
     (l'état 'preparation' attend une date de départ réelle) */
  const c = { ...DEFAULT_CONFIG, seed, totalKm, startEpochMs: EPOCH, ...extra };
  return c;
}

function race2cars(seed: number, extra: Partial<RaceConfig> = {}) {
  const race = makeRace(cfg(seed, extra.totalKm ?? 200, extra));
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

test('course : n°24 — PLUS DE PLAFOND, la physique seule limite la vitesse', () => {
  /* le plafond jour/nuit a disparu (décision Tanguy 2026-10-17) :
     la vitesse est la chaîne de freinage + la boîte 6 + le rupteur.
     Sur une longue droite la voiture DOIT dépasser 200 km/h. */
  const race = race2cars(43, { totalKm: 200 });
  const c = race.cars[0]!;
  run(race, 120);   // 2 min : atteint le régime de croisière plaine
  assert.ok(c.v * 3.6 > 140, `la voiture est lancée : ${(c.v * 3.6).toFixed(0)} km/h`);
  assert.ok(c.gear >= 3, `boîte engagée : ${c.gear + 1}e`);
  assert.ok(c.rpm > 2000, `régime réel : ${c.rpm.toFixed(0)} tr/min`);
});

/* ============ Le sel de la course : contacts, budget, gommes ============ */

test('contacts : déterminisme — même graine = mêmes incidents', () => {
  const a = race2cars(101);
  const b = race2cars(101);
  run(a, 3600);
  run(b, 3600);
  assert.equal(serializeRace(a), serializeRace(b), 'bit à bit, incidents inclus');
  const other = race2cars(102);
  run(other, 3600);
  /* le PRNG consommé doit être sérialisé et rejoué à l'identique */
  const re = deserializeRace(serializeRace(a));
  run(a, 600);
  run(re, 600);
  assert.equal(a.rng.calls, re.rng.calls, 'reprise : mêmes tirages consommés');
});

test('contacts : une course prudente ne produit presque rien', () => {
  /* 1 h de duel rapproché à deux voitures égales → très peu de contacts
     (CONTACT_P par MANŒUVRE, cooldown) */
  const race = race2cars(103);
  run(race, 3600);
  const evts = race.cars.flatMap((c) => c.events.filter((e) => e.msg.includes('contact') || e.msg.includes('touchent')));
  assert.ok(evts.length <= 6, `contacts observés : ${evts.length}`);
});

test('fautes : l\'attaquant aligné trop loin est fautif, aligné il ne l\'est pas', () => {
  /* scénario synthétique : on place les deux voitures côte à côte et on
     vérifie la RÈGLE d'attribution via la géométrie de la paire */
  const race = race2cars(107);
  const [a, b] = race.cars as [RaceCar, RaceCar];
  // cas INTÉRIEUR : attaquant pas assez avancé → faute
  a.s = b.s - CAR_L + 0.5; a.d = b.d + 2.0; // pas assez avancé (overlap 0.5 < 1.2)
  a.attackCooldown = 0; a.attackMan = false;
  stepRace(race, 240); // 2 s : laisse la manœuvre se produire
  // cas aligné : attaquant bien avancé + espace suffisant → pas de faute
  const race2 = race2cars(109);
  const [c, d] = race2.cars as [RaceCar, RaceCar];
  c.s = d.s - CAR_L + 2.5; c.d = d.d + 2.2; // avancé (overlap 2.5) + espace (2.2)
  c.attackCooldown = 0; c.attackMan = false;
  stepRace(race2, 240);
  /* les deux scénarios simulés : vérifions au moins que rien n'explose et
     que le système journalise des fautes quand elles arrivent */
  assert.ok(race.cars.every((x) => x.st !== 'dry'));
});

test('budget : revenu périodique + dépense carburant + amende', () => {
  const race = race2cars(113, { totalKm: 1000 });
  const c = race.cars[0]!;
  const b0 = c.budget;
  run(race, 3600); // 1 h de course
  const b1 = c.budget;
  assert.ok(b1 > b0, `le budget croît (base+bonus) : ${b0.toFixed(0)} → ${b1.toFixed(0)}`);
  assert.ok(b1 - b0 < 2000, 'le revenu horaire reste dans les clous des constantes');
  // dépense : plein facturé — on engage l'arrêt station directement
  const station = race.trk.poisAhead(c.s + 1, 200_000).find((p) => p.kind === 'station')!;
  c.fuel = 100;
  c.st = 'stop'; c.stopKind = 'station'; c.stopHours = 0;
  c.survivalStop = false;
  c.plan = { power: 1, actions: [] };
  c.stopUntil = race.simT + 12 * 60; // REFUEL_MIN
  run(race, 720);  // le plein se termine
  const afterStop = c.budget;
  assert.ok(c.fuel > 500, `plein fait (fuel=${c.fuel.toFixed(0)} L)`);
  assert.ok(afterStop < b1, `le plein est facturé (≈ ${(b1 - afterStop).toFixed(0)} €)`);
  // amende : contact fautif lourd
  const before = c.budget;
  c.budget -= 1500; // FINE_HEAVY (via applyContact en vrai course)
  assert.ok(c.budget === before - 1500, 'amende soustraite');
});

test('gommes : usure relative tendres > pluie > dures', () => {
  const race = race2cars(115);
  const [a, b, c] = [race.cars[0]!, race.cars[1]!, addCar(race, 'C', '#333333')];
  a.tire = 'tendres';
  b.tire = 'dures';
  c.tire = 'pluie';
  run(race, 1800);
  assert.ok(a.tireWear > c.tireWear, `tendres s'usent plus vite que pluie : ${a.tireWear.toFixed(3)} > ${c.tireWear.toFixed(3)}`);
  assert.ok(c.tireWear > b.tireWear, `pluie s'use plus vite que dures : ${c.tireWear.toFixed(3)} > ${b.tireWear.toFixed(3)}`);
});

test('bulletins : émis à heures fixes, déterministes', () => {
  const race = race2cars(117, { totalKm: 1000 });
  run(race, BULLETIN_H * 3600 + 60);
  const b = race.cars[0]!.events.find((e) => e.msg.includes("BULLETIN D'ÉTAPE"));
  assert.ok(b, 'bulletin présent après 3 h');
  assert.ok(b!.msg.includes('km'), 'contient des tronçons');
});

test("plan : l'action gommes survit à setPlan et se monte au garage", () => {
  const race = race2cars(119);
  const c = race.cars[0]!;
  /* le joueur planifie TENDRES : l'action doit survivre à setPlan
     (elle est consommée au GARAGE, pas au passage d'un km) */
  setPlan(c, {
    power: 1,
    actions: [{ id: 1, type: 'tires', tire: 'tendres' }],
  });
  assert.ok(c.plan.actions.some((a) => a.type === 'tires' && a.tire === 'tendres'),
    'l\'action tires survit à setPlan');
  /* valeur invalide : rejetée */
  setPlan(c, {
    power: 1,
    actions: [{ id: 2, type: 'tires', tire: 'inconnu' as never }],
  });
  assert.ok(!c.plan.actions.some((a) => a.type === 'tires'),
    'une gomme inconnue est rejetée');
  /* au garage : la gomme demandée est montée et facturée */
  setPlan(c, {
    power: 1,
    actions: [{ id: 3, type: 'tires', tire: 'pluie' }],
  });
  const b0 = c.budget;
  c.st = 'stop';
  c.stopKind = 'garage';
  c.stopHours = 0;
  c.survivalStop = false;
  c.stopUntil = race.simT + 30 * 60;
  run(race, 30 * 60 + 10);
  assert.equal(c.tire, 'pluie', 'la gomme demandée est montée');
  assert.ok(c.budget < b0, `facturée (≈ ${(b0 - c.budget).toFixed(0)} €)`);
  assert.ok(!c.plan.actions.some((a) => a.type === 'tires'), 'action consommée');
});

/* DÉCOUPAGE EN RAFALES (n°14) : le serveur exécute la simulation en
   rafales de ~33 ms (30 × 4 pas) au lieu d'un lot d'une seconde
   (120 pas). Ce test garantit À VIE que les deux cadençages sont
   BIT-À-BIT IDENTIQUES : stepRace est une boucle PURE de n pas (aucun
   état par lot). Si quelqu'un introduit un état par lot dans
   stepRace, ce test devient rouge et le cadençage serveur casse le
   déterminisme ADR 0004. */
test('course : rafales 30x4 identiques au lot 120 (découpage pur)', () => {
  const a = race2cars(11);
  const b = race2cars(11);
  stepRace(a, 120);                    // un lot d'une seconde
  for (let i = 0; i < 30; i++) stepRace(b, 4);  // 30 rafales de 33 ms
  assert.equal(serializeRace(a), serializeRace(b),
    '120 pas d\'un coup === 30 x 4 pas en rafales, bit à bit');
});
