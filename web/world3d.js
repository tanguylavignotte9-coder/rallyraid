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
    decorRand = mulberry32(snap.seed ?? 42);
    buildRoad(group, d);
    buildTerrain(group, d);
    buildProps(group, d);
    buildPois(group, d.pois ?? []);
    scene.add(group);
    if (world) {
      scene.remove(world.group);
      world.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material?.dispose) o.material.dispose();
      });
    }
    world = { group, pts: d.pts, s0, step: STEP };
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
    const halfDirt = w + 1.6;
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

/* hauteur du terrain à distance latérale dist du point p (indice i).
   UNE formule pour le maillage ET les décors — sinon les arbres
   flottent ou s'enfoncent là où le terrain ondule. À j=0 le terrain
   affleure juste SOUS la chaussée (posée à p.z + 0,05) ; la rampe
   laisse le bruit prendre de l'amplitude en s'éloignant — plus de
   mur qui enterre le bas-côté ni de vide sous la route. */
function terrainY(p, i, dist) {
  const j = Math.max(0, (dist - (p.w + 2)) / STEP);
  const ramp = Math.min(1, j / 8);
  const noise = Math.sin(i * 0.31 + j * 0.17) * Math.cos(j * 0.09 + i * 0.13);
  return p.z - 0.3 - Math.max(0, j - 1) * 0.35 + noise * ramp * (4 + j * 1.4);
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
        const y = terrainY(p, i, dist) + decorRand() * 0.8;
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
      t: performance.now(),   /* la cible est un ÉCHANTILLON d'un mouvement
                                  continu, pas un point d'arrivée */
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

  const sky = new THREE.Color();
  let fogNear = 300, fogFar = 2200;
  if (h >= 21 || h < 5) { sky.setHex(NIGHT); sun.intensity = 0.05; fogNear = 60; fogFar = 900; }
  else if (h < 8) sky.lerpColors(new THREE.Color(NIGHT), new THREE.Color(0xf2b98a), (h - 5) / 3);
  else if (h < 18) sky.setHex(0x87b5d8);
  else if (h < 20) sky.lerpColors(new THREE.Color(0xf2975a), new THREE.Color(NIGHT), (h - 18) / 2.5);
  else sky.setHex(NIGHT);

  const car = followCar();
  const b = car ? (world?.pts?.find?.((p) => Math.abs(p.x - car.pos3.x) < 50)?.biome ?? 0) : 0;
  const weather = (car?.weather ?? 'dry') === 'rain';
  if (weather) { fogNear = 40; fogFar = 600; sky.multiplyScalar(0.55); }
  scene.background = sky;
  scene.fog.color.copy(sky).lerp(new THREE.Color(BIOME_FOG[b] ?? 0xcfe8f2), 0.4);
  scene.fog.near = fogNear;
  scene.fog.far = fogFar;

  stars.material.opacity = h >= 21 || h < 5 ? 0.9 : 0;
  const nightNow = h >= 20 || h < 7;
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
    } else if (fps > 50 && quality === 1) {
      renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.5 : 2));
    }
  }
  animateCars(dt, now);
  updateCamera(dt);
  updateSky();
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
  for (const m of carMeshes.values()) scene.remove(m.group);
  carMeshes.clear();
  renderer?.dispose();
}
