# Installer le bouton « 🐞 Signaler » — instructions pour Claude

Ce fichier est écrit pour **Claude Code**. Le propriétaire du projet t'a dit quelque chose comme :
« Installe le bouton Signaler depuis https://github.com/770lab/bouton-signaler dans mon projet ». Suis ces étapes dans l'ordre, dans le dépôt
**du projet** (pas dans celui-ci). Parle au propriétaire dans sa langue, simplement : ce n'est pas forcément un développeur.

## Ce que tu installes

```
page (widget/signaler.js) ──POST /signaler──▶ relais ──POST …/routines/trig_…/fire──▶ routine Claude Code du propriétaire
  capture l'écran, dictée                    garde les jetons, vérifie la clé           (une session : corrige, teste, ouvre
  ou note vocale, erreurs, éléments          ou la session, range captures et note,      une PR ; en MODE direct, fusionne et
  entourés, journal de la page               écrit le MODE du projet,                    attend que ce soit en ligne)
                                             abonnement 1, sinon abonnement 2
                                             garde la demande          ◀──POST /retour── à la fin : l'état, les captures
  « Mes demandes » ◀──GET /demandes──────    et son état                                avant / après, de quoi annuler
  Annuler / Mettre en ligne ──POST /demandes/<réf>/annuler|valider──▶ un travail ANNULER ou VALIDER pour la routine
  le bouton se montre ou non ◀──GET /etat──  interrupteurs et modes (POST /etat), abonnements (GET / POST /routine)
  « Se connecter avec l'empreinte » ──/auth/…──▶ clés d'accès (WebAuthn) → session de 12 h ◀──POST /auth/verifier── un autre serveur
```

Trois morceaux : le **bouton** dans la page, le **relais** (seul à connaître les jetons des routines), la **routine** sur le compte
Claude du propriétaire (deux routines s'il a deux abonnements). Un jeton de routine ne va JAMAIS dans la page, dans un commit, ni
dans la conversation ; le secret des sessions (`SESSION_SECRET`) non plus.

## Règles pour toi

- Ne crée ni ne lis toi-même le jeton de la routine : c'est le propriétaire qui le génère et le pose en secret du relais.
  S'il te le colle dans la conversation, dis-lui de le régénérer (« Regenerate ») une fois installé. Même règle pour
  `SESSION_SECRET` : c'est lui qui le tire au hasard et le pose (étape 4), sans te le montrer.
- Ne mets aucun secret dans le dépôt, ni dans `wrangler.toml` (seulement des `[vars]` publiques : origines, dépôt).
- Le **mode** de chaque projet (étape 5) décide si la routine fusionne elle-même (« direct ») ou s'arrête à la PR (« à valider »,
  et toujours pour une page d'aucun projet). Le mode direct est la décision du propriétaire, projet par projet, à prendre en
  connaissance de cause (chaque signalement pourra changer le site en ligne sans relecture humaine ; « Annuler » le remet comme
  avant) ; ne l'active pas de toi-même.
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
  `ROUTINE_JETON`, `CLES`, et s'il y a lieu `ROUTINE_URL_2`, `ROUTINE_JETON_2`, `SESSION_SECRET` (les secrets depuis le
  gestionnaire de secrets du projet, jamais en dur) et `PIECES`, un objet `{ put(id, octets, { httpMetadata: { contentType } }),
  get(id), delete(id) }` branché sur le stockage du projet (S3, GCS, Firebase Storage, disque…).
- `GET /piece/<id>` → sert le fichier rangé (en-têtes : son type, `X-Content-Type-Options: nosniff`).
- Toutes les autres routes (`GET /demandes`, `POST /demandes/<réf>/renvoyer|annuler|valider`, `POST /retour`, `GET / POST /etat`,
  `GET / POST /routine`, `/auth/…`) → le plus simple est de passer toute requête à `routeur(request, env)` (exporté par
  `worker.mjs`), qui fait l'aiguillage. Le stockage sert aussi à du JSON : `put(clé, texte, …)` doit accepter une chaîne, et
  `get(clé)` rendre `{ body, httpMetadata }` (ou un objet avec `text()`), `null` si la clé n'existe pas ; `delete(clé)` (sans lui,
  le relais écrit une « pierre tombale » lue comme absente). Clés utilisées : les pièces (32 hex), `demande:<réf>`,
  `demandes:<nom>`, `etat`, `routine`, `defi:<défi>`, `appareil:<id>`, `appareils:<nom>`, `personne:<nom>`, `cle:<nom>`.
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
demandée une seule fois dans la fenêtre du bouton. Pour retirer quelqu'un : enlever sa clé de `CLES` (ses appareils inscrits
pour l'empreinte ne valent plus rien non plus). Une personne qui ne se connecte plus que par l'empreinte GARDE sa clé dans
`CLES` : c'est la liste de l'équipe.
Ne recopie pas les clés dans le dépôt ni dans ta réponse finale : donne-les au propriétaire une fois, dans la conversation.

