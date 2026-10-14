/* ============================================================
   VUE 3D SPECTATEUR — three.js par CDN (zéro build, zéro dépendance serveur)
   ============================================================
   Design arrêté : chase cam sur la voiture sélectionnée (lissage
   ~0,4 s ; orbite lente quand la voiture est arrêtée), monde riche
   par biome (terrain + végétation InstancedMesh), cycle jour/nuit
   complet calé sur l'heure de Paris réelle (nuit sombre, aubes et
   crépuscules soignés), ambiance low-poly stylisée, palette tendre
   par biome. POI éclairés la nuit — des balises de vie dans le noir.
   Perf : fenêtre glissante ~8 km, pixelRatio adaptatif, qualité
   auto-dégradée sous 28 fps (objectif 30 fps sur mobile moyen). */

import * as THREE from 'three';

const $ = (id) => document.getElementById(id);

/* ---- PRNG local : copie du mulberry32 du cœur, semée par la graine
   de course (donnée du snapshot) — le décor client est déterministe
   et IDENTIQUE pour tous les spectateurs (ADR 0004 d'esprit). ---- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let decorRand = mulberry32(42);

/* ---- palettes tendres par biome (design prompt C) ---- */
const BIOME_GROUND = ['#8fbf6a', '#2e5d34', '#e0b089', '#8a9099'];
const BIOME_FOG = [0xcfe8f2, 0x9fb8c8, 0xf0e0c8, 0xcdd6de];   // brume bleutée forêt, air sec désert, nuage bas altitude
const SNOW_ALT = 300;                                          // seuil de neige (m)
const NIGHT = 0x0a0e1a;

/* ---- état ---- */
let snap = null;
let followId = null;
let renderer, scene, camera;
let isMobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
let shadowsOn = !isMobile;
let quality = 1;               // 1 = nominal, 0.7 = dégradé
let carMeshes = new Map();      // id -> {group, wheels, nameSprite, brakeMat, headMat, dust}
let world = null;               // {road, terrain, props, pois} fenêtre glissante
let winCenter = -1;
let lastFpsT = performance.now(), frames = 0;

/* ============================================================
   API — même session que le reste du jeu (401 → login)
   ============================================================ */
async function api(path) {
  const r = await fetch(path);
  if (r.status === 401) { location.href = '/login.html'; return null; }
  return r;
}

async function poll() {
  try {
    const r = await api('/api/state');
    if (!r) return;
    const d = await r.json();
    if (!d.cars?.length) return;
    if (followId === null || !d.cars.some((c) => c.id === followId)) {
      followId = d.me?.id ?? d.cars[0].id;
    }
    const prev = snap;
    snap = d;
    $('clock').textContent = d.clock;
    renderCarList();
    syncCars();
    /* bandeau d'événements en direct (même flux que le stratège) */
    const mine = d.me?.events ?? [];
    if (prev && mine.length) {
      const old = prev.me?.events ?? [];
      for (const e of mine.slice(-4)) {
        if (!old.some((o) => o.t === e.t && o.msg === e.msg)) flash(e.msg);
      }
    }
  } catch { /* silence — le prochain tick réessaie */ }
}

function flash(msg) {
  const b = document.createElement('div');
  b.className = 'flash';
  b.textContent = msg;
  $('flash').prepend(b);
  setTimeout(() => b.remove(), 8000);
  while ($('flash').children.length > 4) $('flash').lastChild.remove();
}

/* ============================================================
   three.js — scène, lumières, ciel
   ============================================================ */
function initScene() {
  renderer = new THREE.WebGLRenderer({ antialias: !isMobile, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.5 : 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = shadowsOn;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  $('scene').appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87b5d8);
  scene.fog = new THREE.Fog(0x87b5d8, 300, 2200);

  camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.5, 5000);

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

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}

/* ============================================================
   MONDE — fenêtre glissante ~8 km autour de la voiture suivie
   ============================================================ */
const WIN = 8000;               // m, fenêtre de rendu
const STEP = 16;                // m entre points de maillage

