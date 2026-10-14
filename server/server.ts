/* ============================================================
   SERVEUR AUTORITAIRE (ADR 0001) — Node stdlib, zéro dépendance
   ============================================================
   La simulation vit ICI, 24 h/24 : pas fixe 1/120 s en temps réel,
   état persisté sur disque (reprise après redémarrage — ADR 0004 :
   même graine ⇒ même course). Les clients ne font que lire l'état
   et soumettre des plans (ADR 0002). Horloge calée sur Paris.
   Lancement : node --experimental-strip-types server/server.ts
*/
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DT } from '../core/engine.ts';
import {
  makeRace, addCar, stepRace, rankCars, serializeRace, deserializeRace,
  setPlan, parisClock, type Plan,
} from '../core/race.ts';

const PORT = Number(process.env.RALLY_PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'race-state.json');
const SAVE_EVERY_S = 10;
const SNAPSHOT_EVERY_S = 1;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', 'web');

const TOTAL_KM = Number(process.env.RALLY_TOTAL_KM ?? 1000);
const SEED = Number(process.env.RALLY_SEED ?? 42);

function loadRace() {
  if (existsSync(STATE_FILE)) {
    try {
      const race = deserializeRace(readFileSync(STATE_FILE, 'utf8'));
      console.log(`Reprise de la course : graine ${race.seed}, ${race.cars.length} voitures, simT=${Math.round(race.simT)} s`);
      return race;
    } catch (e) {
      console.error('État illisible, nouvelle course :', e);
    }
  }
  const race = makeRace(SEED, TOTAL_KM);
  addCar(race, 'Renard', '#e63946');
  addCar(race, 'Lynx', '#457b9d');
  addCar(race, 'Fennec', '#f4a261');
  return race;
}

const race = loadRace();
let saveAcc = 0;
let snapshot = buildSnapshot();

function buildSnapshot() {
  const ranked = rankCars(race);
  return {
    simT: race.simT,
    clock: parisClock(race),
    finished: race.finished,
    finishS: race.trk.finishS,
    totalKm: race.totalKm,
    seed: race.seed,
    cars: ranked.map((c, i) => ({
      id: c.id,
      rank: i + 1,
      name: c.name,
      color: c.color,
      km: c.s / 1000,
      v: c.v * 3.6,
      fuel: c.fuel,
      fatigue: c.fatigue,
      st: c.st,
      stopKind: c.stopKind,
      stopUntil: c.stopUntil,
      plan: c.plan,
      finishedAt: c.finishedAt,
      events: c.events,
      d: c.d,
      pos: race.trk.roadPoint(c.s),
    })),
  };
}

function save() {
  try {
    writeFileSync(STATE_FILE, serializeRace(race));
  } catch (e) {
    console.error('Sauvegarde impossible :', e);
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJSON(res: http.ServerResponse, code: number, obj: unknown) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) { reject(new Error('body trop grand')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  try {
    if (url.pathname === '/api/state') {
      sendJSON(res, 200, snapshot);
      return;
    }
    if (url.pathname === '/api/track') {
      const s0 = Number(url.searchParams.get('s0') ?? '0');
      const step = Math.max(8, Number(url.searchParams.get('step') ?? '80'));
      const len = Math.min(200_000, Number(url.searchParams.get('len') ?? 60000));
      const pts: { x: number; y: number }[] = [];
      for (let s = s0; s < s0 + len; s += step) {
        pts.push(race.trk.roadPoint(Math.min(s, race.trk.finishS)));
      }
      sendJSON(res, 200, { pts });
      return;
    }
    if (url.pathname === '/api/plan' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { carId: number; plan: Plan };
      const car = race.cars.find((c) => c.id === body.carId);
      if (!car) { sendJSON(res, 404, { error: 'voiture inconnue' }); return; }
      setPlan(car, body.plan);
      snapshot = buildSnapshot();
      sendJSON(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/api/cars' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { name: string; color: string };
      if (race.cars.length >= 40) { sendJSON(res, 400, { error: 'grille pleine' }); return; }
      addCar(race, (body.name ?? '').slice(0, 20) || `Équipe ${race.cars.length + 1}`, body.color ?? '#888888');
      snapshot = buildSnapshot();
      save();
      sendJSON(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/api/reset' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}') as { seed?: number; totalKm?: number };
      const names = race.cars.map((c) => ({ name: c.name, color: c.color }));
      const fresh = makeRace(body.seed ?? SEED, body.totalKm ?? TOTAL_KM);
      for (const c of names) addCar(fresh, c.name, c.color);
      applyReplace(fresh);
      sendJSON(res, 200, { ok: true });
      return;
    }
    // fichiers statiques (interface)
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.normalize(path.join(WEB_DIR, p));
    if (!file.startsWith(WEB_DIR)) { res.writeHead(403); res.end(); return; }
    try {
      const data = readFileSync(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('404');
    }
  } catch (e) {
    sendJSON(res, 400, { error: String(e) });
  }
});

function applyReplace(fresh: ReturnType<typeof makeRace>) {
  Object.assign(race, fresh);
  snapshot = buildSnapshot();
  save();
}

const STEP_BATCH = 120;
let acc = 0;
let lastMs = Date.now();
const CYCLE_MS = 1000 * STEP_BATCH * DT;

setInterval(() => {
  const now = Date.now();
  acc += now - lastMs;
  lastMs = now;
  if (acc > CYCLE_MS * 5) acc = CYCLE_MS * 5;
  while (acc >= CYCLE_MS) {
    acc -= CYCLE_MS;
    if (!race.finished) stepRace(race, STEP_BATCH);
  }
  snapshot = buildSnapshot();
  saveAcc += 1;
  if (saveAcc >= SAVE_EVERY_S) { saveAcc = 0; save(); }
}, Math.round(CYCLE_MS));

server.listen(PORT, HOST, () => {
  console.log(`Rally Raid — serveur autoritaire sur http://${HOST}:${PORT}`);
  console.log(`Course ${race.totalKm} km, graine ${race.seed}, ${race.cars.length} voitures, temps réel 1:1 (Paris)`);
});

process.on('SIGINT', () => { save(); process.exit(0); });
process.on('SIGTERM', () => { save(); process.exit(0); });
