/*! « Signaler à Claude » — un bouton qui photographie l'écran, prend la parole de l'utilisateur et envoie le tout à Claude.
 *  Sans dépendance (html2canvas est chargé à la demande). Licence MIT.
 *
 *  INSTALLATION (une ligne, avant </body>) :
 *    <script src="/signaler.js" data-endpoint="https://mon-relais.exemple.workers.dev" data-version="1.4.2" defer></script>
 *  ou, avant le script : window.SignalerConfig = { endpoint: '…', version: '…', utilisateur: () => 'marie@exemple.fr' };
 *
 *  Réglages (attribut data-… ou clé de SignalerConfig) :
 *    endpoint       l'adresse du relais (obligatoire) — le relais garde le jeton de la routine, jamais la page
 *    version        la version de l'application, recopiée dans le signalement
 *    utilisateur    fonction rendant le compte connecté (facultatif)
 *    position       'bas-droite' (défaut) ou 'bas-gauche'
 *    html2canvas    l'adresse de html2canvas si la page interdit cdnjs (CSP)
 *    visible        fonction : false pour cacher le bouton (ex. visiteurs non connectés)
 *    sansAlerte     fonction (adresse complète) : true pour une requête dont la page affiche déjà l'échec elle-même (le pupitre et
 *                   son Mac) ; elle reste dans la boîte noire, mais n'allume ni le point rouge ni la bulle
 *    projet         le projet de la page ('home', 'pupitre', 'havroutia', 'avinou', 'gescom', 'koulam') ; sans réglage, d'après son adresse
 *                   (Signaler.projetDeLaPage) : 770lab.com/home/robots… → pupitre, 770lab.com/home… → home,
 *                   770lab.com/havroutia… → havroutia, avinou-malkenou.web.app → avinou, koulam.app → koulam, sinon aucun
 *
 *  Les interrupteurs du pupitre : un GÉNÉRAL et un PAR PROJET. Avant de montrer le rond, le bouton demande au relais s'il est
 *  coupé (GET /etat?projet=<id>, ou GET /etat pour une page d'aucun projet ; 4 s au plus) : « effectif: false » (le général ou
 *  celui de ce projet coupé) le cache ; un relais d'avant les projets ne dit pas « effectif », son « actif: false » le cache.
 *  Coupé : le rond n'apparaît pas. Relais muet, en erreur ou lent : le rond apparaît quand même (on ne bloque pas sur une panne).
 *  Signaler.montrer() sur un bouton coupé redemande au relais : rallumé depuis le pupitre, il revient sans recharger la page ;
 *  toujours coupé, il reste caché (une page qui appelle montrer() après une connexion ne passe pas outre l'interrupteur).
 *  « Mes demandes » : connecté (empreinte ou clé d'équipe), un petit nombre sur le rond compte les demandes « à traiter » (une
 *  question de Claude, une PR à relire, une modification à valider, une demande pas partie) ; le toucher ouvre la liste
 *  (GET /demandes), le reste du rond photographie. Une lecture sans réponse lisible est expliquée : réseau coupé, ou relais qui
 *  refuse CETTE page (adresse absente de ses ORIGINES, ou relais pas encore à jour) ; GET /etat, public, peut le dire lui-même.
 *  Chaque carte : l'état, le projet, l'abonnement Claude qui l'a prise (« via abonnement 1 »), le résumé, les captures avant / après
 *  (un toucher les montre en plein écran), et ce que le relais permet (champ « actions ») : « Annuler » une modification en ligne
 *  (garder appuyé 1,2 s), « Mettre en ligne » une modification à valider (exige d’être connecté par l’empreinte : sinon le bouton
 *  la demande d’abord ; sur un appareil de confiance : un appareil ajouté avec la clé d'équipe seule ne met pas en ligne, le
 *  bouton le dit ; jamais pour Avinou Malkenou, que son propriétaire met en ligne depuis son Mac), « Renvoyer » une demande
 *  pas partie ou sans nouvelle depuis 15 minutes (et « Renvoyer sur l’autre abonnement »).
 *
 *  LA CONNEXION. Par EMPREINTE (WebAuthn, clés d'accès, rpId = le nom d'hôte de la page) : POST /auth/options/connexion puis
 *  /auth/connexion → une SESSION de 30 jours gardée sous localStorage signaler_session_v1 = { session, exp, qui } (partagée par les
 *  pages de 770lab.com : Home, le pupitre, HavroutIA), envoyée en « Authorization: Bearer ». Refusée (401) ou expirée : oubliée.
 *  Sans session ni clé, la fenêtre propose « Se connecter avec l’empreinte » (et « J’ai une clé » pour l'ancien champ). La clé
 *  d'équipe (X-Signaler-Cle, localStorage signaler_cle_v1) marche toujours ; après un envoi fait avec elle, si le relais a réglé
 *  l'empreinte (GET /auth/options/connexion ne répond pas 503), « Activer l’empreinte sur cet appareil » est proposé UNE fois
 *  (localStorage signaler_empreinte_proposee_v1). La page ne garde ni ne voit aucun secret : le jeton est signé par le relais.
 *
 *  LE ROND. Un toucher court l'ouvre, avec une vibration (20/10/2026, Yoann : « un seul tap haptique, il se lance ; un clic long et
 *  qu'on déplace son doigt, il doit se déplacer ») ; navigator.vibrate, ou sur iPhone l'interrupteur caché d'iOS 18 (le tour du
 *  pupitre). Un toucher le fait s'enfoncer, puis pendant la photo un anneau tourne autour, une onde s'en échappe et l'étoile tourne
 *  (transform et opacité seulement : le compositeur les joue même quand html2canvas occupe la page). Appui long (0,38 s) puis
 *  glisser, au doigt ou à la souris : il se déplace ; sa place est gardée PAR PAGE (localStorage signaler_pos_v1, origine + chemin,
 *  en proportion de l'écran), ramenée dans l'écran à chaque rotation. Déplacé, il porte la classe « sgn-deplace » et left / top en
 *  ligne : une page qui le remonte par CSS doit viser .sgn-fab:not(.sgn-deplace). « Remettre le bouton à sa place » dans la fenêtre.
 *  LA CAPTURE se montre en grand dans la fenêtre : on dessine dessus (traits rouges) ; l'image envoyée porte le dessin et, pour
 *  chaque trait, l'élément de la page qui était dessous (contexte.elements : chemin, balise, id, classes, texte, onclick — lus au
 *  moment de la photo, jamais la valeur d'un champ). PLUSIEURS ÉCRANS : « + Un autre écran » ferme la fenêtre et garde le brouillon
 *  (sessionStorage signaler_brouillon_v1 : il survit à un changement de page dans l'onglet, effacé après l'envoi) ; la pastille
 *  blanche du rond compte les écrans en attente, le toucher ajoute l'écran suivant (5 au plus).
 *  LA BOÎTE NOIRE : les 30 dernières secondes de la page, en mémoire seulement (touchers, saisies — QUEL champ, jamais ce qui est
 *  tapé —, pages, défilements, erreurs, requêtes en échec, sans leur partie « ?… »), jointes au signalement (contexte.journal).
 *  Une erreur, ou une requête en échec (5xx, réseau), allume un point rouge sur le rond et une bulle « Le signaler ? » : une fois
 *  par erreur et par chargement de la page, seulement quand le rond est à l'écran ; les appels du bouton lui-même n'y comptent pas.
 *
 *  API : window.Signaler.ouvrir() · .cacher() · .montrer() · .demandes(filtre) · .projetDeLaPage(url) · .projets · .oublier()
 *        filtre = 'toutes' | 'traiter' | 'cours' ; sans filtre : « À traiter » s'il y en a, sinon toutes.
 *        ou { projet: 'home' } / { projet: 'home', etat: 'traiter' } : les demandes de ce projet seulement (puce « Projet : Home × »
 *        au-dessus des filtres, qu'un toucher retire). Le projet d'une demande : son champ « projet », sinon l'adresse de sa page.
 *        oublier() : efface le brouillon, la liste gardée, la boîte noire et la capture en plein écran (pour l'écran verrouillé
 *        d'Avinou Malkenou) ; la clé et la connexion (la session) restent.
 *  Événement : window « signaler:demandes » { aTraiter, total, projets: { <id>: { aTraiter, total } } } à chaque liste lue
 *  (pour un compteur ailleurs dans la page).
 */
