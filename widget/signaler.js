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
 *    projet         le projet de la page ('home', 'pupitre', 'havroutia', 'avinou', 'koulam') ; sans réglage, d'après son adresse
 *                   (Signaler.projetDeLaPage) : 770lab.com/home/robots… → pupitre, 770lab.com/home… → home,
 *                   770lab.com/havroutia… → havroutia, avinou-malkenou.web.app → avinou, koulam.app → koulam, sinon aucun
 *
 *  Les interrupteurs du pupitre : un GÉNÉRAL et un PAR PROJET. Avant de montrer le rond, le bouton demande au relais s'il est
 *  coupé (GET /etat?projet=<id>, ou GET /etat pour une page d'aucun projet ; 4 s au plus) : « effectif: false » (le général ou
 *  celui de ce projet coupé) le cache ; un relais d'avant les projets ne dit pas « effectif », son « actif: false » le cache.
 *  Coupé : le rond n'apparaît pas. Relais muet, en erreur ou lent : le rond apparaît quand même (on ne bloque pas sur une panne).
 *  Signaler.montrer() sur un bouton coupé redemande au relais : rallumé depuis le pupitre, il revient sans recharger la page ;
 *  toujours coupé, il reste caché (une page qui appelle montrer() après une connexion ne passe pas outre l'interrupteur).
 *  « Mes demandes » : avec la clé d'équipe gardée, un petit nombre sur le rond compte les demandes « à traiter » (une question
 *  de Claude, une PR à relire, une demande pas partie) ; le toucher ouvre la liste (GET /demandes), le reste du rond photographie.
 *  Une lecture sans réponse lisible est expliquée : réseau coupé, ou relais qui refuse CETTE page (adresse absente de ses ORIGINES,
 *  ou relais pas encore à jour) ; GET /etat, public, peut le dire lui-même (« origine: false »).
 *
 *  LE ROND. Un toucher le fait s'enfoncer, puis pendant la photo un anneau tourne autour, une onde s'en échappe et l'étoile tourne
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
 *        oublier() : efface le brouillon, la liste gardée et la boîte noire (pour l'écran verrouillé d'Avinou Malkenou) ; la clé et
 *        la connexion restent.
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
  var COUPE_MSG = 'Le bouton est coupé depuis le pupitre.';
  var MAX_MSG = ECRANS_MAX + ' écrans au plus : retire-en un pour en ajouter un autre.';
  // Pourquoi le relais ne répond pas : le navigateur ne lit pas une réponse sans CORS, il faut le dire en clair à la personne.
  var MSG = {
    origine: 'Page non autorisée : ce site n’est pas dans la liste du relais (ORIGINES).',
    refus: 'Le relais répond, mais pas à cette page : il n’est sans doute pas encore à jour pour « Mes demandes » (à redéployer), ou l’adresse de cette page n’est pas dans sa liste (ORIGINES).',
    ancien: 'Le relais n’est pas encore à jour : il ne connaît pas « Mes demandes ». Il doit être redéployé.',
    injoignable: 'Le relais est injoignable : vérifie la connexion, puis touche « Actualiser ».',
    origineEnvoi: 'Cette page n’est pas autorisée par le relais (son adresse n’est pas dans sa liste, ORIGINES) : l’envoi sera refusé.',
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
      if (!statut || statut >= 500) alerter('requete:' + cible + ':' + statut, 'Une requête a échoué : ' + cible + (statut ? ' (erreur ' + statut + ')' : ' (pas de réponse du réseau)'));
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
    { id: 'avinou', nom: 'Avinou Malkenou' }, { id: 'koulam', nom: 'KOULAM' }];
  // Le projet d'une page d'après son adresse, la même règle que le relais (projetDeLaPage de relay/coeur.mjs) ; null : aucun.
  function projetDeLaPage(url) {
    var u; try { u = new URL(String(url || '')); } catch (e) { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    var hote = u.hostname.toLowerCase().replace(/^www\./, ''), chemin = (u.pathname || '/').toLowerCase();
    if (hote === '770lab.com') {
      if (chemin.indexOf('/home/robots') === 0) return 'pupitre';
      if (chemin.indexOf('/home') === 0) return 'home';
      if (chemin.indexOf('/havroutia') === 0) return 'havroutia';
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
    + '.sgn-fab,.sgn-fab *,.sgn-badge,.sgn-fond,.sgn-fond *,.sgn-bulle,.sgn-bulle *{font-style:normal}'
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
    + '.e-envoyee{--e:#2563eb}.e-pas_partie{--e:#dc2626}.e-a_relire{--e:#b45309}.e-question{--e:#7c3aed}.e-rien{--e:#64748b}.e-echec{--e:#991b1b}.e-en_ligne{--e:#15803d}';
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
    if (o.cle) init.headers['X-Signaler-Cle'] = o.cle;
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
        try { if (navigator.vibrate) navigator.vibrate(15); } catch (er) {}
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
  var Reco = window.SpeechRecognition || window.webkitSpeechRecognition;
  function basculerMicro(bouton, zone, etat) {
    if (Reco) {
      if (dictee) { dictee.stop(); return; }
      var r = new Reco(), avant = zone.value ? zone.value.replace(/\s*$/, ' ') : '';
      r.lang = document.documentElement.lang || 'fr-FR'; r.continuous = true; r.interimResults = true;
      r.onresult = function (ev) { var t = ''; for (var i = 0; i < ev.results.length; i++) t += ev.results[i][0].transcript; zone.value = avant + t; B.texte = zone.value; sauver(); };
      r.onerror = function (ev) { dire(etat, ev && ev.error === 'not-allowed' ? 'Micro refusé : autorise-le dans le navigateur.' : 'La dictée s’est arrêtée.', 'ko'); };
      r.onend = function () { dictee = null; bouton.setAttribute('aria-pressed', 'false'); bouton.textContent = 'Dicter'; };
      try { r.start(); dictee = r; bouton.setAttribute('aria-pressed', 'true'); bouton.textContent = '■ Arrêter la dictée'; dire(etat, 'À l’écoute… parle normalement.'); }
      catch (e) { dire(etat, 'Dictée impossible sur ce navigateur.', 'ko'); }
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
  var ETATS = { envoyee: 'en cours', pas_partie: 'pas partie', a_relire: 'à relire', question: 'question', rien: 'rien à faire', echec: 'échec', en_ligne: 'en ligne' };
  var A_TRAITER = { question: 1, a_relire: 1, pas_partie: 1 };   // ce qui attend le propriétaire
  var FILTRES = [
    { id: 'toutes', lib: 'Toutes', garde: function () { return true; }, vide: 'Aucune demande pour l’instant.' },
    { id: 'traiter', lib: 'À traiter', garde: function (x) { return !!A_TRAITER[x.etat]; }, vide: 'Rien à traiter pour l’instant.' },
    { id: 'cours', lib: 'En cours', garde: function (x) { return x.etat === 'envoyee'; }, vide: 'Rien en cours pour l’instant.' },
  ];
  var NOMS_FILTRE = { toutes: 'toutes', tout: 'toutes', traiter: 'traiter', a_traiter: 'traiter', 'à traiter': 'traiter', cours: 'cours', en_cours: 'cours', 'en cours': 'cours' };
  // liste : null tant que rien n'est lu · auto : le filtre suit le nombre à traiter (ouvert par l'API sans filtre)
  // projet : la liste ne montre que ce projet (Signaler.demandes({ projet })), null : tous
  var D = { liste: null, stockage: true, erreur: '', enCours: false, filtre: 'toutes', auto: false, luA: 0, projet: null };
  var vue = 'signaler', vueRendue = '', depuisSignaler = false, rendus = 0, numeroLecture = 0;

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
  function chargerDemandes() {
    var cle = lire(CLE_STOCKAGE);
    if (!C.endpoint || !cle) return Promise.resolve();
    var n = ++numeroLecture;
    D.enCours = true;
    return appel('/demandes', { cle: cle, delai: 15000 }).then(function (j) {
      if (n !== numeroLecture) return;
      if (j.ok) {
        D.liste = (Array.isArray(j.demandes) ? j.demandes : []).filter(function (x) { return x && typeof x === 'object'; })
          .sort(function (a, b) { return (Number(b.creeLeMs) || 0) - (Number(a.creeLeMs) || 0); });
        D.stockage = j.stockage !== false; D.erreur = ''; D.luA = Date.now();
        try { window.dispatchEvent(new CustomEvent('signaler:demandes', { detail: { aTraiter: compteATraiter(), total: D.liste.length, projets: comptesParProjet() } })); } catch (e) {}
      } else if (j.statut === 401 || j.cle) {
        ecrire(CLE_STOCKAGE, ''); D.liste = null;
        D.erreur = 'Clé refusée : le relais ne la connaît pas. Tape à nouveau ta clé d’équipe.';
      } else if (j.statut === 403) D.erreur = MSG.origine;
      else if (j.statut === 503 || j.stockage === false) { D.liste = []; D.stockage = false; D.erreur = ''; }
      else if (j.statut === 404) D.erreur = MSG.ancien;
      else D.erreur = 'Le relais a répondu une erreur (' + (j.erreur ? j.erreur + ', ' : '') + 'statut ' + j.statut + ').';
    }, function () {
      return diagnostiquer().then(function (cause) { if (n === numeroLecture) D.erreur = MSG[cause] || MSG.injoignable; });
    }).then(function () { if (n === numeroLecture) { D.enCours = false; majCompteur(); } });
  }
  // Le nombre sur le rond et dans l'en-tête de la fenêtre.
  function majCompteur() {
    var n = lire(CLE_STOCKAGE) ? compteATraiter() : 0;
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
    if (lire(CLE_STOCKAGE)) D.erreur = '';   // une vieille erreur ne s'affiche pas pendant la nouvelle lecture
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
  function renvoyer(id, el) {
    var cle = lire(CLE_STOCKAGE);
    if (!cle || !id) return;
    el.disabled = true; el.textContent = 'Envoi…';
    appel('/demandes/' + encodeURIComponent(id) + '/renvoyer', { methode: 'POST', cle: cle, delai: 30000 }).then(function (j) {
      if (j.ok && j.demande && typeof j.demande === 'object') {
        var d = j.demande;
        if (D.liste) D.liste = D.liste.map(function (x) { return x.id === d.id ? d : x; });
        return d.etat === 'pas_partie' ? ['Toujours pas partie' + (d.erreur ? ' : ' + d.erreur : '') + '.', 'ko'] : ['Renvoyée à Claude.', 'ok'];
      }
      if (j.coupe) { couper(); return [COUPE_MSG, 'ko']; }
      if (j.statut === 401 || j.cle) return ['', ''];   // la lecture qui suit le dira et redemandera la clé
      if (j.statut === 409) return ['Cette demande n’est plus « pas partie » : rien à renvoyer.', 'ko'];
      if (j.statut === 404) return ['Demande introuvable : elle a peut-être été effacée.', 'ko'];
      return ['Pas renvoyée : ' + (j.erreur || 'erreur ' + j.statut) + '.', 'ko'];
    }, function () {
      return diagnostiquer().then(function (cause) { return ['Pas renvoyée : ' + (cause === 'reseau' ? 'le relais est injoignable.' : (MSG[cause] || '').replace(/^./, function (c) { return c.toLowerCase(); })), 'ko']; });
    }).then(function (m) {
      return chargerDemandes().then(function () { if (fond && vue === 'demandes') rendre(m[0], m[1]); });
    });
  }

  function carte(x) {
    var e = ETATS[x.etat] ? x.etat : 'inconnu';
    var p = nomProjetDe(x), q = quand(x.creeLeMs);
    var texte = String(x.texte || '').trim();
    if (!texte) texte = Number(x.captures) > 0 ? '(capture seule, sans texte)' : x.audio ? '(note vocale seule)' : '(sans texte)';
    var acts = [], session = httpsSur(x.sessionUrl);
    var lien = (Array.isArray(x.liens) ? x.liens : []).map(httpsSur).filter(Boolean)[0];
    if (session) acts.push('<a class="sgn-act" href="' + h(session) + '" target="_blank" rel="noopener noreferrer">Ouvrir dans Claude</a>');
    if (lien) acts.push('<a class="sgn-act" href="' + h(lien) + '" target="_blank" rel="noopener noreferrer">' + (/\/(pull|merge_requests)\/\d+/.test(lien) ? 'Voir la PR' : 'Voir le lien') + '</a>');
    if (x.etat === 'pas_partie') acts.push('<button type="button" class="sgn-act" data-a="renvoyer" data-id="' + h(x.id) + '">Renvoyer</button>');
    return '<li class="sgn-carte e-' + e + '" data-id="' + h(x.id) + '">'
      + '<div class="sgn-carte-h"><span class="sgn-pil">' + h(ETATS[x.etat] || String(x.etat || 'état inconnu').slice(0, 20)) + '</span>'
      + '<span>' + h([q, p].filter(Boolean).join(' · ')) + '</span></div>'
      + '<p class="sgn-carte-t">' + h(texte) + '</p>'
      + (x.resume ? '<p class="sgn-carte-r">' + h(String(x.resume).slice(0, 500)) + '</p>' : '')
      + (x.etat === 'pas_partie' && x.erreur ? '<p class="sgn-carte-r ko">' + h(x.erreur) + '</p>' : '')
      + (acts.length ? '<div class="sgn-actions">' + acts.slice(0, 3).join('') + '</div>' : '')
      + '</li>';
  }
  function bas(actualiser) {
    return '<div class="sgn-bas">' + (actualiser ? '<button type="button" class="sgn-bouton" data-a="actualiser"' + (D.enCours ? ' disabled' : '') + '>Actualiser</button>' : '')
      + '<button type="button" class="sgn-bouton" data-a="revenir">Revenir</button></div>';
  }
  function htmlDemandes() {
    var t = '<div class="sgn-tete"><b id="sgn-titre">Mes demandes</b><button type="button" class="sgn-x" data-a="fermer" aria-label="Fermer">×</button></div>';
    if (!C.endpoint) return t + '<p class="sgn-erreur">Le bouton n’est pas relié (réglage « endpoint » manquant).</p>' + bas(false);
    if (!lire(CLE_STOCKAGE)) {
      return t + (D.erreur ? '<p class="sgn-erreur">' + h(D.erreur) + '</p>' : '<p class="sgn-aide">Pour voir tes demandes, tape ta clé d’équipe (la même que pour envoyer).</p>')
        + '<input class="sgn-cle" data-a="cle" type="password" autocomplete="off" placeholder="Ta clé d’équipe (donnée par l’administrateur)">'
        + '<p class="sgn-aide">Demandée une seule fois : elle reste dans ce navigateur.</p>'
        + '<button type="button" class="sgn-envoyer" data-a="voircle">Voir mes demandes</button>'
        + '<div class="sgn-etat" role="status" aria-live="polite"></div>' + bas(false);
    }
    var l = D.liste, erreur = D.erreur ? '<p class="sgn-erreur">' + h(D.erreur) + '</p>' : '';
    if (erreur && l && D.luA) erreur += '<p class="sgn-aide">Dernière liste reçue à ' + heure(D.luA) + ' (peut-être plus à jour) :</p>';
    // Le filtre d'un projet : une puce sur sa propre ligne, au-dessus des trois filtres ; la toucher montre tous les projets.
    var nom = D.projet ? nomDuProjet(D.projet) : '';
    var puce = D.projet ? '<div class="sgn-projet"><button type="button" class="sgn-puce" data-a="sansprojet" aria-label="Projet : ' + h(nom)
      + '. Toucher pour voir tous les projets">Projet : ' + h(nom) + ' <span class="sgn-puce-x" aria-hidden="true">×</span></button></div>' : '';
    if (!l) return t + puce + (erreur || '<p class="sgn-vide">Chargement…</p>') + bas(!!erreur);
    if (!D.stockage) return t + erreur + '<p class="sgn-vide">Le relais n’a pas de stockage : il ne garde pas les demandes, cette liste reste donc vide. Elles partent quand même à Claude.</p>' + bas(true);
    l = listeVue();
    if (!l.length) return t + puce + erreur + '<div class="sgn-etat sgn-etat-d" role="status" aria-live="polite"></div><p class="sgn-vide">'
      + (D.projet ? 'Aucune demande pour ce projet.' : 'Aucune demande pour l’instant.') + '</p>' + bas(true);
    var f = FILTRES.filter(function (x) { return x.id === D.filtre; })[0] || FILTRES[0], visibles = l.filter(f.garde);
    return t + puce + '<div class="sgn-filtres" role="group" aria-label="Filtrer les demandes">' + FILTRES.map(function (x) {
      return '<button type="button" class="sgn-filtre" data-a="filtre" data-v="' + x.id + '" aria-pressed="' + (x.id === f.id) + '">' + x.lib + ' <b>' + l.filter(x.garde).length + '</b></button>';
    }).join('') + '</div>'
      + '<div class="sgn-etat sgn-etat-d" role="status" aria-live="polite"></div>' + erreur
      + (visibles.length ? '<ul class="sgn-liste">' + visibles.map(carte).join('') + '</ul>' : '<p class="sgn-vide">' + f.vide + '</p>')
      + bas(true);
  }

  // ── LA FENÊTRE ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  // o.garder : le brouillon reste tel quel (« + Un autre écran ») ; sinon, fenêtre quittée sans rien y mettre = rien à garder.
  function fermer(o) {
    o = o || {};
    if (dictee) try { dictee.stop(); } catch (e) {}
    if (enregistreur) try { enregistreur.stop(); } catch (e) {}
    if (observateur) { observateur.disconnect(); observateur = null; }
    dessinAjuster = null;
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
    var demandeCle = !lire(CLE_STOCKAGE), n = demandeCle ? 0 : compteATraiter();
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
      + htmlCle(demandeCle)
      + '<button type="button" class="sgn-envoyer" data-a="envoyer"' + (envoiEnCours || coupe ? ' disabled' : '') + '>Envoyer à Claude</button>'
      + '<div class="sgn-etat" role="status" aria-live="polite"></div>'
      + htmlPied();
  }
  // Ce qui dit QUI envoie (aujourd'hui la clé d'équipe, demandée une fois).
  function htmlCle(demandeCle) {
    return demandeCle ? '<input class="sgn-cle" data-a="cle" type="password" autocomplete="off" placeholder="Ta clé d’équipe (donnée par l’administrateur)"><p class="sgn-aide">Demandée une seule fois : elle reste dans ce navigateur.</p>' : '';
  }
  // Le bas de la fenêtre : les réglages du rond lui-même.
  function htmlPied() {
    return positionDeLaPage() ? '<div class="sgn-pied"><button type="button" class="sgn-lien" data-a="remettre">Remettre le bouton à sa place</button></div>' : '';
  }
  function creerFond() {
    fond = marquer(document.createElement('div')); fond.className = 'sgn-fond'; vueRendue = '';
    fond.addEventListener('click', clic);
    fond.addEventListener('input', function (e) { if (e.target.classList.contains('sgn-texte')) { B.texte = e.target.value; sauver(); } });
    fond.addEventListener('change', function (e) { if (e.target.getAttribute('data-a') === 'importer') importer(e.target.files).then(function () { rendre(); }); });
    fond.addEventListener('keydown', function (e) { if (e.key === 'Enter' && vue === 'demandes' && e.target.classList.contains('sgn-cle')) { e.preventDefault(); validerCle(); } });
    document.addEventListener('keydown', function esc(e) { if (!fond) { document.removeEventListener('keydown', esc); return; } if (e.key === 'Escape' && !envoiEnCours) fermer(); });
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
    if (vue === 'signaler') {
      brancherDessin();
      var premier = fond.querySelector(!lire(CLE_STOCKAGE) && B.texte ? '.sgn-cle' : '.sgn-texte');
      if (premier) try { premier.focus({ preventScroll: true }); } catch (e) { premier.focus(); }
      return;
    }
    // Dans la liste, le focus reste sur le bouton touché (filtre, Actualiser…), sinon sur la clé à taper ou le filtre choisi.
    var cible = null;
    if (cleFocus && cleFocus[0]) cible = [].filter.call(fond.querySelectorAll('[data-a="' + cleFocus[0] + '"]'), function (el) { return el.getAttribute('data-v') === cleFocus[1] && el.getAttribute('data-id') === cleFocus[2]; })[0];
    if (!cible) cible = fond.querySelector('.sgn-cle') || fond.querySelector('.sgn-filtre[aria-pressed="true"]') || fond.querySelector('[data-a="revenir"]');
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
    else if (a === 'renvoyer') renvoyer(el.getAttribute('data-id'), el);
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
    if (dictee) try { dictee.stop(); } catch (e) {}
    envoiEnCours = true;
    var bouton = fond.querySelector('.sgn-envoyer'); bouton.disabled = true; dire(etat, 'Envoi…');
    var a = Date.now();
    Promise.all(B.captures.map(composer)).then(function (images) {
      var corps = { type: B.type, texte: B.texte.trim(), captures: B.captures.map(function (c, i) { return { donnees: images[i], ou: c.ou }; }), audio: B.audio, contexte: contexte(a) };
      return chercher(base() + '/signaler', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signaler-Cle': lire(CLE_STOCKAGE) }, body: JSON.stringify(corps) });
    })
      .then(function (r) { return r.json().catch(function () { return { ok: false, erreur: 'réponse illisible (' + r.status + ')' }; }).then(function (j) { j.statut = r.status; return j; }); })
      .then(function (j) {
        envoiEnCours = false; vue = 'signaler';
        if (j && j.ok) {
          effacerBrouillon();
          rendre('Transmis à Claude (réf. ' + (j.ref || '?') + ').', 'ok', true);
          var b2 = fond && fond.querySelector('.sgn-envoyer'); if (b2) b2.disabled = true;
          // Fermeture d'elle-même, sauf si la personne a touché quelque chose entre-temps (« Voir mes demandes »…).
          var r = rendus; setTimeout(function () { if (fond && !envoiEnCours && rendus === r) fermer(); }, 8000);
          chargerDemandes();
          return;
        }
        if (j && j.coupe) { couper(); rendre(COUPE_MSG, 'ko'); return; }
        if (j && j.cle) { ecrire(CLE_STOCKAGE, ''); D.liste = null; majCompteur(); }
        var garde = !(j && j.cle) && !!lire(CLE_STOCKAGE);
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
          monter(); if (fab) fab.style.display = ''; placer(); majCompteur();
        });
        return;
      }
      monter(); if (fab) fab.style.display = ''; placer(); majCompteur();
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
