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
 *  API : window.Signaler.ouvrir() · window.Signaler.cacher() · window.Signaler.montrer()
 */
(function () {
  'use strict';
  if (window.Signaler) return;

  var script = document.currentScript || null;
  var C = Object.assign({ position: 'bas-droite', html2canvas: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js' }, window.SignalerConfig || {});
  if (script && script.dataset) ['endpoint', 'version', 'position', 'html2canvas'].forEach(function (k) { if (script.dataset[k]) C[k] = script.dataset[k]; });
  var CLE_STOCKAGE = 'signaler_cle_v1';
  var CAPTURES_MAX = 6, LARGEUR_MAX = 1600, HAUTEUR_MAX = 2600, JPEG_Q = 0.8, AUDIO_MAX_MS = 180000;

  // ── LES DERNIÈRES ERREURS DE LA PAGE : souvent la moitié du diagnostic, et personne ne pense à les recopier ─────────────────
  var ERREURS = [];
  function noter(t) {
    try { t = String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, 300); if (!t) return; ERREURS.push(new Date().toTimeString().slice(0, 8) + ' ' + t); if (ERREURS.length > 10) ERREURS.shift(); } catch (e) {}
  }
  function texteDe(a) { if (a && a.message) return String(a.message); if (typeof a === 'string') return a; try { return JSON.stringify(a); } catch (e) { return String(a); } }
  window.addEventListener('error', function (ev) { noter((ev && ev.message) || 'erreur' + (ev && ev.filename ? ' @' + String(ev.filename).split('/').pop().split('?')[0] + ':' + ev.lineno : '')); });
  window.addEventListener('unhandledrejection', function (ev) { noter('promesse rejetée : ' + texteDe(ev && ev.reason)); });
  var ce = console.error;
  console.error = function () { try { noter('✖ ' + [].map.call(arguments, texteDe).join(' ')); } catch (e) {} return ce.apply(console, arguments); };

  var lire = function (k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  var ecrire = function (k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) {} };
  var h = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  // ── LE STYLE (préfixe sgn-, clair et sombre) ───────────────────────────────────────────────────────────────────────────────
  var css = ''
    + '.sgn-fab{position:fixed;bottom:calc(18px + env(safe-area-inset-bottom));' + (C.position === 'bas-gauche' ? 'left' : 'right') + ':calc(18px + env(safe-area-inset-right));z-index:2147483000;'
    + 'width:48px;height:48px;border-radius:50%;border:0;padding:0;display:flex;align-items:center;justify-content:center;cursor:pointer;'
    + 'background:linear-gradient(135deg,#e08a6a 0%,#d97757 55%,#c45f3f 100%);box-shadow:0 6px 18px -6px rgba(120,50,20,.55),0 0 0 2px rgba(255,255,255,.85);'
    + '-webkit-tap-highlight-color:transparent;transition:transform .15s ease}'
    + '.sgn-fab:active{transform:scale(.88)}'
    // L'étoile de Claude (comme la bulle de KOULAM) : 12 traits inégaux qui s'allongent et se rétractent l'un après l'autre.
    + '.sgn-etoile{position:relative;width:26px;height:26px;display:block;pointer-events:none}'
    + '.sgn-r{position:absolute;left:50%;top:50%;width:0;height:0}'
    + '.sgn-r i{position:absolute;left:-1px;top:1px;width:2px;border-radius:1px;background:#fff;transform-origin:50% 0;animation:sgn-trait 2.6s ease-in-out infinite}'
    + '@keyframes sgn-trait{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.72)}}'
    + '@media (prefers-reduced-motion:reduce){.sgn-r i{animation:none}}'
    + '.sgn-fab:focus-visible{outline:3px solid #60a5fa;outline-offset:2px}'
    + '.sgn-fond{position:fixed;inset:0;z-index:2147483001;background:rgba(15,23,42,.45);display:flex;align-items:flex-end;justify-content:center}'
    + '@media (min-width:640px){.sgn-fond{align-items:center}}'
    + '.sgn-boite{--f:#fff;--t:#0f172a;--d:#475569;--b:#e2e8f0;--a:#2563eb;background:var(--f);color:var(--t);width:100%;max-width:520px;max-height:92vh;overflow:auto;'
    + 'border-radius:16px 16px 0 0;padding:16px 16px calc(16px + env(safe-area-inset-bottom));font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-sizing:border-box}'
    + '@media (min-width:640px){.sgn-boite{border-radius:16px}}'
    + '@media (prefers-color-scheme:dark){.sgn-boite{--f:#0f172a;--t:#f1f5f9;--d:#94a3b8;--b:#334155;--a:#60a5fa}}'
    + '.sgn-boite *{box-sizing:border-box}'
    + '.sgn-tete{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}.sgn-tete b{font-size:17px}'
    + '.sgn-x{border:0;background:transparent;color:var(--d);font-size:22px;cursor:pointer;padding:4px 8px}'
    + '.sgn-types{display:flex;gap:8px;margin-bottom:10px}.sgn-type{flex:1;padding:9px;border:1px solid var(--b);border-radius:10px;background:transparent;color:var(--t);font:inherit;cursor:pointer}'
    + '.sgn-type[aria-pressed="true"]{border-color:var(--a);box-shadow:inset 0 0 0 1px var(--a);font-weight:600}'
    + '.sgn-vignettes{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;margin-bottom:8px}.sgn-v{position:relative;flex:0 0 auto}'
    + '.sgn-v img{display:block;height:84px;border-radius:8px;border:1px solid var(--b)}'
    + '.sgn-v button{position:absolute;top:-6px;right:-6px;width:24px;height:24px;border-radius:50%;border:0;background:#ef4444;color:#fff;font-size:14px;line-height:24px;cursor:pointer}'
    + '.sgn-rang{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}'
    + '.sgn-bouton{padding:9px 12px;border-radius:10px;border:1px solid var(--b);background:transparent;color:var(--t);font:inherit;cursor:pointer}'
    + '.sgn-bouton[aria-pressed="true"]{background:#fee2e2;color:#991b1b;border-color:#fca5a5}'
    + '.sgn-texte{width:100%;min-height:96px;padding:10px;border:1px solid var(--b);border-radius:10px;background:transparent;color:var(--t);font-family:inherit;font-size:16px;line-height:1.4;resize:vertical}'
    + '.sgn-cle{width:100%;padding:10px;border:1px solid var(--b);border-radius:10px;background:transparent;color:var(--t);font-family:inherit;font-size:16px;margin-top:6px}'
    + '.sgn-aide{color:var(--d);font-size:13px;margin:6px 0 0}'
    + '.sgn-envoyer{width:100%;margin-top:12px;padding:12px;border:0;border-radius:12px;background:var(--a);color:#fff;font-family:inherit;font-size:16px;font-weight:600;cursor:pointer}'
    + '.sgn-envoyer:disabled{opacity:.55;cursor:default}'
    + '.sgn-etat{min-height:20px;margin-top:8px;font-size:14px}.sgn-etat.ko{color:#dc2626}.sgn-etat.ok{color:#16a34a}';
  var style = document.createElement('style'); style.textContent = css; (document.head || document.documentElement).appendChild(style);

  // ── L'ÉTAT D'UN SIGNALEMENT EN COURS ───────────────────────────────────────────────────────────────────────────────────────
  var B = { type: 'bug', captures: [], texte: '', audio: null };
  var fab = null, fond = null, dictee = null, enregistreur = null, envoiEnCours = false;

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
  // L'écran TEL QU'IL EST, la partie visible seulement (le bouton et la fenêtre cachés le temps de la photo).
  function photographier() {
    var cacher = [fab, fond].filter(Boolean);
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
      r.onend = function () { dictee = null; bouton.setAttribute('aria-pressed', 'false'); bouton.textContent = '🎤 Dicter'; };
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
        enregistreur = null; bouton.setAttribute('aria-pressed', 'false'); bouton.textContent = '🎤 Note vocale';
        var blob = new Blob(morceaux, { type: rec.mimeType || 'audio/webm' }), s = Math.round((Date.now() - debut) / 1000);
        var lecteur = new FileReader();
        lecteur.onload = function () { B.audio = { donnees: String(lecteur.result), duree: Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') }; dire(etat, '🎤 Note vocale jointe (' + B.audio.duree + ').', 'ok'); };
        lecteur.readAsDataURL(blob);
      };
      rec.start(); enregistreur = rec; bouton.setAttribute('aria-pressed', 'true'); bouton.textContent = '■ Arrêter la note';
      dire(etat, '● Enregistrement… (3 minutes au plus)');
      setTimeout(function () { if (enregistreur === rec) rec.stop(); }, AUDIO_MAX_MS);
    }, function () { dire(etat, 'Micro refusé : autorise-le dans le navigateur.', 'ko'); });
  }

  function dire(el, t, ton) { if (!el) return; el.textContent = t || ''; el.className = 'sgn-etat' + (ton ? ' ' + ton : ''); }

  // ── LA FENÊTRE ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  function fermer() {
    if (dictee) try { dictee.stop(); } catch (e) {}
    if (enregistreur) try { enregistreur.stop(); } catch (e) {}
    if (fond) { fond.remove(); fond = null; }
    if (fab) fab.focus();
  }
  function rendre(message, ton) {
    if (!fond) {
      fond = document.createElement('div'); fond.className = 'sgn-fond';
      fond.addEventListener('click', function (e) { if (e.target === fond && !envoiEnCours) fermer(); });
      document.addEventListener('keydown', function esc(e) { if (!fond) { document.removeEventListener('keydown', esc); return; } if (e.key === 'Escape' && !envoiEnCours) fermer(); });
      document.body.appendChild(fond);
    }
    var demandeCle = !lire(CLE_STOCKAGE);
    fond.innerHTML = '<div class="sgn-boite" role="dialog" aria-modal="true" aria-labelledby="sgn-titre">'
      + '<div class="sgn-tete"><b id="sgn-titre">Signaler à Claude</b><button type="button" class="sgn-x" data-a="fermer" aria-label="Fermer">×</button></div>'
      + '<div class="sgn-types" role="group" aria-label="Type">'
      + '<button type="button" class="sgn-type" data-a="type" data-v="bug" aria-pressed="' + (B.type === 'bug') + '">Un bug</button>'
      + '<button type="button" class="sgn-type" data-a="type" data-v="idee" aria-pressed="' + (B.type === 'idee') + '">💡 Une idée</button></div>'
      + '<div class="sgn-vignettes">' + B.captures.map(function (c, i) { return '<div class="sgn-v"><img src="' + c.donnees + '" alt="capture ' + (i + 1) + '"><button type="button" data-a="retirer" data-i="' + i + '" aria-label="Retirer la capture ' + (i + 1) + '">×</button></div>'; }).join('') + '</div>'
      + '<div class="sgn-rang">'
      + '<button type="button" class="sgn-bouton" data-a="capturer"' + (B.captures.length >= CAPTURES_MAX ? ' disabled' : '') + '>📸 Capturer l’écran</button>'
      + '<label class="sgn-bouton">🖼 Importer<input type="file" accept="image/*" multiple hidden data-a="importer"></label>'
      + '<button type="button" class="sgn-bouton" data-a="micro" aria-pressed="false">' + (Reco ? '🎤 Dicter' : '🎤 Note vocale') + '</button></div>'
      + '<textarea class="sgn-texte" data-a="texte" placeholder="' + (B.type === 'idee' ? 'Ton idée, en quelques mots…' : 'Qu’est-ce qui ne va pas ? Qu’attendais-tu ?') + '">' + h(B.texte) + '</textarea>'
      + (B.audio ? '<p class="sgn-aide">🎤 Note vocale jointe (' + h(B.audio.duree) + ') · <a href="#" data-a="sansaudio">retirer</a></p>' : '')
      + (demandeCle ? '<input class="sgn-cle" data-a="cle" type="password" autocomplete="off" placeholder="Ta clé d’équipe (donnée par l’administrateur)"><p class="sgn-aide">Demandée une seule fois : elle reste dans ce navigateur.</p>' : '')
      + '<button type="button" class="sgn-envoyer" data-a="envoyer"' + (envoiEnCours ? ' disabled' : '') + '>Envoyer à Claude</button>'
      + '<div class="sgn-etat" role="status" aria-live="polite"></div></div>';
    var etat = fond.querySelector('.sgn-etat'), zone = fond.querySelector('.sgn-texte');
    if (message) dire(etat, message, ton);
    zone.addEventListener('input', function () { B.texte = zone.value; });
    fond.querySelector('[data-a="importer"]').addEventListener('change', function (e) { importer(e.target.files).then(function () { rendre(); }); });
    fond.querySelectorAll('[data-a]').forEach(function (el) {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return;
      el.addEventListener('click', function (e) {
        var a = el.getAttribute('data-a');
        if (a === 'fermer') fermer();
        else if (a === 'type') { B.type = el.getAttribute('data-v'); rendre(); }
        else if (a === 'retirer') { B.captures.splice(Number(el.getAttribute('data-i')), 1); rendre(); }
        else if (a === 'sansaudio') { e.preventDefault(); B.audio = null; rendre(); }
        else if (a === 'capturer') { photographier().then(function (d) { ajouterCapture(d); rendre('📸 Capture ajoutée.', 'ok'); }, function () { rendre('La capture a échoué : importe une image à la place.', 'ko'); }); }
        else if (a === 'micro') basculerMicro(el, zone, etat);
        else if (a === 'envoyer') envoyer(etat);
      });
    });
    var premier = fond.querySelector(demandeCle && B.texte ? '.sgn-cle' : '.sgn-texte'); if (premier) premier.focus();
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
    if (champCle) { var k = champCle.value.trim(); if (k.length < 16) { dire(etat, 'Tape ta clé d’équipe (16 caractères au moins).', 'ko'); champCle.focus(); return; } ecrire(CLE_STOCKAGE, k); }
    if (!B.texte.trim() && !B.captures.length && !B.audio) { dire(etat, 'Écris, dicte ou capture quelque chose d’abord.', 'ko'); return; }
    if (dictee) try { dictee.stop(); } catch (e) {}
    envoiEnCours = true;
    var bouton = fond.querySelector('.sgn-envoyer'); bouton.disabled = true; dire(etat, 'Envoi…');
    fetch(String(C.endpoint).replace(/\/+$/, '') + '/signaler', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signaler-Cle': lire(CLE_STOCKAGE) },
      body: JSON.stringify({ type: B.type, texte: B.texte.trim(), captures: B.captures, audio: B.audio, contexte: contexte() }) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, erreur: 'réponse illisible (' + r.status + ')' }; }).then(function (j) { j.statut = r.status; return j; }); })
      .then(function (j) {
        envoiEnCours = false;
        if (j && j.ok) {
          B = { type: 'bug', captures: [], texte: '', audio: null };
          rendre('✅ Transmis à Claude (réf. ' + h(j.ref || '?') + '). La correction arrive ; tu seras prévenu par la mise à jour.', 'ok');
          var b2 = fond && fond.querySelector('.sgn-envoyer'); if (b2) b2.disabled = true;
          setTimeout(function () { if (fond && !envoiEnCours) fermer(); }, 4000);
          return;
        }
        if (j && j.cle) ecrire(CLE_STOCKAGE, '');
        rendre('Pas envoyé : ' + ((j && j.erreur) || 'erreur') + '. Ton message est gardé : réessaie.', 'ko');
      }, function () { envoiEnCours = false; rendre('Pas envoyé : le relais ne répond pas. Ton message est gardé : réessaie.', 'ko'); });
  }

  function ouvrir() {
    if (fond) return;
    // On photographie AVANT d'ouvrir : l'écran tel que la personne le voyait.
    var avant = B.captures.length;
    (avant ? Promise.resolve(null) : photographier().catch(function () { return null; })).then(function (d) {
      if (d) ajouterCapture(d);
      rendre(d ? '' : (avant ? '' : 'La capture automatique a échoué : importe une image si besoin.'), d || avant ? '' : 'ko');
    });
  }

  var ETOILE = (function () {
    var L = [11, 8.5, 10, 7.5, 11.5, 9, 10, 8, 11, 8.5, 10.5, 9], t = '';
    for (var k = 0; k < 12; k++) t += '<span class="sgn-r" style="transform:rotate(' + (k * 30 + 8) + 'deg)"><i style="height:' + L[k] + 'px;animation-delay:-' + (k * 0.217).toFixed(2) + 's"></i></span>';
    return '<span class="sgn-etoile" aria-hidden="true">' + t + '</span>';
  })();
  function monter() {
    if (fab || !document.body) return;
    try { if (typeof C.visible === 'function' && !C.visible()) return; } catch (e) {}
    fab = document.createElement('button'); fab.type = 'button'; fab.className = 'sgn-fab'; fab.innerHTML = ETOILE;
    fab.title = 'Signaler un bug ou une idée à Claude'; fab.setAttribute('aria-label', 'Signaler un bug ou une idée');
    fab.addEventListener('click', ouvrir);
    document.body.appendChild(fab);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', monter); else monter();

  window.Signaler = {
    ouvrir: function () { monter(); ouvrir(); },
    cacher: function () { if (fab) fab.style.display = 'none'; },
    montrer: function () { monter(); if (fab) fab.style.display = ''; },
    _etat: function () { return B; },
  };
})();
