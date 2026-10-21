/* ============================================================
   WORLD3D — moteur 3D partagé (spectateur + cockpit stratège)
   ============================================================
   Module ES unique pour UNE scène WebGL par page : le monde n'est
   jamais dupliqué, spectate.js et app.js sont deux clients minces.
   Correctifs intégrés (SHA 8b3d5df) :
   - CAP 90° : l'avant du maillage voiture est sur l'axe +Z local ;
     pour un cap hd (avant monde = (cos hd, 0, sin hd)), il faut
     rotation.y = PI/2 - hd (et NON -hd, qui pointait exactement
     perpendiculaire à la trajectoire).
   - SACCADES : le poll serveur (1 s) est LA seule source de vérité,
     mais le rendu fait du dead reckoning entre deux polls — chaque
     voiture avance toute seule le long de son cap, puis converge
     en douceur (~0,7 s) vers la position autoritaire. On ne lisse
     que l'affichage, jamais la simulation.
   - 0 DÉCOR AU DÉPART : le garde de fenêtre glissante ne s'applique
     qu'APRÈS une première construction (world && ...) — sinon
     winCenter=-1 vs km 0 : |0-(-1)| < 2500 → retour immédiat,
     et la grille de départ restait nue jusqu'au km 2,5.

   API : init(container, {onReady}) ; setData(snap) ; setFollow(carId) ;
         dispose().
   ============================================================ */

import * as THREE from 'three';
import { H, Hroad, WP, setWorldParams, ss, coastAt, tempAt, moistAt, famAt, flowAccum, villageCell, VILL_CELL } from './terrain.js';

/* ---- PRNG local : copie du mulberry32 du cœur, semée par la graine
   de course — le décor client est déterministe et IDENTIQUE pour tous
   les clients (ADR 0004 d'esprit). ---- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---- n°33 : PALETTE CLIMATIQUE — la couleur du sol dérive des axes
   (température, humidité, distance à la côte, altitude) et PLUS d'une
   étiquette par abscisse. Un versant sous le vent s'assèche → sable ;
   un fond humide → mousse sombre ; une côte franche → plage. Les
   transitions sont des DÉGRADÉS réels (champs continus), pas des
   fondus artificiels entre zones. ---- */
const SAND   = new THREE.Color('#d9c08a');
const STEPPE = new THREE.Color('#b7a866');
const GRASS  = new THREE.Color('#7fae56');
const MOSS   = new THREE.Color('#4f7a44');
const TUNDRA = new THREE.Color('#8a9276');
const LUSH   = new THREE.Color('#2e6b34');
const BEACH  = new THREE.Color('#e6d4a8');
const ROCKC  = new THREE.Color('#8a9099');
const SNOWC  = new THREE.Color('#eef2f5');
const COL_SEABED = new THREE.Color('#3d5a66');

/* couleur du sol : lissée par ss sur les axes — sable → steppe →
   prairie → mousse → luxuriant selon l'humidité, tundra pâle vers le
   froid, roche à l'étage alpin (240-330 m), plage sur les côtes
   franches (co 0,65-0,95). */
function groundCol(hr, T, M, co) {
  const c = new THREE.Color();
  c.copy(SAND);
  c.lerp(STEPPE, ss(0.10, 0.22, M));
  c.lerp(GRASS, ss(0.22, 0.38, M));
  c.lerp(MOSS, ss(0.52, 0.70, M));
  c.lerp(LUSH, ss(0.70, 0.85, M));
  c.lerp(TUNDRA, 0.8 * ss(4, -4, T));
  c.lerp(ROCKC, ss(240, 330, hr));
  c.lerp(BEACH, 0.9 * ss(0.65, 0.95, co));
  return c;
}
/* neige au-dessus de SNOW_ALT (/80), fond marin sous SEA_SL+3 —
   mutateur de couleur, appliqué APRÈS groundCol par sommet. */
function snowAndSea(c, y) {
  if (y > SNOW_ALT) c.lerp(SNOWC, Math.min(1, (y - SNOW_ALT) / 80));
  else if (y < WP.seaLevel + 3) c.lerp(COL_SEABED, Math.min(1, (WP.seaLevel + 3 - y) / 60));
}
const SNOW_ALT = 300;
const NIGHT = 0x0a0e1a;

const WIN = 8000;               // m, fenêtre de rendu
const STEP = 16;                 // m entre points de maillage

/* ---- état module (une seule instance WebGL par page) ---- */
let snap = null;
let followId = null;
let renderer, scene, camera;
let isMobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
let shadowsOn = !isMobile;
let quality = 1;
let carMeshes = new Map();       // id -> {group, wheels, ...} + cibles interpolées
let world = null;                // {group, pts, s0, step} fenêtre glissante
let winCenter = -1;
let building = false;
let lastFpsT = performance.now(), frames = 0;
let orbitT = 0;
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
let camZoom = 1;    // n°32 : 0,45 (zoom serré) .. 4 (vue large)
let poiLights = [];
/* ---- décor : état des couches L1/L2, eau, skyline ---- */
let winS0 = 0;                 // abscisse du 1er point de la fenêtre (hash stable)
let skyGroup = null, skyMat = null;
let waterMat = null;            // matériau d'eau PARTAGÉ rivières + lacs
let hydro = null;               // n°33 : grille d'écoulement de la fenêtre (rivières causales, villages à l'eau)
let villageLights = [];         // Points lumineux des villages (nuit)
let decoRidges = [];            // dégradation fps : reliefs
let villageGroups = [];         // dégradation fps : villages lointains
let degraStage = 0;             // 0 rien, 1 skyline, 2 reliefs, 3 villages
let mantleCaps = null;           // n°40 : plafond de largeur du manteau par rangée (cap au rayon local)
let lowFpsN = 0, highFpsN = 0;  // n°37 : hystérésis (nb de relevés consécutifs)
let hudEl = null;               // n°37 : HUD debug fps/dégra

/* HASH PUR de position : stable au rebuild de la fenêtre — tout
   REPÈRE (village, lac, relief, ravin) passe par ici. n°37 : le
   décor entier (jitter, teinte, patchwork, props) est ancré au
   monde par ce hash. */
function posHash(a, b) {
  const x = Math.sin(a * 127.1 + b * 311.7 + (snap?.seed ?? 42) * 0.618) * 43758.5453;
  return x - Math.floor(x);
}


/* rampe de terrain : le bruit prend de l'amplitude en s'éloignant */
/* n°37 : la rampe retombe à 0 vers le bord externe du manteau :
   la dernière rangée (j = BAND) n'a PLUS de jitter → couture
   exacte avec l'anneau 0 de la bande L1. */
function terrainRamp(j) { return Math.min(1, j / 12) * Math.min(1, (400 / STEP - j) / 4); }

/* brouillard par FAMILLE (n°33) : plaine, désert, forêt (brume serrée),
   boréal, altitude, littoral */
/* n°32 : fog plafonné SOUS le bord de la L1 (2 389 m) — le bord
   « coupé au couteau » du monde n'est plus visible par temps clair. */
const FAM_FOG = [0xcfe8f2, 0xf0e0c8, 0x9fb8c8, 0xdde8f0, 0xcdd6de, 0xcfe8f2];
const FAM_FOG_RANGE = [[300, 2300], [200, 2300], [120, 1400], [150, 1800], [150, 1800], [250, 2100]];

/* ---- SON MOTEUR (n°24) : WebAudio, une voix par voiture visible.
   Oscillateur en dents de scie (fréquence = rpm/60 × 4 explosions/tour
   d'un V8 : 67 Hz au ralenti, ~450 Hz au rupteur) + sous-oscillateur à
   moitié de fréquence (le corps grave) + passe-bas 900 Hz. Gain = pédale
   × atténuation en distance². Lissé par setTargetAtTime (τ 0,06 s) —
   le flux 15 Hz ne fait jamais sauter l'oreille. AudioContext créé au
   PREMIER GESTE utilisateur (règle navigateur), muetable à tout moment.
   Le son ne lit QUE le flux 15 Hz — aucun effet sur la simulation. */
let ac = null, master = null, muted = false;
const voices = new Map();          // carId -> {osc, sub, filt, gain}
function ensureAudio() {
  if (ac) return;
  ac = new (window.AudioContext || window.webkitAudioContext)();
  master = ac.createGain();
  master.gain.value = muted ? 0 : 0.5;
  master.connect(ac.destination);
  ac.resume();
}
document.addEventListener('pointerdown', () => ensureAudio(), { once: true, capture: true });
document.addEventListener('keydown', () => ensureAudio(), { once: true, capture: true });

export function setMuted(m) { muted = m; if (master) master.gain.setTargetAtTime(m ? 0 : 0.5, ac.currentTime, 0.05); }
export function isMuted() { return muted; }

/* voix par voiture : dents de scie + sous-oscillateur + passe-bas */
function makeVoice() {
  const osc = ac.createOscillator();
  osc.type = 'sawtooth';
  const sub = ac.createOscillator();
  sub.type = 'sawtooth';
  const filt = ac.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.value = 900;
  const gain = ac.createGain();
  gain.gain.value = 0;
  osc.connect(filt); sub.connect(filt); filt.connect(gain); gain.connect(master);
  osc.start(); sub.start();
  return { osc, sub, filt, gain };
}

/* appelé chaque frame : met à jour les 8 voix les plus proches */
function updateEngineAudio() {
  if (!ac) return;
  /* les 8 voitures les plus proches de la caméra */
  const near = [];
  for (const [id, m] of carMeshes) {
    if (!m.tgt || m.rx === undefined) continue;
    const dist = Math.hypot(m.rx - camera.position.x, m.rz - camera.position.z);
    near.push([id, m, dist]);
  }
  near.sort((a, b) => a[2] - b[2]);
  const keep = new Set();
  for (let i = 0; i < Math.min(8, near.length); i++) {
    const [id, m, dist] = near[i];
    keep.add(id);
    let v = voices.get(id);
    if (!v) { v = makeVoice(); voices.set(id, v); }
    const rpm = m.rpm ?? 0;
    const thr = m.thrS ?? 0;
    /* n°32 : gamme étendue — ~42 Hz au ralenti, ~670 Hz au rupteur
       (4 octaves au lieu de 2,8) : la montée de régime s'ENTEND.
       Filtre asservi (plus brillant à haut régime). Sous 150 tr/min
       (moteur coupé/à l'arrêt) : silence — plus de ronflement. */
    const f = rpm < 150 ? 0 : Math.max(42, 42 * Math.pow(rpm / 900, 1.35));
    v.osc.frequency.setTargetAtTime(f || 42, ac.currentTime, 0.06);
    v.sub.frequency.setTargetAtTime((f || 42) / 2, ac.currentTime, 0.06);
    v.filt.frequency.setTargetAtTime(f ? 350 + f * 1.9 : 600, ac.currentTime, 0.06);
    const att = 1 / (1 + (dist / 140) ** 2);    // distance²
    const g = (muted || rpm < 150) ? 0 : (0.05 + 0.4 * thr) * att;
    v.gain.gain.setTargetAtTime(g, ac.currentTime, 0.06);
  }
  /* voitures sorties du champ : voix coupée */
  for (const [id, v] of voices) {
    if (!keep.has(id)) {
      v.gain.gain.setTargetAtTime(0, ac.currentTime, 0.06);
      v.osc.stop(); v.sub.stop();
      voices.delete(id);
    }
  }
}

/* Récupère la voiture publique suivie (ou snap.me si c'est la mienne). */
function followCar() {
  if (!snap) return null;
  return snap.cars.find((c) => c.id === followId) ?? null;
}

/* ============================================================
   Scène, lumières, ciel
   ============================================================ */
function initScene(container) {
  renderer = new THREE.WebGLRenderer({ antialias: !isMobile, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.5 : 2));
  renderer.setSize(container.clientWidth || innerWidth, container.clientHeight || innerHeight);
  renderer.shadowMap.enabled = shadowsOn;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87b5d8);
  scene.fog = new THREE.Fog(0x87b5d8, 300, 2200);

  camera = new THREE.PerspectiveCamera(62, (container.clientWidth || innerWidth) / (container.clientHeight || innerHeight), 0.5, 5000);

  const hemi = new THREE.HemisphereLight(0xbdd7ee, 0x6b7a5a, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff3d6, 1.6);
  sun.castShadow = shadowsOn;
  if (shadowsOn) {
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -120; sun.shadow.camera.right = 120;
    sun.shadow.camera.top = 120; sun.shadow.camera.bottom = -120;
    sun.shadow.camera.far = 900;
  }
  /* n°32 : les cibles suivent la voiture vue — sinon les ombres ne
     se voient qu'aux ~80 m de l'ORIGINE de la carte. */
  const sunTarget = new THREE.Object3D(); scene.add(sunTarget);
  sun.target = sunTarget;
  scene.add(sun);
  scene.userData.sun = sun; scene.userData.sunTarget = sunTarget;
  scene.userData.hemi = hemi;

  const moon = new THREE.DirectionalLight(0x8ea6cc, 0.15);
  const moonTarget = new THREE.Object3D(); scene.add(moonTarget);
  moon.target = moonTarget;
  moon.castShadow = shadowsOn;   // commuté avec la nuit dans updateSky
  scene.add(moon);
  scene.userData.moon = moon; scene.userData.moonTarget = moonTarget;

  /* étoiles : visibles la nuit seulement (opacité pilotée par l'heure) */
  const starGeo = new THREE.BufferGeometry();
  const sp = [];
  const srnd = mulberry32(99);
  for (let i = 0; i < 400; i++) {
    const az = srnd() * Math.PI * 2, el = srnd() * Math.PI * 0.45;
    const R = 3000;
    sp.push(Math.cos(az) * Math.cos(el) * R, Math.sin(el) * R, Math.sin(az) * Math.cos(el) * R);
  }
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xcfd8e8, size: 3, transparent: true, opacity: 0, fog: false, sizeAttenuation: false }));
  scene.add(stars);
  scene.userData.stars = stars;

  const resize = () => {
    const w = container.clientWidth || innerWidth, h = container.clientHeight || innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  addEventListener('resize', resize);
  new ResizeObserver(resize).observe(container);
  /* n°32 : boutons +/− zoom (tap-friendly), molette en bonus */
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  const mkBtn = (txt, fn) => {
    const b = document.createElement('button');
    b.textContent = txt;
    b.style.cssText = 'position:absolute;right:12px;width:44px;height:44px;border-radius:50%;'
      + 'border:1px solid #ffffff55;background:#00000066;color:#fff;font-size:22px;'
      + 'cursor:pointer;z-index:5;backdrop-filter:blur(2px)';
    b.addEventListener('click', fn);
    container.appendChild(b);
    return b;
  };
  mkBtn('+', () => { camZoom = Math.min(4, camZoom * 1.3); })
    .style.bottom = '64px';
  mkBtn('−', () => { camZoom = Math.max(0.45, camZoom / 1.3); })
    .style.bottom = '12px';
  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    camZoom = Math.min(4, Math.max(0.45, camZoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
  }, { passive: false });
  /* n°37 : HUD debug discret (fps + étage de dégradation) — diagnostic
     « aucun décor » : « dégra 3 » = machine en dégradation, les
     villages/reliefs/skyline sont cachés par performance. */
  hudEl = document.createElement('div');
  hudEl.style.cssText = 'position:absolute;left:8px;top:8px;z-index:6;color:#fff;'
    + 'font:11px/1.4 monospace;text-shadow:0 1px 2px #000;pointer-events:none;opacity:.8';
  hudEl.textContent = '… fps';
  container.appendChild(hudEl);
}

