// Le bouton dans un VRAI navigateur (Chromium, via Playwright). POST /signaler passe par le VRAI relais (relay/cloudflare/worker.mjs
// servi par Node), avec un faux stockage R2 et une fausse routine : aucune donnée ne sort, aucun appel à Claude.
// L'interrupteur (GET /etat) et « Mes demandes » (GET /demandes, POST /demandes/<id>/renvoyer) sont joués par de FAUX relais écrits
// ici d'après le contrat : le test du bouton ne dépend pas du code de ces routes côté relais (testées par relais.test.mjs).
//   node tests/bouton.navigateur.mjs        (Playwright doit être installé : npm i -D playwright, ou global via NODE_PATH)
//   SIGNALER_CAPTURES=/un/dossier            où ranger les captures d'écran (défaut : tests/.cache/)
// html2canvas : servi depuis tests/.cache/ s'il y est (le navigateur du test ne va pas sur Internet), sinon depuis cdnjs.
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { signaler } from '../relay/cloudflare/worker.mjs';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURES = process.env.SIGNALER_CAPTURES || join(RACINE, 'tests', '.cache');
mkdirSync(CAPTURES, { recursive: true });
let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch (e) { console.log('⊘ Playwright absent : test du navigateur non joué'); process.exit(0); }

let ko = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) ko++; };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