async function refreshWorld() {
  const car = snap.cars.find((c) => c.id === followId);
  if (!car) return;
  const center = car.km * 1000;
  if (Math.abs(center - winCenter) < 2500) return;  // glisse par tranches
  winCenter = center;
  decorRand = mulberry32(snap.seed ?? 42);

  if (world) {
    scene.remove(world.group);
    world.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material?.dispose) o.material.dispose();
    });
  }

  const s0 = Math.max(0, center - WIN / 2);
  const r = await api(`/api/track?s0=${Math.round(s0)}&len=${WIN}&step=${STEP}`);
  if (!r) return;
  const d = await r.json();
  if (!d.pts?.length) return;

  const group = new THREE.Group();
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
    /* accotement terre (bords), chaussée au centre — 6 sommets */
    const w = p.w;
    const halfRoad = w;
    const halfDirt = w + 1.6;
    // premier bord accotement
    pos.push(p.x + nx * -halfDirt, p.z + 0.02, p.y + nz * -halfDirt);
    col.push(dirtCol.r, dirtCol.g, dirtCol.b);
    // bord chaussée gauche
    pos.push(p.x + nx * -halfRoad, p.z + 0.05, p.y + nz * -halfRoad);
    col.push(roadCol.r, roadCol.g, roadCol.b);
    // bord chaussée droite
    pos.push(p.x + nx * halfRoad, p.z + 0.05, p.y + nz * halfRoad);
    col.push(roadCol.r, roadCol.g, roadCol.b);
    // second bord accotement
    pos.push(p.x + nx * halfDirt, p.z + 0.02, p.y + nz * halfDirt);
    col.push(dirtCol.r, dirtCol.g, dirtCol.b);
  }
  /* 4 sommets par point → 3 quads → 6 triangles */
  for (let i = 0; i + 1 < n; i++) {
    const a = i * 4, b = (i + 1) * 4;
    idx.push(a, b, a + 1, a + 1, b, b + 1);          // accotement gauche
    idx.push(a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);  // chaussée
    idx.push(a + 2, b + 2, a + 3, a + 3, b + 2, b + 3);  // accotement droit
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
  buildSegments(group, pts, 1, (p, nx, nz) => {
    const arch = new THREE.Mesh(
      new THREE.BoxGeometry(p.w * 2.4, 1.2, STEP * 1.1),
      new THREE.MeshLambertMaterial({ color: '#9a8f80' }));
    arch.position.set(p.x, p.z - 3.2, p.y);
    arch.rotation.y = -p.hd;
    arch.castShadow = shadowsOn;
    return arch;
  });

  /* ---- TUNNELS (seg=2) : voûte sombre au-dessus de la route ---- */
  buildSegments(group, pts, 2, (p, nx, nz) => {
    const vault = new THREE.Mesh(
      new THREE.BoxGeometry(p.w * 2.6, 0.8, STEP * 1.1),
      new THREE.MeshLambertMaterial({ color: '#4a4440' }));
    vault.position.set(p.x, p.z + 4.5, p.y);
    vault.rotation.y = -p.hd;
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
          wall.rotation.y = -p.hd;
          group.add(wall);
        }
      }
    }
    prev = p;
  }
}

/* ---- terrain : manteau low-poly ~400 m de chaque côté, altitude
   réelle + bruit déterministe local (semé graine de course) ---- */
function buildTerrain(group, d) {
  const pts = d.pts;
  const n = pts.length;
  const BAND = 400 / STEP;      // ~25 rangées de chaque côté
  const pos = [], col = [], idx = [];
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const nx = -Math.sin(p.hd), nz = Math.cos(p.hd);
    const base = new THREE.Color(BIOME_GROUND[p.biome] ?? '#7a8a5a');
    for (let side = -1; side <= 1; side += 2) {
      for (let j = 0; j <= BAND; j++) {
        const dist = p.w + 2 + j * STEP;
        const x = p.x + nx * side * dist;
        const zz = p.y + nz * side * dist;
        /* bruit doux : collines tendres, semées — même monde pour tous */
        const noise = Math.sin(i * 0.31 + j * 0.17) * Math.cos(j * 0.09 + i * 0.13);
        const y = p.z - Math.max(0, j - 1) * 0.35 + noise * (4 + j * 1.4) + decorRand() * 0.8;
        pos.push(x, y, zz);
        const c2 = base.clone();
        /* neige au-dessus du seuil (altitude) */
        if (y > SNOW_ALT) c2.lerp(new THREE.Color('#eef2f5'), Math.min(1, (y - SNOW_ALT) / 80));
        c2.offsetHSL(0, 0, (decorRand() - 0.5) * 0.03);
        col.push(c2.r, c2.g, c2.b);
      }
    }
  }
  /* index : chaque point a 2*(BAND+1) sommets (gauche puis droite) */
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

