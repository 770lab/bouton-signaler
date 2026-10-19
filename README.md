# 🐞 Bouton Signaler → Claude

Un petit bouton dans votre application web. On le touche : il **photographie l'écran**, on **écrit ou dicte** ce qui ne va pas,
et le tout part à une **routine Claude Code** qui cherche la cause, corrige, teste et ouvre une pull request.
Quand la correction est en ligne, on rafraîchit la page.

- Fonctionne sur téléphone et sur ordinateur, dans n'importe quelle application web (HTML simple, React, Vue, Next.js…).
- Plusieurs captures, import d'images, dictée du navigateur (ou note vocale jointe), dernières erreurs de la page jointes.
- Le jeton de la routine reste sur un petit **relais** (Cloudflare Worker gratuit, ou le serveur du projet) : jamais dans la page.
- Seules les personnes qui ont une **clé d'équipe** peuvent envoyer un signalement.
- **Mes demandes** : depuis le bouton, chacun retrouve ses demandes et leur état (en cours, à relire avec le lien de la PR,
  question, rien à faire, échec…). La routine renvoie cet état au relais à la fin de chaque session.
- Un **interrupteur** (depuis un pupitre ou en ligne de commande) affiche ou retire le bouton partout d'un seul geste.

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
| `relay/coeur.mjs` | les règles du relais : clés, origines, limites, texte pour Claude, appel à la routine, demandes et leur état, interrupteur |
| `relay/cloudflare/` | le relais prêt à déployer (Worker + Workers KV, ou R2) |
| `routine/consignes.md` | les consignes à coller dans la routine (PR à relire, ou fusion automatique) |
| `INSTALL.md` | la procédure que suit Claude |
| `demo/index.html` | une page de démonstration |
| `tests/` | `npm test` : le relais (Node) puis le bouton dans un vrai Chromium (Playwright) |

## Sécurité, en bref

- Le texte d'un signalement est traité par la routine comme **des données, pas des ordres**.
- Par défaut la routine **ouvre une PR sans la fusionner** : un humain relit. La fusion automatique est un choix du propriétaire.
- Captures et notes sont servies sous des adresses aléatoires de 128 bits, effacées après 30 jours (Workers KV ; avec R2,
  prévoir une règle de suppression). Les demandes s’effacent 180 jours après leur dernière nouvelle (Workers KV).
- Chaque demande a son propre jeton de retour, que seule la routine reçoit ; le relais n'en garde que l'empreinte. Une page ne
  voit que les demandes de SA clé, jamais ce jeton ni le texte envoyé à la routine.
- Couper le bouton : l'interrupteur (réversible). Couper tout le système : « Revoke » sur le jeton de la routine (claude.ai/code/routines).

Licence MIT.