/* ============================================================
   Monde — fenêtre glissante ~8 km autour de la voiture suivie
   ============================================================ */
async function fetchTrack(s0, len, step) {
  /* le module ne dépend PAS du client pour l'auth : même session que le
     reste du jeu (401 → login) */
  const r = await fetch(`/api/track?s0=${Math.round(s0)}&len=${len}&step=${step}`);
  if (r.status === 401) { location.href = '/login.html'; return null; }
  return r;
}

async function refreshWorld() {
  const car = followCar();
  if (!car) return;
  /* fenêtre AVANT-biaisée : 6 km devant, 2 km derrière — l'ancien
     km - 2800 ne laissait que 1,2 km de route devant pour un seuil
     de reconstruction de 2500 m : la voiture roulait dans le vide
     (brouillard prématuré) au-delà du bord du monde */
  const center = Math.max(0, car.km * 1000 + 2000);
  /* CORRECTIF 3 : le garde ne s'applique qu'APRÈS une première
     construction. Sinon |0-(-1)| = 1 < 2500 → retour immédiat et le
     monde n'existait pas avant le km 2,5 (le « 0 décor » au départ). */
  if (world && Math.abs(center - winCenter) < 2500) return;
  if (building) return;          /* une seule construction à la fois :
                                    un poll pendant le rebuild ne lance
                                    pas une seconde construction */
  building = true;
  try {
    const s0 = Math.max(0, center - WIN / 2);
    const r = await fetchTrack(s0, WIN, STEP);
    if (!r) return;
    const d = await r.json();
    if (!d.pts?.length) return;
    /* le NOUVEAU monde est construit et ajouté AVANT de retirer
       l'ancien — plus jamais de scène vide pendant le rebuild (et
       si le fetch échoue, l'ancien monde reste en place) */
    const group = new THREE.Group();
    poiLights = [];
    villageLights = [];
    winS0 = s0;
    /* n°33 : grille d'écoulement AVANT les couches qui la lisent
       (n°51 : buildVillages lit désormais le champ monde villageCell —
       ne lit PLUS la grille ; seule buildWater la lit : rivières causales). */
    hydro = buildHydro(d);
    /* n°32 : fondu longitudinal des segs — 1 aux points pont/tunnel,
       fondu linéaire sur 10 points (160 m) autour, 0 ailleurs.
       O(n·10) par rebuild, négligeable. DOIT être prêt avant
       buildRoad : la jupe appelle terrainY. */
    /* n°47 : la propagation relisait segFade déjà propagé (passe unique,
       i croissant : segFade[i-1] venait d'être écrit par la boucle) : après
       un point seg, TOUTES les rangées suivantes de la fenêtre reprenaient
       1-1/11 = 0,91 > 0 — terrain ouvert à 90 % jusqu'au bout de la fenêtre
       après chaque pont/tunnel, et garde n°47 aveugle là (percées mesurées
       49 échantillons au km 50 g42, juste après le tunnel km 42,6-46).
       On propage depuis les VRAIS segs (segRaw), conformément au
       commentaire n°32 : fondu ±10 points (160 m), 0 ailleurs. */
    segFade = new Float64Array(d.pts.length);
    const segRaw = new Uint8Array(d.pts.length);
    for (let i = 0; i < d.pts.length; i++)
      segFade[i] = segRaw[i] = (d.pts[i].seg ?? 0) !== 0 ? 1 : 0;
    for (let i = 0; i < d.pts.length; i++) {
      if (segRaw[i]) continue;
      let d2 = 11;
      for (let j = 1; j <= 10; j++) {
        if (segRaw[i + j] || segRaw[i - j]) { d2 = j; break; }
      }
      if (d2 <= 10) segFade[i] = 1 - d2 / 11;
    }
    buildRoad(group, d);
    buildTerrain(group, d);
    buildMidFar(group, d);
    /* n°48 : rides L2 supprimées — elles doublonnaient le vrai relief
       rendu depuis n°26/39 (silhouettes dent de scie qui recoupent les
       montagnes réelles, glitchs verticaux de l'arrière-plan). La
       fonction reste en code mort, decoRidges reste vide (dégradation
       fps → boucle sans effet). */
    buildVillages(group, d);
    buildWater(group, d);
    buildProps(group, d);
    buildPois(group, d.pois ?? []);
    buildSkyline(d);               // skyline RÉELLE : reconstruit chaque fenêtre
    scene.add(group);
    if (world) {
      scene.remove(world.group);
      world.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material?.dispose) o.material.dispose();
      });
    }
    world = { group, pts: d.pts, s0, step: STEP };
    degraStage = 0;        /* nouvelle fenêtre : décor complet */
    winCenter = center;   /* seulement après succès : un échec laisse
                             l'ancien centre → retry au poll suivant */
  } finally {
    building = false;
  }
}

/* ---- route : ruban triangulaire + accotements + ponts/tunnels ---- */
function buildRoad(group, d) {
  const pts = d.pts;
  const n = pts.length;
  const pos = [], col = [], idx = [];
  const roadCol = new THREE.Color('#3d4148');
  const dirtCol = new THREE.Color('#7a6a4f');
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    /* normale latérale : perpendiculaire au cap */
    const nx = -Math.sin(p.hd), nz = Math.cos(p.hd);
    const w = p.w;
    const halfRoad = w;
    /* n°31 — COUTURE EXACTE : le bord externe de la jupe passe à w + 2
       (même latéral que la 1re rangée du terrain) et prend le y EXACT
       de terrainY(p, i, w + 2) — la même technique que l'anneau 0 de
       la bande L1. terrainRamp(0) = 0 : la rangée terrain n'a AUCUN
       jitter à j = 0, l'arête coïncide exactement. Le fondu d'écart
       (|gap| 15-25 m) est suivi par la jupe : le trou « on voit à
       travers la carte » disparaît. PONTS (p.seg === 1) exceptés :
       deck + ravin VOUlus — la jupe reste plate à p.z + 0.02
       (arches dessous, terrain qui s'ouvre). */
    const halfDirt = w + 2;
    const dirtYL = p.seg === 1 ? p.z + 0.02 : terrainY(p, i, -halfDirt);   /* n°49 : dist signé — le bord G suivait le miroir droit */
    const dirtYR = p.seg === 1 ? p.z + 0.02 : terrainY(p, i, halfDirt);
    pos.push(p.x + nx * -halfDirt, dirtYL, p.y + nz * -halfDirt);
    col.push(dirtCol.r, dirtCol.g, dirtCol.b);
    pos.push(p.x + nx * -halfRoad, p.z + 0.05, p.y + nz * -halfRoad);
    col.push(roadCol.r, roadCol.g, roadCol.b);
    pos.push(p.x + nx * halfRoad, p.z + 0.05, p.y + nz * halfRoad);
    col.push(roadCol.r, roadCol.g, roadCol.b);
    pos.push(p.x + nx * halfDirt, dirtYR, p.y + nz * halfDirt);
    col.push(dirtCol.r, dirtCol.g, dirtCol.b);
  }
  /* 4 sommets par point → 3 quads → 6 triangles, en sens ANTIHORAIRE
     vu du ciel : normale (0, +1, 0) partout. L'ancien ordre (a, b,
     a+1…) donnait Edge1 = avant F, Edge2 = latéral N, normale F×N
     = (0, -1, 0) — tournée vers le BAS : backface culling, route
     invisible (terrain, lui, avait le bon winding). */
  for (let i = 0; i + 1 < n; i++) {
    const a = i * 4, b = (i + 1) * 4;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
    idx.push(a + 1, a + 2, b + 1, a + 2, b + 2, b + 1);
    idx.push(a + 2, a + 3, b + 2, a + 3, b + 3, b + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.receiveShadow = shadowsOn;
  group.add(mesh);

  /* ---- PONTS (seg=1) : arche low-poly, ravin visible dessous ---- */
  buildSegments(group, pts, 1, (p) => {
    const arch = new THREE.Mesh(
      new THREE.BoxGeometry(p.w * 2.4, 1.2, STEP * 1.1),
      new THREE.MeshLambertMaterial({ color: '#9a8f80' }));
    arch.position.set(p.x, p.z - 3.2, p.y);
    /* CORRECTIF 1 : même convention de cap que les voitures */
    arch.rotation.y = Math.PI / 2 - p.hd;
    arch.castShadow = shadowsOn;
    return arch;
  });

  /* ---- TUNNELS (seg=2) : voûte sombre au-dessus de la route ---- */
  buildSegments(group, pts, 2, (p) => {
    const vault = new THREE.Mesh(
      new THREE.BoxGeometry(p.w * 2.6, 0.8, STEP * 1.1),
      new THREE.MeshLambertMaterial({ color: '#4a4440' }));
    vault.position.set(p.x, p.z + 4.5, p.y);
    vault.rotation.y = Math.PI / 2 - p.hd;
    return vault;
  });
}

function buildSegments(group, pts, segVal, makeMesh) {
  let prev = null;
  for (const p of pts) {
    const nx = -Math.sin(p.hd), nz = Math.cos(p.hd);
    if (p.seg === segVal) {
      const m = makeMesh(p, nx, nz);
      group.add(m);
      if (prev && prev.seg === segVal) {
        /* parois latérales du tunnel / piles du pont */
        for (const side of [-1, 1]) {
          const wall = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, segVal === 2 ? 6 : 2.5, STEP * 1.1),
            new THREE.MeshLambertMaterial({ color: segVal === 2 ? '#3a3633' : '#8a8072' }));
          wall.position.set(p.x + nx * side * (p.w + 0.4), p.z + (segVal === 2 ? 1.5 : -1.5), p.y + nz * side * (p.w + 0.4));
          wall.rotation.y = Math.PI / 2 - p.hd;
          group.add(wall);
        }
      }
    }
    prev = p;
  }
}

/* hauteur du terrain à distance latérale dist du point p — LE VRAI
   CHAMP H (n°26). Raccord à la chaussée par FONDU : poids latéral
   (accotement → terrain sur T_BLEND) + fondu d'écart (le talus
   s'ouvre dès que le vrai terrain s'écarte de la route) → déblai/
   remblai doux au sol, vallée qui s'ouvre sous les ponts, roche qui
   couvre les tunnels. PURE de (position, graine) : stable au
   rebuild, identique au serveur (core/terrain.ts). */
const T_BLEND = 45;   // m : talus minimal accotement -> H ; étendu à 2,5×|gap| si grand
/* n°32 : fondu d'écart BINAIRE — le terrain épouse la route partout où
   il n'y a PAS de pont/tunnel (plus jamais de mur/estrade sous la
   route) ; autour des segs (segFade, ±10 points) le terrain s'ouvre
   progressivement : ravin sous les ponts, roche au-dessus des tunnels.
   Le talus latéral s'étale : jamais plus raide que ~22°. */
let segFade = null;  // Float64Array par point de fenêtre (1 aux segs, fondu autour)
function terrainY(p, i, dist) {
  const seed = snap?.seed ?? 42;
  const nx = -Math.sin(p.hd), nz = Math.cos(p.hd);
  const x = p.x + nx * dist, z = p.y + nz * dist;
  const hT = H(x, z, seed);
  const wGap = segFade ? (segFade[i] ?? 0) : 0;
  const talus = Math.max(T_BLEND, Math.abs(p.z - H(p.x, p.y, seed)) * 2.5);
  /* n°49 : dist peut être SIGNÉ (côté -1 = gauche du cap) : la position
     x/z suit le signe, le fondu latéral suit |dist|. Avant n°49, tout
     appel côté gauche échantillonnait H au MIROIR droit (preuve : 11 410
     sommets manteau miroir-seuls sur 26 000, 78,9 % côté G à >2 m du
     terrain vrai, max 31,6 m). Le côté droit est inchangé au bit près. */
  const wDist = Math.max(0, Math.min(1, (Math.abs(dist) - (p.w + 2)) / talus));
  return p.z - 0.05 + (hT - (p.z - 0.05)) * Math.min(1, wDist + wGap);
}
/* terrain à une position monde QUELCONQUE (maisons, clochers, lumières
   de village). n°32 : les maisons/villages (250 m-1,2 km de la route)
   se posent sur le VRAI terrain H — l'ancien fondu les posait au
   niveau de la route dès que |gap| ≤ 15 m (71 % des km) : villages
   flottants ou enterrés. À cette distance, le terrain rendu = H
   (wDist saturé). */
function terrainAtXY(p, x, z) {
  const seed = snap?.seed ?? 42;
  return H(x, z, seed);
}

