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
 *
 *  L'interrupteur du pupitre : avant de montrer le rond, le bouton demande au relais s'il est coupé (GET /etat, 4 s au plus).
 *  Coupé : le rond n'apparaît pas. Relais muet, en erreur ou lent : le rond apparaît quand même (on ne bloque pas sur une panne).
 *  « Mes demandes » : avec la clé d'équipe gardée, un petit nombre sur le rond compte les demandes « à traiter » (une question
 *  de Claude, une PR à relire, une demande pas partie) ; le toucher ouvre la liste (GET /demandes), le reste du rond photographie.
 *
 *  API : window.Signaler.ouvrir() · .cacher() · .montrer() · .demandes(filtre)
 *        filtre = 'toutes' | 'traiter' | 'cours' ; sans filtre : « À traiter » s'il y en a, sinon toutes.
 *  Événement : window « signaler:demandes » { aTraiter, total } à chaque liste lue (pour un compteur ailleurs dans la page).
 */
(function () {
  'use strict';
  if (window.Signaler) return;

  var script = document.currentScript || null;
  var C = Object.assign({ position: 'bas-droite', html2canvas: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js' }, window.SignalerConfig || {});
  if (script && script.dataset) ['endpoint', 'version', 'position', 'html2canvas'].forEach(function (k) { if (script.dataset[k]) C[k] = script.dataset[k]; });
  var CLE_STOCKAGE = 'signaler_cle_v1';
  var CAPTURES_MAX = 6, LARGEUR_MAX = 1600, HAUTEUR_MAX = 2600, JPEG_Q = 0.8, AUDIO_MAX_MS = 180000, ETAT_DELAI_MS = 4000;
  var COUPE_MSG = 'Le bouton est coupé depuis le pupitre.';

  // ── LES DERNIÈRES ERREURS DE LA PAGE : souvent la moitié du diagnostic, et personne ne pense à les recopier ─────────────────
  var ERREURS = [];
  function noter(t) {
    try { t = String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, 300); if (!t) return; ERREURS.push(new Date().toTimeString().slice(0, 8) + ' ' + t); if (ERREURS.length > 10) ERREURS.shift(); } catch (e) {}
  }
  function texteDe(a) { if (a && a.message) return String(a.message); if (typeof a === 'string') return a; try { return JSON.stringify(a); } catch (e) { return String(a); } }
  window.addEventListener('error', function (ev) { noter((ev && ev.message) || 'erreur' + (ev && ev.filename ? ' @' + String(ev.filename).split('/').pop().split('?')[0] + ':' + ev.lineno : '')); });
  window.addEventListener('unhandledrejection', function (ev) { noter('promesse rejetée : ' + texteDe(ev && ev.reason)); });
  var ce = console.error;
  console.error = function () { try { noter('console.error : ' + [].map.call(arguments, texteDe).join(' ')); } catch (e) {} return ce.apply(console, arguments); };

  var lire = function (k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  var ecrire = function (k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) {} };
  var h = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var base = function () { return String(C.endpoint || '').replace(/\/+$/, ''); };

  // ── LE STYLE (préfixe sgn-, clair et sombre) ───────────────────────────────────────────────────────────────────────────────
  var cote = C.position === 'bas-gauche' ? 'left' : 'right';
  var css = ''
    + '.sgn-fab{position:fixed;bottom:calc(18px + env(safe-area-inset-bottom));' + cote + ':calc(18px + env(safe-area-inset-right));z-index:2147483000;'
    + 'width:48px;height:48px;border-radius:50%;border:0;padding:0;display:flex;align-items:center;justify-content:center;cursor:pointer;'
    + 'background:linear-gradient(135deg,#e08a6a 0%,#d97757 55%,#c45f3f 100%);box-shadow:0 6px 18px -6px rgba(120,50,20,.55),0 0 0 2px rgba(255,255,255,.85);'
    + '-webkit-tap-highlight-color:transparent;transition:transform .15s ease}'
    + '.sgn-fab:active{transform:scale(.88)}'
    // L'étoile de Claude (comme la bulle de KOULAM) : 12 traits inégaux qui s'allongent et se rétractent l'un après l'autre.
    + '.sgn-etoile{position:relative;width:26px;height:26px;display:block;pointer-events:none}'
    + '.sgn-r{position:absolute;left:50%;top:50%;width:0;height:0}'
    + '.sgn-r span{position:absolute;left:-1px;top:1px;width:2px;border-radius:1px;background:#fff;transform-origin:50% 0;animation:sgn-trait 2.6s ease-in-out infinite}'
    + '@keyframes sgn-trait{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.72)}}'
    + '@media (prefers-reduced-motion:reduce){.sgn-r span{animation:none}}'
    + '.sgn-fab:focus-visible,.sgn-badge:focus-visible{outline:3px solid #60a5fa;outline-offset:2px}'
    // Le nombre des demandes à traiter, posé sur le coin haut du rond ; sa zone de toucher déborde un peu (::after), le centre
    // du rond reste le bouton qui photographie.
    + '.sgn-badge{position:fixed;bottom:calc(51px + env(safe-area-inset-bottom));' + cote + ':calc(' + (cote === 'left' ? 51 : 9) + 'px + env(safe-area-inset-right));'
    + 'z-index:2147483000;min-width:22px;height:22px;padding:0 6px;border-radius:11px;border:2px solid #fff;background:#dc2626;color:#fff;'
    + 'font:700 12px/18px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center;cursor:pointer;box-sizing:border-box;'
    + 'box-shadow:0 2px 6px rgba(0,0,0,.25);-webkit-tap-highlight-color:transparent}'
    + '.sgn-badge::after{content:"";position:absolute;inset:-8px}'
    + '.sgn-fab,.sgn-fab *,.sgn-badge,.sgn-fond,.sgn-fond *{font-style:normal}'
    + '.sgn-fond{position:fixed;inset:0;z-index:2147483001;background:rgba(15,23,42,.45);display:flex;align-items:flex-end;justify-content:center}'
    + '@media (min-width:640px){.sgn-fond{align-items:center}}'
    + '.sgn-boite{--f:#fff;--t:#0f172a;--d:#475569;--b:#e2e8f0;--a:#2563eb;--c:#f8fafc;--ko:#dc2626;--ok:#16a34a;background:var(--f);color:var(--t);width:100%;max-width:520px;max-height:92vh;overflow:auto;'
    + 'border-radius:16px 16px 0 0;padding:16px 16px calc(16px + env(safe-area-inset-bottom));font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-sizing:border-box}'
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
    + '.sgn-vignettes{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;margin-bottom:8px}.sgn-v{position:relative;flex:0 0 auto}'
    + '.sgn-v img{display:block;height:84px;border-radius:8px;border:1px solid var(--b)}'
    + '.sgn-v button{position:absolute;top:-6px;right:-6px;width:24px;height:24px;border-radius:50%;border:0;background:#ef4444;color:#fff;font-size:14px;line-height:24px;cursor:pointer}'
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
    // « Mes demandes » : les filtres (une rangée de 3), puis une carte par demande, la plus récente en haut.
    + '.sgn-filtres{display:flex;gap:6px;margin-bottom:4px}'
    + '.sgn-filtre{flex:1 1 0;min-width:0;padding:8px 4px;border:1px solid var(--b);border-radius:999px;background:transparent;color:var(--t);font:inherit;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap}'
    + '.sgn-filtre b{color:var(--d);margin-left:3px}'
    + '.sgn-filtre[aria-pressed="true"]{background:#d97757;border-color:#d97757;color:#fff}.sgn-filtre[aria-pressed="true"] b{color:#fff}'
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

  // ── L'ÉTAT D'UN SIGNALEMENT EN COURS ───────────────────────────────────────────────────────────────────────────────────────
  var B = { type: 'bug', captures: [], texte: '', audio: null };
  var fab = null, badge = null, fond = null, dictee = null, enregistreur = null, envoiEnCours = false;
  // pret : le relais a dit si le bouton est coupé (ou n'a pas répondu à temps) · coupe : coupé depuis le pupitre
  var pret = false, coupe = false, cacheParPage = false;

  // ── LES APPELS AU RELAIS (sans cookie, jamais mis en cache) ────────────────────────────────────────────────────────────────
  // Rend le JSON de la réponse avec son statut ({ statut }), ou échoue si le relais est injoignable ou trop lent.
  function appel(chemin, o) {
    o = o || {};
    var ctrl = window.AbortController ? new AbortController() : null, minuteur = null;
    var init = { method: o.methode || 'GET', credentials: 'omit', cache: 'no-store', headers: {} };
    if (o.cle) init.headers['X-Signaler-Cle'] = o.cle;
    if (o.corps !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(o.corps); }
    if (ctrl) init.signal = ctrl.signal;
    var p = fetch(base() + chemin, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { j = j && typeof j === 'object' && !Array.isArray(j) ? j : {}; j.statut = r.status; return j; });
    });
    if (o.delai) p = Promise.race([p, new Promise(function (ok, ko) { minuteur = setTimeout(function () { if (ctrl) ctrl.abort(); ko(new Error('trop lent')); }, o.delai); })]);
    return p.then(function (j) { clearTimeout(minuteur); return j; }, function (e) { clearTimeout(minuteur); throw e; });
  }
  // L'interrupteur : seul un « actif: false » explicite cache le bouton. Le doute (panne, lenteur) le laisse paraître.
  var verification = C.endpoint ? appel('/etat', { delai: ETAT_DELAI_MS }).then(function (j) { return !(j && j.actif === false); }, function () { return true; }) : Promise.resolve(true);
  function couper() {
    coupe = true;
    if (fab) { fab.remove(); fab = null; }
    if (badge) { badge.remove(); badge = null; }
  }

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
  // L'écran TEL QU'IL EST, la partie visible seulement (le bouton, son nombre et la fenêtre cachés le temps de la photo).
  function photographier() {
    var cacher = [fab, badge, fond].filter(Boolean);
    cacher.forEach(function (e) { e.style.visibility = 'hidden'; });
    var fin = function () { cacher.forEach(function (e) { e.style.visibility = ''; }); };
    // Le fond de la page (sinon le transparent devient NOIR en JPEG, sous un contenu plus court que l'écran).
    var fondPage = '#ffffff';
    try {
      [document.body, document.documentElement].some(function (el) {
        var c = getComputedStyle(el).backgroundColor;
        if (c && !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(c)) { fondPage = c; return true; }
        return false;
      });
    } catch (e) {}
    return chargerHtml2canvas().then(function () {
      return window.html2canvas(document.body, { x: window.scrollX, y: window.scrollY, width: window.innerWidth, height: window.innerHeight,
        scale: Math.min(window.devicePixelRatio || 1, 2), useCORS: true, logging: false, backgroundColor: fondPage });
    }).then(function (canvas) { fin(); return reduire(canvas); }, function (e) { fin(); throw e; });
  }
  function ajouterCapture(donnees, ou) {
    if (B.captures.length >= CAPTURES_MAX) return false;
    B.captures.push({ donnees: donnees, ou: ou || (document.title || location.pathname) });
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
    })).then(function (d) { d.filter(Boolean).forEach(function (x) { ajouterCapture(x, 'image importée'); }); });
  }

  // ── LA PAROLE : dictée du navigateur quand il sait (Chrome, Edge, Safari), sinon une note vocale jointe ───────────────────
  var Reco = window.SpeechRecognition || window.webkitSpeechRecognition;
  function basculerMicro(bouton, zone, etat) {
    if (Reco) {
      if (dictee) { dictee.stop(); return; }
      var r = new Reco(), avant = zone.value ? zone.value.replace(/\s*$/, ' ') : '';
      r.lang = document.documentElement.lang || 'fr-FR'; r.continuous = true; r.interimResults = true;
      r.onresult = function (ev) { var t = ''; for (var i = 0; i < ev.results.length; i++) t += ev.results[i][0].transcript; zone.value = avant + t; B.texte = zone.value; };
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
        lecteur.onload = function () { B.audio = { donnees: String(lecteur.result), duree: Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') }; dire(etat, 'Note vocale jointe (' + B.audio.duree + ').', 'ok'); };
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
  var D = { liste: null, stockage: true, erreur: '', enCours: false, filtre: 'toutes', auto: false, luA: 0 };
  var vue = 'signaler', depuisSignaler = false, rendus = 0, numeroLecture = 0;

  function compteATraiter() { return D.liste ? D.liste.filter(FILTRES[1].garde).length : 0; }
  function httpsSur(u) { u = String(u || ''); return u.length <= 500 && /^https:\/\/[^\s"'<>]+$/i.test(u) ? u : ''; }
  // Le nom du projet, d'après l'adresse de la page où la demande a été faite.
  function projet(url) {
    var u; try { u = new URL(String(url || '')); } catch (e) { return ''; }
    var hote = u.host.replace(/^www\./i, '').toLowerCase(), chemin = u.pathname || '/';
    if (hote === '770lab.com') {
      if (/^\/home\/robots/i.test(chemin)) return 'Pupitre';
      if (/^\/home/i.test(chemin)) return 'Home';
      if (/^\/havroutia/i.test(chemin)) return 'HavroutIA';
    }
    if (hote === 'avinou-malkenou.web.app') return 'Avinou Malkenou';
    return hote;
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
        try { window.dispatchEvent(new CustomEvent('signaler:demandes', { detail: { aTraiter: compteATraiter(), total: D.liste.length } })); } catch (e) {}
      } else if (j.statut === 401 || j.cle) {
        ecrire(CLE_STOCKAGE, ''); D.liste = null;
        D.erreur = 'Clé refusée : le relais ne la connaît pas. Tape à nouveau ta clé d’équipe.';
      } else if (j.statut === 403) D.erreur = 'Page non autorisée : ce site n’est pas dans la liste du relais.';
      else if (j.statut === 503 || j.stockage === false) { D.liste = []; D.stockage = false; D.erreur = ''; }
      else D.erreur = 'Le relais a répondu une erreur (' + (j.erreur ? j.erreur + ', ' : '') + 'statut ' + j.statut + ').';
    }, function () {
      if (n === numeroLecture) D.erreur = 'Le relais est injoignable : vérifie la connexion, puis touche « Actualiser ».';
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
    }
    var t = fond && fond.querySelector('.sgn-tete [data-a="demandes"]');
    if (t) { t.innerHTML = 'Mes demandes' + (n ? ' <span class="sgn-nb">' + n + '</span>' : ''); t.setAttribute('aria-label', 'Mes demandes' + (n ? ', ' + n + ' à traiter' : '')); }
  }
  function ouvrirDemandes(filtre) {
    if (envoiEnCours || !document.body) return;
    if (vue !== 'demandes') depuisSignaler = !!fond && vue === 'signaler';
    vue = 'demandes';
    if (lire(CLE_STOCKAGE)) D.erreur = '';   // une vieille erreur ne s'affiche pas pendant la nouvelle lecture
    D.auto = !filtre;
    if (filtre) D.filtre = filtre; else if (D.liste) D.filtre = compteATraiter() ? 'traiter' : 'toutes';
    rendre();
    chargerDemandes().then(function () {
      if (!fond || vue !== 'demandes') return;
      if (D.auto) D.filtre = compteATraiter() ? 'traiter' : 'toutes';
      rendre();
    });
  }
  function validerCle() {
    var champ = fond && fond.querySelector('.sgn-cle'), etat = fond && fond.querySelector('.sgn-etat');
    if (!champ) return;
    var k = champ.value.trim();
    if (k.length < 16) { dire(etat, 'Tape ta clé d’équipe (16 caractères au moins).', 'ko'); champ.focus(); return; }
    ecrire(CLE_STOCKAGE, k); D.erreur = ''; D.liste = null;
    ouvrirDemandes(D.auto ? null : D.filtre);
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
    }, function () { return ['Pas renvoyée : le relais est injoignable.', 'ko']; }).then(function (m) {
      return chargerDemandes().then(function () { if (fond && vue === 'demandes') rendre(m[0], m[1]); });
    });
  }

  function carte(x) {
    var e = ETATS[x.etat] ? x.etat : 'inconnu';
    var p = projet(x.page && typeof x.page === 'object' ? x.page.url : ''), q = quand(x.creeLeMs);
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
    if (!l) return t + (erreur || '<p class="sgn-vide">Chargement…</p>') + bas(!!erreur);
    if (!D.stockage) return t + erreur + '<p class="sgn-vide">Le relais n’a pas de stockage : il ne garde pas les demandes, cette liste reste donc vide. Elles partent quand même à Claude.</p>' + bas(true);
    if (!l.length) return t + erreur + '<div class="sgn-etat sgn-etat-d" role="status" aria-live="polite"></div><p class="sgn-vide">Aucune demande pour l’instant.</p>' + bas(true);
    var f = FILTRES.filter(function (x) { return x.id === D.filtre; })[0] || FILTRES[0], visibles = l.filter(f.garde);
    return t + '<div class="sgn-filtres" role="group" aria-label="Filtrer les demandes">' + FILTRES.map(function (x) {
      return '<button type="button" class="sgn-filtre" data-a="filtre" data-v="' + x.id + '" aria-pressed="' + (x.id === f.id) + '">' + x.lib + ' <b>' + l.filter(x.garde).length + '</b></button>';
    }).join('') + '</div>'
      + '<div class="sgn-etat sgn-etat-d" role="status" aria-live="polite"></div>' + erreur
      + (visibles.length ? '<ul class="sgn-liste">' + visibles.map(carte).join('') + '</ul>' : '<p class="sgn-vide">' + f.vide + '</p>')
      + bas(true);
  }

  // ── LA FENÊTRE ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  function fermer() {
    if (dictee) try { dictee.stop(); } catch (e) {}
    if (enregistreur) try { enregistreur.stop(); } catch (e) {}
    if (fond) { fond.remove(); fond = null; }
    vue = 'signaler'; depuisSignaler = false;
    if (fab) fab.focus();
  }
  function htmlSignaler() {
    var demandeCle = !lire(CLE_STOCKAGE), n = demandeCle ? 0 : compteATraiter();
    return '<div class="sgn-tete"><b id="sgn-titre">Signaler à Claude</b><span class="sgn-tete-d">'
      + '<button type="button" class="sgn-lien" data-a="demandes" aria-label="Mes demandes' + (n ? ', ' + n + ' à traiter' : '') + '">Mes demandes' + (n ? ' <span class="sgn-nb">' + n + '</span>' : '') + '</button></span>'
      + '<button type="button" class="sgn-x" data-a="fermer" aria-label="Fermer">×</button></div>'
      + '<div class="sgn-types" role="group" aria-label="Type">'
      + '<button type="button" class="sgn-type" data-a="type" data-v="bug" aria-pressed="' + (B.type === 'bug') + '">Un bug</button>'
      + '<button type="button" class="sgn-type" data-a="type" data-v="idee" aria-pressed="' + (B.type === 'idee') + '">Une idée</button></div>'
      + '<div class="sgn-vignettes">' + B.captures.map(function (c, i) { return '<div class="sgn-v"><img src="' + c.donnees + '" alt="capture ' + (i + 1) + '"><button type="button" data-a="retirer" data-i="' + i + '" aria-label="Retirer la capture ' + (i + 1) + '">×</button></div>'; }).join('') + '</div>'
      + '<div class="sgn-rang">'
      + '<button type="button" class="sgn-bouton" data-a="capturer"' + (B.captures.length >= CAPTURES_MAX ? ' disabled' : '') + '>Capturer l’écran</button>'
      + '<label class="sgn-bouton">Importer<input type="file" accept="image/*" multiple hidden data-a="importer"></label>'
      + '<button type="button" class="sgn-bouton" data-a="micro" aria-pressed="false">' + (Reco ? 'Dicter' : 'Note vocale') + '</button></div>'
      + '<textarea class="sgn-texte" data-a="texte" placeholder="' + (B.type === 'idee' ? 'Ton idée, en quelques mots…' : 'Qu’est-ce qui ne va pas ? Qu’attendais-tu ?') + '">' + h(B.texte) + '</textarea>'
      + (B.audio ? '<p class="sgn-aide">Note vocale jointe (' + h(B.audio.duree) + ') · <a href="#" data-a="sansaudio">retirer</a></p>' : '')
      + (demandeCle ? '<input class="sgn-cle" data-a="cle" type="password" autocomplete="off" placeholder="Ta clé d’équipe (donnée par l’administrateur)"><p class="sgn-aide">Demandée une seule fois : elle reste dans ce navigateur.</p>' : '')
      + '<button type="button" class="sgn-envoyer" data-a="envoyer"' + (envoiEnCours || coupe ? ' disabled' : '') + '>Envoyer à Claude</button>'
      + '<div class="sgn-etat" role="status" aria-live="polite"></div>';
  }
  function creerFond() {
    fond = document.createElement('div'); fond.className = 'sgn-fond';
    fond.addEventListener('click', clic);
    fond.addEventListener('input', function (e) { if (e.target.classList.contains('sgn-texte')) B.texte = e.target.value; });
    fond.addEventListener('change', function (e) { if (e.target.getAttribute('data-a') === 'importer') importer(e.target.files).then(function () { rendre(); }); });
    fond.addEventListener('keydown', function (e) { if (e.key === 'Enter' && vue === 'demandes' && e.target.classList.contains('sgn-cle')) { e.preventDefault(); validerCle(); } });
    document.addEventListener('keydown', function esc(e) { if (!fond) { document.removeEventListener('keydown', esc); return; } if (e.key === 'Escape' && !envoiEnCours) fermer(); });
    document.body.appendChild(fond);
  }
  // lien : ajoute « Voir mes demandes » après le message.
  function rendre(message, ton, lien) {
    if (!document.body) return;
    if (!fond) creerFond();
    rendus++;
    var avant = document.activeElement && fond.contains(document.activeElement) ? document.activeElement : null;
    var cleFocus = avant ? [avant.getAttribute('data-a'), avant.getAttribute('data-v'), avant.getAttribute('data-id')] : null;
    if (vue === 'signaler' && coupe && !message) { message = COUPE_MSG; ton = 'ko'; }
    fond.innerHTML = '<div class="sgn-boite" role="dialog" aria-modal="true" aria-labelledby="sgn-titre">' + (vue === 'demandes' ? htmlDemandes() : htmlSignaler()) + '</div>';
    var etat = fond.querySelector('.sgn-etat');
    if (message) dire(etat, message, ton);
    if (lien && etat) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'sgn-lien'; b.setAttribute('data-a', 'demandes'); b.textContent = 'Voir mes demandes';
      etat.appendChild(document.createTextNode(' ')); etat.appendChild(b);
    }
    if (vue === 'signaler') {
      var premier = fond.querySelector(!lire(CLE_STOCKAGE) && B.texte ? '.sgn-cle' : '.sgn-texte'); if (premier) premier.focus();
      return;
    }
    // Dans la liste, le focus reste sur le bouton touché (filtre, Actualiser…), sinon sur la clé à taper ou le filtre choisi.
    var cible = null;
    if (cleFocus && cleFocus[0]) cible = [].filter.call(fond.querySelectorAll('[data-a="' + cleFocus[0] + '"]'), function (el) { return el.getAttribute('data-v') === cleFocus[1] && el.getAttribute('data-id') === cleFocus[2]; })[0];
    if (!cible) cible = fond.querySelector('.sgn-cle') || fond.querySelector('.sgn-filtre[aria-pressed="true"]') || fond.querySelector('[data-a="revenir"]');
    if (cible) try { cible.focus({ preventScroll: true }); } catch (e) { cible.focus(); }
  }
  function clic(e) {
    if (e.target === fond) { if (!envoiEnCours) fermer(); return; }
    var el = e.target.closest ? e.target.closest('[data-a]') : null;
    if (!el || !fond || !fond.contains(el) || el.disabled || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return;
    var a = el.getAttribute('data-a');
    if (a === 'fermer') fermer();
    else if (a === 'type') { B.type = el.getAttribute('data-v'); rendre(); }
    else if (a === 'retirer') { B.captures.splice(Number(el.getAttribute('data-i')), 1); rendre(); }
    else if (a === 'sansaudio') { e.preventDefault(); B.audio = null; rendre(); }
    else if (a === 'capturer') { photographier().then(function (d) { ajouterCapture(d); rendre('Capture ajoutée.', 'ok'); }, function () { rendre('La capture a échoué : importe une image à la place.', 'ko'); }); }
    else if (a === 'micro') basculerMicro(el, fond.querySelector('.sgn-texte'), fond.querySelector('.sgn-etat'));
    else if (a === 'envoyer') envoyer(fond.querySelector('.sgn-etat'));
    else if (a === 'demandes') ouvrirDemandes(null);
    else if (a === 'filtre') { D.filtre = el.getAttribute('data-v'); D.auto = false; rendre(); }
    else if (a === 'actualiser') { rendre('Actualisation…'); chargerDemandes().then(function () { if (fond && vue === 'demandes') rendre(D.erreur ? '' : 'Liste à jour (' + heure() + ').', 'ok'); }); }
    else if (a === 'renvoyer') renvoyer(el.getAttribute('data-id'), el);
    else if (a === 'voircle') validerCle();
    else if (a === 'revenir') { if (depuisSignaler) { vue = 'signaler'; depuisSignaler = false; rendre(); } else fermer(); }
  }

  function contexte() {
    var u = ''; try { u = typeof C.utilisateur === 'function' ? String(C.utilisateur() || '') : String(C.utilisateur || ''); } catch (e) {}
    return { url: location.href, titre: document.title, version: C.version || '', utilisateur: u, langue: navigator.language || '',
      appareil: navigator.userAgent, taille: window.innerWidth + '×' + window.innerHeight, erreurs: ERREURS.slice() };
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
    fetch(base() + '/signaler', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signaler-Cle': lire(CLE_STOCKAGE) },
      body: JSON.stringify({ type: B.type, texte: B.texte.trim(), captures: B.captures, audio: B.audio, contexte: contexte() }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, erreur: 'réponse illisible (' + r.status + ')' }; }).then(function (j) { j.statut = r.status; return j; }); })
      .then(function (j) {
        envoiEnCours = false; vue = 'signaler';
        if (j && j.ok) {
          B = { type: 'bug', captures: [], texte: '', audio: null };
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
      }, function () { envoiEnCours = false; rendre('Pas envoyé : le relais ne répond pas. Ton message est gardé : réessaie.', 'ko'); });
  }

  function ouvrir() {
    if (fond) { if (vue !== 'signaler' && !envoiEnCours) { vue = 'signaler'; depuisSignaler = false; rendre(); } return; }
    vue = 'signaler'; depuisSignaler = false;
    // On photographie AVANT d'ouvrir : l'écran tel que la personne le voyait.
    var avant = B.captures.length;
    (avant ? Promise.resolve(null) : photographier().catch(function () { return null; })).then(function (d) {
      if (d) ajouterCapture(d);
      rendre(d ? '' : (avant ? '' : 'La capture automatique a échoué : importe une image si besoin.'), d || avant ? '' : 'ko');
    });
  }

  var ETOILE = (function () {
    var L = [11, 8.5, 10, 7.5, 11.5, 9, 10, 8, 11, 8.5, 10.5, 9], t = '';
    for (var k = 0; k < 12; k++) t += '<span class="sgn-r" style="transform:rotate(' + (k * 30 + 8) + 'deg)"><span style="height:' + L[k] + 'px;animation-delay:-' + (k * 0.217).toFixed(2) + 's"></span></span>';
    return '<span class="sgn-etoile" aria-hidden="true">' + t + '</span>';
  })();
  function monter() {
    if (fab || !document.body || !pret || coupe) return;
    try { if (typeof C.visible === 'function' && !C.visible()) return; } catch (e) {}
    fab = document.createElement('button'); fab.type = 'button'; fab.className = 'sgn-fab'; fab.innerHTML = ETOILE;
    fab.title = 'Signaler un bug ou une idée à Claude'; fab.setAttribute('aria-label', 'Signaler un bug ou une idée');
    fab.addEventListener('click', ouvrir);
    badge = document.createElement('button'); badge.type = 'button'; badge.className = 'sgn-badge'; badge.style.display = 'none';
    badge.addEventListener('click', function (e) { e.stopPropagation(); ouvrirDemandes('traiter'); });
    if (cacheParPage) fab.style.display = 'none';
    document.body.appendChild(fab); document.body.appendChild(badge);
    majCompteur();
    chargerDemandes();
  }
  function demarrer() { verification.then(function (actif) { pret = true; if (!actif) { coupe = true; return; } monter(); }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', demarrer); else demarrer();

  window.Signaler = {
    ouvrir: function () { monter(); ouvrir(); },
    cacher: function () { cacheParPage = true; if (fab) fab.style.display = 'none'; majCompteur(); },
    montrer: function () { cacheParPage = false; monter(); if (fab) fab.style.display = ''; majCompteur(); },
    demandes: function (filtre) { ouvrirDemandes(NOMS_FILTRE[String(filtre || '').toLowerCase()] || null); },
    _etat: function () { return B; },
  };
})();
