# ADR 0003 — Navigateur uniquement, PC et mobile

- **Statut** : accepté (2026-10-14)

## Contexte

Les participants jouent « depuis leur interface du navigateur ou navigateur mobile ». Aucune exigence d'application native, de store, ni de hors-ligne complet.

## Décision

- Client **web uniquement**, conçu **d'abord pour mobile** (contraintes d'écran les plus fortes) puis étendu au desktop, pas l'inverse.
- Pas d'application native, pas d'Electron/Tauri. Le rendu de la carte de course et des tableaux doit tenir dans un navigateur standard.
- L'application mobile doit rester utilisable en **3G dégradée** : télémétrie agrégée, rafraîchissement modéré, pas de vidéo temps réel indispensable.

## Conséquences

- Le rendu 3D du prototype (three.js) reste pour le spectateur curieux sur PC ; l'interface **stratège** est avant tout cartes et tableau — légère par nature.
- Pas de pipeline de build natif à maintenir ; la logique d'app est du web standard.
- PWA (installable, notifications) reste possible plus tard si le besoin apparaît — c'est du web, ça n'est pas exclu par cette décision.
