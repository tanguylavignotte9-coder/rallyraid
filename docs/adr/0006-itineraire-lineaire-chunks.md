# ADR 0006 — Itinéraire linéaire généré à la demande, chunk par chunk

- Statut : accepté (2026-10-14)
- Décideurs : l'auteur (design), Vibe (implémentation)
- Phase : 1 — Généralisation

## Contexte

Le moteur du prototype circule sur une **boucle fermée de 20,8 km** (2 600 échantillons de 8 m générés d'un bloc). La vision du jeu exige un **itinéraire linéaire de 15 000 à 25 000 km** — Paris→imaginary-arrival, départ → arrivée, sans boucle. Générer la piste entière d'un bloc est impossible :

- **Mémoire** : 20 000 km à la maille du moteur ≈ 2,5 millions d'échantillons × 10 tableaux ≈ 200 Mo — pour UNE course.
- **Temps de démarrage** : plusieurs secondes de génération avant le départ, à chaque serveur.

## Décision

**Un itinéraire découpé en chunks de 20,8 km, générés à la demande, au fil de la course.**

1. **Chunk = 2 600 échantillons de 8 m** (la maille du moteur, inchangée).
2. **Déterminisme par chunk** : le contenu d'un chunk ne dépend que de `(graine, n° de chunk)` et de l'**état d'entrée** (cap, position, altitude) laissé par le chunk précédent. Même graine ⇒ mêmes virages au bit près (ADR 0004). Les chunks se construisent **en ordre** (chacun a besoin de la sortie du précédent).
3. **Fenêtre mémoire** : seuls les chunks récents restent en mémoire (~32 chunks ≈ 660 km). Les anciens sont **évictés et se régénèrent à l'identique** si on les redemande — replays, spectateurs retardés et reprise serveur restent exacts.
4. **Frontières douces** : cap, plan XY, altitude, grip et largeur sont **continus** aux raccords (l'état d'entrée du chunk k+1 est la sortie exacte du chunk k ; un test verrouille ces continuités).
5. **Biomes par segments de 150-500 km** qui s'enchaînent dans l'ordre du design (plaine → forêt → désert → altitude → …), transitions fondues sur 2 km. Le plan de virages garde les menus du proto par biome. Le cap est refermé **sur chaque chunk** (l'itinéraire chemine sans spiraler sur 20 000 km) ; l'altitude dérive avec un léger retour à la moyenne (des collines vivantes, sans dérive folle).
6. **Points d'intérêt** (station, hôtel, garage) posés par un **curseur global par type**, continu aux frontières de chunks, densité par biome (la plaine est riche, le désert est vide).

## Interface avec le moteur

La physique ne lit la route qu'à travers l'interface `Track` (cinq sondes : courbure, grip, largeur, roulement, altitude). La boucle du proto l'implémente via `trackOf(road)` ; la route linéaire l'implémente via `routeTrack(route)`. **Même physique, même budget de grip, deux mondes** — aucun `if` de type dans le moteur.

## Conséquences

- Le serveur (Phase 3) peut simuler une course de 25 000 km avec ~3 Mo de piste en mémoire.
- La carte 2D (Phase 4) lira `roadPoint(s)` et régénérera à la demande les chunks visualisés — mêmes données bit à bit.
- Limite acceptée : générer un chunk lointain « hors ordre » oblige à construire tous les chunks intermédiaires (bornes d'entrée). Les voitures roulant en continu, ce cas n'arrive qu'en visualisation de carte — coût ponctuel et déterministe.
