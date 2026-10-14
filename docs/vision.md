# Vision du jeu — Rally Raid

> Document vivant de game design. Consolidé après la session de design du 2026-10-14 (5 salves de questions-réponses avec l'auteur). Il fait foi pour toutes les décisions de développement.

## Le pitch

**Une seule grande course de rally raid, ouverte à tous, en temps réel 1:1.** Les voitures roulent 24 h/24 pendant plusieurs jours (une semaine, deux), calées sur l'horaire de Paris. Le joueur ne conduit pas : il **planifie** — sommeil, ravitaillement, pneus, performance moteur. La voiture roule toute seule, connecté ou non, et les participants se doublent et se redoublent tout au long de la compétition.

## Décisions actées (session du 2026-10-14)

### La course
- **Marathon continu 24 h/24** : pas d'étapes, pas de pause nocturne imposée — la course roule jusqu'à la fin.
- **Temps réel 1:1 strict** : 7 jours de course = 7 jours réels.
- **Départ commun** à date et heure fixes : tous en piste en même temps (inscriptions avant le départ).
- **Fin paramétrée par événement** : distance totale fixe (premier au bout des X km) ou durée fixe (le plus loin à la date de fin).
- **Que des voitures de vrais joueurs** : pas de voitures IA pour remplir la course. (L'IA de conduite reste le pilote exécutant de chaque voiture.)

### Le pilote : fatigue et sommeil
- **La fatigue est un compteur de veille** par pilote : temps écoulé depuis le dernier sommeil, pas un cycle calé sur l'horloge.
- **Effets progressifs, les deux cumulés** : dégradation douce (vitesse et réflexes réduits), puis risques réels au-delà d'un seuil (sortie de route → immobilisation et dégâts).
- **Rouler de nuit coûte des risques supplémentaires** (aggrave le bilan du pilote — couplage exact compteur de veille × nuit : à régler).
- **Le sommeil se planifie à la minute près** : à l'hôtel, le joueur choisit la durée exacte (ex. 6 h 30) ; chaque minute dort est récupérée.
- **Le repos ne s'achète pas** : il coûte du temps, jamais d'argent.
- **Pénalité de survie** : sans plan et en fatigue critique, sommeil forcé **en bord de route** — longue pause inefficace, très coûteuse en temps.

### Les ressources
- **Budget d'équipe avec revenu périodique** : base fixe par période + bonus selon la position au classement et la régularité (définition exacte de la régularité : à régler).
- **Dépenses possibles** : carburant, pneus, réparations. **Pas** d'améliorations de voiture, **pas** d'achat d'information — l'économie reste simple, le temps est la vraie monnaie.
- **Carburant : panne sèche possible** — la voiture s'immobilise jusqu'au ravitaillement (assistance lente). La gestion du réservoir est un vrai enjeu.
- **Pneus : usure simple** (une jauge, on change quand c'est usé).
- **Moteur : mode performance ↔ usure et consommation.** La casse est **possible mais réparable** : longue immobilisation au garage, jamais d'abandon de course par casse.

### L'information et l'aléa
- **Aléa mixte** : des bulletins prévisionnels annoncent ce qui attend sur la route (météo, sable, route dégradée) — mais des **surprises restent possibles** (crevaison, tempête).
- Implication technique : les surprises sont **déterministes côté serveur mais cachées** — le moteur reste 100 % déterministe (ADR 0004), l'incertitude vient de l'information non révélée, pas du hasard de simulation.
- **On ne voit des adversaires que les positions et les écarts** : leurs états internus (carburant, fatigue, usure, plans) sont cachés. L'estimation des rivaux est une compétence de joueur.
- **Pas de notifications push** : c'est au joueur de consulter. Un rapport de course complet l'attend à chaque connexion.

## Questions encore ouvertes

- **Rotation des courses** : quand la grande course se termine, quand et comment démarre la suivante ? Inscriptions pour la suivante pendant que la courante court ?
- **Onboarding** : un mode découverte (piste d'essai solo, course courte d'entraînement) avant la grande course ? ou on apprend dans la vraie course ?
- **Le plan par défaut** (ADR 0002) doit devenir un *plan de survie complet* : gérer carburant, pneus, fatigue sans décision humaine — quelles priorités quand tout va mal en même temps ?
- **Rendement de la régularité** (bonus de revenu) : régularité de quoi exactement (rythme de progression ? risque évité ?) ?
- **L'incident "sortie de route"** : modélisation exacte (immobilisation ? dégâts ? quelle gravité selon la vitesse ?).

## Ce qui est déjà acté (structurel)

- **Serveur autoritaire** (ADR 0001) : la simulation vit sur le serveur, 24 h/24, horloge Paris, clients navigateurs en lecture/stratégie.
- **Le joueur est stratège** (ADR 0002) : aucune entrée de pilotage, la stratégie est un plan exécuté en continu, plan par défaut hors connexion.
- **Moteur maison déterministe** (ADR 0004) : TypeScript pur, pas fixe 1/120 s, PRNG semé — la garantie des replays, de la reprise serveur et de l'équité.
- **Équité stricte** : même voiture pour tous ; l'asymétrie ne vient que des choix stratégiques et de la gestion du risque.
- **Aucun contact entre voitures** : le duel se gagne à la corde (essieu avant à mi-hauteur) ou en vitesse pure — la règle du prototype s'appliquera à N voitures.