/* ---- terrain : manteau low-poly ~400 m de chaque côté ---- */
function buildTerrain(group, d) {
  const pts = d.pts;
  const n = pts.length;
  const seed = snap?.seed ?? 42;
  const BAND = 400 / STEP;
  const pos = [], col = [], idx = [];
  /* n°40 : CAP AU RAYON LOCAL — les colonnes latérales de rangées
     voisines se croisent au centre de courbure (distance = rayon) :
     bowties, falaises et triangles inversés (20,6 % du manteau 200-400 m
     avant n°40, « gros problème visuel » km 3 graine 42). Chaque rangée
     plafonne ses colonnes à 0,9×R local (min sur ±256 m) : le manteau
     s'arrête AVANT le centre de courbure → plus aucun repli possible.
     Les colonnes au-delà du plafond sont RABATTUES sur l'anneau du
     plafond (quads dégénérés invisibles, transition en éventail).
     Sur portion droite R = ∞ → plafond 400 → comportement n°37/n°39
     IDENTIQUE au bit près. */
  const capRow = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let rMin = Infinity;
    for (let k = Math.max(1, i - 16); k <= Math.min(n - 2, i + 16); k++) {
      let dh2 = pts[k + 1].hd - pts[k - 1].hd;
      while (dh2 > Math.PI) dh2 -= 2 * Math.PI;
      while (dh2 < -Math.PI) dh2 += 2 * Math.PI;
      if (dh2 !== 0) rMin = Math.min(rMin, 32 / Math.abs(dh2));   /* 32 m d'arc entre k-1 et k+1 */
    }
    capRow[i] = Math.min(400, Math.max(2 * STEP, Math.floor((Math.min(400, 0.9 * rMin) - (pts[i].w + 2)) / STEP) * STEP));
  }
  /* n°46 : ÉROSION DU CAP — la jupe n°44 (plancher 160) violait le
     critère n°40 (cap ≤ 0,9·R local) dans les zones serrées : au km 0-8
     de la graine 42, 426/500 rangées dépassaient le centre de courbure
     de 80-112 m → les bandes du manteau se CROISAIENT (bowties, le
     « gros problème visuel km 3 » historique du n°40) — morceaux de sol
     en percée et scintillement de surfaces interpénétrées. Le lissage
     devient une ÉROSION : capRow[i] = min(cap n°40 propre, moyenne
     ±8 rangées) — il ne peut JAMAIS remonter au-dessus du cap de sa
     rangée → aucune colonne n'atteint un centre de courbure, comme à
     l'ère n°40, tout en gardant des rampes douces aux transitions.
     Le couloir étroit qui en résulte aux kinks est couvert par la
     grille décollée n°45, désormais dessinée PARTOUT (le saut
     hp && hn est supprimé : plus AUCUN quad sauté). */
  const SMOOTH = 8;
  const base = Int32Array.from(capRow);
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0;
    for (let k = Math.max(0, i - SMOOTH); k <= Math.min(n - 1, i + SMOOTH); k++) { sum += base[k]; cnt++; }
    capRow[i] = Math.min(base[i], Math.floor((sum / cnt) / STEP) * STEP);
  }
  mantleCaps = capRow;   /* lu par buildMidFar pour la couture (même plafond) */
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const nx = -Math.sin(p.hd), nz = Math.cos(p.hd);
    /* n°33 : axes climatiques calculés UNE fois par RANG (point de
       route) et hérités par toute la rangée latérale — la couleur
       reste PAR SOMMET via l'altitude réelle du sommet (étage alpin,
       fond marin). */
    const T = tempAt(p.x, p.y, seed);
    const M = moistAt(p.x, p.y, seed);
    const co = coastAt(p.x, p.y, seed);
    for (let side = -1; side <= 1; side += 2) {
      for (let j = 0; j <= BAND; j++) {
        const dist = p.w + 2 + (j * STEP > capRow[i] ? capRow[i] : j * STEP);   // n°40 : colonnes rabattues sur l'anneau du plafond
        const x = p.x + nx * side * dist;
        const zz = p.y + nz * side * dist;
        /* n°37 : jitter ANCRÉ AU MONDE — hash du sommet (x, z) au lieu
           du PRNG de fenêtre : stable au rebuild (l'ancien re-tirait
           chaque sommet à chaque fenêtre : le sol ondulait tout au
           long du voyage), identique pour tous les clients. Bonus :
           deux sommets au même point monde (épingles) obtiennent le
           même jitter → plus d'artefact d'auto-recouvrement. */
        const jc = Math.min(j, capRow[i] / STEP);   // n°40 : rampe de jitter évaluée AU plafond (couture identique à la grille)
        const y = terrainY(p, i, side * dist) + posHash(Math.round(x / 8), Math.round(zz / 8)) * 0.8 * terrainRamp(jc);   /* n°49 : dist signé — le manteau G suit le VRAI terrain, plus le miroir droit */
        pos.push(x, y, zz);
        const c2 = groundCol(y, T, M, co);
        snowAndSea(c2, y);
        c2.offsetHSL(0, 0, (posHash(Math.round(x / 8) + 77, Math.round(zz / 8)) - 0.5) * 0.03);  // n°37 : teinte ancrée au monde
        col.push(c2.r, c2.g, c2.b);
      }
    }
  }
  const row = BAND + 1;
  for (let i = 0; i + 1 < n; i++) {
    const aL = i * row * 2, aR = aL + row;
    const bL = (i + 1) * row * 2, bR = bL + row;
    for (let j = 0; j < BAND; j++) {
      idx.push(aL + j, bL + j, aL + j + 1, aL + j + 1, bL + j, bL + j + 1);
      idx.push(aR + j, aR + j + 1, bR + j, aR + j + 1, bR + j + 1, bR + j);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  mesh.receiveShadow = shadowsOn;
  group.add(mesh);
}

/* ============================================================
   n°39 — GRILLE MONDE MI-LOINTAINE L1 (remplace le ruban n°22)

   Le ruban à anneaux 400·1,22^k se CROISAIT lui-même dans chaque
   virage (repli bowtie : rayon du virage < anneau) : trous avant
   n°38, SUPERPOSITION de 2 sols après le DoubleSide. Remplacement
   par une GRILLE alignée aux multiples de 100 m (comme la grille
   hydro), étendue de PAD au-delà de la bbox de la fenêtre : une
   grille monde ne peut pas se replier sur elle-même, et le bord du
   monde arrière/avant reste au-delà du brouillard.

   - corridor |lat| < w+2+400+2 : sommet DÉCOLLÉ (n°45) : position
     grille conservée, posé SOUS le manteau (min des échantillons de
     coins − 0,35) → jamais de z-fight, jamais de plaque étirée ;
   - edge..edge+700 : fondu terrainY → H(x,z) (le talus des déblais
     se referme sur le terrain naturel), enfoncé de 0,1 → 0,4 m ;
   - au-delà : y = H(x,z) - 0,4 (sol universel : villages, eau,
     reliefs et props posés sur H restent au-dessus) ;
   - quads collés des DEUX côtés du manteau ou intégralement
     collés = sautés (le manteau couvre le couloir) ;
   - patchwork plaine : cellules 220 m MONDE + haies (n°37) ;
   - axes climatiques par macro-case 200 m (partagés 2×2) ;
   - nearest-row par buckets de 500 m. Grille ancrée au monde →
     stable au glissement de fenêtre (cohérent n°37).
   ============================================================ */

function buildMidFar(group, d) {
  const pts = d.pts;
  const seed = snap?.seed ?? 42;
  const pos = [], col = [], idx = [];
  const PAD = 2400, CELL = 100, TALUS = 700, BUCK = 500;
  const BAND49 = 100;   /* n°49 : largeur du raccord grille -> rim du manteau */
  const PATCH = ['#9cc76a', '#b8bf5e', '#cbb06a', '#6da04f'].map((c) => new THREE.Color(c));
  const HEDGE = new THREE.Color('#3f5a35');

  /* bbox de la fenêtre route */
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minZ) minZ = p.y; if (p.y > maxZ) maxZ = p.y;
  }
  const gx0 = Math.floor((minX - PAD) / CELL), gx1 = Math.ceil((maxX + PAD) / CELL);
  const gz0 = Math.floor((minZ - PAD) / CELL), gz1 = Math.ceil((maxZ + PAD) / CELL);
  const nx = gx1 - gx0 + 1, nz = gz1 - gz0 + 1;

  /* buckets de 500 m : recherche de la rangée route la plus proche */
  const buckets = new Map();
  const bkey = (a, b) => a + '|' + b;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const k = bkey(Math.floor(p.x / BUCK), Math.floor(p.y / BUCK));
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(i);
  }

  /* n°49 : RACCORD AU RIM DU MANTEAU — le rim (dernière colonne du
     manteau, dist = w+2+cap de SA rangée, côté signé n°49) porte
     terrainY + jitter, mais la pose n°45/48 du couloir est le min du
     voisinage 3x3 - 0,35 : sur les fortes pentes la grille s'affaisse
     de 1 à 4 m sous le rim local précisément là où le manteau
     s'arrête -> marche flottante (on voit SOUS la coquille) ou mur
     avec z-fight le long du bord. Fix : la bande [edge+2, edge+2+BAND49]
     de la grille REJOINT le rim interpolé le long du bord réel du
     manteau (polyligne des sommets rim des rangées voisines, formule
     SANS jitter — le jitter du manteau est >= 0, la marge -0,15 garde
     la grille strictement sous le rim rendu), puis fond vers sa valeur
     talus. Le mur couloir->bande est caché derrière le bord du rim. */
  const rimH = new Float64Array(pts.length * 2);   /* hauteur du rim par (rangée, côté), sans jitter */
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const capI = mantleCaps ? mantleCaps[i] : 400;
    for (let sgn = -1; sgn <= 1; sgn += 2) {
      rimH[i * 2 + (sgn > 0 ? 1 : 0)] = terrainY(p, i, sgn * (p.w + 2 + capI));
    }
  }
  const rimXY = (i, sgn) => {
    const p = pts[i];
    const capI = mantleCaps ? mantleCaps[i] : 400;
    const nx2 = -Math.sin(p.hd), nz2 = Math.cos(p.hd);
    const dist = p.w + 2 + capI;
    return [p.x + nx2 * sgn * dist, p.y + nz2 * sgn * dist];
  };
  const seamRim = (x, z, bi, sgn) => {   /* rim interpolé : projection sur les segments [bi-1,bi]/[bi,bi+1] */
    const seg = (i0, i1) => {
      const A = rimXY(i0, sgn), B = rimXY(i1, sgn);
      const abx = B[0] - A[0], abz = B[1] - A[1];
      const dd = abx * abx + abz * abz;
      const f = dd < 1e-9 ? 0 : Math.max(0, Math.min(1, ((x - A[0]) * abx + (z - A[1]) * abz) / dd));
      const px = A[0] + abx * f, pz = A[1] + abz * f;
      return { d2: (x - px) * (x - px) + (z - pz) * (z - pz), y: rimH[i0 * 2 + (sgn > 0 ? 1 : 0)] * (1 - f) + rimH[i1 * 2 + (sgn > 0 ? 1 : 0)] * f };
    };
    let best = null;
    for (const [i0, i1] of [[bi - 1, bi], [bi, bi + 1]]) {
      if (i0 < 0 || i1 >= pts.length) continue;
      const e = seg(i0, i1);
      if (!best || e.d2 < best.d2) best = e;
    }
    return best ? best.y : null;
  };

  /* n°47 : GARDE-ROUTE PAR SUBDIVISION — un quad 100 m peut traverser
     la bande bitume (|lat| < w) d'un rang qui n'est PAS son rang proche
     (épingle à cheveux) : ses coins suivent le manteau/terrain du bras
     proche (jusqu'à +10 m AU-DESSUS de la route de l'autre bras) et sa
     surface bilinéaire perce le bitume — le « sol qui déborde sur la
     route ». Ces quads DOIVENT être dessinés (ils couvrent la zone
     [anneau du manteau .. 141 m] que le manteau érodé n°46 ne couvre
     plus — les sauter crée des trous mesurés : 46-87 par fenêtre).
     Solution : SUBDIVISER le quad perçant en 4×4 (25 m) et n'omettre
     QUE les sous-cellules dont la surface dépasse la route sur la
     bande bitume. La bande omise (≤ ~21 m autour du bitume) est
     couverte PAR CONSTRUCTION : deck (|lat| ≤ w+2) + manteau du rang
     percé ([w+2 .. w+2+capRow], capRow ≥ 32 → anneau ≥ 37 m > 21 m).
     Le reste du quad (le terrain au-delà) est rendu À L'IDENTIQUE
     (sous-cellules bilinéaires = surface du quad d'origine au
     millimètre). Rangs exclus du test : segFade > 0 uniquement
     (portail pont/tunnel : la roche au-dessus de la route est VOULUE,
     n°32). Les rangées 0/dernière SONT testées : le deck y est rendu,
     une percée y est visible (mesuré : 13-16 échantillons dy 1,6 m
     en bord de fenêtre) ; au-delà de ±8 m (pastEnd) il n'y a pas de
     bitume, triAbove ne peut rien y signaler. */
  const inTri = (qx, qz, x1, y1, z1, x2, y2, z2, x3, y3, z3) => {
    const d = (z2 - z3) * (x1 - x3) + (x3 - x2) * (z1 - z3);
    if (Math.abs(d) < 1e-9) return null;
    const l1 = ((z2 - z3) * (qx - x3) + (x3 - x2) * (qz - z3)) / d;
    const l2 = ((z3 - z1) * (qx - x3) + (x1 - x3) * (qz - z3)) / d;
    const l3 = 1 - l1 - l2;
    if (l1 < -0.02 || l2 < -0.02 || l3 < -0.02) return null;
    return l1 * y1 + l2 * y2 + l3 * y3;
  };
  const stripRowsFor = (x0, z0, x1, z1) => {
    const out = [];
    for (let gx = Math.floor(x0 / BUCK); gx <= Math.floor(x1 / BUCK); gx++)
      for (let gz = Math.floor(z0 / BUCK); gz <= Math.floor(z1 / BUCK); gz++) {
        const arr = buckets.get(bkey(gx, gz));
        if (!arr) continue;
        for (const r of arr) {
          if (segFade && (segFade[r] ?? 0) > 0) continue;   /* n°47 : rangées 0/dernière TESTÉES aussi (deck rendu, percée visible) ; portail exclu */
          const p2 = pts[r];
          if (p2.x < x0 || p2.x > x1 || p2.y < z0 || p2.y > z1) continue;
          out.push(p2);
        }
      }
    return out;
  };
  const triAbove = (p2, c) => {   /* c = 18 coords : 2 triangles (9 chacune) */
    const cs2 = Math.cos(p2.hd), sn2 = Math.sin(p2.hd);
    const nvx2 = -sn2, nvz2 = cs2;
    const wl = p2.w - 0.3;
    for (let su = -8; su <= 8; su += 2) {
      for (let k2 = -2; k2 <= 2; k2++) {
        const qx = p2.x + cs2 * su + nvx2 * k2 * wl / 2, qz = p2.y + sn2 * su + nvz2 * k2 * wl / 2;
        const y = inTri(qx, qz, c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8])
          ?? inTri(qx, qz, c[9], c[10], c[11], c[12], c[13], c[14], c[15], c[16], c[17]);
        if (y !== null && y > p2.z + 0.05) return true;
      }
    }
    return false;
  };
  const quadPierces = (a, b, c2, d2) => {
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
    const cx = pos[c2 * 3], cy = pos[c2 * 3 + 1], cz = pos[c2 * 3 + 2];
    const dx = pos[d2 * 3], dy = pos[d2 * 3 + 1], dz = pos[d2 * 3 + 2];
    const rows = stripRowsFor(Math.min(ax, bx, cx, dx) - 40, Math.min(az, bz, cz, dz) - 40,
                              Math.max(ax, bx, cx, dx) + 40, Math.max(az, bz, cz, dz) + 40);
    for (const p2 of rows) {
      if (triAbove(p2, [ax, ay, az, cx, cy, cz, bx, by, bz, bx, by, bz, cx, cy, cz, dx, dy, dz])) return true;
    }
    return false;
  };
  /* n°48 : COUTURE COULOIR PAR SUBDIVISION POSÉE — le décollage n°45
     garantit la pose (min des échantillons manteau − 0,35) aux SOMMETS
     de la grille (100 m), mais les FACES bilinéaires percent le manteau
     entre les sommets (mesuré au banc : ~10 % de l'aire du couloir
     recouverte à +3,9-4,1 m, dans CHAQUE bande latérale 0-190 m, les
     deux côtés — la « couture » visible de part et d'autre de la
     route). Fix : subdiviser les quads du couloir (coin à ±1, ±3 =
     talus n'est pas subdivisé) + leurs voisins 4-connexes (edge varie
     entre rangées) en 4×4 (25 m) et POSER les sous-sommets avec la
     MÊME formule que la passe vertex → le mismatch faces/manteau est
     divisé par ~16. La pose est un abaissement uniquement
     (min(bilinéaire, poseRing)) : elle ne peut créer aucune nouvelle
     percée, et la bande omise par la garde n°47 reste couverte par
     construction (deck |lat| ≤ w+2 + manteau). */
  let cbx48 = 1e9, cbz48 = 1e9; const cand48 = [];
  const nearRows = (x, z) => {   /* union des 9 buckets autour — pure en (x,z), cachée par bucket */
    const bx = Math.floor(x / BUCK), bz = Math.floor(z / BUCK);
    if (bx !== cbx48 || bz !== cbz48) {
      cand48.length = 0;
      for (let dbx = -1; dbx <= 1; dbx++) for (let dbz = -1; dbz <= 1; dbz++) {
        const arr = buckets.get(bkey(bx + dbx, bz + dbz));
        if (arr) for (const r of arr) cand48.push(r);
      }
      cbx48 = bx; cbz48 = bz;
    }
    return cand48;
  };
  const poseRing = (x, z) => {   /* réplique EXACTE de la pose n°45 de la passe vertex */
    let bi = -1, bd = Infinity;
    const cand = nearRows(x, z);
    for (let q = 0; q < cand.length; q++) {
      const p = pts[cand[q]];
      const dd = (x - p.x) * (x - p.x) + (z - p.y) * (z - p.y);
      if (dd < bd) { bd = dd; bi = cand[q]; }
    }
    if (bi < 0) return null;
    const p = pts[bi];
    const nvx = -Math.sin(p.hd), nvz = Math.cos(p.hd);
    const lat = (x - p.x) * nvx + (z - p.y) * nvz;
    const u = (x - p.x) * Math.cos(p.hd) + (z - p.y) * Math.sin(p.hd);
    const pastEnd = (bi === 0 && u < -8) || (bi === pts.length - 1 && u > 8);
    const edge = p.w + 2 + (mantleCaps ? mantleCaps[bi] : 400);
    const L = Math.abs(lat);
    if (pastEnd || L >= edge + 2) return null;   /* hors couloir : le sous-sommet reste bilinéaire */
    const sd = lat < 0 ? -1 : 1;   /* n°49 : dist signés */
    const dLow = Math.min(L, edge);
    const jj = Math.max(0, Math.min(25, Math.floor((dLow - (p.w + 2)) / STEP)));
    let yMin = Infinity;
    for (let ri = Math.max(0, bi - 1); ri <= Math.min(pts.length - 1, bi + 1); ri++) {
      const q = pts[ri];
      const capR = mantleCaps ? mantleCaps[ri] : 400;
      const dd0 = q.w + 2 + Math.min(jj * STEP, capR);
      const dd1 = q.w + 2 + Math.min((jj + 1) * STEP, capR);
      yMin = Math.min(yMin, terrainY(q, ri, sd * dd0), terrainY(q, ri, sd * dd1));
    }
    return yMin - 0.35;
  };
  const poseRing49 = (x, z, vy) => {   /* n°49 : couloir n°48 (min(bilinéaire, poseRing)) SINON bande de raccord au rim */
    let bi = -1, bd = Infinity;
    const cand = nearRows(x, z);
    for (let q = 0; q < cand.length; q++) {
      const p = pts[cand[q]];
      const dd = (x - p.x) * (x - p.x) + (z - p.y) * (z - p.y);
      if (dd < bd) { bd = dd; bi = cand[q]; }
    }
    if (bi < 0) return null;
    const p = pts[bi];
    const nvx = -Math.sin(p.hd), nvz = Math.cos(p.hd);
    const lat = (x - p.x) * nvx + (z - p.y) * nvz;
    const u = (x - p.x) * Math.cos(p.hd) + (z - p.y) * Math.sin(p.hd);
    const pastEnd = (bi === 0 && u < -8) || (bi === pts.length - 1 && u > 8);
    const edge = p.w + 2 + (mantleCaps ? mantleCaps[bi] : 400);
    const L = Math.abs(lat);
    if (pastEnd) return null;
    if (L < edge + 2) {   /* couloir : pose n°45/48 inchangée (min(bilinéaire, poseRing)) */
      const pr = poseRing(x, z);
      return pr === null ? null : Math.min(vy, pr);
    }
    if (L >= edge + 2 + BAND49) return null;   /* hors bande : le sous-sommet reste bilinéaire */
    const t = (L - (edge + 2)) / BAND49;
    return (seamRim(x, z, bi, lat < 0 ? -1 : 1) - 0.15) * (1 - t) + vy * t;
  };
  const subEmit = (a, b, c2, d2, omitPierce, jz, jx) => {
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
    const cx = pos[c2 * 3], cy = pos[c2 * 3 + 1], cz = pos[c2 * 3 + 2];
    const dx = pos[d2 * 3], dy = pos[d2 * 3 + 1], dz = pos[d2 * 3 + 2];
    const ac = [col[a * 3], col[a * 3 + 1], col[a * 3 + 2]];
    const bc = [col[b * 3], col[b * 3 + 1], col[b * 3 + 2]];
    const cc = [col[c2 * 3], col[c2 * 3 + 1], col[c2 * 3 + 2]];
    const dc = [col[d2 * 3], col[d2 * 3 + 1], col[d2 * 3 + 2]];
    const rows = omitPierce ? stripRowsFor(Math.min(ax, bx, cx, dx) - 40, Math.min(az, bz, cz, dz) - 40,
                              Math.max(ax, bx, cx, dx) + 40, Math.max(az, bz, cz, dz) + 40) : null;
    const N = 4;   /* 4×4 sous-cellules (25 m) */
    const bxv = bx - ax, byv = by - ay, bzv = bz - az;
    const cxv = cx - ax, cyv = cy - ay, czv = cz - az;
    const dxv = dx - bx - cx + ax, dyv = dy - by - cy + ay, dzv = dz - bz - cz + az;
    /* n°48 : un sous-sommet d'ARRÊTE n'est posé que si le quad voisin
       est AUSSI subdivisé (percée n°47 ou couloir n°48) — règle
       SYMÉTRIQUE : les deux parents consultent le même tableau
       précalculé et posent le sous-sommet partagé à la même valeur
       (poseRing est pure), sinon fissure le long de l'arrête.
       Arrête non posée → valeur bilinéaire = surface du voisin non
       subdivisé (une arrête de patch bilinéaire ne dépend que de ses
       deux coins partagés) → pas de fissure non plus. */
    const subNb = (dz2, dx2) => {
      if (dz2 < 0 || dz2 >= nz - 1 || dx2 < 0 || dx2 >= nx - 1) return false;
      const k = dz2 * (nx - 1) + dx2;
      return pierceQ48[k] === 1 || ringQ48[k] === 1;
    };
    const map = [];
    for (let i = 0; i <= N; i++) {
      map[i] = [];
      for (let j = 0; j <= N; j++) {
        if (i === 0 && j === 0) { map[i][j] = a; continue; }
        if (i === N && j === 0) { map[i][j] = b; continue; }
        if (i === 0 && j === N) { map[i][j] = c2; continue; }
        if (i === N && j === N) { map[i][j] = d2; continue; }
        const te = i / N, tf = j / N;
        const vx = ax + bxv * te + cxv * tf + dxv * te * tf;
        let vy = ay + byv * te + cyv * tf + dyv * te * tf;
        const vz = az + bzv * te + czv * tf + dzv * te * tf;
        /* n°48 : pose couloir (min(bilinéaire, poseRing)) — intérieur :
           toujours ; arrête : seulement si le voisin est subdivisé. */
        let pose = i > 0 && i < N && j > 0 && j < N;
        if (!pose) {
          if (i === 0) pose = subNb(jz, jx - 1);
          else if (i === N) pose = subNb(jz, jx + 1);
          else if (j === 0) pose = subNb(jz - 1, jx);
          else pose = subNb(jz + 1, jx);
        }
        if (pose) {
          const pr = poseRing49(vx, vz, vy);   /* n°49 : couloir OU bande de raccord au rim */
          if (pr !== null) vy = pr;
        }
        pos.push(vx, vy, vz);
        for (let k3 = 0; k3 < 3; k3++)
          col.push(ac[k3] + (bc[k3] - ac[k3]) * te + (cc[k3] - ac[k3]) * tf + (dc[k3] - bc[k3] - cc[k3] + ac[k3]) * te * tf);
        map[i][j] = pos.length / 3 - 1;
      }
    }
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const q00 = map[i][j], q10 = map[i + 1][j], q01 = map[i][j + 1], q11 = map[i + 1][j + 1];
        const e0 = pos[q00 * 3], e1 = pos[q00 * 3 + 1], e2 = pos[q00 * 3 + 2];
        const f0 = pos[q01 * 3], f1 = pos[q01 * 3 + 1], f2 = pos[q01 * 3 + 2];
        const g0 = pos[q10 * 3], g1 = pos[q10 * 3 + 1], g2 = pos[q10 * 3 + 2];
        const h0 = pos[q11 * 3], h1 = pos[q11 * 3 + 1], h2 = pos[q11 * 3 + 2];
        let omit = false;
        if (rows) {
          for (const p2 of rows) {
            if (triAbove(p2, [e0, e1, e2, f0, f1, f2, g0, g1, g2, g0, g1, g2, f0, f1, f2, h0, h1, h2])) { omit = true; break; }
          }
        }
        if (omit) { nHoles47++; continue; }
        idx.push(q00, q01, q10, q10, q01, q11);
        nQuads++;
      }
    }
  };
  let nHoles47 = 0;
  /* axes climatiques par macro-case 200 m (partagés par les cellules 2×2) */
  const climCache = new Map();
  const climAt = (x, z) => {
    const mx = Math.floor(x / 200), mz = Math.floor(z / 200);
    const k = mx * 100003 + mz;
    let e = climCache.get(k);
    if (!e) {
      const ax = mx * 200 + 100, az = mz * 200 + 100;
      e = { T: tempAt(ax, az, seed), M: moistAt(ax, az, seed), co: coastAt(ax, az, seed), fam: famAt(ax, az, seed) };
      climCache.set(k, e);
    }
    return e;
  };

  /* état par sommet (n°48) : 0 = loin ; ±1 couloir côté ± ; ±9 bande raccord n°49 côté ± ; ±3 talus côté ± ; ±2 collé côté ± (mort depuis n°45) */
  const sideOf = new Int8Array(nx * nz);
  const disp = new Float32Array(nx * nz);   /* n°40 : déplacement du collage (0 = libre) */
  const push = (x, y, z, c) => { pos.push(x, y, z); col.push(c.r, c.g, c.b); };

  for (let gz = gz0; gz <= gz1; gz++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const x = gx * CELL, z = gz * CELL;
      const vi = (gz - gz0) * nx + (gx - gx0);
      const cl = climAt(x, z);
      let px = x, pz = z, y = 0;
      let side = 0;
      /* rangée route la plus proche : 3×3 buckets de 500 m */
      let bi = -1, bd = Infinity;
      const bx = Math.floor(x / BUCK), bz = Math.floor(z / BUCK);
      for (let dbx = -1; dbx <= 1; dbx++) for (let dbz = -1; dbz <= 1; dbz++) {
        const arr = buckets.get(bkey(bx + dbx, bz + dbz));
        if (!arr) continue;
        for (let q = 0; q < arr.length; q++) {
          const p = pts[arr[q]];
          const dd = (x - p.x) * (x - p.x) + (z - p.y) * (z - p.y);
          if (dd < bd) { bd = dd; bi = arr[q]; }
        }
      }
      if (bi < 0) {
        y = H(x, z, seed) - 0.4;
      } else {
        const p = pts[bi];
        const nvx = -Math.sin(p.hd), nvz = Math.cos(p.hd);
        const lat = (x - p.x) * nvx + (z - p.y) * nvz;
        const u = (x - p.x) * Math.cos(p.hd) + (z - p.y) * Math.sin(p.hd);
        const pastEnd = (bi === 0 && u < -8) || (bi === pts.length - 1 && u > 8);
        const edge = p.w + 2 + (mantleCaps ? mantleCaps[bi] : 400);   // n°40 : même plafond que le manteau → couture sur l'anneau réel
        const L = Math.abs(lat);
        if (pastEnd || L >= edge + TALUS) {
          y = H(x, z, seed) - 0.4;
        } else if (L < edge + 2) {
          /* n°45 : DÉCOLLAGE GÉNÉRAL — plus AUCUN collage. Le sommet
             reste à sa position grille et se pose sous la surface du
             manteau, à min(échantillons de coins du quad manteau
             couvrant : 3 rangées × 2 colonnes, dist plafonnée au cap
             de chaque rangée) − 0,35 m. Les coins réels du manteau
             portent la même formule + jitter ≥ 0 → le sommet est
             PROUVÉ sous toute surface bilinéaire du manteau, même
             dans les falaises aliasées sous 16 m (H vrai ≠ H
             échantillonné : le décollage « à la position réelle »
             perce le manteau de 5-14 m, mesuré). Le n°43 avait rapproché
             la couture (cap ≥ 160 → limite à ~166 m au lieu de 406) :
             les cordes de collage quasi-coplanaires (|Δy| p50 0,35 m,
             4,5-5,8 km par fenêtre de 8 km) scintillaient en z-fight
             sur TOUT le parcours ; les pulls (moy 82 m, max 169 m)
             étiraient des quads en biais et laissaient des encoches.
             Ici : 0 shimmer, 0 perçage, 0 trou (banc n°45, 3 graines),
             build inchangé (~83 ms). Le manteau n°44 couvre ±166 m >
             141 m (pire diagonale de quad traversant la route) sur
             les portions droites. N°46 : aux kinks l’érosion du cap
             rétrécit le manteau (jusqu’à ~50 m) → le saut hp && hn
             de la passe d’index est SUPPRIMÉ, la grille décollée se
             dessine PARTOUT (étanche par construction) ; les
             conditions mortes gc===4 / disp>170 restent calculées
             mais inopérantes. */
          const sd = lat < 0 ? -1 : 1;
          const dLow = Math.min(L, edge);
          const jj = Math.max(0, Math.min(25, Math.floor((dLow - (p.w + 2)) / STEP)));
          let yMin = Infinity;
          for (let ri = Math.max(0, bi - 1); ri <= Math.min(pts.length - 1, bi + 1); ri++) {
            const q = pts[ri];
            const capR = mantleCaps ? mantleCaps[ri] : 400;
            const dd0 = q.w + 2 + Math.min(jj * STEP, capR);
            const dd1 = q.w + 2 + Math.min((jj + 1) * STEP, capR);
            yMin = Math.min(yMin, terrainY(q, ri, sd * dd0), terrainY(q, ri, sd * dd1));   /* n°49 : dist signés */
          }
          y = yMin - 0.35;
          side = sd;
        } else {
          /* talus : terrainY (celui du manteau) fond vers le H vrai */
          const sd = lat < 0 ? -1 : 1;
          const t = (L - edge) / TALUS;
          y = terrainY(p, bi, sd * L) * (1 - t) + (H(x, z, seed) - 0.4) * t - 0.1 * (1 - t);   /* n°49 : dist signé */
          if (L < edge + 2 + BAND49) {
            /* n°49 : RACCORD AU RIM — le sommet de la bande rejoint le
               rim interpolé (-0,15) puis fond vers sa valeur talus. */
            const t2 = (L - (edge + 2)) / BAND49;
            y = (seamRim(x, z, bi, sd) - 0.15) * (1 - t2) + y * t2;
            side = sd * 9;
          } else if (L < edge + 2 + BAND49 + CELL) {
            side = sd * 9;   /* voisin de bande : subdivisé pour la transition des faces, sans pose propre */
          } else {
            side = sd * 3;   /* n°48 : talus codé ±3 — seul le couloir (±1) et la bande (±9) déclenchent la subdivision */
          }
        }
      }
      sideOf[vi] = side;
      /* couleur : patchwork plaine en cellules 220 m MONDE (n°37) */
      let c;
      if (cl.fam === 0 && cl.M > 0.35 && cl.M < 0.75) {
        const cx = Math.floor(px / 220), cz = Math.floor(pz / 220);
        const fx = px / 220 - cx, fz = pz / 220 - cz;
        if (fx < 0.04 || fx > 0.96 || fz < 0.04 || fz > 0.96) c = HEDGE;
        else c = PATCH[Math.floor(posHash(cx * 3 + cz, 5) * 4) % 4];
      } else {
        c = groundCol(y, cl.T, cl.M, cl.co);
        snowAndSea(c, y);
        c.offsetHSL(0, 0, (posHash(Math.round(px / 8) + 77, Math.round(pz / 8)) - 0.5) * 0.03);
      }
      push(px, y, pz, c);
    }
  }

  /* n°48 : précalcul par quad — percée n°47 (même appel quadPierces
     qu'avant, stocké au lieu d'inline : zéro coût ajouté) et couloir
     n°48 (coin ±1 ; dilatation d'un rang : un voisin 4-connexe a un
     coin ±1, car edge varie entre rangées et une face n'entre dans
     l'anneau du manteau qu'avec un coin proche). */
  const pierceQ48 = new Uint8Array((nx - 1) * (nz - 1));
  const ringQ48 = new Uint8Array((nx - 1) * (nz - 1));
  const ringQuad48 = (jz, jx) => {
    if (jz < 0 || jz + 1 >= nz || jx < 0 || jx + 1 >= nx) return false;
    const a = jz * nx + jx, b = a + 1, c2 = a + nx, d2 = c2 + 1;
    const s = sideOf;
    const inR = (v) => v === 1 || v === -1 || v === 9 || v === -9;   /* n°49 : bande de raccord (±9) subdivisée aussi */
    return inR(s[a]) || inR(s[b]) || inR(s[c2]) || inR(s[d2]);
  };
  for (let jz = 0; jz + 1 < nz; jz++) for (let jx = 0; jx + 1 < nx; jx++) {
    const k = jz * (nx - 1) + jx;
    const a0 = jz * nx + jx, b0 = a0 + 1, c0 = a0 + nx, d0 = c0 + 1;
    pierceQ48[k] = quadPierces(a0, b0, c0, d0) ? 1 : 0;
    ringQ48[k] = (ringQuad48(jz, jx) || ringQuad48(jz, jx - 1) || ringQuad48(jz, jx + 1) ||
                  ringQuad48(jz - 1, jx) || ringQuad48(jz + 1, jx)) ? 1 : 0;
  }
  /* index : quads monde ; saut de ceux que le manteau couvre */
  let nQuads = 0, nSkip = 0;
  for (let jz = 0; jz + 1 < nz; jz++) {
    for (let jx = 0; jx + 1 < nx; jx++) {
      const a = jz * nx + jx, b = a + 1, c2 = a + nx, d2 = c2 + 1;
      const sa = sideOf[a], sb = sideOf[b], sc = sideOf[c2], sd = sideOf[d2];
      let hp = false, hn = false, gc = 0;
      if (sa > 0) hp = true; else if (sa < 0) hn = true;
      if (sb > 0) hp = true; else if (sb < 0) hn = true;
      if (sc > 0) hp = true; else if (sc < 0) hn = true;
      if (sd > 0) hp = true; else if (sd < 0) hn = true;
      if (sa === 2 || sa === -2) gc++;
      if (sb === 2 || sb === -2) gc++;
      if (sc === 2 || sc === -2) gc++;
      if (sd === 2 || sd === -2) gc++;
      /* n°40 : cap de déplacement — un coin collé à plus de 170 m de sa
         position grille est un collage sur un AUTRE bras d'épingle (même
         signe → non couvert par la règle des 2 côtés) : quad sauté, la
         zone reste couverte par le manteau. Collage légitime ≤ ~145 m. */
      const kq = jz * (nx - 1) + jx;
      if (pierceQ48[kq]) { subEmit(a, b, c2, d2, true, jz, jx); nSkip++; continue; }
      if (ringQ48[kq]) { subEmit(a, b, c2, d2, false, jz, jx); nSkip++; continue; }
      idx.push(a, c2, b, b, c2, d2);
      nQuads++;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  mesh.receiveShadow = shadowsOn;
  mesh.frustumCulled = false;
  group.add(mesh);
}


/* ============================================================
   n°22 — RELIEFS L2 LOW-POLY DANS LA BRUME (1,2-2,2 km)
   Par fenêtre, 3-8 masses positionnées par HASH PUR — silhouettes
   mangées à moitié par le brouillard = profondeur gratuite.
   ============================================================ */
function buildRidges(group, d) {
  const pts = d.pts;
  const seed = snap?.seed ?? 42;
  decoRidges = [];
  /* n°37 : masses ANCRÉES AU MONDE (cellules de 1 km d'arc, comme
     les villages) — l'ancienne clé floor(winS0/1000) changeait à
     CHAQUE fenêtre : les montagnes de l'horizon se téléportaient
     tous les 2,5 km de course. Même silhouette, mêmes couleurs,
     placement stable et identique pour tous les clients. */
  for (let cell = Math.floor(winS0 / 1000); cell <= Math.floor((winS0 + pts.length * STEP) / 1000); cell++) {
    const h0 = posHash(cell, 11);
    const nHere = h0 < 0.35 ? 1 : h0 < 0.55 ? 2 : 0;   // ~6 masses/fenêtre de 8 km
    for (let m = 0; m < nHere; m++) {
    const h1 = posHash(cell, 21 + m);
    const h2 = posHash(cell, 23 + m);
    const h3 = posHash(cell * 3 + m, 25);
    const sIdx = Math.round((cell * 1000 + h1 * 1000 - winS0) / STEP);
    if (sIdx < 2 || sIdx >= pts.length - 2) continue;
    const p = pts[sIdx];
    const side = h2 < 0.5 ? -1 : 1;
    const dist = 1200 + h3 * 1000;
    const nx = -Math.sin(p.hd), nz = Math.cos(p.hd);
    const cx = p.x + nx * side * dist, cz = p.y + nz * side * dist;
    /* base et amplitude RÉELLES (n°26) : le vrai H autour du candidat */
    let hMin = Infinity, hMax = -Infinity;
    for (const o of [[0, 0], [400, 0], [-400, 0], [0, 400], [0, -400]]) {
      const v = H(cx + o[0], cz + o[1], seed);
      if (v < hMin) hMin = v;
      if (v > hMax) hMax = v;
    }
    const ridgeH = Math.max(60, (hMax - hMin) * (0.5 + h2 * 0.5));
    const W = 250 + h3 * 450;
    /* crête en dents de scie : ligne de base + sommets */
    const pos = [], idx = [];
    const TEETH = 5 + Math.floor(h1 * 4);
    const dirX = Math.cos(p.hd + Math.PI / 2), dirZ = Math.sin(p.hd + Math.PI / 2);
    let vi = 0;
    /* n°33 : couleur CLIMATIQUE au lieu du relief (famille du lieu) ;
       mesa tabulaire = climat SEC (moistAt < 0,30), plus d'étiquette ;
       neige dès que l'altitude réelle du massif dépasse SNOW_ALT. */
    const T = tempAt(cx, cz, seed);
    const M = moistAt(cx, cz, seed);
    const co = coastAt(cx, cz, seed);
    const dry = M < 0.30;
    const baseY = hMin - 5;
    const snow = new THREE.Color('#eef2f5');
    const c = groundCol(baseY + ridgeH, T, M, co);
    c.multiplyScalar(0.55);   // teinte ASSOBRIE : lisibilité en silhouette
    if (baseY + ridgeH > SNOW_ALT) c.lerp(snow, Math.min(1, (baseY + ridgeH - SNOW_ALT) / 120));
    const cols = [];
    for (let t = 0; t <= TEETH; t++) {
      const u = t / TEETH;
      const bx = cx + dirX * (u - 0.5) * W * 2;
      const bz = cz + dirZ * (u - 0.5) * W * 2;
      pos.push(bx, baseY, bz); cols.push(c.r, c.g, c.b);
      const peakH = baseY + ridgeH * (0.6 + 0.4 * posHash(cell * 10 + t, 31));
      if (dry) {
        /* MESA tabulaire : plateau plat + flancs raides */
        const topH = baseY + ridgeH * 0.85;
        pos.push(bx + dirX * 8, topH, bz + dirZ * 8); cols.push(c.r, c.g, c.b);
        pos.push(bx - dirX * 8, topH, bz - dirZ * 8); cols.push(c.r, c.g, c.b);
      } else {
        pos.push(bx, peakH, bz); cols.push(c.r, c.g, c.b);
      }
      vi += dry ? 3 : 2;
    }
    const step = dry ? 3 : 2;
    for (let t = 0; t < TEETH; t++) {
      const a = t * step, b = (t + 1) * step;
      if (dry) {
        idx.push(a, a + 2, b, a + 2, b + 2, b);
        idx.push(a + 1, a + 2, b + 1, a + 2, b + 2, b + 1);
        idx.push(a + 2, b + 2, b, b + 1, b, b + 2);
      } else {
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
    decoRidges.push(mesh);
  }
  }
}

/* ============================================================
   n°22 — VILLAGES (plaine) + FERMES ISOLÉES — n°51 : le bourg est un
   CHAMP DU MONDE (villageCell, terrain.js — le MÊME champ que celui
   que la route esquive : cohérence route↔rendu par champ partagé).
   Le rendu itère les cellules MONDE de la bbox de la fenêtre
   (+ 1 500 m) : plus AUCUN ancrage route (plus de p.hd, plus de
   winS0) — le placement n°33 (famille du lieu, eau-vallée, temp,
   neige, praticabilité) vit DANS villageCell (core/terrain.ts).
   Maisons/clochers/lumières par posHash(ix * 1013 + iy, sel) :
   reconstruits À L'IDENTIQUE au rebuild de la fenêtre (ADR 0004
   d'esprit). Chaque maison reste posée à SA position H (n°26)
   via terrainAtXY.
   ============================================================ */
function buildVillages(group, d) {
  const pts = d.pts;
  const seed = snap?.seed ?? 42;
  villageLights = [];
  villageGroups = [];
  const wallGeo = new THREE.BoxGeometry(6, 4, 5);
  const roofGeo = new THREE.CylinderGeometry(0, 4.2, 2.4, 4);   // prisme 45°
  roofGeo.rotateY(Math.PI / 4);
  const WALLS = ['#d8d2c0', '#c9a98a', '#b7c4b5'].map((c) => new THREE.MeshLambertMaterial({ color: c }));
  const ROOFS = ['#8a4a3a', '#6a5a4a'].map((c) => new THREE.MeshLambertMaterial({ color: c }));
  const walls = [], roofs = [];
  const churchGeo = new THREE.CylinderGeometry(0, 2.2, 18, 4);
  const churches = [];
  const pushHouse = (x, y, z, rot) => {
    walls.push([x, y, z, rot]);
    roofs.push([x, y, z, rot]);
  };
  /* bbox monde de la fenêtre + 1 500 m : les bourgs « survolés » par le
     snap POI (rayon 2 200 m) et les rocades (700 m) sont dessinés */
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minZ) minZ = p.y; if (p.y > maxZ) maxZ = p.y;
  }
  const p0 = pts[0];   // terrainAtXY n'utilise pas p (H(x, z) monde)
  const i0 = Math.floor((minX - 1500) / VILL_CELL), i1 = Math.floor((maxX + 1500) / VILL_CELL);
  const j0 = Math.floor((minZ - 1500) / VILL_CELL), j1 = Math.floor((maxZ + 1500) / VILL_CELL);
  for (let ix = i0; ix <= i1; ix++) for (let iy = j0; iy <= j1; iy++) {
    const v = villageCell(ix, iy, seed);
    if (!v) continue;
    const isVillage = v.kind === 'village';
    const cx = v.x, cz = v.y;
    /* orientation des maisons par hash MONDE (plus de cap route) */
    const key = ix * 1013 + iy;
    const rotBase = posHash(key, 21) * Math.PI * 2;
    const nHouse = isVillage ? 6 + Math.floor(posHash(key, 12) * 13) : 2;
    const radius = isVillage ? 40 + posHash(key, 13) * 80 : 12;
    for (let h = 0; h < nHouse; h++) {
      const ang = (h / nHouse) * Math.PI * 2 + posHash(key * 10 + h, 14) * 0.5;
      const rr = radius * (0.55 + posHash(key * 10 + h, 15) * 0.7);
      const hx = cx + Math.cos(ang) * rr, hz = cz + Math.sin(ang) * rr;
      const rot = rotBase + (posHash(key * 10 + h, 16) - 0.5) * 0.9;
      pushHouse(hx, terrainAtXY(p0, hx, hz), hz, rot);
    }
    /* clocher sur ~1 village sur 2 */
    if (isVillage && posHash(key, 17) < 0.5)
      churches.push([cx, terrainAtXY(p0, cx, cz), cz, rotBase]);
    /* nuit : points lumineux chauds — allumés avec les POI */
    if (isVillage) {
      const nL = 4 + Math.floor(posHash(key, 18) * 6);
      for (let l = 0; l < nL; l++) {
        const ang = posHash(key * 10 + l, 19) * Math.PI * 2;
        const rr = radius * posHash(key * 10 + l, 20);
        const g = new THREE.Points(
          new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(cx + Math.cos(ang) * rr, terrainAtXY(p0, cx + Math.cos(ang) * rr, cz + Math.sin(ang) * rr) + 3, cz + Math.sin(ang) * rr)]),
          new THREE.PointsMaterial({ color: 0xffd9a0, size: 3, transparent: true, opacity: 0 }));
        group.add(g);
        villageLights.push(g);
      }
    }
  }
  const place = (geo, mats, arr, yOff) => {
    if (!arr.length) return;
    const mat = mats[0];
    const im = new THREE.InstancedMesh(geo, mat, arr.length);
    const m = new THREE.Matrix4();
    arr.forEach(([x, y, z, rot], i2) => {
      m.makeRotationY(Math.PI / 2 - rot);
      m.setPosition(x, y + yOff, z);
      im.setMatrixAt(i2, m);
    });
    im.castShadow = shadowsOn;
    group.add(im);
    villageGroups.push(im);
  };
  place(wallGeo, WALLS, walls, 2);
  place(roofGeo, ROOFS, roofs, 5.2);
  place(churchGeo, ROOFS, churches, 9);
}

