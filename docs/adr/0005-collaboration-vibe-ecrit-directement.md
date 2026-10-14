# ADR 0005 — Le dépôt est écrit directement par Vibe (l'agent), sur validation de l'auteur

- **Statut** : accepté (2026-10-14)

## Contexte

L'auteur n'a pas de compétence en codage. Sur le projet voisin (Course-du-Pacifique), le mode de collaboration était : Vibe livre des *prompts d'intégration* que l'auteur applique lui-même au dépôt via un autre outil. Pour Rally Raid, l'auteur a confirmé que l'agent peut **écrire directement** dans ce dépôt via l'intégration GitHub, ici même, en mode chat.

## Décision

- Vibe écrit directement dans le dépôt `rallyraid` : commits, branches, fichiers — via l'intégration GitHub, **après validation de l'auteur dans le chat** pour tout ce qui engage le design (ADR, game design) et après passage au vert de la CI pour le code.
- L'auteur reste l'**unique décideur de game design** ; Vibe est responsable de la technique, de la qualité (tests, CI) et de la cohérence avec les ADR.
- Le mode « prompts d'intégration » **reste la règle pour le dépôt Course-du-Pacifique**, qui n'est pas concerné par cet ADR.
- Le Knowledge de chat (base de connaissances personnelle) conserve la mémoire des sessions d'itération (diagnostics, pièges techniques, décisions) ; ce dépôt conserve la mémoire structurelle (ADR, docs, code). En cas de divergence, le dépôt fait foi pour le code, le Knowledge pour l'historique des itérations.

## Conséquences

- Un commit = une intention expliquée dans le chat ; pas de push silencieux.
- L'auteur vérifie via la CI (onglet *Actions*) : ✔ vert = sain, sans lire le code.
- Les sessions de travail se terminent par une mise à jour du Knowledge (ce qui a été fait, ce qui a échoué, ce qui reste à faire) pour que la session suivante reparte du bon état.