(function () {
  'use strict';
  if (window.Signaler) return;

  var script = document.currentScript || null;
  var C = Object.assign({ position: 'bas-droite', html2canvas: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js' }, window.SignalerConfig || {});
  if (script && script.dataset) ['endpoint', 'version', 'position', 'html2canvas', 'projet'].forEach(function (k) { if (script.dataset[k]) C[k] = script.dataset[k]; });
  var CLE_STOCKAGE = 'signaler_cle_v1', BROUILLON_CLE = 'signaler_brouillon_v1', POS_CLE = 'signaler_pos_v1';
  var ECRANS_MAX = 5, LARGEUR_MAX = 1600, HAUTEUR_MAX = 2600, JPEG_Q = 0.8, AUDIO_MAX_MS = 180000, ETAT_DELAI_MS = 4000;
  var APPUI_LONG_MS = 380, MARGE = 12, MARGE_HAUT = 16, POSITIONS_MAX = 40;          // le rond qu'on déplace
  var ROUGE = '#ff2b2b', EPAISSEUR_PX = 4, TRAITS_MAX = 30, POINTS_MAX = 500, ELEMENTS_MAX = 10, ELEMENTS_GRILLE = 400;
  var BOITE_MS = 30000, BOITE_MAX = 200, ALERTES_MAX = 5;
  // La connexion par empreinte : la session (et l’empreinte proposée une fois) ; un défi demandé d’avance sert 4 minutes
  // (le relais le garde 5).
  var SESSION_CLE = 'signaler_session_v1', PROPOSEE_CLE = 'signaler_empreinte_proposee_v1';
  var DEFI_GARDE_MS = 4 * 60000, TENIR_MS = 1200, ROUTINE_GARDE_MS = 2 * 60000;
  var COUPE_MSG = 'Le bouton est coupé depuis le pupitre.';
  var MAX_MSG = ECRANS_MAX + ' écrans au plus : retire-en un pour en ajouter un autre.';
  // Pourquoi le relais ne répond pas : le navigateur ne lit pas une réponse sans CORS, il faut le dire en clair à la personne.
  var MSG = {
    origine: 'Page non autorisée : ce site n’est pas dans la liste du relais (ORIGINES).',
    refus: 'Le relais répond, mais pas à cette page : il n’est sans doute pas encore à jour pour « Mes demandes » (à redéployer), ou l’adresse de cette page n’est pas dans sa liste (ORIGINES).',
    ancien: 'Le relais n’est pas encore à jour : il ne connaît pas « Mes demandes ». Il doit être redéployé.',
    injoignable: 'Le relais est injoignable : vérifie la connexion, puis touche « Actualiser ».',
    origineEnvoi: 'Cette page n’est pas autorisée par le relais (son adresse n’est pas dans sa liste, ORIGINES) : l’envoi sera refusé.',
    pasReglee: 'La connexion par empreinte n’est pas encore réglée sur le relais : utilise ta clé d’équipe.',
    sessionPerdue: 'Ta connexion a expiré (ou cet appareil a été retiré) : reconnecte-toi avec ton empreinte.',
    // 403 « confiance » du relais : l'appareil de la session a été ajouté avec la clé seule (une clé volée suffit pour cela).
    confiance: 'Cet appareil a été ajouté avec la clé d’équipe seule : il ne peut pas mettre en ligne. Mets en ligne depuis ton téléphone, ou ici après « Se déconnecter » puis « Se connecter avec l’empreinte » en choisissant ton téléphone.',
    muet: 'Le relais ne répond pas : vérifie la connexion, puis réessaie.',
  };

  var court = function (s, n) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n); };
  // Les nœuds du bouton (rond, nombre, fenêtre, bulle) : marqués, ignorés par la photo, la boîte noire et la carte des éléments.
  function marquer(el) { el.setAttribute('data-sgn', ''); el.setAttribute('data-html2canvas-ignore', 'true'); return el; }
  function estAMoi(el) {
    if (el && el.nodeType === 3) el = el.parentElement;
    return !!(el && el.nodeType === 1 && el.closest && el.closest('[data-sgn]'));
  }
  // Le fetch de la page AVANT que la boîte noire ne l'enveloppe : les appels du bouton au relais passent par lui, ils ne comptent
  // ni dans la boîte noire ni pour le point rouge. Tout nouvel appel du bouton doit passer par chercher() (ou appel()).
  var fetchNatif = typeof window.fetch === 'function' ? window.fetch : null;
  function chercher(url, init) { return fetchNatif.call(window, url, init); }

  // ── LES DERNIÈRES ERREURS DE LA PAGE : souvent la moitié du diagnostic, et personne ne pense à les recopier ─────────────────
  var ERREURS = [];
  function noter(t) {
    try { t = String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, 300); if (!t) return; ERREURS.push(new Date().toTimeString().slice(0, 8) + ' ' + t); if (ERREURS.length > 10) ERREURS.shift(); } catch (e) {}
  }
  function texteDe(a) { if (a && a.message) return String(a.message); if (typeof a === 'string') return a; try { return JSON.stringify(a); } catch (e) { return String(a); } }
  window.addEventListener('error', function (ev) {
    noter((ev && ev.message) || 'erreur' + (ev && ev.filename ? ' @' + String(ev.filename).split('/').pop().split('?')[0] + ':' + ev.lineno : ''));
    var m = court((ev && ev.message) || 'erreur', 300), ou = ev && ev.filename ? String(ev.filename).split('/').pop().split('?')[0] + ':' + ev.lineno : 'page';
    consigner('erreur', ou, m);
    alerter('erreur:' + m.slice(0, 160), 'Erreur sur la page : ' + m.slice(0, 160));
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var m = court(texteDe(ev && ev.reason), 300);
    noter('promesse rejetée : ' + m);
    consigner('erreur', 'promesse', m);
    alerter('erreur:' + m.slice(0, 160), 'Erreur sur la page (promesse rejetée) : ' + m.slice(0, 160));
  });
  var ce = console.error;
  console.error = function () {
    try {
      var m = court([].map.call(arguments, texteDe).join(' '), 300);
      noter('console.error : ' + m);
      consigner('erreur', 'console', m);
      alerter('erreur:' + m.slice(0, 160), 'Erreur sur la page : ' + m.slice(0, 160));
    } catch (e) {}
    return ce.apply(console, arguments);
  };

  // ── LA BOÎTE NOIRE : les 30 dernières secondes de la page, en mémoire seulement ──────────────────────────────────────────
  // Ce qui s'est passé JUSTE AVANT que la personne touche le rond, souvent la clé du bug. Rien de ce qu'elle tape n'y entre :
  // d'un champ, seulement QUEL champ (balise, type, id, étiquette), jamais sa valeur ; d'une adresse, le chemin sans « ?… ».
  // Chaque écran du brouillon garde la boîte de son moment (joindreBoite) : elle survit au changement de page avec lui.
  var BOITE = [];
  function consigner(type, cible, detail) {
    try {
      var t = Date.now();
      while (BOITE.length && (BOITE.length >= BOITE_MAX || t - BOITE[0].at > BOITE_MS)) BOITE.shift();
      BOITE.push({ at: t, type: type, cible: court(cible, 160), detail: court(detail, 300) });
    } catch (e) {}
  }
  function extraitBoite() { var t = Date.now(); return BOITE.filter(function (e) { return t - e.at <= BOITE_MS; }).map(function (e) { return { at: e.at, type: e.type, cible: e.cible, detail: e.detail }; }); }
  var CHAMP_RX = /^(INPUT|TEXTAREA|SELECT|OPTION)$/, EXCLU_RX = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA|SELECT|OPTION|INPUT)$/;
  function estChamp(el) { return !!(el && el.nodeType === 1 && (CHAMP_RX.test(el.tagName) || el.isContentEditable)); }
  function classesDe(el) {
    var c = typeof el.className === 'string' ? el.className : (el.getAttribute && el.getAttribute('class')) || '';
    return String(c).trim().split(/\s+/).filter(Boolean).slice(0, 3);
  }
  // L'étiquette d'un champ (ce que la page en dit), jamais sa valeur.
  function etiquetteChamp(el) {
    var t = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
    if (!t && el.labels && el.labels[0]) t = libelle(el.labels[0], 60);
    return court(t || el.getAttribute('name') || el.getAttribute('title') || '', 60);
  }
  // Le texte qu'on VOIT dans un élément, sans ce qui est tapé : les champs, les zones éditables et le bouton sont sautés.
  function libelle(el, n) {
    if (!el || el.nodeType !== 1) return '';
    if (estChamp(el)) return etiquetteChamp(el);
    var t = '';
    try {
      var w = document.createTreeWalker(el, 5, { acceptNode: function (x) {
        if (x.nodeType === 3) return 1;
        return EXCLU_RX.test(x.tagName) || x.isContentEditable || x.hasAttribute('data-sgn') ? 2 : 3;   // 1 garder, 2 sauter, 3 descendre
      } });
      while (t.length < n * 2 && w.nextNode()) t += ' ' + w.currentNode.nodeValue;
    } catch (e) {}
    t = court(t, n);
    if (!t) t = court(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || '', n);
    if (!t && el.tagName === 'IMG') { var src = String(el.getAttribute('src') || ''); t = court(/^(data|blob):/.test(src) ? 'image' : 'image ' + src.split('?')[0].split('/').pop(), n); }
    return t;
  }
  var INTERACTIF = 'a,button,input,select,textarea,label,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"]';
  function cibleUtile(el) { var c = el && el.closest ? el.closest(INTERACTIF) : null; return c && c !== document.body ? c : el; }
  // « button#panne « Enregistrer » » : la balise, l'id (sinon une classe), le type d'un champ, son texte court.
  function decrireCourt(el) {
    if (!el || el.nodeType !== 1) return '';
    var s = el.tagName.toLowerCase();
    if (s === 'input') s += '[' + court((el.getAttribute('type') || 'text').toLowerCase(), 20) + ']';
    if (el.id) s += '#' + court(el.id, 40); else { var c = classesDe(el)[0]; if (c) s += '.' + court(c, 30); }
    var t = libelle(el, 40);
    return s + (t ? ' « ' + t + ' »' : '');
  }
  // Le chemin d'une page : sans « ?… » (des jetons s'y cachent) ; l'ancre seulement si elle a l'air d'une route.
  function cheminPage() {
    var a = String(location.hash || '');
    return location.pathname + (!a ? '' : /^#[A-Za-z0-9_\-./]{0,60}$/.test(a) ? a : '#…');
  }
  var dernierPointeur = '';
  document.addEventListener('pointerdown', function (e) { dernierPointeur = e.pointerType || ''; }, true);
  document.addEventListener('click', function (e) {
    try {
      var el = e.target && e.target.nodeType === 3 ? e.target.parentElement : e.target;
      if (!el || el.nodeType !== 1 || estAMoi(el)) return;
      var pt = e.pointerType || dernierPointeur;
      consigner(pt === 'touch' || pt === 'pen' ? 'toucher' : 'clic', decrireCourt(cibleUtile(el)), e.detail === 0 && !e.pointerType ? 'au clavier' : '');
    } catch (er) {}
  }, true);
  function surSaisie(e) {
    try {
      var el = e.target;
      if (!estChamp(el) || estAMoi(el)) return;
      var cible = decrireCourt(el), der = BOITE[BOITE.length - 1], t = Date.now();
      // Une saisie = une ligne, même tapée lettre à lettre ; le « change » qui la clôt (en quittant le champ) la marque « validée ».
      if (e.type === 'change') {
        for (var i = BOITE.length - 1; i >= 0; i--) if (BOITE[i].type === 'saisie' && BOITE[i].cible === cible) { BOITE[i].detail = 'validée'; return; }
        consigner('saisie', cible, 'validée');
        return;
      }
      if (der && der.type === 'saisie' && der.cible === cible && t - der.at < 3000) { der.at = t; return; }
      consigner('saisie', cible, '');
    } catch (er) {}
  }
  document.addEventListener('input', surSaisie, true);
  document.addEventListener('change', surSaisie, true);
  // Le défilement : une ligne par geste (la dernière position), relevée 250 ms après le dernier mouvement.
  var defilCible = null, defilMinuteur = null;
  window.addEventListener('scroll', function (e) {
    if (estAMoi(e.target)) return;
    defilCible = e.target;
    if (defilMinuteur) return;
    defilMinuteur = setTimeout(function () {
      defilMinuteur = null;
      var x = defilCible; defilCible = null;
      try {
        var page = !x || x === document || x === window || x === document.documentElement || x === document.body;
        var y = Math.round(page ? window.scrollY || 0 : x.scrollTop || 0);
        var max = page ? document.documentElement.scrollHeight - window.innerHeight : x.scrollHeight - x.clientHeight;
        var cible = page ? 'page' : decrireCourt(x), detail = 'y = ' + y + ' px' + (max > 0 ? ' (' + Math.min(100, Math.round(100 * y / max)) + ' %)' : '');
        var der = BOITE[BOITE.length - 1];
        if (der && der.type === 'defilement' && der.cible === cible && Date.now() - der.at < 2000) { der.at = Date.now(); der.detail = detail; }
        else consigner('defilement', cible, detail);
      } catch (er) {}
    }, 250);
  }, { capture: true, passive: true });
  consigner('page', cheminPage(), 'chargement');
  window.addEventListener('hashchange', function () { consigner('page', cheminPage(), 'ancre'); });
  window.addEventListener('popstate', function () { consigner('page', cheminPage(), 'retour ou avance'); });
  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = window.history && history[m];
    if (typeof orig !== 'function') return;
    history[m] = function () {
      var avant = cheminPage(), r = orig.apply(this, arguments);
      try { var apres = cheminPage(); if (apres !== avant) consigner('page', apres, m === 'pushState' ? 'navigation' : 'remplacement'); } catch (e) {}
      return r;
    };
  });
  // Les requêtes de la page en échec (statut ≥ 400, ou pas de réponse) : méthode, chemin sans « ?… », statut.
  function requeteEchouee(methode, url, statut) {
    try {
      var u = new URL(String(url), location.href);
      if (!/^https?:$/.test(u.protocol)) return;
      var cible = court(String(methode || 'GET').toUpperCase(), 10) + ' ' + court((u.origin === location.origin ? '' : u.host) + u.pathname, 150);
      consigner('requete', cible, statut ? 'statut ' + statut : 'pas de réponse (réseau)');
      var muet = false;
      try { muet = typeof C.sansAlerte === 'function' && !!C.sansAlerte(u.href); } catch (e) {}
      if (!muet && (!statut || statut >= 500)) alerter('requete:' + cible + ':' + statut, 'Une requête a échoué : ' + cible + (statut ? ' (erreur ' + statut + ')' : ' (pas de réponse du réseau)'));
    } catch (e) {}
  }
  if (fetchNatif) window.fetch = function (entree, init) {
    var p = fetchNatif.apply(window, arguments);
    try {
      var m = (init && init.method) || (entree && typeof entree === 'object' && entree.method) || 'GET';
      var u = entree && typeof entree === 'object' && 'url' in entree ? entree.url : String(entree);
      p.then(function (r) { if (r && r.status >= 400) requeteEchouee(m, u, r.status); },
        function (e) { if (!(e && e.name === 'AbortError')) requeteEchouee(m, u, 0); });
    } catch (e) {}
    return p;
  };
  (function () {
    var X = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (!X || typeof WeakMap !== 'function') return;
    var infos = new WeakMap(), ouvrirX = X.open, envoyerX = X.send;
    X.open = function (m, u) { try { infos.set(this, { m: m, u: u, annule: false }); } catch (e) {} return ouvrirX.apply(this, arguments); };
    X.send = function () {
      var x = this, i = infos.get(x);
      if (i && !i.branche) {
        i.branche = true;
        try {
          x.addEventListener('abort', function () { var j = infos.get(x); if (j) j.annule = true; });
          x.addEventListener('loadend', function () { var j = infos.get(x); if (j && !j.annule && (x.status >= 400 || x.status === 0)) requeteEchouee(j.m, j.u, x.status); });
        } catch (e) {}
      }
      return envoyerX.apply(this, arguments);
    };
  })();

  var lire = function (k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  var ecrire = function (k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) {} };
  var h = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var base = function () { return String(C.endpoint || '').replace(/\/+$/, ''); };
  var largeur = function () { var d = document.documentElement; return Math.min(window.innerWidth, (d && d.clientWidth) || window.innerWidth); };

  // ── LES PROJETS : les mêmes que le relais (PROJETS de relay/coeur.mjs), dans l'ordre du pupitre ────────────────────────────
  // KOULAM n'envoie rien par ce relais (sa propre bulle, sa propre routine) : il est là pour l'interrupteur et les anciennes demandes.
  var PROJETS = [{ id: 'home', nom: 'Home' }, { id: 'pupitre', nom: 'Pupitre' }, { id: 'havroutia', nom: 'HavroutIA' },
    { id: 'avinou', nom: 'Avinou Malkenou' }, { id: 'gescom', nom: 'GesCom' }, { id: 'koulam', nom: 'KOULAM' }];
  // Le projet d'une page d'après son adresse, la même règle que le relais (projetDeLaPage de relay/coeur.mjs) ; null : aucun.
  function projetDeLaPage(url) {
    var u; try { u = new URL(String(url || '')); } catch (e) { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    var hote = u.hostname.toLowerCase().replace(/^www\./, ''), chemin = (u.pathname || '/').toLowerCase();
    if (hote === '770lab.com') {
      if (chemin.indexOf('/home/robots') === 0) return 'pupitre';
      if (chemin.indexOf('/home') === 0) return 'home';
      if (chemin.indexOf('/havroutia') === 0) return 'havroutia';
      if (chemin.indexOf('/gescom') === 0) return 'gescom';
      return null;
    }
    if (hote === 'avinou-malkenou.web.app') return 'avinou';
    if (hote === 'koulam.app') return 'koulam';
    return null;
  }
  // Un identifiant de projet donné par la page ou par une demande : en minuscules, sans blanc ; '' s'il n'y en a pas.
  function idProjet(v) { return typeof v === 'string' ? v.trim().toLowerCase().slice(0, 40) : ''; }
  function nomDuProjet(id) { var p = PROJETS.filter(function (x) { return x.id === id; })[0]; return p ? p.nom : id; }
  // Le projet de CETTE page : le réglage (data-projet, SignalerConfig.projet) l'emporte sur l'adresse.
  var PROJET_PAGE = idProjet(C.projet) || projetDeLaPage(location.href) || '';

  // ── LE STYLE (préfixe sgn-, clair et sombre) ───────────────────────────────────────────────────────────────────────────────
  var cote = C.position === 'bas-gauche' ? 'left' : 'right';
  var POLICE = 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
  var css = ''
    + '.sgn-fab{position:fixed;bottom:calc(18px + env(safe-area-inset-bottom));' + cote + ':calc(18px + env(safe-area-inset-right));z-index:2147483000;'
    + 'width:48px;height:48px;border-radius:50%;border:0;padding:0;display:flex;align-items:center;justify-content:center;cursor:pointer;overflow:visible;'
    + 'background:linear-gradient(135deg,#e08a6a 0%,#d97757 55%,#c45f3f 100%);box-shadow:0 6px 18px -6px rgba(120,50,20,.55),0 0 0 2px rgba(255,255,255,.85);'
    + '-webkit-tap-highlight-color:transparent;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;transition:transform .15s ease}'
    // Toucher = réponse TOUT DE SUITE : le rond s'enfonce ; soulevé (appui long), il grossit un peu et suit le doigt.
    + '.sgn-fab:active,.sgn-fab.sgn-appui{transform:scale(.86)}'
    + '.sgn-fab.sgn-souleve{transform:scale(1.12);cursor:grabbing;box-shadow:0 14px 30px -8px rgba(120,50,20,.6),0 0 0 3px #fff}'
    // L'étoile de Claude (comme la bulle de KOULAM) : 12 traits inégaux qui s'allongent et se rétractent l'un après l'autre.
    + '.sgn-etoile{position:relative;width:26px;height:26px;display:block;pointer-events:none}'
    + '.sgn-r{position:absolute;left:50%;top:50%;width:0;height:0}'
    + '.sgn-r span{position:absolute;left:-1px;top:1px;width:2px;border-radius:1px;background:#fff;transform-origin:50% 0;animation:sgn-trait 2.6s ease-in-out infinite}'
    + '@keyframes sgn-trait{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.72)}}'
    // Pendant la photo : l'anneau tourne, l'onde s'échappe, l'étoile tourne (le compositeur les joue, la page peut être prise).
    + '.sgn-anneau,.sgn-onde{position:absolute;border-radius:50%;pointer-events:none;opacity:0;box-sizing:border-box}'
    + '.sgn-anneau{inset:-7px;border:3px solid rgba(196,95,63,.25);border-top-color:#c45f3f;border-right-color:#e08a6a;transition:opacity .12s}'
    + '.sgn-onde{inset:0;border:2px solid #d97757}'
    + '.sgn-fab.sgn-occupe .sgn-anneau{opacity:1;animation:sgn-tourne .8s linear infinite;will-change:transform}'
    + '.sgn-fab.sgn-occupe .sgn-onde{animation:sgn-onde 1.1s ease-out infinite;will-change:transform,opacity}'
    + '.sgn-fab.sgn-occupe .sgn-etoile{animation:sgn-tourne 1.6s linear infinite;will-change:transform}'
    + '@keyframes sgn-tourne{to{transform:rotate(360deg)}}'
    + '@keyframes sgn-onde{0%{transform:scale(1);opacity:.75}100%{transform:scale(2.2);opacity:0}}'
    // Mouvement réduit : rien ne tourne ni ne pulse ; l'anneau, plein, dit quand même « je travaille ».
    + '@media (prefers-reduced-motion:reduce){.sgn-r span,.sgn-fab.sgn-occupe .sgn-anneau,.sgn-fab.sgn-occupe .sgn-etoile{animation:none}'
    + '.sgn-fab.sgn-occupe .sgn-onde{animation:none;opacity:0}.sgn-fab.sgn-occupe .sgn-anneau{border-color:#c45f3f}.sgn-fab{transition:none}}'
    // La pastille BLANCHE : les écrans du brouillon en attente (en bas à gauche du rond). Le point ROUGE : un problème vient
    // d'arriver sur la page (en haut à gauche). Le nombre rouge des demandes à traiter reste en haut à droite.
    + '.sgn-pastille{position:absolute;left:-7px;bottom:-5px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:#fff;color:#7c2d12;'
    + 'border:1.5px solid #d97757;font:700 11px/17px ' + POLICE + ';text-align:center;box-sizing:border-box;box-shadow:0 1px 4px rgba(0,0,0,.25);display:none;pointer-events:none}'
    + '.sgn-fab.sgn-attente .sgn-pastille{display:block}'
    + '.sgn-point{position:absolute;left:-2px;top:-2px;width:14px;height:14px;border-radius:50%;background:#dc2626;border:2px solid #fff;box-sizing:border-box;'
    + 'box-shadow:0 1px 3px rgba(0,0,0,.3);display:none;pointer-events:none}'
    + '.sgn-fab.sgn-alerte .sgn-point{display:block}'
    + '.sgn-fab:focus-visible,.sgn-badge:focus-visible{outline:3px solid #60a5fa;outline-offset:2px}'
    // Le nombre des demandes à traiter, posé sur le coin haut du rond ; sa zone de toucher déborde un peu (::after), le centre
    // du rond reste le bouton qui photographie. Rond déplacé : il le suit (left / top en ligne).
    + '.sgn-badge{position:fixed;bottom:calc(51px + env(safe-area-inset-bottom));' + cote + ':calc(' + (cote === 'left' ? 51 : 9) + 'px + env(safe-area-inset-right));'
    + 'z-index:2147483000;min-width:22px;height:22px;padding:0 6px;border-radius:11px;border:2px solid #fff;background:#dc2626;color:#fff;'
    + 'font:700 12px/18px ' + POLICE + ';text-align:center;cursor:pointer;box-sizing:border-box;'
    + 'box-shadow:0 2px 6px rgba(0,0,0,.25);-webkit-tap-highlight-color:transparent}'
    + '.sgn-badge::after{content:"";position:absolute;inset:-8px}'
    + '.sgn-fab,.sgn-fab *,.sgn-badge,.sgn-fond,.sgn-fond *,.sgn-bulle,.sgn-bulle *,.sgn-vis,.sgn-vis *{font-style:normal}'
    // La bulle à côté du rond : « Un problème vient d’arriver… » (Signaler / Ignorer), ou un mot après « + Un autre écran ».
    + '.sgn-bulle{--f:#fff;--t:#0f172a;--b:#e2e8f0;--a:#b9532f;position:fixed;left:0;top:0;z-index:2147483000;box-sizing:border-box;width:max-content;'
    + 'max-width:min(300px,calc(100vw - 24px));padding:10px 12px;border-radius:12px;background:var(--f);color:var(--t);border:1px solid var(--b);'
    + 'box-shadow:0 12px 30px -10px rgba(15,23,42,.45);font:14px/1.4 ' + POLICE + ';animation:sgn-bulle .18s ease-out}'
    + '@media (prefers-color-scheme:dark){.sgn-bulle{--f:#0f172a;--t:#f1f5f9;--b:#334155;--a:#e08a6a}}'
    + '@keyframes sgn-bulle{from{opacity:0;transform:translateY(6px)}}'
    + '@media (prefers-reduced-motion:reduce){.sgn-bulle{animation:none}}'
    + '.sgn-bulle p{margin:0}.sgn-bulle-r{display:flex;gap:8px;margin-top:8px}'
    + '.sgn-bulle button{flex:1 1 0;min-height:36px;padding:6px 10px;border-radius:10px;border:1px solid var(--b);background:transparent;color:var(--t);font:inherit;font-weight:600;cursor:pointer}'
    + '.sgn-bulle .sgn-bulle-ok{background:#b9532f;border-color:#b9532f;color:#fff}'
    + '.sgn-bulle button:focus-visible{outline:3px solid #60a5fa;outline-offset:2px}'
    + '.sgn-fond{position:fixed;inset:0;z-index:2147483001;background:rgba(15,23,42,.45);display:flex;align-items:flex-end;justify-content:center}'
    + '@media (min-width:640px){.sgn-fond{align-items:center}}'
    + '.sgn-boite{--f:#fff;--t:#0f172a;--d:#475569;--b:#e2e8f0;--a:#2563eb;--c:#f8fafc;--ko:#dc2626;--ok:#16a34a;background:var(--f);color:var(--t);width:100%;max-width:520px;max-height:92vh;overflow:auto;'
    + 'border-radius:16px 16px 0 0;padding:16px 16px calc(16px + env(safe-area-inset-bottom));font:15px/1.45 ' + POLICE + ';box-sizing:border-box}'
    + '@media (min-width:640px){.sgn-boite{border-radius:16px}}'
    + '@media (prefers-color-scheme:dark){.sgn-boite{--f:#0f172a;--t:#f1f5f9;--d:#94a3b8;--b:#334155;--a:#60a5fa;--c:#1e293b;--ko:#f87171;--ok:#4ade80}}'
    + '.sgn-boite *{box-sizing:border-box}'
    // L'en-tête : la croix reste en haut à droite ; « Mes demandes » passe à la ligne s'il n'a pas la place à côté du titre.
    + '.sgn-tete{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:0 8px;margin-bottom:10px;padding-right:36px}'
    + '.sgn-tete b{font-size:17px;min-height:34px;display:flex;align-items:center}'
    + '.sgn-tete-d{display:flex;margin-left:auto}'
    + '.sgn-x{position:absolute;top:0;right:0;height:34px;border:0;background:transparent;color:var(--d);font-size:22px;line-height:1;cursor:pointer;padding:4px 8px}'
    + '.sgn-lien{border:0;background:transparent;color:var(--a);font:inherit;font-weight:600;padding:6px 8px;border-radius:8px;cursor:pointer;white-space:nowrap}'
    + '.sgn-lien:disabled{opacity:.5;cursor:default}'
    + '.sgn-nb{display:inline-block;min-width:20px;margin-left:4px;padding:0 6px;border-radius:10px;background:#dc2626;color:#fff;font-size:12px;font-weight:700;line-height:20px;text-align:center}'
    + '.sgn-etat .sgn-lien{padding:2px 0;font-size:inherit;text-decoration:underline}'
    + '.sgn-types{display:flex;gap:8px;margin-bottom:10px}.sgn-type{flex:1;padding:9px;border:1px solid var(--b);border-radius:10px;background:transparent;color:var(--t);font:inherit;cursor:pointer}'
    + '.sgn-type[aria-pressed="true"]{border-color:var(--a);box-shadow:inset 0 0 0 1px var(--a);font-weight:600}'
    // La capture en grand, avec sa couche de dessin (le canvas, posé exactement sur l'image).
    + '.sgn-grand{display:flex;justify-content:center;margin-bottom:4px}'
    + '.sgn-toile{position:relative;display:inline-block;max-width:100%;line-height:0}'
    + '.sgn-toile img{display:block;max-width:100%;max-height:min(52vh,560px);width:auto;height:auto;border-radius:10px;border:1px solid var(--b);'
    + '-webkit-user-select:none;user-select:none;-webkit-user-drag:none;pointer-events:none}'
    + '.sgn-toile canvas{position:absolute;left:0;top:0;width:100%;height:100%;border-radius:10px;touch-action:none;cursor:crosshair}'
    + '.sgn-dessin-b{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:0 8px;margin-bottom:6px}'
    + '.sgn-dessin-b .sgn-aide{margin:0;flex:1 1 180px;min-width:0}'
    // Les écrans du brouillon : une vignette chacun (toucher = la voir en grand, × = la retirer), puis « + Un autre écran ».
    + '.sgn-vignettes{display:flex;flex-wrap:wrap;gap:12px 10px;align-items:stretch;padding:7px 7px 4px 0;margin-bottom:8px}.sgn-v{position:relative;flex:0 0 auto}'
    + '.sgn-v-voir{position:relative;display:block;padding:0;border:2px solid transparent;border-radius:10px;background:transparent;cursor:pointer;line-height:0}'
    + '.sgn-v-voir[aria-current="true"]{border-color:var(--a)}'
    + '.sgn-v img{display:block;height:64px;max-width:120px;border-radius:8px;border:1px solid var(--b)}'
    + '.sgn-v svg{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none}'
    + '.sgn-v-n{position:absolute;left:3px;bottom:3px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:rgba(15,23,42,.75);color:#fff;font-size:11px;font-weight:700;line-height:16px;text-align:center}'
    + '.sgn-v-x{position:absolute;top:-7px;right:-7px;width:24px;height:24px;border-radius:50%;border:0;padding:0;background:#ef4444;color:#fff;font-size:14px;line-height:24px;cursor:pointer}'
    + '.sgn-ajout{flex:0 0 auto;min-height:68px;max-width:120px;padding:6px 10px;border:1.5px dashed var(--b);border-radius:10px;background:transparent;'
    + 'color:var(--a);font:inherit;font-size:13px;font-weight:600;line-height:1.25;cursor:pointer}'
    + '.sgn-ajout:disabled{color:var(--d);cursor:default}'
    + '.sgn-rang{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}'
    + '.sgn-bouton{padding:9px 12px;border-radius:10px;border:1px solid var(--b);background:transparent;color:var(--t);font:inherit;cursor:pointer}'
    + '.sgn-bouton:disabled{opacity:.55;cursor:default}'
    + '.sgn-bouton[aria-pressed="true"]{background:#fee2e2;color:#991b1b;border-color:#fca5a5}'
    + '.sgn-texte{width:100%;min-height:96px;padding:10px;border:1px solid var(--b);border-radius:10px;background:transparent;color:var(--t);font-family:inherit;font-size:16px;line-height:1.4;resize:vertical}'
    + '.sgn-cle{width:100%;padding:10px;border:1px solid var(--b);border-radius:10px;background:transparent;color:var(--t);font-family:inherit;font-size:16px;margin-top:6px}'
    + '.sgn-aide{color:var(--d);font-size:13px;margin:6px 0 0}'
    + '.sgn-envoyer{width:100%;margin-top:12px;padding:12px;border:0;border-radius:12px;background:var(--a);color:#fff;font-family:inherit;font-size:16px;font-weight:600;cursor:pointer}'
    + '@media (prefers-color-scheme:dark){.sgn-envoyer{color:#0f172a}}'
    + '.sgn-envoyer:disabled{opacity:.55;cursor:default}'
    + '.sgn-etat{min-height:20px;margin-top:8px;font-size:14px}.sgn-etat.ko{color:var(--ko)}.sgn-etat.ok{color:var(--ok)}'
    + '.sgn-pied{display:flex;flex-wrap:wrap;gap:4px 8px;margin-top:6px}.sgn-pied .sgn-lien{padding:6px 0;font-size:14px;white-space:normal;text-align:left}'
    // « Mes demandes » : les filtres (une rangée de 3), puis une carte par demande, la plus récente en haut.
    + '.sgn-filtres{display:flex;gap:6px;margin-bottom:4px}'
    + '.sgn-filtre{flex:1 1 0;min-width:0;padding:8px 4px;border:1px solid var(--b);border-radius:999px;background:transparent;color:var(--t);font:inherit;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap}'
    + '.sgn-filtre b{color:var(--d);margin-left:3px}'
    + '.sgn-filtre[aria-pressed="true"]{background:#d97757;border-color:#d97757;color:#fff}.sgn-filtre[aria-pressed="true"] b{color:#fff}'
    // La puce du projet choisi (Signaler.demandes({ projet })), seule sur sa ligne au-dessus des filtres ; « × » la retire.
    + '.sgn-projet{display:flex;margin-bottom:8px;min-width:0}'
    + '.sgn-puce{display:inline-flex;align-items:center;gap:8px;max-width:100%;min-height:36px;padding:6px 10px 6px 14px;border:1px solid #d97757;border-radius:999px;'
    + 'background:transparent;color:var(--t);font:inherit;font-size:14px;font-weight:600;text-align:left;overflow-wrap:anywhere;cursor:pointer}'
    + '.sgn-puce-x{flex:0 0 auto;font-size:18px;line-height:1;color:var(--d)}'
    + '.sgn-puce:focus-visible{outline:3px solid #60a5fa;outline-offset:2px}'
    + '.sgn-etat-d{min-height:0;margin:6px 0}'
    + '.sgn-erreur{margin:8px 0;color:var(--ko);font-size:14px}'
    + '.sgn-vide{margin:12px 0;color:var(--d)}'
    + '.sgn-liste{list-style:none;margin:0;padding:0;display:grid;gap:10px}'
    + '.sgn-carte{--e:#64748b;min-width:0;border:1px solid var(--b);border-left:4px solid var(--e);border-radius:12px;background:var(--c);padding:10px 12px}'
    + '.sgn-carte-h{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin-bottom:6px;color:var(--d);font-size:13px}'
    + '.sgn-pil{display:inline-block;border-radius:999px;padding:1px 9px;background:var(--e);color:#fff;font-size:12px;font-weight:700;white-space:nowrap}'
    + '.sgn-carte-t{margin:0;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}'
    + '.sgn-carte-r{margin:6px 0 0;color:var(--d);font-size:14px;overflow-wrap:anywhere}.sgn-carte-r.ko{color:var(--ko)}'
    + '.sgn-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}'
    + '.sgn-act{flex:1 1 auto;display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:7px 10px;border:1px solid var(--b);border-radius:10px;'
    + 'background:var(--f);color:var(--a);font:inherit;font-size:14px;font-weight:600;text-align:center;text-decoration:none;cursor:pointer}'
    + '.sgn-act:disabled{opacity:.55;cursor:default}'
    + '.sgn-bas{display:flex;gap:8px;margin-top:12px}.sgn-bas .sgn-bouton{flex:1}'
    // La connexion : « Se connecter avec l’empreinte » (et « J’ai une clé »), la proposition d'activer l'empreinte, qui est connecté.
    + '.sgn-connexion{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;margin-top:4px}'
    + '.sgn-emp{display:inline-flex;align-items:center;justify-content:center;gap:9px;flex:1 1 230px;max-width:100%;min-height:46px;border-color:var(--a);color:var(--a);font-weight:600}'
    + '.sgn-emp span{white-space:nowrap}'
    + '.sgn-emp svg,.sgn-offre-t svg{flex:0 0 auto;width:22px;height:22px}'
    + '.sgn-offre{margin:10px 0 12px;padding:12px;border:1px solid var(--b);border-radius:12px;background:var(--c)}'
    + '.sgn-offre-t{display:flex;align-items:flex-start;gap:10px;margin:0 0 10px}.sgn-offre-t svg{color:var(--a);margin-top:1px}'
    + '.sgn-offre .sgn-rang{margin:0}.sgn-offre .sgn-bouton{flex:1 1 140px}'
    + '.sgn-qui{color:var(--d);font-size:14px;padding:6px 0}'
    // Le bouton principal d'une carte (« Mettre en ligne »), et « Annuler », qu'on garde appuyé : il se remplit en 1,2 s.
    + '.sgn-prim{background:var(--a);border-color:var(--a);color:#fff;font-weight:600}'
    + '@media (prefers-color-scheme:dark){.sgn-prim{color:#0f172a}}'
    + '.sgn-tenir{position:relative;isolation:isolate;overflow:hidden;color:var(--ko);-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;touch-action:manipulation}'
    + '.sgn-tenir::before{content:"";position:absolute;inset:0;z-index:-1;background:currentColor;opacity:.2;transform:scaleX(0);transform-origin:0 50%;pointer-events:none}'
    + '.sgn-tenir.sgn-tient::before{transform:scaleX(1);transition:transform 1.2s linear}'
    + '@media (prefers-reduced-motion:reduce){.sgn-tenir.sgn-tient::before{transition:none}}'
    // Les captures avant / après d'une carte, côte à côte ; un toucher les montre en plein écran (la visionneuse).
    + '.sgn-avap{display:flex;gap:8px;margin-top:8px}'
    + '.sgn-ap{position:relative;flex:1 1 0;min-width:0;max-width:240px;padding:0;border:1px solid var(--b);border-radius:10px;background:var(--f);overflow:hidden;cursor:zoom-in;line-height:0}'
    + '.sgn-ap img{display:block;width:100%;height:112px;object-fit:cover;object-position:top center}'
    + '.sgn-ap.sgn-ap-ko{cursor:pointer}.sgn-ap-ko img{visibility:hidden}.sgn-ap-ko::after{content:"Image bloquée par cette page : touche pour l’ouvrir";position:absolute;inset:0 0 26px;display:flex;align-items:center;justify-content:center;padding:6px 8px;font-size:12px;line-height:1.3;text-align:center;color:var(--d)}'
    + '.sgn-vis-ko{margin:0;padding:18px 12px;text-align:center;color:#fff;font-size:15px;line-height:1.45}.sgn-vis-ko a{color:#fff;font-weight:700}'
    + '.sgn-ap span{position:absolute;left:6px;bottom:6px;padding:0 8px;border-radius:999px;background:rgba(15,23,42,.8);color:#fff;font-size:12px;font-weight:700;line-height:20px}'
    + '.sgn-ap:focus-visible{outline:3px solid #60a5fa;outline-offset:2px}'
    + '.sgn-vis{position:fixed;inset:0;z-index:2147483002;display:flex;flex-direction:column;box-sizing:border-box;background:rgba(2,6,23,.94);color:#f1f5f9;'
    + 'padding:calc(10px + env(safe-area-inset-top)) 12px calc(12px + env(safe-area-inset-bottom));font:15px/1.4 ' + POLICE + '}'
    + '.sgn-vis *{box-sizing:border-box}'
    + '.sgn-vis-b{flex:0 0 auto;display:flex;justify-content:flex-end;gap:8px}'
    + '.sgn-vis button{min-height:40px;padding:8px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.4);background:transparent;color:#fff;font:inherit;font-weight:600;cursor:pointer}'
    + '.sgn-vis button[aria-pressed="true"]{background:#fff;border-color:#fff;color:#0f172a}'
    + '.sgn-vis button:focus-visible{outline:3px solid #60a5fa;outline-offset:2px}'
    + '.sgn-vis-i{position:relative;flex:1 1 auto;min-height:0;margin:10px 0 8px}'
    + '.sgn-vis-i img{position:absolute;inset:0;margin:auto;max-width:100%;max-height:100%;border-radius:8px}'
    + '.sgn-vis-l{flex:0 0 auto;margin:0;text-align:center;color:#cbd5e1;font-size:14px}'
    + '.e-envoyee{--e:#2563eb}.e-pas_partie{--e:#dc2626}.e-a_relire{--e:#b45309}.e-question{--e:#7c3aed}.e-rien{--e:#64748b}.e-echec{--e:#991b1b}.e-en_ligne,.e-reglee{--e:#15803d}'
    + '.e-a_valider{--e:#c2410c}.e-annulee{--e:#475569}.e-en_cours_annulation,.e-en_cours_validation{--e:#4f46e5}';
  var style = document.createElement('style'); style.textContent = css; (document.head || document.documentElement).appendChild(style);

  // ── L'ÉTAT D'UN SIGNALEMENT EN COURS (le brouillon) ────────────────────────────────────────────────────────────────────────
  // captures : [{ donnees (la photo, sans dessin), ou, traits: [{ l, p: [[x, y]…], e? }], grille, vw, vh, at }]
  //   traits : coordonnées en proportion de l'image (0 à 1), l = épaisseur en proportion de sa largeur, e = l'élément dessous.
  // journal : la boîte noire de chaque écran, au moment de sa photo · attente : « + Un autre écran » touché (le prochain toucher
  // du rond photographie l'écran suivant).
  function brouillonNeuf() { return { type: 'bug', captures: [], texte: '', audio: null, journal: [], attente: false }; }
  var B = brouillonNeuf(), courante = 0;
  var fab = null, badge = null, fond = null, bulle = null, dictee = null, enregistreur = null, envoiEnCours = false, occupe = false;
  // pret : le relais a dit si le bouton est coupé (ou n'a pas répondu à temps) · coupe : coupé depuis le pupitre
  // origineRefusee : le relais a dit (GET /etat) que cette page n'est pas dans sa liste
  // aVerifier : la page cachait le bouton au démarrage, le relais n'a pas encore été interrogé (montrer() le fera)
  var pret = false, coupe = false, aVerifier = false, cacheParPage = false, origineRefusee = false;

  // ── LES APPELS AU RELAIS (sans cookie, jamais mis en cache) ────────────────────────────────────────────────────────────────
  // Rend le JSON de la réponse avec son statut ({ statut }), ou échoue si le relais est injoignable ou trop lent.
  function appel(chemin, o) {
    o = o || {};
    var ctrl = window.AbortController ? new AbortController() : null, minuteur = null;
    var init = { method: o.methode || 'GET', credentials: 'omit', cache: 'no-store', headers: {} };
    if (o.mode) init.mode = o.mode;
    if (o.session) init.headers.Authorization = 'Bearer ' + o.session;
    else if (o.cle) init.headers['X-Signaler-Cle'] = o.cle;
    if (o.corps !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(o.corps); }
    if (ctrl) init.signal = ctrl.signal;
    var p = chercher(base() + chemin, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { j = j && typeof j === 'object' && !Array.isArray(j) ? j : {}; j.statut = r.status; return j; });
    });
    if (o.delai) p = Promise.race([p, new Promise(function (ok, ko) { minuteur = setTimeout(function () { if (ctrl) ctrl.abort(); ko(new Error('trop lent')); }, o.delai); })]);
    return p.then(function (j) { clearTimeout(minuteur); return j; }, function (e) { clearTimeout(minuteur); throw e; });
  }
  // Les interrupteurs : seul un « coupé » explicite cache le bouton. Le doute (panne, lenteur) le laisse paraître.
  // « effectif » (relais à projets, avec ?projet=) = le général ET celui du projet ; sans lui (relais d'avant les projets, ou
  // page d'aucun projet), le général « actif » ; un relais qui donnerait les projets sans « effectif » est lu projet par projet.
  function etatCoupe(j, p) {
    if (!j || typeof j !== 'object') return false;
    if (typeof j.effectif === 'boolean') return !j.effectif;
    if (j.actif === false) return true;
    var x = p && j.projets && typeof j.projets === 'object' ? j.projets[p] : null;
    return !!(x && typeof x === 'object' && x.actif === false);
  }
  function lireEtat() {
    if (!C.endpoint) return Promise.resolve(true);
    var p = PROJET_PAGE, t0 = Date.now();
    return appel('/etat' + (p ? '?projet=' + encodeURIComponent(p) : ''), { delai: ETAT_DELAI_MS }).then(function (j) {
      // Projet inconnu du relais (400) : au moins l'interrupteur général, dans le temps qui reste.
      if (p && j.statut === 400) { p = ''; return appel('/etat', { delai: Math.max(500, ETAT_DELAI_MS - (Date.now() - t0)) }); }
      return j;
    }).then(function (j) {
      if (j.origine === false) origineRefusee = true;
      return !etatCoupe(j, p);
    }, function () { return true; });
  }
  var reverification = null;
  // Une route du relais a échoué SANS réponse lisible. Le navigateur ne dit pas pourquoi (réseau coupé ou réponse sans CORS) :
  // GET /etat, public, dit lui-même si la page est permise ; illisible lui aussi, une requête « opaque » (no-cors, rien n'est
  // lu) n'échoue que si le relais est vraiment injoignable. Rend 'origine' | 'refus' | 'ancien' | 'reseau', gardé 30 s.
  var diag = null;
  function diagnostiquer() {
    if (origineRefusee) return Promise.resolve('origine');
    if (diag && Date.now() - diag.a < 30000) return diag.p;
    var p = appel('/etat', { delai: ETAT_DELAI_MS }).then(function (j) {
      if (j.origine === false) { origineRefusee = true; return 'origine'; }
      return j.statut === 404 ? 'ancien' : 'reseau';
    }, function () {
      return appel('/etat', { mode: 'no-cors', delai: ETAT_DELAI_MS }).then(function () { return 'refus'; }, function () { return 'reseau'; });
    });
    diag = { a: Date.now(), p: p };
    return p;
  }
  function couper() {
    coupe = true;
    cacherBulle();
    if (fab) { fab.remove(); fab = null; }
    if (badge) { badge.remove(); badge = null; }
  }

  // ── LA CONNEXION : une SESSION (après l'empreinte, 30 jours) ou la clé d'équipe ──────────────────────────────────────────────────
  // signaler_session_v1 = { session, exp, qui }, écrit aussi par le pupitre (même origine 770lab.com). Le jeton est signé par le
  // relais : la page le lit seulement (l'heure de l'empreinte « uv » dit s'il est frais pour « Mettre en ligne ») et le renvoie ;
  // c'est le relais qui juge. Illisible ou expiré : oublié tout de suite ; refusé par le relais (401) : oublié aussi.
  var JETON_RX = /^[A-Za-z0-9_-]{10,3000}\.[A-Za-z0-9_-]{43}$/;
  function versOctets(s) {
    s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var b = atob(s), u = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u;
  }
  function versB64u(buf) {
    var u = buf instanceof Uint8Array ? buf : new Uint8Array(buf || []), s = '';
    for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function contenuJeton(jeton) {
    try {
      var o = versOctets(String(jeton).split('.')[0]);
      var p = JSON.parse(window.TextDecoder ? new TextDecoder().decode(o) : decodeURIComponent(escape(String.fromCharCode.apply(null, o))));
      return p && typeof p === 'object' ? p : null;
    } catch (e) { return null; }
  }
  function sessionGardee() {
    var t = lire(SESSION_CLE), o = null;
    if (!t) return null;
    try { o = JSON.parse(t); } catch (e) { o = null; }
    var p = o && typeof o.session === 'string' && JETON_RX.test(o.session) ? contenuJeton(o.session) : null;
    var exp = p ? Number(o.exp) || Number(p.exp) || 0 : 0;
    if (!p || !exp || exp <= Date.now()) { ecrire(SESSION_CLE, ''); return null; }
    return { session: o.session, exp: exp, qui: court(typeof o.qui === 'string' && o.qui ? o.qui : p.qui, 60), uv: Number(p.uv) || 0 };
  }
  function garderSession(j) { ecrire(SESSION_CLE, JSON.stringify({ session: String(j.session), exp: Number(j.exp) || 0, qui: court(j.qui, 60) })); }
  function oublierSession() { ecrire(SESSION_CLE, ''); }
  function aAcces() { return !!(sessionGardee() || lire(CLE_STOCKAGE)); }
  // Un appel « en mon nom » : la session s'il y en a une (Authorization: Bearer), sinon la clé d'équipe. Session refusée (401) :
  // oubliée, et la clé prend le relais s'il y en a une (réponse marquée parCle) ; sans clé, la réponse est marquée sessionPerdue.
  function appelAcces(chemin, o) {
    var s = sessionGardee(), k = lire(CLE_STOCKAGE);
    return appel(chemin, Object.assign({}, o, s ? { session: s.session } : { cle: k })).then(function (j) {
      if (j.statut === 401 && s) {
        oublierSession();
        if (k) return appel(chemin, Object.assign({}, o, { cle: k })).then(function (j2) { j2.parCle = true; return j2; });
        j.sessionPerdue = true;
      }
      if (!s) j.parCle = !!k;
      return j;
    });
  }
  // « le relais dit… » en une phrase : majuscule au début, point à la fin.
  function phrase(t) { t = court(t, 300); if (!t) return ''; t = t.charAt(0).toUpperCase() + t.slice(1); return /[.!?…]$/.test(t) ? t : t + '.'; }

  // ── L'EMPREINTE (WebAuthn, clés d'accès) ─────────────────────────────────────────────────────────────────────────────────────
  // Se connecter : un défi (POST /auth/options/connexion), navigator.credentials.get (l'appareil propose la clé de ce site, rien
  // à taper), POST /auth/connexion → une session. Activer l'empreinte sur cet appareil (clé d'équipe ou session exigée) :
  // POST /auth/options/inscription, navigator.credentials.create, POST /auth/inscription → une session aussi. Le défi est demandé
  // AVANT le toucher quand on le peut (préchargé, 4 minutes) : Safari veut que l'empreinte soit demandée dans le geste même.
  // EMP.reglee : null = on ne sait pas encore ; false = le relais répond 503 (« pas encore réglée ») ou ne connaît pas /auth ;
  // true = il a donné un défi. EMP.offre : « Activer l’empreinte sur cet appareil » est proposé dans la fenêtre.
  var EMP = { reglee: null, defi: null, enRoute: null, inscription: null, inscrEnRoute: null, offre: false };
  var montrerCle = false;   // « J’ai une clé » touché (ou empreinte impossible) : le champ de la clé à la place de l'empreinte
  function empreintePossible() {
    try { return !!(window.PublicKeyCredential && navigator.credentials && typeof navigator.credentials.get === 'function' && window.isSecureContext !== false && window.atob); }
    catch (e) { return false; }
  }
  // Une empreinte de l'appareil lui-même (Touch ID, capteur du téléphone) : ce qu'on propose d'activer.
  function plateformeEmpreinte() {
    try {
      var f = window.PublicKeyCredential && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable;
      return typeof f === 'function' ? f.call(PublicKeyCredential).then(function (x) { return !!x; }, function () { return false; }) : Promise.resolve(false);
    } catch (e) { return Promise.resolve(false); }
  }
  function messageWebAuthn(e, creer) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'AbortError') return creer ? 'Activation annulée (ou le temps est passé).' : 'Empreinte annulée, ou pas encore activée sur cet appareil pour ce site.';
    if (n === 'InvalidStateError') return 'Cet appareil a déjà une empreinte pour ce site : connecte-toi avec elle.';
    if (n === 'SecurityError') return 'Ce site ne peut pas demander l’empreinte (adresse non sécurisée ou non reconnue).';
    if (n === 'NotSupportedError') return 'Ce navigateur ne sait pas utiliser l’empreinte ici : utilise ta clé d’équipe.';
    return 'L’empreinte n’a pas marché' + (n ? ' (' + court(n, 40) + ')' : '') + '.';
  }
  // Le nom de l'appareil, montré par le pupitre (« Mes appareils ») : « Chrome sur Android (770lab.com) ».
  function nomDeCetAppareil() {
    var ua = navigator.userAgent || '', pf = (navigator.userAgentData && navigator.userAgentData.platform) || '', x = pf || ua;
    var os = /Android/i.test(ua) ? 'Android' : /iPhone/i.test(ua) ? 'iPhone' : /iPad/i.test(ua) ? 'iPad' : /Mac/i.test(x) ? 'Mac'
      : /Win/i.test(x) ? 'Windows' : /CrOS|Chrome OS/i.test(x) ? 'Chromebook' : /Linux/i.test(x) ? 'Linux' : 'cet appareil';
    var nav = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
      : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navigateur';
    return court(nav + ' sur ' + os + ' (' + location.hostname + ')', 60);
  }
  var frais = function (x) { return !!(x && Date.now() - x.a < DEFI_GARDE_MS); };
  // Un défi de connexion : { etat: 'ok', o } · { etat: 'pas_reglee' } · { etat: 'erreur', msg }.
  function demanderDefi() {
    if (EMP.enRoute) return EMP.enRoute;
    EMP.enRoute = appel('/auth/options/connexion', { methode: 'POST', corps: {}, delai: 8000 }).then(function (j) {
      if (j.statut === 503) { EMP.reglee = false; return { etat: 'pas_reglee' }; }
      if (j.ok && typeof j.challenge === 'string') { EMP.reglee = true; return { etat: 'ok', o: j, a: Date.now() }; }
      if (j.statut === 403) return { etat: 'erreur', msg: MSG.origine };
      return { etat: 'erreur', msg: 'Le relais n’a pas donné de défi (' + (j.erreur ? j.erreur + ', ' : '') + 'statut ' + j.statut + ').' };
    }, function () {
      // Sans réponse lisible : relais injoignable, ou relais d'avant l'empreinte (404 sans CORS). GET /etat dit lequel.
      return appel('/etat', { delai: ETAT_DELAI_MS }).then(function (j) {
        if (j.origine === false) return { etat: 'erreur', msg: MSG.origine };
        if (j.statut === 200) { EMP.reglee = false; return { etat: 'pas_reglee' }; }
        return { etat: 'erreur', msg: MSG.muet };
      }, function () { return { etat: 'erreur', msg: MSG.muet }; });
    }).then(function (r) { EMP.enRoute = null; return r; });
    return EMP.enRoute;
  }
  // Précharger le défi (fenêtre ouverte sans connexion, ou « Mettre en ligne » à l'écran) ; « pas réglée » : le champ de la clé.
  function prechargerDefi() {
    if (!C.endpoint || !empreintePossible() || EMP.reglee === false || frais(EMP.defi) || EMP.enRoute) return;
    demanderDefi().then(function (r) {
      if (r.etat === 'ok' && !r.pris) EMP.defi = r;
      else if (r.etat === 'pas_reglee') majAcces();
    });
  }
  // Un défi frais, une seule fois : le préchargé, celui qui arrive, ou un nouveau.
  function prendreDefi() {
    var d = EMP.defi; EMP.defi = null;
    if (frais(d)) { d.pris = true; return Promise.resolve(d); }
    return demanderDefi().then(function (r) { if (EMP.defi === r) EMP.defi = null; r.pris = true; return r; });
  }
  // Se connecter avec l'empreinte. Rend { ok, qui } ou { ok: false, msg, cle? (montrer le champ de la clé), absente? (annulée,
  // ou pas d'empreinte pour ce site sur cet appareil) }.
  function connexionEmpreinte() {
    if (!empreintePossible()) return Promise.resolve({ ok: false, cle: true, msg: 'Ce navigateur ne sait pas demander l’empreinte : utilise ta clé d’équipe.' });
    return prendreDefi().then(function (d) {
      if (d.etat === 'pas_reglee') return { ok: false, cle: true, msg: MSG.pasReglee };
      if (d.etat !== 'ok') return { ok: false, msg: d.msg };
      var o = d.o, pk = { challenge: versOctets(o.challenge), userVerification: 'required', allowCredentials: [], timeout: Number(o.timeout) || 120000 };
      if (typeof o.rpId === 'string' && o.rpId) pk.rpId = o.rpId;
      return navigator.credentials.get({ publicKey: pk }).then(function (c) {
        var r = c.response, corps = { id: c.id, rawId: versB64u(c.rawId), type: c.type, response: { clientDataJSON: versB64u(r.clientDataJSON),
          authenticatorData: versB64u(r.authenticatorData), signature: versB64u(r.signature) } };
        if (r.userHandle && r.userHandle.byteLength) corps.response.userHandle = versB64u(r.userHandle);
        return appel('/auth/connexion', { methode: 'POST', corps: corps, delai: 20000 }).then(function (j) {
          if (j.ok && typeof j.session === 'string' && JETON_RX.test(j.session)) { garderSession(j); return { ok: true, qui: court(j.qui, 60) }; }
          if (j.statut === 503) { EMP.reglee = false; return { ok: false, cle: true, msg: MSG.pasReglee }; }
          return { ok: false, absente: j.statut === 401, msg: 'Empreinte refusée par le relais : ' + (j.erreur || 'statut ' + j.statut) + '.' };
        }, function () { return { ok: false, msg: MSG.muet }; });
      }, function (e) {
        var n = e && e.name;
        return { ok: false, msg: messageWebAuthn(e, false), absente: n === 'NotAllowedError', cle: n === 'NotSupportedError' || n === 'SecurityError' };
      });
    });
  }
  // Les options d'inscription de CET appareil (avec la clé ou la session) : { etat: 'ok', o } · { etat: 'pas_reglee' } · erreur.
  function demanderInscription() {
    return appelAcces('/auth/options/inscription', { methode: 'POST', corps: { nom: nomDeCetAppareil() }, delai: 8000 }).then(function (j) {
      if (j.statut === 503) { EMP.reglee = false; return { etat: 'pas_reglee' }; }
      var o = j.publicKey && typeof j.publicKey === 'object' ? j.publicKey : j;
      if (j.ok && typeof o.challenge === 'string' && o.user && typeof o.user.id === 'string' && o.rp) { EMP.reglee = true; return { etat: 'ok', o: o, a: Date.now() }; }
      if (j.statut === 401) return { etat: 'erreur', msg: 'Ta clé d’équipe n’est plus reconnue : impossible d’activer l’empreinte.' };
      return { etat: 'erreur', msg: phrase(j.erreur) || 'Le relais a refusé (statut ' + j.statut + ').' };
    }, function () { return { etat: 'erreur', msg: MSG.muet }; });
  }
  function prechargerInscription() {
    if (frais(EMP.inscription) || EMP.inscrEnRoute || !empreintePossible() || EMP.reglee === false) return;
    EMP.inscrEnRoute = demanderInscription().then(function (r) { EMP.inscrEnRoute = null; if (r.etat === 'ok' && !r.pris) EMP.inscription = r; return r; });
  }
  // Activer l'empreinte sur cet appareil. Rend { ok, appareil } ou { ok: false, msg }.
  function activerEmpreinte() {
    if (!empreintePossible() || typeof navigator.credentials.create !== 'function') return Promise.resolve({ ok: false, msg: 'Ce navigateur ne sait pas créer d’empreinte.' });
    var d = EMP.inscription; EMP.inscription = null;
    var p = frais(d) ? Promise.resolve(d) : (EMP.inscrEnRoute || demanderInscription());
    return p.then(function (r) {
      if (EMP.inscription === r) EMP.inscription = null;
      r.pris = true;
      if (r.etat === 'pas_reglee') return { ok: false, msg: MSG.pasReglee };
      if (r.etat !== 'ok') return { ok: false, msg: r.msg };
      var o = r.o, pk = { rp: { id: o.rp.id, name: String(o.rp.name || '770lab') },
        user: { id: versOctets(o.user.id), name: String(o.user.name || ''), displayName: String(o.user.displayName || o.user.name || '') },
        challenge: versOctets(o.challenge),
        pubKeyCredParams: Array.isArray(o.pubKeyCredParams) ? o.pubKeyCredParams : [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: o.authenticatorSelection || { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        attestation: 'none', timeout: Number(o.timeout) || 120000,
        excludeCredentials: (Array.isArray(o.excludeCredentials) ? o.excludeCredentials : []).filter(function (c) { return c && typeof c.id === 'string'; }).map(function (c) {
          var x = { type: 'public-key', id: versOctets(c.id) }; if (Array.isArray(c.transports)) x.transports = c.transports; return x;
        }) };
      return navigator.credentials.create({ publicKey: pk }).then(function (c) {
        var rr = c.response, corps = { id: c.id, rawId: versB64u(c.rawId), type: c.type,
          response: { clientDataJSON: versB64u(rr.clientDataJSON), attestationObject: versB64u(rr.attestationObject) } };
        try { if (typeof rr.getTransports === 'function') corps.response.transports = rr.getTransports(); } catch (e) {}
        try { if (typeof rr.getPublicKeyAlgorithm === 'function') corps.response.publicKeyAlgorithm = rr.getPublicKeyAlgorithm(); } catch (e) {}
        try { var spki = typeof rr.getPublicKey === 'function' ? rr.getPublicKey() : null; if (spki) corps.response.publicKey = versB64u(spki); } catch (e) {}
        return appel('/auth/inscription', { methode: 'POST', corps: corps, delai: 20000 }).then(function (j) {
          if (j.ok && typeof j.session === 'string' && JETON_RX.test(j.session)) { garderSession(j); return { ok: true, appareil: j.appareil }; }
          return { ok: false, msg: 'Le relais a refusé cet appareil : ' + (j.erreur || 'statut ' + j.statut) + '.' };
        }, function () { return { ok: false, msg: MSG.muet }; });
      }, function (e) { return { ok: false, msg: messageWebAuthn(e, true) }; });
    });
  }
  // Après un envoi fait avec la clé d'équipe : « Activer l’empreinte sur cet appareil », proposé UNE fois, si l'appareil a sa propre
  // empreinte et si le relais l'a réglée (GET /auth/options/connexion ne répond pas 503 ; le défi reçu servira à la connexion).
  function proposerEmpreinte() {
    if (lire(PROPOSEE_CLE) || sessionGardee() || !lire(CLE_STOCKAGE) || !empreintePossible() || EMP.reglee === false || typeof navigator.credentials.create !== 'function') return;
    plateformeEmpreinte().then(function (oui) {
      if (!oui) return null;
      return appel('/auth/options/connexion', { delai: ETAT_DELAI_MS }).then(function (j) {
        if (j.statut === 503) { EMP.reglee = false; return; }
        if (!j.ok || typeof j.challenge !== 'string') return;
        EMP.reglee = true; EMP.defi = { etat: 'ok', o: j, a: Date.now() };
        if (!fond || vue !== 'signaler' || envoiEnCours || sessionGardee() || lire(PROPOSEE_CLE)) return;
        ecrire(PROPOSEE_CLE, '1');
        EMP.offre = true;
        var e = fond.querySelector('.sgn-etat');
        if (e && !fond.querySelector('.sgn-offre')) { e.insertAdjacentHTML('afterend', htmlOffre()); rendus++; }   // rendus : la fenêtre ne se ferme plus d'elle-même
        prechargerInscription();
      });
    }).catch(function () {});
  }
  var EMPREINTE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
    + '<path d="M5.6 18.6A9.6 9.6 0 0 1 3.4 12 8.6 8.6 0 0 1 19 7"/><path d="M20.4 10.4c.1.5.1 1 .1 1.6 0 2.4-.4 4.6-1.2 6.6"/>'
    + '<path d="M7.9 16.4A10.6 10.6 0 0 1 7.5 12a4.5 4.5 0 0 1 9 0c0 3-.6 5.8-1.8 8.2"/><path d="M12 12c0 3.4-.9 6.4-2.7 8.9"/>'
    + '<path d="M6.8 5.1A8.5 8.5 0 0 1 12 3.4c1.3 0 2.6.3 3.7.8"/></svg>';
  // Ni session ni clé : « Se connecter avec l’empreinte » (et « J’ai une clé »), ou le champ de la clé (navigateur sans empreinte,
  // relais pas encore réglé, « J’ai une clé » touché). ou : 'signaler' | 'demandes'.
  function htmlAcces(ou) {
    var peut = empreintePossible() && EMP.reglee !== false;
    if (peut && !montrerCle) return '<div class="sgn-connexion"><button type="button" class="sgn-bouton sgn-emp" data-a="empreinte">' + EMPREINTE_SVG
      + '<span>Se connecter avec l’empreinte</span></button><button type="button" class="sgn-lien" data-a="jaicle">J’ai une clé</button></div>'
      + '<p class="sgn-aide">' + (ou === 'demandes' ? 'Pour voir tes demandes : ton' : 'Ton') + ' doigt (ou ton visage) suffit, rien à taper. La première fois sur cet appareil : « J’ai une clé ».</p>';
    var vers = peut ? '<div class="sgn-pied"><button type="button" class="sgn-lien" data-a="sanscle">Se connecter avec l’empreinte</button></div>' : '';
    var champ = '<input class="sgn-cle" data-a="cle" type="password" autocomplete="off" placeholder="Ta clé d’équipe (donnée par l’administrateur)">'
      + '<p class="sgn-aide">Demandée une seule fois : elle reste dans ce navigateur.</p>';
    if (ou === 'demandes') return (D.erreur ? '' : '<p class="sgn-aide">Pour voir tes demandes, tape ta clé d’équipe (la même que pour envoyer).</p>')
      + champ + '<button type="button" class="sgn-envoyer" data-a="voircle">Voir mes demandes</button>' + vers;
    return champ + vers;
  }
  // Le bloc de connexion redessiné seul (sans refaire la fenêtre : la personne écrit peut-être), quand on apprend que l'empreinte
  // n'est pas réglée, ou qu'on passe de l'empreinte à la clé et retour.
  function majAcces() {
    var z = fond && fond.querySelector('.sgn-acces');
    if (!z || aAcces()) return;
    var dedans = z.contains(document.activeElement);
    z.innerHTML = htmlAcces(vue);
    if (dedans) { var c = z.querySelector('.sgn-cle, button'); if (c) try { c.focus({ preventScroll: true }); } catch (e) { c.focus(); } }
  }
  function htmlOffre() {
    if (!EMP.offre || sessionGardee() || !lire(CLE_STOCKAGE) || EMP.reglee === false) return '';
    return '<div class="sgn-offre" role="group" aria-label="Activer l’empreinte sur cet appareil"><p class="sgn-offre-t">' + EMPREINTE_SVG
      + '<span><b>Activer l’empreinte sur cet appareil ?</b> La prochaine fois, ton doigt (ou ton visage) suffira : plus de clé à taper.</span></p>'
      + '<div class="sgn-rang"><button type="button" class="sgn-bouton sgn-prim" data-a="activer">Activer l’empreinte</button>'
      + '<button type="button" class="sgn-bouton" data-a="plustard">Plus tard</button></div></div>';
  }

  // ── LA PHOTO DE L'ÉCRAN ────────────────────────────────────────────────────────────────────────────────────────────────────
  function chargerHtml2canvas() {
    if (window.html2canvas) return Promise.resolve();
    return new Promise(function (ok, ko) {
      var s = document.createElement('script'); s.src = C.html2canvas; s.async = true;
      s.onload = function () { ok(); }; s.onerror = function () { ko(new Error('html2canvas introuvable')); };
      document.head.appendChild(s);
    });
  }
  function reduire(canvas) {
    var l = canvas.width, ht = canvas.height, r = Math.min(1, LARGEUR_MAX / l, HAUTEUR_MAX / ht);
    if (r >= 1) return canvas.toDataURL('image/jpeg', JPEG_Q);
    var c = document.createElement('canvas'); c.width = Math.round(l * r); c.height = Math.round(ht * r);
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', JPEG_Q);
  }
  // Deux images peintes (l'anneau est à l'écran) avant le gros travail ; onglet caché (pas d'image) : on n'attend pas plus.
  function attendrePeinture() {
    return new Promise(function (ok) {
      var fini = false, finir = function () { if (!fini) { fini = true; ok(); } };
      setTimeout(finir, 150);
      if (window.requestAnimationFrame) requestAnimationFrame(function () { requestAnimationFrame(function () { setTimeout(finir, 20); }); });
    });
  }
  // L'ÉLÉMENT SOUS CHAQUE POINT, relevé au moment de la photo (une grille d'environ 2 000 points, tous les 14 px au moins,
  // elementsFromPoint sans les nœuds du bouton ; ~60 ms sur un ordinateur, pendant que l'anneau tourne) : un trait dessiné plus
  // tard, même sur un écran quitté depuis, retrouve ce qui était dessous.
  function decrireElement(el) {
    var l = [], e = el;
    for (var i = 0; e && e.nodeType === 1 && e !== document.body && e !== document.documentElement && i < 4; i++, e = e.parentElement) {
      var s = e.tagName.toLowerCase();
      if (e.id) s += '#' + court(e.id, 40); else { var c = classesDe(e).slice(0, 2); if (c.length) s += '.' + c.join('.'); }
      l.unshift(s);
      if (e.id) break;
    }
    var clic = el.closest ? el.closest('[onclick]') : null;
    return { chemin: court(l.join(' > '), 200), balise: el.tagName.toLowerCase(), id: court(el.id || '', 60),
      classes: classesDe(el).map(function (c) { return court(c, 40); }), texte: libelle(el, 80), onclick: clic ? court(clic.getAttribute('onclick'), 120) : '' };
  }
  function cartographier(vw, vh) {
    if (!document.elementsFromPoint || !vw || !vh) return null;
    var pas = Math.max(14, Math.ceil(Math.sqrt(vw * vh / 2000))), nc = Math.ceil(vw / pas), nr = Math.ceil(vh / pas);
    var vus = typeof Map === 'function' ? new Map() : null, k = [], e = [];
    if (!vus) return null;
    for (var j = 0; j < nr; j++) for (var i = 0; i < nc; i++) {
      var l = document.elementsFromPoint(Math.min(vw - 1, (i + 0.5) * pas), Math.min(vh - 1, (j + 0.5) * pas)), el = null, n = -1;
      for (var q = 0; q < l.length; q++) if (!estAMoi(l[q])) { el = l[q]; break; }
      if (el && el !== document.body && el !== document.documentElement) {
        el = cibleUtile(el);
        if (vus.has(el)) n = vus.get(el);
        else if (e.length < ELEMENTS_GRILLE) { n = e.length; vus.set(el, n); e.push(decrireElement(el)); }
      }
      k.push(n);
    }
    return { pas: pas, nc: nc, nr: nr, k: k, e: e };
  }
  // L'écran TEL QU'IL EST, la partie visible seulement. Le bouton, son nombre, la bulle et la fenêtre restent à l'écran (l'anneau
  // tourne) mais pas sur la photo (ignoreElements, data-html2canvas-ignore).
  function photographier() {
    var vw = window.innerWidth, vh = window.innerHeight, at = Date.now(), ou = court(document.title || location.pathname, 200);
    // Le fond de la page (sinon le transparent devient NOIR en JPEG, sous un contenu plus court que l'écran).
    var fondPage = '#ffffff';
    try {
      [document.body, document.documentElement].some(function (el) {
        var c = getComputedStyle(el).backgroundColor;
        if (c && !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(c)) { fondPage = c; return true; }
        return false;
      });
    } catch (e) {}
    occupe = true;
    if (fab) fab.classList.add('sgn-occupe');
    var fin = function () { occupe = false; if (fab) fab.classList.remove('sgn-occupe'); };
    var x = window.scrollX, y = window.scrollY;
    return chargerHtml2canvas().then(attendrePeinture).then(function () {
      var grille = null;
      try { grille = cartographier(vw, vh); } catch (e) {}
      return window.html2canvas(document.body, { x: x, y: y, width: vw, height: vh,
        scale: Math.min(window.devicePixelRatio || 1, 2), useCORS: true, logging: false, backgroundColor: fondPage,
        ignoreElements: function (el) { return estAMoi(el); },
        // La copie de la page rejoue les animations depuis zéro : ce qui entre en fondu y serait encore transparent.
        onclone: function (doc) {
          try {
            var st = doc.createElement('style');
            st.textContent = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition:none!important}';
            (doc.head || doc.documentElement).appendChild(st);
          } catch (e) {}
        } }).then(function (canvas) { return { donnees: reduire(canvas), ou: ou, traits: [], grille: grille, vw: vw, vh: vh, at: at }; });
    }).then(function (c) { fin(); return c; }, function (e) { fin(); throw e; });
  }
  function ajouterCapture(c) {
    if (!c || B.captures.length >= ECRANS_MAX) return false;
    B.captures.push(c);
    courante = B.captures.length - 1;
    joindreBoite();
    sauver();
    return true;
  }
  function importer(fichiers) {
    var l = Array.prototype.slice.call(fichiers || []).filter(function (f) { return /^image\//.test(f.type); });
    return Promise.all(l.map(function (f) {
      return new Promise(function (ok) {
        var img = new Image(), url = URL.createObjectURL(f);
        img.onload = function () { var c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0); URL.revokeObjectURL(url); ok(reduire(c)); };
        img.onerror = function () { URL.revokeObjectURL(url); ok(null); };
        img.src = url;
      });
    })).then(function (d) { d.filter(Boolean).forEach(function (x) { ajouterCapture({ donnees: x, ou: 'image importée', traits: [], grille: null, vw: 0, vh: 0, at: Date.now() }); }); });
  }
  // La boîte noire de CE moment-là, jointe au brouillon (sans doublon : une même ligne vue par deux écrans ne compte qu'une fois).
  function joindreBoite() {
    var vu = {};
    B.journal = B.journal.concat(extraitBoite()).filter(function (e) {
      var k = e.at + '|' + e.type + '|' + e.cible + '|' + e.detail;
      if (vu[k]) return false; vu[k] = 1; return true;
    }).sort(function (a, b) { return a.at - b.at; }).slice(-BOITE_MAX);
  }

  // ── LE DESSIN SUR LA CAPTURE ───────────────────────────────────────────────────────────────────────────────────────────────
  function tracer(g, traits, W, H) {
    g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = ROUGE; g.fillStyle = ROUGE;
    (traits || []).forEach(function (t) {
      var p = t.p, l = Math.max(1, t.l * W);
      if (!p || !p.length) return;
      if (p.length === 1) { g.beginPath(); g.arc(p[0][0] * W, p[0][1] * H, l / 2, 0, 2 * Math.PI); g.fill(); return; }
      g.lineWidth = l; g.beginPath(); g.moveTo(p[0][0] * W, p[0][1] * H);
      for (var i = 1; i < p.length; i++) g.lineTo(p[i][0] * W, p[i][1] * H);
      g.stroke();
    });
  }
  // L'image envoyée : la photo avec ses traits, à sa taille.
  function composer(c) {
    if (!c.traits || !c.traits.length) return Promise.resolve(c.donnees);
    return new Promise(function (ok) {
      var img = new Image();
      img.onload = function () {
        try {
          var cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
          var g = cv.getContext('2d'); g.drawImage(img, 0, 0); tracer(g, c.traits, cv.width, cv.height);
          ok(cv.toDataURL('image/jpeg', JPEG_Q));
        } catch (e) { ok(c.donnees); }
      };
      img.onerror = function () { ok(c.donnees); };
      img.src = c.donnees;
    });
  }
  // L'élément sous un trait : celui du milieu du trait, sinon celui que le trait touche le plus souvent.
  function elementDuTrait(c, t) {
    var g = c.grille;
    if (!g || !g.k || !t.p.length || !c.vw || !c.vh) return null;
    var a = function (fx, fy) {
      var i = Math.floor(fx * c.vw / g.pas), j = Math.floor(fy * c.vh / g.pas);
      return i < 0 || j < 0 || i >= g.nc || j >= g.nr ? -1 : g.k[j * g.nc + i];
    };
    var x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    t.p.forEach(function (q) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); });
    var n = a((x0 + x1) / 2, (y0 + y1) / 2);
    if (n < 0) {
      var compte = {}, mieux = -1;
      t.p.forEach(function (q) { var m = a(q[0], q[1]); if (m >= 0) { compte[m] = (compte[m] || 0) + 1; if (mieux < 0 || compte[m] > compte[mieux]) mieux = m; } });
      n = mieux;
    }
    return n >= 0 && g.e[n] ? g.e[n] : null;
  }
  function elementsDuBrouillon() {
    var r = [];
    B.captures.forEach(function (c, i) {
      (c.traits || []).forEach(function (t) { if (t.e && r.length < ELEMENTS_MAX) r.push(Object.assign({ ecran: i + 1 }, t.e)); });
    });
    return r;
  }
  var arrondi = function (x) { return Math.round(Math.max(0, Math.min(1, x)) * 10000) / 10000; };
  function traitsSvg(c) {
    return (c.traits || []).map(function (t) {
      var p = t.p.length === 1 ? [t.p[0], [t.p[0][0] + 0.0005, t.p[0][1]]] : t.p;
      return '<polyline points="' + p.map(function (q) { return Number(q[0]).toFixed(4) + ',' + Number(q[1]).toFixed(4); }).join(' ')
        + '" fill="none" stroke="' + ROUGE + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>';
    }).join('');
  }
  // La couche de dessin de la capture en grand (refaite à chaque rendu de la fenêtre).
  var dessinAjuster = null, observateur = null, finDessin = 0;
  function brancherDessin() {
    dessinAjuster = null;
    if (observateur) { observateur.disconnect(); observateur = null; }
    var cadre = fond && fond.querySelector('.sgn-toile'), c = B.captures[courante];
    if (!cadre || !c) return;
    var img = cadre.querySelector('img'), cv = cadre.querySelector('canvas'), g = cv.getContext('2d'), trait = null, id = null;
    function ajuster() {
      var r = img.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var d = Math.min(window.devicePixelRatio || 1, 3), w = Math.round(r.width * d), ht = Math.round(r.height * d);
      if (cv.width !== w || cv.height !== ht) { cv.width = w; cv.height = ht; }
      g.clearRect(0, 0, cv.width, cv.height);
      tracer(g, c.traits, cv.width, cv.height);
    }
    dessinAjuster = ajuster;
    if (img.complete && img.naturalWidth) ajuster(); else img.addEventListener('load', ajuster);
    if (window.ResizeObserver) { observateur = new ResizeObserver(function () { ajuster(); }); observateur.observe(img); }
    function point(e) { var r = cv.getBoundingClientRect(); return [arrondi((e.clientX - r.left) / r.width), arrondi((e.clientY - r.top) / r.height)]; }
    cv.addEventListener('pointerdown', function (e) {
      if (trait || (e.button != null && e.button > 0) || c.traits.length >= TRAITS_MAX) return;
      var r = cv.getBoundingClientRect();
      if (!r.width) return;
      e.preventDefault();
      id = e.pointerId;
      trait = { l: arrondi(EPAISSEUR_PX / r.width), p: [point(e)] };
      c.traits.push(trait);
      try { cv.setPointerCapture(id); } catch (er) {}
      ajuster();
    });
    cv.addEventListener('pointermove', function (e) {
      if (!trait || e.pointerId !== id) return;
      e.preventDefault();
      var r = cv.getBoundingClientRect(), p = point(e), q = trait.p[trait.p.length - 1];
      if ((Math.abs(p[0] - q[0]) * r.width < 1.5 && Math.abs(p[1] - q[1]) * r.height < 1.5) || trait.p.length >= POINTS_MAX) return;
      trait.p.push(p);
      // Seulement le nouveau bout : un long trait reste fluide.
      g.lineCap = 'round'; g.strokeStyle = ROUGE; g.lineWidth = Math.max(1, trait.l * cv.width);
      g.beginPath(); g.moveTo(q[0] * cv.width, q[1] * cv.height); g.lineTo(p[0] * cv.width, p[1] * cv.height); g.stroke();
    });
    function finir(e) {
      if (!trait || (e && e.pointerId !== id)) return;
      var t = trait; trait = null; id = null; finDessin = Date.now();
      t.e = elementDuTrait(c, t);
      ajuster();
      apresDessin();
    }
    cv.addEventListener('pointerup', finir);
    cv.addEventListener('pointercancel', finir);
  }
  // Après un trait (ou « Effacer le dessin ») : la vignette, le bouton « Effacer », le brouillon — sans refaire la fenêtre.
  function apresDessin() {
    var c = B.captures[courante];
    if (!fond || !c) return;
    var s = fond.querySelector('.sgn-v[data-i="' + courante + '"] svg'); if (s) s.innerHTML = traitsSvg(c);
    var gm = fond.querySelector('[data-a="gomme"]'); if (gm) gm.disabled = !c.traits.length;
    sauver();
  }
  function effacerDessin() {
    var c = B.captures[courante];
    if (!c) return;
    c.traits = [];
    if (dessinAjuster) dessinAjuster();
    apresDessin();
    var gm = fond && fond.querySelector('[data-a="gomme"]'); if (gm) gm.disabled = true;
    var t = fond && fond.querySelector('.sgn-texte'); if (t) try { t.focus({ preventScroll: true }); } catch (e) {}
  }

  // ── LE BROUILLON GARDÉ DANS L'ONGLET (sessionStorage) : il suit la personne d'une page à l'autre, jusqu'à l'envoi ──────────────
  // Mémoire du navigateur pleine : on le garde sans la note vocale, sinon en mémoire seulement (perdu si la page change).
  var minuteurSauver = null;
  function brouillonVide() {
    return B.captures.length <= 1 && !B.texte.trim() && !B.audio && !B.captures.some(function (c) { return c.traits && c.traits.length; });
  }
  function sauverMaintenant() {
    clearTimeout(minuteurSauver); minuteurSauver = null;
    var ss = null; try { ss = window.sessionStorage; } catch (e) { return; }
    if (!ss) return;
    try {
      if (!B.captures.length && !B.texte.trim() && !B.audio) { ss.removeItem(BROUILLON_CLE); return; }
      var o = { v: 1, type: B.type, texte: B.texte, audio: B.audio, captures: B.captures, journal: B.journal, attente: B.attente, courante: courante, a: Date.now() };
      try { ss.setItem(BROUILLON_CLE, JSON.stringify(o)); }
      catch (e) { o.audio = null; ss.setItem(BROUILLON_CLE, JSON.stringify(o)); }
    } catch (e) { try { ss.removeItem(BROUILLON_CLE); } catch (e2) {} }
  }
  function sauver() { clearTimeout(minuteurSauver); minuteurSauver = setTimeout(sauverMaintenant, 300); }
  window.addEventListener('pagehide', function () { if (minuteurSauver) sauverMaintenant(); });
  function effacerBrouillon() {
    clearTimeout(minuteurSauver); minuteurSauver = null;
    B = brouillonNeuf(); courante = 0;
    try { sessionStorage.removeItem(BROUILLON_CLE); } catch (e) {}
    majPastille();
  }
  var nombre01 = function (x) { return typeof x === 'number' && isFinite(x) && x >= 0 && x <= 1; };
  var IMAGE_RX = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
  // Relu au chargement : tout est revérifié (ce que la page aurait pu y écrire n'est pas cru tel quel).
  function restaurer() {
    var o = null;
    try { o = JSON.parse(sessionStorage.getItem(BROUILLON_CLE) || 'null'); } catch (e) { o = null; }
    if (!o || o.v !== 1 || !Array.isArray(o.captures)) return;
    var chaine = function (v, n) { return typeof v === 'string' ? v.slice(0, n) : ''; };
    var element = function (e) {
      if (!e || typeof e !== 'object') return null;
      return { chemin: chaine(e.chemin, 200), balise: chaine(e.balise, 30), id: chaine(e.id, 60), texte: chaine(e.texte, 80), onclick: chaine(e.onclick, 120),
        classes: (Array.isArray(e.classes) ? e.classes : []).filter(function (c) { return typeof c === 'string'; }).slice(0, 3).map(function (c) { return c.slice(0, 40); }) };
    };
    var captures = o.captures.filter(function (c) { return c && typeof c.donnees === 'string' && IMAGE_RX.test(c.donnees); }).slice(0, ECRANS_MAX).map(function (c) {
      var g = c.grille && typeof c.grille === 'object' && Array.isArray(c.grille.k) && Array.isArray(c.grille.e) && c.grille.pas > 0 ? c.grille : null;
      return { donnees: c.donnees, ou: chaine(c.ou, 200), vw: Number(c.vw) || 0, vh: Number(c.vh) || 0, at: Number(c.at) || 0,
        grille: g ? { pas: Number(g.pas), nc: Number(g.nc) || 0, nr: Number(g.nr) || 0, k: g.k.map(function (n) { return Number(n) | 0; }), e: g.e.map(element) } : null,
        traits: (Array.isArray(c.traits) ? c.traits : []).slice(0, TRAITS_MAX).map(function (t) {
          var p = (t && Array.isArray(t.p) ? t.p : []).filter(function (q) { return Array.isArray(q) && nombre01(q[0]) && nombre01(q[1]); }).slice(0, POINTS_MAX);
          return { l: nombre01(t && t.l) && t.l > 0 ? t.l : 0.01, p: p, e: element(t && t.e) };
        }).filter(function (t) { return t.p.length; }) };
    });
    var audio = o.audio && typeof o.audio.donnees === 'string' && /^data:audio\//.test(o.audio.donnees) ? { donnees: o.audio.donnees, duree: chaine(o.audio.duree, 10) } : null;
    B = { type: o.type === 'idee' ? 'idee' : 'bug', texte: chaine(o.texte, 4000), audio: audio, captures: captures, attente: !!o.attente,
      journal: (Array.isArray(o.journal) ? o.journal : []).filter(function (e) { return e && typeof e.type === 'string'; }).slice(-BOITE_MAX).map(function (e) {
        return { at: Number(e.at) || 0, type: chaine(e.type, 20), cible: chaine(e.cible, 160), detail: chaine(e.detail, 300) };
      }) };
    courante = Math.max(0, Math.min(B.captures.length - 1, Number(o.courante) | 0));
    // Une fenêtre ouverte puis quittée sans rien y mettre (la photo automatique seule) : rien à garder.
    if (brouillonVide() && !B.attente) effacerBrouillon();
  }
  restaurer();

  // ── LA PLACE DU ROND : appui long puis glisser ; gardée par page, en proportion de l'écran ─────────────────────────────────────
  var sonde = null;
  function encoches() {
    try {
      if (!sonde) {
        sonde = marquer(document.createElement('div'));
        sonde.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;'
          + 'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
        document.body.appendChild(sonde);
      }
      var s = getComputedStyle(sonde);
      return { t: parseFloat(s.paddingTop) || 0, r: parseFloat(s.paddingRight) || 0, b: parseFloat(s.paddingBottom) || 0, l: parseFloat(s.paddingLeft) || 0 };
    } catch (e) { return { t: 0, r: 0, b: 0, l: 0 }; }
  }
  var clePage = function () { return location.origin + location.pathname; };
  function lirePositions() { try { var o = JSON.parse(lire(POS_CLE) || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (e) { return {}; } }
  function positionDeLaPage() { var p = lirePositions()[clePage()]; return p && nombre01(p.x) && nombre01(p.y) ? p : null; }
  function garderPosition(x, y) {
    var o = lirePositions(), k = clePage();
    delete o[k];
    var l = Object.keys(o).sort(function (a, b) { return (Number(o[b].a) || 0) - (Number(o[a].a) || 0); }).slice(0, POSITIONS_MAX - 1), r = {};
    l.forEach(function (c) { r[c] = o[c]; });
    r[k] = { x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000, a: Date.now() };
    ecrire(POS_CLE, JSON.stringify(r));
  }
  function oublierPosition() { var o = lirePositions(); delete o[clePage()]; ecrire(POS_CLE, Object.keys(o).length ? JSON.stringify(o) : ''); }
  function bornes() {
    var w = fab.offsetWidth || 48, ht = fab.offsetHeight || 48, s = encoches(), W = largeur(), H = window.innerHeight;
    var x0 = MARGE + s.l, y0 = MARGE_HAUT + s.t;
    return { w: w, h: ht, W: W, H: H, x0: x0, x1: Math.max(x0, W - w - MARGE - s.r), y0: y0, y1: Math.max(y0, H - ht - MARGE - s.b) };
  }
  var important = function (el, p, v) { el.style.setProperty(p, v, 'important'); };
  function poser(x, y) {
    var b = bornes();
    x = Math.round(Math.max(b.x0, Math.min(b.x1, x))); y = Math.round(Math.max(b.y0, Math.min(b.y1, y)));
    fab.classList.add('sgn-deplace');
    important(fab, 'left', x + 'px'); important(fab, 'top', y + 'px'); important(fab, 'right', 'auto'); important(fab, 'bottom', 'auto');
    suivre();
  }
  // À sa place gardée pour cette page (ramenée dans l'écran), sinon à celle du CSS (celle de la page, qui peut la remonter).
  function placer() {
    if (!fab) return;
    var p = positionDeLaPage();
    if (!p) {
      fab.classList.remove('sgn-deplace');
      ['left', 'top', 'right', 'bottom'].forEach(function (k) { fab.style.removeProperty(k); });
      suivre();
      return;
    }
    var b = bornes();
    poser(p.x * (b.W - b.w), p.y * (b.H - b.h));
  }
  // Le nombre rouge suit le rond déplacé (son coin haut droit) ; la bulle aussi.
  function suivre() {
    if (badge) {
      if (fab && fab.classList.contains('sgn-deplace')) {
        var l = parseFloat(fab.style.left) || 0, t = parseFloat(fab.style.top) || 0, w = fab.offsetWidth || 48, bw = badge.offsetWidth || 22;
        important(badge, 'left', Math.round(Math.max(2, Math.min(largeur() - bw - 2, l + w + 9 - bw))) + 'px');
        important(badge, 'top', Math.round(Math.max(2, t - 7)) + 'px');
        important(badge, 'right', 'auto'); important(badge, 'bottom', 'auto');
      } else ['left', 'top', 'right', 'bottom'].forEach(function (k) { badge.style.removeProperty(k); });
    }
    placerBulle();
  }
  var redimEnAttente = false;
  function surRedimension() {
    if (redimEnAttente) return;
    redimEnAttente = true;
    (window.requestAnimationFrame || setTimeout)(function () { redimEnAttente = false; placer(); if (dessinAjuster) dessinAjuster(); });
  }
  window.addEventListener('resize', surRedimension);
  window.addEventListener('orientationchange', surRedimension);
  // Toucher court = photographier ; appui long (0,38 s sans bouger) = on le soulève, il suit le doigt ou la souris.
  var finGeste = 0;
  // LA VIBRATION : navigator.vibrate (Android) ; sur iPhone, qui n'a pas vibrate, l'interrupteur caché d'iOS 18 basculé dans le geste
  // (le même tour que le pupitre). Marqué data-sgn : la boîte noire ne le note pas.
  var labHaptique = null;
  function vibrer(ms) {
    try {
      if (typeof navigator.vibrate === 'function') { navigator.vibrate(ms); return; }
      if (!(/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))) return;
      if (!labHaptique) {
        labHaptique = document.createElement('label'); labHaptique.setAttribute('data-sgn', 'haptique'); labHaptique.setAttribute('aria-hidden', 'true');
        labHaptique.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden';
        var inp = document.createElement('input'); inp.type = 'checkbox'; inp.setAttribute('switch', ''); inp.tabIndex = -1;
        labHaptique.appendChild(inp);
        labHaptique.addEventListener('click', function (e) { e.stopPropagation(); }); inp.addEventListener('click', function (e) { e.stopPropagation(); });
        document.body.appendChild(labHaptique);
      }
      labHaptique.click();
    } catch (e) {}
  }
  function gestes(b) {
    var d = null;
    b.addEventListener('pointerdown', function (e) {
      if (d || (e.button != null && e.button > 0)) return;
      var r = b.getBoundingClientRect();
      d = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, porte: false, bouge: false, deplace: false };
      if (!occupe) b.classList.add('sgn-appui');
      d.minuteur = setTimeout(function () {
        if (!d || d.bouge) return;
        d.porte = true;
        // Le point de prise, mesuré sans l'enfoncement : le rond ne saute pas en se soulevant.
        var x0 = parseFloat(b.style.left), y0 = parseFloat(b.style.top);
        if (b.classList.contains('sgn-deplace') && isFinite(x0) && isFinite(y0)) { d.dx = d.x - x0; d.dy = d.y - y0; }
        else { var q = b.getBoundingClientRect(), w = b.offsetWidth || 48; d.dx = d.x - (q.left + q.width / 2 - w / 2); d.dy = d.y - (q.top + q.height / 2 - w / 2); }
        b.classList.remove('sgn-appui'); b.classList.add('sgn-souleve');
        cacherBulle();
        try { b.setPointerCapture(d.id); } catch (er) {}
        vibrer(15);
      }, APPUI_LONG_MS);
    });
    b.addEventListener('pointermove', function (e) {
      if (!d || e.pointerId !== d.id) return;
      if (d.porte) { e.preventDefault(); d.deplace = true; poser(e.clientX - d.dx, e.clientY - d.dy); return; }
      if (Math.abs(e.clientX - d.x) > 10 || Math.abs(e.clientY - d.y) > 10) { d.bouge = true; clearTimeout(d.minuteur); b.classList.remove('sgn-appui'); }
    });
    function fin(e) {
      if (!d || (e && e.pointerId !== d.id)) return;
      clearTimeout(d.minuteur);
      var x = d; d = null;
      b.classList.remove('sgn-appui', 'sgn-souleve');
      if (!x.porte) return;
      finGeste = Date.now();   // le « click » qui suit le lâcher n'est pas un toucher
      if (x.deplace) {
        var bo = bornes(), l = parseFloat(b.style.left) || 0, t = parseFloat(b.style.top) || 0;
        garderPosition(bo.W > bo.w ? l / (bo.W - bo.w) : 0, bo.H > bo.h ? t / (bo.H - bo.h) : 0);
      }
    }
    b.addEventListener('pointerup', fin);
    b.addEventListener('pointercancel', fin);
    b.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    b.addEventListener('click', function (e) {
      if (Date.now() - finGeste < 700) { e.preventDefault(); return; }
      vibrer(10);
      ouvrir();
    });
  }
  function remettreBouton() { oublierPosition(); placer(); rendre('Le bouton est revenu à sa place.', 'ok'); }

  // ── LA PASTILLE (écrans en attente), LE POINT ROUGE ET LA BULLE ─────────────────────────────────────────────────────────────
  function majPastille() {
    if (!fab) return;
    var n = fond ? 0 : B.captures.length, p = fab.querySelector('.sgn-pastille');
    if (p) p.textContent = String(n);
    fab.classList.toggle('sgn-attente', n > 0);
    var l = n ? 'Signaler à Claude : ' + n + (n > 1 ? ' écrans' : ' écran') + ' en attente, toucher pour ' + (B.attente && n < ECRANS_MAX ? 'ajouter cet écran' : 'reprendre')
      : 'Signaler un bug ou une idée';
    if (fab.classList.contains('sgn-alerte')) l += '. Un problème vient d’arriver sur cette page';
    fab.setAttribute('aria-label', l);
  }
  var bulleMinuteur = null, alerteLigne = '', alertesVues = Object.create(null), alertesMontrees = 0, enAlerte = false;
  function rondVisible() { return !!(fab && fab.isConnected && !cacheParPage && !coupe && fab.style.display !== 'none'); }
  function montrerBulle(genre, texte) {
    if (!document.body || !rondVisible()) return;
    if (!bulle) {
      bulle = marquer(document.createElement('div'));
      bulle.className = 'sgn-bulle';
      bulle.setAttribute('role', 'status'); bulle.setAttribute('aria-live', 'polite');
      bulle.addEventListener('click', function (e) {
        var a = e.target.closest ? e.target.closest('[data-a]') : null, quoi = a ? a.getAttribute('data-a') : '';
        if (quoi === 'b-signaler') { eteindreAlerte(); cacherBulle(); ouvrir({ nouvelEcran: true, ligne: alerteLigne }); }
        else if (quoi === 'b-ignorer') { eteindreAlerte(); cacherBulle(); if (fab) fab.focus({ preventScroll: true }); }
        else if (bulle.getAttribute('data-genre') === 'info') cacherBulle();
      });
      document.body.appendChild(bulle);
    }
    bulle.setAttribute('data-genre', genre);
    bulle.innerHTML = '<p>' + h(texte) + '</p>' + (genre === 'alerte'
      ? '<div class="sgn-bulle-r"><button type="button" class="sgn-bulle-ok" data-a="b-signaler">Signaler</button><button type="button" data-a="b-ignorer">Ignorer</button></div>' : '');
    bulle.style.display = '';
    placerBulle();
    clearTimeout(bulleMinuteur);
    bulleMinuteur = setTimeout(cacherBulle, genre === 'alerte' ? 20000 : 6000);
  }
  function cacherBulle() { clearTimeout(bulleMinuteur); if (bulle) bulle.style.display = 'none'; }
  function placerBulle() {
    if (!bulle || bulle.style.display === 'none') return;
    if (!rondVisible()) { cacherBulle(); return; }
    var r = fab.getBoundingClientRect(), W = largeur(), H = window.innerHeight, bw = bulle.offsetWidth, bh = bulle.offsetHeight;
    var x = r.left + r.width / 2 > W / 2 ? r.right - bw : r.left, y = r.top - bh - 14;
    if (y < 8) y = r.bottom + 14;
    bulle.style.left = Math.round(Math.max(8, Math.min(W - bw - 8, x))) + 'px';
    bulle.style.top = Math.round(Math.max(8, Math.min(H - bh - 8, y))) + 'px';
  }
  // Une erreur ou une requête en échec : le point rouge et la bulle, une fois par erreur et par chargement de la page, et
  // seulement si le rond est à l'écran (fenêtre fermée). ligne : ce que la fenêtre écrira pour la personne si elle signale.
  function alerter(cle, ligne) {
    if (enAlerte) return;
    enAlerte = true;
    try {
      if (alertesVues[cle] || alertesMontrees >= ALERTES_MAX || !rondVisible() || fond || occupe) return;
      alertesVues[cle] = 1; alertesMontrees++;
      alerteLigne = ligne;
      fab.classList.add('sgn-alerte');
      majPastille();
      montrerBulle('alerte', 'Un problème vient d’arriver sur cette page. Le signaler ?');
    } catch (e) {} finally { enAlerte = false; }
  }
  function eteindreAlerte() { if (fab) fab.classList.remove('sgn-alerte'); majPastille(); }

  // ── LA PAROLE : dictée du navigateur quand il sait (Chrome, Edge, Safari), sinon une note vocale jointe ───────────────────
  // LES MOTS DOUBLÉS ET L'ARRÊT AU PREMIER SILENCE (21/10/2026, Yoann : « ça me dédouble les mots […] et ça s'arrête, je suis obligé à
  // chaque fois de rappuyer »). En mode continu, Chrome renvoie des résultats qui reprennent les précédents (« dans », « dans chaque »,
  // « dans chaque conversation »…) et coupe au premier silence. Désormais une phrase à la fois (continuous = false), relancée tant
  // qu'on n'a pas rappuyé, ses morceaux recollés sans répétition (recoller) ; trois relances sans un mot l'arrêtent.
  var Reco = window.SpeechRecognition || window.webkitSpeechRecognition;
  function cleMot(m) { return String(m).toLowerCase().replace(/[.,;:!?…«»"'’()]/g, ''); }
  // morceaux : les textes des résultats, dans l'ordre → le texte dicté, chaque mot repris d'un morceau à l'autre écrit une fois
  function recoller(morceaux) {
    var acquis = [];
    (morceaux || []).forEach(function (s) {
      var m = String(s == null ? '' : s).trim().split(/\s+/).filter(Boolean), k = Math.min(acquis.length, m.length);
      for (; k > 0; k--) {
        var pareil = true;
        for (var i = 0; i < k && pareil; i++) pareil = cleMot(acquis[acquis.length - k + i]) === cleMot(m[i]);
        if (pareil) break;
      }
      acquis = acquis.concat(m.slice(k));
    });
    return acquis.join(' ');
  }
  // garder : la fin de la phrase en cours s'écrit encore (on a rappuyé) ; sinon (fenêtre fermée, envoi) plus rien ne s'écrit
  function arreterDictee(garder) {
    var t = dictee; if (!t) return;
    dictee = null; t.voulu = false; t.garder = garder !== false; if (t.ui) t.ui();
    try { if (t.r) t.r.stop(); } catch (e) {}
  }
  function basculerMicro(bouton, zone, etat) {
    if (Reco) {
      if (dictee) { arreterDictee(true); return; }
      var tour = dictee = { r: null, voulu: true, garder: true }, base = zone.value ? zone.value.replace(/\s*$/, ' ') : '', vides = 0;
      tour.ui = function () { bouton.setAttribute('aria-pressed', 'false'); bouton.textContent = 'Dicter'; };
      var fin = function (msg, ton) { tour.voulu = false; if (dictee === tour) { dictee = null; tour.ui(); } if (msg) dire(etat, msg, ton); };
      var lancer = function () {
        var r = tour.r = new Reco(), dit = '';
        r.lang = document.documentElement.lang || 'fr-FR'; r.continuous = false; r.interimResults = true; r.maxAlternatives = 1;
        r.onresult = function (ev) {
          if (!tour.garder || (dictee && dictee !== tour)) return;
          var l = []; for (var i = 0; i < ev.results.length; i++) l.push(ev.results[i][0].transcript);
          dit = recoller(l); zone.value = base + dit; B.texte = zone.value; sauver();
        };
        r.onerror = function (ev) {
          var e = String(ev && ev.error);
          if (e === 'not-allowed' || e === 'service-not-allowed') fin('Micro refusé : autorise-le dans le navigateur.', 'ko');
          else if (e === 'audio-capture' || e === 'network') fin('La dictée s’est arrêtée.', 'ko');
        };
        r.onend = function () {
          if (dit.trim()) { vides = 0; base = (base + dit).replace(/\s*$/, ' '); } else vides++;
          if (!tour.voulu || vides >= 3) { fin(tour.voulu ? 'Dictée arrêtée : je n’entends plus rien. Rappuie sur « Dicter » pour reprendre.' : ''); return; }
          setTimeout(function () { if (!tour.voulu) return; try { lancer(); } catch (e) { fin('La dictée s’est arrêtée.', 'ko'); } }, 120);
        };
        r.start();
      };
      try { lancer(); bouton.setAttribute('aria-pressed', 'true'); bouton.textContent = '■ Arrêter la dictée'; dire(etat, 'À l’écoute… parle normalement.'); }
      catch (e) { fin('Dictée impossible sur ce navigateur.', 'ko'); }
      return;
    }
    if (enregistreur) { enregistreur.stop(); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) { dire(etat, 'Ce navigateur ne sait ni dicter ni enregistrer : écris ton message.', 'ko'); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (flux) {
      var morceaux = [], debut = Date.now(), rec = new MediaRecorder(flux);
      rec.ondataavailable = function (e) { if (e.data && e.data.size) morceaux.push(e.data); };
      rec.onstop = function () {
        flux.getTracks().forEach(function (t) { t.stop(); });
        enregistreur = null; bouton.setAttribute('aria-pressed', 'false'); bouton.textContent = 'Note vocale';
        var blob = new Blob(morceaux, { type: rec.mimeType || 'audio/webm' }), s = Math.round((Date.now() - debut) / 1000);
        var lecteur = new FileReader();
        lecteur.onload = function () { B.audio = { donnees: String(lecteur.result), duree: Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') }; sauver(); dire(etat, 'Note vocale jointe (' + B.audio.duree + ').', 'ok'); };
        lecteur.readAsDataURL(blob);
      };
      rec.start(); enregistreur = rec; bouton.setAttribute('aria-pressed', 'true'); bouton.textContent = '■ Arrêter la note';
      dire(etat, '● Enregistrement… (3 minutes au plus)');
      setTimeout(function () { if (enregistreur === rec) rec.stop(); }, AUDIO_MAX_MS);
    }, function () { dire(etat, 'Micro refusé : autorise-le dans le navigateur.', 'ko'); });
  }

  function dire(el, t, ton) { if (!el) return; el.textContent = t || ''; el.classList.remove('ok', 'ko'); if (ton) el.classList.add(ton); }

  // ── MES DEMANDES : ce que le relais a gardé des demandes de CETTE clé, avec leur état ──────────────────────────────────────
  // Les états et leurs libellés : les mêmes que le relais (LIBELLES_ETATS de relay/coeur.mjs).
  var ETATS = { envoyee: 'en cours', pas_partie: 'pas partie', a_relire: 'à relire', question: 'question', rien: 'rien à faire', echec: 'échec', en_ligne: 'en ligne',
    a_valider: 'à valider', annulee: 'annulée', en_cours_annulation: 'annulation en cours', en_cours_validation: 'mise en ligne en cours' };
  var A_TRAITER = { question: 1, a_relire: 1, a_valider: 1, pas_partie: 1 };   // ce qui attend le propriétaire
  var EN_COURS = { envoyee: 1, en_cours_annulation: 1, en_cours_validation: 1 };   // une session Claude y travaille
  var FILTRES = [
    { id: 'toutes', lib: 'Toutes', garde: function () { return true; }, vide: 'Aucune demande pour l’instant.' },
    { id: 'traiter', lib: 'À traiter', garde: function (x) { return !!A_TRAITER[x.etat] && !horsConversation(x); }, vide: 'Rien à traiter pour l’instant.' },
    { id: 'cours', lib: 'En cours', garde: function (x) { return !!EN_COURS[x.etat]; }, vide: 'Rien en cours pour l’instant.' },
  ];
  var NOMS_FILTRE = { toutes: 'toutes', tout: 'toutes', traiter: 'traiter', a_traiter: 'traiter', 'à traiter': 'traiter', cours: 'cours', en_cours: 'cours', 'en cours': 'cours' };
  // liste : null tant que rien n'est lu · auto : le filtre suit le nombre à traiter (ouvert par l'API sans filtre)
  // projet : la liste ne montre que ce projet (Signaler.demandes({ projet })), null : tous
  var D = { liste: null, stockage: true, erreur: '', enCours: false, filtre: 'toutes', auto: false, luA: 0, projet: null };
  var vue = 'signaler', vueRendue = '', depuisSignaler = false, rendus = 0, numeroLecture = 0;
  // Les abonnements Claude (GET /routine), lus seulement quand une carte pourrait proposer « Renvoyer sur l’autre abonnement ».
  var R = { abonnements: null, luA: 0, enRoute: null };

  // Les conversations de l'Atelier 770LAB (mêmes règles que atelier/regles.js de 770lab.github.io) : une réponse envoyée de
  // l'Atelier est une demande dont le texte commence par « SUITE DE LA DEMANDE <réf> » ; elle continue la conversation de <réf>,
  // et seule la DERNIÈRE réponse d'une conversation peut être à traiter. Une conversation rangée dans « Réglé » (regleeLeMs de
  // sa demande d'origine, gardé par le relais) n'est plus à traiter, jusqu'à une réponse envoyée après.
  var SUITE_RX = /^\s*SUITE DE LA DEMANDE ([0-9a-f]{12})\b/;
  var CONV = { liste: null, hors: {}, reglee: {} };
  function conversations() {
    if (CONV.liste === D.liste) return CONV;
    var l = (D.liste || []).filter(function (x) { return x && x.id; }), par = {}, racine = {}, dernier = {}, hors = {}, reglee = {};
    l.forEach(function (x) { par[x.id] = x; });
    var racineDe = function (x) {
      var r = x, n = 0, m;
      while ((m = SUITE_RX.exec(String(r.texte || ''))) && par[m[1]] && par[m[1]] !== r && n++ < 20) r = par[m[1]];
      return r;
    };
    l.forEach(function (x) {
      var r = racineDe(x), d = dernier[r.id]; racine[x.id] = r;
      if (!d || (x !== r && Number(x.creeLeMs || 0) >= Number(d.creeLeMs || 0))) dernier[r.id] = x;
    });
    l.forEach(function (x) {
      var r = racine[x.id], m = Number(r.regleeLeMs) || 0;
      if (dernier[r.id] !== x) hors[x.id] = 1;
      else if (m && m >= Number(x.creeLeMs || 0)) { hors[x.id] = 1; reglee[x.id] = 1; }
    });
    CONV = { liste: D.liste, hors: hors, reglee: reglee };
    return CONV;
  }
  function horsConversation(x) { return !!(x && conversations().hors[x.id]); }
  function regleeIci(x) { return !!(x && conversations().reglee[x.id]); }

  // Le nombre du rond compte TOUTES les demandes à traiter ; la liste, celles du projet choisi s'il y en a un.
  function compteATraiter() { return D.liste ? D.liste.filter(FILTRES[1].garde).length : 0; }
  function listeVue() { return !D.liste ? [] : D.projet ? D.liste.filter(function (x) { return projetDe(x) === D.projet; }) : D.liste; }
  function httpsSur(u) { u = String(u || ''); return u.length <= 500 && /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : ''; }
  // Le projet d'une demande : son champ « projet » (relais à projets), sinon d'après l'adresse de la page où elle a été faite.
  function urlDe(x) { return x && x.page && typeof x.page === 'object' ? x.page.url : ''; }
  function projetDe(x) { return idProjet(x && x.projet) || projetDeLaPage(urlDe(x)) || ''; }
  // Ce que la carte en dit : le nom du projet, sinon l'adresse du site.
  function nomProjetDe(x) {
    var p = projetDe(x); if (p) return nomDuProjet(p);
    try { return new URL(String(urlDe(x) || '')).host.replace(/^www\./i, '').toLowerCase(); } catch (e) { return ''; }
  }
  // Par projet : { <id>: { aTraiter, total } } pour chaque projet de PROJETS (pour le pupitre, qui en fait une ligne chacun).
  function comptesParProjet() {
    var r = {};
    PROJETS.forEach(function (p) { r[p.id] = { aTraiter: 0, total: 0 }; });
    (D.liste || []).forEach(function (x) { var c = r[projetDe(x)]; if (!c) return; c.total++; if (FILTRES[1].garde(x)) c.aTraiter++; });
    return r;
  }
  function quand(ms) {
    var d = new Date(Number(ms));
    if (!ms || isNaN(d.getTime())) return '';
    var o = { day: 'numeric', month: 'long' };
    if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
    try { return d.toLocaleDateString('fr-FR', o) + ' à ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }
  function heure(ms) { try { return new Date(ms || Date.now()).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }

  // Lit la liste. Rend une promesse ; seule la DERNIÈRE lecture lancée est retenue (une réponse lente n'écrase pas une plus fraîche).
  // Une carte qui pourrait proposer « Renvoyer sur l’autre abonnement » fait lire aussi les abonnements (GET /routine).
  function chargerDemandes() {
    if (!C.endpoint || !aAcces()) return Promise.resolve();
    var n = ++numeroLecture;
    D.enCours = true;
    return appelAcces('/demandes', { delai: 15000 }).then(function (j) {
      if (n !== numeroLecture) return;
      if (j.ok) {
        D.liste = (Array.isArray(j.demandes) ? j.demandes : []).filter(function (x) { return x && typeof x === 'object'; })
          .sort(function (a, b) { return (Number(b.creeLeMs) || 0) - (Number(a.creeLeMs) || 0); });
        D.stockage = j.stockage !== false; D.erreur = ''; D.luA = Date.now();
        try { window.dispatchEvent(new CustomEvent('signaler:demandes', { detail: { aTraiter: compteATraiter(), total: D.liste.length, projets: comptesParProjet() } })); } catch (e) {}
        if (D.liste.some(function (x) { return x.abonnement && actionsDe(x).indexOf('renvoyer') >= 0; })) return chargerRoutine();
      } else if (j.sessionPerdue) { D.liste = null; D.erreur = MSG.sessionPerdue; }
      else if (j.statut === 401 || j.cle) {
        ecrire(CLE_STOCKAGE, ''); D.liste = null; montrerCle = true;
        D.erreur = 'Clé refusée : le relais ne la connaît pas. Tape à nouveau ta clé d’équipe.';
      } else if (j.statut === 403) D.erreur = MSG.origine;
      else if (j.statut === 503 || j.stockage === false) { D.liste = []; D.stockage = false; D.erreur = ''; }
      else if (j.statut === 404) D.erreur = MSG.ancien;
      else D.erreur = 'Le relais a répondu une erreur (' + (j.erreur ? j.erreur + ', ' : '') + 'statut ' + j.statut + ').';
    }, function () {
      return diagnostiquer().then(function (cause) { if (n === numeroLecture) D.erreur = MSG[cause] || MSG.injoignable; });
    }).then(function () { if (n === numeroLecture) { D.enCours = false; majCompteur(); } });
  }
  // Les abonnements Claude réglés (gardés 2 minutes). Relais d'avant les deux abonnements : rien (pas d'« autre abonnement »).
  function chargerRoutine() {
    if (R.enRoute) return R.enRoute;
    if (R.luA && Date.now() - R.luA < ROUTINE_GARDE_MS) return Promise.resolve();
    R.enRoute = appelAcces('/routine', { delai: 6000 }).then(function (j) {
      if (j.ok && Array.isArray(j.abonnements)) R.abonnements = j.abonnements.filter(function (a) { return a && (a.id === '1' || a.id === '2'); });
      else if (j.statut === 404) R.abonnements = [];
    }, function () {}).then(function () { R.enRoute = null; R.luA = Date.now(); });
    return R.enRoute;
  }
  // Le nombre sur le rond et dans l'en-tête de la fenêtre.
  function majCompteur() {
    var n = aAcces() ? compteATraiter() : 0;
    if (badge) {
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.setAttribute('aria-label', n + (n > 1 ? ' demandes' : ' demande') + ' à traiter : voir la liste');
      badge.title = badge.getAttribute('aria-label');
      badge.style.display = n && fab && !cacheParPage ? '' : 'none';
      suivre();
    }
    var t = fond && fond.querySelector('.sgn-tete [data-a="demandes"]');
    if (t) { t.innerHTML = 'Mes demandes' + (n ? ' <span class="sgn-nb">' + n + '</span>' : ''); t.setAttribute('aria-label', 'Mes demandes' + (n ? ', ' + n + ' à traiter' : '')); }
  }
  // filtre : 'toutes' | 'traiter' | 'cours', ou null (« À traiter » s'il y en a) · projet : un id, ou null pour tous les projets.
  function filtreAuto() { return listeVue().filter(FILTRES[1].garde).length ? 'traiter' : 'toutes'; }
  function ouvrirDemandes(filtre, projet) {
    if (envoiEnCours || !document.body) return;
    if (vue !== 'demandes') depuisSignaler = !!fond && vue === 'signaler';
    vue = 'demandes';
    if (aAcces()) D.erreur = '';   // une vieille erreur ne s'affiche pas pendant la nouvelle lecture
    D.projet = projet || null;
    D.auto = !filtre;
    if (filtre) D.filtre = filtre; else if (D.liste) D.filtre = filtreAuto();
    rendre();
    chargerDemandes().then(function () {
      if (!fond || vue !== 'demandes') return;
      if (D.auto) D.filtre = filtreAuto();
      rendre();
    });
  }
  function validerCle() {
    var champ = fond && fond.querySelector('.sgn-cle'), etat = fond && fond.querySelector('.sgn-etat');
    if (!champ) return;
    var k = champ.value.trim();
    if (k.length < 16) { dire(etat, 'Tape ta clé d’équipe (16 caractères au moins).', 'ko'); champ.focus(); return; }
    ecrire(CLE_STOCKAGE, k); D.erreur = ''; D.liste = null;
    ouvrirDemandes(D.auto ? null : D.filtre, D.projet);
  }
  // « Se connecter avec l’empreinte » (dans la fenêtre du signalement ou dans « Mes demandes »).
  function seConnecter(el) {
    el.disabled = true;
    dire(fond.querySelector('.sgn-etat'), 'Pose ton empreinte…');
    connexionEmpreinte().then(function (r) {
      if (!fond) return;
      if (!r.ok) {
        el.disabled = false;
        if (r.cle) { montrerCle = true; majAcces(); }
        dire(fond.querySelector('.sgn-etat'), r.msg, 'ko');
        return;
      }
      D.erreur = ''; D.liste = null;
      if (vue === 'demandes') { ouvrirDemandes(D.auto ? null : D.filtre, D.projet); return; }
      rendre('Connecté' + (r.qui ? ' (' + r.qui + ')' : '') + ' : tu peux envoyer.', 'ok');
      chargerDemandes();
    });
  }
  // « Activer l’empreinte » (la proposition faite après un envoi par la clé, ou après une empreinte introuvable).
  function activer(el) {
    el.disabled = true;
    dire(fond.querySelector('.sgn-etat'), 'Pose ton empreinte pour l’activer…');
    activerEmpreinte().then(function (r) {
      if (!fond) return;
      if (!r.ok) { el.disabled = false; dire(fond.querySelector('.sgn-etat'), r.msg, 'ko'); return; }
      EMP.offre = false;
      // Ajouté avec la clé seule alors que la personne a déjà un appareil (« sur: false ») : il envoie, mais ne met pas en ligne.
      var dit = r.appareil && r.appareil.sur === false
        ? 'Empreinte activée sur cet appareil : la prochaine fois, elle suffira pour envoyer. Il a été ajouté avec la clé d’équipe seule : pour mettre en ligne, l’empreinte de ton téléphone.'
        : 'Empreinte activée sur cet appareil : la prochaine fois, elle suffira.';
      rendre(dit, 'ok');
      if (vue === 'demandes') chargerDemandes().then(function () { if (fond && vue === 'demandes') rendre(dit, 'ok'); });
    });
  }

  // ── LES ACTIONS SUR UNE DEMANDE : renvoyer, annuler, mettre en ligne ──────────────────────────────────────────────────────────
  // Ce que le relais permet pour une demande (son champ « actions ») ; un relais d'avant ne le dit pas : « Renvoyer » une demande
  // pas partie, comme avant.
  function actionsDe(x) { return Array.isArray(x.actions) ? x.actions.filter(function (a) { return typeof a === 'string'; }) : x.etat === 'pas_partie' ? ['renvoyer'] : []; }
  // L'autre abonnement que celui qui a pris la demande, s'il est réglé ('' sinon, ou si on ne sait pas).
  function autreAbonnement(x) {
    var a = String(x.abonnement || ''), autre = a === '1' ? '2' : a === '2' ? '1' : '';
    return autre && R.abonnements && R.abonnements.some(function (b) { return b.id === autre && b.regle; }) ? autre : '';
  }
  // POST /demandes/<réf>/<quoi>. Rend [message, ton], ou { empreinte: true } (le relais veut une empreinte fraîche). 403
  // « confiance » : reposer le doigt sur CET appareil n'y changerait rien (il a été ajouté avec la clé seule), on le dit.
  function agir(quoi, id, el, corps, m) {
    el.disabled = true;
    if (m.enCours) el.textContent = m.enCours;
    return appelAcces('/demandes/' + encodeURIComponent(id) + '/' + quoi, { methode: 'POST', corps: corps || {}, delai: 30000 }).then(function (j) {
      if (j.demande && typeof j.demande === 'object' && D.liste) { var d = j.demande; D.liste = D.liste.map(function (x) { return x.id === d.id ? d : x; }); }
      if (j.ok && j.demande && typeof j.demande === 'object') return m.ok(j.demande);
      if (j.coupe) { couper(); return [COUPE_MSG, 'ko']; }
      if (j.statut === 403 && j.confiance) return [MSG.confiance, 'ko'];
      if (j.statut === 403 && j.empreinte) return { empreinte: true };
      if (j.sessionPerdue) return [MSG.sessionPerdue, 'ko'];
      if (j.statut === 401 || j.cle) return ['', ''];   // la lecture qui suit le dira et redemandera la clé
      if (j.statut === 404) return ['Demande introuvable : elle a peut-être été effacée.', 'ko'];
      if (j.statut === 409) return [m.conflit ? m.conflit(j) : phrase(j.erreur) || 'Ce n’est plus possible pour cette demande.', 'ko'];
      return [m.echec + (j.erreur || 'erreur ' + j.statut) + '.', 'ko'];
    }, function () {
      return diagnostiquer().then(function (cause) {
        return [m.echec + (cause === 'reseau' ? 'le relais est injoignable.' : (MSG[cause] || '').replace(/^./, function (c) { return c.toLowerCase(); })), 'ko'];
      });
    });
  }
  // Après une action : la liste relue, puis le mot pour la personne.
  function apresAction(m) {
    if (!m || !Array.isArray(m)) m = ['', ''];
    return chargerDemandes().then(function () { if (fond && vue === 'demandes') rendre(m[0], m[1]); });
  }
  // « Renvoyer » ; ab : '1' | '2' pour « Renvoyer sur l’autre abonnement » (celui-là seul).
  function renvoyer(id, el, ab) {
    if (!aAcces() || !id) return;
    agir('renvoyer', id, el, ab ? { abonnement: ab } : {}, { enCours: 'Envoi…', echec: 'Pas renvoyée : ',
      ok: function (d) {
        return d.etat === 'pas_partie' ? ['Toujours pas partie' + (d.erreur ? ' : ' + d.erreur : '') + '.', 'ko']
          : ['Renvoyée à Claude' + (d.abonnement ? ' (abonnement ' + d.abonnement + ')' : '') + '.', 'ok'];
      },
      conflit: function (j) { return /abonnement/.test(String(j.erreur || '')) ? phrase(j.erreur) : 'Cette demande est déjà repartie : rien à renvoyer.'; } }).then(apresAction);
  }
  // « Annuler » une modification en ligne (après l'appui de 1,2 s) : le relais lance le travail ANNULER (git revert, en ligne).
  function annulerMiseEnLigne(id, el) {
    if (!aAcces() || !id) return;
    agir('annuler', id, el, {}, { enCours: 'Annulation…', echec: 'Annulation pas partie : ',
      ok: function () { return ['Annulation lancée : Claude retire le changement, puis vérifie le site. Le résultat arrivera ici.', 'ok']; } }).then(apresAction);
  }
  // « Mettre en ligne » une modification à valider : être connecté par l’empreinte suffit (pas de seconde empreinte). Sans session :
  // l’empreinte d’abord ; le relais la refuse encore : une fois de plus, puis on s’arrête.
  function mettreEnLigne(id, el) {
    if (!id) return;
    var pose = false;
    el.disabled = true;
    function empreinte() {
      if (!empreintePossible() || EMP.reglee === false)
        return Promise.resolve({ ok: false, msg: 'Mettre en ligne demande ton empreinte, ' + (EMP.reglee === false ? 'et la connexion par empreinte n’est pas encore réglée sur le relais.' : 'et ce navigateur ne sait pas la demander.') });
      pose = true;
      dire(fond.querySelector('.sgn-etat'), 'Pose ton empreinte pour mettre en ligne…');
      return connexionEmpreinte();
    }
    function lancer(forcer) {
      var s = sessionGardee();
      return (s && !forcer ? Promise.resolve({ ok: true }) : empreinte()).then(function (r) {
        if (!r.ok) {
          // Pas d'empreinte pour ce site sur cet appareil, mais une clé : proposer de l'activer, ici même.
          if (r.absente && lire(CLE_STOCKAGE) && !sessionGardee() && EMP.reglee !== false) EMP.offre = true;
          return [r.msg, 'ko'];
        }
        if (!fond) return null;
        return agir('valider', id, el, {}, { enCours: 'Mise en ligne…', echec: 'Mise en ligne pas partie : ',
          ok: function () { return ['Mise en ligne lancée : Claude fusionne la PR, attend que ce soit en ligne et vérifie le site. Le résultat arrivera ici.', 'ok']; } })
          .then(function (m) { return m && m.empreinte ? (pose ? ['Le relais demande encore ton empreinte : réessaie.', 'ko'] : lancer(true)) : m; });
      });
    }
    lancer(false).then(function (m) { if (m) apresAction(m); else if (fond) el.disabled = false; });
  }
  // « Annuler » se garde appuyé 1,2 s (doigt, souris ou clavier) : un toucher trop court ne fait rien, il dit comment faire.
  // Pendant l'appui, RIEN ne bouge au-dessus du bouton (le bouton qui se remplit suffit) : un message écrit dans .sgn-etat
  // décalait la carte, Chrome voyait alors la souris « quitter » le bouton immobile (pointerleave) et l'appui tombait.
  // Le bouton capture le pointeur (comme le fait déjà le doigt) : seul le relâcher ou une annulation du geste l'arrête.
  function brancherTenir(b) {
    var t = null;
    function etat() { return fond && fond.querySelector('.sgn-etat'); }
    function debut(e) {
      if (t || b.disabled || (e && e.button != null && e.button > 0)) return;
      if (e && e.pointerId != null) try { b.setPointerCapture(e.pointerId); } catch (er) {}
      b.classList.add('sgn-tient');
      t = setTimeout(function () { t = null; b.classList.remove('sgn-tient'); annulerMiseEnLigne(b.getAttribute('data-id'), b); }, TENIR_MS);
    }
    function fin() {
      if (!t) return;
      clearTimeout(t); t = null; b.classList.remove('sgn-tient');
      dire(etat(), 'Pas annulé : garde le doigt (ou la souris) appuyé une seconde sur « Annuler ».');
    }
    b.addEventListener('pointerdown', debut);
    ['pointerup', 'pointercancel', 'lostpointercapture', 'blur'].forEach(function (n) { b.addEventListener(n, fin); });
    // Sans capture (navigateur qui la refuse), sortir du bouton arrête l'appui ; avec la capture, ce n'est jamais un vrai départ.
    b.addEventListener('pointerleave', function (e) { try { if (b.hasPointerCapture(e.pointerId)) return; } catch (er) {} fin(); });
    b.addEventListener('keydown', function (e) { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); debut(); } });
    b.addEventListener('keyup', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fin(); } });
    b.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  // ── LES CAPTURES AVANT / APRÈS : vignettes sur la carte, visionneuse en plein écran ──────────────────────────────────────────
  // Une capture n'est montrée que si le relais la sert lui-même (…/piece/<32 hex>) : jamais une image venue d'ailleurs.
  function imageSure(u) {
    u = String(u || '');
    if (u.length > 400 || !/\/piece\/[0-9a-f]{32}$/.test(u)) return '';
    return u.indexOf(base() + '/piece/') === 0 || /^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/piece\/[0-9a-f]{32}$/.test(u) ? u : '';
  }
  // Capture avant / après refusée par la CSP de la page (img-src sans le relais, comme Avinou Malkenou qui ne l'admet qu'en
  // connect-src) : relue par fetch (le relais répond avec CORS aux ORIGINES) et montrée depuis la mémoire (blob:). Une seule
  // tentative par image, seulement pour une adresse /piece/ du relais et une réponse image ; sinon siKo(). Oubliées par oublier().
  // Par chercher() (le fetch d'origine : une pièce expirée n'entre ni dans la boîte noire ni dans le point rouge), sans cache
  // HTTP (no-store : une capture d'Avinou Malkenou ne reste pas sur le disque après le verrouillage). Une lecture partie avant
  // oublier() (génération changée) n'apporte rien : son blob n'est jamais créé.
  var IMAGES_MEMOIRE = {}, generationImages = 0;
  function imageEnMemoire(i, siKo) {
    var src = i.getAttribute('data-sgn-src') || i.getAttribute('src') || '';
    if (i.getAttribute('data-sgn-src') || !fetchNatif || !window.URL || !URL.createObjectURL || imageSure(src) !== src || src.indexOf(base() + '/piece/') !== 0) { siKo(); return; }
    i.setAttribute('data-sgn-src', src);
    if (IMAGES_MEMOIRE[src]) { i.src = IMAGES_MEMOIRE[src]; return; }
    var g = generationImages;
    chercher(src, { credentials: 'omit', cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('statut');
      return r.blob();
    }).then(function (b) {
      if (g !== generationImages) return;
      if (!/^image\/(jpeg|png|webp)$/.test(b.type || '')) throw new Error('genre');
      if (!IMAGES_MEMOIRE[src]) IMAGES_MEMOIRE[src] = URL.createObjectURL(b);
      if (i.isConnected !== false) i.src = IMAGES_MEMOIRE[src];
    }).catch(function () { if (g === generationImages) siKo(); });
  }
  function oublierImages() {
    generationImages++;
    Object.keys(IMAGES_MEMOIRE).forEach(function (k) { try { URL.revokeObjectURL(IMAGES_MEMOIRE[k]); } catch (e) {} });
    IMAGES_MEMOIRE = {};
  }
  function imagesDe(x) {
    var i = x && x.images && typeof x.images === 'object' ? x.images : {};
    return { avant: imageSure(i.avant), apres: imageSure(i.apres) };
  }
  function legende(x, k) {
    if (k === 'avant') return 'Avant le changement';
    return x.etat === 'a_valider' ? 'Après le changement (pas encore en ligne)' : x.etat === 'en_ligne' ? 'Après le changement (en ligne)' : 'Après le changement';
  }
  var vis = null, visRetour = null;
  function ouvrirVisionneuse(id, k, depuis) {
    var x = (D.liste || []).filter(function (d) { return d && d.id === id; })[0], im = imagesDe(x);
    if (!x || !im[k] || !document.body) return;
    fermerVisionneuse(true);
    visRetour = depuis || null;
    vis = marquer(document.createElement('div'));
    vis.className = 'sgn-vis';
    vis.setAttribute('role', 'dialog'); vis.setAttribute('aria-modal', 'true'); vis.setAttribute('aria-label', 'Capture en grand');
    function montrer(c) {
      vis.innerHTML = '<div class="sgn-vis-b">' + (im.avant && im.apres ? ['avant', 'apres'].map(function (z) {
        return '<button type="button" data-v="' + z + '" aria-pressed="' + (z === c) + '">' + (z === 'avant' ? 'Avant' : 'Après') + '</button>';
      }).join('') : '') + '<button type="button" class="sgn-vis-x" data-v="fermer">Fermer</button></div>'
        + '<div class="sgn-vis-i"><img src="' + h(im[c]) + '" alt="' + h(legende(x, c)) + '"></div><p class="sgn-vis-l">' + h(legende(x, c)) + '</p>';
    }
    montrer(k);
    // Une page dont la CSP refuse les images du relais (img-src) : relue par fetch (imageEnMemoire) ; refusée encore, on le dit,
    // avec un lien qui ouvre la capture dans un onglet.
    vis.addEventListener('error', function (e) {
      var i = e.target, z = i && i.tagName === 'IMG' && i.parentNode;
      if (!z || !i.getAttribute('src')) return;
      imageEnMemoire(i, function () {
        z.innerHTML = '<p class="sgn-vis-ko">Cette page bloque l’affichage de la capture. <a href="' + h(i.getAttribute('data-sgn-src') || i.getAttribute('src'))
          + '" target="_blank" rel="noopener noreferrer">Ouvrir la capture dans un nouvel onglet</a></p>';
      });
    }, true);
    vis.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-v]') : null, v = b ? b.getAttribute('data-v') : '';
      if (v === 'avant' || v === 'apres') { montrer(v); var nb = vis.querySelector('[data-v="' + v + '"]'); if (nb) nb.focus({ preventScroll: true }); return; }
      if (v === 'fermer' || e.target.tagName !== 'IMG') fermerVisionneuse();   // le fond sombre ferme aussi
    });
    document.body.appendChild(vis);
    try { vis.querySelector('.sgn-vis-x').focus({ preventScroll: true }); } catch (e) {}
  }
  function fermerVisionneuse(sansFocus) {
    if (!vis) return;
    vis.remove(); vis = null;
    var r = visRetour; visRetour = null;
    if (!sansFocus && r && r.isConnected) try { r.focus({ preventScroll: true }); } catch (e) {}
  }

  // Une carte : l'état, la date, le projet, l'abonnement ; le texte, le résumé de Claude ; les captures avant / après ; puis deux
  // rangées (3 boutons au plus chacune) : ce qu'on peut FAIRE (mettre en ligne, annuler, renvoyer), puis les liens.
  var estPr = function (l) { return /\/(pull|merge_requests)\/\d+/.test(l); };
  function carte(x) {
    var reglee = regleeIci(x), e = reglee ? 'reglee' : ETATS[x.etat] ? x.etat : 'inconnu', projet = projetDe(x), id = h(x.id);
    var p = nomProjetDe(x), q = quand(x.creeLeMs), ab = x.abonnement === '1' || x.abonnement === '2' ? 'via abonnement ' + x.abonnement : '';
    var texte = String(x.texte || '').trim();
    if (!texte) texte = Number(x.captures) > 0 ? '(capture seule, sans texte)' : x.audio ? '(note vocale seule)' : '(sans texte)';
    var acts = actionsDe(x), faire = [], liensH = [], notes = [];
    var liens = (Array.isArray(x.liens) ? x.liens : []).map(httpsSur).filter(Boolean), pr = liens.filter(estPr)[0] || '', lien = liens[0] || '';
    var session = httpsSur(x.sessionUrl), apercu = httpsSur(x.apercu);
    var a = function (href, t) { return '<a class="sgn-act" href="' + h(href) + '" target="_blank" rel="noopener noreferrer">' + t + '</a>'; };
    if (acts.indexOf('valider') >= 0) faire.push('<button type="button" class="sgn-act sgn-prim" data-a="valider" data-id="' + id + '">Mettre en ligne</button>');
    if (x.etat === 'a_valider' && pr) faire.push(a(pr, 'Voir la PR'));
    if (x.etat === 'a_valider' && projet === 'avinou') notes.push('Avinou Malkenou est mis en ligne par son propriétaire, depuis son Mac (son coffre) : rien à valider ici.');
    if (acts.indexOf('annuler') >= 0) faire.push('<button type="button" class="sgn-act sgn-tenir" data-a="annuler" data-tenir="" data-id="' + id
      + '" aria-label="Annuler la mise en ligne : garder appuyé une seconde" title="Garder appuyé une seconde pour annuler">Annuler</button>');
    if (acts.indexOf('renvoyer') >= 0) {
      faire.push('<button type="button" class="sgn-act" data-a="renvoyer" data-id="' + id + '">Renvoyer</button>');
      var autre = autreAbonnement(x);
      if (autre) faire.push('<button type="button" class="sgn-act" data-a="renvoyer" data-id="' + id + '" data-ab="' + autre + '" aria-label="Renvoyer sur l’abonnement ' + autre + '">Renvoyer sur l’autre abonnement</button>');
      if (EN_COURS[x.etat]) notes.push('Pas de nouvelle de Claude depuis plus de 15 minutes.');
    }
    if (session) liensH.push(a(session, 'Ouvrir dans Claude'));
    if (apercu) liensH.push(a(apercu, 'Voir l’aperçu'));
    if (lien && !(x.etat === 'a_valider' && lien === pr)) liensH.push(a(lien, estPr(lien) ? 'Voir la PR' : 'Voir le lien'));
    var im = imagesDe(x), vign = ['avant', 'apres'].filter(function (k) { return im[k]; }).map(function (k) {
      var t = k === 'avant' ? 'Avant' : 'Après';
      return '<button type="button" class="sgn-ap" data-a="agrandir" data-id="' + id + '" data-k="' + k + '" aria-label="' + h(legende(x, k)) + ' : voir en grand">'
        + '<img src="' + h(im[k]) + '" alt="" loading="lazy" decoding="async"><span aria-hidden="true">' + t + '</span></button>';
    });
    return '<li class="sgn-carte e-' + e + '" data-id="' + id + '">'
      + '<div class="sgn-carte-h"><span class="sgn-pil">' + h(reglee ? 'réglé' : ETATS[x.etat] || String(x.etat || 'état inconnu').slice(0, 20)) + '</span>'
      + '<span>' + h([q, p, ab].filter(Boolean).join(' · ')) + '</span></div>'
      + '<p class="sgn-carte-t">' + h(texte) + '</p>'
      + (x.resume ? '<p class="sgn-carte-r">' + h(String(x.resume).slice(0, 500)) + '</p>' : '')
      + (x.erreur ? '<p class="sgn-carte-r ko">' + h(String(x.erreur).slice(0, 600)) + '</p>' : '')
      + notes.map(function (n) { return '<p class="sgn-carte-r">' + h(n) + '</p>'; }).join('')
      + (vign.length ? '<div class="sgn-avap">' + vign.join('') + '</div>' : '')
      + (faire.length ? '<div class="sgn-actions">' + faire.slice(0, 3).join('') + '</div>' : '')
      + (liensH.length ? '<div class="sgn-actions">' + liensH.slice(0, 3).join('') + '</div>' : '')
      + '</li>';
  }
  function bas(actualiser) {
    return '<div class="sgn-bas">' + (actualiser ? '<button type="button" class="sgn-bouton" data-a="actualiser"' + (D.enCours ? ' disabled' : '') + '>Actualiser</button>' : '')
      + '<button type="button" class="sgn-bouton" data-a="revenir">Revenir</button></div>';
  }
  function htmlDemandes() {
    var t = '<div class="sgn-tete"><b id="sgn-titre">Mes demandes</b><button type="button" class="sgn-x" data-a="fermer" aria-label="Fermer">×</button></div>';
    if (!C.endpoint) return t + '<p class="sgn-erreur">Le bouton n’est pas relié (réglage « endpoint » manquant).</p>' + bas(false);
    if (!aAcces()) {
      return t + (D.erreur ? '<p class="sgn-erreur">' + h(D.erreur) + '</p>' : '') + '<div class="sgn-acces">' + htmlAcces('demandes') + '</div>'
        + '<div class="sgn-etat" role="status" aria-live="polite"></div>' + bas(false);
    }
    var l = D.liste, erreur = D.erreur ? '<p class="sgn-erreur">' + h(D.erreur) + '</p>' : '';
    if (erreur && l && D.luA) erreur += '<p class="sgn-aide">Dernière liste reçue à ' + heure(D.luA) + ' (peut-être plus à jour) :</p>';
    // Le filtre d'un projet : une puce sur sa propre ligne, au-dessus des trois filtres ; la toucher montre tous les projets.
    var nom = D.projet ? nomDuProjet(D.projet) : '';
    var puce = D.projet ? '<div class="sgn-projet"><button type="button" class="sgn-puce" data-a="sansprojet" aria-label="Projet : ' + h(nom)
      + '. Toucher pour voir tous les projets">Projet : ' + h(nom) + ' <span class="sgn-puce-x" aria-hidden="true">×</span></button></div>' : '';
    var etat = '<div class="sgn-etat sgn-etat-d" role="status" aria-live="polite"></div>' + htmlOffre();
    if (!l) return t + puce + (erreur || '<p class="sgn-vide">Chargement…</p>') + bas(!!erreur);
    if (!D.stockage) return t + erreur + '<p class="sgn-vide">Le relais n’a pas de stockage : il ne garde pas les demandes, cette liste reste donc vide. Elles partent quand même à Claude.</p>' + bas(true);
    l = listeVue();
    if (!l.length) return t + puce + erreur + etat + '<p class="sgn-vide">'
      + (D.projet ? 'Aucune demande pour ce projet.' : 'Aucune demande pour l’instant.') + '</p>' + bas(true);
    var f = FILTRES.filter(function (x) { return x.id === D.filtre; })[0] || FILTRES[0], visibles = l.filter(f.garde);
    return t + puce + '<div class="sgn-filtres" role="group" aria-label="Filtrer les demandes">' + FILTRES.map(function (x) {
      return '<button type="button" class="sgn-filtre" data-a="filtre" data-v="' + x.id + '" aria-pressed="' + (x.id === f.id) + '">' + x.lib + ' <b>' + l.filter(x.garde).length + '</b></button>';
    }).join('') + '</div>'
      + etat + erreur
      + (visibles.length ? '<ul class="sgn-liste">' + visibles.map(carte).join('') + '</ul>' : '<p class="sgn-vide">' + f.vide + '</p>')
      + bas(true);
  }

  // ── LA FENÊTRE ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  // o.garder : le brouillon reste tel quel (« + Un autre écran ») ; sinon, fenêtre quittée sans rien y mettre = rien à garder.
  function fermer(o) {
    o = o || {};
    arreterDictee(false);
    if (enregistreur) try { enregistreur.stop(); } catch (e) {}
    if (observateur) { observateur.disconnect(); observateur = null; }
    dessinAjuster = null;
    fermerVisionneuse(true);
    if (fond) { fond.remove(); fond = null; }
    vue = 'signaler'; vueRendue = ''; depuisSignaler = false;
    if (!o.garder && brouillonVide() && !B.attente) effacerBrouillon(); else sauverMaintenant();
    majPastille();
    if (fab && !o.sansFocus) try { fab.focus({ preventScroll: true }); } catch (e) { fab.focus(); }
  }
  // La capture en grand (celle qu'on regarde, où l'on dessine), puis les écrans du brouillon et « + Un autre écran ».
  function htmlCaptures() {
    if (!B.captures.length) return '';
    if (courante >= B.captures.length) courante = B.captures.length - 1;
    var c = B.captures[courante], plein = B.captures.length >= ECRANS_MAX;
    return '<div class="sgn-grand"><div class="sgn-toile"><img src="' + c.donnees + '" alt="Écran ' + (courante + 1) + ' du signalement"><canvas aria-hidden="true"></canvas></div></div>'
      + '<div class="sgn-dessin-b"><p class="sgn-aide">Entoure ou barre ce qui ne va pas, au doigt ou à la souris.</p>'
      + '<button type="button" class="sgn-lien" data-a="gomme"' + (c.traits.length ? '' : ' disabled') + '>Effacer le dessin</button></div>'
      + '<div class="sgn-vignettes" role="group" aria-label="Les écrans du signalement">' + B.captures.map(function (x, i) {
        return '<div class="sgn-v" data-i="' + i + '"><button type="button" class="sgn-v-voir" data-a="voir" data-i="' + i + '" aria-current="' + (i === courante) + '" aria-label="Voir l’écran ' + (i + 1) + '">'
          + '<img src="' + x.donnees + '" alt="écran ' + (i + 1) + '"><svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">' + traitsSvg(x) + '</svg>'
          + '<span class="sgn-v-n" aria-hidden="true">' + (i + 1) + '</span></button>'
          + '<button type="button" class="sgn-v-x" data-a="retirer" data-i="' + i + '" aria-label="Retirer l’écran ' + (i + 1) + '">×</button></div>';
      }).join('')
      + '<button type="button" class="sgn-ajout" data-a="autre"' + (plein ? ' disabled' : '') + '>' + (plein ? ECRANS_MAX + ' écrans au plus' : '+ Un autre écran') + '</button></div>';
  }
  function htmlSignaler() {
    var acces = aAcces(), n = acces ? compteATraiter() : 0;
    return '<div class="sgn-tete"><b id="sgn-titre">Signaler à Claude</b><span class="sgn-tete-d">'
      + '<button type="button" class="sgn-lien" data-a="demandes" aria-label="Mes demandes' + (n ? ', ' + n + ' à traiter' : '') + '">Mes demandes' + (n ? ' <span class="sgn-nb">' + n + '</span>' : '') + '</button></span>'
      + '<button type="button" class="sgn-x" data-a="fermer" aria-label="Fermer">×</button></div>'
      + '<div class="sgn-types" role="group" aria-label="Type">'
      + '<button type="button" class="sgn-type" data-a="type" data-v="bug" aria-pressed="' + (B.type === 'bug') + '">Un bug</button>'
      + '<button type="button" class="sgn-type" data-a="type" data-v="idee" aria-pressed="' + (B.type === 'idee') + '">Une idée</button></div>'
      + htmlCaptures()
      + '<div class="sgn-rang">'
      + '<button type="button" class="sgn-bouton" data-a="capturer"' + (B.captures.length >= ECRANS_MAX ? ' disabled' : '') + '>Capturer l’écran</button>'
      + '<label class="sgn-bouton">Importer<input type="file" accept="image/*" multiple hidden data-a="importer"></label>'
      + '<button type="button" class="sgn-bouton" data-a="micro" aria-pressed="false">' + (Reco ? 'Dicter' : 'Note vocale') + '</button></div>'
      + '<textarea class="sgn-texte" data-a="texte" placeholder="' + (B.type === 'idee' ? 'Ton idée, en quelques mots…' : 'Qu’est-ce qui ne va pas ? Qu’attendais-tu ?') + '">' + h(B.texte) + '</textarea>'
      + (B.audio ? '<p class="sgn-aide">Note vocale jointe (' + h(B.audio.duree) + ') · <a href="#" data-a="sansaudio">retirer</a></p>' : '')
      // Qui envoie : sans session ni clé, de quoi se connecter (l'empreinte, ou la clé d'équipe demandée une fois).
      + (acces ? '' : '<div class="sgn-acces">' + htmlAcces('signaler') + '</div>')
      + '<button type="button" class="sgn-envoyer" data-a="envoyer"' + (envoiEnCours || coupe ? ' disabled' : '') + '>Envoyer à Claude</button>'
      + '<div class="sgn-etat" role="status" aria-live="polite"></div>'
      + htmlOffre()
      + htmlPied();
  }
  // Le bas de la fenêtre : qui est connecté par l'empreinte (et « Se déconnecter »), les réglages du rond lui-même.
  function htmlPied() {
    var s = sessionGardee(), l = [];
    if (s) l.push('<span class="sgn-qui">Connexion par empreinte' + (s.qui ? ' (' + h(s.qui) + ')' : '') + '</span>'
      + '<button type="button" class="sgn-lien" data-a="deconnecter">Se déconnecter</button>');
    if (positionDeLaPage()) l.push('<button type="button" class="sgn-lien" data-a="remettre">Remettre le bouton à sa place</button>');
    return l.length ? '<div class="sgn-pied">' + l.join('') + '</div>' : '';
  }
  function creerFond() {
    fond = marquer(document.createElement('div')); fond.className = 'sgn-fond'; vueRendue = '';
    fond.addEventListener('click', clic);
    // Vignette avant / après que la page refuse (CSP img-src sans le relais) : relue par fetch (imageEnMemoire) ; refusée encore,
    // le cadre le dit, et le toucher ouvre un onglet.
    fond.addEventListener('error', function (e) {
      var i = e.target, b = i && i.tagName === 'IMG' && i.closest ? i.closest('.sgn-ap') : null;
      if (!b || b.classList.contains('sgn-ap-ko')) return;
      imageEnMemoire(i, function () {
        b.classList.add('sgn-ap-ko');
        b.setAttribute('aria-label', (b.getAttribute('aria-label') || '').replace(/ : voir en grand$/, '') + ' : bloquée par cette page, ouvrir dans un nouvel onglet');
      });
    }, true);
    fond.addEventListener('input', function (e) { if (e.target.classList.contains('sgn-texte')) { B.texte = e.target.value; sauver(); } });
    fond.addEventListener('change', function (e) { if (e.target.getAttribute('data-a') === 'importer') importer(e.target.files).then(function () { rendre(); }); });
    fond.addEventListener('keydown', function (e) { if (e.key === 'Enter' && vue === 'demandes' && e.target.classList.contains('sgn-cle')) { e.preventDefault(); validerCle(); } });
    document.addEventListener('keydown', function esc(e) {
      if (!fond) { document.removeEventListener('keydown', esc); return; }
      if (e.key !== 'Escape') return;
      if (vis) fermerVisionneuse(); else if (!envoiEnCours) fermer();   // la capture en plein écran se ferme d'abord
    });
    document.body.appendChild(fond);
    majPastille();
    cacherBulle();
  }
  // lien : ajoute « Voir mes demandes » après le message.
  function rendre(message, ton, lien) {
    if (!document.body) return;
    if (!fond) creerFond();
    rendus++;
    var avant = document.activeElement && fond.contains(document.activeElement) ? document.activeElement : null;
    var cleFocus = avant ? [avant.getAttribute('data-a'), avant.getAttribute('data-v'), avant.getAttribute('data-id')] : null;
    // Dans le signalement, la fenêtre redessinée reste où elle était (dessin, vignette touchée…).
    var boite = fond.querySelector('.sgn-boite'), haut = boite && vue === 'signaler' && vueRendue === 'signaler' ? boite.scrollTop : 0;
    if (vue === 'signaler' && !message && (coupe || origineRefusee)) { message = coupe ? COUPE_MSG : MSG.origineEnvoi; ton = 'ko'; }
    fond.innerHTML = '<div class="sgn-boite" role="dialog" aria-modal="true" aria-labelledby="sgn-titre">' + (vue === 'demandes' ? htmlDemandes() : htmlSignaler()) + '</div>';
    vueRendue = vue;
    if (haut) fond.querySelector('.sgn-boite').scrollTop = haut;
    var etat = fond.querySelector('.sgn-etat');
    if (message) dire(etat, message, ton);
    if (lien && etat) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'sgn-lien'; b.setAttribute('data-a', 'demandes'); b.textContent = 'Voir mes demandes';
      etat.appendChild(document.createTextNode(' ')); etat.appendChild(b);
    }
    [].forEach.call(fond.querySelectorAll('[data-tenir]'), brancherTenir);
    // Le défi de l’empreinte demandé d’avance : pour « Se connecter avec l’empreinte », ou « Mettre en ligne » sans être connecté.
    if (fond.querySelector('.sgn-acces [data-a="empreinte"]') || (fond.querySelector('[data-a="valider"]') && !sessionGardee())) prechargerDefi();
    if (fond.querySelector('.sgn-offre')) prechargerInscription();
    if (vue === 'signaler') {
      brancherDessin();
      var premier = (!aAcces() && B.texte && fond.querySelector('.sgn-acces .sgn-cle, .sgn-acces [data-a="empreinte"]')) || fond.querySelector('.sgn-texte');
      if (premier) try { premier.focus({ preventScroll: true }); } catch (e) { premier.focus(); }
      return;
    }
    // Dans la liste, le focus reste sur le bouton touché (filtre, Actualiser…), sinon sur la clé à taper ou le filtre choisi.
    var cible = null;
    if (cleFocus && cleFocus[0]) cible = [].filter.call(fond.querySelectorAll('[data-a="' + cleFocus[0] + '"]'), function (el) { return el.getAttribute('data-v') === cleFocus[1] && el.getAttribute('data-id') === cleFocus[2]; })[0];
    if (!cible) cible = fond.querySelector('.sgn-cle') || fond.querySelector('.sgn-acces [data-a="empreinte"]') || fond.querySelector('.sgn-filtre[aria-pressed="true"]') || fond.querySelector('[data-a="revenir"]');
    if (cible) try { cible.focus({ preventScroll: true }); } catch (e) { cible.focus(); }
  }
  function clic(e) {
    // Un trait qui finit hors de la capture ne ferme pas la fenêtre.
    if (e.target === fond) { if (!envoiEnCours && Date.now() - finDessin > 400) fermer(); return; }
    var el = e.target.closest ? e.target.closest('[data-a]') : null;
    if (!el || !fond || !fond.contains(el) || el.disabled || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return;
    var a = el.getAttribute('data-a');
    if (a === 'fermer') fermer();
    else if (a === 'type') { B.type = el.getAttribute('data-v'); sauver(); rendre(); }
    else if (a === 'voir') { var i = Number(el.getAttribute('data-i')); if (B.captures[i]) { courante = i; sauver(); rendre(); } }
    else if (a === 'retirer') { B.captures.splice(Number(el.getAttribute('data-i')), 1); courante = Math.min(courante, Math.max(0, B.captures.length - 1)); sauver(); rendre(); }
    else if (a === 'gomme') effacerDessin();
    else if (a === 'autre') autreEcran();
    else if (a === 'remettre') remettreBouton();
    else if (a === 'sansaudio') { e.preventDefault(); B.audio = null; sauver(); rendre(); }
    else if (a === 'capturer') {
      if (B.captures.length >= ECRANS_MAX) { rendre(MAX_MSG, 'ko'); return; }
      el.disabled = true; dire(fond.querySelector('.sgn-etat'), 'Capture…');
      photographier().then(function (d) { ajouterCapture(d); rendre('Capture ajoutée.', 'ok'); }, function () { rendre('La capture a échoué : importe une image à la place.', 'ko'); });
    }
    else if (a === 'micro') basculerMicro(el, fond.querySelector('.sgn-texte'), fond.querySelector('.sgn-etat'));
    else if (a === 'envoyer') envoyer(fond.querySelector('.sgn-etat'));
    else if (a === 'demandes') ouvrirDemandes(null);
    else if (a === 'filtre') { D.filtre = el.getAttribute('data-v'); D.auto = false; rendre(); }
    else if (a === 'sansprojet') { D.projet = null; if (D.auto) D.filtre = filtreAuto(); rendre(); }
    else if (a === 'actualiser') { rendre('Actualisation…'); chargerDemandes().then(function () { if (fond && vue === 'demandes') rendre(D.erreur ? '' : 'Liste à jour (' + heure() + ').', 'ok'); }); }
    else if (a === 'renvoyer') renvoyer(el.getAttribute('data-id'), el, el.getAttribute('data-ab'));
    else if (a === 'valider') mettreEnLigne(el.getAttribute('data-id'), el);
    else if (a === 'annuler') { /* rien au simple toucher : brancherTenir (garder appuyé 1,2 s) */ }
    else if (a === 'agrandir') {
      if (!el.classList.contains('sgn-ap-ko')) ouvrirVisionneuse(el.getAttribute('data-id'), el.getAttribute('data-k'), el);
      else {
        var xi = (D.liste || []).filter(function (d) { return d && d.id === el.getAttribute('data-id'); })[0], ui = imagesDe(xi)[el.getAttribute('data-k')];
        if (ui) window.open(ui, '_blank', 'noopener,noreferrer');
      }
    }
    else if (a === 'empreinte') seConnecter(el);
    else if (a === 'jaicle' || a === 'sanscle') {
      montrerCle = a === 'jaicle'; majAcces();
      var z = fond.querySelector(montrerCle ? '.sgn-acces .sgn-cle' : '.sgn-acces [data-a="empreinte"]'); if (z) try { z.focus({ preventScroll: true }); } catch (er) {}
      if (!montrerCle) prechargerDefi();
    }
    else if (a === 'activer') activer(el);
    else if (a === 'plustard') {
      EMP.offre = false;
      var of = fond.querySelector('.sgn-offre'); if (of) of.remove();
      dire(fond.querySelector('.sgn-etat'), 'D’accord : ta clé d’équipe reste gardée dans ce navigateur.', 'ok');
    }
    else if (a === 'deconnecter') {
      oublierSession(); EMP.offre = false;
      if (!lire(CLE_STOCKAGE)) D.liste = null;
      majCompteur();
      rendre('Déconnecté sur cet appareil' + (lire(CLE_STOCKAGE) ? ' (ta clé d’équipe reste gardée)' : '') + '.', 'ok');
      if (lire(CLE_STOCKAGE)) chargerDemandes();
    }
    else if (a === 'voircle') validerCle();
    else if (a === 'revenir') { if (depuisSignaler) { vue = 'signaler'; depuisSignaler = false; rendre(); } else fermer(); }
  }
  // « + Un autre écran » : la fenêtre se ferme, le brouillon attend ; le prochain toucher du rond photographie l'écran suivant.
  function autreEcran() {
    if (B.captures.length >= ECRANS_MAX) return;
    if (fond) { var t = fond.querySelector('.sgn-texte'); if (t) B.texte = t.value; }
    B.attente = true;
    fermer({ garder: true, sansFocus: true });
    var n = B.captures.length;
    montrerBulle('info', 'Brouillon gardé (' + n + (n > 1 ? ' écrans' : ' écran') + '). Va sur l’autre écran, puis touche le rond.');
  }

  function contexte(envoiA) {
    var u = ''; try { u = typeof C.utilisateur === 'function' ? String(C.utilisateur() || '') : String(C.utilisateur || ''); } catch (e) {}
    joindreBoite();
    return { url: location.href, titre: document.title, version: C.version || '', utilisateur: u, langue: navigator.language || '',
      appareil: navigator.userAgent, taille: window.innerWidth + '×' + window.innerHeight, erreurs: ERREURS.slice(),
      elements: elementsDuBrouillon(),
      // t = combien de millisecondes AVANT l'envoi.
      journal: B.journal.slice(-BOITE_MAX).map(function (x) { return { t: Math.max(0, envoiA - x.at), type: x.type, cible: x.cible, detail: x.detail }; }) };
  }
  function envoyer(etat) {
    if (envoiEnCours) return;
    if (!C.endpoint) { dire(etat, 'Le bouton n’est pas relié (réglage « endpoint » manquant).', 'ko'); return; }
    var champCle = fond.querySelector('.sgn-cle');
    if (champCle) { var k = champCle.value.trim(); if (k.length < 16) { dire(etat, 'Tape ta clé d’équipe (16 caractères au moins).', 'ko'); champCle.focus(); return; } ecrire(CLE_STOCKAGE, k); D.liste = null; D.erreur = ''; }
    if (!B.texte.trim() && !B.captures.length && !B.audio) { dire(etat, 'Écris, dicte ou capture quelque chose d’abord.', 'ko'); return; }
    // Ni session ni clé (« Se connecter avec l’empreinte » à l'écran) : « Envoyer » demande l'empreinte, puis envoie.
    if (!aAcces()) {
      if (!empreintePossible() || EMP.reglee === false) { montrerCle = true; majAcces(); dire(etat, 'Tape ta clé d’équipe (16 caractères au moins).', 'ko'); return; }
      envoiEnCours = true;
      var b0 = fond.querySelector('.sgn-envoyer'); if (b0) b0.disabled = true;
      dire(etat, 'Pose ton empreinte…');
      connexionEmpreinte().then(function (r) {
        envoiEnCours = false;
        if (!fond) return;
        if (!r.ok) { if (r.cle) montrerCle = true; rendre(r.msg + ' Ton message est gardé.', 'ko'); return; }
        D.liste = null; D.erreur = '';
        rendre();
        envoyer(fond.querySelector('.sgn-etat'));
      });
      return;
    }
    arreterDictee(false);
    envoiEnCours = true;
    var bouton = fond.querySelector('.sgn-envoyer'); bouton.disabled = true; dire(etat, 'Envoi…');
    var a = Date.now();
    Promise.all(B.captures.map(composer)).then(function (images) {
      var corps = { type: B.type, texte: B.texte.trim(), captures: B.captures.map(function (c, i) { return { donnees: images[i], ou: c.ou }; }), audio: B.audio, contexte: contexte(a) };
      return poster(JSON.stringify(corps), false);
    })
      .then(function (j) {
        envoiEnCours = false; vue = 'signaler';
        if (j && j.ok) {
          effacerBrouillon();
          rendre('Transmis à Claude (réf. ' + (j.ref || '?') + ').', 'ok', true);
          var b2 = fond && fond.querySelector('.sgn-envoyer'); if (b2) b2.disabled = true;
          // Fermeture d'elle-même, sauf si la personne a touché quelque chose entre-temps (« Voir mes demandes »…), ou si
          // « Activer l’empreinte » est proposé (rendus change).
          var r = rendus; setTimeout(function () { if (fond && !envoiEnCours && rendus === r) fermer(); }, 8000);
          chargerDemandes();
          if (j.parCle) proposerEmpreinte();
          // La page qui porte le bouton peut suivre l'envoi (l'Atelier 770LAB ouvre aussitôt la demande, comme celui de gestion).
          try { window.dispatchEvent(new CustomEvent('signaler:envoye', { detail: { ref: String(j.ref || '') } })); } catch (e) {}
          return;
        }
        if (j && j.coupe) { couper(); rendre(COUPE_MSG, 'ko'); return; }
        if (j && j.sessionPerdue) { D.liste = null; majCompteur(); rendre(MSG.sessionPerdue + ' Ton message est gardé.', 'ko'); return; }
        if (j && j.cle) { ecrire(CLE_STOCKAGE, ''); D.liste = null; montrerCle = true; majCompteur(); }
        var garde = !(j && j.cle) && aAcces();
        rendre('Pas envoyé : ' + ((j && j.erreur) || 'erreur') + '. Ton message est gardé : réessaie.', 'ko', garde && j.statut === 502);
        if (garde) chargerDemandes();   // une demande « pas partie » est peut-être gardée par le relais
      }, function () {
        // Sans réponse lisible : réseau coupé, ou page refusée par le relais (une réponse sans CORS) ; « Envoi… » le temps de savoir.
        diagnostiquer().then(function (cause) {
          envoiEnCours = false;
          rendre(cause === 'origine' ? 'Pas envoyé : page non autorisée (ce site n’est pas dans la liste du relais, ORIGINES). Ton message est gardé.'
            : cause === 'refus' ? 'Pas envoyé : le relais refuse cette page (son adresse n’est sans doute pas dans sa liste, ORIGINES). Ton message est gardé.'
            : 'Pas envoyé : le relais ne répond pas. Ton message est gardé : réessaie.', 'ko');
        });
      });
  }
  // POST /signaler avec la session (Authorization: Bearer) ou la clé d'équipe. Session refusée (401) : oubliée, et la clé prend le
  // relais s'il y en a une (le même envoi, une fois) ; sans clé, la réponse est marquée sessionPerdue. parCle : envoyé avec la clé.
  function poster(texte, sansSession) {
    var s = sansSession ? null : sessionGardee(), k = lire(CLE_STOCKAGE), hd = { 'Content-Type': 'application/json' };
    if (s) hd.Authorization = 'Bearer ' + s.session; else hd['X-Signaler-Cle'] = k;
    return chercher(base() + '/signaler', { method: 'POST', credentials: 'omit', headers: hd, body: texte })
      .then(function (r) {
        return r.json().catch(function () { return { ok: false, erreur: 'réponse illisible (' + r.status + ')' }; })
          .then(function (j) { j = j && typeof j === 'object' && !Array.isArray(j) ? j : {}; j.statut = r.status; return j; });
      })
      .then(function (j) {
        if (j.statut === 401 && s) { oublierSession(); if (k) return poster(texte, true); j.sessionPerdue = true; }
        j.parCle = !s && !!k;
        return j;
      });
  }

  // Toucher du rond. Brouillon en attente (« + Un autre écran ») ou rien encore : on photographie AVANT d'ouvrir, l'écran tel
  // que la personne le voyait ; fenêtre simplement refermée : elle se rouvre telle quelle.
  // o.nouvelEcran : photographier quand même (la bulle d'erreur) · o.ligne : une ligne pour la personne (l'erreur vue).
  function ouvrir(o) {
    o = o || {};
    if (fond) { if (vue !== 'signaler' && !envoiEnCours) { vue = 'signaler'; depuisSignaler = false; rendre(); } return; }
    if (occupe) return;
    vue = 'signaler'; depuisSignaler = false;
    cacherBulle();
    if (o.ligne) {
      if (!B.captures.length && !B.texte.trim()) B.type = 'bug';
      if (B.texte.indexOf(o.ligne) < 0) B.texte = B.texte.trim() ? B.texte.replace(/\s*$/, '\n') + o.ligne : o.ligne;
    }
    var photo = o.nouvelEcran || B.attente || !B.captures.length;
    B.attente = false;
    if (!photo) { rendre(); return; }
    if (B.captures.length >= ECRANS_MAX) { rendre(MAX_MSG, 'ko'); return; }
    photographier().then(function (c) { ajouterCapture(c); return ''; }, function () { return 'La capture automatique a échoué : importe une image si besoin.'; })
      .then(function (m) { if (!fond) rendre(m, m ? 'ko' : ''); });
  }

  var ETOILE = (function () {
    var L = [11, 8.5, 10, 7.5, 11.5, 9, 10, 8, 11, 8.5, 10.5, 9], t = '';
    for (var k = 0; k < 12; k++) t += '<span class="sgn-r" style="transform:rotate(' + (k * 30 + 8) + 'deg)"><span style="height:' + L[k] + 'px;animation-delay:-' + (k * 0.217).toFixed(2) + 's"></span></span>';
    return '<span class="sgn-etoile" aria-hidden="true">' + t + '</span>';
  })();
  function monter() {
    if (fab || !document.body || !pret || coupe) return;
    try { if (typeof C.visible === 'function' && !C.visible()) return; } catch (e) {}
    fab = marquer(document.createElement('button')); fab.type = 'button'; fab.className = 'sgn-fab';
    fab.innerHTML = '<span class="sgn-onde" aria-hidden="true"></span><span class="sgn-anneau" aria-hidden="true"></span>' + ETOILE
      + '<span class="sgn-point" aria-hidden="true"></span><span class="sgn-pastille" aria-hidden="true"></span>';
    fab.title = 'Signaler un bug ou une idée à Claude (appui long pour le déplacer)';
    gestes(fab);
    badge = marquer(document.createElement('button')); badge.type = 'button'; badge.className = 'sgn-badge'; badge.style.display = 'none';
    badge.addEventListener('click', function (e) { e.stopPropagation(); ouvrirDemandes('traiter'); });
    if (cacheParPage) fab.style.display = 'none';
    document.body.appendChild(fab); document.body.appendChild(badge);
    placer();
    majPastille();
    majCompteur();
    chargerDemandes();
  }
  // Montré de nouveau (montrer()) : le rond existe peut-être déjà ; une liste oubliée entre-temps (oublier(), au verrouillage
  // d'Avinou Malkenou) est relue, sinon le nombre des demandes à traiter ne reviendrait qu'à l'ouverture de la feuille.
  function afficher() {
    monter(); if (fab) fab.style.display = ''; placer(); majCompteur();
    if (fab && !D.liste && !D.enCours) chargerDemandes();
  }
  // Page qui cache le bouton au démarrage (écran verrouillé, visiteur…) : rien n'est demandé au relais avant montrer().
  function demarrer() {
    var visible = true;
    try { if (typeof C.visible === 'function') visible = !!C.visible(); } catch (e) { visible = false; }
    if (!visible) { pret = true; aVerifier = true; return; }
    lireEtat().then(function (actif) { pret = true; if (!actif) { coupe = true; return; } monter(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', demarrer); else demarrer();

  window.Signaler = {
    ouvrir: function () { monter(); ouvrir(); },
    cacher: function () { cacheParPage = true; if (fab) fab.style.display = 'none'; cacherBulle(); majCompteur(); },
    montrer: function () {
      cacheParPage = false;
      if ((coupe || aVerifier) && pret) {
        // Coupé (au chargement ou par une réponse « coupé »), ou relais pas encore interrogé : on lui demande avant de montrer.
        if (!reverification) reverification = lireEtat().then(function (actif) {
          reverification = null; aVerifier = false;
          if (!actif) { coupe = true; return; }
          coupe = false;
          if (cacheParPage) return;
          afficher();
        });
        return;
      }
      afficher();
    },
    // filtre : 'toutes' | 'traiter' | 'cours', ou { projet: '<id>', etat: 'traiter' } (etat facultatif) pour un seul projet.
    demandes: function (filtre) {
      var o = filtre && typeof filtre === 'object' ? filtre : { etat: filtre };
      ouvrirDemandes(NOMS_FILTRE[String(o.etat || o.filtre || '').toLowerCase()] || null, idProjet(o.projet) || null);
    },
    // L'écran se verrouille (Avinou Malkenou) : plus rien de ce que la personne a fait ou vu ne reste dans la page.
    // La clé d'équipe et la connexion restent (la page les efface elle-même si elle le veut).
    oublier: function () {
      numeroLecture++;   // une lecture en route ne remplira pas la liste oubliée
      D.liste = null; D.erreur = ''; D.luA = 0; D.enCours = false; D.projet = null;
      BOITE.length = 0; ERREURS.length = 0;
      R.abonnements = null; R.luA = 0; EMP.offre = false;
      fermerVisionneuse(true); oublierImages();
      if (fond) fermer({ garder: true, sansFocus: true });
      effacerBrouillon();
      eteindreAlerte(); cacherBulle();
      majCompteur();
    },
    projetDeLaPage: projetDeLaPage,
    projets: PROJETS.map(function (p) { return { id: p.id, nom: p.nom }; }),
    _etat: function () { return B; },
    _journal: function () { return extraitBoite(); },
  };
})();
