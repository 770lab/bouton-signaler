// Le bouton dans un VRAI navigateur (Chromium, via Playwright). POST /signaler passe par le VRAI relais (relay/cloudflare/worker.mjs
// servi par Node), avec un faux stockage R2 et une fausse routine : aucune donnée ne sort, aucun appel à Claude.
// L'interrupteur (GET /etat) et « Mes demandes » (GET /demandes, POST /demandes/<id>/renvoyer) sont joués par de FAUX relais écrits
// ici d'après le contrat : le test du bouton ne dépend pas du code de ces routes côté relais (testées par relais.test.mjs).
//   node tests/bouton.navigateur.mjs        (Playwright doit être installé : npm i -D playwright, ou global via NODE_PATH)
//   SIGNALER_CAPTURES=/un/dossier            où ranger les captures d'écran (défaut : tests/.cache/)
//   SIGNALER_PREFIXE=g1-                     un préfixe pour leurs noms (pour comparer deux passages)
// html2canvas : servi depuis tests/.cache/ s'il y est (le navigateur du test ne va pas sur Internet), sinon depuis cdnjs.
// Les pages des projets (http://770lab.com:<port>/home/, /home/robots.html, /havroutia/) : le navigateur envoie 770lab.com sur
// 127.0.0.1 (--host-resolver-rules), le site y sert la démo ; le bouton y trouve son projet d'après l'adresse, comme en ligne.
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { signaler } from '../relay/cloudflare/worker.mjs';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURES = process.env.SIGNALER_CAPTURES || join(RACINE, 'tests', '.cache');
const PREFIXE = String(process.env.SIGNALER_PREFIXE || '').replace(/[^a-z0-9_-]/gi, '');
mkdirSync(CAPTURES, { recursive: true });
let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch (e) { console.log('⊘ Playwright absent : test du navigateur non joué'); process.exit(0); }

let ko = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) ko++; };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

// Le site de démonstration (la racine du dépôt, en statique).
// ?dataProjet=<id> : la démo servie avec l'attribut data-projet sur la balise du bouton (écrit ici, par le site : une page
// fournie par Playwright n'aurait pas d'adresse IP, et Chrome lui refuserait le bouton et le relais, servis sur 127.0.0.1).
const DEMO = join(RACINE, 'demo', 'index.html');
const site = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), chemin = decodeURIComponent(u.pathname), attribut = u.searchParams.get('dataProjet');
  if (chemin === '/api/panne') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"ok":false}'); }
  if (chemin === '/api/panne-xhr') { res.writeHead(503); return res.end(); }
  if (/^\/(home|havroutia)/i.test(chemin) || (attribut && chemin === '/demo/index.html')) {
    let html = readFileSync(DEMO, 'utf8');
    if (attribut) html = html.replace('<script src="../widget/signaler.js"', '<script src="../widget/signaler.js" data-projet="' + attribut.replace(/[^a-z0-9_-]/gi, '') + '"');
    res.writeHead(200, { 'Content-Type': TYPES['.html'] }); return res.end(html);
  }
  const p = join(RACINE, chemin);
  if (!p.startsWith(RACINE) || !existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(readFileSync(p));
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const ORIGINE = 'http://127.0.0.1:' + site.address().port;
const LAB = 'http://770lab.com:' + site.address().port;   // Home, le pupitre, HavroutIA (le même site, sous leur adresse)
const PERMISES = new Set([ORIGINE, LAB]);

// Le relais : le vrai code du Worker pour POST /signaler, derrière un petit serveur Node.
const CLE = 'k7Qe9mWz4Lp2Xr8T', CLE_PAUL = 'Zr2mP8vQ5nB3wX6y';   // clés de test, sans valeur ailleurs
const NOMS = { [CLE]: 'marie', [CLE_PAUL]: 'paul' };
const objets = new Map(), appels = [];
const texteDe = (v) => (typeof v === 'string' ? v : new TextDecoder().decode(v instanceof ArrayBuffer ? new Uint8Array(v) : v));
const env = { ORIGINES: ORIGINE + ',' + LAB, DEPOT: 'exemple/app', ROUTINE_URL: 'https://api.anthropic.com/v1/claude_code/routines/trig_01TEST/fire', ROUTINE_JETON: 'sk-ant-oat01-FAUX',
  CLES: 'marie:' + CLE + ',paul:' + CLE_PAUL,
  PIECES: { put: async (k, v, o) => { objets.set(k, { v, o }); },
    get: async (k) => (objets.has(k) ? { body: objets.get(k).v, httpMetadata: (objets.get(k).o || {}).httpMetadata, text: async () => texteDe(objets.get(k).v) } : null) } };
const fausseRoutine = async (url, init) => { appels.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ claude_code_session_id: 'session_01X', claude_code_session_url: 'https://claude.ai/code/session_01X' }) }; };

// ── LE FAUX RELAIS des routes nouvelles, d'après le contrat ───────────────────────────────────────────────────────────────────
// faux.etat : 'on' | 'off' | 'erreur' (500) | 'absent' (vieux relais : 404 sans CORS) | 'lent' (répond « coupé » après 6 s)
// faux.etatOuvert : GET /etat lisible de partout (CORS « * ») et dit « origine: false » à une page absente des ORIGINES
//   (la correction proposée côté relais) ; sinon, comme le contrat : CORS pour les origines permises seulement.
// faux.demandes : 'normal' | 'sans-stockage' | 'injoignable' (connexion coupée) | 'interdit' (403) | 'erreur' (500)
//   | 'absent' (vieux relais, d'avant « Mes demandes » : 404 sans CORS, comme le relais en ligne le 19/10)
// faux.coupe : POST /signaler répond « coupé depuis le pupitre »
// faux.projets : { <id>: false } = l'interrupteur de ce projet coupé (les autres activés) ; GET /etat rend tous les projets, et
//   avec ?projet=<id> « projet » et « effectif » (le général ET ce projet) ; un id inconnu : 400 « projet inconnu ».
//   POST /signaler d'une page d'un projet coupé : « coupé » (le projet d'après contexte.url, comme le relais).
// faux.etatVieux : relais d'avant les projets (il ne lit pas ?projet=, ne dit ni « projets » ni « effectif »)
// faux.requetesEtat : le projet demandé à chaque GET /etat (null : sans ?projet=)
const PROJETS = ['home', 'pupitre', 'havroutia', 'avinou', 'koulam'];
// La règle du contrat (une copie ici : le test ne lit pas le code du bouton pour vérifier le bouton).
function projetDeLaPage(url) {
  let u; try { u = new URL(String(url || '')); } catch (e) { return null; }
  const hote = u.hostname.toLowerCase().replace(/^www\./, ''), c = u.pathname.toLowerCase();
  if (hote === '770lab.com') return c.startsWith('/home/robots') ? 'pupitre' : c.startsWith('/home') ? 'home' : c.startsWith('/havroutia') ? 'havroutia' : null;
  return hote === 'avinou-malkenou.web.app' ? 'avinou' : hote === 'koulam.app' ? 'koulam' : null;
}
const T0 = Date.now();
const LONG = 'Sur la page des cartes, quand on ouvre une carte puis qu’on revient en arrière, la liste remonte tout en haut et on perd sa place. '
  + 'Il faudrait que la liste garde la position, comme sur le téléphone, et que la carte ouverte reste en surbrillance un instant. '
  + 'Même chose sur ordinateur, où la molette ramène aussi en haut. Et la carte devrait se refermer avec la touche Échap.';
function demandesDeMarie() {
  const d = (min, x) => Object.assign({ qui: 'marie', type: 'bug', captures: 1, audio: false, creeLeMs: T0 - min * 60000, majLeMs: T0 - min * 60000 + 30000,
    retourHash: 'f'.repeat(64), texteRoutine: 'TEXTE INTERNE AU RELAIS' }, x);
  return [
    d(5, { id: 'a1b2c3d4e5f6', etat: 'question', texte: 'Le compteur des robots ne bouge plus depuis ce matin.', page: { url: 'https://770lab.com/home/robots.html', titre: 'Pupitre' },
      sessionUrl: 'https://claude.ai/code/session_01QUESTION', resume: 'Claude demande : faut-il compter aussi les robots en pause ?' }),
    d(30, { id: 'b2c3d4e5f6a1', etat: 'a_relire', texte: 'Le total des dossiers est faux sur l’accueil.', page: { url: 'https://770lab.com/home/', titre: 'Home' },
      sessionUrl: 'https://claude.ai/code/session_01RELIRE', liens: ['https://github.com/770lab/home/pull/42'], resume: 'Le total est corrigé ; la PR attend ta relecture.' }),
    d(90, { id: 'c3d4e5f6a1b2', etat: 'pas_partie', texte: 'La recherche ne trouve pas les mots avec accent.', page: { url: 'https://770lab.com/havroutia/recherche', titre: 'HavroutIA' },
      erreur: 'Claude n’a pas pu être prévenu (statut 503)', sessionUrl: 'https://claude.ai/code/session_01ANCIEN', liens: ['https://github.com/770lab/havroutia/pull/7'] }),
    d(180, { id: 'd4e5f6a1b2c3', etat: 'envoyee', type: 'idee', texte: LONG, page: { url: 'https://avinou-malkenou.web.app/cartes', titre: 'Avinou Malkenou' },
      sessionUrl: 'https://claude.ai/code/session_01ENCOURS' }),
    d(240, { id: '9f8e7d6c5b4a', etat: 'pas_partie', texte: 'Le bouton Partager ne fait rien sur Android.', page: { url: 'https://avinou-malkenou.web.app/', titre: 'Avinou Malkenou' },
      erreur: 'le relais n’est pas encore relié à Claude' }),
    d(400, { id: 'e5f6a1b2c3d4', etat: 'envoyee', texte: '<img src=x onerror="window.__xss=1">Un titre <b>gras</b>', page: { url: 'https://koulam.app/tehilim', titre: 'KOULAM' },
      sessionUrl: 'javascript:window.__xss=2' }),
    d(1500, { id: 'f6a1b2c3d4e5', etat: 'rien', texte: 'Le bouton Enregistrer est trop petit.', page: { url: ORIGINE + '/demo/index.html', titre: 'Démo' },
      resume: 'Rien à changer : le bouton fait déjà 48 px, comme demandé.' }),
    d(3000, { id: '0a1b2c3d4e5f', etat: 'echec', texte: 'Le journal plante quand on filtre par semaine.', page: { url: 'https://770lab.com/home/journal', titre: 'Home' },
      resume: 'Impossible de reproduire sur la page indiquée.' }),
    d(9000, { id: '1a2b3c4d5e6f', etat: 'en_ligne', texte: '', captures: 2, page: { url: 'https://770lab.com/home/', titre: 'Home' },
      liens: ['https://770lab.com/home/'], resume: 'Corrigé et en ligne.' }),
  ];
}
const faux = { etat: 'on', etatOuvert: false, etatVieux: false, coupe: false, projets: {}, demandes: 'normal', base: {}, appelsEtat: 0, appelsDemandes: 0, renvois: [],
  entetesEtat: null, requetesEtat: [], signalements: [] };
function remettre() {
  Object.assign(faux, { etat: 'on', etatOuvert: false, etatVieux: false, coupe: false, projets: {}, demandes: 'normal', base: { marie: demandesDeMarie(), paul: [] }, renvois: [], requetesEtat: [] });
}
remettre();
const publique = (x) => { const { retourHash, texteRoutine, ...p } = x; return p; };
const RENVOI_RX = /^\/demandes\/([0-9a-f]{12})\/renvoyer$/;

