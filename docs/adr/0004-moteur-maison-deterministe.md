# ADR 0004 — Moteur physique maison, déterministe, pas de temps fixe

- **Statut** : accepté (2026-10-14) — entérine des mois de prototype

## Contexte

Le cœur physique (`core/engine.ts`) a été développé et validé image par image sur un prototype de course-duelle : cercle de friction (le frein et le virage partagent le budget du pneu, ellipse), aspiration aéro, chaînes de freinage par induction arrière, IA de conduite honnête (elle subit la même physique), règle de la corde pour les doublages, anti-collision symétrique. Des tests garantissent : déterminisme au bit près, tour de référence sans dépassement d'adhérence, duel de 15 minutes sans contact.

## Décision

- **Un seul moteur maison en TypeScript pur**, sans dépendance (pas de moteur physique externe, pas de lib de jeu). Motifs : (1) un moteur générique ne modélise pas le cercle de friction tel que conçu ; (2) un moteur externe (Box2D, PhysX…) n'est **pas déterministe multi-plateforme**, ce qui tue les replays et la simulation serveur reproductible ; (3) le modèle actuel est déjà validé.
- **Pas de temps fixe 1/120 s**, aucune flottabilité dans la boucle de simulation : le serveur rattrape son retard en rejouant des pas entiers (catch-up), jamais en dilatant dt.
- **Aucune source de hasard hors graine** : PRNG `mulberry32` semé ; interdiction d'`Math.random()`, `Date.now()` ou équivalents dans le cœur.
- **Zéro dépendance du cœur** : pas de DOM, pas de réseau, pas de three.js — testable en ligne de commande, exécutable sur serveur.

## Conséquences

- Toute évolution physique passe par les tests de non-régression (les seuils : grip ≤ 1,05, contact = 0, temps au tour de référence).
- La maintenance du moteur repose sur ce dépôt — documenter chaque décision de réglage (voir aussi l'historique d'itération du prototype dans le canvas `raid-duel`).
- Si un jour une brique externe s'avérait nécessaire (collisions complexes ?), elle devrait prouver son déterminisme avant d'entrer dans le cœur.
