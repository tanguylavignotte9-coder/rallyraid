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
let world = null;                // {group, pts} fenêtre glissante
let winCenter = -1;
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
  const center = Math.max(0, car.km * 1000 - WIN * 0.35);
  /* CORRECTIF 3 : le garde ne s'applique qu'APRÈS une première
     construction. Sinon |0-(-1)| = 1 < 2500 → retour immédiat et le
     monde n'existait pas avant le km 2,5 (le « 0 décor » au départ). */
  if (world && Math.abs(center - winCenter) < 2500) return;
  winCenter = center;
  decorRand = mulberry32(snap.seed ?? 42);

  if (world) {
    scene.remove(world.group);
    world.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material?.dispose) o.material.dispose();
    });
    world = null;
  }

  const s0 = Math.max(0, center - WIN / 2);
  const r = await fetchTrack(s0, WIN, STEP);
  if (!r) return;
  const d = await r.json();
  if (!d.pts?.length) return;

  const group = new THREE.Group();
  poiLights = [];
  buildRoad(group, d);
  buildTerrain(group, d);
  buildProps(group, d);
  buildPois(group, d.pois ?? []);
  scene.add(group);
  world = { group, pts: d.pts };
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
  for (let i = 0; i + 1 < n; i++) {
    const a = i * 4, b = (i + 1) * 4;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
    idx.push(a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
    idx.push(a + 2, b + 2, a + 3, a + 3, b + 2, b + 3);
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
        const noise = Math.sin(i * 0.31 + j * 0.17) * Math.cos(j * 0.09 + i * 0.13);
        const y = p.z - Math.max(0, j - 1) * 0.35 + noise * (4 + j * 1.4) + decorRand() * 0.8;
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
    const y = p.z - dist * 0.06 + decorRand() * 2;
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
  const wm = new THREE.MeshLambertMaterial({ color: '#14171c' });
  for (const [x, z] of [[-0.95, 1.35], [0.95, 1.35], [-0.95, -1.35], [0.95, -1.35]]) {
    const w = new THREE.Mesh(wg, wm);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, 0.42, z);
    g.add(w);
    wheels.push(w);
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
  return { group: g, wheels, headMat, brakeMat, dust, tgt: null };
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
    /* cible en coordonnées monde : y = altitude z, z = y plan serveur */
    m.tgt = {
      x: c.pos3.x, y: c.pos3.z, z: c.pos3.y, hd: c.hd,
      v: (d.me?.id === c.id ? d.me.v : (c.v ?? 0)) / 3.6,
    };
    /* premier rendu : sauter sur la cible — pas de lerp depuis
       l'origine (0,0,0), la voiture serait « arrivée en volant » */
    if (m.rx === undefined) {
      m.rx = m.tgt.x; m.ry = m.tgt.y; m.rz = m.tgt.z; m.rhd = m.tgt.hd;
    }
    const meC = d.me?.id === c.id ? d.me : null;
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

/* Dead reckoning : avance extrapolée le long du cap + convergence
   douce (~0,7 s) vers la cible autoritaire du dernier poll. */
function animateCars(dt) {
  for (const m of carMeshes.values()) {
    if (!m.tgt) continue;
    m.v = m.tgt.v;
    m.rx += Math.cos(m.rhd) * m.v * dt;
    m.rz += Math.sin(m.rhd) * m.v * dt;
    const k = 1 - Math.exp(-dt / 0.7);
    m.rx += (m.tgt.x - m.rx) * k;
    m.ry += (m.tgt.y - m.ry) * k;
    m.rz += (m.tgt.z - m.rz) * k;
    let dh = m.tgt.hd - m.rhd;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    m.rhd += dh * k;
    m.group.position.set(m.rx, m.ry, m.rz);
    /* CORRECTIF 1 : l'avant du maillage est sur +Z local ;
       rotation.y = PI/2 - hd aligne l'avant sur (cos hd, 0, sin hd). */
    m.group.rotation.y = Math.PI / 2 - m.rhd;
    for (const w of m.wheels) w.rotation.y += (m.v / 0.42) * dt;
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
  animateCars(dt);
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
