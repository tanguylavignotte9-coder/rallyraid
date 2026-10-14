# ADR 0002 (amendement) — Arrêt de survie après 24 h sans connexion

- **Statut** : amendement accepté (2026-10-14, 3e session de design)

## Contexte

L'ADR 0002 posait qu'« une voiture sans plan actif ne s'arrête jamais de courir » (plan par défaut perpétuel). La course est une compétition intime de plusieurs dizaines d'équipes sur 1-2 semaines réelles : une voiture dont l'équipe disparaît plusieurs jours continuerait de rouler en boucle sur son plan, polluant le classement et la route sans superviseur.

## Décision

**Après 24 h sans connexion, la voiture s'arrête à un point d'arrêt (station, hôtel, garage — le plus proche sur l'itinéraire) et n'en repart qu'à la reconnexion de son équipe.** Pendant l'arrêt de survie, la voiture est rangée hors trajectoire comme tout véhicule arrêté (décision duel : bas-côté, sans contrainte pour les autres).

Le plan par défaut continue de s'appliquer **dans la fenêtre des 24 h** : une absence d'une journée reste jouable sans pénalité, la voiture continue de rouler selon les règles conditionnelles du joueur.

## Conséquences

- Une reconnexion reprend la course exactement là où la voiture s'est arrêtée — pas de rattrapage, pas de téléportation.
- Le classement ne contient pas de voitures fantômes rouler 10 jours sans supervision.
- La règle est honnête : elle protège le peloton, pas le joueur absent (la position continue de se dégrader pendant l'arrêt).
- Le serveur doit modéliser l'état « arrêt de survie » comme un état de voiture distinct (persistant, survivant aux redémarrages).