**Une nouvelle clé sans Terminal** (relais avec stockage et `SESSION_SECRET`) : dans le pupitre, carte « Mes appareils »,
« Nouvelle clé » puis l'empreinte. Le relais (`POST /auth/cle/nouvelle`) exige une empreinte de moins de 5 minutes (une clé
d'équipe seule ne suffit pas : une clé volée ne peut pas en créer une autre), tire une clé de 24 caractères, la rend UNE fois et
n'en range que l'empreinte sous `cle:<nom>`. Dès lors, la clé que `CLES` donnait à cette personne ne marche plus ; une nouvelle
création remplace la précédente. Workers KV met jusqu'à une minute à le savoir partout. Le Terminal reste le secours : changer
`CLES` (une autre clé pour ce nom) rend la clé de `CLES` valable de nouveau, à côté de celle du pupitre. Retirer la personne de
`CLES` retire tout, sa clé du pupitre comprise (la remettre sous le même nom la rend valable de nouveau). Pour annuler seulement
la clé du pupitre : en créer une autre, ou effacer `cle:<nom>` (`npx wrangler@4 kv key delete --binding PIECES_KV --remote "cle:<nom>"`).

## 4. La routine Claude (sur le compte du propriétaire — c'est lui qui clique)

Guide-le :

1. **claude.ai/code/routines → New routine.**
2. **Dépôt** : celui du projet (son compte GitHub doit pouvoir y pousser).
3. **Instructions** : le texte de `routine/consignes.md` de ce dépôt, `<DEPOT>` remplacé. Il n'y a plus de variante à choisir :
   le relais écrit dans chaque signalement le MODE du projet (« direct » ou « à valider », étape 5), et la routine suit ce MODE.
   Pour le mode direct, la routine doit pouvoir fusionner les PR du dépôt (contrôles obligatoires verts) ; sinon elle s'arrête
   à la PR et le dit.
4. **Environnement** : l'accès réseau doit autoriser l'adresse du relais (pour télécharger les captures et renvoyer l'état de
   la demande, `POST /retour`) et celle du site (vérifier en ligne, captures avant / après) — dans les réglages de
   l'environnement de la routine, « Network access » : ajouter ces domaines aux domaines autorisés. Sans le relais, les demandes
   restent « en cours » dans « Mes demandes ».
5. **Déclencheur** : « Add another trigger » → **API** → enregistrer → **Generate token**. Le jeton n'est affiché qu'une fois.
6. Le propriétaire pose les valeurs en secrets du relais, sans te les montrer :
   ```bash
   npx wrangler secret put ROUTINE_URL     # l'adresse affichée : https://api.anthropic.com/v1/claude_code/routines/trig_…/fire
   npx wrangler secret put ROUTINE_JETON   # le jeton : sk-ant-oat01-…
   npx wrangler secret put CLES            # marie:…,paul:…
   openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET   # la connexion par empreinte (32 caractères au moins)
   ```
   (Option B : dans le gestionnaire de secrets du projet.) Sans `SESSION_SECRET`, les routes `/auth` répondent `503`
   « connexion par empreinte pas encore réglée » et tout le reste marche avec les clés. Le changer déconnecte tout le monde
   (les sessions en cours ne valent plus ; les appareils inscrits restent).
7. **Un second abonnement Claude** (facultatif) : la même routine (mêmes dépôt, consignes, accès réseau) créée sur l'autre compte
   Claude, avec son déclencheur API, puis :
   ```bash
   npx wrangler secret put ROUTINE_URL_2
   npx wrangler secret put ROUTINE_JETON_2
   ```
   Le relais prévient le second quand le premier refuse (voir l'étape 5, « Deux abonnements »).

## 5. « Mes demandes » et l'interrupteur

Avec un stockage (Workers KV ou R2), le relais garde chaque demande et son état ; sans stockage, tout marche comme avant, sans
« Mes demandes » ni interrupteur.

- **Mes demandes** (dans la fenêtre du bouton) : `GET /demandes` avec la clé de la personne rend SES 20 dernières demandes, la
  plus récente d'abord (avec la clé ou la session). États : `envoyee` (en cours : la session Claude travaille), `pas_partie` (la
  routine n'a pas été prévenue ; la raison est dans `erreur`, et « Renvoyer » relance `POST /demandes/<réf>/renvoyer`),
  `en_cours_annulation`, `en_cours_validation` (un travail ANNULER ou VALIDER), puis ce que la routine renvoie à la fin :
  `en_ligne`, `a_valider`, `a_relire` (PR ouverte, à relire), `question`, `rien`, `echec`, `annulee`. « À traiter » : `question`,
  `a_relire`, `a_valider`, `pas_partie` (`A_TRAITER` de `coeur.mjs`, libellés français dans `LIBELLES_ETATS`). Chaque demande
  porte aussi `mode`, `abonnement` (« 1 » ou « 2 »), `envoyeLeMs`, et, quand la routine les a renvoyés, `images`
  (`{ avant, apres }` : des adresses du relais), `annulation`, `apercu` ; `actions` liste ce que la page peut proposer
  (`annuler`, `valider`, `renvoyer`). Le lien de la session Claude n'y figure que si `MONTRER_SUIVI = "oui"` (comme après l'envoi).
