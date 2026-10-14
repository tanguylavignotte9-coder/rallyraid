/* Tests de la route linéaire — Phase 1.
   L'itinéraire départ→arrivée est généré à la demande, chunk par
   chunk ; ces tests verrouillent les trois garanties du design :
   déterminisme au bit près (replays, reprise serveur), continuité
   parfaite aux frontières de chunks (la voiture ne doit rien sentir),
   et génération à la demande sur des dizaines de milliers de km. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRoute, routeTrack, ensureChunk, buildChunk,
  RCHUNK, RSAMP, MAX_CACHED, type Route,
} from '../core/route.ts';

/* espacement minimal plausible entre deux POI (800 m) */
const SEG_MIN_DIST = 800;

/* grappillage générique : quelques sondes d'un chunk, pour comparer */
function probe(rt: Route, k: number): number[] {
  const c = ensureChunk(rt, k);
  const out: number[] = [];
  for (const i of [0, 1, 37, 500, 1299, RSAMP - 2, RSAMP - 1]) {
    out.push(c.hd[i], c.h[i], c.w[i], c.mua[i], c.xs[i], c.zs[i]);
  }
  for (const p of c.pois) out.push(p.s, p.kind.length);
  return out;
}

test('route : déterminisme chunk par chunk, même après éviction', () => {
  const a = makeRoute(2024, 1000);
  const b = makeRoute(2024, 1000);
  for (const k of [0, 1, 2, 5, 12, 30]) {
    assert.deepEqual(probe(a, k), probe(b, k), `chunk ${k} doit être identique`);
  }
  /* éviction puis régénération : le chunk revient À L'IDENTIQUE
     (garantie reprise serveur / replay) */
  const trk = routeTrack(a);
  const before = probe(a, 3);
  a.chunks.delete(3);
  a.order = a.order.filter((k) => k !== 3);
  trk.cvAt(3 * RCHUNK + 100); // force la reconstruction des chunks intermédiaires
  assert.deepEqual(probe(a, 3), before, 'le chunk régénéré doit être identique');
});

test('route : continuité aux frontières de chunks (cap, plan, altitude, grip)', () => {
  const rt = makeRoute(77, 200);
  const trk = routeTrack(rt);
  for (const k of [0, 1, 2, 4, 7]) {
    const s = k * RCHUNK;
    /* le cap et l'altitude sont CONTINUS au raccord */
    assert.ok(Math.abs(trk.cvAt(s + 0.01) - trk.cvAt(s - 0.01)) < 0.02,
      `saut de courbure à la frontière du chunk ${k}`);
    assert.ok(Math.abs(trk.heightAt(s + 0.01) - trk.heightAt(s - 0.01)) < 0.01,
      `saut d altitude à la frontière du chunk ${k}`);
    assert.ok(Math.abs(trk.wAt(s + 0.01) - trk.wAt(s - 0.01)) < 0.01,
      `saut de largeur à la frontière du chunk ${k}`);
    assert.ok(Math.abs(trk.muAt(s + 0.01) - trk.muAt(s - 0.01)) < 0.05,
      `saut de grip à la frontière du chunk ${k}`);
    /* le plan XY aussi (pour la carte 2D) */
    const p1 = trk.roadPoint(s - 0.01);
    const p2 = trk.roadPoint(s + 0.01);
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    assert.ok(dist < 1.0, `saut de position (${dist} m) à la frontière du chunk ${k}`);
  }
});

test('route : génération à la demande + fenêtre mémoire respectée', () => {
  const rt = makeRoute(4242, 5000); // 5 000 km — une vraie étape-raid
  const trk = routeTrack(rt);
  const sFar = 2_345_678; // ~2 345 km : 113 chunks plus loin
  const h = trk.heightAt(sFar);
  const cv = trk.cvAt(sFar);
  assert.ok(Number.isFinite(h) && Number.isFinite(cv), 'sondes lointaines finies');
  assert.ok(rt.chunks.size <= MAX_CACHED + 2, 'la fenêtre mémoire ne doit pas exploser');
  /* la fin de course est propre : pas de NaN au-delà de l arrivée */
  assert.ok(Number.isFinite(trk.cvAt(rt.finishS + 500)), 'au-delà de l arrivée : sondes finies');
  /* un retour en arrière (voiture arrêtée, carte) relit des chunks évictés */
  assert.ok(Number.isFinite(trk.heightAt(8_000)), 'relecture arrière finie');
});

test('route : POI déterministes, triés, densité par biome', () => {
  const a = routeTrack(makeRoute(99, 600));
  const b = routeTrack(makeRoute(99, 600));
  const pa = a.poisAhead(0, 600_000);
  const pb = b.poisAhead(0, 600_000);
  assert.deepEqual(pa, pb, 'les POI doivent être déterministes');
  assert.ok(pa.length > 10, 'il doit y avoir des POI sur 600 km');
  for (let i = 1; i < pa.length; i++) {
    assert.ok(pa[i].s >= pa[i - 1].s, 'POI triés par abscisse');
  }
  const count = (kind: string) => pa.filter((p) => p.kind === kind).length;
  assert.ok(count('station') > count('hotel'), 'plus de stations que d hôtels');
  assert.ok(count('hotel') > count('garage'), 'plus d hôtels que de garages');
  /* tous les types sont représentés dans les 600 premiers km */
  for (const kind of ['station', 'hotel', 'garage']) {
    assert.ok(count(kind) >= 1, `${kind} présent`);
  }
  /* pas deux POI DU MÊME TYPE trop proches (des types différents peuvent
     se regrouper — un bourg avec station ET hôtel, c'est un village-étape) */
  for (const kind of ['station', 'hotel', 'garage']) {
    const of = pa.filter((p) => p.kind === kind);
    for (let i = 1; i < of.length; i++) {
      assert.ok(of[i].s - of[i - 1].s >= SEG_MIN_DIST, `POI ${kind} espacés`);
    }
  }
});

/* espacement minimal plausible entre deux POI (800 m) */