/* ============================================================
   n°22 — EAU : rivières sous les ponts + lacs dans les creux
   Matériau PARTAGÉ (suit la palette nuit comme le reste).
   ============================================================ */
function getWaterMat() {
  if (!waterMat) waterMat = new THREE.MeshLambertMaterial({ color: 0x4a7a9a });
  return waterMat;
}

/* ============================================================
   n°33 — HYDROLOGIE LOCALE : grille D8 de 100 m sur la bbox de la
   fenêtre + marge 2 400 m ; flowAccum (core/terrain) descend le
   relief case par case et accumule l'eau reçue. Pur de la fenêtre :
   même grille → mêmes rivières au rebuild (jamais de PRNG). Le coût
   est borné par la fenêtre (aujourd'hui ~180×180 cellules).
   ============================================================ */
function buildHydro(d) {
  const pts = d.pts;
  const seed = snap?.seed ?? 42;
  const CS = 100, PAD = 2400;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  /* origine ALIGNÉE AU MONDE (multiple de CS) : les cellules rivière
     tombent aux mêmes positions monde à chaque rebuild de fenêtre —
     pas de tremblement d'eau quand la fenêtre glisse. */
  const ox = Math.floor((minX - PAD) / CS) * CS;
  const oz = Math.floor((minY - PAD) / CS) * CS;
  const w = Math.ceil((maxX + PAD - ox) / CS) + 1;
  const h = Math.ceil((maxY + PAD - oz) / CS) + 1;
  const grid = new Float64Array(w * h);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++)
      grid[j * w + i] = H(ox + i * CS, oz + j * CS, seed);
  const acc = flowAccum(grid, w, h);
  return { x0: ox, z0: oz, w, h, CS, acc };
}

