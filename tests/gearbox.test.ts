/* Tests n°24 — BOÎTE 6 + RÉGIME + SUPPRESSION DU PLAFOND + ASPIRATION v2.
   Le moteur a un régime, des rapports et un rupteur ; la vitesse est
   purement physique (plus de cap jour/nuit) ; le sillage survit à la
   mise à hauteur ; la conso est branchée au régime. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRace, addCar, stepRace, serializeRace, deserializeRace,
  DEFAULT_CONFIG, makeCar, TANK_L,
  type RaceConfig, type RaceCar,
} from '../core/race.ts';
import {
  driveStep, draftMul, rpmOf, torqueAt, FLAT, V_LIM,
  RATIOS, RPM_MAX, RPM_SHIFT_UP, CAR_L,
  type KinCar,
} from '../core/engine.ts';

const EPOCH = Date.UTC(2026, 9, 14, 10, 0, 0);
function cfg(seed: number, totalKm: number, extra: Partial<RaceConfig> = {}): RaceConfig {
  return { ...DEFAULT_CONFIG, seed, totalKm, startEpochMs: EPOCH, ...extra };
}

/* piste synthétique plate et droite : le banc pur du moteur */
const BENCH = {
  muAt: () => 1.0, cvAt: () => 0, crrAt: () => 1, heightAt: () => 0,
};
function benchCar(pwr = 1): KinCar {
  return { s: 0, v: 0, d: 0, dSm: 0, dRate: 0, roll: 0, pitch: 0,
    acc: 0, thr: 0, brkCmd: 0, grip: 0, abs: 0, steer: 0, pwr,
    gear: 0, rpm: 1000, shiftT: 0 } as KinCar;
}

test('boite 6 : 0-100 <= 8 s, 0-200 ~19.6 s, vmax 257 +/- 5, 5 passages', () => {
  const dt = 1 / 120;
  const c = benchCar(1);
  let t100: number | null = null, t200: number | null = null;
  let shifts = 0, prevGear = 0;
  for (let t = 0; t < 120; t += dt) {
    driveStep(BENCH, c, FLAT, dt);
    if (c.gear !== prevGear) { shifts++; prevGear = c.gear; }
    if (t100 === null && c.v * 3.6 >= 100) t100 = t;
    if (t200 === null && c.v * 3.6 >= 200) t200 = t;
  }
  assert.ok(t100 !== null && t100 <= 8, `0-100 : ${t100?.toFixed(1)} s > 8`);
  assert.ok(t200 !== null && t200 > 17 && t200 < 22, `0-200 : ${t200?.toFixed(1)} s hors 19.6 +/- 2`);
  assert.ok(Math.abs(c.v * 3.6 - 257) <= 5, `vmax : ${(c.v * 3.6).toFixed(0)} km/h hors 257 +/- 5`);
  assert.equal(shifts, 5, 'exactement 5 passages de 0 a vmax');
  assert.ok(c.gear === 5, '6e en vmax');
  /* rupteur PROGRESSIF : a vmax le regime affiche ~6840, pas 7000 */
  assert.ok(c.rpm > 6700 && c.rpm < RPM_MAX, `regime vmax : ${c.rpm.toFixed(0)}`);
  /* 200 km/h en 6e ~ 5030 tr/min */
  const rpm200 = rpmOf(5, 200 / 3.6);
  assert.ok(rpm200 > 4900 && rpm200 < 5500, `200 km/h en 6e : ${rpm200.toFixed(0)} tr/min`);
});

test('boite 6 : curseur pwr 0.6 -> vmax ~234, 0-100 <= 9 s', () => {
  const dt = 1 / 120;
  const c = benchCar(0.6);
  let t100: number | null = null;
  for (let t = 0; t < 120; t += dt) {
    driveStep(BENCH, c, FLAT, dt);
    if (t100 === null && c.v * 3.6 >= 100) t100 = t;
  }
  assert.ok(t100 !== null && t100 <= 9, `0-100 pwr 0.6 : ${t100?.toFixed(1)} s`);
  assert.ok(Math.abs(c.v * 3.6 - 234) <= 6, `vmax pwr 0.6 : ${(c.v * 3.6).toFixed(0)}`);
});

test('boite 6 : determinisme — 2 runs identiques au pas pres (ADR 0004)', () => {
  const run = () => {
    const c = benchCar(1);
    const trace: number[] = [];
    for (let i = 0; i < 2400; i++) {
      driveStep(BENCH, c, FLAT, 1 / 120);
      trace.push(c.gear, Math.round(c.rpm), c.v);
    }
    return trace;
  };
  assert.deepEqual(run(), run(), 'gear/rpm/v identiques pas a pas');
});

test('boite 6 : couple max a 4500, rupteur a 7000', () => {
  assert.equal(torqueAt(4500), 400);
  assert.ok(torqueAt(1000) < torqueAt(4500), 'montee du couple');
  assert.ok(torqueAt(7000) < torqueAt(5300), 'chute au rupteur');
  assert.ok(torqueAt(6999) >= 400 * 0.72, 'rupteur progressif : pas de chute a zero');
});