// Le site de démonstration (la racine du dépôt, en statique).
const site = http.createServer((req, res) => {
  const p = join(RACINE, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(RACINE) || !existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(readFileSync(p));
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const ORIGINE = 'http://127.0.0.1:' + site.address().port;

// Le relais : le vrai code du Worker pour POST /signaler, derrière un petit serveur Node.
const CLE = 'k7Qe9mWz4Lp2Xr8T', CLE_PAUL = 'Zr2mP8vQ5nB3wX6y';   // clés de test, sans valeur ailleurs
const NOMS = { [CLE]: 'marie', [CLE_PAUL]: 'paul' };
const objets = new Map(), appels = [];
const texteDe = (v) => (typeof v === 'string' ? v : new TextDecoder().decode(v instanceof ArrayBuffer ? new Uint8Array(v) : v));
const env = { ORIGINES: ORIGINE, DEPOT: 'exemple/app', ROUTINE_URL: 'https://api.anthropic.com/v1/claude_code/routines/trig_01TEST/fire', ROUTINE_JETON: 'sk-ant-oat01-FAUX',
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
const faux = { etat: 'on', etatOuvert: false, coupe: false, demandes: 'normal', base: {}, appelsEtat: 0, appelsDemandes: 0, renvois: [], entetesEtat: null };
function remettre() { Object.assign(faux, { etat: 'on', etatOuvert: false, coupe: false, demandes: 'normal', base: { marie: demandesDeMarie(), paul: [] }, renvois: [] }); }
remettre();
const publique = (x) => { const { retourHash, texteRoutine, ...p } = x; return p; };
const RENVOI_RX = /^\/demandes\/([0-9a-f]{12})\/renvoyer$/;

const relais = http.createServer(async (req, res) => {
  const morceaux = []; for await (const m of req) morceaux.push(m);
  const corps = Buffer.concat(morceaux);
  const u = new URL(req.url, 'http://x'), origine = req.headers.origin || '';
  const permise = origine === ORIGINE;
  const cors = permise ? { 'Access-Control-Allow-Origin': ORIGINE, 'Vary': 'Origin' } : { 'Vary': 'Origin' };
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
    if (faux.etat === 'absent') { res.writeHead(404); return res.end('introuvable'); }
    const ce = faux.etatOuvert ? { 'Access-Control-Allow-Origin': '*', 'Vary': 'Origin' } : cors, plus = faux.etatOuvert ? { origine: permise } : {};
    if (faux.etat === 'erreur') return repondre(500, { ok: false }, ce);
    if (faux.etat === 'lent') { await attendre(6000); return repondre(200, { ok: true, actif: false, depuis: T0, par: 'marie', ...plus }, ce); }
    return repondre(200, Object.assign(faux.etat === 'off' ? { ok: true, actif: false, depuis: T0, par: 'marie' } : { ok: true, actif: true, depuis: null, par: null }, plus), ce);
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
  if (req.method === 'POST' && u.pathname === '/signaler' && faux.coupe && permise && qui) {
    return repondre(403, { ok: false, coupe: true, erreur: 'le bouton est coupé depuis le pupitre' });
  }
  const r = new Request('http://127.0.0.1' + req.url, { method: req.method, headers: req.headers, body: req.method === 'POST' ? corps : undefined });
  const rep = await signaler(r, env, { fetch: fausseRoutine, attendre: async () => {} });
  res.writeHead(rep.status, Object.fromEntries(rep.headers)); res.end(Buffer.from(await rep.arrayBuffer()));
});
await new Promise((r) => relais.listen(0, '127.0.0.1', r));
const RELAIS = 'http://127.0.0.1:' + relais.address().port;

const navigateur = await chromium.launch();
const H2C = join(RACINE, 'tests', '.cache', 'html2canvas-1.4.1.min.js');
async function page(taille, o = {}) {
  const ctx = await navigateur.newContext({ viewport: taille, permissions: [], colorScheme: o.theme || 'light' });
  if (o.cle) await ctx.addInitScript((k) => { try { if (!localStorage.getItem('signaler_cle_v1')) localStorage.setItem('signaler_cle_v1', k); } catch (e) {} }, o.cle);
  if (o.init) await ctx.addInitScript(o.init);
  const p = await ctx.newPage();
  if (existsSync(H2C)) await p.route('https://cdnjs.cloudflare.com/**', (route) => route.fulfill({ contentType: 'text/javascript', body: readFileSync(H2C, 'utf8') }));
  const erreursPage = []; p.on('pageerror', (e) => erreursPage.push(String(e)));
  await p.goto((o.origine || ORIGINE) + '/demo/index.html?relais=' + encodeURIComponent(o.relais || RELAIS));
  return { p, ctx, erreursPage };
}
const texte = async (p, sel) => ((await p.textContent(sel)) || '').replace(/\s+/g, ' ').trim();
const capture = (p, nom) => p.screenshot({ path: join(CAPTURES, nom) });

// Ce que la règle de l'interface interdit, mesuré dans la page : défilement en largeur, élément qui dépasse de la fenêtre,
// rangée de plus de 3 boutons, italique, émoji (texte, aria-label, title, placeholder, alt).
async function controler(p) {
  return p.evaluate(() => {
    const pb = [], de = document.documentElement;
    const nom = (e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : '') + ' « ' + (e.textContent || '').trim().slice(0, 30) + ' »';
    if (de.scrollWidth > de.clientWidth) pb.push('la page défile en largeur (' + de.scrollWidth + ' > ' + de.clientWidth + ')');
    const tous = [...document.querySelectorAll('.sgn-fab, .sgn-fab *, .sgn-badge, .sgn-fond, .sgn-fond *')];
    const RX = /\p{Extended_Pictographic}/u;
    for (const e of tous) {
      if (getComputedStyle(e).fontStyle !== 'normal') pb.push('italique : ' + nom(e));
      if (/^(EM|I)$/.test(e.tagName)) pb.push('balise ' + e.tagName + ' : ' + nom(e));
      for (const n of e.childNodes) if (n.nodeType === 3 && RX.test(n.nodeValue)) pb.push('émoji : ' + n.nodeValue.trim().slice(0, 40));
      for (const a of ['aria-label', 'title', 'placeholder', 'alt']) { const v = e.getAttribute(a); if (v && RX.test(v)) pb.push('émoji (' + a + ') : ' + v); }
    }
    for (const sel of ['.sgn-fab', '.sgn-badge']) {
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
      const clics = [...boite.querySelectorAll('button, a[href], label.sgn-bouton')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.closest('.sgn-v'); });
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
  // Sous un contenu plus court que l'écran, la capture prend le fond de la page — pas du noir (le transparent en JPEG).
  const basDeCapture = await p.evaluate(() => new Promise((ok) => {
    const img = new Image();
    img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const d = g.getImageData(Math.floor(img.width / 2), img.height - 5, 1, 1).data; ok(d[0] + d[1] + d[2]); };
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
    ['e5f6a1b2c3d4', 'en cours', 'koulam.app', []],
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
  console.log('  captures : ' + CAPTURES);
} catch (e) { ko++; console.log('  ✗ exception : ' + (e && e.stack || e)); }
finally { await navigateur.close(); site.close(); relais.close(); }

console.log(ko ? '\n✗ ' + ko + ' échec(s)' : '\n✓ tout passe');
process.exit(ko ? 1 : 0);