/* max d'accumulation dans le carré de rayon r autour de (x, z) */
function hydroAccMax(x, z, r) {
  if (!hydro) return 0;
  const g0x = Math.max(0, Math.round((x - r - hydro.x0) / hydro.CS));
  const g0y = Math.max(0, Math.round((z - r - hydro.z0) / hydro.CS));
  const g1x = Math.min(hydro.w - 1, Math.round((x + r - hydro.x0) / hydro.CS));
  const g1y = Math.min(hydro.h - 1, Math.round((z + r - hydro.z0) / hydro.CS));
  let m = 0;
  for (let gy = g0y; gy <= g1y; gy++)
    for (let gx = g0x; gx <= g1x; gx++)
      if (hydro.acc[gy * hydro.w + gx] > m) m = hydro.acc[gy * hydro.w + gx];
  return m;
}

function buildWater(group, d) {
  const pts = d.pts;
  const seed = snap?.seed ?? 42;
  const water = getWaterMat();
  /* n°33 — RIVIÈRES CAUSALES : toute cellule de la grille hydro avec
     accumulation ≥ 60 ET humidité ≥ 0,30 est une cellule de rivière.
     Le plan d'eau = min de H sur le voisinage 3×3 + 1,5 m ; les
     cellules sous SEA_SL+2 sont la mer (pas une rivière). L'eau
     DESCEND le relief — elle n'est plus un ruban posé par hash sous
     les ponts. Un quad cs/2+1 par cellule (léger recouvrement pour
     boucher les jointures), une seule géométrie. */
  const pos = [], idx = [];
  let vi = 0;
  for (let j = 1; j < hydro.h - 1; j++) {
    for (let i = 1; i < hydro.w - 1; i++) {
      if (hydro.acc[j * hydro.w + i] < 60) continue;
      const x = hydro.x0 + i * hydro.CS, z = hydro.z0 + j * hydro.CS;
      if (moistAt(x, z, seed) < 0.30) continue;
      let hb = Infinity;
      for (let oj = -1; oj <= 1; oj++)
        for (let oi = -1; oi <= 1; oi++)
          hb = Math.min(hb, H(x + oi * hydro.CS, z + oj * hydro.CS, seed));
      if (hb < WP.seaLevel + 2) continue;   // c'est la mer, pas une rivière
      /* n°41 : BERGE + PLAN BAS + CORRIDOR — la nappe à hb+1,5 SURVOLE
         le sol en plaine plate (mesuré km 0 : 1,9 m au-dessus de
         l'herbe, nappes carrées de 102 m découpées en triangles, de
         part et d'autre de la route) et sur le talus en montagne
         (2,9 m à 430 m de la route : le sol du talus est un fondu
         route→H, pas H). L'eau ne se dessine QUE bordée par le
         terrain, comme la côte de la mer :
         - PORTE : au moins 2,0 m de montée de H sur l'empreinte du
           quad (±51 m) — cellule plate = pas de rive = pas d'eau ;
         - PLAN BAS : hb+0,35 — ruisseau peu profond dans le creux,
           bord naturel = intersection plan/pente ;
         - CORRIDOR : pas d'eau dans edge+700+51 de la rangée la plus
           proche (sol route-ancré ≠ H, et l'eau y serait cachée par
           le talus depuis n°39). */
      let hg = -Infinity;
      for (let pj = -1; pj <= 1; pj++)
        for (let pi = -1; pi <= 1; pi++)
          hg = Math.max(hg, H(x + pi * (hydro.CS / 2 + 1), z + pj * (hydro.CS / 2 + 1), seed));
      if (hg - hb < 2.0) continue;
      let bMin = Infinity, bNear = -1;
      for (let t = 0; t < pts.length; t++) {
        const dd = (x - pts[t].x) ** 2 + (z - pts[t].y) ** 2;
        if (dd < bMin) { bMin = dd; bNear = t; }
      }
      const pn = pts[bNear];
      const nvx = -Math.sin(pn.hd), nvz = Math.cos(pn.hd);
      const lat = Math.abs((x - pn.x) * nvx + (z - pn.y) * nvz);
      if (lat < pn.w + 2 + (mantleCaps ? mantleCaps[bNear] : 400) + 751) continue;
      const y = hb + 0.35;
      const r = hydro.CS / 2 + 1;
      pos.push(x - r, y, z - r, x + r, y, z - r, x + r, y, z + r, x - r, y, z + r);
      idx.push(vi, vi + 2, vi + 1, vi, vi + 3, vi + 2);
      vi += 4;
    }
  }
  if (vi) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    group.add(new THREE.Mesh(geo, water));
  }
  /* n°33 — MER : plan au niveau SEA_SL, centré sur la fenêtre. La
     côte est une courbe de niveau du champ — visible dès que la
     route frôle ou traverse la côte ; la chaussée F5 la survole
     (HroadC = SEA_SL + 12). */
  const mid = pts[Math.floor(pts.length / 2)];
  const seaGeo = new THREE.CircleGeometry(4800, 24);
  seaGeo.rotateX(-Math.PI / 2);
  const sea = new THREE.Mesh(seaGeo, water);
  sea.position.set(mid.x, WP.seaLevel, mid.y);
  group.add(sea);
  /* LACS : cellules de 2 000 m, plaine/forêt — vrais minima locaux
     de H (n°26), disque d'eau posé dans la cuvette réelle */
  for (let cell = Math.floor(winS0 / 2000); cell <= Math.floor((winS0 + pts.length * STEP) / 2000); cell++) {
    if (posHash(cell, 13) >= 0.045) continue;
    const sCell = cell * 2000 - winS0;
    const i = Math.round(sCell / STEP);
    if (i < 2 || i >= pts.length - 2) continue;
    const p = pts[i];
    /* n°33 : lacs en plaine/forêt/boréal (familles 0/2/3) — le désert
       n'a pas de lac, le littoral a la mer, l'altitude a la neige. */
    if (p.biome !== 0 && p.biome !== 2 && p.biome !== 3) continue;
    /* n°29 : nx/nz étaient hors de portée (déclarés dans la boucle
       RIVIÈRES uniquement) — ReferenceError dès qu'une cellule lac
       candidate entrait dans la fenêtre : le monde ne se reconstruisait
       plus (fenêtre figée, voitures hors-piste). */
    const nx = -Math.sin(p.hd), nz = Math.cos(p.hd);
    /* VRAI minimum local de H (n°26) : scan fin 25 m — la grille est
       remplie D'ABORD dans un Float64Array (~6 000 appels H), puis on
       détecte les minima locaux stricts. Zone : latéral 300-1600 m
       DES DEUX côtés, ±700 m le long. */
    const SP = 25, NW = 53, NL = 57;
    const grid = new Float64Array(NW * NL * 2);
    let best = null;
    for (let side2 = 0; side2 < 2; side2++) {
      const sgn = side2 === 0 ? -1 : 1;
      for (let jj = 0; jj < NL; jj++) {
        const dj = -700 + jj * SP;
        for (let kk = 0; kk < NW; kk++) {
          const dd = 300 + kk * SP;
          const gx = p.x + nx * sgn * dd + Math.cos(p.hd) * dj;
          const gz = p.y + nz * sgn * dd + Math.sin(p.hd) * dj;
          grid[(side2 * NL + jj) * NW + kk] = H(gx, gz, seed);
        }
      }
    }
    for (let side2 = 0; side2 < 2 && !best; side2++) {
      for (let jj = 1; jj < NL - 1; jj++) {
        const dj = -700 + jj * SP;
        if (Math.abs(dj) > 500) continue;   // rester dans la fenêtre rendue
        for (let kk = 1; kk < NW - 1; kk++) {
          const v = grid[(side2 * NL + jj) * NW + kk];
          let isMin = true;
          for (let a = -1; a <= 1 && isMin; a++)
            for (let b2 = -1; b2 <= 1; b2++) {
              if (!a && !b2) continue;
              if (grid[(side2 * NL + jj + b2) * NW + kk + a] <= v) { isMin = false; break; }
            }
          if (!isMin) continue;
          const dd = 300 + kk * SP;
          const sgn = side2 === 0 ? -1 : 1;
          const gx = p.x + nx * sgn * dd + Math.cos(p.hd) * dj;
          const gz = p.y + nz * sgn * dd + Math.sin(p.hd) * dj;
          /* cuvette vs anneau 250 m */
          let ringMin = Infinity;
          for (let a = 0; a < 8; a++) {
            const v2 = H(gx + Math.cos(a * Math.PI / 4) * 250, gz + Math.sin(a * Math.PI / 4) * 250, seed);
            if (v2 < ringMin) ringMin = v2;
          }
          const depth = ringMin - v;
          if (depth >= 1.2 && (!best || depth > best.depth))
            best = { x: gx, z: gz, c: v, depth };
        }
      }
    }
    if (!best) continue;
    /* rayon du disque : le plus grand R tel que le cercle (12 pts)
       reste au-dessus du plan d'eau best.c + 0,6·depth */
    const lvl = best.c + 0.6 * best.depth;
    let R = 0;
    for (let r = 300; r >= 50; r -= 25) {
      let ok = true;
      for (let a = 0; a < 12; a++) {
        const v2 = H(best.x + Math.cos(a * Math.PI / 6) * r, best.z + Math.sin(a * Math.PI / 6) * r, seed);
        if (v2 < lvl) { ok = false; break; }
      }
      if (ok) { R = r; break; }
    }
    if (R < 50) continue;
    const y = lvl;
    const nVert = 12 + Math.floor(posHash(cell, 25) * 9);
    const Rlake = Math.min(R, 60 + posHash(cell, 26) * 160);
    const pos = [best.x, y, best.z];
    const idx = [];
    for (let v = 1; v <= nVert; v++) {
      const ang = (v / nVert) * Math.PI * 2;
      const rr = Rlake * (0.7 + posHash(cell * 10 + v, 27) * 0.5);
      pos.push(best.x + Math.cos(ang) * rr, y, best.z + Math.sin(ang) * rr);
      idx.push(0, v, v === nVert ? 1 : v + 1);
    }    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    group.add(new THREE.Mesh(geo, water));
  }
}