const relais = http.createServer(async (req, res) => {
  const morceaux = []; for await (const m of req) morceaux.push(m);
  const corps = Buffer.concat(morceaux);
  const u = new URL(req.url, 'http://x'), origine = req.headers.origin || '';
  const permise = PERMISES.has(origine);
  const cors = permise ? { 'Access-Control-Allow-Origin': origine, 'Vary': 'Origin' } : { 'Vary': 'Origin' };
  const repondre = (statut, o, entetes) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(statut, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, entetes || cors));
    res.end(JSON.stringify(o));
  };
  const qui = NOMS[String(req.headers['x-signaler-cle'] || '')];
  if (req.method === 'OPTIONS') {
    res.writeHead(204, Object.assign(cors, permise ? { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Signaler-Cle', 'Access-Control-Max-Age': '600' } : {}));
    return res.end();
  }
  if (req.method === 'GET' && u.pathname === '/etat') {
    faux.appelsEtat++; faux.entetesEtat = req.headers;
    const pq = u.searchParams.get('projet'); faux.requetesEtat.push(pq);
    if (faux.etat === 'absent') { res.writeHead(404); return res.end('introuvable'); }
    const ce = faux.etatOuvert ? { 'Access-Control-Allow-Origin': '*', 'Vary': 'Origin' } : cors, plus = faux.etatOuvert ? { origine: permise } : {};
    if (faux.etat === 'erreur') return repondre(500, { ok: false }, ce);
    if (faux.etat === 'lent') { await attendre(6000); return repondre(200, { ok: true, actif: false, depuis: T0, par: 'marie', ...plus }, ce); }
    const coupeLe = { actif: false, depuis: T0, par: 'marie' }, allume = { actif: true, depuis: null, par: null };
    const r = Object.assign({ ok: true }, faux.etat === 'off' ? coupeLe : allume, plus);
    if (faux.etatVieux) return repondre(200, r, ce);
    r.projets = Object.fromEntries(PROJETS.map((id) => [id, faux.projets[id] === false ? coupeLe : allume]));
    if (pq !== null) {
      if (!PROJETS.includes(pq)) return repondre(400, { ok: false, erreur: 'projet inconnu' }, ce);
      Object.assign(r, { projet: pq, effectif: r.actif && r.projets[pq].actif });
    }
    return repondre(200, r, ce);
  }
  if (req.method === 'GET' && u.pathname === '/demandes') {
    faux.appelsDemandes++;
    if (faux.demandes === 'injoignable') return req.socket.destroy();
    if (faux.demandes === 'absent') { res.writeHead(404); return res.end('introuvable'); }
    if (origine && !permise) return repondre(403, { ok: false, erreur: 'page non autorisée' });
    if (faux.demandes === 'interdit') return repondre(403, { ok: false, erreur: 'page non autorisée' });
    if (!qui) return repondre(401, { ok: false, cle: true, erreur: 'clé d’équipe absente ou inconnue' });
    if (faux.demandes === 'erreur') return repondre(500, { ok: false, erreur: 'stockage en panne' });
    if (faux.demandes === 'sans-stockage') return repondre(200, { ok: true, demandes: [], stockage: false });
    const l = (faux.base[qui] || []).slice().sort((a, b) => b.creeLeMs - a.creeLeMs).slice(0, 20).map(publique);
    return repondre(200, { ok: true, demandes: l });
  }
  const m = RENVOI_RX.exec(u.pathname);
  if (req.method === 'POST' && m) {
    if (origine && !permise) return repondre(403, { ok: false, erreur: 'page non autorisée' });
    if (!qui) return repondre(401, { ok: false, cle: true, erreur: 'clé d’équipe absente ou inconnue' });
    const d = (faux.base[qui] || []).find((x) => x.id === m[1]);
    if (!d) return repondre(404, { ok: false, erreur: 'demande inconnue' });
    if (d.etat !== 'pas_partie') return repondre(409, { ok: false, erreur: 'cette demande n’est pas « pas partie »' });
    faux.renvois.push(d.id);
    Object.assign(d, { etat: 'envoyee', sessionUrl: 'https://claude.ai/code/session_01RENVOI', majLeMs: Date.now(), retourHash: 'e'.repeat(64) }); delete d.erreur;
    return repondre(200, { ok: true, demande: publique(d) });
  }
  // faux.signalements : chaque corps de POST /signaler tel que le bouton l'a envoyé (images avec leur dessin, contexte…).
  if (req.method === 'POST' && u.pathname === '/signaler') { try { faux.signalements.push(JSON.parse(texteDe(corps))); } catch (e) {} }
  if (req.method === 'POST' && u.pathname === '/signaler' && permise && qui) {
    let pj = null; try { pj = projetDeLaPage(JSON.parse(texteDe(corps)).contexte.url); } catch (e) {}
    if (faux.coupe || (pj && faux.projets[pj] === false)) return repondre(403, { ok: false, coupe: true, erreur: 'le bouton est coupé depuis le pupitre' });
  }
  const r = new Request('http://127.0.0.1' + req.url, { method: req.method, headers: req.headers, body: req.method === 'POST' ? corps : undefined });
  const rep = await signaler(r, env, { fetch: fausseRoutine, attendre: async () => {} });
  res.writeHead(rep.status, Object.fromEntries(rep.headers)); res.end(Buffer.from(await rep.arrayBuffer()));
});
await new Promise((r) => relais.listen(0, '127.0.0.1', r));
const RELAIS = 'http://127.0.0.1:' + relais.address().port;

const navigateur = await chromium.launch({ args: ['--host-resolver-rules=MAP 770lab.com 127.0.0.1'] });
const H2C = join(RACINE, 'tests', '.cache', 'html2canvas-1.4.1.min.js');
// html2canvas, enveloppé : window.__h2cDelai (ms) retarde la photo, pour voir le rond PENDANT qu'elle se fait.
const H2C_RETARD = '\n;(function(){var v=window.html2canvas;if(!v)return;window.html2canvas=function(e,o){var d=window.__h2cDelai||0;'
  + 'return new Promise(function(r){setTimeout(r,d)}).then(function(){return v(e,o)})}})();';
// o.toucher : écran tactile (hasTouch ; isMobile jusqu'à 768 px) · o.mouvement : 'reduce' pour prefers-reduced-motion
async function page(taille, o = {}) {
  const ctx = await navigateur.newContext({ viewport: taille, permissions: [], colorScheme: o.theme || 'light', hasTouch: !!o.toucher,
    isMobile: !!o.toucher && taille.width <= 768, reducedMotion: o.mouvement || 'no-preference' });
  if (o.cle) await ctx.addInitScript((k) => { try { if (!localStorage.getItem('signaler_cle_v1')) localStorage.setItem('signaler_cle_v1', k); } catch (e) {} }, o.cle);
  if (o.init) await ctx.addInitScript(o.init);
  const p = await ctx.newPage();
  await p.route('https://cdnjs.cloudflare.com/**', async (route) => {
    const corps = existsSync(H2C) ? readFileSync(H2C, 'utf8') : await (await route.fetch()).text();
    return route.fulfill({ contentType: 'text/javascript', body: corps + H2C_RETARD });
  });
  const erreursPage = []; p.on('pageerror', (e) => erreursPage.push(String(e)));
  // o.chemin : une autre page que la démo (/home/, /home/robots.html…) · o.projet : ?projet= (SignalerConfig.projet de la démo)
  // o.dataProjet : l'attribut data-projet posé sur la balise du bouton (par le site)
  await p.goto((o.origine || ORIGINE) + (o.chemin || '/demo/index.html') + '?relais=' + encodeURIComponent(o.relais || RELAIS)
    + (o.projet ? '&projet=' + encodeURIComponent(o.projet) : '') + (o.dataProjet ? '&dataProjet=' + encodeURIComponent(o.dataProjet) : ''));
  return { p, ctx, erreursPage };
}
const texte = async (p, sel) => ((await p.textContent(sel)) || '').replace(/\s+/g, ' ').trim();
const capture = (p, nom) => p.screenshot({ path: join(CAPTURES, PREFIXE + nom) });

// Ce que la règle de l'interface interdit, mesuré dans la page : défilement en largeur, élément qui dépasse de la fenêtre,
// rangée de plus de 3 boutons, italique, émoji (texte, aria-label, title, placeholder, alt).
async function controler(p) {
  return p.evaluate(() => {
    const pb = [], de = document.documentElement;
    const nom = (e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : '') + ' « ' + (e.textContent || '').trim().slice(0, 30) + ' »';
    if (de.scrollWidth > de.clientWidth) pb.push('la page défile en largeur (' + de.scrollWidth + ' > ' + de.clientWidth + ')');
    const tous = [...document.querySelectorAll('.sgn-fab, .sgn-fab *, .sgn-badge, .sgn-fond, .sgn-fond *, .sgn-bulle, .sgn-bulle *')];
    const RX = /\p{Extended_Pictographic}/u;
    for (const e of tous) {
      if (getComputedStyle(e).fontStyle !== 'normal') pb.push('italique : ' + nom(e));
      if (/^(EM|I)$/.test(e.tagName)) pb.push('balise ' + e.tagName + ' : ' + nom(e));
      for (const n of e.childNodes) if (n.nodeType === 3 && RX.test(n.nodeValue)) pb.push('émoji : ' + n.nodeValue.trim().slice(0, 40));
      for (const a of ['aria-label', 'title', 'placeholder', 'alt']) { const v = e.getAttribute(a); if (v && RX.test(v)) pb.push('émoji (' + a + ') : ' + v); }
    }
    for (const sel of ['.sgn-fab', '.sgn-badge', '.sgn-bulle']) {
      const e = document.querySelector(sel); if (!e || getComputedStyle(e).display === 'none') continue;
      const r = e.getBoundingClientRect();
      if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) pb.push(sel + ' sort de l’écran');
    }
    const boite = document.querySelector('.sgn-boite');
    if (boite) {
      const b = boite.getBoundingClientRect();
      if (b.left < -0.5 || b.right > innerWidth + 0.5) pb.push('la fenêtre sort de l’écran');
      if (boite.scrollWidth > boite.clientWidth) pb.push('la fenêtre défile en largeur (' + boite.scrollWidth + ' > ' + boite.clientWidth + ')');
      for (const e of boite.querySelectorAll('*')) {
        const r = e.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        if (r.left < b.left - 0.5 || r.right > b.right + 0.5) pb.push('dépasse de la fenêtre : ' + nom(e));
        if (!e.closest('.sgn-vignettes') && e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1) pb.push('contenu plus large que sa boîte : ' + nom(e));
      }
    }
    // Pas plus de 3 boutons par rangée, dans la fenêtre comme dans la bulle (les vignettes des écrans sont une galerie).
    for (const zone of document.querySelectorAll('.sgn-boite, .sgn-bulle')) {
      if (getComputedStyle(zone).display === 'none') continue;
      const clics = [...zone.querySelectorAll('button, a[href], label.sgn-bouton')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.closest('.sgn-v'); });
      const rangs = [];
      for (const e of clics) {
        const r = e.getBoundingClientRect(), c = r.top + r.height / 2;
        let g = rangs.find((x) => Math.abs(x.c - c) < Math.min(x.h, r.height) / 2);
        if (!g) rangs.push(g = { c, h: r.height, noms: [] });
        g.noms.push((e.textContent || '').trim());
      }
      for (const g of rangs) if (g.noms.length > 3) pb.push('plus de 3 boutons sur une rangée : ' + g.noms.join(' | '));
    }
    return pb;
  });
}

