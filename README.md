# Rally Raid

Course stratégique persistante multi-jouieurs. Des voitures de rally raid roulent **en continu pendant plusieurs jours** (compétition calée sur l'horaire de Paris). Chaque joueur, depuis son navigateur (PC ou mobile), ne conduit pas : il **planifie la stratégie** — changements de pneus, arrêts (stations-service, hôtels, garages), niveau de performance moteur (consommation, usure). La voiture roule toute seule, connecté ou non, et les participants se doublent et se redoublent tout au long de la compétition.

> **Première version jouable** : serveur autoritaire temps réel 1:1 + interface de stratège dans le navigateur — voir [Jouer](#jouer).

## Jouer

**En 1 clic** (vérifie/installe Node.js si besoin, démarre le serveur, ouvre le navigateur) :

- **Windows** : double-cliquer `start.cmd` — il lance `start.ps1` avec la politique d'exécution adaptée (le `-ExecutionPolicy Bypass` ne s'applique qu'à CE script, pas au système ; installe Node via winget si absent). En cas de problème, le launcher affiche l'erreur et laisse la fenêtre ouverte ; un ancien serveur qui traîne peut occuper le port 8787 (fermer node.exe).
- **Linux / macOS** : `./start.sh` (propose d'installer Node via apt/brew si absent)

Ou manuellement :

```bash
npm start          # serveur autoritaire sur http://localhost:8787
```

Puis ouvrir **http://localhost:8787** dans le navigateur (interface en français : carte 2D, classement, jauges, journal, éditeur de plan). La page d'accueil redirige vers la connexion si besoin. Le serveur :

- simule la course **en temps réel 1:1** (horloge de Paris), 24 h/24 ;
- **persiste l'état sur disque** (`server/race-state.json`) : fermer le serveur puis le relancer reprend la course exactement où elle en était (même graine ⇒ même course, ADR 0004) ;
- sert l'interface et une petite API JSON :

| Endpoint | Rôle |
|---|---|
| `GET /api/health` | Sonde du launcher 1-clic — publique, minimale (`{ok, phase}`) |
| `POST /api/login` / `POST /api/logout` | Session (cookie httpOnly, plusieurs sessions autorisées) |
| `GET /api/me` | Compte courant : user, niveau, voiture |
| `GET /api/state` | Classement public + SA voiture en détail ; `hour` (Paris), météo et `pos3` par voiture |
| `GET /api/track?s0=&len=&step=` | Géométrie de l'itinéraire : `{x, y, z, hd, w, biome, seg}` + `pois` (rétro-compatible 2D : x/y) |
| `POST /api/configure` | Première configuration (grille ouverte) — ou personnalisation différée d'une voiture auto-attribuée (à tout moment, une fois) |
| `GET /api/liveries` | Livrées encore disponibles |
| `POST /api/plan` | Remplacer le plan de SA voiture (ou de n'importe laquelle pour un super) |
| `POST/GET /api/cb` | CB de proximité : émission (anti-flood 5 s) / réception filtrée ≤ 100 km |
| `GET /api/cars` | Liste des participants (super/admin) |
| `POST /api/admin/accounts` · `/api/admin/reset-pass` · `/api/admin/level` · `/api/admin/disable` | Gestion des comptes (admin) |
| `GET/POST /api/admin/reset` | Paramètres et reset de course (admin) |
| `GET /api/admin/seedmap?seed=&km=` | Explorateur de graines : carte + profil + stats (admin) |
| `GET /api/profile` | Carte complète + profil d'altitude (préparation) |
| `/spectate.html` | Vue 3D spectateur : chase cam, monde par biome, cycle jour/nuit réel (Paris) |

Toutes les routes API (et les pages de jeu) exigent une session valide — 401 sinon.

**Comptes & déroulé** : pas d'auto-inscription — l'admin crée les comptes. Au premier lancement du serveur, un compte `admin` est créé avec un mot de passe aléatoire **affiché une seule fois dans la console** (modifiable dans la page admin, `admin.html`). Déroulé d'une course : **préparation** (compte à rebours, les joueurs configurent leur voiture — nom d'équipe + livrée unique) → **course** (temps réel 1:1) → **terminée** (podium et résumé figés jusqu'au prochain reset admin). Au départ, tout compte actif sans voiture en reçoit une automatiquement (nom = identifiant, livrée libre, plan par défaut) — il la personnalise à sa première connexion ; la grille est figée au départ, un compte créé après attend le reset suivant.

Interface « une voiture » : chaque joueur voit SA voiture (jauges, plan, journal) et des autres seulement position, nom et état visible. Le super utilisateur garde un sélecteur discret de participant ; l'admin a la page d'administration (comptes : création, mot de passe, niveau super, désactivation ; course : reset avec graine, distance, date/heure de départ, fenêtre de préparation, type de fin distance/durée, survie sans connexion, densité POI, forme de la bride de nuit, nb d'inscriptions max).

Règles simulées (temps réel 1:1, distance de test 1000 km par défaut) : la **nuit** (22 h–6 h, Paris) bride la vitesse ; la **fatigue** compte les heures de veille et force un sommeil de survie en bord de route au-delà de 30 h ; la **panne sèche** immobilise 2 h (assistance) ; les arrêts se font aux **points d'intérêt** de l'itinéraire (station = plein 12 min, hôtel = sommeil à la minute près, garage = réparation 30 min).

Variables d'environnement : `RALLY_PORT` (défaut 8787), `RALLY_SEED` (défaut 42), `RALLY_TOTAL_KM` (défaut 1000).

## Architecture

Le principe fondateur : **une seule source de vérité physique, déterministe, sur le serveur**.

```
┌─────────────────────────────────────────────────────────────┐
│  core/ — MOTEUR (TypeScript pur, zéro dépendance)           │
│  piste procédurale · physique (cercle de friction, aéro)    │
│  IA de conduite · règles de duel (corde, anti-collision)    │
│  DÉTERMINISTE : même graine ⇒ même course au bit près       │
└──────────────────────────┬──────────────────────────────────┘
                           │ advance(game, dt) — pas fixe 1/120 s
┌──────────────────────────▼──────────────────────────────────┐
│  server/ (à venir) — simulation AUTORITAIRE 24 h/24         │
│  horloge calée sur Paris · persistance de l'état de course  │
│  exécution des plans de stratégie · API temps réel (WS/SSE) │
└──────────────────────────┬──────────────────────────────────┘
                           │ télémétrie + plans (JSON)
┌──────────────────────────▼──────────────────────────────────┐
│  web/ (à venir) — interface STRATÈGE, navigateur PC/mobile │
│  carte de la course · télémétrie · éditeur de plan          │
└─────────────────────────────────────────────────────────────┘
```

Points clés :

- **Toutes les voitures sont autonomes.** Le joueur n'accélère ni ne braque : il édite un *plan* (pneus, arrêts, mode moteur) que l'exécuteur applique en continu, qu'il soit connecté ou non.
- **Le déterminisme est la garantie du projet** : il rend possibles les replays, les spectateurs retardés, la reprise après redémarrage serveur, et il interdit les triches client.
- **Un seul modèle de voiture pour tout le monde** : l'équité vient des règles (budget de grip partagé, règle de la corde), pas de handicaps cachés.

## Structure du dépôt

| Chemin | Rôle |
|---|---|
| `core/engine.ts` | Le moteur complet (piste + physique + IA de conduite + duel). Toutes les fonctions top-level sont exportées. |
| `core/route.ts` | L'itinéraire linéaire départ → arrivée, généré par chunks à la demande, avec POI (stations, hôtels, garages). |
| `core/race.ts` | La course : carburant, fatigue, sommeil, nuit, arrêts, exécution des plans, sérialisation. |
| `server/server.ts` | Le serveur autoritaire : simulation temps réel 1:1, persistance, API JSON, fichiers statiques. |
| `web/` | L'interface stratège (HTML/JS, aucune dépendance). |
| `tests/core.test.ts` | Non-régression : déterminisme au bit près, tour de référence dans le budget de grip, duel sans contact. |
| `docs/vision.md` | Le jeu tel que voulu par l'auteur — document vivant de game design. |
| `docs/adr/` | Architecture Decision Records : chaque décision fondatrice, son contexte et son pourquoi. |
| `.github/workflows/ci.yml` | CI : les tests tournent à chaque push/pull request. |

## Vérifier (aucune compétence en codage requise)

Le dépôt est pensé pour être vérifié sans toucher au code :

- **Chaque push** déclenche la CI (onglet *Actions* sur GitHub) : ✔ vert = le moteur est sain.
- Les **78 tests** (9 fichiers : `core`, `route`, `race`, `aggression`, `gearbox`, `terrain`, `terrain-web`, `fixes27`, `fixes28`) garantissent : déterminisme bit à bit (moteur, route, course — contacts et reprise après sérialisation inclus) ; continuité aux frontières de chunks ; arrêt de survie (stop sans connexion, reprise à la reconnexion) ; bride de nuit (multiplicateur et plafond) ; contacts et fautes (une course prudente ne produit presque rien) ; budget (revenus, dépenses, amendes) ; usure relative des gommes ; bulletins d'étape.

## Feuille de route

| Phase | Contenu | État |
|---|---|---|
| **0 — Fondations** | Moteur migré et testé, ADR, CI, vision documentée | ✅ ce commit |
| **1 — Généralisation** | N voitures (au lieu de 2) · variables d'usure (pneus, moteur, carburant) · points d'arrêt sur la piste | ✅ |
| **2 — Stratégie** | Format de *plan* (données), exécuteur, plan par défaut hors-ligne | ✅ |
| **3 — Serveur** | Simulation persistante 24 h/24 calée sur Paris, snapshots/reprise, API JSON | ✅ cette version |
| **4 — Interface** | Client web PC/mobile : carte, classement, jauges, journal, éditeur de plan | ✅ |
| **5a — Comptes & admin** | Sessions scrypt, page admin (comptes, reset complet), interface une-voiture | ✅ cette version |
| **5 — Compétition** | Course multi-jouieurs de plusieurs jours, doublages/rétablissements | ⬜ |
| **Décor : profondeur** | Couture route/terrain, mi-lointain (L1), horizon (reliefs + skyline), villages, eau | ✅ |
| **Route V4 : ondulation de plateforme** | Bruit à l'échelle de la voiture (méandre ψ + octave verticale rapide) | ✅ |

## Décisions fondatrices

Voir [`docs/adr/`](docs/adr/) — chaque décision y est motivée :

1. `0001` — Serveur autoritaire, clients simples
2. `0002` — Le joueur est stratège : les voitures sont autonomes, la stratégie est un plan
3. `0003` — Navigateur uniquement, PC et mobile
4. `0004` — Moteur physique maison, déterministe, pas de temps fixe
5. `0005` — Le dépôt est écrit directement par Vibe (l'agent), sur validation de l'auteur — amendé : prompts préparés dans Work, codage dans le module Code