/* ============================================================
   n°26 — SKYLINE RÉELLE : le vrai H à 4,5 km — les montagnes
   visibles sont celles que la route traverse réellement.
   Reconstruit à chaque fenêtre (l'horizon change avec la position).
   ============================================================ */
function buildSkyline(d) {
  const seed = snap?.seed ?? 42;
  const pts = d.pts;
  const mid = pts[Math.floor(pts.length / 2)];
  if (skyGroup) {           // reconstruit à chaque fenêtre : le VRAI
    scene.remove(skyGroup);  // horizon change avec la position
    skyGroup.geometry.dispose();
    skyGroup.material.dispose();
    skyGroup = null;
  }
  const R = 4500;
  const pos = [], idx = [];
  const SEG = 48;
  let vi = 0;
  for (let s = 0; s < SEG; s++) {
    const a0 = (s / SEG) * Math.PI * 2, a1 = ((s + 1) / SEG) * Math.PI * 2;
    /* silhouette RÉELLE : le vrai H à 4,5 km, relatif à l'altitude
       locale — on voit les montagnes que la route traverse réellement */
    const h0 = Math.max(40, H(mid.x + Math.cos(a0) * R, mid.y + Math.sin(a0) * R, seed) - mid.z + 60);
    const h1 = Math.max(40, H(mid.x + Math.cos(a1) * R, mid.y + Math.sin(a1) * R, seed) - mid.z + 60);
    pos.push(Math.cos(a0) * R, 0, Math.sin(a0) * R);
    pos.push(Math.cos(a0) * R, h0, Math.sin(a0) * R);
    pos.push(Math.cos(a1) * R, h1, Math.sin(a1) * R);
    pos.push(Math.cos(a1) * R, 0, Math.sin(a1) * R);
    idx.push(vi, vi + 1, vi + 2, vi + 2, vi + 3, vi);
    vi += 4;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  skyMat = new THREE.MeshBasicMaterial({ color: 0x8aa0b8, fog: false, side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
  skyGroup = new THREE.Mesh(geo, skyMat);
  skyGroup.frustumCulled = false;
  scene.add(skyGroup);
}

/* ---- végétation par biome : InstancedMesh ---- */
function buildProps(group, d) {
  const pts = d.pts;
  const seed = snap?.seed ?? 42;
  const treeGeo = new THREE.ConeGeometry(2.2, 6, 6);
  const treeMat = new THREE.MeshLambertMaterial({ color: '#2e7d32' });
  const pineGeo = new THREE.ConeGeometry(1.8, 9, 5);
  const pineMat = new THREE.MeshLambertMaterial({ color: '#1b5e20' });
  const rockGeo = new THREE.DodecahedronGeometry(1.6, 0);
  const rockMat = new THREE.MeshLambertMaterial({ color: '#9e958a' });
  const bushGeo = new THREE.SphereGeometry(1.1, 5, 4);
  const bushMat = new THREE.MeshLambertMaterial({ color: '#7a7a3a' });
  const palmTrunkGeo = new THREE.CylinderGeometry(0.35, 0.55, 7, 5);
  const palmTrunkMat = new THREE.MeshLambertMaterial({ color: '#8a6a4a' });
  const palmCrownGeo = new THREE.ConeGeometry(3.2, 1.6, 6);
  const palmCrownMat = new THREE.MeshLambertMaterial({ color: '#3e8e3e' });

  const items = { tree: [], pine: [], rock: [], bush: [], palm: [] };
  for (let i = 2; i < pts.length - 2; i += 2) {
    const p = pts[i];
    const nx = -Math.sin(p.hd), nz = Math.cos(p.hd);
    /* n°37 : tirages ANCRÉS AU MONDE (rangée monde rw) — l'ancien
       PRNG de fenêtre faisait apparaître/disparaître les arbres à
       chaque glissement de fenêtre. */
    const rw = winS0 / STEP + i;
    const r1 = posHash(rw, 40), r2 = posHash(rw, 41), r3 = posHash(rw, 42);
    const side = r2 < 0.5 ? -1 : 1;
    const dist = p.w + 4 + r3 * 90;
    const x = p.x + nx * side * dist;
    const zz = p.y + nz * side * dist;
    const y = terrainY(p, i, side * dist) + posHash(rw, 43) * 2;   /* n°49 : dist signé — les arbres/roches G se posaient sur le miroir droit */
    /* n°33 — CASCADE CLIMATIQUE : la végétation dérive des axes au
       point de pose (plus d'étiquette par abscisse) — roches en
       nival, pins taïga sous −6 °C, pins+roches de montagne, palmiers
       tropical humide et rivage chaud, feuillus denses en humide,
       buissons épars en sec, prairie tempérée par défaut. */
    const T = tempAt(x, zz, seed), M = moistAt(x, zz, seed), co = coastAt(x, zz, seed);
    const forestWave = Math.sin(i * 0.15) > -0.3;
    if (y > SNOW_ALT) {
      if (r1 < 0.35) items.rock.push([x, y, zz, 0.7 + r3]);
    } else if (T < -6) {
      if (r1 < 0.14) items.pine.push([x, y, zz, 0.8 + r3 * 0.7]);
    } else if (y > 240) {
      if (r1 < 0.18) items.pine.push([x, y, zz, 0.8 + r3 * 0.7]);
      if (r3 > 0.85) items.rock.push([x, y, zz, 0.7 + r3]);
    } else if (T > 22 && M > 0.45) {
      if (r1 < 0.28) items.palm.push([x, y, zz, 0.75 + r3 * 0.5]);
    } else if (co > 0.65 && T > 12) {
      if (r1 < 0.20) items.palm.push([x, y, zz, 0.75 + r3 * 0.5]);
    } else if (M > 0.55) {
      if (r1 < (forestWave ? 0.55 : 0.12)) items.tree.push([x, y, zz, 0.7 + r3 * 0.6]);
    } else if (M < 0.30) {
      if (r1 < 0.15) items.bush.push([x, y, zz, 0.6 + r3]);
    } else {
      if (r1 < 0.22) items.tree.push([x, y, zz, 0.7 + r3 * 0.6]);
    }
  }
  const place = (geo, mat, arr) => {
    if (!arr.length) return;
    const im = new THREE.InstancedMesh(geo, mat, arr.length);
    const m = new THREE.Matrix4();
    arr.forEach(([x, y, z, s], i) => {
      m.makeTranslation(x, y + 2 * s, z);
      m.scale(new THREE.Vector3(s, s, s));
      im.setMatrixAt(i, m);
    });
    im.castShadow = shadowsOn;
    group.add(im);
  };
  place(treeGeo, treeMat, items.tree);
  place(pineGeo, pineMat, items.pine);
  place(rockGeo, rockMat, items.rock);
  place(bushGeo, bushMat, items.bush);
  /* palmiers : 2 InstancedMesh (tronc + couronne) aux MÊMES positions */
  if (items.palm.length) {
    const imT = new THREE.InstancedMesh(palmTrunkGeo, palmTrunkMat, items.palm.length);
    const imC = new THREE.InstancedMesh(palmCrownGeo, palmCrownMat, items.palm.length);
    const m = new THREE.Matrix4(), sc = new THREE.Vector3();
    items.palm.forEach(([x, y, z, s], i) => {
      m.makeTranslation(x, y + 3.5 * s, z); m.scale(sc.set(s, s, s)); imT.setMatrixAt(i, m);
      m.makeTranslation(x, y + 7.4 * s, z); m.scale(sc.set(s, s, s)); imC.setMatrixAt(i, m);
    });
    imT.castShadow = shadowsOn;
    imC.castShadow = shadowsOn;
    group.add(imT);
    group.add(imC);
  }
}

/* ---- POI : low-poly + éclairage la nuit ---- */
function buildPois(group, pois) {
  for (const poi of pois) {
    const g = new THREE.Group();
    if (poi.kind === 'station') {
      g.add(box(6, 3, 4, '#cfd6dd', 0, 1.5, 0));
      g.add(box(7, 0.3, 5, '#e63946', 0, 3.4, 0));
      g.add(box(0.8, 1.2, 0.8, '#d64545', 2.5, 0.6, 1.5));
      g.add(box(0.8, 1.2, 0.8, '#d64545', 4, 0.6, 1.5));
    } else if (poi.kind === 'hotel') {
      g.add(box(9, 5, 6, '#d9c9a3', 0, 2.5, 0));
      g.add(box(2, 1, 2, '#ffd166', 0, 5.8, 0));
    } else {
      g.add(box(8, 3.4, 6, '#8d99ae', 0, 1.7, 0));
      g.add(box(3, 2.2, 0.3, '#6c757d', 0, 4.4, 0));
    }
    g.position.set(poi.x, poi.z, poi.y);
    const light = new THREE.PointLight(0xffd9a0, 0, 60, 2);
    light.position.set(poi.x, poi.z + 6, poi.y);
    group.add(light);
    poiLights.push(light);
    group.add(g);
  }
}

function box(w, h, dp, color, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, dp), new THREE.MeshLambertMaterial({ color }));
  m.position.set(x, y, z);
  m.castShadow = shadowsOn;
  return m;
}

/* ============================================================
   Voitures — low-poly, roues, phares, nom, poussière
   ============================================================ */
function makeCarMesh(car) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.8, 4.2),
    new THREE.MeshLambertMaterial({ color: car.color }));
  body.position.y = 0.75;
  body.castShadow = shadowsOn;
  g.add(body);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 1.8),
    new THREE.MeshLambertMaterial({ color: '#20262e' }));
  cabin.position.set(0, 1.35, -0.2);
  g.add(cabin);
  const wheels = [];
  const wg = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 8);
  /* essieu sur X DANS LA GÉOMÉTRIE : l'ancien rotation.z = PI/2 sur
     le mesh, combiné au spin sur rotation.y (Euler XYZ), faisait
     tourner l'essieu autour de la VERTICALE — les roues « flottaient »
     à ~66 rad/s au lieu de rouler. Avec la géométrie pré-tournée, le
     spin sur rotation.x roule sur le bon axe. */
  wg.rotateZ(Math.PI / 2);
  const wm = new THREE.MeshLambertMaterial({ color: '#14171c' });
  let fw = 0;
  for (const [x, z] of [[-0.95, 1.35], [0.95, 1.35], [-0.95, -1.35], [0.95, -1.35]]) {
    const w = new THREE.Mesh(wg, wm);
    w.position.set(x, 0.42, z);
    /* ROUES AVANT (z > 0) BRAQUÉES : rotation.order YXZ pour que le
       braquage (rotation.y, autour de la verticale) s'applique AVANT
       le spin (rotation.x) — la roue roule dans la direction où elle
       pointe. Le braquage suit la consigne steer exposée par le serveur. */
    if (z > 0) { w.rotation.order = 'YXZ'; wheels.push(w); fw++; }
    else wheels.push(w);
    g.add(w);
  }
  const headMat = new THREE.MeshLambertMaterial({ color: '#fff7d0', emissive: 0x000000 });
  for (const x of [-0.6, 0.6]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.2, 0.1), headMat);
    h.position.set(x, 0.85, 2.1);
    g.add(h);
  }
  const brakeMat = new THREE.MeshLambertMaterial({ color: '#5a1520', emissive: 0x000000 });
  const stop = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.15, 0.08), brakeMat);
  stop.position.set(0, 0.85, -2.12);
  g.add(stop);
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 64;
  const ctx = cv.getContext('2d');
  ctx.font = 'bold 34px system-ui';
  ctx.textAlign = 'center';
  ctx.fillStyle = car.color;
  ctx.fillText(`${car.rank}. ${car.name}`, 128, 42);
  const tex = new THREE.CanvasTexture(cv);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  sprite.scale.set(7, 1.8, 1);
  sprite.position.y = 3;
  g.add(sprite);
  scene.add(g);
  return { group: g, wheels, frontWheels: wheels.slice(0, 2), headMat, brakeMat, tgt: null };
}