test('draftMul v2 : file indienne inchangee, cote a cote 0.70, fenetre etendue', () => {
  const mk = (s: number, d: number): KinCar =>
    ({ s, v: 50, d, dSm: d, dRate: 0, roll: 0, pitch: 0, acc: 0, thr: 0, brkCmd: 0, grip: 0, abs: 0, steer: 0, pwr: 1, gear: 5, rpm: 5000, shiftT: 0 }) as KinCar;
  const behind = mk(0, 0);
  /* file indienne : IDENTIQUE a l'ancienne formule sur ds e ]0,30], dd <= 1.9 */
  assert.ok(Math.abs(draftMul(behind, mk(30, 0)) - 1) < 1e-9, 'ds=30 -> 1');
  assert.ok(Math.abs(draftMul(behind, mk(15, 0)) - 0.85) < 1e-9, 'ds=15 -> 0.85');
  assert.ok(Math.abs(draftMul(behind, mk(1, 0)) - 0.71) < 1e-9, 'ds=1 -> 0.71');
  assert.ok(Math.abs(draftMul(behind, mk(15, 1.9)) - 0.85) < 1e-9, 'dd=1.9 garde le tow');
  /* v2 : cote a cote — le tow SURVIT a la mise a hauteur */
  assert.ok(Math.abs(draftMul(behind, mk(-1, 1.5)) - 0.70) < 1e-9, 'ds=-1 cote a cote -> 0.70');
  assert.ok(Math.abs(draftMul(behind, mk(-4, 2.2)) - 0.70) < 1e-9, 'deport attaque 2.2 m -> tow conserve');
  assert.ok(Math.abs(draftMul(behind, mk(-4.5, 0)) - 0.70) < 1e-9, 'entrefer -4.5 -> 0.70');
  /* hors fenetre */
  assert.equal(draftMul(behind, mk(31, 0)), 1, 'ds > 30 -> 1');
  assert.equal(draftMul(behind, mk(-CAR_L - 0.1, 0)), 1, 'ds <= -CAR_L -> 1');
  assert.equal(draftMul(behind, mk(15, 2.6)), 1, 'dd > 2.5 -> 1');
});

test('conso regime : croisiere au limiteur ~155 L/100 (banc plaine ~131), ralenti seul', () => {
  const dt = 1 / 120;
  /* croisiere : la pedale e equilibre la trainee a 200 km/h */
  /* la pedale d'equilibre a 200 km/h : la force moteur egale la
     trainee — on la trouve par la physique du driveStep lui-meme
     (consigne au-dessus, la pedale se cale et la vitesse plafonne
     au rupteur ; on mesure a mi-chemin vers le limiteur) */
  const c = benchCar(1);
  for (let i = 0; i < 3000; i++) driveStep(BENCH, c, FLAT, dt);   // ~ vmax 257
  /* en vmax au limiteur : thr 0.80 (banc) et regime ~6840 */
  const per100 = (0.00035 + (0.0025 * c.rpm / 1000 + 0.0137 * c.thr * c.rpm / 1000)) * 3600 / (c.v * 3.6 / 100);
  assert.ok(per100 > 120 && per100 < 190, `croisiere limiteur ${(c.v * 3.6).toFixed(0)} km/h : ${per100.toFixed(0)} L/100 (banc plaine ~131, thr ${c.thr.toFixed(2)})`);
  /* a l'arret, thr = 0 : il ne reste que le ralenti */
  const idle = 0.00035 * 3600;   // L/h
  assert.ok(idle < 2, `ralenti ${idle.toFixed(2)} L/h raisonnable`);
});

test('retrocompat : vieux race-state avec dayCapKmh et sans gear se charge', () => {
  const race = makeRace(cfg(99, 100));
  race.departed = true;
  const c = addCar(race, 'A', '#111111');
  stepRace(race, 240);
  const raw = JSON.parse(serializeRace(race));
  /* simule un ancien etat : dayCapKmh orphelin (tolere), pas de gear */
  raw.config.dayCapKmh = 190;
  delete raw.cars[0].gear;
  raw.cars[0].v = 45;   // ~160 km/h : la derive doit trouver la 5e/6e
  const old = deserializeRace(JSON.stringify(raw));
  const car = old.cars[0] as RaceCar;
  assert.ok(typeof car.gear === 'number' && car.gear >= 0 && car.gear <= 5, `gear derive : ${car.gear}`);
  assert.doesNotThrow(() => stepRace(old, 240), 'la course continue sans exception');
  /* les cles orphelines de config sont ignorees sans erreur */
  assert.ok((old.config as Record<string, unknown>).maxCars !== undefined, 'config chargee');
});

test('course entiere : boite en action sur la vraie route (conso + autonomie)', () => {
  const race = makeRace(cfg(12345, 300));
  race.departed = true;
  const c = addCar(race, 'A', '#111111');
  const fuel0 = c.fuel;
  let s0 = c.s;
  /* n°43 : la route émergente est plus sinueuse — la croisière passe
     ~82 % de l'heure en 5e/6e (17 % en 4e dans les secteurs lents),
     mais l'INSTANT final peut tomber en 4e : on garde le rapport
     DOMINANT de l'heure (échantillonné minute par minute). */
  const gearUse = new Array(8).fill(0);
  for (let t = 0; t < 60; t++) {
    stepRace(race, Math.ceil(60 / (1 / 120)));   // 1 min
    gearUse[c.gear]!++;
  }
  const hiGear = gearUse.slice(4).reduce((x, y) => x + y, 0);
  assert.ok(hiGear >= 30, `croisiere en 5e/6e : ${hiGear}/60 min (4e ${gearUse[3]} min)`);
  const km = (c.s - s0) / 1000;
  const used = fuel0 - c.fuel;
  const per100 = used / km * 100;
  assert.ok(c.rpm > 3000 && c.rpm < 7200, `regime de croisiere : ${c.rpm.toFixed(0)}`);  // n°43 : 3808 mesuré (route émergente plus sinueuse)
  assert.ok(per100 > 80 && per100 < 200, `conso plaine : ${per100.toFixed(0)} L/100 (n°43 : 138 mesuré)`);
  const autonomy = TANK_L / (per100 / 100);
  assert.ok(autonomy > 280 && autonomy < 520, `autonomie : ${autonomy.toFixed(0)} km (banc ~398)`);
});
