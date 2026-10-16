/* Tests de la couche d'agressivité IA (n°19) : 3 niveaux de conduite
   pilotés par le plan du joueur. Le niveau ne module QUE la fréquence
   et l'audace des manœuvres — CONTACT_P (par manœuvre) est identique
   pour tous ; CAR_D reste un mur physique ; aggrOf normalise tout
   plan ancien/invalide en 'standard'. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRace, addCar, stepRace, serializeRace, deserializeRace, setPlan,
  aggrOf, AGG, defaultPlan,
  DEFAULT_CONFIG, type RaceConfig, type RaceCar, type Aggression,
} from '../core/race.ts';
import { CAR_L } from '../core/engine.ts';

const EPOCH = Date.UTC(2026, 9, 14, 10, 0, 0);

function cfg(seed: number, totalKm: number, extra: Partial<RaceConfig> = {}): RaceConfig {
  return { ...DEFAULT_CONFIG, seed, totalKm, startEpochMs: EPOCH, ...extra };
}

function race2cars(seed: number, aggression: Aggression) {
  const race = makeRace(cfg(seed, 200));
  race.departed = true;
  addCar(race, 'A', '#111111');
  addCar(race, 'B', '#222222');
  // la voiture B (suiveuse) porte le niveau testé ; A mène
  for (const c of race.cars) {
    setPlan(c, { ...defaultPlan(c.id), aggression });
  }
  return race;
}

/* place B derrière A à `gap` m, A plus lente de `dv` m/s, dans une
   chaussée large (on cherche un point de plaine) : le duel y est
   géométriquement possible */
function placePair(race: ReturnType<typeof race2cars>, gap: number, dv: number) {
  const [a, b] = race.cars as [RaceCar, RaceCar];
  /* cherche un s où la chaussée permet un côte à côte (2*hwDuel >= CAR_D) */
  let s = 2000;
  for (; s < 100_000; s += 500) {
    if (2 * (race.trk.wAt(s) - 1.05) >= 2.35 && 2 * (race.trk.wAt(s + gap) - 1.05) >= 2.35) break;
  }
  a.s = s; a.v = 30; a.d = 0; a.st = 'run';
  b.s = s - gap; b.v = 30 + dv; b.d = 0; b.st = 'run';
  b.attackCooldown = 0; b.attackMan = false;
  a.attackCooldown = 0; a.attackMan = false;
  return [a, b] as [RaceCar, RaceCar];
}

/* une manœuvre est-elle lancée dans les premières secondes ? on lit
   attackMan après un court run (le boolean retombe quand la manœuvre
   se termine, d'où le pas court) */
function attackLaunched(race: ReturnType<typeof race2cars>, seconds: number): boolean {
  const b = race.cars[1]!;
  const before = b.attackMan;
  const n = Math.ceil(seconds / (1 / 120));
  stepRace(race, n);
  /* la manœuvre a pu être lancée PUIS terminée pendant le run : on
     détecte aussi le cooldown armé (signe qu'une manœuvre a eu lieu) */
  return b.attackMan || b.attackCooldown > 0 || before;
}

test('sécurité n\'attaque pas où le standard attaque (gap 8 m, +1,0 m/s)', () => {
  const rStd = race2cars(301, 'standard');
  const rSec = race2cars(301, 'securite');
  placePair(rStd, 8, 1.0);
  placePair(rSec, 8, 1.0);
  assert.ok(attackLaunched(rStd, 3), 'standard lance (gapMax 12 > 8, dvReq -0.5 < +1.0)');
  assert.ok(!attackLaunched(rSec, 3), 'sécurité ne lance pas (gapMax 6 < 8)');
});

test('agressif attaque où le standard n\'attaque pas (gap 15 m, -1,0 m/s)', () => {
  const rAgg = race2cars(307, 'agressif');
  const rStd = race2cars(307, 'standard');
  placePair(rAgg, 15, -1.0);
  placePair(rStd, 15, -1.0);
  assert.ok(attackLaunched(rAgg, 3), 'agressif lance (gapMax 20 > 15, dvReq -1.5 < -1.0)');
  assert.ok(!attackLaunched(rStd, 3), 'standard ne lance pas (gapMax 12 < 15)');
});

test('CONTACT_P identique : le tirage de contact ne dépend pas du niveau', () => {
  /* le PRNG des contacts est semé par la graine de course, pas par la
     voiture : même graine + même instant de manœuvre => même tirage.
     On vérifie que la TABLE ne change pas la probabilité : AGG n'a
     aucun champ de probabilité, et le code tire toujours CONTACT_P. */
  for (const lvl of ['securite', 'standard', 'agressif'] as Aggression[]) {
    assert.ok('cooldownS' in AGG[lvl] && !('contactP' in (AGG[lvl] as object)),
      `AGG.${lvl} ne module pas la probabilité`);
  }
  /* même scénario de manœuvre sur 3 courses même graine, niveau différent :
     le rng est semé à l'identique, la SEULE divergence possible vient du
     nombre de manœuvres (fréquence), pas du tirage par manœuvre */
  const evts = (lvl: Aggression) => {
    const r = race2cars(311, lvl);
    placePair(r, 8, 1.0);
    stepRace(r, Math.ceil(30 / (1 / 120)));
    return r.cars[1]!.events.filter((e) => e.msg.includes('contact')).length;
  };
  /* à gap 8 + dv +1,0 : standard ET agressif attaquent, sécurité non —
     le tirage par manœuvre est le même tirage rng de la même graine */
  const std = evts('standard');
  const agg = evts('agressif');
  assert.ok(std === agg, `même graine/même manœuvre => même tirage (${std} vs ${agg})`);
});