/* setData(snap) : alimente les cibles — le poll serveur (1 s) est LA
   seule source de vérité ; entre deux polls, animateCars() fait le
   dead reckoning (CORRECTIF 2). */
function syncTargets(d) {
  snap = d;
  if (followId === null || !d.cars.some((c) => c.id === followId)) {
    followId = d.me?.id ?? d.cars[0].id;
  }
  const seen = new Set();
  for (const c of d.cars) {
    seen.add(c.id);
    let m = carMeshes.get(c.id);
    if (!m) { m = makeCarMesh(c); carMeshes.set(c.id, m); }
    const meC = d.me?.id === c.id ? d.me : null;
    /* MA voiture : cible lue sur d.me (reconstruit À LA REQUÊTE,
     donc frais) — l'entrée publique de cars peut être plus ancienne */
    const src = meC ?? c;
    m.tgt = {
      x: src.pos3.x, y: src.pos3.z, z: src.pos3.y, hd: src.hd,
      s: src.km * 1000, d: src.d ?? 0,   /* abscisse curviligne + décalage
                                            latéral : le dead reckoning va
                                            suivre LA ROUTE (km et d sont
                                            déjà dans le snapshot public) */
      v: (meC ? meC.v : (c.v ?? 0)) / 3.6,
      steer: c.steer ?? 0,   /* braquage des roues avant (télémétrie) */
      rpm: c.rpm ?? 0,        /* régime moteur — son (n°24) */
      t: performance.now(),   /* la cible est un ÉCHANTILLON d'un mouvement
                                  continu, pas un point d'arrivée */
      thrS: (c.thr ?? 0),     /* pédale pour le son (lissée par setTargetAtTime) */
    };
    /* premier rendu : sauter sur la cible — pas de lerp depuis
       l'origine (0,0,0), la voiture serait « arrivée en volant » */
    if (m.rx === undefined) {
      m.rx = m.tgt.x; m.ry = m.tgt.y; m.rz = m.tgt.z; m.rhd = m.tgt.hd;
      m.rs = m.tgt.s;   /* abscisse curviligne rendue (dead reckoning route) */
    }
    if (meC) {
      m.group.rotation.x = meC.pitch ?? 0;
      m.group.rotation.z = meC.roll ?? 0;
    }
    m.brakeMat.emissive.setHex((c.brake ?? (meC?.brake ?? 0)) ? 0xff2222 : 0x000000);
    /* poussière : visible si on roule, plus dense au désert */
    let biome = 0;
    if (world?.pts) {
      let best = Infinity;
      for (const wp of world.pts) {
        const dd = Math.abs(wp.x - c.pos3.x) + Math.abs(wp.y - c.pos3.y);
        if (dd < best) { best = dd; biome = wp.biome; }
      }
    }
  }
  for (const [id, m] of carMeshes) {
    if (!seen.has(id)) { scene.remove(m.group); carMeshes.delete(id); }
  }
}

/* Position sur la POLYLINE de la route pour l'abscisse curviligne rs
   (mètres depuis le départ) : le monde est échantillonné tous les
   STEP m depuis s0 — on interpole entre les deux échantillons qui
   encadrent rs, puis on décale latéralement de `lat` mètres sur la
   normale au cap interpolé. C'est LE correctif « la voiture coupe
   les virages puis revient » : l'ancien dead reckoning en ligne
   droite le long du cap accumulait 3,0–5,5 m d'erreur latérale par
   seconde de poll dans les virages. Renvoie null si le monde n'est
   pas prêt ou si rs sort de la fenêtre (fallback tangente). */
function roadPos(rs, lat) {
  if (!world?.pts?.length) return null;
  const f = (rs - world.s0) / world.step;
  if (f < 0 || f > world.pts.length - 1) return null;
  const i = Math.min(world.pts.length - 2, Math.floor(f));
  const u = f - i;
  const a = world.pts[i], b = world.pts[i + 1];
  let dh = b.hd - a.hd;
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  const hd = a.hd + dh * u;
  const nx = -Math.sin(hd), nz = Math.cos(hd);
  return {
    x: a.x + (b.x - a.x) * u + nx * lat,   /* plan : x de l'API */
    y: a.z + (b.z - a.z) * u,             /* altitude : z de l'API → Y three */
    z: a.y + (b.y - a.y) * u + nz * lat,  /* plan : y de l'API → Z three */
    hd,
  };
}