/* ---- végétation par biome : InstancedMesh, densité modeste ---- */
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
    /* ryhtme par biome : la forêt RESPIRE (murs d'arbres puis clairières) */
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

/* ---- POI : station/hôtel/garage low-poly + ÉCLAIRS la nuit ---- */
function buildPois(group, pois) {
  for (const poi of pois) {
    const g = new THREE.Group();
    if (poi.kind === 'station') {
      g.add(box(6, 3, 4, '#cfd6dd', 0, 1.5, 0));
      g.add(box(7, 0.3, 5, '#e63946', 0, 3.4, 0));       // auvent
      g.add(box(0.8, 1.2, 0.8, '#d64545', 2.5, 0.6, 1.5)); // pompe
      g.add(box(0.8, 1.2, 0.8, '#d64545', 4, 0.6, 1.5));
    } else if (poi.kind === 'hotel') {
      g.add(box(9, 5, 6, '#d9c9a3', 0, 2.5, 0));
      g.add(box(2, 1, 2, '#ffd166', 0, 5.8, 0));         // enseigne
    } else {
      g.add(box(8, 3.4, 6, '#8d99ae', 0, 1.7, 0));
      g.add(box(3, 2.2, 0.3, '#6c757d', 0, 4.4, 0));
    }
    g.position.set(poi.x, poi.z, poi.y);
    /* halo de vie : lumière ponctuelle, allumée la nuit (cycle) */
    const light = new THREE.PointLight(0xffd9a0, 0, 60, 2);
    light.position.set(poi.x, poi.z + 6, poi.y);
    group.add(light);
    group.userData.poiLights = group.userData.poiLights ?? [];
    group.userData.poiLights.push(light);
    poiLights.push(light);
    group.add(g);
  }
}
let poiLights = [];
function box(w, h, dp, color, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, dp), new THREE.MeshLambertMaterial({ color }));
  m.position.set(x, y, z);
  m.castShadow = shadowsOn;
  return m;
}

/* ============================================================
   VOITURES — low-poly maison, roues, phares, nom, poussière
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
  /* phares émissifs (allumés la nuit — spotlights si perf OK) */
  const headMat = new THREE.MeshLambertMaterial({ color: '#fff7d0', emissive: 0x000000 });
  for (const x of [-0.6, 0.6]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.2, 0.1), headMat);
    h.position.set(x, 0.85, 2.1);
    g.add(h);
  }
  /* feu stop (rouge si brake=1) */
  const brakeMat = new THREE.MeshLambertMaterial({ color: '#5a1520', emissive: 0x000000 });
  const stop = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.15, 0.08), brakeMat);
  stop.position.set(0, 0.85, -2.12);
  g.add(stop);
  /* nom en sprite au-dessus */
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
  /* poussière légère derrière (plus dense au désert) */
  const dustGeo = new THREE.SphereGeometry(0.5, 4, 3);
  const dustMat = new THREE.MeshBasicMaterial({ color: 0xb9a889, transparent: true, opacity: 0 });
  const dust = new THREE.Mesh(dustGeo, dustMat);
  dust.position.set(0, 0.4, -2.6);
  dust.scale.set(2.5, 1.2, 2.5);
  g.add(dust);
  scene.add(g);
  return { group: g, wheels, headMat, brakeMat, dust, lastS: 0 };
}

