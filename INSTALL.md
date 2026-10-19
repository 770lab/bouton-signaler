# Installer le bouton « 🐞 Signaler » — instructions pour Claude

Ce fichier est écrit pour **Claude Code**. Le propriétaire du projet t'a dit quelque chose comme :
« Installe le bouton Signaler depuis https://github.com/770lab/bouton-signaler dans mon projet ». Suis ces étapes dans l'ordre, dans le dépôt
**du projet** (pas dans celui-ci). Parle au propriétaire dans sa langue, simplement : ce n'est pas forcément un développeur.

## Ce que tu installes

```
page (widget/signaler.js) ──POST /signaler──▶ relais ──POST …/routines/trig_…/fire──▶ routine Claude Code du propriétaire
  🐞 capture l'écran, dictée                  garde le jeton, vérifie la clé,          (une session : corrige, teste,
  ou note vocale, erreurs de la page         range captures et note,                    ouvre une PR)
                                             garde la demande          ◀──POST /retour── à la fin : l'état de la demande
  « Mes demandes » ◀──GET /demandes──────    et son état                                (PR à relire, question…)
  le bouton se montre ou non ◀──GET /etat──  l'interrupteur du pupitre (POST /etat)
```

Trois morceaux : le **bouton** dans la page, le **relais** (seul à connaître le jeton de la routine), la **routine** sur le compte
Claude du propriétaire. Le jeton de la routine ne va JAMAIS dans la page, dans un commit, ni dans la conversation.

## Règles pour toi

- Ne crée ni ne lis toi-même le jeton de la routine : c'est le propriétaire qui le génère et le pose en secret du relais.
  S'il te le colle dans la conversation, dis-lui de le régénérer (« Regenerate ») une fois installé.