/* Dead reckoning LE LONG DE LA ROUTE : l'abscisse curviligne m.rs
   avance de v·dt, la position est PROJETÉE sur la polyline de la
   route (roadPos) — la voiture rendue suit le tracé dans les
   virages au lieu de couper en ligne droite hors piste puis de
   « revenir » au poll. Convergence ~0,7 s vers l'abscisse cible
   extrapolée (échantillon + v×âge) : corrige la dérive d'horloge
   sans jamais téléporter. Fallback tangente si le monde n'est pas
   encore construit ou si l'abscisse sort de la fenêtre de rendu. */
function animateCars(dt, now) {
  for (const m of carMeshes.values()) {
    if (!m.tgt) continue;
    m.v = m.tgt.v;
    const k = 1 - Math.exp(-dt / 0.7);
    if (m.rs === undefined) m.rs = m.tgt.s;
    m.rs += m.v * dt;
    /* CIBLE EXTRAPOLÉE en abscisse : on converge vers où la voiture
       est MAINTENANT (échantillon + v×âge), pas vers l'échantillon
       gelé — en régime établi l'erreur est nulle, la vitesse rendue
       est CONSTANTE. */
    const age = Math.max(0, (now - m.tgt.t) / 1000);
    const sT = m.tgt.s + m.tgt.v * age;
    m.rs += (sT - m.rs) * k;
    const rp = roadPos(m.rs, m.tgt.d ?? 0);
    if (rp) {
      m.rx += (rp.x - m.rx) * k;
      m.ry += (rp.y - m.ry) * k;
      m.rz += (rp.z - m.rz) * k;
      let dh = m.tgt.hd - m.rhd;
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      m.rhd += dh * k;
    } else {
      /* fallback : l'ancienne extrapolation tangente (monde pas
         encore construit, abscisse hors fenêtre) */
      m.rx += Math.cos(m.rhd) * m.v * dt;
      m.rz += Math.sin(m.rhd) * m.v * dt;
      const px = m.tgt.x + Math.cos(m.tgt.hd) * m.tgt.v * age;
      const pz = m.tgt.z + Math.sin(m.tgt.hd) * m.tgt.v * age;
      const py = m.tgt.y;
      m.rx += (px - m.rx) * k;
      m.ry += (py - m.ry) * k;
      m.rz += (pz - m.rz) * k;
      let dh = m.tgt.hd - m.rhd;
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      m.rhd += dh * k;
    }
    m.group.position.set(m.rx, m.ry, m.rz);
    /* CORRECTIF 1 : l'avant du maillage est sur +Z local ;
       rotation.y = PI/2 - hd aligne l'avant sur (cos hd, 0, sin hd). */
    m.group.rotation.y = Math.PI / 2 - m.rhd;
    for (const w of m.wheels) w.rotation.x += (m.v / 0.42) * dt;
    /* ROUES AVANT BRAQUÉES : steer × 0,35 rad (défense 0 si absent —
       snapshot ancien). YXZ : le braquage vertical s'applique avant
       le spin, la roue roule où elle pointe. */
    const steerAng = (m.tgt.steer ?? 0) * 0.35;
    for (const w of m.frontWheels) w.rotation.y = steerAng;
  }
}

/* ============================================================
   Caméra — poursuite derrière-haute UNIQUEMENT (choix arrêté) ;
   orbite lente si la voiture est arrêtée (sommeil, ravitaillement,
   panne — et pendant la préparation, où toute la grille est à
   l'arrêt : elle s'active toute seule). Lit la position
   INTERPOLÉE du mesh suivi — sinon la caméra sauterait à chaque
   poll même avec le dead reckoning.
   ============================================================ */
function updateCamera(dt) {
  const m = carMeshes.get(followId);
  if (!m || m.rx === undefined) return;
  const p = new THREE.Vector3(m.rx, m.ry + 1, m.rz);
  const car = followCar();
  const stopped = !car || ['stop', 'dry', 'finish'].includes(car.st)
    || (snap?.phase === 'preparation');
  let target, look;
  if (stopped) {
    orbitT += dt * 0.25;
    target = new THREE.Vector3(
      p.x + Math.cos(orbitT) * 18 * camZoom,
      p.y + 7 * camZoom,
      p.z + Math.sin(orbitT) * 18 * camZoom);
    look = p.clone();
  } else {
    const fx = Math.cos(m.rhd), fz = Math.sin(m.rhd);
    target = new THREE.Vector3(p.x - fx * 14 * camZoom, p.y + 6 * camZoom, p.z - fz * 14 * camZoom);
    look = new THREE.Vector3(p.x + fx * 10 * camZoom, p.y, p.z + fz * 10 * camZoom);
  }
  const k = 1 - Math.exp(-dt / 0.4);
  camPos.lerp(target, k);
  camLook.lerp(look, k);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
}

/* ============================================================
   Cycle jour/nuit — calé sur l'heure de Paris
   ============================================================ */
function updateSky() {
  if (!snap) return;
  const h = snap.hour ?? 12;
  const sun = scene.userData.sun, moon = scene.userData.moon;
  const hemi = scene.userData.hemi, stars = scene.userData.stars;

  const dayT = (h - 6) / 12;
  const elev = Math.sin(Math.max(0, Math.min(1, dayT)) * Math.PI);
  const az = (h / 24) * Math.PI * 2;
  const sunDir = new THREE.Vector3(Math.cos(az), Math.max(elev, 0.05), Math.sin(az));
  /* n°32 : soleil ET lune ancrés sur la voiture vue (ombres qui
     suivent la caméra), commutation des ombres jour/nuit (UNE SEULE
     lumière castShadow à la fois = une passe d'ombre par frame),
     teinte chaude à l'aube/crépuscule. */
  const sunTarget = scene.userData.sunTarget, moonTarget = scene.userData.moonTarget;
  const night = h >= 21 || h < 5;
  const fm = carMeshes.get(followId);
  const cx = fm?.rx ?? 0, cy = fm?.ry ?? 0, cz = fm?.rz ?? 0;
  sun.position.set(cx + sunDir.x * 400, cy + sunDir.y * 400, cz + sunDir.z * 400);
  sunTarget.position.set(cx, cy, cz);
  sun.intensity = night ? 0 : 0.25 + elev * 1.55;
  sun.castShadow = shadowsOn && !night;
  sun.color.setHex(elev < 0.35 && !night ? 0xffb066 : 0xfff3d6);
  const moonDir = new THREE.Vector3(-sunDir.x, Math.max(0.35, 1 - elev), -sunDir.z).normalize();
  moon.position.set(cx + moonDir.x * 400, cy + moonDir.y * 400, cz + moonDir.z * 400);
  moonTarget.position.set(cx, cy, cz);
  moon.intensity = night ? 0.4 : 0;
  moon.castShadow = shadowsOn && night;

  const car = followCar();
  /* n°33 : famille au point VOITURE par famAt direct (pos3.x = X
     monde, pos3.y = Z monde) — plus de recherche de point route. */
  const b = car ? famAt(car.pos3.x, car.pos3.y, snap?.seed ?? 42) : 0;
  const sky = new THREE.Color();
  /* brouillard PAR FAMILLE (jour clair) : plaine, désert air sec,
     forêt brume serrée, boréal, altitude, littoral — la nuit et la
     pluie gardent leurs contraintes */
  let [fogNear, fogFar] = FAM_FOG_RANGE[b] ?? [300, 2200];
  if (h >= 21 || h < 5) { sky.setHex(NIGHT); fogNear = 60; fogFar = 900; }
  else if (h < 8) sky.lerpColors(new THREE.Color(NIGHT), new THREE.Color(0xf2b98a), (h - 5) / 3);
  else if (h < 18) sky.setHex(0x87b5d8);
  else if (h < 20) sky.lerpColors(new THREE.Color(0xf2975a), new THREE.Color(NIGHT), (h - 18) / 2.5);
  else sky.setHex(NIGHT);

  const weather = (car?.weather ?? 'dry') === 'rain';
  if (weather) { fogNear = 40; fogFar = 600; sky.multiplyScalar(0.55); }
  fogFar = Math.min(fogFar, 2300);   /* n°32 : le fog couvre le bord L1 (2384 m) */
  scene.background = sky;
  scene.fog.color.copy(sky);
  scene.fog.near = fogNear;
  scene.fog.far = fogFar;

  stars.material.opacity = h >= 21 || h < 5 ? 0.9 : 0;
  const nightNow = h >= 20 || h < 7;
  /* SKYLINE : la même palette que le brouillard — silhouettes laiteuses
     le jour, discrètes la nuit (0.25) ; suit la caméra sans parallaxe */
  if (skyGroup) {
    skyGroup.position.set(camera.position.x, 0, camera.position.z);
    skyMat.color.copy(scene.fog.color).multiplyScalar(1.06);
    skyMat.opacity = nightNow ? 0.25 : 0.85;
  }
  /* VILLAGES : les points lumineux s'allument avec les POI */
  for (const g of villageLights) g.material.opacity = nightNow ? 0.9 : 0;
  hemi.intensity = nightNow ? 0.12 : 0.45;
  for (const m of carMeshes.values()) {
    m.headMat.emissive.setHex(nightNow ? 0xfff2b0 : 0x000000);
  }
  for (const l of poiLights) l.intensity = nightNow ? 2.2 : 0;
}

/* ============================================================
   Boucle rAF — animateCars (interpolation), caméra, ciel,
   qualité auto-dégradée sous 28 fps
   ============================================================ */
let lastT = performance.now();
let loopOn = false;
function loop() {
  if (!loopOn) return;
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  frames++;
  if (now - lastFpsT > 2000) {
    const fps = frames / ((now - lastFpsT) / 1000);
    frames = 0; lastFpsT = now;
    /* n°37 : HYSTÉRÉSIS — avant, un seul relevé < 28 fps montait
       d'un cran toutes les 2 s et les couches restaient cachées
       jusqu'au rebuild suivant (~83 s à 100 km/h) : villages
       visibles ~6 s par fenêtre — « aucun décor au loin ».
       Maintenant : 3 relevés consécutifs < 28 pour dégrader,
       2 relevés consécutifs > 40 pour restaurer, et les
       visibilités sont RÉAPPLIQUÉES à chaque relevé (plus jamais
       d'état fantôme après un rebuild). */
    if (fps < 28) {
      lowFpsN++; highFpsN = 0;
      if (lowFpsN >= 3) {
        if (quality > 0.6) {
          quality = 0.6;
          renderer.setPixelRatio(Math.min(devicePixelRatio, 1));
        }
        degraStage = Math.min(3, degraStage + 1);
      }
    } else if (fps > 40) {
      highFpsN++; lowFpsN = 0;
      if (highFpsN >= 2) degraStage = Math.max(0, degraStage - 1);
      if (fps > 50 && quality < 1) {
        quality = 1;
        renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.5 : 2));
      }
    } else { lowFpsN = 0; highFpsN = 0; }
    /* ordre de dégradation : 1. skyline, 2. reliefs, 3. villages —
       la bande L1 JAMAIS (c'est elle qui remplit le fond) */
    if (degraStage >= 1 && skyGroup) skyMat.opacity = 0;
    else if (skyGroup) skyMat.opacity = 0.85;
    if (degraStage >= 2) for (const m of decoRidges) m.visible = false;
    else for (const m of decoRidges) m.visible = true;
    if (degraStage >= 3) for (const m of villageGroups) m.visible = false;
    else for (const m of villageGroups) m.visible = true;
    if (hudEl) hudEl.textContent = `${Math.round(fps)} fps · dégra ${degraStage} · q ${quality.toFixed(1)}`;
  }
  animateCars(dt, now);
  updateCamera(dt);
  updateSky();
  updateEngineAudio();
  renderer.render(scene, camera);
}

/* ============================================================
   API exportée
   ============================================================ */
export async function init(container, { onReady } = {}) {
  initScene(container);
  loopOn = true;
  lastT = performance.now();
  lastFpsT = performance.now();
  loop();
  if (onReady) onReady();
}

export function setData(d) {
  /* n°42 : les constantes monde voyagent dans le snapshot — appliquées
     AVANT tout rendu. Jeu et spectateur passent ici (aucun autre fichier
     à changer). Idempotent, négligeable (~16 nombres par snapshot). */
  if (d?.world) setWorldParams(d.world);
  if (!d?.cars?.length) return;
  syncTargets(d);
}

export function setFollow(carId) {
  followId = carId;
  orbitT = 0;
  refreshWorld();
}

export function getFollow() { return followId; }

export async function refreshWorldNow() { return refreshWorld(); }

/* Télémétrie 30 Hz (debug admin) : anime braquage, roulis, tangage et
   feu stop SANS toucher à la position — le dead reckoning sur le poll
   1 s reste LA référence des positions. ⚠️ la télémétrie est en KM/H,
   m.tgt.v est en M/S (comme dans syncTargets) : division par 3,6
   OBLIGATOIRE, sans elle la voiture « téléporterait ». Les ids absents
   de la map ne sont pas touchés (défense). */
export function setTele(map) {
  for (const [id, t] of map) {
    const m = carMeshes.get(id);
    if (!m || !m.tgt || !t) continue;
    m.tgt.steer = t.steer ?? 0;
    m.tgt.v = (t.v ?? 0) / 3.6;
    m.group.rotation.x = t.pitch ?? 0;
    m.group.rotation.z = t.roll ?? 0;
    m.brakeMat.emissive.setHex(t.brk > 0 ? 0xff2222 : 0x000000);
  }
}

/* Nettoyage complet : une page, un cycle de vie WebGL. */
export function dispose() {
  loopOn = false;
  if (world) {
    scene.remove(world.group);
    world.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material?.dispose) o.material.dispose();
    });
    world = null;
  }
  /* le skyline vit HORS du groupe fenêtre → destruction explicite */
  if (skyGroup) {
    scene.remove(skyGroup);
    skyGroup.geometry.dispose();
    skyMat?.dispose();
    skyGroup = null; skyMat = null;
  }
  for (const m of carMeshes.values()) scene.remove(m.group);
  carMeshes.clear();
  /* audio : voix coupées + contexte fermé */
  for (const v of voices.values()) { try { v.osc.stop(); v.sub.stop(); } catch {} }
  voices.clear();
  ac?.close();
  ac = null; master = null;
  if (hudEl) { hudEl.remove(); hudEl = null; }
  renderer?.dispose();
}