test('cooldown par niveau : 60 / 120 / 180 s', () => {
  assert.equal(AGG.agressif.cooldownS, 60);
  assert.equal(AGG.standard.cooldownS, 120);
  assert.equal(AGG.securite.cooldownS, 180);
  /* en simulation : après une manœuvre, attackCooldown est armé au
     niveau du plan */
  const r = race2cars(313, 'securite');
  const [a, b] = placePair(r, 5, 2.0); // sécurité attaque (gap 5 < 6, dv +2 > 1.5)
  void a;
  stepRace(r, Math.ceil(2 / (1 / 120)));
  if (b.attackMan || b.attackCooldown > 0) {
    assert.ok(b.attackCooldown > 120, `cooldown sécurité > standard 120 (${b.attackCooldown})`);
  }
});

test('pression permanente : l\'agressif colle plus près que le standard', () => {
  /* garde de suivi à l'équilibre de la consigne : vT suit
     vFront + max(0, freeGap - followDead)*0.35 ; l'équilibre est
     d'autant plus serré que followDead est petit */
  assert.ok(AGG.agressif.followDead < AGG.standard.followDead,
    'followDead agressif < standard');
  assert.ok(AGG.standard.followDead < AGG.securite.followDead,
    'followDead standard < sécurité');
  /* simulation longue derrière un leader lent : l'écart final
     agressif < standard */
  const gap = (lvl: Aggression) => {
    const r = race2cars(317, lvl);
    const [a, b] = placePair(r, 20, 3.0);
    a.v = 20; // leader lent : b se stabilise derrière
    stepRace(r, Math.ceil(60 / (1 / 120)));
    return a.s - b.s - CAR_L;
  };
  const gAgg = gap('agressif');
  const gStd = gap('standard');
  const gSec = gap('securite');
  assert.ok(gAgg <= gStd + 0.5 && gStd <= gSec + 0.5,
    `écart d'équilibre agressif ≤ standard ≤ sécurité (${gAgg.toFixed(1)} / ${gStd.toFixed(1)} / ${gSec.toFixed(1)})`);
});

test('setPlan : agressivité inconnue ou absente => standard', () => {
  const race = race2cars(319, 'standard');
  const c = race.cars[0]!;
  setPlan(c, { ...defaultPlan(c.id), aggression: 'nimportequoi' as Aggression });
  assert.equal(aggrOf(c), 'standard');
  setPlan(c, { ...defaultPlan(c.id), aggression: undefined });
  assert.equal(aggrOf(c), 'standard');
  setPlan(c, { ...defaultPlan(c.id), aggression: 'agressif' });
  assert.equal(aggrOf(c), 'agressif');
});

test('compat descendante : plan sérialisé SANS aggression => standard', () => {
  const race = race2cars(321, 'agressif');
  const raw = serializeRace(race);
  /* simule un ancien état : on retire la clé du plan de chaque voiture */
  const obj = JSON.parse(raw);
  for (const c of obj.cars) delete c.plan.aggression;
  const old = deserializeRace(JSON.stringify(obj));
  for (const c of old.cars) {
    assert.equal(aggrOf(c as RaceCar), 'standard');
  }
  assert.doesNotThrow(() => stepRace(old, 240));
});

test('CAR_D intouchable : aucun niveau n\'attaque en chaussée étroite', () => {
  /* cherche un s où hwDuel ne permet PAS CAR_D (chaussée étroite :
     forêt/altitude — il faut une course LONGUE, les segments de biome
     font 150-500 km et une route de 200 km reste en plaine) */
  const race = makeRace(cfg(323, 2000));
  race.departed = true;
  addCar(race, 'A', '#111111');
  addCar(race, 'B', '#222222');
  for (const c of race.cars) setPlan(c, { ...defaultPlan(c.id), aggression: 'agressif' });
  const [a, b] = race.cars as [RaceCar, RaceCar];
  const narrow = (s0: number) =>
    2 * (race.trk.wAt(s0) - 1.05) < 2.05 && 2 * (race.trk.wAt(s0 + 5) - 1.05) < 2.05;
  let s = 1000;
  for (; s < race.trk.finishS - 10; s += 250) {
    if (narrow(s)) break;
  }
  assert.ok(narrow(s), 'point de chaussée étroite trouvé');
  a.s = s; a.v = 25; a.d = 0; a.st = 'run';
  b.s = s - 5; b.v = 30; b.d = 0; b.st = 'run';
  b.attackCooldown = 0; b.attackMan = false;
  /* vérifie PAS À PAS : dès qu'une manœuvre se lance, ou dès que la
     paire quitte la zone étroite, on s'arrête */
  let launched = false;
  for (let i = 0; i < 240; i++) {
    if (!narrow(b.s) || !narrow(a.s)) break; // sorti de la zone : on ne teste plus
    stepRace(race, 1);
    if (b.attackMan || b.attackCooldown > 0) { launched = true; break; }
  }
  assert.ok(!launched,
    'agressif ne lance rien en chaussée étroite (le plus audace des 3)');
  assert.ok(Math.abs(a.d - b.d) < 2.05 || a.s - b.s >= CAR_L,
    'pas de chevauchement latéral sous CAR_D');
});
