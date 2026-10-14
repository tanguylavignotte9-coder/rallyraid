# ADR 0001 — Serveur autoritaire, clients simples

- **Statut** : accepté (2026-10-14)
- **Décideur** : Tanguy (vision) + Vibe (architecture)

## Contexte

La course dure plusieurs jours, en temps réel, et se poursuit **que le joueur soit connecté ou non**. Les clients sont des navigateurs (PC et mobile), par nature instables : onglets fermés, réseau intermittent, téléphones en veille. Plusieurs voitures sur la même piste doivent se doubler selon les mêmes règles, sans que personne ne puisse altérer sa propre physique.

## Décision

La simulation physique tourne **sur le serveur, uniquement** :

- le serveur fait tourner `core/engine.ts` à pas fixe (1/120 s) en boucle 24 h/24, horloge calée sur **Paris** ;
- l'état complet de la course (piste, voitures, usures, plans) est **persistant** (snapshots réguliers + reprise au redémarrage) ;
- les clients ne font que **lire** la télémétrie et **écrire** des décisions stratégiques (plans) via l'API — jamais d'état local faisant autorité ;
- l'API temps réel (WebSocket ou SSE, à choisir en Phase 3) diffuse la télémétrie ; l'historisation (replays, spectateurs retardés) est rendue possible par le déterminisme (ADR 0004).

## Conséquences

- Le serveur est un composant critique : il doit redémarrer proprement et rattraper son retard (catch-up déterministe sur pas fixe).
- Un client en retard ou déconnecté ne peut jamais corrompre la course — dans le pire cas, son plan par défaut s'applique (ADR 0002).
- Pas de triche par modification du client : la physique est hors de portée du navigateur.
- L'hébergement (où, combien) est une question ouverte de Phase 3 — pas un frein de Phase 0-2.
