/* Tests du cœur physique — la garantie de non-régression du projet.
   Chaque test fait tourner le moteur headless (aucun rendu, aucun réseau). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeGame, advance, L_METERS,
} from '../core/proto.ts';
import { DT, CAR_L, CAR_D } from '../core/engine.ts';

type Res = {
  snaps: string[];
  gripMaxPl: number;
  gripMaxRv: number;
  contact: number;
  lapFrames: number | null;
  g: any;
};

function run(seed: number, seconds: number, withRival: boolean, lapFrom = -1): Res {
  const g: any = makeGame(seed);
  if (withRival) { g.rv.on = true; g.rv.s = 460; g.rv.v = 20; }
  const frames = Math.round(seconds / DT);
  const snaps: string[] = [];
  let gripMaxPl = 0, gripMaxRv = 0, contact = 0, lapFrames: number | null = null;
  for (let i = 0; i < frames; i++) {
    advance(g, DT);
    if (g.pl.grip > gripMaxPl) gripMaxPl = g.pl.grip;
    if (g.rv.on && g.rv.grip > gripMaxRv) gripMaxRv = g.rv.grip;
    if (g.rv.on && Math.abs(g.pl.s - g.rv.s) < CAR_L && Math.abs(g.pl.d - g.rv.d) < CAR_D) contact++;
    if (lapFrom > 0 && lapFrames === null && g.pl.s >= lapFrom + L_METERS) lapFrames = i + 1;
    if (i % 120 === 0) snaps.push(JSON.stringify([g.pl.s, g.pl.v, g.pl.d, g.pl.dSm, g.rv.s, g.rv.v, g.rv.d, g.rv.st, g.rv.t, g.rv.tries, g.rv.wins]));
  }
  return { snaps, gripMaxPl, gripMaxRv, contact, lapFrames, g };
}

/* 1. DÉTERMINISME — même graine, deux courses complètes avec duel,
   états identiques à l'octet près. C'est le prérequis des replays,
   des ghosts et de la simulation serveur autoritaire. */
test('déterminisme : deux courses identiques au bit près (500 s avec duel)', () => {
  const a = run(42, 500, true);
  const b = run(42, 500, true);
  assert.deepEqual(a.snaps, b.snaps, 'les états doivent être identiques image par image');
  assert.equal(a.g.pl.s, b.g.pl.s);
  assert.equal(a.g.rv.tries, b.g.rv.tries);
});

/* 2. TOUR SOLO — la voiture autopilotée boucle la piste dans le
   temps de référence (~7,8 min) sans dépasser le budget pneu. */
test('tour solo : temps de référence et budget de grip respecté', () => {
  const r = run(1337, 600, false, 500);
  assert.ok(r.lapFrames !== null, 'un tour complet doit être bouclé');
  const lapS = r.lapFrames * DT;
  assert.ok(lapS > 430 && lapS < 520, `temps au tour hors référence : ${lapS.toFixed(1)} s`);
  assert.ok(r.gripMaxPl <= 1.05, `grip max hors budget : ${r.gripMaxPl}`);
  assert.ok(Number.isFinite(r.g.pl.s) && Number.isFinite(r.g.pl.v));
});

/* 3. DUEL PROPRE — la rivale attaque, mais : aucun contact, les deux
   voitures dans leur budget de grip (l'IA ne triche pas). */
test('duel 900 s : au moins une tentative, zéro contact, grip dans le budget', () => {
  const r = run(777, 900, true);
  assert.equal(r.contact, 0, 'aucun contact ne doit survenir');
  assert.ok(r.gripMaxPl <= 1.05, `grip joueur hors budget : ${r.gripMaxPl}`);
  assert.ok(r.gripMaxRv <= 1.05, `grip rivale hors budget : ${r.gripMaxRv}`);
  assert.ok(r.g.rv.tries >= 1, 'la rivale doit tenter au moins une fois');
  assert.ok(Number.isFinite(r.g.rv.s));
});