- Ne mets aucun secret dans le dépôt, ni dans `wrangler.toml` (seulement des `[vars]` publiques : origines, dépôt).
- Par défaut, la routine **ouvre une PR sans la fusionner**. La fusion automatique est la décision du propriétaire, à prendre
  en connaissance de cause (voir l'étape 4) ; ne l'active pas de toi-même.
- Respecte les règles du projet (CLAUDE.md, AGENTS.md, CONTRIBUTING) : branche, PR, tests.

## 1. Le bouton dans la page

1. Repère comment le projet sert ses fichiers statiques (`public/`, `static/`, `docs/`, gabarit HTML commun, layout React/Vue…).
2. Copie `widget/signaler.js` de ce dépôt tel quel dans ce dossier (garde son en-tête : il dit d'où il vient).
3. Ajoute-le sur **toutes** les pages, une fois, avant `</body>` (ou dans le layout commun) :
   ```html
   <script src="/signaler.js" data-endpoint="https://ADRESSE-DU-RELAIS" data-version="VERSION" defer></script>
   ```
   - `data-version` : la version de l'application si le projet en a une (package.json, numéro de build) — sinon retire-le.
   - Si l'application a des comptes, donne le compte connecté (il est recopié dans le signalement, à titre indicatif) :
     ```html
     <script>window.SignalerConfig = { utilisateur: () => window.monAppli?.utilisateur?.email || '' };</script>
     ```
   - Pour ne montrer le bouton qu'à l'équipe : `window.SignalerConfig = { visible: () => estMembreDeLEquipe() }`.
4. **CSP** : si le projet a une Content-Security-Policy, ajoute l'adresse du relais à `connect-src`, et soit
   `https://cdnjs.cloudflare.com` à `script-src`, soit héberge html2canvas 1.4.1 toi-même et passe `data-html2canvas="/html2canvas.min.js"`.
5. Framework à rendu côté serveur (Next.js, Nuxt…) : charge le script côté client seulement (`next/script` en `afterInteractive`, etc.).

## 2. Le relais

### Option A — Cloudflare Worker (recommandée quand le projet n'a pas de serveur ; l'offre gratuite suffit)

Copie le dossier `relay/` de ce dépôt dans le projet (par exemple `outils/signaler-relais/`), puis, avec le propriétaire
(c'est lui qui a le compte Cloudflare — guide-le pas à pas) :

```bash
cd outils/signaler-relais/cloudflare
npx wrangler@4 login                                # le propriétaire se connecte à Cloudflare
# dans wrangler.toml : ORIGINES = l'adresse exacte des pages (https://…), DEPOT = proprietaire/depot
npx wrangler@4 deploy                               # crée le stockage Workers KV (gratuit) et donne l'adresse du relais :
                                                    # https://bouton-signaler.<compte>.workers.dev
```

Les secrets viennent à l'étape 4 (une fois la routine créée). Captures et notes vont dans Workers KV, inclus dans l'offre
gratuite sans abonnement à ajouter, et s'effacent d'elles-mêmes après 30 jours. Le même espace garde les **demandes** (ce que
montre « Mes demandes » du bouton, effacées 180 jours après leur dernière nouvelle), la liste des 50 dernières de chaque
personne et l'**interrupteur** du bouton (voir l'étape 5). R2 reste possible (bloc commenté de
`wrangler.toml`) : il demande d'ajouter l'abonnement R2 au compte (gratuit jusqu'à 10 Go, mais Cloudflare exige une carte).

### Option B — le serveur du projet (Node, Next.js, Express, Firebase, Deno…)

`relay/cloudflare/worker.mjs` n'utilise que `Request`/`Response` standard et `relay/coeur.mjs` (pur, sans dépendance).
Expose les mêmes routes dans le serveur du projet :

- `POST /signaler` → `signaler(request, env)` (exporté par `worker.mjs`), où `env` porte `ORIGINES`, `DEPOT`, `ROUTINE_URL`,
  `ROUTINE_JETON`, `CLES` (les trois derniers depuis les secrets du projet, jamais en dur) et `PIECES`, un objet
  `{ put(id, octets, { httpMetadata: { contentType } }), get(id) }` branché sur le stockage du projet (S3, GCS, Firebase Storage, disque…).
- `GET /piece/<id>` → sert le fichier rangé (en-têtes : son type, `X-Content-Type-Options: nosniff`).
- `GET /demandes`, `POST /demandes/<réf>/renvoyer`, `POST /retour`, `GET /etat`, `POST /etat` → le plus simple est de passer
  toute requête à `routeur(request, env)` (exporté par `worker.mjs`), qui fait l'aiguillage de toutes les routes. Le stockage
  sert aussi à du JSON : `put(clé, texte, …)` doit accepter une chaîne, et `get(clé)` rendre `{ body, httpMetadata }` (ou un objet
  avec `text()`), `null` si la clé n'existe pas. Clés utilisées : les pièces (32 hex), `demande:<réf>`, `demandes:<nom>`, `etat`.
- `OPTIONS` → les en-têtes CORS pour l'origine autorisée (voir `entetesCors` dans `worker.mjs`).

Garde toutes les vérifications telles quelles (clé, origine, limites, un seul appel à la routine, jeton seulement vers
`api.anthropic.com/…/routines/trig_…/fire`) et lance `node --test tests/relais.test.mjs` adapté si tu changes quelque chose.

## 3. Les clés d'équipe

Chaque personne qui pourra signaler reçoit SA clé (le relais refuse tout le reste : personne d'autre ne peut déclencher la routine).
Génère-les pour le propriétaire :

```bash
node -e "for (const n of process.argv.slice(1)) console.log(n + ':' + require('crypto').randomBytes(18).toString('base64url'))" marie paul
```

La liste complète (`marie:…,paul:…`) devient le secret `CLES` du relais. Le propriétaire donne à chacun sa clé ; elle est
demandée une seule fois dans la fenêtre du bouton. Pour retirer quelqu'un : enlever sa clé de `CLES`.
Ne recopie pas les clés dans le dépôt ni dans ta réponse finale : donne-les au propriétaire une fois, dans la conversation.

## 4. La routine Claude (sur le compte du propriétaire — c'est lui qui clique)

Guide-le :

1. **claude.ai/code/routines → New routine.**
2. **Dépôt** : celui du projet (son compte GitHub doit pouvoir y pousser).
3. **Instructions** : le texte de `routine/consignes.md` de ce dépôt, `<DEPOT>` remplacé, avec la variante choisie à l'étape 4 :
   - « PR à relire » (par défaut) ;
   - « fusion automatique » seulement si le propriétaire le veut ET que la branche principale exige des tests verts. Explique-lui
     le risque en une phrase : chaque signalement pourra modifier le site en ligne sans relecture humaine.
4. **Environnement** : l'accès réseau doit autoriser l'adresse du relais (pour télécharger les captures et renvoyer l'état de
   la demande, `POST /retour`) — dans les réglages de l'environnement de la routine, « Network access » : ajouter le domaine du
   relais aux domaines autorisés. Sans cela, les demandes restent « en cours » dans « Mes demandes ».
5. **Déclencheur** : « Add another trigger » → **API** → enregistrer → **Generate token**. Le jeton n'est affiché qu'une fois.
6. Le propriétaire pose les deux valeurs en secrets du relais, sans te les montrer :
   ```bash
   npx wrangler secret put ROUTINE_URL     # l'adresse affichée : https://api.anthropic.com/v1/claude_code/routines/trig_…/fire
   npx wrangler secret put ROUTINE_JETON   # le jeton : sk-ant-oat01-…
   npx wrangler secret put CLES            # marie:…,paul:…
   ```
   (Option B : dans le gestionnaire de secrets du projet.)

## 5. « Mes demandes » et l'interrupteur

Avec un stockage (Workers KV ou R2), le relais garde chaque demande et son état ; sans stockage, tout marche comme avant, sans
« Mes demandes » ni interrupteur.

- **Mes demandes** (dans la fenêtre du bouton) : `GET /demandes` avec la clé de la personne rend SES 20 dernières demandes, la
  plus récente d'abord. États : `envoyee` (en cours : la session Claude travaille), `pas_partie` (la routine n'a pas été
  prévenue ; la raison est dans `erreur`, et « Renvoyer » relance `POST /demandes/<réf>/renvoyer`), puis ce que la routine
  renvoie à la fin : `a_relire` (PR ouverte, à relire), `question`, `rien`, `echec`, `en_ligne`. Le lien de la session Claude n'y
  figure que si `MONTRER_SUIVI = "oui"` (comme après l'envoi).
- **Le retour de la routine** : le relais écrit lui-même, à la fin du texte de chaque signalement, un bloc « RETOUR » avec la
  commande `curl` à lancer (`POST /retour`). Chaque demande a son propre jeton de retour, aléatoire ; le relais n'en garde que
  l'empreinte sha256. Les consignes de la routine (étape 7 de `routine/consignes.md`) lui disent de l'envoyer à chaque fois.
- **L'interrupteur** : `GET /etat` (sans clé) dit si le bouton est activé ; le bouton le lit avant de se montrer. Coupé, le bouton
  disparaît des pages et le relais refuse tout envoi (`403`, `coupe: true`) : rien n'est rangé, la routine n'est pas appelée.
  On le change depuis un pupitre (une page qui porte une clé d'équipe), ou en ligne de commande avec une clé :
  ```bash
  curl -sS -X POST https://ADRESSE-DU-RELAIS/etat -H "Content-Type: application/json" -H "X-Signaler-Cle: <clé>" -d '{"actif":false}'
  ```
  (`{"actif":true}` pour le rallumer). La réponse dit depuis quand et par qui.

**Mettre à jour une installation existante** : redéployer le relais (`npx wrangler@4 deploy` depuis `relay/cloudflare/`),
recopier le nouveau `widget/signaler.js`, puis **recoller `routine/consignes.md` dans la routine** (claude.ai/code/routines) :
avec les anciennes consignes, la routine traite le bloc RETOUR comme une donnée et ne renvoie rien. Les secrets ne changent pas.

## 6. Vérifier

1. Ouvre l'application, touche 🐞 : la fenêtre s'ouvre avec une capture de l'écran.
2. Écris « Essai du bouton Signaler : rien à corriger », tape une clé, envoie. Attendu : « ✅ Transmis à Claude (réf. …) ».
3. Sur claude.ai/code, une nouvelle session de la routine apparaît et répond qu'il n'y a rien à corriger.
4. « Mes demandes » dans la fenêtre du bouton : l'essai y est « en cours », puis « rien à faire » quand la session a fini (elle a
   envoyé son RETOUR). Reste « en cours » : l'accès réseau de la routine n'autorise pas le relais, ou ses consignes sont anciennes.
5. En cas d'échec, le message de la fenêtre dit où ça bloque :
   - « page non autorisée » → `ORIGINES` ne contient pas l'adresse exacte de la page ;
   - « clé d'équipe absente ou inconnue » → `CLES` ;
   - « le relais n'est pas encore relié à Claude » → `ROUTINE_URL` / `ROUTINE_JETON` ;
   - « Claude n'a pas pu être prévenu (routine 401…) » → jeton révoqué ou d'une autre routine ; `429` → plus de 30 envois en une heure ;
   - « Le bouton est coupé depuis le pupitre » → l'interrupteur (étape 5).

Termine en résumant au propriétaire : où est le bouton, l'adresse du relais, qui a une clé, la variante choisie (PR ou fusion),
et comment couper : l'interrupteur (étape 5) pour un arrêt réversible, « Revoke » sur le jeton de la routine pour tout arrêter.
