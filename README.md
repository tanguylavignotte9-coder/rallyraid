# Rally Raid

Course stratégique persistante multi-jouieurs. Des voitures de rally raid roulent **en continu pendant plusieurs jours** (compétition calée sur l'horaire de Paris). Chaque joueur, depuis son navigateur (PC ou mobile), ne conduit pas : il **planifie la stratégie** — changements de pneus, arrêts (stations-service, hôtels, garages), niveau de performance moteur (consommation, usure). La voiture roule toute seule, connecté ou non, et les participants se doublent et se redoublent tout au long de la compétition.

> Ce dépôt est encore en **Phase 0 : fondations**. Le moteur physique est réel et testé ; le serveur, l'API et l'interface viendront ensuite (voir la [feuille de route](#feuille-de-route)).

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
| `tests/core.test.ts` | Non-régression : déterminisme au bit près, tour de référence dans le budget de grip, duel sans contact. |
| `docs/vision.md` | Le jeu tel que voulu par l'auteur — document vivant de game design. |
| `docs/adr/` | Architecture Decision Records : chaque décision fondatrice, son contexte et son pourquoi. |
| `.github/workflows/ci.yml` | CI : les tests tournent à chaque push/pull request. |

## Vérifier (aucune compétence en codage requise)

Le dépôt est pensé pour être vérifié sans toucher au code :

- **Chaque push** déclenche la CI (onglet *Actions* sur GitHub) : ✔ vert = le moteur est sain.
- Les **3 tests** garantissent : deux courses de la même graine sont identiques image par image ; un tour complet se boucle au temps de référence sans dépasser l'adhérence des pneus ; un duel de 15 minutes produit des tentatives de doublage mais zéro contact.

## Feuille de route

| Phase | Contenu | État |
|---|---|---|
| **0 — Fondations** | Moteur migré et testé, ADR, CI, vision documentée | ✅ ce commit |
| **1 — Généralisation** | N voitures (au lieu de 2) · variables d'usure (pneus, moteur, carburant) · points d'arrêt sur la piste | ⬜ |
| **2 — Stratégie** | Format de *plan* (données), exécuteur, plan par défaut hors-ligne | ⬜ |
| **3 — Serveur** | Simulation persistante 24 h/24 calée sur Paris, snapshots/reprise, API temps réel | ⬜ |
| **4 — Interface** | Client web PC/mobile : carte, télémétrie, éditeur de plan | ⬜ |
| **5 — Compétition** | Course multi-jouieurs de plusieurs jours, doublages/rétablissements | ⬜ |

## Décisions fondatrices

Voir [`docs/adr/`](docs/adr/) — chaque décision y est motivée :

1. `0001` — Serveur autoritaire, clients simples
2. `0002` — Le joueur est stratège : les voitures sont autonomes, la stratégie est un plan
3. `0003` — Navigateur uniquement, PC et mobile
4. `0004` — Moteur physique maison, déterministe, pas de temps fixe
5. `0005` — Le dépôt est écrit directement par Vibe (l'agent), sur validation de l'auteur
