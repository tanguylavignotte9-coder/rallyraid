/* ============================================================
   SERVEUR AUTORITAIRE (ADR 0001) — Node stdlib, zéro dépendance
   ============================================================
   La simulation vit ICI, 24 h/24 : pas fixe 1/120 s en temps réel,
   état persisté sur disque (reprise après redémarrage — ADR 0004 :
   même graine ⇒ même course). Horloge calée sur Paris.

   Comptes (design arrêté) : pas d'auto-inscription — l'admin crée
   les comptes. Toutes les routes API exigent une session valide ;
   les pages de jeu (carte, admin) aussi. L'interface est
   « une voiture » : un joueur ne voit que SA voiture en détail.

   Lancement : node --experimental-strip-types server/server.ts
*/
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DT } from '../core/engine.ts';
import {
  makeRace, addCar, stepRace, rankCars, serializeRace, deserializeRace,
  setPlan, wakeSurvival, parisClock, DEFAULT_CONFIG,
  type Plan, type Race, type RaceCar, type RaceConfig,
} from '../core/race.ts';
import { AccountStore, hashPassword, randomPassword, type Level } from './accounts.ts';

const PORT = Number(process.env.RALLY_PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, 'race-state.json');
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const WEB_DIR = path.join(__dirname, '..', 'web');
const SAVE_EVERY_S = 10;

/* palette contrôlée des livrées : pas de doublons de couleur dans
   la course (vision : chaque voiture reconnaissable de loin) */
const LIVERY_PALETTE = [
  '#e63946', '#457b9d', '#f4a261', '#2a9d8f', '#e9c46a',
  '#9b5de5', '#f15bb5', '#00bbf9', '#00f5d4', '#fee440',
  '#e76f51', '#8ab17d', '#5f0f40', '#fb8b24', '#003049',
  '#7f5539', '#b8b8ff', '#ff70a6', '#4361ee', '#3a0ca3',
];

/* ---- comptes ---- */
const accounts = new AccountStore(ACCOUNTS_FILE);
const adminPass = accounts.ensureAdmin();
if (adminPass !== null) {
  console.log('==========================================================');
  console.log('  PREMIER LANCEMENT — compte admin créé');
  console.log(`  identifiant : admin`);
  console.log(`  mot de passe : ${adminPass}`);
  console.log('  (affiché une seule fois — modifiable dans la page admin)');
  console.log('==========================================================');
}

/* ---- course ---- */
function loadRace(): Race {
  if (existsSync(STATE_FILE)) {
    try {
      const race = deserializeRace(readFileSync(STATE_FILE, 'utf8'));
      console.log(`Reprise de la course : graine ${race.seed}, ${race.cars.length} voitures, phase=${race.phase}`);
      return race;
    } catch (e) {
      console.error('État illisible, nouvelle course :', e);
    }
  }
  const cfg: RaceConfig = { ...DEFAULT_CONFIG, startEpochMs: Date.now() + 60 * 60 * 1000 };
  return makeRace(cfg);
}

const race = loadRace();
let saveAcc = 0;
let snapshot = buildSnapshot();

type PublicCar = {
  id: number; rank: number; name: string; color: string;
  km: number; v: number; st: string; stopKind: string | null;
  configured: boolean;
};

/* ce qu'un joueur voit des AUTRES : position, nom, km, état visible —
   jamais leurs jauges ni leur vitesse (vision : « des adversaires, on
   ne voit que positions et écarts ») */
function publicCar(c: RaceCar, i: number): PublicCar {
  return {
    id: c.id, rank: i + 1, name: c.name, color: c.color,
    km: c.s / 1000, v: 0, st: c.st, stopKind: c.stopKind,
    configured: c.owner !== null,
  };
}

function buildSnapshot() {
  const ranked = rankCars(race);
  return {
    simT: race.simT,
    clock: parisClock(race),
    phase: race.phase,
    finished: race.finished,
    finishS: race.trk.finishS,
    totalKm: race.totalKm,
    seed: race.seed,
    startEpochMs: race.config.startEpochMs,
    maxCars: race.config.maxCars,
    cars: ranked.map((c, i) => publicCar(c, i)),
  };
}

