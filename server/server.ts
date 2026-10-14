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
import { DT, SEG } from '../core/engine.ts';
import {
  makeRace, addCar, stepRace, rankCars, serializeRace, deserializeRace,
  setPlan, wakeSurvival, parisClock, parisHour, weatherRain, DEFAULT_CONFIG,
  TIRES, CB_RANGE_KM, CB_MIN_INTERVAL_S,
  type Plan, type Race, type RaceCar, type RaceConfig, type TireKind,
} from '../core/race.ts';
import { makeRoute, routeTrack, RCHUNK, RSAMP } from '../core/route.ts';
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

/* ============================================================
   REMPLISSAGE DE LA GRILLE AU DÉPART
   ============================================================
   Au coup d'envoi, TOUT compte joueur actif sans voiture en reçoit
   une automatiquement : nom = identifiant, livrée = première libre
   de la palette, plan par défaut du cœur, gommes dures. La grille
   est figée au départ — un compte créé après attend le reset
   suivant. Fonction PURE sur des données en entrée : même comptes
   dans le désordre ⇒ même remplissage (déterminisme). */
export type EligibleAccount = { username: string; created: number };

export function fillGrid(
  accountsList: EligibleAccount[],
  existingCars: { owner: string | null }[],
  palette: string[],
  maxCars: number,
): { username: string; color: string }[] {
  /* ordre DÉTERMINISTE : date de création, puis username (ties) */
  const sorted = [...accountsList].sort((a, b) =>
    a.created - b.created || (a.username < b.username ? -1 : a.username > b.username ? 1 : 0));
  const taken = new Set(existingCars.map((c) => c.owner).filter((o) => o !== null));
  /* couleurs prises : les voitures existantes occupent leur livrée */
  const usedColors = new Set<string>();
  for (const car of existingCars as { owner: string | null; color?: string }[]) {
    if (car.color) usedColors.add(car.color);
  }
  const free = palette.filter((col) => !usedColors.has(col));
  const out: { username: string; color: string }[] = [];
  const room = maxCars - existingCars.length;
  for (const acc of sorted) {
    if (out.length >= room) break;
    if (taken.has(acc.username)) continue;
    out.push({ username: acc.username, color: free.shift() ?? '#888888' });
  }
  return out;
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
  /* premier lancement : départ à now + fenêtre de préparation de la
     config (le reset admin définit lui-même sa date, lui ne change pas) */
  const cfg: RaceConfig = { ...DEFAULT_CONFIG, startEpochMs: Date.now() + DEFAULT_CONFIG.prepMinutes * 60_000 };
  return makeRace(cfg);
}

const race = loadRace();
let saveAcc = 0;
let snapshot = buildSnapshot();

/* CB de proximité : canal global unique ; la RÉCEPTION est filtrée par
   la distance entre équipes (≤ CB_RANGE_KM). Anti-flood par équipe.
   Simple journal en mémoire — les messages arrivent en temps réel. */
type CbMsg = { from: string; carId: number; msg: string; t: number };
let cbLog: CbMsg[] = [];
const cbLast = new Map<string, number>();

type PublicCar = {
  id: number; rank: number; name: string; color: string;
  km: number; v: number; st: string; stopKind: string | null;
  configured: boolean;
  pos3: { x: number; y: number; z: number };
  hd: number;
  d: number;
  brake: 0 | 1;
  weather: 'rain' | 'dry';
};

/* ce qu'un joueur voit des AUTRES : position, nom, km, état visible —
   jamais leurs jauges ni leur vitesse (vision : « des adversaires, on
   ne voit que positions et écarts ») */
function publicCar(c: RaceCar, i: number): PublicCar {
  const p = race.trk.roadPoint(c.s);
  return {
    id: c.id, rank: i + 1, name: c.name, color: c.color,
    km: c.s / 1000, v: 0, st: c.st, stopKind: c.stopKind,
    configured: c.owner !== null,
    autoCreated: c.autoCreated,
    pos3: { x: p.x, y: p.y, z: race.trk.heightAt(c.s) },
    hd: p.hd,
    d: c.d,
    brake: c.brkCmd > 0 ? 1 : 0,
    weather: weatherRain(race.seed, c.s) ? 'rain' : 'dry',
  };
}

