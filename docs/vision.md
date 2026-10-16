# Vision du jeu — Rally Raid

> Document vivant de game design. Consolidé après trois sessions de design avec l'auteur (2026-10-14). Il fait foi pour toutes les décisions de développement.

## Le pitch

**Une grande course de rally raid ouverte à quelques dizaines d'équipes, en temps réel 1:1.** Les voitures roulent 24 h/24 pendant plusieurs jours sur un itinéraire linéaire de 15 000 à 25 000 km, calées sur l'horaire de Paris. Le joueur ne conduit pas : il **planifie** — sommeil, ravitaillement, pneus, performance moteur. La voiture roule toute seule, connecté ou non, et les participants se doublent et se redoublent tout au long de la compétition.

## Décisions actées

### La course
- **Itinéraire linéaire** : un départ, une arrivée, pas de boucle. Les biomes s'enchaînent tout au long de la course (plaine → forêt → désert → altitude…).
- **Temps réel 1:1 strict** et **assumer l'énormité** : 7 jours de course = 15-25 000 km au compteur, on roule vraiment tout ce temps.
- **Départ commun** à date et heure fixes ; **fin paramétrée par événement** (distance totale ou durée).
- **Quelques dizaines de voitures maximum** : une course intime où l'on se connaît tous.
- **Classement** : premier arrivé au temps total (arrêts et incidents inclus) ; en intermédiaire, la position sur la route fait foi ; les non-arrivés d'une course à durée sont **classés au kilomètre atteint**.
- **Des courses programmées à des dates précises** : le serveur ouvre la course, elle se court, la suivante est planifiée.
- **Éphémère** : chaque course est un nouveau départ — rien ne se transmet d'une course à l'autre, pas de palmarès cumulé.

### La piste et le moteur (implications techniques)
- Le générateur doit passer d'une boucle de 20 km à un **itinéraire linéaire généré à la demande** (chunks) — c'est le gros morceau de la Phase 1.
- **Le duel s'arbitre paire par paire** (la règle de la corde) ; pas de gestion spécifique des paquets ou triples dépassements. **Portée exacte (clarification du 2026-10-14) : strictement deux voitures par duel, en chaîne — voir « Le duel à N voitures et les fautes » ci-dessous.**

