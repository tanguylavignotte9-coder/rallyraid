# Vision du jeu — Rally Raid

> Document vivant de game design, rédigé à partir des mots de l'auteur (Tanguy, 2026-10-14). Il fait foi pour toutes les décisions de développement ; le modifier = changer la direction du projet.

## Le pitch

Une **compétition de rally raid qui dure plusieurs jours** — une semaine, deux semaines. Les voitures roulent **en permanence, en temps réel**, calées sur l'**horaire de Paris**. Les participants se doublent et se redoublent tout au long de la compétition.

## Le joueur : un stratège, pas un pilote

Le joueur **n'effectue aucune action concrète d'accélération ni de direction**. Sa voiture se pilote **constamment en temps réel, qu'il soit connecté ou non**. Depuis son interface (navigateur PC ou mobile), il **planifie** :

- les **prochains changements de pneus** ;
- les **prochains arrêts** : stations-service, hôtels pour dormir, garages ;
- le **degré de performance du moteur**, avec ses conséquences : consommation, usure du moteur.

C'est un jeu de **gestion et de stratégie de course**, où le moteur physique (validation image par image, budget d'adhérence, duels à la corde) garantit que la course est *véridique* : les écarts viennent de la piste et des choix, pas de jets de dés.

## Les ingrédients attendus sur la route

Tout au long de la route générée :

- **Stations-service** → ravitaillement (temps d'arrêt vs autonomie) ;
- **Hôtels** → sommeil du pilote (gestion de la fatigue / rythme nuit-jour ?) ;
- **Garages** → réparations / entretien moteur.

## À définir (questions ouvertes de game design)

Ces points ne sont pas encore arbitrés — chacun mérite sa propre session de design avant d'être codé :

- **Périmètre de l'usure** : pneus (sûr), moteur (sûr), carburant (sûr) — et la fatigue du pilote, les dégâts (toujours interdits ? le proto interdit tout contact), la météo ?
- **Effet du sommeil** : la voiture s'arrête-t-elle à l'hôtel (arbitrage vitesse vs récupération) ? Rythme imposé par la nuit ?
- **Échelle de temps** : 1:1 réel pur, ou temps légèrement dilaté/contracté pour que la course tienne en quelques jours ?
- **Nombre de joueurs** d'une même compétition ; sessions simultanées ou une seule grande course ?
- **Fin de course** : ligne d'arrivée après N jours, ou classement au temps cumulé sur étapes ?

## Ce qui est déjà acté

- Le **moteur physique maison** (cercle de friction, aspiration, IA de conduite honnête, règle de la corde) est **validé par des mois de prototype** et migré dans ce dépôt (`core/engine.ts`) avec ses tests.
- **Équité stricte** : même voiture, même physique pour tous ; l'asymétrie ne vient que des choix stratégiques.
- **Aucun contact** entre voitures : le duel se gagne à la corde (essieu avant à mi-hauteur) ou en vitesse pure, jamais par le contact.