try {
  console.log('1. Un signalement complet, sur téléphone (390 × 844)');
  const { p, ctx, erreursPage } = await page({ width: 390, height: 844 });
  await p.click('#panne');                                   // une erreur dans la console de la page
  const fab = await p.waitForSelector('.sgn-fab');
  const bf = await fab.boundingBox();
  ok(bf && bf.x + bf.width <= 390 && bf.y + bf.height <= 844 && bf.width >= 44, 'le rond est à l’écran, assez grand pour un doigt (≥ 44 px)');
  ok(faux.appelsEtat >= 1 && !faux.entetesEtat['x-signaler-cle'] && !faux.entetesEtat.cookie, 'le relais a été consulté (GET /etat), sans clé ni cookie');
  ok(!(await p.isVisible('.sgn-badge')), 'sans clé, pas de nombre sur le rond');
  await fab.click();
  await p.waitForSelector('.sgn-boite');
  await p.waitForSelector('.sgn-v img', { timeout: 15000 });
  ok((await p.$$('.sgn-v img')).length === 1, 'l’écran est photographié AVANT que la fenêtre s’ouvre (une capture)');
  // Là où rien n'est peint (sous un contenu plus court que l'écran, ou dans la marge de la page, ici le coin bas gauche), la
  // capture prend le fond de la page — pas du noir (le transparent en JPEG).
  const basDeCapture = await p.evaluate(() => new Promise((ok) => {
    const img = new Image();
    img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const d = g.getImageData(4, img.height - 5, 1, 1).data; ok(d[0] + d[1] + d[2]); };
    img.src = window.Signaler._etat().captures[0].donnees;
  }));
  ok(basDeCapture > 600, 'le bas de la capture a la couleur du fond de la page, pas du noir (somme RVB ' + basDeCapture + ')');
  const bb = await (await p.$('.sgn-boite')).boundingBox();
  ok(bb.width <= 390 && bb.x >= 0, 'la fenêtre tient dans la largeur du téléphone');
  ok(!!(await p.$('.sgn-cle')), 'la première fois, la clé d’équipe est demandée');
  ok(/Mes demandes/.test(await texte(p, '.sgn-tete')), 'l’en-tête propose « Mes demandes »');
  await p.click('[data-a="capturer"]');
  await p.waitForFunction(() => document.querySelectorAll('.sgn-v img').length === 2, null, { timeout: 15000 });
  ok(true, '« Capturer l’écran » ajoute une seconde capture');
  await p.fill('.sgn-texte', 'Le bouton Enregistrer ne fait rien sur le devis D-0042');
  await p.fill('.sgn-cle', CLE);
  await capture(p, 'fenetre-telephone.png');
  await p.click('.sgn-envoyer');
  await p.waitForSelector('.sgn-etat.ok', { timeout: 15000 });
  ok(/Transmis à Claude/.test(await p.textContent('.sgn-etat')), 'la page dit « Transmis à Claude » avec la référence');
  ok(!!(await p.$('.sgn-etat [data-a="demandes"]')) && /Voir mes demandes/.test(await p.textContent('.sgn-etat')), 'le message de réussite propose « Voir mes demandes »');
  ok(appels.length === 1, 'la routine est prévenue une fois');
  const t = (appels[0] && appels[0].text) || '';
  ok(t.includes('Le bouton Enregistrer ne fait rien sur le devis D-0042') && t.includes('Signalé par : marie') && t.includes('compte dans l’application : marie@exemple.fr'), 'le texte, la personne (d’après sa clé) et son compte');
  ok(t.includes('TypeError: devis.client is undefined') && t.includes('Version : demo-1.0') && t.includes('Écran : 390×844'), 'les erreurs de la page, la version, la taille de l’écran');
  const imgs = [...objets.values()].filter((o) => o.o && o.o.customMetadata && o.o.customMetadata.genre === 'image');
  ok(imgs.length === 2 && imgs.every((o) => o.o.httpMetadata.contentType === 'image/jpeg' && o.v.length > 1000), 'les deux captures sont rangées (JPEG)');
  ok((t.match(/\/piece\/[0-9a-f]{32}/g) || []).length === 2, 'leurs adresses sont dans le texte de la routine');
  await p.waitForFunction(() => { const b = document.querySelector('.sgn-badge'); return b && b.textContent === '4'; }, null, { timeout: 5000 });
  ok(true, 'après l’envoi, la liste est relue : le rond porte le nombre à traiter (4)');
  await capture(p, 'w-390-light-envoye.png');
  await p.click('.sgn-etat [data-a="demandes"]');
  await p.waitForSelector('.sgn-carte');
  ok((await texte(p, '#sgn-titre')) === 'Mes demandes', '« Voir mes demandes » ouvre la liste dans la même fenêtre');
  await p.waitForTimeout(8500);
  ok(!!(await p.$('.sgn-boite')), 'la liste ouverte ne se referme pas d’elle-même');
  ok(erreursPage.length === 0, 'aucune erreur JavaScript du bouton lui-même');
  await p.keyboard.press('Escape');

  console.log('2. La clé est gardée ; une clé refusée est redemandée, le message reste');
  await p.reload();
  await (await p.waitForSelector('.sgn-fab')).click();
  await p.waitForSelector('.sgn-boite');
  ok(!(await p.$('.sgn-cle')), 'la clé n’est plus demandée (gardée dans ce navigateur)');
  await p.evaluate(() => localStorage.setItem('signaler_cle_v1', 'cle-inconnue-de-16c'));
  await p.fill('.sgn-texte', 'Deuxième essai');
  await p.click('.sgn-envoyer');
  await p.waitForSelector('.sgn-etat.ko', { timeout: 15000 });
  ok(/clé/.test(await p.textContent('.sgn-etat')) && !!(await p.$('.sgn-cle')), 'clé refusée : on le dit, et la clé est redemandée');
  ok((await p.inputValue('.sgn-texte')) === 'Deuxième essai', 'le message n’est pas perdu');
  ok(appels.length === 1, 'rien n’est parti à la routine');
  await p.keyboard.press('Escape');
  ok(!(await p.$('.sgn-boite')), 'Échap ferme la fenêtre');
  await ctx.close();

  console.log('3. Sur ordinateur (1440 × 900)');
  const o = await page({ width: 1440, height: 900 });
  await (await o.p.waitForSelector('.sgn-fab')).click();
  await o.p.waitForSelector('.sgn-v img', { timeout: 15000 });
  const bo = await (await o.p.$('.sgn-boite')).boundingBox();
  ok(bo.width <= 520 && bo.x > 400, 'la fenêtre est centrée, pas plus large que 520 px');
  await capture(o.p, 'fenetre-ordinateur.png');
  await o.ctx.close();

  console.log('4. L’interrupteur du pupitre (GET /etat)');
  remettre(); faux.etat = 'off';
  let e = await page({ width: 390, height: 844 }, { cle: CLE });
  await e.p.waitForTimeout(1500);
  ok(!(await e.p.$('.sgn-fab')) && !(await e.p.$('.sgn-badge')), 'coupé depuis le pupitre : le rond n’apparaît pas');
  await e.p.evaluate(() => window.Signaler.demandes());
  await e.p.waitForSelector('.sgn-carte');
  ok((await texte(e.p, '#sgn-titre')) === 'Mes demandes', 'Signaler.demandes() ouvre quand même la liste (le pupitre s’en sert)');
  await e.p.keyboard.press('Escape');
  let lusEtat = faux.appelsEtat;
  await e.p.evaluate(() => window.Signaler.montrer());
  await e.p.waitForTimeout(1500);
  ok(faux.appelsEtat > lusEtat && !(await e.p.$('.sgn-fab')), 'toujours coupé : Signaler.montrer() (Home, après la connexion) redemande au relais et ne passe pas outre l’interrupteur');
  faux.etat = 'on';
  await e.p.evaluate(() => window.Signaler.montrer());
  ok(!!(await e.p.waitForSelector('.sgn-fab', { timeout: 3000 }).catch(() => null)), 'rallumé depuis le pupitre : Signaler.montrer() fait revenir le rond sans recharger la page');
  ok(!!(await e.p.waitForFunction(() => { const b = document.querySelector('.sgn-badge'); return b && b.style.display !== 'none' && b.textContent === '4'; }, null, { timeout: 5000 }).catch(() => null)), 'avec son nombre à traiter (4)');
  ok(e.erreursPage.length === 0, 'aucune erreur JavaScript');
  await e.ctx.close();
  // Page qui cache le bouton au démarrage (écran verrouillé d'Avinou Malkenou, Home avant la connexion) : pas un mot au relais.
  remettre(); faux.etat = 'on';
  lusEtat = faux.appelsEtat;
  e = await page({ width: 390, height: 844 }, { cle: CLE, init: () => {
    // la démo pose sa propre SignalerConfig : on y ajoute visible() au moment où elle l'écrit
    let v; Object.defineProperty(window, 'SignalerConfig', { configurable: true, get: () => v, set: (x) => { v = Object.assign({}, x, { visible: () => !!window.__ouvert }); } });
  } });
  await e.p.waitForTimeout(1500);
  ok(!(await e.p.$('.sgn-fab')) && faux.appelsEtat === lusEtat, 'caché au démarrage : ni rond, ni appel à GET /etat');
  await e.p.evaluate(() => { window.__ouvert = true; window.Signaler.montrer(); });
  ok(!!(await e.p.waitForSelector('.sgn-fab', { timeout: 3000 }).catch(() => null)) && faux.appelsEtat > lusEtat, 'puis Signaler.montrer() (déverrouillage, connexion) : le relais est interrogé et le rond paraît');
  await e.ctx.close();
  for (const [mode, dit] of [['on', 'allumé'], ['erreur', 'relais en erreur (500)'], ['absent', 'vieux relais sans /etat (404 sans CORS)']]) {
    faux.etat = mode;
    e = await page({ width: 390, height: 844 });
    ok(!!(await e.p.waitForSelector('.sgn-fab', { timeout: 3000 }).catch(() => null)), dit + ' : le rond apparaît');
    await e.ctx.close();
  }
  faux.etat = 'lent';
  const t0 = Date.now();
  e = await page({ width: 390, height: 844 });
  await e.p.waitForSelector('.sgn-fab', { timeout: 9000 });
  const dt = Date.now() - t0;
  ok(dt >= 3500 && dt < 6000, 'relais trop lent (réponse après 6 s) : le rond apparaît au bout de 4 s (' + dt + ' ms)');
  await e.p.waitForTimeout(Math.max(0, 7000 - (Date.now() - t0)));
  ok(!!(await e.p.$('.sgn-fab')), 'la réponse tardive « coupé » est ignorée : le rond reste');
  await e.ctx.close();
  faux.etat = 'on'; faux.coupe = true;
  e = await page({ width: 390, height: 844 }, { cle: CLE });
  await (await e.p.waitForSelector('.sgn-fab')).click();
  await e.p.waitForSelector('.sgn-v img', { timeout: 15000 });
  await e.p.fill('.sgn-texte', 'Essai pendant la coupure');
  const n0 = appels.length;
  await e.p.click('.sgn-envoyer');
  await e.p.waitForSelector('.sgn-etat.ko', { timeout: 15000 });
  ok((await texte(e.p, '.sgn-etat')) === 'Le bouton est coupé depuis le pupitre.', 'coupé pendant que la page était ouverte : « Le bouton est coupé depuis le pupitre. »');
  ok(!(await e.p.$('.sgn-fab')) && !(await e.p.$('.sgn-badge')), 'et le rond disparaît');
  ok(appels.length === n0 && (await e.p.inputValue('.sgn-texte')) === 'Essai pendant la coupure' && await e.p.isDisabled('.sgn-envoyer'), 'rien n’est parti à Claude, le message reste, « Envoyer » est grisé');
  faux.coupe = false;
  await e.p.keyboard.press('Escape');
  await e.p.evaluate(() => window.Signaler.montrer());
  ok(!!(await e.p.waitForSelector('.sgn-fab', { timeout: 3000 }).catch(() => null)), 'puis rallumé : Signaler.montrer() le fait revenir');
  ok(e.erreursPage.length === 0, 'aucune erreur JavaScript');
  await e.ctx.close();

  console.log('5. Le nombre sur le rond, et « Mes demandes »');
  remettre();
  const m = await page({ width: 390, height: 844 }, { cle: CLE });
  await m.p.waitForSelector('.sgn-fab');
  const badge = await m.p.waitForSelector('.sgn-badge', { state: 'visible', timeout: 5000 });
  ok((await badge.textContent()) === '4', 'le rond porte le nombre de demandes à traiter : question, à relire, 2 pas parties (4)');
  const rb = await badge.boundingBox(), rf = await (await m.p.$('.sgn-fab')).boundingBox();
  ok(rb.x < rf.x + rf.width && rb.x + rb.width > rf.x && rb.y < rf.y + rf.height && rb.y + rb.height > rf.y && rb.x + rb.width <= 390, 'le nombre est posé sur le coin du rond, à l’écran');
  ok(await m.p.evaluate(() => { const f = document.querySelector('.sgn-fab').getBoundingClientRect(); const x = document.elementFromPoint(f.left + f.width / 2, f.top + f.height / 2); return !!(x && x.closest('.sgn-fab')); }), 'le centre du rond reste le bouton qui photographie');
  await badge.click();
  await m.p.waitForSelector('.sgn-carte');
  ok((await texte(m.p, '#sgn-titre')) === 'Mes demandes' && (await m.p.getAttribute('.sgn-filtre[aria-pressed="true"]', 'data-v')) === 'traiter', 'toucher le nombre ouvre la liste filtrée sur « À traiter »');
  ok((await m.p.$$('.sgn-carte')).length === 4 && await m.p.evaluate(() => window.Signaler._etat().captures.length === 0), '4 cartes, et l’écran n’a pas été photographié');
  const puces = await m.p.$$eval('.sgn-filtre', (l) => l.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
  ok(puces.join(' | ') === 'Toutes 9 | À traiter 4 | En cours 2', 'les filtres, sur une rangée : ' + puces.join(' | '));
  await m.p.click('[data-a="filtre"][data-v="cours"]');
  ok((await m.p.$$eval('.sgn-carte .sgn-pil', (l) => l.map((x) => x.textContent))).join() === 'en cours,en cours', '« En cours » : les 2 demandes parties, pas encore revenues');
  await m.p.click('[data-a="filtre"][data-v="toutes"]');
  const cartes = await m.p.$$eval('.sgn-carte', (l) => l.map((c) => ({ id: c.dataset.id, pil: c.querySelector('.sgn-pil').textContent, meta: c.querySelector('.sgn-carte-h').textContent,
    texte: c.querySelector('.sgn-carte-t').textContent, resume: [...c.querySelectorAll('.sgn-carte-r')].map((x) => x.textContent).join(' / '),
    actions: [...c.querySelectorAll('.sgn-actions > *')].map((a) => ({ t: a.textContent, href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel') })) })));
  const ATTENDU = [
    ['a1b2c3d4e5f6', 'question', 'Pupitre', ['Ouvrir dans Claude']],
    ['b2c3d4e5f6a1', 'à relire', 'Home', ['Ouvrir dans Claude', 'Voir la PR']],
    ['c3d4e5f6a1b2', 'pas partie', 'HavroutIA', ['Ouvrir dans Claude', 'Voir la PR', 'Renvoyer']],
    ['d4e5f6a1b2c3', 'en cours', 'Avinou Malkenou', ['Ouvrir dans Claude']],
    ['9f8e7d6c5b4a', 'pas partie', 'Avinou Malkenou', ['Renvoyer']],
    ['e5f6a1b2c3d4', 'en cours', 'KOULAM', []],
    ['f6a1b2c3d4e5', 'rien à faire', new URL(ORIGINE).host, []],
    ['0a1b2c3d4e5f', 'échec', 'Home', []],
    ['1a2b3c4d5e6f', 'en ligne', 'Home', ['Voir le lien']],
  ];
  ok(cartes.map((c) => c.id).join() === ATTENDU.map((a) => a[0]).join(), 'toutes les demandes, la plus récente en haut');
  for (const [id, pil, proj, acts] of ATTENDU) {
    const c = cartes.find((x) => x.id === id) || { actions: [] };
    ok(c.pil === pil && c.meta.endsWith(' · ' + proj) && /\d{1,2} \p{L}+ à \d{2}:\d{2}/u.test(c.meta) && c.actions.map((a) => a.t).join() === acts.join(),
      '« ' + pil + ' » · ' + proj + ' · ' + (acts.join(', ') || 'sans action') + '  (' + c.meta + ')');
  }
  const ext = cartes.flatMap((c) => c.actions.filter((a) => a.href));
  ok(ext.length === 7 && ext.every((a) => a.target === '_blank' && /noopener/.test(a.rel) && /^https:\/\//.test(a.href)), 'les liens s’ouvrent dans un nouvel onglet, rel noopener, https seulement');
  ok(cartes[0].actions[0].href === 'https://claude.ai/code/session_01QUESTION' && cartes[1].actions[1].href === 'https://github.com/770lab/home/pull/42', '« Ouvrir dans Claude » = la session, « Voir la PR » = le premier lien');
  ok(cartes[0].resume.includes('faut-il compter aussi') && cartes[2].resume.includes('statut 503'), 'le résumé de Claude, et pour une demande pas partie, pourquoi');
  ok(cartes[8].texte === '(capture seule, sans texte)', 'une demande sans texte le dit');
  const x5 = cartes.find((c) => c.id === 'e5f6a1b2c3d4');
  ok(x5.texte.startsWith('<img src=x') && !(await m.p.$('.sgn-liste img')) && (await m.p.evaluate(() => window.__xss)) === undefined, 'le texte est affiché tel quel (échappé), une adresse « javascript: » n’est pas un lien');
  const coupe3 = await m.p.$eval('.sgn-carte[data-id="d4e5f6a1b2c3"] .sgn-carte-t', (el) => ({ h: el.getBoundingClientRect().height, l: parseFloat(getComputedStyle(el).lineHeight), plus: el.scrollHeight > el.clientHeight + 1 }));
  ok(coupe3.plus && coupe3.h <= coupe3.l * 3 + 1, 'un long texte tient en 3 lignes (' + Math.round(coupe3.h) + ' px), coupé');
  let pb = await controler(m.p);
  ok(!pb.length, 'mise en page de la liste à 390 px' + (pb.length ? ' : ' + pb.join(' ; ') : ''));
  // « Renvoyer » : une demande déjà repartie ailleurs (409), puis une vraie.
  faux.base.marie.find((x) => x.id === '9f8e7d6c5b4a').etat = 'envoyee';
  let lus = faux.appelsDemandes;
  await m.p.click('.sgn-carte[data-id="9f8e7d6c5b4a"] [data-a="renvoyer"]');
  await m.p.waitForFunction(() => /plus « pas partie »/.test(document.querySelector('.sgn-etat').textContent));
  ok(faux.appelsDemandes > lus && (await texte(m.p, '.sgn-carte[data-id="9f8e7d6c5b4a"] .sgn-pil')) === 'en cours' && faux.renvois.length === 0, 'déjà repartie (409) : on le dit, la liste est relue, rien n’est renvoyé');
  lus = faux.appelsDemandes;
  await m.p.click('.sgn-carte[data-id="c3d4e5f6a1b2"] [data-a="renvoyer"]');
  await m.p.waitForFunction(() => /Renvoyée à Claude/.test(document.querySelector('.sgn-etat').textContent));
  ok(faux.renvois.join() === 'c3d4e5f6a1b2', '« Renvoyer » appelle le relais pour CETTE demande');
  ok(faux.appelsDemandes > lus && (await texte(m.p, '.sgn-carte[data-id="c3d4e5f6a1b2"] .sgn-pil')) === 'en cours' && !(await m.p.$('.sgn-carte[data-id="c3d4e5f6a1b2"] [data-a="renvoyer"]')), 'puis la liste est relue : la demande est « en cours », sans « Renvoyer »');
  ok((await m.p.textContent('.sgn-badge')) === '2' && (await m.p.$$eval('.sgn-filtre', (l) => l.map((x) => x.textContent.replace(/\s+/g, ' ').trim()))).join(' | ') === 'Toutes 9 | À traiter 2 | En cours 4', 'le nombre du rond et les filtres suivent (2 à traiter)');
  lus = faux.appelsDemandes;
  await m.p.click('[data-a="actualiser"]');
  await m.p.waitForFunction(() => /Liste à jour/.test(document.querySelector('.sgn-etat').textContent));
  ok(faux.appelsDemandes === lus + 1, '« Actualiser » relit la liste');
  await m.p.click('[data-a="revenir"]');
  ok(!(await m.p.$('.sgn-boite')), '« Revenir » (liste ouverte par le nombre) referme la fenêtre');
  await m.p.click('.sgn-fab', { position: { x: 24, y: 30 } });
  await m.p.waitForSelector('.sgn-v img', { timeout: 15000 });
  ok((await texte(m.p, '#sgn-titre')) === 'Signaler à Claude', 'toucher le rond (hors du nombre) : la capture puis la fenêtre, comme avant');
  ok(/Mes demandes 2/.test(await texte(m.p, '.sgn-tete [data-a="demandes"]')), 'l’en-tête dit « Mes demandes 2 »');
  await m.p.fill('.sgn-texte', 'Brouillon à garder');
  await m.p.click('.sgn-tete [data-a="demandes"]');
  await m.p.waitForSelector('.sgn-carte');
  ok((await m.p.getAttribute('.sgn-filtre[aria-pressed="true"]', 'data-v')) === 'traiter', 'depuis l’en-tête : la liste, sur « À traiter » puisqu’il y en a');
  await m.p.click('[data-a="revenir"]');
  ok((await texte(m.p, '#sgn-titre')) === 'Signaler à Claude' && (await m.p.inputValue('.sgn-texte')) === 'Brouillon à garder' && (await m.p.$$('.sgn-v img')).length === 1, '« Revenir » ramène au signalement, brouillon et capture gardés');
  await m.p.keyboard.press('Escape');
  await m.p.evaluate(() => window.Signaler.demandes('toutes'));
  await m.p.waitForSelector('.sgn-carte');
  ok((await m.p.getAttribute('.sgn-filtre[aria-pressed="true"]', 'data-v')) === 'toutes', 'Signaler.demandes(\'toutes\') ouvre la liste entière');
  ok(m.erreursPage.length === 0, 'aucune erreur JavaScript');
  await m.ctx.close();

  console.log('6. Sans clé, liste vide, erreurs en clair');
  remettre();
  const s = await page({ width: 390, height: 844 });
  await (await s.p.waitForSelector('.sgn-fab')).click();
  await s.p.waitForSelector('.sgn-v img', { timeout: 15000 });
  lus = faux.appelsDemandes;
  await s.p.click('.sgn-tete [data-a="demandes"]');
  await s.p.waitForSelector('[data-a="voircle"]');
  ok(!!(await s.p.$('.sgn-cle')) && /clé d’équipe/.test(await texte(s.p, '.sgn-boite')) && faux.appelsDemandes === lus, 'sans clé : « Mes demandes » la demande d’abord (même champ), sans appeler le relais');
  await s.p.fill('.sgn-cle', 'trop-courte');
  await s.p.click('[data-a="voircle"]');
  ok(/16 caractères/.test(await texte(s.p, '.sgn-etat')), 'clé trop courte : on le dit');
  await s.p.fill('.sgn-cle', 'cle-inconnue-de-16c');
  await s.p.click('[data-a="voircle"]');
  await s.p.waitForSelector('.sgn-erreur');
  ok(/Clé refusée/.test(await texte(s.p, '.sgn-erreur')) && !!(await s.p.$('.sgn-cle')) && !(await s.p.evaluate(() => localStorage.getItem('signaler_cle_v1'))), 'clé refusée : on le dit, on la redemande, elle n’est pas gardée');
  await capture(s.p, 'w-390-light-cle.png');
  await s.p.fill('.sgn-cle', CLE_PAUL);
  await s.p.press('.sgn-cle', 'Enter');
  await s.p.waitForFunction(() => /Aucune demande/.test((document.querySelector('.sgn-vide') || {}).textContent || ''), null, { timeout: 5000 }).catch(() => {});
  ok((await texte(s.p, '.sgn-vide')) === 'Aucune demande pour l’instant.' && (await s.p.evaluate(() => localStorage.getItem('signaler_cle_v1'))) === CLE_PAUL, 'bonne clé (Entrée) : gardée, et liste vide « Aucune demande pour l’instant. »');
  for (const [mode, rx, dit] of [['sans-stockage', /n’a pas de stockage/, 'relais sans stockage'], ['injoignable', /injoignable/, 'relais injoignable'],
    ['interdit', /Page non autorisée/, 'page non autorisée (403)'], ['erreur', /erreur \(stockage en panne, statut 500\)/, 'erreur du relais (500)']]) {
    faux.demandes = mode;
    await s.p.click('[data-a="actualiser"]');
    await s.p.waitForFunction((t) => new RegExp(t).test(document.querySelector('.sgn-boite').textContent), rx.source, { timeout: 5000 }).catch(() => {});
    ok(rx.test(await texte(s.p, '.sgn-boite')), dit + ' : ' + (await texte(s.p, '.sgn-erreur, .sgn-vide')).slice(0, 110));
    if (mode === 'injoignable') {
      ok(/Dernière liste reçue à \d{2}:\d{2} \(peut-être plus à jour\)/.test(await texte(s.p, '.sgn-boite')), 'relais injoignable : la liste montrée est l’ancienne, et on dit de quand elle date');
      await capture(s.p, 'w-390-light-injoignable.png');
    }
    faux.demandes = 'normal';
    await s.p.click('[data-a="actualiser"]');
    await s.p.waitForFunction(() => !document.querySelector('.sgn-erreur'), null, { timeout: 5000 }).catch(() => {});
  }
  ok(!(await s.p.$('.sgn-erreur')), 'une fois le relais revenu, l’erreur s’efface');
  ok(s.erreursPage.length === 0, 'aucune erreur JavaScript');
  await s.ctx.close();

  console.log('7. Mise en page : 360, 412, 768, 1280 px, clair et sombre');
  for (const [w, ht] of [[360, 780], [412, 915], [768, 1024], [1280, 900]]) {
    for (const theme of ['light', 'dark']) {
      remettre();
      const x = await page({ width: w, height: ht }, { cle: CLE, theme });
      await x.p.waitForSelector('.sgn-badge', { state: 'visible', timeout: 5000 });
      const nom = 'w-' + w + '-' + theme;
      let pbs = await controler(x.p);
      await x.p.click('.sgn-badge');
      await x.p.waitForSelector('.sgn-carte');
      await x.p.click('[data-a="filtre"][data-v="toutes"]');
      pbs = pbs.concat(await controler(x.p));
      const fondBoite = await x.p.$eval('.sgn-boite', (el) => getComputedStyle(el).backgroundColor);
      ok(theme === 'dark' ? fondBoite === 'rgb(15, 23, 42)' : fondBoite === 'rgb(255, 255, 255)', nom + ' : la fenêtre est ' + (theme === 'dark' ? 'sombre' : 'claire') + ' (' + fondBoite + ')');
      await capture(x.p, nom + '-demandes.png');
      await x.p.$eval('.sgn-boite', (el) => { el.scrollTop = el.scrollHeight; });
      await capture(x.p, nom + '-demandes-bas.png');
      // Les demandes d'UN projet (le pupitre, ligne « Home ») : la puce du projet, seule sur sa ligne au-dessus des filtres.
      await x.p.evaluate(() => window.Signaler.demandes({ projet: 'home', etat: 'toutes' }));
      await x.p.waitForFunction(() => document.querySelector('.sgn-puce') && document.querySelectorAll('.sgn-carte').length === 3, null, { timeout: 5000 });
      pbs = pbs.concat(await controler(x.p));
      await capture(x.p, nom + '-projet.png');
      await x.p.keyboard.press('Escape');
      await x.p.click('.sgn-fab', { position: { x: 24, y: 30 } });
      await x.p.waitForSelector('.sgn-v img', { timeout: 15000 });
      pbs = pbs.concat(await controler(x.p));
      await capture(x.p, nom + '-signaler.png');
      await x.p.keyboard.press('Escape');
      await capture(x.p, nom + '-bouton.png');
      ok(!pbs.length && !x.erreursPage.length, nom + ' : rien ne déborde, pas plus de 3 boutons par rangée, ni italique ni émoji' + (pbs.length ? ' — ' + [...new Set(pbs)].join(' ; ') : '') + (x.erreursPage.length ? ' — ' + x.erreursPage.join(' ; ') : ''));
      if (w === 360 && theme === 'light') {
        // Le contrôle lui-même : il doit voir une rangée de 4 boutons, un élément qui dépasse et de l'italique.
        await x.p.click('.sgn-fab', { position: { x: 24, y: 30 } });
        await x.p.waitForSelector('.sgn-boite');
        await x.p.$eval('.sgn-boite', (b) => b.insertAdjacentHTML('beforeend', '<div id="essai"><button>A</button> <button>B</button> <button>C</button> <button>D</button>'
          + '<div style="width:900px">large</div><span style="font-style:italic">penché</span></div>'));
        const vus = await controler(x.p);
        ok(vus.some((v) => /plus de 3 boutons/.test(v)) && vus.some((v) => /dépasse de la fenêtre/.test(v)) && vus.some((v) => /italique/.test(v)), 'le contrôle de mise en page voit bien ce qu’il cherche (4 boutons, débordement, italique)');
      }
      await x.ctx.close();
    }
  }
  console.log('8. Page absente des ORIGINES, relais pas à jour, relais éteint : on dit lequel (pas « injoignable » pour tout)');
  const LOCALE = 'http://localhost:' + site.address().port;   // le même site sous une autre adresse : absente des ORIGINES
  const eteint = http.createServer(); await new Promise((r) => eteint.listen(0, '127.0.0.1', r));
  const RELAIS_ETEINT = 'http://127.0.0.1:' + eteint.address().port; await new Promise((r) => eteint.close(r));
  const erreurListe = async (q) => {
    await q.p.evaluate(() => window.Signaler.demandes());
    await q.p.waitForSelector('.sgn-erreur', { timeout: 12000 });
    return texte(q.p, '.sgn-erreur');
  };
  const essaiEnvoi = async (q) => {
    await q.p.click('.sgn-fab', { position: { x: 24, y: 30 } });
    await q.p.waitForSelector('.sgn-v img', { timeout: 15000 });
    const avant = await texte(q.p, '.sgn-etat');
    await q.p.fill('.sgn-texte', 'Essai depuis une page refusée');
    await q.p.click('.sgn-envoyer');
    await q.p.waitForFunction(() => /^Pas envoyé/.test(document.querySelector('.sgn-etat').textContent), null, { timeout: 15000 });
    return { avant, apres: await texte(q.p, '.sgn-etat'), garde: (await q.p.inputValue('.sgn-texte')) === 'Essai depuis une page refusée' };
  };
  const CAS = [
    { dit: 'relais qui dit « origine: false » (GET /etat lisible de partout)', theme: 'light', o: { origine: LOCALE }, regle: () => { faux.etatOuvert = true; },
      liste: /^Page non autorisée : ce site n’est pas dans la liste du relais \(ORIGINES\)\.$/, avant: /^Cette page n’est pas autorisée par le relais/, envoi: /^Pas envoyé : page non autorisée/ },
    { dit: 'relais du contrat (pas de CORS pour une page refusée)', theme: 'dark', o: { origine: LOCALE }, regle: () => {},
      liste: /pas à cette page : il n’est sans doute pas encore à jour pour « Mes demandes » \(à redéployer\), ou l’adresse de cette page n’est pas dans sa liste \(ORIGINES\)/, avant: /^$/, envoi: /^Pas envoyé : le relais refuse cette page/ },
    { dit: 'vieux relais, d’avant « Mes demandes » (404 sans CORS)', theme: 'light', o: {}, regle: () => { faux.etat = 'absent'; faux.demandes = 'absent'; },
      liste: /il n’est sans doute pas encore à jour pour « Mes demandes » \(à redéployer\)/ },
    { dit: 'relais éteint', theme: 'dark', o: { relais: RELAIS_ETEINT }, regle: () => {},
      liste: /^Le relais est injoignable/, avant: /^$/, envoi: /^Pas envoyé : le relais ne répond pas/ },
  ];
  for (const [i, c] of CAS.entries()) {
    remettre(); c.regle();
    const q = await page({ width: 360, height: 780 }, Object.assign({ cle: CLE, theme: c.theme }, c.o));
    ok(!!(await q.p.waitForSelector('.sgn-fab', { timeout: 6000 }).catch(() => null)), c.dit + ' : le rond apparaît (il n’est pas coupé)');
    await q.p.waitForTimeout(800);
    ok(!(await q.p.isVisible('.sgn-badge')), c.dit + ' : pas de nombre sur le rond (la liste n’a pas pu être lue)');
    const msg = await erreurListe(q);
    ok(c.liste.test(msg), c.dit + ' : « ' + msg + ' »');
    const pbs = await controler(q.p);
    ok(!pbs.length, c.dit + ' : mise en page à 360 px' + (pbs.length ? ' : ' + pbs.join(' ; ') : ''));
    await capture(q.p, 'w-360-' + c.theme + '-erreur-' + (i + 1) + '.png');
    await q.p.keyboard.press('Escape');
    if (c.envoi) {
      const n0 = appels.length, r = await essaiEnvoi(q);
      ok(c.avant.test(r.avant), c.dit + ' : avant l’envoi, ' + (r.avant ? '« ' + r.avant + ' »' : 'rien de signalé'));
      ok(c.envoi.test(r.apres) && r.garde && appels.length === n0, c.dit + ' : « ' + r.apres + ' » (message gardé, rien n’est parti)');
      const pbs2 = await controler(q.p);
      ok(!pbs2.length, c.dit + ' : mise en page de la fenêtre à 360 px' + (pbs2.length ? ' : ' + pbs2.join(' ; ') : ''));
      await capture(q.p, 'w-360-' + c.theme + '-erreur-' + (i + 1) + '-envoi.png');
    }
    ok(q.erreursPage.length === 0, c.dit + ' : aucune erreur JavaScript');
    await q.ctx.close();
  }
  console.log('9. Un interrupteur par projet (GET /etat?projet=), et les demandes d’un projet');
  const SUR = { home: [LAB, '/home/'], pupitre: [LAB, '/home/robots.html'], havroutia: [LAB, '/havroutia/'], aucun: [ORIGINE, '/demo/index.html'] };
  // Ouvre la page, attend que le bouton ait lu l'interrupteur, et dit si le rond paraît et quel projet il a demandé.
  const essai = async (ou, o = {}) => {
    const n = faux.requetesEtat.length;
    const q = await page({ width: 412, height: 915 }, Object.assign({ origine: SUR[ou][0], chemin: SUR[ou][1] }, o));
    for (let i = 0; i < 40 && faux.requetesEtat.length === n; i++) await attendre(50);
    await q.p.waitForTimeout(700);
    return { q, rond: !!(await q.p.$('.sgn-fab')), demandes: faux.requetesEtat.slice(n) };
  };
  remettre();
  let q0 = await page({ width: 412, height: 915 });
  const regle = await q0.p.evaluate(() => {
    const S = window.Signaler, r = {};
    for (const u of ['https://770lab.com/home/robots.html', 'https://770lab.com/home/robots', 'https://770lab.com/home/', 'https://770lab.com/home',
      'https://www.770lab.com/HOME/journal', 'https://770lab.com/havroutia/recherche', 'https://avinou-malkenou.web.app/cartes', 'https://koulam.app/tehilim',
      'https://770lab.com/', 'https://770lab.com/autre', 'https://exemple.fr/home/', 'pas une adresse', '']) r[u] = S.projetDeLaPage(u);
    return { r, projets: S.projets.map((p) => p.id + '=' + p.nom).join(',') };
  });
  const REGLE = { 'https://770lab.com/home/robots.html': 'pupitre', 'https://770lab.com/home/robots': 'pupitre', 'https://770lab.com/home/': 'home', 'https://770lab.com/home': 'home',
    'https://www.770lab.com/HOME/journal': 'home', 'https://770lab.com/havroutia/recherche': 'havroutia', 'https://avinou-malkenou.web.app/cartes': 'avinou',
    'https://koulam.app/tehilim': 'koulam', 'https://770lab.com/': null, 'https://770lab.com/autre': null, 'https://exemple.fr/home/': null, 'pas une adresse': null, '': null };
  const fausses = Object.keys(REGLE).filter((u) => regle.r[u] !== REGLE[u]);
  ok(!fausses.length, 'Signaler.projetDeLaPage : le projet d’une adresse, comme le relais' + (fausses.length ? ' — faux : ' + fausses.map((u) => u + ' → ' + regle.r[u]).join(' ; ') : ''));
  ok(regle.projets === 'home=Home,pupitre=Pupitre,havroutia=HavroutIA,avinou=Avinou Malkenou,koulam=KOULAM', 'Signaler.projets : les 5 projets, dans l’ordre du pupitre');
  await q0.ctx.close();

  remettre(); faux.projets.home = false;
  let r9 = await essai('home');
  ok(!r9.rond && r9.demandes.join() === 'home', 'Home coupé : sur 770lab.com/home/, le bouton demande GET /etat?projet=home et le rond ne paraît pas');
  await capture(r9.q.p, 'projet-home-coupe.png');
  // Rallumé depuis le pupitre : Signaler.montrer() (Home, après la connexion) le fait revenir sans recharger la page.
  faux.projets.home = true;
  await r9.q.p.evaluate(() => window.Signaler.montrer());
  ok(!!(await r9.q.p.waitForSelector('.sgn-fab', { timeout: 3000 }).catch(() => null)) && faux.requetesEtat.slice(-1)[0] === 'home', 'Home rallumé : Signaler.montrer() redemande ?projet=home, le rond revient');
  ok(!r9.q.erreursPage.length, 'aucune erreur JavaScript');
  await r9.q.ctx.close();
  faux.projets.home = false;
  for (const [ou, dit] of [['pupitre', '770lab.com/home/robots.html (le pupitre)'], ['havroutia', '770lab.com/havroutia/ (HavroutIA)']]) {
    r9 = await essai(ou);
    ok(r9.rond && r9.demandes.join() === ou, 'Home coupé : sur ' + dit + ', GET /etat?projet=' + ou + ', le rond paraît');
    if (ou === 'pupitre') await capture(r9.q.p, 'projet-pupitre-allume.png');
    await r9.q.ctx.close();
  }
  r9 = await essai('aucun');
  ok(r9.rond && r9.demandes.length === 1 && r9.demandes[0] === null, 'Home coupé : une page d’aucun projet demande GET /etat (sans ?projet=), le rond paraît');
  await r9.q.ctx.close();
  r9 = await essai('aucun', { projet: 'avinou' });
  ok(r9.rond && r9.demandes.join() === 'avinou', 'SignalerConfig.projet = avinou (page sans projet d’après son adresse) : GET /etat?projet=avinou, le rond paraît');
  await r9.q.ctx.close();
  // Le réglage de la page l'emporte sur l'adresse.
  r9 = await essai('home', { projet: 'havroutia' });
  ok(r9.rond && r9.demandes.join() === 'havroutia', 'SignalerConfig.projet = havroutia sur 770lab.com/home/ (Home coupé) : c’est le réglage qui compte, le rond paraît');
  await r9.q.ctx.close();
  r9 = await essai('havroutia', { dataProjet: 'home' });
  ok(!r9.rond && r9.demandes.join() === 'home', 'data-projet="home" sur 770lab.com/havroutia/ (Home coupé) : l’attribut l’emporte sur l’adresse, le rond ne paraît pas');
  await r9.q.ctx.close();
  r9 = await essai('aucun', { dataProjet: 'home', projet: 'havroutia' });
  ok(!r9.rond && r9.demandes.join() === 'home', 'data-projet="home" et SignalerConfig.projet = havroutia : data-projet l’emporte (comme les autres réglages)');
  await r9.q.ctx.close();

  // Le général coupé : tout est caché, quel que soit le projet.
  remettre(); faux.etat = 'off';
  const caches = [];
  for (const ou of ['home', 'pupitre', 'havroutia', 'aucun']) { r9 = await essai(ou); if (r9.rond) caches.push(ou); await r9.q.ctx.close(); }
  ok(!caches.length, 'interrupteur général coupé (projets allumés) : le rond ne paraît nulle part' + (caches.length ? ' — visible : ' + caches.join(', ') : ''));
  // Un projet que le relais ne connaît pas (400) : le bouton lit au moins le général.
  for (const [g, rond] of [['on', true], ['off', false]]) {
    remettre(); faux.etat = g;
    r9 = await essai('aucun', { dataProjet: 'inconnu' });
    ok(r9.rond === rond && r9.demandes.join() === 'inconnu,', 'projet inconnu du relais (400), général ' + (g === 'on' ? 'activé' : 'coupé') + ' : GET /etat sans projet, le rond ' + (rond ? 'paraît' : 'ne paraît pas'));
    await r9.q.ctx.close();
  }
  // Un relais d'avant les projets : il ne lit pas ?projet=, son « actif » (le général) décide.
  for (const [g, rond] of [['on', true], ['off', false]]) {
    remettre(); faux.etatVieux = true; faux.etat = g;
    r9 = await essai('home');
    ok(r9.rond === rond, 'relais d’avant les projets, actif: ' + (g === 'on') + ' : le rond ' + (rond ? 'paraît' : 'ne paraît pas') + ' sur Home');
    await r9.q.ctx.close();
  }
  // Coupé pendant que la page est ouverte : le relais refuse l'envoi (« coupe »), le rond disparaît.
  remettre();
  r9 = await essai('home', { cle: CLE });
  await r9.q.p.click('.sgn-fab', { position: { x: 24, y: 30 } });
  await r9.q.p.waitForSelector('.sgn-v img', { timeout: 15000 });
  faux.projets.home = false;
  await r9.q.p.fill('.sgn-texte', 'Essai pendant la coupure de Home');
  const n9 = appels.length;
  await r9.q.p.click('.sgn-envoyer');
  await r9.q.p.waitForSelector('.sgn-etat.ko', { timeout: 15000 });
  ok((await texte(r9.q.p, '.sgn-etat')) === 'Le bouton est coupé depuis le pupitre.' && !(await r9.q.p.$('.sgn-fab')) && appels.length === n9, 'Home coupé pendant que la page est ouverte : l’envoi est refusé, on le dit, le rond disparaît');
  await r9.q.p.keyboard.press('Escape');
  await r9.q.p.evaluate(() => window.Signaler.montrer());
  await r9.q.p.waitForTimeout(1200);
  ok(!(await r9.q.p.$('.sgn-fab')) && faux.requetesEtat.slice(-1)[0] === 'home', 'toujours coupé : Signaler.montrer() redemande ?projet=home et le rond reste caché');
  ok(!r9.q.erreursPage.length, 'aucune erreur JavaScript');
  await r9.q.ctx.close();

  // Les demandes d'un projet : Signaler.demandes({ projet }) (le pupitre, une ligne par projet).
  remettre();
  // Une demande récente porte son projet (champ « projet » du relais) : il l'emporte sur l'adresse de sa page.
  faux.base.marie.push({ id: '2b3c4d5e6f7a', qui: 'marie', type: 'idee', etat: 'rien', texte: 'Une idée pour la recherche.', projet: 'havroutia',
    page: { url: ORIGINE + '/demo/index.html', titre: 'Démo' }, captures: 0, audio: false, creeLeMs: T0 - 2000 * 60000, majLeMs: T0 - 1999 * 60000, resume: 'Rien à faire.' });
  const pr = await page({ width: 360, height: 780 }, { cle: CLE, init: () => {
    window.__comptes = [];
    window.addEventListener('signaler:demandes', (e) => window.__comptes.push(e.detail));
  } });
  await pr.p.waitForSelector('.sgn-badge', { state: 'visible', timeout: 5000 });
  const det = await pr.p.evaluate(() => window.__comptes.slice(-1)[0]);
  const parProjet = det && det.projets ? PROJETS.map((id) => id + ' ' + det.projets[id].aTraiter + '/' + det.projets[id].total).join(', ') : '';
  ok(det && det.aTraiter === 4 && det.total === 10 && parProjet === 'home 1/3, pupitre 1/1, havroutia 1/2, avinou 1/2, koulam 0/1',
    'l’événement « signaler:demandes » compte aussi par projet (à traiter / en tout) : ' + parProjet);
  const puceEtFiltres = async () => pr.p.evaluate(() => {
    const pc = document.querySelector('.sgn-puce'), f = document.querySelector('.sgn-filtres');
    return { puce: pc ? pc.textContent.replace(/\s+/g, ' ').trim() : '', dessus: !!(pc && f && pc.getBoundingClientRect().bottom <= f.getBoundingClientRect().top),
      filtres: [...document.querySelectorAll('.sgn-filtre')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()).join(' | '),
      actif: (document.querySelector('.sgn-filtre[aria-pressed="true"]') || {}).dataset?.v || '',
      cartes: [...document.querySelectorAll('.sgn-carte')].map((c) => c.dataset.id + ' ' + c.querySelector('.sgn-carte-h').textContent.split(' · ').pop()) };
  });
  await pr.p.evaluate(() => window.Signaler.demandes({ projet: 'home' }));
  await pr.p.waitForSelector('.sgn-carte');
  let v9 = await puceEtFiltres();
  ok(v9.puce === 'Projet : Home ×' && v9.dessus, 'Signaler.demandes({ projet: \'home\' }) : la puce « ' + v9.puce + ' », au-dessus des filtres');
  ok(v9.filtres === 'Toutes 3 | À traiter 1 | En cours 0' && v9.actif === 'traiter' && v9.cartes.join() === 'b2c3d4e5f6a1 Home', 'les filtres comptent ce projet seulement (' + v9.filtres + '), sur « À traiter » puisqu’il y en a');
  let pb9 = await controler(pr.p);
  ok(!pb9.length, 'mise en page à 360 px avec la puce du projet' + (pb9.length ? ' : ' + pb9.join(' ; ') : ''));
  await capture(pr.p, 'w-360-light-projet-traiter.png');
  await pr.p.evaluate(() => window.Signaler.demandes({ projet: 'home', etat: 'toutes' }));
  await pr.p.waitForFunction(() => document.querySelectorAll('.sgn-carte').length === 3);
  v9 = await puceEtFiltres();
  ok(v9.actif === 'toutes' && v9.cartes.join() === 'b2c3d4e5f6a1 Home,0a1b2c3d4e5f Home,1a2b3c4d5e6f Home', '{ projet: \'home\', etat: \'toutes\' } : les 3 demandes de Home');
  await pr.p.click('.sgn-puce');
  v9 = await puceEtFiltres();
  ok(!v9.puce && v9.filtres === 'Toutes 10 | À traiter 4 | En cours 2' && v9.cartes.length === 10, 'toucher la puce la retire : toutes les demandes de tous les projets (' + v9.filtres + ')');
  ok(await pr.p.evaluate(() => document.activeElement && document.activeElement.matches('.sgn-filtre[aria-pressed="true"]')), 'le focus passe sur le filtre choisi');
  await pr.p.evaluate(() => window.Signaler.demandes({ projet: 'havroutia', etat: 'toutes' }));
  await pr.p.waitForFunction(() => document.querySelectorAll('.sgn-carte').length === 2);
  v9 = await puceEtFiltres();
  ok(v9.puce === 'Projet : HavroutIA ×' && v9.cartes.join() === 'c3d4e5f6a1b2 HavroutIA,2b3c4d5e6f7a HavroutIA', 'HavroutIA : la demande de sa page, et celle dont le champ « projet » le dit (même faite ailleurs)');
  await pr.p.evaluate(() => window.Signaler.demandes({ projet: 'KOULAM', etat: 'cours' }));
  await pr.p.waitForFunction(() => /KOULAM/.test((document.querySelector('.sgn-puce') || {}).textContent || ''));
  v9 = await puceEtFiltres();
  ok(v9.puce === 'Projet : KOULAM ×' && v9.actif === 'cours' && v9.cartes.join() === 'e5f6a1b2c3d4 KOULAM', 'KOULAM (id en capitales accepté), « En cours » : sa demande d’avant, d’après l’adresse koulam.app');
  await pr.p.evaluate(() => window.Signaler.demandes({ projet: 'zzz' }));
  await pr.p.waitForFunction(() => /zzz/.test((document.querySelector('.sgn-puce') || {}).textContent || ''));
  ok((await texte(pr.p, '.sgn-vide')) === 'Aucune demande pour ce projet.' && !(await pr.p.$('.sgn-filtres')), 'un projet sans demande : « Aucune demande pour ce projet. », la puce pour revenir à tous');
  pb9 = await controler(pr.p);
  ok(!pb9.length, 'mise en page à 360 px, projet sans demande' + (pb9.length ? ' : ' + pb9.join(' ; ') : ''));
  await capture(pr.p, 'w-360-light-projet-vide.png');
  await pr.p.click('.sgn-puce');
  ok(!(await pr.p.$('.sgn-puce')) && (await pr.p.$$('.sgn-carte')).length > 0, 'la puce retirée, la liste de tous revient');
  await pr.p.keyboard.press('Escape');
  // Le nombre du rond compte tout ; la liste ouverte par lui (ou par « Mes demandes ») n'a pas de filtre de projet.
  await pr.p.evaluate(() => window.Signaler.demandes({ projet: 'home' }));
  await pr.p.waitForSelector('.sgn-puce');
  await pr.p.keyboard.press('Escape');
  await pr.p.click('.sgn-badge');
  await pr.p.waitForSelector('.sgn-carte');
  ok((await pr.p.textContent('.sgn-badge')) === '4' && !(await pr.p.$('.sgn-puce')) && (await pr.p.$$('.sgn-carte')).length === 4, 'le nombre du rond compte tous les projets (4), et ouvre la liste sans filtre de projet');
  await pr.p.keyboard.press('Escape');
  await pr.p.evaluate(() => window.Signaler.demandes('toutes'));
  await pr.p.waitForSelector('.sgn-carte');
  ok(!(await pr.p.$('.sgn-puce')), 'Signaler.demandes(\'toutes\') (le pupitre d’avant) : sans puce, comme avant');
  ok(!pr.erreursPage.length, 'aucune erreur JavaScript');
  await pr.ctx.close();
  console.log('10. Le rond déplacé, la photo, le dessin, plusieurs écrans, la boîte noire, le point rouge (360 → 1280, clair = doigt, sombre = souris)');
  // Le doigt passe par le protocole de Chrome (Playwright ne sait que « tap ») : de vrais pointerdown / move / up de type touch.
  const cdps = new WeakMap();
  const doigt = async (p, type, x, y) => {
    if (!cdps.has(p)) cdps.set(p, await p.context().newCDPSession(p));
    await cdps.get(p).send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: Math.round(x), y: Math.round(y) }] });
  };
  const toucherEl = (p, toucher, sel) => (toucher ? p.tap(sel) : p.click(sel));
  // Un geste qui suit des points ; attente : avant de bouger (appui long) ; auMilieu : appelé pendant l'appui, avant de bouger.
  async function geste(p, toucher, pts, o = {}) {
    const [x0, y0] = pts[0];
    if (toucher) await doigt(p, 'touchStart', x0, y0); else { await p.mouse.move(x0, y0); await p.mouse.down(); }
    if (o.auMilieu) { await attendre(140); await o.auMilieu(); }
    if (o.attente) await attendre(Math.max(0, o.attente - (o.auMilieu ? 140 : 0)));
    // À la vitesse d'une main (une image sur 60), et le doigt s'arrête avant de se lever : sinon Chrome y voit un « lancer »
    // et écarte le toucher suivant (il le prend pour l'arrêt du lancer).
    for (const [x, y] of pts.slice(1)) { if (toucher) { await doigt(p, 'touchMove', x, y); await attendre(16); } else await p.mouse.move(x, y); }
    if (toucher) { await attendre(150); await doigt(p, 'touchEnd'); await attendre(300); } else await p.mouse.up();
  }
  const ligne = (a, b, n) => Array.from({ length: n + 1 }, (_, i) => [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]);
  const ellipse = (cx, cy, rx, ry, n = 28) => Array.from({ length: n + 1 }, (_, i) => [cx + rx * Math.cos(2 * Math.PI * i / n), cy + ry * Math.sin(2 * Math.PI * i / n)]);
  const boite = (p, sel) => p.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });
  const brouillonGarde = (p) => p.evaluate(() => { try { const o = JSON.parse(sessionStorage.getItem('signaler_brouillon_v1') || 'null'); return o ? { n: o.captures.length, texte: o.texte, traits: o.captures.map((c) => c.traits.length), attente: o.attente } : null; } catch (e) { return 'illisible'; } });
  const pastille = (p) => p.evaluate(() => { const f = document.querySelector('.sgn-fab'), x = f && f.querySelector('.sgn-pastille'); return f && f.classList.contains('sgn-attente') && getComputedStyle(x).display !== 'none' ? x.textContent : ''; });
  const bulleVue = (p) => p.evaluate(() => { const b = document.querySelector('.sgn-bulle'); return b && getComputedStyle(b).display !== 'none' ? [...b.querySelectorAll('p, button')].map((x) => x.textContent.trim()).join(' | ') : ''; });
  const ouvrirAvecPhoto = async (p, toucher, n) => {
    await toucherEl(p, toucher, '.sgn-fab');
    await p.waitForFunction((k) => document.querySelector('.sgn-toile canvas') && window.Signaler._etat().captures.length === k, n, { timeout: 20000 });
  };
  const SECRET_TEXTE = 'secret-texte-123', SECRET_MDP = 'MotDePasse-Secret-456', ERREUR_DEMO = 'Le calcul du total a planté (démo)';
  for (const [w, ht] of [[360, 780], [412, 915], [768, 1024], [1280, 900]]) {
    for (const theme of ['light', 'dark']) {
      const toucher = theme === 'light', nom = 'rond-' + w + '-' + theme, dit = w + ' px ' + (toucher ? 'au doigt' : 'à la souris') + ' (' + (theme === 'light' ? 'clair' : 'sombre') + ')';
      remettre();
      const x = await page({ width: w, height: ht }, { cle: CLE, theme, toucher });
      const p = x.p;
      await p.waitForSelector('.sgn-badge', { state: 'visible', timeout: 5000 });
      let pbs = [];
      // a) Le point rouge : une vraie erreur, une fois ; « Ignorer » l'éteint ; la même erreur ne revient pas.
      await toucherEl(p, toucher, '#lancer-erreur');
      await p.waitForSelector('.sgn-bulle', { state: 'visible', timeout: 3000 });
      const a1 = await p.evaluate(() => ({ point: getComputedStyle(document.querySelector('.sgn-point')).display !== 'none', label: document.querySelector('.sgn-fab').getAttribute('aria-label') }));
      ok(a1.point && (await bulleVue(p)) === 'Un problème vient d’arriver sur cette page. Le signaler ? | Signaler | Ignorer' && /Un problème vient d’arriver/.test(a1.label), dit + ' : une erreur de la page allume le point rouge et la bulle « Le signaler ? »');
      pbs = pbs.concat(await controler(p));
      const bb1 = await boite(p, '.sgn-bulle'), fb1 = await boite(p, '.sgn-fab');
      ok(bb1.y + bb1.h <= fb1.y && bb1.x >= 0 && bb1.x + bb1.w <= w, dit + ' : la bulle est juste au-dessus du rond, à l’écran');
      await p.waitForTimeout(300);   // la bulle entre en fondu (0,18 s)
      await capture(p, nom + '-alerte.png');
      await toucherEl(p, toucher, '.sgn-bulle [data-a="b-ignorer"]');
      ok(!(await bulleVue(p)) && !(await p.evaluate(() => document.querySelector('.sgn-fab').classList.contains('sgn-alerte'))), dit + ' : « Ignorer » ferme la bulle et éteint le point');
      await toucherEl(p, toucher, '#lancer-erreur');
      await p.evaluate(() => { const x = new XMLHttpRequest(); x.open('GET', '/api/panne-xhr?jeton=xhr-secret'); x.send(); });
      await p.waitForSelector('.sgn-bulle', { state: 'visible', timeout: 3000 });
      ok(true, dit + ' : la même erreur une seconde fois ne rallume rien ; une requête XMLHttpRequest en 503 (autre problème) rallume la bulle');
      await toucherEl(p, toucher, '.sgn-bulle [data-a="b-ignorer"]');
      // b) La boîte noire : deux champs (texte, mot de passe), une requête 404, une ancre, un défilement.
      await p.fill('#champ-nom', SECRET_TEXTE);
      await p.focus('#champ-mdp'); await p.keyboard.type(SECRET_MDP);
      await p.evaluate(() => fetch('/api/absent?cle=zzz').then(() => {}, () => {}));
      await toucherEl(p, toucher, '#vers-bas');
      await p.waitForTimeout(500);
      await p.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); window.scrollTo(0, 0); });
      await p.waitForTimeout(500);
      ok(!(await bulleVue(p)), dit + ' : une requête en 404 n’allume rien (seulement 5xx et réseau)');
      // c) Déplacer le rond : appui long 0,45 s puis glisser ; il s'enfonce dès l'appui ; ce n'est pas un toucher.
      const f0 = await boite(p, '.sgn-fab'), but = [12 + 24 + 30, Math.round(ht * 0.62)];
      let enfonce = 1;
      await geste(p, toucher, ligne([f0.cx, f0.cy], but, 14), { attente: 450, auMilieu: async () => { enfonce = await p.$eval('.sgn-fab', (e) => new DOMMatrix(getComputedStyle(e).transform).a); } });
      await p.waitForTimeout(250);
      const f1 = await boite(p, '.sgn-fab'), b1 = await boite(p, '.sgn-badge');
      const pos = await p.evaluate(() => { try { return JSON.parse(localStorage.getItem('signaler_pos_v1') || '{}')[location.origin + location.pathname] || null; } catch (e) { return null; } });
      ok(enfonce < 0.95, dit + ' : à l’appui, le rond s’enfonce (échelle ' + enfonce.toFixed(2) + ')');
      ok(Math.abs(f1.cx - but[0]) <= 2 && Math.abs(f1.cy - but[1]) <= 2 && await p.$eval('.sgn-fab', (e) => e.classList.contains('sgn-deplace')), dit + ' : appui long puis glisser, le rond suit (' + Math.round(f1.cx) + ', ' + Math.round(f1.cy) + ')');
      ok(!(await p.$('.sgn-boite')) && (await p.evaluate(() => window.Signaler._etat().captures.length)) === 0, dit + ' : le déplacer n’ouvre pas la fenêtre et ne photographie rien');
      ok(b1.x < f1.x + f1.w + 10 && b1.x + b1.w > f1.x + f1.w - 14 && b1.y < f1.y && b1.y + b1.h > f1.y, dit + ' : le nombre rouge suit le rond (son coin haut droit)');
      ok(pos && pos.x >= 0 && pos.x <= 1 && pos.y >= 0 && pos.y <= 1, dit + ' : la place est gardée pour cette page, en proportion (' + (pos ? pos.x + ', ' + pos.y : 'rien') + ')');
      pbs = pbs.concat(await controler(p));
      await capture(p, nom + '-deplace.png');
      // Glissé hors de l'écran : il reste dedans, loin des bords.
      const f2 = await boite(p, '.sgn-fab');
      await geste(p, toucher, ligne([f2.cx, f2.cy], [w + 60, -60], 10), { attente: 450 });
      await p.waitForTimeout(250);
      const f3 = await boite(p, '.sgn-fab');
      ok(f3.x + f3.w <= w - 11 && f3.y >= 15, dit + ' : tiré hors de l’écran, il s’arrête à 12 px du bord (' + Math.round(w - f3.x - f3.w) + ' px, haut ' + Math.round(f3.y) + ' px)');
      await geste(p, toucher, ligne([f3.cx, f3.cy], but, 10), { attente: 450 });
      await p.waitForTimeout(250);
      // d) Une requête en échec (500) : la bulle ; « Signaler » photographie l'écran (l'anneau tourne pendant ce temps) puis ouvre la fenêtre.
      await toucherEl(p, toucher, '#requete-ko');
      await p.waitForSelector('.sgn-bulle', { state: 'visible', timeout: 3000 });
      const bb2 = await boite(p, '.sgn-bulle'), fb2 = await boite(p, '.sgn-fab');
      ok(bb2.y + bb2.h <= fb2.y && Math.abs(bb2.x - fb2.x) <= 1, dit + ' : une requête en 500 rallume la bulle, posée au-dessus du rond déplacé');
      // Le haut de la page à l'écran (toucher le bouton l'a fait défiler) : « Enregistrer » sera sur la photo.
      await p.evaluate(() => window.scrollTo(0, 0));
      await p.waitForTimeout(400);
      await p.evaluate(() => { window.__h2cDelai = 1500; });
      await toucherEl(p, toucher, '.sgn-bulle [data-a="b-signaler"]');
      await p.waitForSelector('.sgn-fab.sgn-occupe', { timeout: 3000 });
      await p.waitForTimeout(450);
      const anim = await p.evaluate(() => {
        const f = document.querySelector('.sgn-fab'), st = (s) => getComputedStyle(f.querySelector(s));
        return { occupe: f.classList.contains('sgn-occupe'), anneau: st('.sgn-anneau').opacity + ' ' + st('.sgn-anneau').animationName, onde: st('.sgn-onde').animationName,
          etoile: st('.sgn-etoile').animationName, fenetre: !!document.querySelector('.sgn-boite'), bulle: !!document.querySelector('.sgn-bulle') && getComputedStyle(document.querySelector('.sgn-bulle')).display !== 'none' };
      });
      ok(anim.occupe && anim.anneau === '1 sgn-tourne' && anim.onde === 'sgn-onde' && anim.etoile === 'sgn-tourne' && !anim.fenetre && !anim.bulle,
        dit + ' : pendant la photo, l’anneau tourne, l’onde s’échappe, l’étoile tourne (' + anim.anneau + ', ' + anim.onde + ', ' + anim.etoile + ')');
      await capture(p, nom + '-photo.png');
      await p.evaluate(() => { window.__h2cDelai = 0; });
      await p.waitForSelector('.sgn-toile canvas', { timeout: 20000 });
      ok((await p.inputValue('.sgn-texte')) === 'Une requête a échoué : GET /api/panne (erreur 500)' && (await p.getAttribute('.sgn-type[data-v="bug"]', 'aria-pressed')) === 'true',
        dit + ' : « Signaler » ouvre un bug, avec la ligne « ' + (await p.inputValue('.sgn-texte')) + ' »');
      // e) Le dessin : une ellipse autour du bouton « Enregistrer » de la capture.
      const geo = await p.evaluate(() => {
        const c = document.querySelector('.sgn-toile canvas').getBoundingClientRect(), b = document.getElementById('panne').getBoundingClientRect(), cap = window.Signaler._etat().captures[0];
        return { c: { x: c.left, y: c.top, w: c.width, h: c.height }, b: { cx: b.left + b.width / 2, cy: b.top + b.height / 2, w: b.width, h: b.height }, vw: cap.vw, vh: cap.vh };
      });
      const sx = geo.c.w / geo.vw, sy = geo.c.h / geo.vh;
      const tour = ellipse(geo.c.x + geo.b.cx * sx, geo.c.y + geo.b.cy * sy, geo.b.w * sx / 2 + 8, geo.b.h * sy / 2 + 8);
      await geste(p, toucher, ligne([geo.c.x + 10, geo.c.y + 10], [geo.c.x + 40, geo.c.y + 30], 4));
      ok(await p.evaluate(() => window.Signaler._etat().captures[0].traits.length === 1 && !document.querySelector('[data-a="gomme"]').disabled), dit + ' : un trait sur la capture, « Effacer le dessin » s’allume');
      await toucherEl(p, toucher, '[data-a="gomme"]');
      ok(await p.evaluate(() => window.Signaler._etat().captures[0].traits.length === 0 && document.querySelector('[data-a="gomme"]').disabled), dit + ' : « Effacer le dessin » retire les traits');
      await geste(p, toucher, tour);
      const tr = await p.evaluate(() => { const t = window.Signaler._etat().captures[0].traits; return { n: t.length, e: t[0] && t[0].e, svg: document.querySelectorAll('.sgn-v[data-i="0"] svg polyline').length }; });
      ok(tr.n === 1 && tr.e && tr.e.id === 'panne' && tr.e.balise === 'button' && tr.svg === 1, dit + ' : l’ellipse autour d’« Enregistrer » : l’élément dessous est ' + (tr.e ? tr.e.chemin + ' « ' + tr.e.texte + ' »' : 'introuvable') + ', la vignette porte le trait');
      const rouge = await p.evaluate(() => { const c = document.querySelector('.sgn-toile canvas'), g = c.getContext('2d'), d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i] > 200 && d[i + 1] < 90) n++; return n; });
      ok(rouge > 200, dit + ' : le trait rouge se voit sur la capture (' + rouge + ' points)');
      pbs = pbs.concat(await controler(p));
      await capture(p, nom + '-dessin.png');
      // f) Plusieurs écrans : « + Un autre écran », la pastille blanche, un rechargement, cinq écrans en tout.
      await toucherEl(p, toucher, '[data-a="autre"]');
      ok(!(await p.$('.sgn-boite')) && (await pastille(p)) === '1' && /^Brouillon gardé \(1 écran\)/.test(await bulleVue(p)), dit + ' : « + Un autre écran » ferme la fenêtre, la pastille blanche dit 1, la bulle explique');
      pbs = pbs.concat(await controler(p));
      await p.waitForTimeout(300);
      await capture(p, nom + '-attente.png');
      await p.reload();
      await p.waitForSelector('.sgn-fab');
      await p.waitForTimeout(300);
      const f4 = await boite(p, '.sgn-fab');
      ok(Math.abs(f4.cx - but[0]) <= 1 && Math.abs(f4.cy - but[1]) <= 1 && (await pastille(p)) === '1', dit + ' : après un rechargement, le rond est à sa place et la pastille dit toujours 1');
      for (let k = 2; k <= 5; k++) {
        await ouvrirAvecPhoto(p, toucher, k);
        if (k === 3) {
          await toucherEl(p, toucher, '[data-a="autre"]');
          await p.reload(); await p.waitForSelector('.sgn-fab'); await p.waitForTimeout(200);
          ok((await pastille(p)) === '3', dit + ' : rechargé avec 3 écrans en attente, la pastille dit 3');
          continue;
        }
        if (k < 5) await toucherEl(p, toucher, '[data-a="autre"]');
      }
      const plein = await p.evaluate(() => ({ n: document.querySelectorAll('.sgn-v img').length, ajout: document.querySelector('[data-a="autre"]').textContent, off: document.querySelector('[data-a="autre"]').disabled, capt: document.querySelector('[data-a="capturer"]').disabled }));
      ok(plein.n === 5 && plein.off && plein.capt && plein.ajout === '5 écrans au plus', dit + ' : cinq écrans au plus (« ' + plein.ajout + ' »)');
      pbs = pbs.concat(await controler(p));
      await capture(p, nom + '-cinq.png');
      await p.keyboard.press('Escape');
      await p.reload(); await p.waitForSelector('.sgn-fab'); await p.waitForTimeout(200);
      const garde = await brouillonGarde(p);
      ok((await pastille(p)) === '5' && garde && garde.n === 5 && garde.traits[0] === 1 && garde.texte === 'Une requête a échoué : GET /api/panne (erreur 500)', dit + ' : le brouillon de 5 écrans survit au rechargement (texte et dessin compris)');
      await toucherEl(p, toucher, '.sgn-fab');
      await p.waitForSelector('.sgn-toile canvas', { timeout: 10000 });
      ok((await p.$$('.sgn-v img')).length === 5 && await p.evaluate(() => window.Signaler._etat().captures.length === 5) && (await p.$$('.sgn-v[data-i="0"] svg polyline')).length === 1, dit + ' : le rond rouvre les 5 écrans sans en prendre un sixième');
      // g) L'envoi : 5 images, la première avec son dessin ; les éléments ; la boîte noire, sans rien de tapé.
      const n0 = faux.signalements.length;
      await toucherEl(p, toucher, '.sgn-envoyer');
      await p.waitForSelector('.sgn-etat.ok', { timeout: 20000 });
      const corps = faux.signalements[n0] || {}, cx = corps.contexte || {}, j = Array.isArray(cx.journal) ? cx.journal : [];
      ok(Array.isArray(corps.captures) && corps.captures.length === 5, dit + ' : les 5 écrans partent');
      const el0 = (cx.elements || [])[0] || {};
      ok((cx.elements || []).length === 1 && el0.id === 'panne' && el0.balise === 'button' && /button#panne/.test(el0.chemin) && /Enregistrer/.test(el0.texte) && el0.ecran === 1,
        dit + ' : contexte.elements = ' + JSON.stringify(cx.elements || []).slice(0, 160));
      const pixels = await p.evaluate(({ src, pts }) => new Promise((ok) => {
        const img = new Image();
        img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
          let r = 0; for (const [fx, fy] of pts) { const d = g.getImageData(Math.min(img.width - 1, Math.round(fx * img.width)), Math.min(img.height - 1, Math.round(fy * img.height)), 1, 1).data; if (d[0] > 170 && d[1] < 110 && d[2] < 110) r++; }
          ok(r); };
        img.onerror = () => ok(-1);
        img.src = src;
      }), { src: corps.captures[0].donnees, pts: tour.map(([px, py]) => [(px - geo.c.x) / geo.c.w, (py - geo.c.y) / geo.c.h]).filter(([fx, fy]) => fx > 0.01 && fx < 0.99 && fy > 0.01 && fy < 0.99) });
      ok(pixels >= 20, dit + ' : l’image envoyée porte le dessin (' + pixels + ' points rouges sur le tracé)');
      const types = (t, f) => j.filter((e) => e.type === t && (!f || f(e)));
      const tape = toucher ? 'toucher' : 'clic';
      ok(types(tape, (e) => /#lancer-erreur/.test(e.cible)).length >= 1 && types(tape, (e) => /#vers-bas/.test(e.cible)).length === 1, dit + ' : boîte noire, les ' + (toucher ? 'touchers' : 'clics') + ' (« ' + (types(tape)[0] || {}).cible + ' »)');
      ok(types('saisie', (e) => /^input\[text\]#champ-nom « Nom du client »$/.test(e.cible) && e.detail === 'validée').length === 1
        && types('saisie', (e) => /^input\[password\]#champ-mdp « Mot de passe »$/.test(e.cible) && e.detail === 'validée').length === 1,
        dit + ' : boîte noire, une ligne par champ, sans sa valeur (« ' + types('saisie').map((e) => e.cible).join(' », « ') + ' »)');
      ok(types('page', (e) => e.cible === '/demo/index.html#bas' && e.detail === 'ancre').length === 1 && types('page', (e) => e.detail === 'chargement').length >= 1, dit + ' : boîte noire, les pages (chargement, ancre #bas)');
      ok(types('defilement', (e) => e.cible === 'page' && /^y = \d+ px/.test(e.detail)).length >= 1, dit + ' : boîte noire, le défilement');
      ok(types('erreur', (e) => e.detail.endsWith(ERREUR_DEMO) && /\.html:\d+$/.test(e.cible)).length >= 1, dit + ' : boîte noire, l’erreur de la page');
      ok(types('requete', (e) => e.cible === 'GET /api/panne' && e.detail === 'statut 500').length === 1 && types('requete', (e) => e.cible === 'GET /api/panne-xhr' && e.detail === 'statut 503').length === 1
        && types('requete', (e) => e.cible === 'GET /api/absent' && e.detail === 'statut 404').length === 1, dit + ' : boîte noire, les requêtes en échec (500, 503, 404), sans « ?… »');
      ok(j.length > 0 && j.length <= 200 && j.every((e) => typeof e.t === 'number' && e.t >= 0 && typeof e.cible === 'string' && typeof e.detail === 'string')
        && !j.some((e) => /sgn-|Signaler à Claude|Un autre écran/.test(e.cible)), dit + ' : ' + j.length + ' lignes, chacune avec t (ms avant l’envoi) ; rien du bouton lui-même');
      const brut = JSON.stringify(corps), texteRoutine = (appels[appels.length - 1] || {}).text || '';
      ok(![SECRET_TEXTE, SECRET_MDP, 'jeton=', 'demo-secret', 'xhr-secret', 'cle=zzz'].some((s) => brut.includes(s) || texteRoutine.includes(s)), dit + ' : ni le texte tapé, ni le mot de passe, ni « ?jeton=… » ne partent (corps envoyé et texte de la routine)');
      ok(!(await brouillonGarde(p)) && !(await pastille(p)), dit + ' : envoyé, le brouillon est effacé (plus de pastille)');
      await p.keyboard.press('Escape');
      // h) Tourner l'écran : le rond déplacé est ramené dans l'écran.
      await p.setViewportSize({ width: ht, height: w });
      await p.waitForTimeout(250);
      const f5 = await boite(p, '.sgn-fab');
      ok(f5.x >= 11 && f5.x + f5.w <= ht - 11 && f5.y >= 15 && f5.y + f5.h <= w - 11, dit + ' : écran tourné (' + ht + ' × ' + w + '), le rond reste dans l’écran');
      await p.setViewportSize({ width: w, height: ht });
      await p.waitForTimeout(250);
      // i) « Remettre le bouton à sa place ».
      await ouvrirAvecPhoto(p, toucher, 1);
      await toucherEl(p, toucher, '[data-a="remettre"]');
      ok((await texte(p, '.sgn-etat')) === 'Le bouton est revenu à sa place.' && !(await p.$('[data-a="remettre"]'))
        && !(await p.evaluate(() => document.querySelector('.sgn-fab').classList.contains('sgn-deplace') || !!JSON.parse(localStorage.getItem('signaler_pos_v1') || '{}')[location.origin + location.pathname])), dit + ' : « Remettre le bouton à sa place »');
      await p.keyboard.press('Escape');
      const f6 = await boite(p, '.sgn-fab');
      ok(Math.abs(f6.x + f6.w - (w - 18)) <= 1 && Math.abs(f6.y + f6.h - (ht - 18)) <= 1 && !(await pastille(p)), dit + ' : revenu en bas à droite ; la fenêtre fermée sans rien y mettre ne laisse pas de brouillon');
      // j) Signaler.oublier() : brouillon, liste et boîte noire effacés ; la clé reste.
      await ouvrirAvecPhoto(p, toucher, 1);
      await p.fill('.sgn-texte', 'À oublier');
      await toucherEl(p, toucher, '[data-a="autre"]');
      ok((await pastille(p)) === '1' && (await p.evaluate(() => window.Signaler._journal().length)) > 0, dit + ' : un brouillon en attente, une boîte noire pleine');
      await p.evaluate(() => window.Signaler.oublier());
      const apres = await p.evaluate(() => ({ b: sessionStorage.getItem('signaler_brouillon_v1'), j: window.Signaler._journal().length, n: window.Signaler._etat().captures.length, badge: getComputedStyle(document.querySelector('.sgn-badge')).display, cle: !!localStorage.getItem('signaler_cle_v1') }));
      ok(!apres.b && !apres.j && !apres.n && apres.badge === 'none' && apres.cle && !(await pastille(p)), dit + ' : Signaler.oublier() efface le brouillon, la liste gardée et la boîte noire ; la clé reste');
      const vraies = x.erreursPage.filter((e) => !e.includes(ERREUR_DEMO));
      ok(!pbs.length && !vraies.length, dit + ' : rien ne déborde, pas plus de 3 boutons par rangée, ni italique ni émoji' + (pbs.length ? ' — ' + [...new Set(pbs)].join(' ; ') : '') + (vraies.length ? ' — ' + vraies.join(' ; ') : ''));
      await x.ctx.close();
    }
  }
  // Mouvement réduit : rien ne tourne ni ne pulse, l'anneau plein dit quand même « je travaille ».
  remettre();
  const rm = await page({ width: 412, height: 915 }, { mouvement: 'reduce' });
  await rm.p.waitForSelector('.sgn-fab');
  await rm.p.evaluate(() => { window.__h2cDelai = 1200; });
  await rm.p.click('.sgn-fab');
  await rm.p.waitForSelector('.sgn-fab.sgn-occupe', { timeout: 3000 });
  await rm.p.waitForTimeout(300);
  const calme = await rm.p.evaluate(() => { const f = document.querySelector('.sgn-fab'), st = (s) => getComputedStyle(f.querySelector(s)); return [st('.sgn-anneau').opacity, st('.sgn-anneau').animationName, st('.sgn-onde').opacity, st('.sgn-etoile').animationName].join(' '); });
  ok(calme === '1 none 0 none', 'prefers-reduced-motion : pendant la photo, l’anneau est là mais immobile, pas d’onde (' + calme + ')');
  await capture(rm.p, 'rond-412-mouvement-reduit.png');
  await rm.ctx.close();
  console.log('  captures : ' + CAPTURES);
} catch (e) { ko++; console.log('  ✗ exception : ' + (e && e.stack || e)); }
finally { await navigateur.close(); site.close(); relais.close(); }

console.log(ko ? '\n✗ ' + ko + ' échec(s)' : '\n✓ tout passe');
process.exit(ko ? 1 : 0);
