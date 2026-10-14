# ADR 0002 — Le joueur est stratège : les voitures sont autonomes, la stratégie est un plan

- **Statut** : accepté (2026-10-14)

## Contexte

Dans le prototype, deux voitures roulent déjà seules : une IA pilote (`speedTarget` + ligne de course), une rivale attaque avec une politique explicite. Le jeu voulu n'a **aucune entrée de pilotage** : le joueur planifie pneus, arrêts (stations-service, hôtels, garages) et niveau de performance moteur (consommation, usure) — et la voiture continue de rouler **qu'il soit connecté ou non**.

## Décision

1. **Toute voiture est autonome** : le couple « IA de conduite + physique » du cœur pilote chaque voiture. Le concept de « joueur » ne désigne pas un pilote, mais l'auteur d'un plan.
2. **La stratégie est une donnée, pas une session** : un *plan* (liste d'instructions datées/géolocalisées : changer les pneus à tel arrêt, dormir à tel hôtel, mode moteur 70 % jusqu'au km X) est stocké côté serveur et **exécuté par l'exécuteur du cœur** image par image, indépendamment de la connexion du joueur.
3. **Il existe toujours un plan par défaut** (rouler en mode prudent) : une voiture sans plan actif ne s'arrête jamais de courir.
4. La différenciation entre voitures vient **uniquement** du plan et de ses conséquences physiques (usure, ravitaillement, sommeil) — jamais de paramètres moteur cachés.

## Conséquences

- Le duel du prototype (règle de la corde, anti-collision, aspiration) devient le **système d'arbitrage commun à toutes les voitures** : il devra être généralisé à N voitures en Phase 1.
- L'interface web est un **éditeur de plan + tableau de télémétrie**, pas un jeu de pilotage : à concevoir comme un jeu de gestion.
- Modifier un plan à chaud doit être une opération sûre et auditée (journal des décisions de course) — à définir en Phase 2.
- La connexion du joueur ne donne aucun avantage physique : elle donne de l'information et le droit de réviser le plan.