function syncCars() {
  const seen = new Set();
  for (const c of snap.cars) {
    seen.add(c.id);
    let m = carMeshes.get(c.id);
    if (!m) { m = makeCarMesh(c); carMeshes.set(c.id, m); }
    /* position + cap : y monde = altitude z, z monde = y plan (voie serveur) */
    m.group.position.set(c.pos3.x, c.pos3.z, c.pos3.y);
    m.group.rotation.y = -c.hd;
    /* suspension cosmétique : roll/pitch calculés par le cœur */
    const me = snap.me?.id === c.id ? snap.me : null;
    if (me) {
      m.group.rotation.x = me.pitch ?? 0;
      m.group.rotation.z = me.roll ?? 0;
    }
    /* roues qui tournent (vitesse réelle si dispo, sinon km/h public) */
    const v = (snap.me?.id === c.id ? snap.me.v : (c.v || 0)) / 3.6;
    for (const w of m.wheels) w.rotation.y += v * 0.05;
    /* feu stop */
    m.brakeMat.emissive.setHex((c.brake ?? (snap.me?.id === c.id ? snap.me.brake : 0)) ? 0xff2222 : 0x000000);
    /* poussière : visible si on roule, plus dense au désert (biome lu
       sur la fenêtre du monde — approximation du point le plus proche) */
    let biome = 0;
    if (world?.pts) {
      let best = Infinity;
      for (const wp of world.pts) {
        const dd = Math.abs(wp.x - c.pos3.x) + Math.abs(wp.y - c.pos3.y);
        if (dd < best) { best = dd; biome = wp.biome; }
      }
    }
    m.dust.material.opacity = v > 8 ? (biome === 2 ? 0.5 : 0.2) : 0;
  }
  for (const [id, m] of carMeshes) {
    if (!seen.has(id)) { scene.remove(m.group); carMeshes.delete(id); }
  }
}

/* ============================================================
   CHASE CAM — lissage ~0,4 s ; orbite quand la voiture est arrêtée
   ============================================================ */
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
let orbitT = 0;
function updateCamera(dt) {
  const car = snap?.cars.find((c) => c.id === followId);
  if (!car) return;
  /* three.js : y = altitude, x/z = plan. L'avant de la voiture suit hd :
     dans le plan, direction avant = (cos hd, sin hd) en (x, y-serveur)
     → en monde 3D : (cos hd, 0, sin hd). */
  const p = new THREE.Vector3(car.pos3.x, car.pos3.z + 1, car.pos3.y);
  const fx = Math.cos(car.hd), fz = Math.sin(car.hd);
  const stopped = ['stop', 'dry', 'finish'].includes(car.st);
  let target, look;
  if (stopped) {
    /* voiture arrêtée (sommeil, ravitaillement, panne) → orbite lente */
    orbitT += dt * 0.25;
    target = new THREE.Vector3(
      p.x + Math.cos(orbitT) * 18,
      p.y + 7,
      p.z + Math.sin(orbitT) * 18);
    look = p.clone();
  } else {
    /* derrière-haute, regard devant la voiture */
    target = new THREE.Vector3(p.x - fx * 14, p.y + 6, p.z - fz * 14);
    look = new THREE.Vector3(p.x + fx * 10, p.y, p.z + fz * 10);
  }
  /* lissage ~0,4 s — la caméra traîne juste assez pour lire la vitesse */
  const k = 1 - Math.exp(-dt / 0.4);
  camPos.lerp(target, k);
  camLook.lerp(look, k);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
}

/* ============================================================
   CYCLE JOUR/NUIT — calé sur l'heure de Paris réelle
   ============================================================ */