function buildSnapshot() {
  const ranked = rankCars(race);
  /* HEURE décimale de Paris (0-24) : pilote le cycle jour/nuit 3D.
     La météo (weatherRain) dépend de l'ABSCISSE (zones de 50 km),
     pas du biome : elle est donc exposée PAR VOITURE dans publicCar. */
  const hour = parisHour(race);
  return {
    simT: race.simT,
    hour,
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
      budget: car.budget,
      tire: car.tire,
      tireWear: car.tireWear,
      punctured: car.punctured,
      pendingSG: car.pendingSG,
      incidents: car.incidents,
      plan: car.plan,
      events: car.events,
      finishedAt: car.finishedAt,
      autoCreated: car.autoCreated,
      d: car.d,
      brake: car.brkCmd > 0 ? 1 : 0,
      roll: car.roll,
      pitch: car.pitch,
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
      /* VUE 3D SPECTATEUR : chaque point gagne z (altitude), hd (cap),
         w (demi-largeur), biome et seg (0 sol, 1 pont, 2 tunnel) ; la
         réponse gagne les POI de la fenêtre. RÉTRO-COMPATIBLE : l'interface
         2D existante ne lit que x/y. Bornes conservées : len max 200 000,
         step min 8. */
      const s0 = Number(url.searchParams.get('s0') ?? '0');
      const step = Math.max(8, Number(url.searchParams.get('step') ?? '80'));
      const len = Math.min(200_000, Number(url.searchParams.get('len') ?? 60000));
      const pts: { x: number; y: number; z: number; hd: number; w: number; biome: number; seg: number }[] = [];
      for (let s = s0; s < s0 + len; s += step) {
        const sc = Math.min(s, race.trk.finishS);
        const p = race.trk.roadPoint(sc);
        /* constantes de chunk importées de core/ (une seule source de
           vérité : si la taille des chunks change, l'API ne se
           désynchronise pas du tracé) */
        const k = Math.min(race.route.nChunks - 1, Math.floor(sc / RCHUNK));
        let seg = 0;
        const c = race.route.chunks.get(k);
        if (c) {
          const i = Math.min(RSAMP - 1, Math.max(0, Math.floor((sc - c.s0) / SEG)));
          seg = c.segType[i] ?? 0;
        }
        pts.push({
          x: p.x, y: p.y, z: race.trk.heightAt(sc), hd: p.hd,
          w: race.trk.wAt(sc), biome: Math.floor(race.trk.biomeAt(sc)), seg,
        });
      }
      /* POI de la fenêtre (positions absolues pour la 3D) */
      const pois = race.trk.poisAhead(Math.max(0, s0), len)
        .map((poi) => {
          const p = race.trk.roadPoint(poi.s);
          return { s: poi.s, kind: poi.kind, x: p.x, y: p.y, z: race.trk.heightAt(poi.s) };
        });
      sendJSON(res, 200, { pts, pois, seed: race.seed });
      return;
    }

    if (url.pathname === '/api/configure' && req.method === 'POST') {
      /* première configuration de SA voiture : nom d'équipe + livrée.
         La voiture n'existait pas avant — elle s'insrit sur la grille.
         EXCEPTION (design : grille auto-remplie au départ) : si la
         voiture de me a été AUTO-ATTRIBUÉE, le joueur la personnalise
         à sa première connexion, à TOUT moment — l'identité reste au
         joueur. Les gommes sont un réglage de préparation : silencieusement
         ignorées si la course a déjà commencé. */
      const mine = me;
      if (mine && !mine.autoCreated) { sendJSON(res, 400, { error: 'voiture déjà configurée' }); return; }
      if (!mine && race.phase !== 'preparation') { sendJSON(res, 400, { error: 'la grille est fermée — course en cours' }); return; }
      const personalizing = Boolean(mine?.autoCreated);
      const body = JSON.parse(await readBody(req)) as { name?: string; color?: string; tire?: TireKind };
      const name = (body.name ?? '').trim().slice(0, 20);
      if (name.length < 2) { sendJSON(res, 400, { error: 'nom d\'équipe trop court' }); return; }
      if (body.tire && !(body.tire in TIRES)) { sendJSON(res, 400, { error: 'gommes inconnues' }); return; }
      if (!personalizing && race.cars.length >= race.config.maxCars) { sendJSON(res, 400, { error: 'grille complète' }); return; }
      let color = body.color ?? '';
      if (!LIVERY_PALETTE.includes(color)) { sendJSON(res, 400, { error: 'livrée inconnue' }); return; }
      /* une livrée déjà prise est refusée, SAUF si c'est celle de SA
         propre voiture (cas de la personnalisation sans changement) */
      const takenBy = race.cars.find((c) => c.color === color);
      if (takenBy && takenBy.id !== mine?.id) { sendJSON(res, 400, { error: 'livrée déjà prise dans cette course' }); return; }
      let car;
      if (personalizing && mine) {
        /* personnalisation différée : on renomme et re-livre SA voiture
           auto-attribuée — elle devient définitivement sienne */
        car = mine;
        car.name = name;
        car.color = color;
        if (race.phase === 'preparation' && body.tire && body.tire in TIRES) {
          car.tire = body.tire;   // gommes : réglage d'avant-course uniquement
        }
        car.autoCreated = false;  // plus renommable (comme les autres)
      } else {
        car = addCar(race, name, color);
        if (body.tire && body.tire in TIRES) car.tire = body.tire;
        car.owner = acc.username;
        acc.carId = car.id;
      }
      accounts.save();
      snapshot = buildSnapshot();
      save();
      sendJSON(res, 200, { ok: true, carId: car.id });
      return;
    }

    if (url.pathname === '/api/profile') {
      /* carte complète + profil d'altitude pour la fenêtre de
         préparation (POI NON marqués — design 2026-10-14). Calculé par
         le même code de génération que la course. En course, limité
         à la fenêtre devant le joueur (l'information est le métier). */
      const myS = me ? me.s : 0;
      const full = race.phase === 'preparation';
      const from = full ? 0 : myS;
      const len = full ? race.trk.finishS : 60_000;
      const step = Math.max(500, len / 300);
      const pts: { x: number; y: number; h: number; b: number; s: number }[] = [];
      for (let s = from; s < Math.min(from + len, race.trk.finishS); s += step) {
        const p = race.trk.roadPoint(s);
        pts.push({ x: p.x, y: p.y, h: race.trk.heightAt(s), b: Math.floor(race.trk.biomeAt(s)), s });
      }
      sendJSON(res, 200, { pts, finishS: race.trk.finishS, phase: race.phase });
      return;
    }

    if (url.pathname === '/api/liveries') {
      /* livrées encore disponibles pour SA configuration */
      sendJSON(res, 200, {
        palette: LIVERY_PALETTE,
        taken: race.cars.map((c) => c.color),
        tires: Object.entries(TIRES).map(([k, v]) => ({ kind: k, ...v })),
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

    if (url.pathname === '/api/cb' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { msg?: string };
      const msg = (body.msg ?? '').trim().slice(0, 160);
      if (!me) { sendJSON(res, 400, { error: 'aucune voiture — configurez-la d\'abord' }); return; }
      if (!msg) { sendJSON(res, 400, { error: 'message vide' }); return; }
      const last = cbLast.get(acc.username) ?? 0;
      if (Date.now() - last < CB_MIN_INTERVAL_S * 1000) {
        sendJSON(res, 429, { error: 'trop de messages — patientez' });
        return;
      }
      cbLast.set(acc.username, Date.now());
      cbLog.push({ from: me.name, carId: me.id, msg, t: race.simT });
      if (cbLog.length > 200) cbLog.shift();
      sendJSON(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/api/cb' && req.method === 'GET') {
      /* réception : seulement les équipes à ≤ CB_RANGE_KM (proximité) */
      if (!me) { sendJSON(res, 200, { msgs: [] }); return; }
      const msgs = cbLog
        .filter((m) => m.carId !== me.id)
        .filter((m) => {
          const other = race.cars.find((c) => c.id === m.carId);
          if (!other) return false;
          return Math.abs(other.s - me.s) <= CB_RANGE_KM * 1000;
        })
        .slice(-60);
      sendJSON(res, 200, { msgs });
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
        /* les messages CB d'une course morte ne fuient pas dans la
           suivante : canal vidé au reset */
        cbLog = [];
        cbLast.clear();
        Object.assign(race, fresh);
        snapshot = buildSnapshot();
        save();
        sendJSON(res, 200, { ok: true, phase: race.phase });
        return;
      }
      /* EXPLORATEUR DE GRAINES : carte complète + stats, calculées par le
         MÊME code de génération que la course (aucune divergence
         possible) — l'admin choisit sa graine puis lance le reset */
      if (url.pathname === '/api/admin/seedmap' && req.method === 'GET') {
        const seed = Number(url.searchParams.get('seed') ?? 42);
        const totalKm = Math.min(5000, Math.max(50, Number(url.searchParams.get('km') ?? race.totalKm)));
        const rt = makeRoute(seed, totalKm);
        const trk = routeTrack(rt);
        /* un point tous les ~2 km (vue de dessus + altitude + biome) */
        const step = 2000;
        const pts: { x: number; y: number; h: number; b: number }[] = [];
        for (let s = 0; s < rt.finishS; s += step) {
          const p = trk.roadPoint(s);
          pts.push({ x: p.x, y: p.y, h: trk.heightAt(s), b: Math.floor(trk.biomeAt(s)) });
        }
        /* km par biome */
        const kmBiome = [0, 0, 0, 0];
        for (const p of pts) kmBiome[p.b] += step / 1000;
        /* virages par catégorie : échantillonnage de la courbure */
        let epingles = 0, serres = 0, rapides = 0;
        let maxRun = 0, run = 0;
        for (let s = 0; s < rt.finishS; s += 8) {
          const cv = Math.abs(trk.cvAt(s));
          if (cv > 0.02) epingles++;
          else if (cv > 0.005) serres++;
          else if (cv > 0.001) rapides++;
          if (cv < 1e-4) { run += 8; if (run > maxRun) maxRun = run; } else run = 0;
        }
        /* densité POI (même curseur que la course, sans voitures) */
        let nPoi = 0;
        for (let s = 0; s < rt.finishS; s += 1000) {
          for (const p of trk.poisAhead(s, 1000)) nPoi++;
        }
        sendJSON(res, 200, {
          seed, totalKm, pts, kmBiome,
          turns: { epingles, serres, rapides, plusLongueDroite: maxRun },
          poiPer100km: +(nPoi / (totalKm / 100)).toFixed(1),
          altMin: Math.min(...pts.map((p) => p.h)),
          altMax: Math.max(...pts.map((p) => p.h)),
        });
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
      /* REMPLISSAGE DE LA GRILLE avant le premier pas : tout compte
         actif sans voiture en reçoit une (nom = identifiant, livrée
         libre, plan par défaut, dures). Les voitures configurées
         pendant la préparation sont prioritaires ; on complète
         jusqu'à maxCars. */
      const eligible = [...accounts.accounts.values()]
        .filter((a) => !a.disabled)
        .map((a) => ({ username: a.username, created: a.created }));
      const fills = fillGrid(eligible, race.cars, LIVERY_PALETTE, race.config.maxCars);
      let auto = 0;
      for (const f of fills) {
        const car = addCar(race, f.username, f.color);
        car.owner = f.username;
        car.tire = 'dures';
        car.autoCreated = true;
        const acc = accounts.accounts.get(f.username);
        if (acc) acc.carId = car.id;
        auto++;
      }
      if (auto > 0) accounts.save();
      const outOfGrid = eligible.filter((e) =>
        !race.cars.some((c) => c.owner === e.username)).length;
      console.log(`Départ : ${race.cars.length} voitures, dont ${auto} auto-attribuées, ${outOfGrid} comptes hors grille (max ${race.config.maxCars})`);
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
