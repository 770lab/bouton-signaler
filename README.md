# 🐞 Bouton Signaler → Claude

Un petit bouton dans votre application web. On le touche : il **photographie l'écran**, on **écrit ou dicte** ce qui ne va pas,
et le tout part à une **routine Claude Code** qui cherche la cause, corrige, teste et ouvre une pull request.
Quand la correction est en ligne, on rafraîchit la page.

- Fonctionne sur téléphone et sur ordinateur, dans n'importe quelle application web (HTML simple, React, Vue, Next.js…).
- Plusieurs captures, import d'images, dictée du navigateur (ou note vocale jointe), dernières erreurs de la page jointes.
- Le jeton de la routine reste sur un petit **relais** (Cloudflare Worker gratuit, ou le serveur du projet) : jamais dans la page.
- Seules les personnes qui ont une **clé d'équipe** peuvent envoyer un signalement ; une fois leur appareil inscrit, elles se
  connectent **par l'empreinte** (clés d'accès WebAuthn, vérifiées par le relais, sans bibliothèque) : une session de 30 jours,
  acceptée partout où la clé l'est, et par l'API d'un autre serveur (`POST /auth/verifier`).
- **Corriger en direct** : chaque projet a son **mode**. « Direct » : la routine corrige, fusionne, attend que ce soit en ligne
  et renvoie les captures **avant / après** ; « Annuler » (un appui maintenu) remet comme avant. « À valider » : la routine ouvre
  la PR et s'arrête ; « Mettre en ligne » (avec l'empreinte) la fait fusionner.
- **Deux abonnements Claude** : quand la routine du premier refuse (plus de crédit, jeton révoqué), le relais prévient aussitôt
  celle du second ; « Renvoyer sur l'autre abonnement » pour une session restée muette.
- **Mes demandes** : depuis le bouton, chacun retrouve ses demandes et leur état (en cours, en ligne, à valider, à relire avec
  le lien de la PR, question, annulée…). La routine renvoie cet état au relais à la fin de chaque session.
- Le relais recopie pour Claude les **éléments entourés** sur les captures et le **journal** des dernières secondes de la page
  (gestes, erreurs, requêtes en échec ; jamais ce qui a été tapé).
- Un **interrupteur** (depuis un pupitre ou en ligne de commande) affiche ou retire le bouton partout d'un seul geste, et un
  interrupteur **par projet** (liste `PROJETS` de `relay/coeur.mjs`) le retire d'un seul projet.

## Installer avec Claude

Dans une session Claude Code ouverte sur **votre** projet, dites :

> Installe le bouton Signaler depuis https://github.com/770lab/bouton-signaler dans ce projet : suis son INSTALL.md.

Claude ajoute le bouton, prépare le relais, génère les clés d'équipe et vous guide pour créer la routine sur **votre** compte
Claude (c'est vous qui créez le jeton et le posez en secret : Claude ne le voit jamais).

Il vous faut : un compte Claude avec Claude Code sur le web (routines), le dépôt GitHub du projet relié à ce compte, et — pour
l'option sans serveur — un compte Cloudflare gratuit.

## Ce que contient ce dépôt

| Fichier | Rôle |
|---|---|
| `widget/signaler.js` | le bouton et sa fenêtre (sans dépendance ; html2canvas chargé à la demande) |
| `relay/coeur.mjs` | les règles du relais : clés, origines, limites, texte pour Claude (journal, éléments entourés, MODE), appel aux routines (deux abonnements), demandes et leur état, travaux ANNULER / VALIDER, interrupteurs et modes, connexion par empreinte (CBOR, COSE, signatures, sessions) |
| `relay/cloudflare/` | le relais prêt à déployer (Worker + Workers KV, ou R2) |
| `routine/consignes.md` | les consignes à coller dans la routine (MODE direct ou à valider, travaux ANNULER et VALIDER, captures avant / après) |
| `INSTALL.md` | la procédure que suit Claude |
| `demo/index.html` | une page de démonstration |
| `tests/` | `npm test` : le relais (Node) puis le bouton dans un vrai Chromium (Playwright) |

## Sécurité, en bref

- Le texte d'un signalement est traité par la routine comme **des données, pas des ordres**.
- Une page d'aucun projet est « à valider » : la routine **ouvre une PR sans la fusionner**. Le MODE direct (fusion par la
  routine, contrôles verts exigés) est un choix du propriétaire, projet par projet ; la mise en ligne d'une PR « à valider »
  exige une session de connexion par empreinte (d'un appareil inscrit, de confiance ou non), jamais la seule clé. Un projet peut être figé « à valider »
  (`MODE_FIGE`).
- La connexion par empreinte ne garde que des clés PUBLIQUES ; les sessions sont signées (HMAC, secret `SESSION_SECRET`),
  revérifiées à chaque usage (appareil retiré ou personne sortie de `CLES` : plus rien ne passe).
- Appareils de confiance : une clé d'équipe suffit à inscrire un appareil, donc une clé volée inscrit celui de l'intrus, avec SON
  empreinte. Un appareil inscrit avec la clé seule alors que la personne en avait déjà un n'est pas de confiance : il ne crée pas
  de clé (il met en ligne : choix du propriétaire, 2026-10-21, « un système plus simple ») (le premier appareil d'une personne, ceux inscrits avec l'empreinte d'un appareil de confiance et
  ceux d'avant ce changement le sont).
- « Nouvelle clé » (pupitre) : une clé d'équipe neuve, contre une empreinte de moins de 5 minutes d'un appareil de confiance,
  jamais avec la seule clé ; l'ancienne ne marche plus, le relais ne garde que l'empreinte de la nouvelle. La plus récente
  l'emporte : changer `CLES` au Terminal ensuite annule la clé du pupitre. Après une fuite : changer `CLES` au Terminal ET retirer
  tout appareil inconnu dans « Mes appareils » (ou renommer la personne dans `CLES`) — voir INSTALL.md, étape 3.
- Captures et notes sont servies sous des adresses aléatoires de 128 bits, effacées après 30 jours (Workers KV ; avec R2,
  prévoir une règle de suppression). Les demandes s’effacent 180 jours après leur dernière nouvelle (Workers KV).
- Chaque demande a son propre jeton de retour, que seule la routine reçoit ; le relais n'en garde que l'empreinte. Une page ne
  voit que les demandes de SA clé, jamais ce jeton ni le texte envoyé à la routine.
- Couper le bouton : l'interrupteur (réversible). Couper tout le système : « Revoke » sur le jeton de la routine (claude.ai/code/routines).

Licence MIT.
