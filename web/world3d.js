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
import { H } from './terrain.js';

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
let decorRand = mulberry32(42);

/* ---- palettes tendres par biome ---- */
const BIOME_GROUND = ['#8fbf6a', '#2e5d34', '#e0b089', '#8a9099'];
const BIOME_FOG = [0xcfe8f2, 0x9fb8c8, 0xf0e0c8, 0xcdd6de];
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
let poiLights = [];
/* ---- décor : état des couches L1/L2, eau, skyline ---- */
let winS0 = 0;                 // abscisse du 1er point de la fenêtre (hash stable)
let skyGroup = null, skyMat = null;
let waterMat = null;            // matériau d'eau PARTAGÉ rivières + lacs
let villageLights = [];         // Points lumineux des villages (nuit)
let decoRidges = [];            // dégradation fps : reliefs
let villageGroups = [];         // dégradation fps : villages lointains
let degraStage = 0;             // 0 rien, 1 skyline, 2 reliefs, 3 villages

/* HASH PUR de position : stable au rebuild de la fenêtre (decorRand,
   lui, est RESEMÉ à chaque reconstruction — tout REPÈRE (village, lac,
   relief, ravin) passe par ici, jamais par decorRand). */
function posHash(a, b) {
  const x = Math.sin(a * 127.1 + b * 311.7 + (snap?.seed ?? 42) * 0.618) * 43758.5453;
  return x - Math.floor(x);
}


/* rampe de terrain : le bruit prend de l'amplitude en s'éloignant */
function terrainRamp(j) { return Math.min(1, j / 12); }

/* brouillard par biome : plaine, forêt (brume serrée), désert (air sec),
   altitude */
const BIOME_FOG_RANGE = [[300, 2400], [120, 1400], [200, 3000], [150, 1800]];

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
    const f = Math.max(30, rpm / 60 * 4);       // 4 explosions/tour
    v.osc.frequency.setTargetAtTime(f, ac.currentTime, 0.06);
    v.sub.frequency.setTargetAtTime(f / 2, ac.currentTime, 0.06);
    const att = 1 / (1 + (dist / 140) ** 2);    // distance²
    const g = muted ? 0 : (0.05 + 0.4 * thr) * att;
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
    sun.shadow.camera.left = -80; sun.shadow.camera.right = 80;
    sun.shadow.camera.top = 80; sun.shadow.camera.bottom = -80;
    sun.shadow.camera.far = 600;
  }
  scene.add(sun);
  scene.userData.sun = sun;
  scene.userData.hemi = hemi;

  const moon = new THREE.DirectionalLight(0x8ea6cc, 0.15);
  scene.add(moon);
  scene.userData.moon = moon;

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
    decorRand = mulberry32(snap.seed ?? 42);
    winS0 = s0;
    buildRoad(group, d);
    buildTerrain(group, d);
    buildMidFar(group, d);
    buildRidges(group, d);
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
    /* jupe terre qui RECOUVRE la 1re rangée du terrain (w + 2) :
       recouvrement de 0,5 m — plus jamais de fissure visible */
    const halfDirt = w + 2.5;
    pos.push(p.x + nx * -halfDirt, p.z + 0.02, p.y + nz * -halfDirt);
    col.push(dirtCol.r, dirtCol.g, dirtCol.b);
    pos.push(p.x + nx * -halfRoad, p.z + 0.05, p.y + nz * -halfRoad);
    col.push(roadCol.r, roadCol.g, roadCol.b);
    pos.push(p.x + nx * halfRoad, p.z + 0.05, p.y + nz * halfRoad);
    col.push(roadCol.r, roadCol.g, roadCol.b);
    pos.push(p.x + nx * halfDirt, p.z + 0.02, p.y + nz * halfDirt);
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
const T_BLEND = 45;                    // m : raccord latéral accotement -> H
const T_GAP_ON = 15, T_GAP_FULL = 35; // m : ouverture du talus selon |gap|
function terrainY(p, i, dist) {
  const seed = snap?.seed ?? 42;
  const nx = -Math.sin(p.hd), nz = Math.cos(p.hd);
  const x = p.x + nx * dist, z = p.y + nz * dist;
  const hT = H(x, z, seed);
  const gap = p.z - H(p.x, p.y, seed);
  const wGap = Math.max(0, Math.min(1, (Math.abs(gap) - T_GAP_ON) / (T_GAP_FULL - T_GAP_ON)));
  const wDist = Math.max(0, Math.min(1, (dist - (p.w + 2)) / T_BLEND));
  return p.z - 0.05 + (hT - (p.z - 0.05)) * Math.min(1, wDist + wGap);
}
/* terrain à une position monde QUELCONQUE (maisons, clochers, lumières
   de village) — sans le poids latéral ; même fondu d'écart. */
