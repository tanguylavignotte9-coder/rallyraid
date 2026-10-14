# ADR 0005 (amendement) — Workflow « prompts Work → codage Code »- **Statut** : amendement accepté (2026-10-14)## ContexteDepuis les premières sessions, le mode de collaboration a évolué : l'auteur prépare désormais ses *prompts d'intégration dans Work* (module de préparation de missions), puis les soumet au **module Code** où Vibe exécute. L'ADR 0005 d'origine décrivait l'écriture directe en mode chat ; ce workflow structuré le remplace depuis le 2026-10-14.## Décision- L'ADR 0005 reste valable dans son esprit (Vibe écrit directement dans le dépôt, l'auteur valide le design) ; son mode opératoire est amendé : **les prompts sont préparés dans Work, le codage a lieu dans le module Code**.- Les règles de fond sont inchangées : validation de l'auteur pour tout ce qui engage le design, CI verte pour le code, l'auteur unique décideur de game design.## Conséquences- Les sessions de chat brut ne sont plus le canal de livraison ; le dépôt reste la mémoire structurelle (ADR, docs, code).EOF
python3 - <<'PYEOF'
p='README.md'
s=open(p,encoding='utf-8').read()
# tests : 15 → 25, 3 fichiers, descriptions à jour
s=s.replace("- Les **15 tests** garantissent",
            "- Les **25 tests** (3 fichiers : `core`, `route`, `race`) garantissent")
import re
s=s.replace("""Les **25 tests** (3 fichiers : `core`, `route`, `race`) garantissent notamment : deux courses de la même graine sont identiques image par image ; un tour complet se boucle au temps de référence sans dépasser l'adhérence des pneus ; un duel de 15 minutes produit des tentatives de doublage mais zéro contact ; la course reprise après sérialisation est identique au bit près.""",
"""Les **25 tests** (3 fichiers : `core`, `route`, `race`) garantissent notamment : déterminisme bit à bit (moteur, route, course — y compris les contacts et la reprise après sérialisation) ; continuité aux frontières de chunks ; arrêt de survie (stop sans connexion, reprise à la reconnexion) ; bride de nuit (multiplicateur et plafond) ; contacts et fautes (une course prudente ne produit presque rien) ; budget (revenus, dépenses, amendes) ; usure relative des gommes ; bulletins d'étape.""")
# structure du dépôt : citer les 3 fichiers de tests
s=s.replace("| `tests/core.test.ts` | Non-régression : déterminisme au bit près, tour de référence dans le budget de grip, duel sans contact. |",
"""| `tests/core.test.ts` | Moteur : déterminisme au bit près, tour de référence dans le budget de grip, duel sans contact. |
| `tests/race.test.ts` | Course : plans, survie, bride de nuit, contacts/fautes, budget, gommes, bulletins, reprise. |""")
# /api/state : météo par voiture
s=s.replace("| `GET /api/state` | Classement public + SA voiture en détail (session requise) |",
"| `GET /api/state` | Classement public + SA voiture en détail ; `hour` (Paris), météo et `pos3` par voiture |")
# ADR 0005 ligne
s=s.replace("5. `0005` — Le dépôt est écrit directement par Vibe (l'agent), sur validation de l'auteur",
"5. `0005` — Le dépôt est écrit directement par Vibe (l'agent), sur validation de l'auteur — amendé : prompts préparés dans Work, codage dans le module Code")
open(p,'w',encoding='utf-8').write(s)
print('readme ok')
PYEOF
grep -n "25 tests" README.md | head -2