/* snapshot nominatif : SA voiture en détail + les autres en public */
function buildMe(car: RaceCar): unknown {
  const ranked = rankCars(race);
  const i = ranked.indexOf(car);
  return {
    ...snapshot,
    me: {
      ...publicCar(car, i),
      fuel: car.fuel,
      fatigue: car.fatigue,
      v: car.v * 3.6,
      plan: car.plan,
      events: car.events,
      finishedAt: car.finishedAt,
      d: car.d,
      survivalStop: car.survivalStop,
      pos: race.trk.roadPoint(car.s),
    },
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
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
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

/* cookie de session (httpOnly — le JS client ne le lit jamais) */
function tokenOf(req: http.IncomingMessage): string | undefined {
  const raw = req.headers.cookie ?? '';
  const m = /(?:^|;\s*)rallysession=([a-f0-9]+)/.exec(raw);
  return m?.[1];
}

function setCookie(res: http.ServerResponse, token: string) {
  res.setHeader('set-cookie', `rallysession=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${30 * 24 * 3600}`);
}

function touch(car: RaceCar | null) {
  /* connexion du joueur : lève l'arrêt de survie et rafraîchit le
     compteur « vu » — la voiture repart si elle était figée */
  if (!car) return;
  car.lastSeenSimT = race.simT;
  if (car.survivalStop) wakeSurvival(race, car);
}

function carOfUser(user: string): RaceCar | null {
  return race.cars.find((c) => c.owner === user) ?? null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  try {
    /* ---------- routes SANS session ---------- */
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { user?: string; pass?: string };
      const s = accounts.login((body.user ?? '').trim(), body.pass ?? '');
      if (!s) { sendJSON(res, 401, { error: 'identifiant ou mot de passe invalide, ou compte désactivé' }); return; }
      setCookie(res, s.token);
      const acc = accounts.byToken(s.token)!;
      const car = carOfUser(acc.username);
      touch(car);
      snapshot = buildSnapshot();
      sendJSON(res, 200, { user: acc.username, level: acc.level, carId: car?.id ?? null });
      return;
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      const t = tokenOf(req);
      if (t) accounts.logout(t);
      res.setHeader('set-cookie', 'rallysession=; HttpOnly; Path=/; Max-Age=0');
      sendJSON(res, 200, { ok: true });
      return;
    }

    /* ---------- auth : TOUT le reste exige une session ----------
       (exception : la page de connexion et son script — sinon personne
       ne peut se connecter) */
    if (url.pathname === '/login.html' || url.pathname === '/login.js') {
      const file = path.join(WEB_DIR, 'login.html');
      try {
        const data = readFileSync(file);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(data);
      } catch { res.writeHead(404); res.end(); }
      return;
    }

    const acc = accounts.byToken(tokenOf(req));
    if (!acc) { sendJSON(res, 401, { error: 'session requise' }); return; }

    const me = carOfUser(acc.username);
    touch(me); // toute requête authentifiée compte comme connexion du joueur

    if (url.pathname === '/api/me') {
      sendJSON(res, 200, { user: acc.username, level: acc.level, carId: me?.id ?? null, phase: race.phase });
      return;
    }

    if (url.pathname === '/api/state') {
      /* joueur avec voiture configurée : SA voiture en détail ; les
         autres en public. Super : sélecteur discret (viewCar param) */
      let viewCar = me;
      if (acc.level !== 'player' && url.searchParams.get('viewCar')) {
        const id = Number(url.searchParams.get('viewCar'));
        viewCar = race.cars.find((c) => c.id === id) ?? me;
      }
      if (viewCar) { sendJSON(res, 200, buildMe(viewCar)); return; }
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

    if (url.pathname === '/api/configure' && req.method === 'POST') {
      /* première configuration de SA voiture : nom d'équipe + livrée.
         La voiture n'existait pas avant — elle s'insrit sur la grille */
      if (me) { sendJSON(res, 400, { error: 'voiture déjà configurée' }); return; }
      if (race.phase !== 'preparation') { sendJSON(res, 400, { error: 'la grille est fermée — course en cours' }); return; }
      const body = JSON.parse(await readBody(req)) as { name?: string; color?: string };
      const name = (body.name ?? '').trim().slice(0, 20);
      if (name.length < 2) { sendJSON(res, 400, { error: 'nom d\'équipe trop court' }); return; }
      if (race.cars.length >= race.config.maxCars) { sendJSON(res, 400, { error: 'grille complète' }); return; }
      let color = body.color ?? '';
      if (!LIVERY_PALETTE.includes(color)) { sendJSON(res, 400, { error: 'livrée inconnue' }); return; }
      if (race.cars.some((c) => c.color === color)) { sendJSON(res, 400, { error: 'livrée déjà prise dans cette course' }); return; }
      const car = addCar(race, name, color);
      car.owner = acc.username;
      acc.carId = car.id;
      accounts.save();
      snapshot = buildSnapshot();
      save();
      sendJSON(res, 200, { ok: true, carId: car.id });
      return;
    }

    if (url.pathname === '/api/liveries') {
      /* livrées encore disponibles pour SA configuration */
      sendJSON(res, 200, {
        palette: LIVERY_PALETTE,
        taken: race.cars.map((c) => c.color),
        phase: race.phase,
      });
      return;
    }

    if (url.pathname === '/api/plan' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { carId?: number; plan: Plan };
      let car = me;
      /* super utilisateur : peut éditer le plan de n'importe quelle voiture */
      if (acc.level !== 'player' && body.carId !== undefined) {
        car = race.cars.find((c) => c.id === body.carId) ?? me;
      }
      if (!car) { sendJSON(res, 404, { error: 'aucune voiture à planifier — configurez-la d\'abord' }); return; }
      setPlan(car, body.plan);
      snapshot = buildSnapshot();
      sendJSON(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/api/cars') {
      /* liste discrète des participants (sélecteur super utilisateur) */
      if (acc.level === 'player') { sendJSON(res, 403, { error: 'réservé aux supers' }); return; }
      sendJSON(res, 200, {
        cars: race.cars.map((c) => ({ id: c.id, name: c.name, owner: c.owner })),
      });
      return;
    }

    /* ---------- routes ADMIN ---------- */
    if (url.pathname.startsWith('/api/admin/')) {
      if (acc.level !== 'admin') { sendJSON(res, 403, { error: 'réservé aux admins' }); return; }

      if (url.pathname === '/api/admin/accounts' && req.method === 'GET') {
        sendJSON(res, 200, {
          accounts: [...accounts.accounts.values()].map((a) => ({
            username: a.username, level: a.level, disabled: a.disabled,
            carId: a.carId, created: a.created,
          })),
        });
        return;
      }
      if (url.pathname === '/api/admin/accounts' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { user?: string; pass?: string; level?: Level };
        const r = accounts.create((body.user ?? '').trim(), body.pass ?? '', body.level ?? 'player');
        if ('error' in r) { sendJSON(res, 400, { error: r.error }); return; }
        sendJSON(res, 200, { ok: true });
        return;
      }
      if (url.pathname === '/api/admin/reset-pass' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { user?: string; pass?: string };
        const ok = accounts.resetPassword((body.user ?? '').trim(), body.pass ?? '');
        sendJSON(res, ok ? 200 : 400, ok ? { ok: true } : { error: 'impossible (mot de passe trop court ?)' });
        return;
      }
      if (url.pathname === '/api/admin/level' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { user?: string; level?: Level };
        const ok = accounts.setLevel((body.user ?? '').trim(), body.level ?? 'player');
        sendJSON(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'compte inconnu' });
        return;
      }
      if (url.pathname === '/api/admin/disable' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { user?: string; disabled?: boolean };
        const ok = accounts.setDisabled((body.user ?? '').trim(), body.disabled ?? true);
        sendJSON(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'compte inconnu' });
        return;
      }
      if (url.pathname === '/api/admin/race' && req.method === 'GET') {
        sendJSON(res, 200, { config: race.config, phase: race.phase, cars: race.cars.length });
        return;
      }
      if (url.pathname === '/api/admin/reset' && req.method === 'POST') {
        /* RESET de course — paramètres complets, confirmation par
           bouton côté interface ; ici tout est revalidé */
        const body = JSON.parse(await readBody(req) || '{}') as Partial<RaceConfig> & { startIso?: string };
        const cfg: RaceConfig = {
          seed: Math.floor(Number(body.seed ?? race.config.seed)) || 42,
          totalKm: Math.min(50000, Math.max(50, Number(body.totalKm ?? 1000))),
          startEpochMs: body.startIso ? Date.parse(body.startIso) : (race.config.startEpochMs ?? Date.now()),
          prepMinutes: Math.max(0, Number(body.prepMinutes ?? 60)),
          endType: body.endType === 'duration' ? 'duration' : 'distance',
          endHours: Math.max(1, Number(body.endHours ?? 24 * 7)),
          survivalHours: Math.max(1, Number(body.survivalHours ?? 24)),
          poiDensity: Math.max(0.2, Math.min(3, Number(body.poiDensity ?? 1))),
          nightMode: body.nightMode === 'cap' ? 'cap' : 'mul',
          nightValue: Math.max(0.3, Math.min(1, Number(body.nightValue ?? 0.85))),
          maxCars: Math.max(2, Math.min(40, Number(body.maxCars ?? 40))),
        };
        if (body.nightMode === 'cap') cfg.nightValue = Math.min(300, Math.max(30, Number(body.nightValue ?? 110)));
        const fresh = makeRace(cfg);
        /* les comptes restent ; les voitures sont neuves — les joueurs
           devront reconfigurer leur voiture pour la nouvelle course */
        for (const a of accounts.accounts.values()) a.carId = null;
        accounts.save();
        Object.assign(race, fresh);
        snapshot = buildSnapshot();
        save();
        sendJSON(res, 200, { ok: true, phase: race.phase });
        return;
      }
      sendJSON(res, 404, { error: 'route admin inconnue' });
      return;
    }

    /* ---------- fichiers statiques (interface) ----------
       exigent une session : connexion requise pour jouer/admin */
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    if (p === '/admin.html') {
      if (acc.level !== 'admin') { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('403 — admin uniquement'); return; }
    }
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

/* ---- boucle temps réel : départ donné par l'horloge serveur ---- */
const STEP_BATCH = 120;
let acc2 = 0;
let lastMs = Date.now();
const CYCLE_MS = 1000 * STEP_BATCH * DT;

setInterval(() => {
  const now = Date.now();
  acc2 += now - lastMs;
  lastMs = now;
  if (acc2 > CYCLE_MS * 5) acc2 = CYCLE_MS * 5;
  while (acc2 >= CYCLE_MS) {
    acc2 -= CYCLE_MS;
    /* le cœur ne lit jamais l'horloge : le serveur donne le départ
       quand la date réelle a passé startEpochMs (déterminisme) */
    if (race.phase === 'preparation' && now >= race.config.startEpochMs) {
      race.departed = true;
      console.log('Départ donné !');
    }
    if (race.phase !== 'finished') stepRace(race, STEP_BATCH);
  }
  snapshot = buildSnapshot();
  saveAcc += 1;
  if (saveAcc >= SAVE_EVERY_S) { saveAcc = 0; save(); }
}, Math.round(CYCLE_MS));

server.listen(PORT, HOST, () => {
  console.log(`Rally Raid — serveur autoritaire sur http://${HOST}:${PORT}`);
  console.log(`Course ${race.totalKm} km, graine ${race.seed}, ${race.cars.length} voitures, temps réel 1:1 (Paris), phase=${race.phase}`);
});

process.on('SIGINT', () => { save(); process.exit(0); });
process.on('SIGTERM', () => { save(); process.exit(0); });