### Le plan stratégique (la « manette » du joueur)
- **Deux étages** : des **règles conditionnelles générales** (ex. « si fatigue > 70 %, s'arrêter au prochain hôtel ») + des **actions planifiées prioritaires** (ex. « km 850 : pneus »).
- **Horizon limité à 12-24 h** : on ne planifie que le futur proche — ça force à revenir, la course reste vivante.
- **Révision libre et instantanée** quand on est connecté.
- **Préparation d'avant-course** : quelques choix initiaux (gommes, réservoir, réglage moteur).
- **Règle d'arrêt de survie** : sans connexion depuis **24 h**, la voiture s'arrête à un point d'arrêt et **ne repart qu'à la reconnexion**. (Amende l'ADR 0002 : le plan par défaut ne roule plus indéfiniment — une voiture non supervisée dort à un arrêt.)

### Le pilote : fatigue et sommeil
- **Fatigue = compteur de veille** par pilote (temps depuis le dernier sommeil). La nuit n'accélère PAS ce compteur.
- **La nuit bride la performance** : vitesse max réduite entre 22 h et 6 h (Paris), indépendamment de la fatigue.
- **Effets progressifs cumulés** : dégradation douce (vitesse, réflexes) puis **risques réels** de sortie de route au-delà d'un seuil.
- **Sommeil à la minute près à l'hôtel** : durée exacte choisie ; chaque minute dort est récupérée. **Le repos ne s'achète pas.**
- **Sommeil en bord de route** (sans plan, fatigue critique) : récupération **complète mais deux fois moins efficace** qu'à l'hôtel.

### Les ressources et l'économie
- **Budget à revenu périodique** : base fixe + bonus position + bonus régularité (**moitié rythme de croisière stable, moitié absence d'incident**). Dépenses : carburant, pneus, réparations — pas d'améliorations de voiture, pas d'achat d'information.
- **Carburant : panne sèche possible** (immobilisation, assistance lente). **Pneus : usure simple** (jauge). **Moteur : mode perf ↔ usure/consommation, cassable mais réparable** — et **jamais de fin de course par accident : tout se répare, dans le pire cas très longtemps**.

### Les incidents
- **Sortie de route** (fatigue critique) : immobilisation chronométrée **+ dégâts** (moteur/boîte), réparables au garage.
- **Crevaison surprise** : mode dégradé (80-90 km/h max) jusqu'au prochain garage ou arrêt pneus.
- **Météo : grip seulement** — pluie et sable réduisent l'adhérence, la voiture ralentit toute seule (s'attache au μ par biome du moteur).
- **Surprises uniquement négatives** : crevaison, tempête, orage de sable — jamais d'aubaine.

### Les arrêts (points d'intérêt)
- **Pas de files** : chaque voiture a son poste, services en parallèle.
- **Durées proportionnelles mais courtes et réalistes**.
- **Densité variable par biome** : zones riches (plaine) et zones désertiques vides.
- **Services à la carte** selon l'offre du point d'intérêt (station = carburant, hôtel = sommeil, garage = mécanique).

### Le duel à N voitures et les fautes
- **Strictement des duels à deux — jamais de bataille à trois simultanée** (clarification du 2026-10-14). Le jeu n'arbitre que des duels par paires, en chaîne : si trois voitures se suivent — la 1, la 2 et la 3 — la voiture 1 ne dispute **que** le duel contre la 2, et la voiture 2 **que** le duel contre la 3. Le duel « 1 contre 3 » **n'existe pas**. Deux duels adjacents (1↔2 et 2↔3) peuvent être actifs en même temps, mais ce sont **deux arbitrages indépendants, chacun à deux voitures** — aucune règle ne lit jamais un trio.
- **Le contact reste interdit en règle, mais peut arriver** — sa fréquence est **systémique** : c'est l'agressivité des stratégies des joueurs qui détermine le taux (des courses prudentes produisent peu de contacts).
- **L'attribution de la faute suit les règlements sportifs réels de course** :
  - *Attaque à l'intérieur* : l'attaquant doit être maître de sa voiture, ne pas plonger de façon excessive ou brutale, et placer **au minimum son essieu avant à hauteur du rétroviseur** du défenseur **au point de corde** ;
  - *Attaque à l'extérieur* : l'attaquant doit être **à hauteur ou devant** au point de corde pour exiger la largeur ;
  - *Côte à côte significatif* : chaque pilote doit **laisser l'espace** nécessaire à l'autre pour tourner sans le forcer hors piste.
- **Pénalité du fautif** : du temps (stop-and-go) **+ amende de budget dans certains cas**.
- **Aspiration confirmée entre toutes les voitures** — l'arme du poursuivant.
- **Voiture arrêtée** : rangée sur le bas-côté, hors trajectoire — les autres passent sans contrainte.

### L'information
- **Aléa mixte** : bulletins prévisionnels + surprises **déterministes côté serveur mais cachées** (l'incertitude vient de l'information non révélée, jamais du hasard de simulation).
- **Des adversaires, on ne voit que positions et écarts** ; leurs états internes sont cachés.
- **Pas de push** : à la reconnexion, un **journal chronologique détaillé** de chaque événement.

### L'identité et la vitrine
- **Nom d'équipe + livrée** (couleurs) : chaque voiture est reconnaissable de loin.
- **Engagement** : 2-3 consultations/jour suffisent pour un niveau standard ; la surveillance fait la différence au sommet.
- **Carte 2D pour jouer + vue 3D spectateur** : on « regarde la course ». La vue 3D (page spectateur séparée) : chase cam lissée sur la voiture suivée (orbite lente à l'arrêt), monde riche low-poly par biome (terrain, végétation, ponts à arche sur les ravins, tunnels sombres), cycle jour/nuit COMPLET calé sur l'horloge de Paris réelle — vraie nuit sombre à étoiles, aubes et crépuscules chauds — POI éclairés comme des balises de vie dans le noir, ciel annonçant la météo du biome (pluie = ciel lourd et nuages bas), voitures à roues tournantes et suspension branchée sur le cœur, poussière plus dense au désert. Ombres légères sur PC, flat shading mobile, qualité auto-dégradée sous 28 fps.
- **Onboarding : rien pour le moment** (décision explicite — éventuellement plus tard).

### Comptes, déroulé et interface (acté, mise en œuvre)

- **Pas d'auto-inscription** : l'admin crée les comptes (page admin). Mots de passe jamais en clair (scrypt + sel).
- **Déroulé d'une course** : préparation (compte à rebours, grille ouverte, réglages d'avant-course modifiables) → course (grille figée ; un absent part quand même avec son plan par défaut) → terminée (podium + résumé figés jusqu'au reset).
- **Interface « une voiture »** pour tous, y compris le super utilisateur : un joueur voit sa voiture en détail ; des autres, seulement position, nom et état visible. Le super utilisateur a un sélecteur discret de participant.
- **Arrêt de survie rétabli** (amendement ADR 0002) : après la durée paramétrée sans connexion de SON joueur, la voiture s'arrête à un point d'arrêt et ne repart qu'à sa reconnexion — distinct de l'arrêt bord de route pour fatigue critique.

### Le sel de la course (acté, mis en œuvre)

- **Contacts & fautes** : chaque MANŒUVRE de doublage lancée porte un risque dosé (constant exporté, tiré du PRNG semé du cœur — jamais Math.random). Gravité croissante avec le rythme du moment (fatigue + nuit + vitesse) : léger = échange de peinture + ralenti ; lourd = crevaison ou dégât réparable — jamais de fin de course par accident. Faute attribuée selon le règlement (intérieur = essieu avant au rétroviseur à la corde ; extérieur = à hauteur ou devant ; espace dû côte à côte) ; sans faute claire = incident de course. Pénalité : stop-and-go au prochain POI + amende si lourde. Journal public détaillé.
- **Agressivité de conduite** : la conduite a 3 niveaux d'agressivité (sécurité / standard / agressif) réglés dans le plan du joueur, comme le curseur moteur. Le sur-risque de l'agressif vient de la fréquence des manœuvres et de la pression permanente (il colle au devancier), jamais de la probabilité de contact par manœuvre — CONTACT_P est identique pour les trois niveaux, et CAR_D reste un mur physique que aucun niveau ne franchit. Le niveau d'un adversaire n'est pas visible (l'incertitude fait le sel).
- **Budget** : revenu périodique = base + bonus position + bonus de régularité (moitié rythme stable, moitié absence d'incident). Dépenses : carburant (€/L), pneus, réparations, amendes. Jauge € dans l'interface.
- **Gommes** : TENDRES (grip haut, usure rapide), DURES (grip moindre, usure lente), PLUIE (grip normal sous la pluie) — choisies à la préparation, changées au garage. La pluie par tronçon (déterministe) réduit μ : les pluie compensent, les secs y perdent. Crevaison surprise à gomme morte : mode dégradé 85 km/h jusqu'au garage.
- **Bulletins d'étape** : toutes les 3 h (constante exportée), biomes et météo des prochains tronçons — déterministes, lus sur l'état de la course.
- **CB de proximité** : canal global unique, anti-flood 1 message/5 s ; chaque équipe ne reçoit que les messages des équipes à ≤ 100 km. Bandeau direct + journal.

### Le monde et le tracé (design du 2026-10-14, mis en œuvre)

- **Chaque biome a son CARACTÈRE de tracé** — la géométrie change, pas seulement μ/crr :
  - *Plaine* : asphalte, route large, rythme fluide — le royaume du duel ;
  - *Forêt* : revêtement terre (μ plus bas même à sec), virages serrés et « aveugles », brume ;
  - *Désert* : longues droites VALLONNÉES (la dune creuse la pointe — le profil fait varier la vitesse en pleine ligne droite), sable, larges sections ;
  - *Altitude* : route ÉTROITE à 1 file (le duel côte à côte y est physiquement impossible — la garde anti-collision sépare en LONG), pierre, lacets marqués, PONTS sur les ravins et TUNNELS sous la roche (données du tracé par sample : terrain qui s'écarte du tracé, déterministes et régénérables à l'identique).
- **L'altitude suit le biome** : amplitude de relief par biome (le désert vallonne, l'altitude grimpe vers les cols), retour à la moyenne conservé.
- **Explorateur de graines** (page admin) : mini-carte vue de dessus, couleurs par biome, profil d'altitude, km par biome, virages par catégorie, densité POI — calculé par le MÊME code de génération que la course, puis l'admin lance le reset avec cette graine.
- **Fenêtre de préparation** (joueur) : carte complète + profil d'altitude + bandes de biomes le long de la course, un seul graphique mobile first ; POI non marqués.

## Questions encore ouvertes (équilibrage, à trancher en jeu)

- Paramètres exacts : plafond nuit (−X % ?), durées stop-and-go et amendes, seuils et taux du RNG de contact, formule du bonus de régularité, couplage dégradation/risque de la fatigue.
- Calendrier opérationnel des courses (dates précises).
- Ces réglages se feront **en condition réelle**, avec des courses tests — plus en théorie.

## Ce qui est déjà acté (structurel)

- **Serveur autoritaire** (ADR 0001) : simulation 24 h/24 sur le serveur, horloge Paris, clients navigateurs en lecture/stratégie.
- **Le joueur est stratège** (ADR 0002, amendé) : aucune entrée de pilotage, la stratégie est un plan exécuté en continu, arrêt de survie après 24 h sans connexion.
- **Moteur maison déterministe** (ADR 0004) : TypeScript pur, pas fixe 1/120 s, PRNG semé — replays, reprise serveur, équité.
- **Équité stricte** : même voiture pour tous ; l'asymétrie ne vient que des choix stratégiques et de la gestion du risque.