- **Le retour de la routine** : le relais écrit lui-même, à la fin du texte de chaque signalement, un bloc « RETOUR » avec la
  commande `curl` à lancer (`POST /retour`) et la ligne `MODE : direct` ou `MODE : à valider`. Chaque demande a son propre jeton
  de retour, aléatoire ; le relais n'en garde que l'empreinte sha256, et chaque nouvel envoi (renvoi, ANNULER, VALIDER) en tire un
  neuf. Le corps (5 Mo au plus) porte `etat`, `resume`, `liens`, et peut porter `images` (`{ "avant": "data:image/jpeg;base64,…",
  "apres": … }`, 1,5 Mo au plus chacune, rangées 180 jours et servies sous `/piece/<id>`), `annulation` (`{ depot, commits,
  branche, autres? }`) et `apercu` (un lien https). Les consignes de la routine (« Le RETOUR, toujours ») lui disent de l'envoyer
  à chaque fois.
- **Ce que le relais recopie pour Claude** : les éléments entourés sur les captures (`contexte.elements`, 10 au plus : chemin,
  balise, id, classes, texte, onclick) et la boîte noire (`contexte.journal`, 200 événements au plus : toucher, clic, saisie
  — jamais sa valeur, le relais jette le détail —, page, défilement, erreur, requête), en 8000 caractères au plus (les plus
  anciens tombent d'abord). Une ligne « MODE : » ou un faux bloc du relais écrit par la personne est neutralisé.
- **L'interrupteur** : `GET /etat` (sans clé) dit si le bouton est activé ; le bouton le lit avant de se montrer. Coupé, le bouton
  disparaît des pages et le relais refuse tout envoi (`403`, `coupe: true`) : rien n'est rangé, la routine n'est pas appelée.
  On le change depuis un pupitre (une page qui porte une clé d'équipe), ou en ligne de commande avec une clé :
  ```bash
  curl -sS -X POST https://ADRESSE-DU-RELAIS/etat -H "Content-Type: application/json" -H "X-Signaler-Cle: <clé>" -d '{"actif":false}'
  ```
  (`{"actif":true}` pour le rallumer). La réponse dit depuis quand et par qui.
  Une page dont l'adresse n'est pas dans `ORIGINES` peut lire `GET /etat` (et seulement cette route) : la réponse porte alors
  `"origine": false` (sans « depuis » ni « par »), pour que le bouton dise « page non autorisée » au lieu de « relais injoignable ».
- **Un interrupteur par projet**, en plus du général : la liste fixe `PROJETS` de `relay/coeur.mjs` (`home`, `pupitre`,
  `havroutia`, `avinou`, `gescom` (770lab.com/gescom…), `koulam`). Le projet d'une page vient de son adresse (`projetDeLaPage`,
  la même règle dans le bouton ; une adresse d'aucun projet ne suit que le général). Le bouton d'un projet se montre seulement
  si le général ET le sien sont activés ; un projet jamais touché est activé.
  - `GET /etat` rend aussi `projets: { <id>: { actif, depuis, par } }` (tous les projets) ; `actif` reste le GÉNÉRAL.
    `GET /etat?projet=<id>` ajoute `projet` et `effectif` (général ET ce projet : ce que le bouton doit faire). Id inconnu : `400`.
  - `POST /etat` avec `{"actif":false,"projet":"<id>"}` coupe ce projet seulement (même clé, mêmes règles ; id inconnu : `400`) ;
    sans `projet`, c'est le général, comme avant. La réponse est l'état complet.
  - `POST /signaler` est refusé (`403`, `coupe: true`) quand le projet de la page (`contexte.url`) est coupé. Chaque demande
    garde son `projet` (aussi dans `GET /demandes` ; une demande d'avant : celui de l'adresse de sa page).
  - KOULAM n'envoie rien au relais (sa bulle « Modifier avec Claude » a sa propre routine) : il lit seulement
    `GET /etat?projet=koulam` pour savoir s'il montre sa bulle ; koulam.app n'a pas besoin d'être dans `ORIGINES`.
  - Ajouter un projet : une ligne dans `PROJETS` et sa règle dans `projetDeLaPage` (relais ET bouton), puis redéployer.

- **Le mode de chaque projet** (dans le même état que les interrupteurs) : `direct` (la routine fusionne, attend que ce soit en
  ligne, renvoie `en_ligne` avec les captures avant / après et `annulation`) ou `valider` (elle ouvre la PR, renvoie `a_valider`
  avec les captures). Par défaut : `direct` pour `home`, `pupitre`, `havroutia` ; `valider` pour `avinou`, qui ne peut JAMAIS
  passer en direct (`MODE_FIGE` : `400`) ; `koulam` est fixe (sa bulle a sa propre routine) ; `gescom`, comme une page d'aucun
  projet : `valider` (le pupitre peut le passer en direct).
  `GET /etat` rend `modes` et le `mode` de chaque projet ; `POST /etat` avec `{"projet":"home","mode":"valider"}` le change (même
  clé ou session ; `actif` peut s'y ajouter).
- **Annuler** : `POST /demandes/<réf>/annuler` (la sienne, `en_ligne` avec `annulation`, jamais `avinou` : `409`) → l'état
  `en_cours_annulation` et un travail ANNULER écrit par le relais (git revert des commits donnés, en ligne, RETOUR `annulee`).
  **Mettre en ligne** : `POST /demandes/<réf>/valider` (la sienne, `a_valider` avec une PR GitHub, jamais `avinou` : `409`) exige
  une SESSION dont l'empreinte date de 5 minutes au plus (sinon `403` avec `empreinte: true` : la page refait l'empreinte) →
  `en_cours_validation` et un travail VALIDER (fusion, en ligne, RETOUR `en_ligne` avec `annulation`). Si la routine ne part pas,
  la demande garde son état (`en_ligne` / `a_valider`) avec la raison dans `erreur`, et la réponse est `502`.
- **Deux abonnements** (`ROUTINE_URL` / `ROUTINE_JETON`, puis `ROUTINE_URL_2` / `ROUTINE_JETON_2`) : le relais prévient d'abord
  celui choisi (`auto` : le 1 puis le 2), saute celui qui est noté indisponible (sauf s'ils le sont tous) ; `429` → indisponible
  jusqu'à `Retry-After` (1 h sans), autre `4xx` → 6 h, avec la raison, et l'autre est prévenu aussitôt ; `500/503/529` → un
  second essai puis l'autre ; une coupure réseau ou un `502/504` : on s'arrête (la session existe peut-être). Chaque demande garde
  son `abonnement`. `GET /routine` (clé ou session) → `{ choix, abonnements: [{ id, nom, regle, indispo? }] }` (ni adresse ni
  jeton) ; `POST /routine {"choix":"auto"|"1"|"2"}` le change et efface les indisponibilités notées (on réessaie tout de suite).
  `POST /demandes/<réf>/renvoyer` accepte `{"abonnement":"2"}` (celui-là seulement) et vaut aussi pour une demande en cours sans
  nouvelle depuis 15 minutes (« Renvoyer sur l'autre abonnement ») ; si elle ne repart pas, elle reste en cours (`502`).
- **La connexion par empreinte** (avec `SESSION_SECRET`, sinon `503` partout sous `/auth`) : le rpId est le nom d'hôte de la page
  (dans `ORIGINES`), l'origine attendue est la sienne, exactement. `POST /auth/options/inscription {"nom"}` (clé ou session) puis
  `POST /auth/inscription` (le résultat de `navigator.credentials.create`, en JSON base64url) inscrivent l'appareil (20 par
  personne au plus) et rendent une session ; `POST` (ou `GET`) `/auth/options/connexion` puis `POST /auth/connexion` (le résultat
  de `navigator.credentials.get`) rendent `{ session, exp, qui, appareil }`. Les options sont à plat et sous `publicKey`.
  Une session dure 12 heures (`exp` en millisecondes) ; elle vaut la clé partout (`Authorization: Bearer <session>`) tant que
  l'appareil est inscrit et que la personne a une clé dans `CLES` (retirer quelqu'un de `CLES` retire aussi ses appareils).
  `GET /auth/appareils` et `POST /auth/appareils/<id>/retirer` (les siens seulement) gèrent « Mes appareils » ;
  `POST /auth/verifier {"session"}` → `{ ok, valide, qui?, exp? }` sert à un autre serveur (l'API d'un Mac…). Défis : 5 minutes,
  une seule fois. Seules les clés PUBLIQUES sont rangées ; l'attestation n'est pas vérifiée (demandée « none »).

**Mettre à jour une installation existante** — les trois morceaux, sinon rien ne change pour personne (le relais neuf avec
un ancien bouton n'affiche ni « Mes demandes » ni le badge ; le bouton neuf avec un ancien relais non plus) :

1. **Le relais** : `npx wrangler@4 deploy` depuis `relay/cloudflare/` (le propriétaire, connecté à Cloudflare), avec le stockage
   Workers KV branché (`PIECES_KV` dans `wrangler.toml`). Vérifier : `curl -sS https://ADRESSE-DU-RELAIS/etat` répond
   `{"ok":true,"actif":true,…}`. « introuvable » = c'est encore l'ancien relais qui tourne.
2. **Le bouton, dans CHAQUE projet qui le porte** : recopier le nouveau `widget/signaler.js` à la place de CHAQUE copie servie
   (chercher `signaler.js` dans chaque dépôt : un projet peut en avoir plusieurs, ou une copie dans un autre dépôt qui le
   publie), puis monter le `?v=` (ou le nom de fichier) de chaque balise `<script>` qui le charge : sans cela, téléphones et
   cache gardent l'ancien. Vérifier sur la page en ligne : `typeof window.Signaler.demandes === 'function'`.
3. **La routine** : recoller `routine/consignes.md` (claude.ai/code/routines), dans CHAQUE routine (les deux abonnements) : avec
   d'anciennes consignes, la routine ignore le MODE, les captures avant / après et les travaux ANNULER / VALIDER (ou ne renvoie
   rien du tout ; les demandes restent « en cours »). Les secrets existants ne changent pas ; `SESSION_SECRET`,
   `ROUTINE_URL_2` et `ROUTINE_JETON_2` s'ajoutent quand le propriétaire le veut (étape 4).

## 6. Vérifier

1. Ouvre l'application, touche 🐞 : la fenêtre s'ouvre avec une capture de l'écran.
2. Écris « Essai du bouton Signaler : rien à corriger », tape une clé, envoie. Attendu : « ✅ Transmis à Claude (réf. …) ».
3. Sur claude.ai/code, une nouvelle session de la routine apparaît et répond qu'il n'y a rien à corriger.
4. « Mes demandes » dans la fenêtre du bouton : l'essai y est « en cours », puis « rien à faire » quand la session a fini (elle a
   envoyé son RETOUR). Reste « en cours » : l'accès réseau de la routine n'autorise pas le relais, ou ses consignes sont anciennes.
5. En cas d'échec, le message de la fenêtre dit où ça bloque :
   - « page non autorisée » → `ORIGINES` ne contient pas l'adresse exacte de la page (schéma, domaine, port) ; ajoute-la et
     redéploie le relais. Un bouton qui ne lit pas `"origine": false` dans `GET /etat` dit à la place « le relais est injoignable » ;
   - « clé d'équipe absente ou inconnue » → `CLES` ;
   - « le relais n'est pas encore relié à Claude » → `ROUTINE_URL` / `ROUTINE_JETON` ;
   - « Claude n'a pas pu être prévenu (routine 401…) » → jeton révoqué ou d'une autre routine ; `429` → plus de 30 envois en une heure ;
   - « Le bouton est coupé depuis le pupitre » → l'interrupteur (étape 5).
6. Avec `SESSION_SECRET` : « Activer l'empreinte sur cet appareil » (après un envoi avec la clé), puis « Se connecter avec
   l'empreinte » sur une page neuve ; `curl -sS -X POST https://ADRESSE-DU-RELAIS/auth/verifier -H "Content-Type: application/json"
   -d '{"session":"x"}'` répond `{"ok":true,"valide":false}` (et non `503`).
7. Le mode : `curl -sS https://ADRESSE-DU-RELAIS/etat` montre `modes` ; un signalement d'un projet « direct » finit « en ligne »
   avec ses captures avant / après, et « Annuler » le remet comme avant.

Termine en résumant au propriétaire : où est le bouton, l'adresse du relais, qui a une clé, le mode de chaque projet (direct
ou à valider), s'il a un second abonnement et l'empreinte, et comment couper : l'interrupteur (étape 5) pour un arrêt
réversible, « Annuler » sur une demande en ligne pour revenir en arrière, « Revoke » sur le jeton de la routine (des deux
routines) pour tout arrêter.
