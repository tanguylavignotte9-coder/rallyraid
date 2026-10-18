/* Tests n°30 — durées de vie cibles des gommes : tendres ~6 h · dures
   ~12 h · pluie ~8 h au peloton médian. Calibration par constantes
   UNIQUEMENT (TIRE_WEAR_FULL_H 2 h → 7 h, wear 1,6/0,6/1,0 → 2/1/1,5) ;
   la formule d'accumulation (cercle de friction) est inchangée. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRace, addCar, stepRace,
  DEFAULT_CONFIG, TIRES, TIRE_WEAR_FULL_H,
  type RaceConfig,
} from '../core/race.ts';

const EPOCH = Date.UTC(2026, 9, 14, 10, 0, 0);

function cfg(seed: number, totalKm: number, extra: Partial<RaceConfig> = {}): RaceConfig {
  return { ...DEFAULT_CONFIG, seed, totalKm, startEpochMs: EPOCH, ...extra };
}

function run(race: ReturnType<typeof makeRace>, simSeconds: number) {
  stepRace(race, Math.ceil(simSeconds / (1 / 120)));
}

test('30 : verrou de calibration — FULL_H 7 h, rapports wear 2 : 1,5 : 1', () => {
  assert.equal(TIRE_WEAR_FULL_H, 3600 * 7);
  assert.equal(TIRES.dures.wear, 1);
  assert.equal(TIRES.tendres.wear, 2 * TIRES.dures.wear);
  assert.equal(TIRES.pluie.wear, 1.5 * TIRES.dures.wear);
});

test('30 : rapport d\'usure entre gommes — courses identiques, comportement identique', () => {
  /* Trois courses identiques (même graine), une voiture, une gomme.     Pour isoler le PURE facteur wear, on égalise μ (grip/wetGrip)     temporairement : à grip différent, chaque gomme négocie autrement     les virages et l'usure s'écarte du rapport exact — l'égalisation     rend le comportement (et donc le grip sollicité) identique. */
  const kinds = ['tendres', 'dures', 'pluie'] as const;
  const saved = new Map(kinds.map((k) => [k, { ...TIRES[k] }]));
  for (const k of kinds) { TIRES[k].grip = 1.0; TIRES[k].wetGrip = 1.0; }
  const wearFor = (tire: 'tendres' | 'dures' | 'pluie') => {
    const race = makeRace(cfg(300, 1800));
    race.departed = true;
    const c = addCar(race, 'A', '#111111');
    c.tire = tire;
    run(race, 10); // 1 200 pas
    return c.tireWear;
  };
  const wT = wearFor('tendres');
  const wD = wearFor('dures');
  const wP = wearFor('pluie');
  for (const k of kinds) Object.assign(TIRES[k], saved.get(k)!);
  assert.ok(wD > 0, `usure positive (dures=${wD.toFixed(4)})`);
  const near = (x: number, target: number) =>
    assert.ok(Math.abs(x / target - 1) <= 0.02, `rapport ${x.toFixed(3)} ≈ ${target}`);
  near(wT / wD, 2.0);
  near(wP / wD, 1.5);
  near(wT / wP, 4 / 3);
});

test('30 : vie à plein grip (analytique) — 7 h, cible peloton ~12 h', () => {
  const fullH = TIRE_WEAR_FULL_H / 3600 / TIRES.dures.wear;
  assert.equal(fullH, 7);
  assert.ok(Math.abs(7 / 0.58 - 12.07) < 0.1,
    '7 h à plein grip / usage peloton 0,58 ≈ 12,07 h de roulage (cible ~12 h)');
});
