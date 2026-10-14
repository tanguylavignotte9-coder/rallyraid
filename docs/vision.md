# Vision du jeu — Rally Raid

> Document vivant de game design. Consolidé après deux sessions de design avec l'auteur (2026-10-14). Il fait foi pour toutes les décisions de développement.

## Le pitch

**Une seule grande course de rally raid, ouverte à tous, en temps réel 1:1.** Les voitures roulent 24 h/24 pendant plusieurs jours (une semaine, deux), calées sur l'horaire de Paris. Le joueur ne conduit pas : il **planifie** — sommeil, ravitaillement, pneus, performance moteur. La voiture roule toute seule, connecté ou non, et les participants se doublent et se redoublent tout au long de la compétition.

## Décisions actées

### La course
- **Marathon continu 24 h/24**, temps réel **1:1 strict** (7 jours de course = 7 jours réels).
- **Départ commun** à date et heure fixes ; **fin paramétrée par événement** (distance totale ou durée).
- **Une seule grande course persistante** ouverte à tous ; **que des voitures de vrais joueurs** (pas de PNJ de remplissage — l'IA de conduite est l'exécutant de chaque voiture, pas un adversaire).
- **Classement** : premier arrivé au temps total (arrêts et incidents inclus) ; en intermédiaire, la position sur la route fait foi.

### Le plan stratégique (la « manette » du joueur)
- **Deux étages** : des **règles conditionnelles générales** (ex. « si fatigue > 70 %, s'arrêter au prochain hôtel ») + des **actions planifiées prioritaires** (ex. « km 850 : pneus », « Djanet : dormir 6 h »).
- **Horizon limité à 12-24 h** : on ne peut planifier que le futur proche — ça force à revenir, la course reste vivante.
- **Révision libre et instantanée** quand on est connecté : tout est modifiable à tout moment.
- **Préparation d'avant-course** : quelques choix initiaux (gommes, réservoir, réglage moteur).

### Le pilote : fatigue et sommeil
- **Fatigue = compteur de veille** par pilote (temps depuis le dernier sommeil, pas calé sur l'horloge).
- **Effets progressifs cumulés** : dégradation douce (vitesse, réflexes) puis **risques réels** de sortie de route au-delà d'un seuil. **Rouler la nuit coûte des risques supplémentaires.**
- **Sommeil à la minute près** : à l'hôtel, durée exacte choisie ; chaque minute dort est récupérée. **Le repos ne s'achète pas** — il coûte du temps, jamais d'argent.
- **Pénalité de survie** : sans plan et en fatigue critique → sommeil forcé **en bord de route** (très coûteux).

### Les ressources et l'économie
- **Budget à revenu périodique** : base fixe + bonus position et régularité. Dépenses : **carburant, pneus, réparations** — pas d'améliorations de voiture, pas d'achat d'information.
- **Carburant : panne sèche possible** (immobilisation, assistance lente). **Pneus : usure simple** (jauge). **Moteur : mode perf ↔ usure/consommation, cassable mais réparable** (longue immobilisation au garage, jamais d'abandon).

### Les incidents
- **Sortie de route** (fatigue critique) : immobilisation chronométrée **+ dégâts** (moteur/boîte), réparables au garage.
- **Crevaison surprise** : mode dégradé (80-90 km/h max) jusqu'au prochain garage ou arrêt pneus.
- **Météo : grip seulement** — pluie et sable réduisent l'adhérence, la voiture ralentit toute seule (s'attache au μ par biome du moteur).
- **Surprises uniquement négatives** : crevaison, tempête, orage de sable — jamais d'aubaine.

### Les arrêts (points d'intérêt)
- **Pas de files** : chaque voiture a son poste, services en parallèle.
- **Durées proportionnelles mais courtes et réalistes** (le plein au litre, la réparation selon les dégâts).
- **Densité variable par biome** : zones riches (plaine) et zones désertiques vides — la vraie gestion d'autonomie.
- **Services à la carte** selon l'offre du point d'intérêt (station = carburant, hôtel = sommeil, garage = mécanique).

### Le duel à N voitures
- **Le contact reste interdit en règle, MAIS il peut arriver** : selon les statistiques des voitures et un aléatoire dosé, un contact peut survenir → **accident plus ou moins grave, avec faute attribuée** à l'un ou à l'autre selon le contexte. *(Implication moteur : RNG semé — le déterminisme de l'ADR 0004 est préservé ; la garde anti-collision devient un réducteur de risque, plus une garantie absolue. Règles d'attribution de faute à définir.)*
- **Aspiration confirmée entre toutes les voitures** — l'arme du poursuivant.
- **Voiture arrêtée** (panne, sommeil, réparation) : rangée sur le bas-côté, hors trajectoire — les autres passent sans contrainte.

### L'information
- **Aléa mixte** : bulletins prévisionnels sur la route à venir + surprises **déterministes côté serveur mais cachées** aux joueurs (l'incertitude vient de l'information non révélée, pas du hasard de simulation).
- **Des adversaires, on ne voit que positions et écarts** : leurs états internes (carburant, fatigue, usure, plans) sont cachés.
- **Pas de push** : à la reconnexion, un **journal chronologique détaillé** de chaque événement depuis la dernière visite.

### L'identité et la vitrine
- **Nom d'équipe + livrée** (couleurs) : chaque voiture est reconnaissable de loin.
- **Engagement** : compétitif = surveiller le plus possible ; mais **2-3 consultations/jour suffisent** pour un niveau de performance standard.
- **Carte 2D pour jouer + vue 3D spectateur** (comme le prototype) : on « regarde la course ».

## Questions encore ouvertes

- **Attribution de la faute** (contact) : quelles règles ? La règle de la corde devient-elle le juge ? Quelle pénalité (temps ? dégâts ?) ?
- **Fréquence du contact RNG** : à quel point rare ? (le prototype garantit 0 contact ; l'équilibrage est critique)
- **Rotation des courses** : quand démarre la suivante ?
- **Course à durée : classement des non-arrivés** (km parcourus ?).
- **Onboarding** : mode découverte avant la grande course ?
- **Plan de survie par défaut** : priorités quand tout va mal en même temps.
- **Bonus « régularité »** du revenu : définition exacte.
- **Couplage fatigue × nuit** : formule exacte.

## Ce qui est déjà acté (structurel)

- **Serveur autoritaire** (ADR 0001) : simulation 24 h/24 sur le serveur, horloge Paris, clients navigateurs en lecture/stratégie.
- **Le joueur est stratège** (ADR 0002) : aucune entrée de pilotage, la stratégie est un plan exécuté en continu, plan de survie par défaut hors connexion.
- **Moteur maison déterministe** (ADR 0004) : TypeScript pur, pas fixe 1/120 s, PRNG semé — replays, reprise serveur, équité.
- **Équité stricte** : même voiture pour tous ; l'asymétrie ne vient que des choix stratégiques et de la gestion du risque.