function updateSky() {
  if (!snap) return;
  const h = snap.hour ?? 12;
  const sun = scene.userData.sun, moon = scene.userData.moon;
  const hemi = scene.userData.hemi, stars = scene.userData.stars;

  /* position du soleil : plein sud à 12 h, course complète */
  const dayT = (h - 6) / 12;                     // 0 à 1 sur la journée 6 h→18 h
  const elev = Math.sin(Math.max(0, Math.min(1, dayT)) * Math.PI);   // 0→1→0
  const az = (h / 24) * Math.PI * 2;
  const sunDir = new THREE.Vector3(Math.cos(az), Math.max(elev, 0.05), Math.sin(az));
  sun.position.copy(sunDir).multiplyScalar(400);
  sun.intensity = 0.2 + elev * 1.5;
  moon.position.set(-sunDir.x, Math.max(0.3, 1 - elev), -sunDir.z).multiplyScalar(400);

  /* palettes par plage horaire : nuit sombre 21-6, aube 6-8,
     crépuscule 18-20 (couleurs chaudes), jour éclairé */
  const sky = new THREE.Color();
  let fogNear = 300, fogFar = 2200;
  if (h >= 21 || h < 5) { sky.setHex(NIGHT); sun.intensity = 0.05; fogNear = 60; fogFar = 900; }
  else if (h < 8) sky.lerpColors(new THREE.Color(NIGHT), new THREE.Color(0xf2b98a), (h - 5) / 3);
  else if (h < 18) sky.setHex(0x87b5d8);
  else if (h < 20) sky.lerpColors(new THREE.Color(0xf2975a), new THREE.Color(NIGHT), (h - 18) / 2.5);
  else sky.lerpColors(new THREE.Color(NIGHT), new THREE.Color(NIGHT), 1);

  /* brouillard PAR BIOME + météo : pluie = ciel lourd et nuages bas */
  const car = snap.cars.find((c) => c.id === followId);
  const b = car ? (world?.pts?.find?.((p) => Math.abs(p.x - car.pos3.x) < 50)?.biome ?? 0) : 0;
  const weather = snap.weather?.[b] === 'rain';
  if (weather) { fogNear = 40; fogFar = 600; sky.multiplyScalar(0.55); }
  scene.background = sky;
  scene.fog.color.copy(sky).lerp(new THREE.Color(BIOME_FOG[b] ?? 0xcfe8f2), 0.4);
  scene.fog.near = fogNear;
  scene.fog.far = fogFar;

  /* étoiles la nuit, éclairage automatique */
  stars.material.opacity = h >= 21 || h < 5 ? 0.9 : 0;
  const nightNow = h >= 20 || h < 7;
  hemi.intensity = nightNow ? 0.18 : 0.9;
  for (const m of carMeshes.values()) {
    m.headMat.emissive.setHex(nightNow ? 0xfff2b0 : 0x000000);
  }
  /* POI éclairés la nuit — balises de vie dans le noir */
  for (const l of poiLights) l.intensity = nightNow ? 2.2 : 0;
}

/* ============================================================
   Sélecteur + boutons
   ============================================================ */
function renderCarList() {
  const sel = $('carSel');
  const ids = snap.cars.map((c) => c.id).join(',');
  if (sel.dataset.ids !== ids) {
    sel.dataset.ids = ids;
    sel.innerHTML = '';
    for (const c of snap.cars) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = `${c.rank}. ${c.name}`;
      sel.appendChild(o);
    }
  }
  sel.value = String(followId);
}

$('carSel').onchange = (e) => {
  followId = Number(e.target.value);
  orbitT = 0;
  refreshWorld();
};
$('backBtn').onclick = () => location.href = '/';
$('fsBtn').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
};

/* ============================================================
   Boucle — qualité auto-dégradée sous 28 fps
   ============================================================ */
let lastT = performance.now();
function loop() {
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
  updateCamera(dt);
  updateSky();
  renderer.render(scene, camera);
}

/* ============================================================
   Boot
   ============================================================ */
(async () => {
  try {
    initScene();
  } catch (e) {
    $('err').style.display = 'grid';
    return;
  }
  await poll();
  await refreshWorld();
  const car = snap?.cars.find((c) => c.id === followId);
  if (car) {
    camPos.set(car.pos3.x, car.pos3.z + 6, car.pos3.y - 14);
    camLook.set(car.pos3.x, car.pos3.z, car.pos3.y);
  }
  setInterval(poll, 1000);
  setInterval(refreshWorld, 3000);
  loop();
})();