function terrainAtXY(p, x, z) {
  const seed = snap?.seed ?? 42;
  const hT = H(x, z, seed);
  const gap = p.z - H(p.x, p.y, seed);
  const wGap = Math.max(0, Math.min(1, (Math.abs(gap) - T_GAP_ON) / (T_GAP_FULL - T_GAP_ON)));
  return p.z - 0.05 + (hT - (p.z - 0.05)) * wGap;
}

/* ---- terrain : manteau low-poly ~400 m de chaque côté ---- */
function buildTerrain(group, d) {
  const pts = d.pts;
  const n = pts.length;
  const BAND = 400 / STEP;
  const pos = [], col = [], idx = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const nx = -Math.sin(p.hd), nz = Math.cos(p.hd);
    const base = new THREE.Color(BIOME_GROUND[p.biome] ?? '#7a8a5a');
    for (let side = -1; side <= 1; side += 2) {
      for (let j = 0; j <= BAND; j++) {
        const dist = p.w + 2 + j * STEP;
        const x = p.x + nx * side * dist;
        const zz = p.y + nz * side * dist;
        const y = terrainY(p, i, dist) + decorRand() * 0.8 * terrainRamp(j);
        pos.push(x, y, zz);
        const c2 = base.clone();
        if (y > SNOW_ALT) c2.lerp(new THREE.Color('#eef2f5'), Math.min(1, (y - SNOW_ALT) / 80));
        c2.offsetHSL(0, 0, (decorRand() - 0.5) * 0.03);
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
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.receiveShadow = shadowsOn;
  group.add(mesh);
}

/* ============================================================
   n°22 — BANDE MI-LOINTAINE L1 (400 m → 1,8 km)
   1 point route sur 4 (64 m) ; anneaux latéraux à d_k = 400·1.22^k ;
   l'anneau 0 = terrainY(p, i, 400) EXACT → couture parfaite avec la
   rangée externe du L0 (même formule). Ondulation macro par biome.
   ============================================================ */
function buildMidFar(group, d) {
  const pts = d.pts;
  const seed = snap?.seed ?? 42;
  const pos = [], col = [], idx = [];
  const RINGS = [];
  for (let k = 0; ; k++) {
    const dd = 400 * Math.pow(1.22, k);
    if (dd > 1800) break;
    RINGS.push(dd);
  }
  if (!RINGS.length) return;
  const SAMPL = 4;                       // 1 point sur 4 (64 m)
  let vcount = 0;
  const cellSide = 220 / (STEP * SAMPL); // parcelle agricole ~220 m
  const PATCH = ['#9cc76a', '#b8bf5e', '#cbb06a', '#6da04f'].map((c) => new THREE.Color(c));
  const HEDGE = new THREE.Color('#3f5a35');
  const biomeCol = new THREE.Color();
  const snow = new THREE.Color('#eef2f5');
  const push = (x, y, z, c) => { pos.push(x, y, z); col.push(c.r, c.g, c.b); };
  for (let side = -1; side <= 1; side += 2) {
    const baseIdx = vcount;
    for (let i = 0; i < pts.length; i += SAMPL) {
      const p = pts[i];
      const nx = -Math.sin(p.hd), nz = Math.cos(p.hd);
      for (let k = 0; k < RINGS.length; k++) {
        const dist = RINGS[k];
        const x = p.x + nx * side * dist;
        const zz = p.y + nz * side * dist;
        const y = terrainY(p, i, dist);
        let c;
        if (p.biome === 0) {
          /* PATCHWORK AGRICOLE : parcelles ~220 m, haies aux frontières */
          const cell = Math.floor((i / SAMPL) / cellSide);
          const inCell = ((i / SAMPL) / cellSide) - cell;
          const edge = inCell < 0.04 || inCell > 0.96;
          if (edge) c = HEDGE;
          else {
            const h4 = posHash(cell + 1000 * side, 5);
            c = PATCH[Math.floor(h4 * 4) % 4];
          }
        } else {
          biomeCol.set(BIOME_GROUND[p.biome] ?? '#7a8a5a');
          if (p.biome === 1) biomeCol.offsetHSL(0, 0, (posHash(i, k) - 0.5) * 0.04);
          if (p.biome === 2) biomeCol.offsetHSL(0, 0, (posHash(i, k + 50) - 0.5) * 0.05);
          if (y > SNOW_ALT) biomeCol.lerp(snow, Math.min(1, (y - SNOW_ALT) / 80));
          c = biomeCol;
        }
        push(x, y, zz, c);
        vcount++;
      }
    }
    /* index : quads entre rangées successives (et L0 raccordé par
       l'anneau 0 qui RECOPIE la formule du bord externe du L0) */
    const colsN = RINGS.length;
    const rows = Math.floor(pts.length / SAMPL);
    for (let r = 0; r + 1 < rows; r++) {
      const a = baseIdx + r * colsN, b = a + colsN;
      for (let k = 0; k + 1 < colsN; k++) {
        if (side === -1) idx.push(a + k, b + k, a + k + 1, a + k + 1, b + k, b + k + 1);
        else idx.push(a + k, a + k + 1, b + k, a + k + 1, b + k + 1, b + k);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
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
  const nMass = 3 + Math.floor(posHash(Math.floor(winS0 / 1000), 11) * 6);
  decoRidges = [];
  for (let m = 0; m < nMass; m++) {
    const h1 = posHash(Math.floor(winS0 / 1000), 21 + m);
    const h2 = posHash(Math.floor(winS0 / 1000) + m, 23);
    const h3 = posHash(m, Math.floor(winS0 / 1000));
    const sIdx = Math.floor(h1 * pts.length);
    const p = pts[Math.min(pts.length - 1, sIdx)];
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
    const baseY = hMin - 5;
    const snow = new THREE.Color('#eef2f5');
    const c = new THREE.Color(BIOME_GROUND[p.biome] ?? '#7a8a5a');
    c.multiplyScalar(0.55);   // teinte ASSOMBRIE : lisibilité en silhouette
    if (p.biome === 3 && baseY + ridgeH > SNOW_ALT) c.lerp(snow, Math.min(1, (baseY + ridgeH - SNOW_ALT) / 120));
    const cols = [];
    for (let t = 0; t <= TEETH; t++) {
      const u = t / TEETH;
      const bx = cx + dirX * (u - 0.5) * W * 2;
      const bz = cz + dirZ * (u - 0.5) * W * 2;
      pos.push(bx, baseY, bz); cols.push(c.r, c.g, c.b);
      const peakH = baseY + ridgeH * (0.6 + 0.4 * posHash(m * 10 + t, 31));
      if (p.biome === 2) {
        /* MESA tabulaire : plateau plat + flancs raides */
        const topH = baseY + ridgeH * 0.85;
        pos.push(bx + dirX * 8, topH, bz + dirZ * 8); cols.push(c.r, c.g, c.b);
        pos.push(bx - dirX * 8, topH, bz - dirZ * 8); cols.push(c.r, c.g, c.b);
      } else {
        pos.push(bx, peakH, bz); cols.push(c.r, c.g, c.b);
      }
      vi += p.biome === 2 ? 3 : 2;
    }
    const step = p.biome === 2 ? 3 : 2;
    for (let t = 0; t < TEETH; t++) {
      const a = t * step, b = (t + 1) * step;
      if (p.biome === 2) {
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

/* ============================================================
   n°22 — VILLAGES (plaine) + FERMES ISOLÉES
   REPÈRES placés par HASH PUR de cellule (500 m d'arc) : reconstruits
   À L'IDENTIQUE au rebuild de la fenêtre. Chaque maison est posée à
   SA position H (n°26), filtrée par praticabilité de pente.
   ============================================================ */
function buildVillages(group, d) {
  const pts = d.pts;
  const seed = snap?.seed ?? 42;
  const VILL_P = [0.022, 0.012, 0.006, 0.008];
  const FARM_P = [0.008, 0.004, 0.002, 0.003];
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
  for (let cell = Math.floor(winS0 / 500); cell <= Math.floor((winS0 + pts.length * STEP) / 500); cell++) {
    /* position route du centre de cellule */
    const sCell = cell * 500 - winS0;
    const i = Math.round(sCell / STEP);
    if (i < 2 || i >= pts.length - 2) continue;
    const p = pts[i];
    const b = p.biome;
    const isVillage = posHash(cell, 7) < VILL_P[b];
    const isFarm = !isVillage && posHash(cell, 9) < FARM_P[b];
    if (!isVillage && !isFarm) continue;
    const side = posHash(cell, 8) < 0.5 ? -1 : 1;
    const dist = isVillage ? 350 + posHash(cell, 10) * 850 : 250 + posHash(cell, 10) * 300;
    const nx = -Math.sin(p.hd), nz = Math.cos(p.hd);
    const cx = p.x + nx * side * dist, cz = p.y + nz * side * dist;
    let hMin = Infinity, hMax = -Infinity;
    for (let a = -50; a <= 50; a += 25)
      for (let b2 = -50; b2 <= 50; b2 += 25) {
        const v = H(cx + a, cz + b2, seed);
        if (v < hMin) hMin = v;
        if (v > hMax) hMax = v;
      }
    if ((hMax - hMin) / 100 > 0.12) continue;   // terrain non praticable
    const l1y = terrainAtXY(p, cx, cz);
    const nHouse = isVillage ? 6 + Math.floor(posHash(cell, 12) * 13) : 2;
    const radius = isVillage ? 40 + posHash(cell, 13) * 80 : 12;
    for (let h = 0; h < nHouse; h++) {
      const ang = (h / nHouse) * Math.PI * 2 + posHash(cell * 10 + h, 14) * 0.5;
      const rr = radius * (0.55 + posHash(cell * 10 + h, 15) * 0.7);
      const hx = cx + Math.cos(ang) * rr, hz = cz + Math.sin(ang) * rr;
      const rot = p.hd + (posHash(cell * 10 + h, 16) - 0.5) * 0.9;
      pushHouse(hx, terrainAtXY(p, hx, hz), hz, rot);
    }
    /* clocher sur ~1 village sur 2 */
    if (isVillage && posHash(cell, 17) < 0.5) churches.push([cx, terrainAtXY(p, cx, cz), cz, p.hd]);
    /* NUIT : points lumineux chauds — allumés avec les POI */
    if (isVillage) {
      const nL = 4 + Math.floor(posHash(cell, 18) * 6);
      for (let l = 0; l < nL; l++) {
        const ang = posHash(cell * 10 + l, 19) * Math.PI * 2;
        const rr = radius * posHash(cell * 10 + l, 20);
        const g = new THREE.Points(
          new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(cx + Math.cos(ang) * rr, terrainAtXY(p, cx + Math.cos(ang) * rr, cz + Math.sin(ang) * rr) + 3, cz + Math.sin(ang) * rr)]),
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

function buildWater(group, d) {
  const pts = d.pts;
  const seed = snap?.seed ?? 42;
  const water = getWaterMat();
  /* RIVIÈRES : ruban au fond du ravin sur chaque run seg=1 (± 120 m) */
  let i = 0;
  while (i < pts.length) {
    if (pts[i].seg === 1) {
      const runStart = Math.max(0, i - Math.round(120 / STEP));
      while (i < pts.length && pts[i].seg === 1) i++;
      const runEnd = Math.min(pts.length - 1, i + Math.round(120 / STEP));
      const width = 10 + posHash(Math.floor((winS0 + runStart * STEP) / 100), 3) * 14;
      const phase = posHash(Math.floor((winS0 + runStart * STEP) / 100), 4) * Math.PI * 2;
      const amp = 15 + posHash(Math.floor((winS0 + runStart * STEP) / 100), 5) * 25;
      const pos = [], idx = [];
      let vi = 0;
      let deepEnough = false;
      for (let q = runStart; q <= runEnd; q++) {
        const p = pts[q];
        const nx = -Math.sin(p.hd), nz = Math.cos(p.hd);
        const meander = Math.sin((q - runStart) * 0.08 + phase) * amp;
        /* fond de vallée RÉEL : min de H sur la traversée latérale */
        let hb = Infinity;
        for (let dd = -150; dd <= 150; dd += 25)
          hb = Math.min(hb, H(p.x + nx * dd, p.y + nz * dd, seed));
        if (p.z - hb >= 8) deepEnough = true;
        const y = hb + 2;
        pos.push(p.x + nx * (meander - width / 2), y, p.y + nz * (meander - width / 2));
        pos.push(p.x + nx * (meander + width / 2), y, p.y + nz * (meander + width / 2));
        if (q < runEnd) { idx.push(vi, vi + 1, vi + 2, vi + 1, vi + 3, vi + 2); }
        vi += 2;
      }
      if (deepEnough) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        group.add(new THREE.Mesh(geo, water));
      }
    } else i++;
  }
  /* LACS : cellules de 2 000 m, plaine/forêt — vrais minima locaux
     de H (n°26), disque d'eau posé dans la cuvette réelle */
  for (let cell = Math.floor(winS0 / 2000); cell <= Math.floor((winS0 + pts.length * STEP) / 2000); cell++) {
    if (posHash(cell, 13) >= 0.045) continue;
    const sCell = cell * 2000 - winS0;
    const i = Math.round(sCell / STEP);
    if (i < 2 || i >= pts.length - 2) continue;
    const p = pts[i];
    if (p.biome !== 0 && p.biome !== 1) continue;
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
  const treeGeo = new THREE.ConeGeometry(2.2, 6, 6);
  const treeMat = new THREE.MeshLambertMaterial({ color: '#2e7d32' });
  const pineGeo = new THREE.ConeGeometry(1.8, 9, 5);
  const pineMat = new THREE.MeshLambertMaterial({ color: '#1b5e20' });
  const rockGeo = new THREE.DodecahedronGeometry(1.6, 0);
  const rockMat = new THREE.MeshLambertMaterial({ color: '#9e958a' });
  const bushGeo = new THREE.SphereGeometry(1.1, 5, 4);
  const bushMat = new THREE.MeshLambertMaterial({ color: '#7a7a3a' });

  const items = { tree: [], pine: [], rock: [], bush: [] };
  for (let i = 2; i < pts.length - 2; i += 2) {
    const p = pts[i];
    const nx = -Math.sin(p.hd), nz = Math.cos(p.hd);
    const r1 = decorRand(), r2 = decorRand(), r3 = decorRand();
    const side = r2 < 0.5 ? -1 : 1;
    const dist = p.w + 4 + r3 * 90;
    const x = p.x + nx * side * dist;
    const zz = p.y + nz * side * dist;
    const y = terrainY(p, i, dist) + decorRand() * 2;
    const forestWave = Math.sin(i * 0.15) > -0.3;
    if (p.biome === 0 && r1 < 0.22) items.tree.push([x, y, zz, 0.7 + r3 * 0.6]);
    else if (p.biome === 1 && r1 < (forestWave ? 0.85 : 0.1)) items.pine.push([x, y, zz, 0.8 + r3 * 0.7]);
    else if (p.biome === 2 && r1 < 0.18) items.bush.push([x, y, zz, 0.6 + r3]);
    else if (p.biome === 3 && r1 < 0.25) items.rock.push([x, y, zz, 0.7 + r3]);
    if (p.biome === 3 && y > SNOW_ALT && r1 > 0.9) items.rock.push([x, y, zz, 0.5 + r3]);
    if (p.biome === 2 && r1 > 0.9) items.rock.push([x, y, zz, 0.8 + r3]);
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
  const dustGeo = new THREE.SphereGeometry(0.5, 4, 3);
  const dustMat = new THREE.MeshBasicMaterial({ color: 0xb9a889, transparent: true, opacity: 0 });
  const dust = new THREE.Mesh(dustGeo, dustMat);
  dust.position.set(0, 0.4, -2.6);
  dust.scale.set(2.5, 1.2, 2.5);
  g.add(dust);
  scene.add(g);
  return { group: g, wheels, frontWheels: wheels.slice(0, 2), headMat, brakeMat, dust, tgt: null };
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
    m.dust.material.opacity = m.tgt.v > 8 ? (biome === 2 ? 0.5 : 0.2) : 0;
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
      p.x + Math.cos(orbitT) * 18,
      p.y + 7,
      p.z + Math.sin(orbitT) * 18);
    look = p.clone();
  } else {
    const fx = Math.cos(m.rhd), fz = Math.sin(m.rhd);
    target = new THREE.Vector3(p.x - fx * 14, p.y + 6, p.z - fz * 14);
    look = new THREE.Vector3(p.x + fx * 10, p.y, p.z + fz * 10);
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
  sun.position.copy(sunDir).multiplyScalar(400);
  sun.intensity = 0.2 + elev * 1.5;
  moon.position.set(-sunDir.x, Math.max(0.3, 1 - elev), -sunDir.z).multiplyScalar(400);

  const car = followCar();
  const b = car ? (world?.pts?.find?.((p) => Math.abs(p.x - car.pos3.x) < 50)?.biome ?? 0) : 0;
  const sky = new THREE.Color();
  /* brouillard PAR BIOME (jour clair) : plaine, forêt serrée, désert
     air sec, altitude — la nuit et la pluie gardent leurs contraintes */
  let [fogNear, fogFar] = BIOME_FOG_RANGE[b] ?? [300, 2200];
  if (h >= 21 || h < 5) { sky.setHex(NIGHT); sun.intensity = 0.05; fogNear = 60; fogFar = 900; }
  else if (h < 8) sky.lerpColors(new THREE.Color(NIGHT), new THREE.Color(0xf2b98a), (h - 5) / 3);
  else if (h < 18) sky.setHex(0x87b5d8);
  else if (h < 20) sky.lerpColors(new THREE.Color(0xf2975a), new THREE.Color(NIGHT), (h - 18) / 2.5);
  else sky.setHex(NIGHT);

  const weather = (car?.weather ?? 'dry') === 'rain';
  if (weather) { fogNear = 40; fogFar = 600; sky.multiplyScalar(0.55); }
  scene.background = sky;
  scene.fog.color.copy(sky).lerp(new THREE.Color(BIOME_FOG[b] ?? 0xcfe8f2), 0.4);
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
  hemi.intensity = nightNow ? 0.18 : 0.9;
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
    if (fps < 28 && quality > 0.6) {
      quality = 0.6;
      renderer.setPixelRatio(Math.min(devicePixelRatio, 1));
      /* ordre de dégradation : 1. skyline, 2. reliefs, 3. villages —
         la bande L1 JAMAIS (c'est elle qui remplit le fond) */
      degraStage = Math.min(3, degraStage + 1);
      if (degraStage >= 1 && skyGroup) skyMat.opacity = 0;
      if (degraStage >= 2) for (const m of decoRidges) m.visible = false;
      if (degraStage >= 3) for (const m of villageGroups) m.visible = false;
    } else if (fps < 28 && quality <= 0.6) {
      degraStage = Math.min(3, degraStage + 1);
      if (degraStage >= 1 && skyGroup) skyMat.opacity = 0;
      if (degraStage >= 2) for (const m of decoRidges) m.visible = false;
      if (degraStage >= 3) for (const m of villageGroups) m.visible = false;
    } else if (fps > 50 && quality === 1) {
      renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.5 : 2));
    }
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
  renderer?.dispose();
}
