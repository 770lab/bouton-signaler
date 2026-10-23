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
// Section 11 : le VRAI relais tout entier (l'export par défaut du Worker) dans un fil à part, avec un Workers KV en mémoire, une
// fausse routine pour les deux abonnements et une montre qu'on peut avancer ; Chrome y joue l'empreinte avec son authentificateur
// virtuel (protocole DevTools, WebAuthn) : inscription, connexion, empreinte fraîche, session expirée, appareil retiré.
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { randomBytes } from 'node:crypto';
import { signaler } from '../relay/cloudflare/worker.mjs';
import * as Coeur from '../relay/coeur.mjs';

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
// ?csp=img : la démo servie avec la CSP des images du pupitre (img-src 'self' data: blob:), écrite ici pour la même raison.
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
  // ?csp=strict : img-src sans blob: non plus (la capture relue par fetch reste refusée : la vignette le dit).
  const CSPS = { img: "img-src 'self' data: blob:", strict: "img-src 'self' data:" };
  const csp = chemin === '/demo/index.html' && CSPS[u.searchParams.get('csp')] ? { 'Content-Security-Policy': CSPS[u.searchParams.get('csp')] } : {};
  res.writeHead(200, Object.assign({ 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' }, csp)); res.end(readFileSync(p));
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
const PROJETS = ['home', 'pupitre', 'havroutia', 'avinou', 'gescom', 'koulam'];
// La règle du contrat (une copie ici : le test ne lit pas le code du bouton pour vérifier le bouton).
function projetDeLaPage(url) {
  let u; try { u = new URL(String(url || '')); } catch (e) { return null; }
  const hote = u.hostname.toLowerCase().replace(/^www\./, ''), c = u.pathname.toLowerCase();
  if (hote === '770lab.com') return c.startsWith('/home/robots') ? 'pupitre' : c.startsWith('/home') ? 'home' : c.startsWith('/havroutia') ? 'havroutia' : c.startsWith('/gescom') ? 'gescom' : null;
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
  entetesEtat: null, requetesEtat: [], signalements: [], auth: [] };
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
    res.writeHead(204, Object.assign(cors, permise ? { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Signaler-Cle, Authorization', 'Access-Control-Max-Age': '600' } : {}));
    return res.end();
  }
  // L'empreinte : ce faux relais est celui d'avant SESSION_SECRET (« pas encore réglée », 503) ; le vrai est joué en 11.
  if (u.pathname.startsWith('/auth/')) { faux.auth.push(req.method + ' ' + u.pathname); return repondre(503, { ok: false, erreur: 'connexion par empreinte pas encore réglée' }); }
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

// ── LE VRAI RELAIS (section 11) : l'export par défaut de relay/cloudflare/worker.mjs, dans un fil à part (worker_threads) ──────
// Sa montre avance à la demande (POST /__test/decalage) sans toucher à celle de ce processus (Playwright compte ses délais) : les
// 30 jours d'une session, les 5 minutes d'une empreinte fraîche et les 15 minutes « sans nouvelle » sont vraiment éprouvées. Workers KV
// en mémoire (ses durées suivent cette montre) ; la routine des DEUX abonnements est fausse : rien ne sort vers api.anthropic.com.
// /__test/… : decalage { ms }, routine { trig_…: statut }, appels (ce qu'a reçu la routine), journal (les requêtes des pages, et
// si elles portaient une session ou la clé), kv?prefixe= (les clés rangées).
const FIL_RELAIS = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const http = require('node:http');
(async () => {
  const worker = (await import(workerData.url)).default;
  if (!workerData.bavard) console.log = () => {};   // le journal du relais : SIGNALER_JOURNAL=1 pour le voir
  const montre = Date.now.bind(Date);
  let decalage = 0;
  Date.now = () => montre() + decalage;
  const objets = new Map();
  const octetsDe = (v) => (typeof v === 'string' ? v : v instanceof ArrayBuffer ? new Uint8Array(v.slice(0)) : new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
  const lu = (k) => { const x = objets.get(k); if (x && x.fin && x.fin <= Date.now()) { objets.delete(k); return null; } return x || null; };
  const PIECES_KV = {
    put: async (k, v, o) => { objets.set(k, { v: octetsDe(v), fin: o && o.expirationTtl ? Date.now() + o.expirationTtl * 1000 : 0, meta: (o && o.metadata) || null }); },
    get: async (k) => { const x = lu(k); return x ? (typeof x.v === 'string' ? x.v : new TextDecoder().decode(x.v)) : null; },
    getWithMetadata: async (k) => {
      const x = lu(k); if (!x) return { value: null, metadata: null };
      const u = typeof x.v === 'string' ? new TextEncoder().encode(x.v) : x.v;
      return { value: u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength), metadata: x.meta };
    },
    delete: async (k) => { objets.delete(k); },
  };
  const appels = [], journal = [], reponses = {};
  globalThis.fetch = async (url, init) => {
    const u = String(url && url.url ? url.url : url), m = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/(trig_[A-Za-z0-9]+)\/fire$/.exec(u);
    if (!m) throw new Error('sortie refusée par le test : ' + u);
    const statut = reponses[m[1]] || 200, n = appels.length + 1;
    appels.push({ trig: m[1], statut: statut, text: JSON.parse(init.body).text });
    if (statut !== 200) return new Response(JSON.stringify({ error: { type: statut === 429 ? 'rate_limit_error' : 'invalid_request_error', message: statut === 429 ? 'plus de crédit pour le moment' : 'refusé' } }),
      { status: statut, headers: Object.assign({ 'content-type': 'application/json' }, statut === 429 ? { 'retry-after': '3600' } : {}) });
    return new Response(JSON.stringify({ claude_code_session_id: 'session_01VRAI' + n, claude_code_session_url: 'https://claude.ai/code/session_01VRAI' + n }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const env = Object.assign({}, workerData.env, { PIECES_KV: PIECES_KV });
  let base = '';
  const serveur = http.createServer(async (req, res) => {
    const morceaux = []; for await (const x of req) morceaux.push(x);
    const corps = Buffer.concat(morceaux), u = new URL(req.url, 'http://x');
    const repondre = (statut, o) => { res.writeHead(statut, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname.startsWith('/__test/')) {
      const q = corps.length ? JSON.parse(corps.toString()) : {}, quoi = u.pathname.slice(8);
      if (quoi === 'decalage') { decalage = Number(q.ms) || 0; return repondre(200, { ok: true }); }
      if (quoi === 'routine') { Object.assign(reponses, q); return repondre(200, { ok: true }); }
      if (quoi === 'appels') return repondre(200, appels);
      if (quoi === 'journal') return repondre(200, journal);
      if (quoi === 'kv') { const pr = u.searchParams.get('prefixe') || ''; return repondre(200, [...objets.keys()].filter((k) => k.startsWith(pr) && lu(k))); }
      return repondre(404, {});
    }
    if (req.method !== 'OPTIONS') journal.push({ m: req.method, p: u.pathname, par: req.headers.authorization ? 'session' : req.headers['x-signaler-cle'] ? 'cle' : '' });
    try {
      const r = new Request(base + req.url, { method: req.method, headers: req.headers, body: req.method === 'POST' ? corps : undefined });
      const rep = await worker.fetch(r, env);
      res.writeHead(rep.status, Object.fromEntries(rep.headers)); res.end(Buffer.from(await rep.arrayBuffer()));
    } catch (e) { res.writeHead(500); res.end(String(e && e.message)); }
  });
  serveur.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + serveur.address().port; parentPort.postMessage({ base: base }); });
})().catch((e) => parentPort.postMessage({ erreur: String((e && e.stack) || e) }));
`;
const LOCALHOST = 'http://localhost:' + site.address().port;   // la page de la section 11 : localhost (l'empreinte veut un nom, pas une IP)
const fil = new Worker(FIL_RELAIS, { eval: true, workerData: { url: pathToFileURL(join(RACINE, 'relay', 'cloudflare', 'worker.mjs')).href, bavard: !!process.env.SIGNALER_JOURNAL, env: {
  ORIGINES: LOCALHOST, DEPOT: '770lab/home', MONTRER_SUIVI: 'oui', CLES: 'marie:' + CLE + ',paul:' + CLE_PAUL,
  ROUTINE_URL: 'https://api.anthropic.com/v1/claude_code/routines/trig_01UN/fire', ROUTINE_JETON: 'sk-ant-oat01-FAUX-UN',
  ROUTINE_URL_2: 'https://api.anthropic.com/v1/claude_code/routines/trig_02DEUX/fire', ROUTINE_JETON_2: 'sk-ant-oat01-FAUX-DEUX',
  SESSION_SECRET: randomBytes(32).toString('hex') } } });   // un secret tiré pour ce test seulement, jamais écrit ni montré
const VRAI = await new Promise((ok, ko) => { fil.once('message', (m) => (m && m.base ? ok(m.base) : ko(new Error(m && m.erreur)))); fil.once('error', ko); });
const ctl = async (quoi, corps) => (await fetch(VRAI + '/__test/' + quoi, corps === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) })).json();

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
  // o.dataProjet : l'attribut data-projet posé sur la balise du bouton (par le site) · o.csp : la CSP des images du pupitre
  await p.goto((o.origine || ORIGINE) + (o.chemin || '/demo/index.html') + '?relais=' + encodeURIComponent(o.relais || RELAIS)
    + (o.projet ? '&projet=' + encodeURIComponent(o.projet) : '') + (o.dataProjet ? '&dataProjet=' + encodeURIComponent(o.dataProjet) : '')
    + (o.csp ? '&csp=' + (o.csp === true ? 'img' : o.csp) : '') + (o.couleur ? '&couleur=' + encodeURIComponent(o.couleur) : '')
    + (o.fenetre ? '&theme=' + encodeURIComponent(o.fenetre) : ''));
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
    const tous = [...document.querySelectorAll('.sgn-fab, .sgn-fab *, .sgn-badge, .sgn-fond, .sgn-fond *, .sgn-bulle, .sgn-bulle *, .sgn-vis, .sgn-vis *')];
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
    // La capture en plein écran : tout tient dans l'écran.
    const vis = document.querySelector('.sgn-vis');
    if (vis) for (const e of [vis, ...vis.querySelectorAll('*')]) {
      const r = e.getBoundingClientRect();
      if ((r.width || r.height) && (r.left < -0.5 || r.top < -0.5 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5)) pb.push('sort de l’écran (visionneuse) : ' + nom(e));
    }
    // Pas plus de 3 boutons par rangée, dans la fenêtre, la bulle et la visionneuse (les vignettes des écrans sont une galerie).
    for (const zone of document.querySelectorAll('.sgn-boite, .sgn-bulle, .sgn-vis')) {
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
  if (process.env.SIGNALER_SEULEMENT !== '11') {
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
  ok(!!(await p.waitForSelector('.sgn-cle', { timeout: 5000 }).catch(() => null)) && !(await p.$('[data-a="empreinte"]')) && faux.auth.includes('POST /auth/options/connexion'),
    'la première fois, sur un relais où l’empreinte n’est pas réglée (503) : la clé d’équipe est demandée, comme avant');
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

  console.log('3 bis. La dictée : pas de mots doublés, relancée jusqu’à ce qu’on rappuie (21/10/2026)');
  // Un faux micro qui fait comme Chrome sur Android : chaque résultat reprend le précédent (« dans », « dans chaque »…), et la
  // reconnaissance s'arrête à la fin de chaque phrase. Avant : « dansdans chaquedans chaque conversation », puis plus rien.
  const FAUX_MICRO = () => {
    const PHRASES = [['dans', 'dans chaque', 'dans chaque conversation'], ['mets-moi', 'mets-moi un lien']];
    let n = 0; window.__srLancements = 0;
    class SR {
      start() {
        const phrase = PHRASES[n++]; window.__srLancements++;
        setTimeout(() => {
          if (!this.arrete && phrase) this.onresult && this.onresult({ results: phrase.map((t) => [{ transcript: t }]) });
          else if (!this.arrete) this.onerror && this.onerror({ error: 'no-speech' });
          this.onend && this.onend();
        }, 30);
      }
      stop() { this.arrete = true; }
    }
    window.SpeechRecognition = SR; window.webkitSpeechRecognition = SR;
  };
  const dct = await page({ width: 412, height: 915 }, { init: FAUX_MICRO });
  await (await dct.p.waitForSelector('.sgn-fab')).click();
  await dct.p.waitForSelector('.sgn-texte');
  await dct.p.click('[data-a="micro"]');
  const finie = await dct.p.waitForFunction(() => window.__srLancements >= 5 && (document.querySelector('[data-a="micro"]').textContent || '').trim() === 'Dicter', null, { timeout: 10000 }).then(() => true, () => false);
  const dit = await dct.p.$eval('.sgn-texte', (z) => z.value.trim());
  ok(finie && dit === 'dans chaque conversation mets-moi un lien', 'deux phrases, chaque mot une seule fois (et pas « dansdans chaquedans… ») — « ' + dit + ' »');
  ok(await dct.p.evaluate(() => window.__srLancements) === 5 && /je n’entends plus rien/.test(await texte(dct.p, '.sgn-etat')),
    'relancée après chaque phrase, arrêtée après trois silences, et ça se dit');
  await dct.p.click('[data-a="micro"]'); await dct.p.click('[data-a="micro"]'); await dct.p.waitForTimeout(600);
  ok(await dct.p.evaluate(() => window.__srLancements) === 6 && (await texte(dct.p, '[data-a="micro"]')) === 'Dicter', 'rappuyer arrête : plus aucune relance');
  ok(!dct.erreursPage.length, 'aucune erreur dans la page' + (dct.erreursPage.length ? ' — ' + dct.erreursPage.join(' ; ') : ''));
  await dct.ctx.close();

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
  // SignalerConfig.sansAlerte : une requête que la page affiche déjà elle-même (le pupitre et son Mac) reste dans la boîte noire,
  // sans point rouge ni bulle ; une autre requête en échec allume toujours la bulle.
  e = await page({ width: 390, height: 844 }, { cle: CLE, init: () => {
    let v; Object.defineProperty(window, 'SignalerConfig', { configurable: true, get: () => v, set: (x) => { v = Object.assign({}, x, { sansAlerte: (u) => u.indexOf('127.0.0.1:9/') >= 0 }); } });
  } });
  await e.p.waitForSelector('.sgn-fab', { timeout: 5000 });
  await e.p.evaluate(() => fetch('http://127.0.0.1:9/mac/robots').catch(() => null));
  await e.p.waitForTimeout(600);
  const muette = await e.p.evaluate(() => ({ bulle: !!document.querySelector('.sgn-bulle:not([hidden])') && getComputedStyle(document.querySelector('.sgn-bulle')).display !== 'none',
    rouge: document.querySelector('.sgn-fab').classList.contains('sgn-alerte'), journal: JSON.stringify(window.Signaler._journal()) }));
  await e.p.evaluate(() => fetch('http://127.0.0.1:1/autre').catch(() => null));
  const parle = await e.p.waitForSelector('.sgn-bulle', { state: 'visible', timeout: 3000 }).then(() => true, () => false);
  ok(!muette.bulle && !muette.rouge && /127\.0\.0\.1:9\/mac\/robots/.test(muette.journal) && parle,
    'SignalerConfig.sansAlerte : la requête du Mac en échec reste dans la boîte noire sans bulle ni point rouge ; une autre allume la bulle'
    + (muette.bulle || muette.rouge ? ' (alerte allumée pour la requête muette)' : '') + (parle ? '' : ' (pas de bulle pour l’autre)'));
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
    ['c3d4e5f6a1b2', 'pas partie', 'HavroutIA', ['Renvoyer', 'Ouvrir dans Claude', 'Voir la PR']],
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
  ok(await m.p.$eval('.sgn-carte[data-id="c3d4e5f6a1b2"]', (c) => { const r = c.querySelectorAll('.sgn-actions'); return r.length === 2 && r[0].textContent === 'Renvoyer'; }), 'deux rangées : ce qu’on peut faire (« Renvoyer »), puis les liens');
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
  await m.p.waitForFunction(() => /déjà repartie/.test(document.querySelector('.sgn-etat').textContent));
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

  console.log('5 bis. Les conversations de l’Atelier : une réponse continue sa conversation, « Réglé » n’est plus à traiter');
  remettre();
  {
    const d = (min, x) => Object.assign({ qui: 'marie', type: 'bug', captures: 0, audio: false, creeLeMs: T0 - min * 60000, majLeMs: T0 - min * 60000 + 30000,
      page: { url: 'https://770lab.com/home/', titre: 'Home' } }, x);
    const suite = (ref, t) => 'SUITE DE LA DEMANDE ' + ref + ' (…) — projet Home\n\n' + t;
    faux.base.marie = [
      d(10, { id: 'c0c0c0c0c0c2', etat: 'question', texte: suite('c0c0c0c0c0c1', 'finalement non') }),            // rouverte : compte
      d(60, { id: 'b0b0b0b0b0b1', etat: 'a_relire', texte: 'La PR à relire, rangée dans Réglé', regleeLeMs: T0 - 50 * 60000 }),  // réglée : ne compte pas
      d(90, { id: 'a0a0a0a0a0a2', etat: 'question', texte: suite('a0a0a0a0a0a1', 'je veux un bouton') }),         // la dernière réponse : compte
      d(120, { id: 'd0d0d0d0d0d1', etat: 'pas_partie', texte: 'Pas partie' }),                                     // compte
      d(180, { id: 'a0a0a0a0a0a1', etat: 'question', texte: 'Pourquoi ça marche pas ?' }),                        // continuée : ne compte pas
      d(300, { id: 'c0c0c0c0c0c1', etat: 'question', texte: 'Une autre', regleeLeMs: T0 - 200 * 60000 }),         // continuée après « Réglé »
    ];
    const c = await page({ width: 412, height: 915 }, { cle: CLE });
    const b5 = await c.p.waitForSelector('.sgn-badge', { state: 'visible', timeout: 5000 });
    ok((await b5.textContent()) === '3', 'le rond compte 3 : la dernière réponse de chaque conversation, sans celle rangée dans « Réglé » (' + (await b5.textContent()) + ')');
    await b5.click();
    await c.p.waitForSelector('.sgn-carte');
    const ids = await c.p.$$eval('.sgn-carte', (l) => l.map((x) => x.dataset.id));
    ok(ids.join() === 'c0c0c0c0c0c2,a0a0a0a0a0a2,d0d0d0d0d0d1', '« À traiter » : ' + ids.join());
    await c.p.click('[data-a="filtre"][data-v="toutes"]');
    ok((await texte(c.p, '.sgn-carte[data-id="b0b0b0b0b0b1"] .sgn-pil')) === 'réglé', 'une conversation rangée dans « Réglé » le dit');
    ok((await texte(c.p, '.sgn-carte[data-id="a0a0a0a0a0a1"] .sgn-pil')) === 'question', 'une demande continuée garde son état (elle n’est juste plus à traiter)');
    const det = await c.p.evaluate(() => new Promise((ok) => { addEventListener('signaler:demandes', (e) => ok(e.detail), { once: true }); window.Signaler.demandes('toutes'); }));
    ok(det.aTraiter === 3 && det.projets.home.aTraiter === 3, 'le pupitre reçoit les mêmes nombres (signaler:demandes)');
    const pb5 = await controler(c.p);
    ok(!pb5.length, 'mise en page à 412 px' + (pb5.length ? ' : ' + pb5.join(' ; ') : ''));
    ok(c.erreursPage.length === 0, 'aucune erreur JavaScript');
    await c.ctx.close();
  }

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
  console.log('7 bis. La couleur de la page (23/10/2026, Yoann : « juste pour la couleur, il prend celle de la page où il se trouve »)');
  {
    const lum = (h) => { const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    const contraste = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const enHex = (rgb) => '#' + (rgb.match(/\d+/g) || []).slice(0, 3).map((v) => (+v).toString(16).padStart(2, '0')).join('');
    // Ouvre la fenêtre et rend sa couleur : les liens, le bouton « Envoyer à Claude », son texte, le fond.
    const ouvrirEtLire = async (p) => {
      await p.click('.sgn-fab', { position: { x: 24, y: 30 } });
      await p.waitForSelector('.sgn-v img', { timeout: 15000 });
      return p.evaluate(() => {
        const cs = (s, k) => getComputedStyle(document.querySelector(s))[k];
        return { lien: cs('.sgn-tete .sgn-lien', 'color'), plein: cs('.sgn-envoyer', 'backgroundColor'), texte: cs('.sgn-envoyer', 'color'),
          fond: cs('.sgn-boite', 'backgroundColor'), choix: cs('.sgn-type[aria-pressed="true"]', 'borderTopColor'), teinte: window.Signaler.teinte() };
      });
    };
    // a) Rien à lire sur la page (la démo n'a ni variable ni bouton plein) : le bleu du modèle, comme l'Atelier 770LAB.
    remettre();
    let x = await page({ width: 412, height: 915 }, { cle: CLE });
    let c = await ouvrirEtLire(x.p);
    ok(enHex(c.plein) === '#2563eb' && enHex(c.lien) === '#2563eb' && enHex(c.texte) === '#ffffff' && enHex(c.fond) === '#ffffff',
      'page sans couleur : le bleu du modèle (' + enHex(c.plein) + ', texte ' + enHex(c.texte) + ')');
    await x.p.keyboard.press('Escape');
    // b) La page a une variable --accent (orange) : le bouton plein la prend telle quelle ; les liens, assombris juste assez, se lisent.
    await x.p.evaluate(() => document.documentElement.style.setProperty('--accent', '#d97757'));
    await x.p.waitForTimeout(2100);   // la couleur lue est gardée 2 s
    c = await ouvrirEtLire(x.p);
    ok(enHex(c.plein) === '#d97757' && enHex(c.choix) === enHex(c.lien) && contraste(enHex(c.lien), '#ffffff') >= 4.5 && contraste(enHex(c.texte), '#d97757') >= 3,
      '--accent orange : « Envoyer à Claude » ' + enHex(c.plein) + ', liens ' + enHex(c.lien) + ' (contraste ' + contraste(enHex(c.lien), '#ffffff').toFixed(2) + '), texte ' + enHex(c.texte));
    await capture(x.p, 'couleur-accent-orange.png');
    await x.p.keyboard.press('Escape');
    // c) Une couleur claire (jaune) : le bouton reste jaune, son texte devient presque noir.
    await x.p.evaluate(() => document.documentElement.style.setProperty('--accent', '#facc15'));
    await x.p.waitForTimeout(2100);
    c = await ouvrirEtLire(x.p);
    ok(enHex(c.plein) === '#facc15' && enHex(c.texte) === '#0f172a' && contraste(enHex(c.lien), '#ffffff') >= 4.5,
      '--accent jaune : le bouton reste jaune, texte presque noir, liens lisibles (' + enHex(c.lien) + ')');
    await x.p.keyboard.press('Escape');
    // d) Pas de variable, mais un bouton principal plein (vert) : sa couleur.
    await x.p.evaluate(() => { document.documentElement.style.removeProperty('--accent'); document.body.insertAdjacentHTML('afterbegin', '<button class="btn-primary" style="background:#16a34a;color:#fff;padding:12px 20px;border:0">Valider</button>'); });
    await x.p.waitForTimeout(2100);
    c = await ouvrirEtLire(x.p);
    ok(enHex(c.plein) === '#16a34a', 'bouton principal vert de la page : la fenêtre le prend (' + enHex(c.plein) + ')');
    ok(!x.erreursPage.length, 'aucune erreur JavaScript' + (x.erreursPage.length ? ' — ' + x.erreursPage.join(' ; ') : ''));
    await x.ctx.close();
    // e) Le réglage `couleur` l'emporte sur la page ; `theme: 'sombre'` impose la fenêtre sombre sur une page claire.
    remettre();
    x = await page({ width: 412, height: 915 }, { cle: CLE, couleur: '#7c3aed', fenetre: 'sombre' });
    c = await ouvrirEtLire(x.p);
    ok(enHex(c.plein) === '#7c3aed' && enHex(c.fond) === '#0f172a' && c.teinte.sombre === true && contraste(enHex(c.lien), '#0f172a') >= 4.5,
      'réglages couleur (violet) et theme sombre : appliqués (' + enHex(c.plein) + ', fond ' + enHex(c.fond) + ', liens ' + enHex(c.lien) + ')');
    await x.ctx.close();
    // f) Page sombre avec sa variable : fenêtre sombre, le bleu clair de la page, texte presque noir sur le bouton.
    remettre();
    x = await page({ width: 1280, height: 900 }, { cle: CLE, theme: 'dark', init: () => { document.addEventListener('DOMContentLoaded', () => document.documentElement.style.setProperty('--accent', '#5aa9ff')); } });
    c = await ouvrirEtLire(x.p);
    ok(c.teinte.sombre && enHex(c.fond) === '#0f172a' && enHex(c.plein) === '#5aa9ff' && enHex(c.texte) === '#0f172a',
      'page sombre (--accent #5aa9ff) : fenêtre sombre, bouton ' + enHex(c.plein) + ', texte ' + enHex(c.texte));
    await capture(x.p, 'couleur-page-sombre.png');
    // g) La page passe en clair pendant que la fenêtre est ouverte : la fenêtre suit.
    await x.p.emulateMedia({ colorScheme: 'light' });
    await x.p.waitForFunction(() => getComputedStyle(document.querySelector('.sgn-boite')).backgroundColor === 'rgb(255, 255, 255)', null, { timeout: 3000 }).then(() => ok(true, 'la page passe en clair, fenêtre ouverte : la fenêtre suit'), () => ok(false, 'la page passe en clair, fenêtre ouverte : la fenêtre suit'));
    ok(!x.erreursPage.length, 'aucune erreur JavaScript (page sombre)' + (x.erreursPage.length ? ' — ' + x.erreursPage.join(' ; ') : ''));
    await x.ctx.close();
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
      'https://770lab.com/gescom/', 'https://www.770lab.com/GesCom/clients', 'https://770lab.com/', 'https://770lab.com/autre', 'https://exemple.fr/home/', 'pas une adresse', '']) r[u] = S.projetDeLaPage(u);
    return { r, projets: S.projets.map((p) => p.id + '=' + p.nom).join(',') };
  });
  const REGLE = { 'https://770lab.com/home/robots.html': 'pupitre', 'https://770lab.com/home/robots': 'pupitre', 'https://770lab.com/home/': 'home', 'https://770lab.com/home': 'home',
    'https://www.770lab.com/HOME/journal': 'home', 'https://770lab.com/havroutia/recherche': 'havroutia', 'https://avinou-malkenou.web.app/cartes': 'avinou',
    'https://koulam.app/tehilim': 'koulam', 'https://770lab.com/gescom/': 'gescom', 'https://www.770lab.com/GesCom/clients': 'gescom', 'https://770lab.com/': null, 'https://770lab.com/autre': null, 'https://exemple.fr/home/': null, 'pas une adresse': null, '': null };
  const fausses = Object.keys(REGLE).filter((u) => regle.r[u] !== REGLE[u]);
  ok(!fausses.length, 'Signaler.projetDeLaPage : le projet d’une adresse, comme le relais' + (fausses.length ? ' — faux : ' + fausses.map((u) => u + ' → ' + regle.r[u]).join(' ; ') : ''));
  ok(regle.projets === 'home=Home,pupitre=Pupitre,havroutia=HavroutIA,veille=Veille,avinou=Avinou Malkenou,gescom=GesCom,koulam=KOULAM', 'Signaler.projets : les 7 projets, dans l’ordre du pupitre');
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
  ok(det && det.aTraiter === 4 && det.total === 10 && parProjet === 'home 1/3, pupitre 1/1, havroutia 1/2, avinou 1/2, gescom 0/0, koulam 0/1',
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
      const espionVibrer = () => p.evaluate(() => { window.__vib = []; Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (ms) => { window.__vib.push(ms); return true; } }); });
      await espionVibrer();
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
      const vib1 = await p.evaluate(() => window.__vib.slice());
      ok(vib1.length === 1 && vib1[0] === 15, dit + ' : soulevé, il vibre (15 ms) ; le déplacer n’est pas un toucher : pas la vibration du toucher (' + JSON.stringify(vib1) + ')');
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
      await espionVibrer();
      for (let k = 2; k <= 5; k++) {
        await ouvrirAvecPhoto(p, toucher, k);
        if (k === 2) { const vib2 = await p.evaluate(() => window.__vib.slice()); ok(vib2[0] === 10, dit + ' : un toucher court vibre (10 ms) et ouvre la fenêtre (' + JSON.stringify(vib2) + ')'); }
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
  }
  {   // (un bloc : ses noms ne croisent pas ceux des sections d'avant)
  console.log('11. Le VRAI relais (Worker entier, KV en mémoire) et l’empreinte de Chrome (authentificateur virtuel) : connexion, cartes avant / après, Annuler, Mettre en ligne, l’autre abonnement');
  // Un appareil avec son empreinte (Touch ID, capteur du téléphone) : l'authentificateur virtuel de Chrome, qui dit « oui » à la
  // vérification de la personne. cles : des clés d'accès à y recopier (le même téléphone, dans une autre page).
  const authentificateur = async (p, cles = []) => {
    const cdp = await p.context().newCDPSession(p);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    for (const c of cles) await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: c });
    return { cles: async () => (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials };
  };
  const copie = (c) => ({ credentialId: c.credentialId, isResidentCredential: true, rpId: c.rpId, privateKey: c.privateKey, userHandle: c.userHandle, signCount: c.signCount });
  // Le doigt (protocole de Chrome) et la place d'un élément, comme en 10.
  const cdps = new WeakMap();
  const doigt = async (p, type, x, y) => {
    if (!cdps.has(p)) cdps.set(p, await p.context().newCDPSession(p));
    await cdps.get(p).send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: Math.round(x), y: Math.round(y) }] });
  };
  const boite = (p, sel) => p.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });
  // Combien de fois la page a demandé l'empreinte (get) ou en a créé une (create).
  const COMPTEUR = () => {
    window.__webauthn = { get: 0, create: 0 };
    try {
      const c = navigator.credentials, g = c.get.bind(c), k = c.create.bind(c);
      c.get = (o) => { window.__webauthn.get++; return g(o); };
      c.create = (o) => { window.__webauthn.create++; return k(o); };
    } catch (e) {}
  };
  const surVrai = (taille, o = {}) => page(taille, Object.assign({ origine: LOCALHOST, relais: VRAI, init: COMPTEUR }, o));
  const webauthn = (p) => p.evaluate(() => window.__webauthn);
  const sessionDe = (p) => p.evaluate(() => { try { return JSON.parse(localStorage.getItem('signaler_session_v1') || 'null'); } catch (e) { return 'illisible'; } });
  const requetes = async () => (await ctl('journal')).filter((x) => x.m !== 'OPTIONS');
  const derniere = async (chemin) => (await requetes()).filter((x) => x.p === chemin).pop() || {};
  const ouvrirFenetre = async (p) => {
    if (!(await p.$('.sgn-boite'))) await p.click('.sgn-fab', { position: { x: 24, y: 30 } });
    await p.waitForSelector('.sgn-boite .sgn-texte', { timeout: 20000 });
  };
  const transmis = (p) => p.waitForFunction(() => /^Transmis à Claude/.test((document.querySelector('.sgn-etat.ok') || {}).textContent || ''), null, { timeout: 20000 });
  const envoyerTexte = async (p, t) => { await ouvrirFenetre(p); await p.fill('.sgn-texte', t); await p.click('.sgn-envoyer'); await transmis(p); };
  const etatDit = (p, rx, delai = 15000) => p.waitForFunction((s) => new RegExp(s).test((document.querySelector('.sgn-etat') || {}).textContent || ''), rx.source, { timeout: delai });
  // Une demande de marie faite de serveur à serveur (sa clé, l'origine de la page), puis le RETOUR de la « routine » avec le jeton
  // que le relais a écrit dans le texte qu'elle a reçu.
  const enNode = (chemin, o = {}) => fetch(VRAI + chemin, { method: o.corps === undefined ? 'GET' : 'POST',
    headers: Object.assign({ Origin: LOCALHOST, 'X-Signaler-Cle': o.cle || CLE }, o.corps === undefined ? {} : { 'Content-Type': 'application/json' }),
    body: o.corps === undefined ? undefined : JSON.stringify(o.corps) }).then((r) => r.json());
  const signalerNode = (t, url) => enNode('/signaler', { corps: { type: 'bug', texte: t, captures: [], contexte: { url: url || LOCALHOST + '/demo/index.html', titre: 'Démo' } } });
  const jetonDe = async (ref) => {
    const rx = new RegExp('"id":"' + ref + '","cle":"([0-9a-f]{32})"');
    for (const a of (await ctl('appels')).reverse()) { const x = rx.exec(a.text || ''); if (x) return x[1]; }
    return '';
  };
  const retourDe = async (ref, corps) => (await fetch(VRAI + '/retour', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ id: ref, cle: await jetonDe(ref) }, corps)) })).json();
  const carteVue = (p, id) => p.$eval('.sgn-carte[data-id="' + id + '"]', (c) => ({
    pil: c.querySelector('.sgn-pil').textContent, meta: c.querySelector('.sgn-carte-h').textContent.replace(/\s+/g, ' ').trim(),
    notes: [...c.querySelectorAll('.sgn-carte-r')].map((x) => x.textContent).join(' / '),
    rangs: [...c.querySelectorAll('.sgn-actions')].map((r) => [...r.children].map((x) => x.textContent.trim())),
    vign: [...c.querySelectorAll('.sgn-ap')].map((b) => b.querySelector('span').textContent + ' ' + b.querySelector('img').getAttribute('src')) })).catch(() => null);
  const imagesChargees = (p, sel) => p.waitForFunction((s) => [...document.querySelectorAll(s)].every((c) => [...c.querySelectorAll('img')].every((i) => i.complete && i.naturalWidth > 0)),
    sel, { timeout: 8000 }).catch(() => null);
  const versCarte = (p, id) => p.$eval('.sgn-carte[data-id="' + id + '"]', (c) => c.scrollIntoView({ block: 'start' }));
  const actualiser = async (p, toucher) => { await (toucher ? p.tap('[data-a="actualiser"]') : p.click('[data-a="actualiser"]')); await p.waitForFunction(() => !document.querySelector('[data-a="actualiser"][disabled]') && !/Actualisation/.test(document.querySelector('.sgn-etat') ? document.querySelector('.sgn-etat').textContent : ''), null, { timeout: 15000 }); };

  // a) Un appareil qui a la clé d'équipe : il envoie, puis « Activer l’empreinte sur cet appareil ? » (une fois).
  const A = await surVrai({ width: 412, height: 915 }, { cle: CLE });
  const telA = await authentificateur(A.p);
  await envoyerTexte(A.p, 'Premier envoi avec la clé, sur le vrai relais');
  ok((await derniere('/signaler')).par === 'cle', 'vrai relais : l’envoi part avec la clé d’équipe (X-Signaler-Cle)');
  const offreVue = await A.p.waitForSelector('.sgn-offre', { timeout: 6000 }).catch(() => null);
  ok(!!offreVue && /Activer l’empreinte sur cet appareil \?/.test(await texte(A.p, '.sgn-offre')) && (await requetes()).some((x) => x.m === 'GET' && x.p === '/auth/options/connexion'),
    'envoyé avec la clé, l’empreinte réglée sur le relais (GET /auth/options/connexion, pas 503) : « Activer l’empreinte sur cet appareil ? » est proposé');
  ok((await A.p.evaluate(() => localStorage.getItem('signaler_empreinte_proposee_v1'))) === '1', 'la proposition est notée dans ce navigateur (une seule fois)');
  let pb11 = await controler(A.p);
  await capture(A.p, 'empreinte-offre-412-light-a.png');
  await A.p.waitForTimeout(8600);
  ok(!!(await A.p.$('.sgn-offre')), 'tant que la proposition est là, la fenêtre ne se ferme pas d’elle-même (8 s)');
  await A.p.click('[data-a="activer"]');
  await etatDit(A.p, /Empreinte activée sur cet appareil/);
  const clesA = await telA.cles(), sA = await sessionDe(A.p), appareils = await ctl('kv?prefixe=appareil:');
  ok(clesA.length === 1 && clesA[0].isResidentCredential && clesA[0].rpId === 'localhost' && (await webauthn(A.p)).create === 1,
    '« Activer l’empreinte » : une clé d’accès créée sur l’appareil (découvrable, rpId = localhost, le nom d’hôte de la page)');
  ok(appareils.length === 1 && sA && sA.qui === 'marie' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(sA.session) && Math.abs(sA.exp - Date.now() - 30 * 24 * 3600000) < 120000,
    'le relais l’a vérifiée (attestation, UP + UV) et rangée (appareil:<id>) ; la session de 30 jours est gardée (signaler_session_v1, marie)');
  ok(!(await A.p.$('.sgn-offre')) && /Connexion par empreinte \(marie\)/.test(await texte(A.p, '.sgn-pied')), 'la proposition disparaît ; le bas de la fenêtre dit « Connexion par empreinte (marie) »');
  await envoyerTexte(A.p, 'Deuxième envoi : la session suffit');
  ok((await derniere('/signaler')).par === 'session', 'l’envoi suivant passe par la session (Authorization: Bearer), plus par la clé');
  await A.p.click('[data-a="deconnecter"]');
  ok(!(await sessionDe(A.p)) && !!(await A.p.evaluate(() => localStorage.getItem('signaler_cle_v1'))) && /^Déconnecté sur cet appareil/.test(await texte(A.p, '.sgn-etat')),
    '« Se déconnecter » : la session est oubliée, la clé d’équipe reste');
  await envoyerTexte(A.p, 'Troisième envoi, de nouveau avec la clé');
  await A.p.waitForTimeout(1500);
  ok(!(await A.p.$('.sgn-offre')) && (await derniere('/signaler')).par === 'cle', 'de nouveau avec la clé : l’empreinte n’est pas reproposée (une seule fois)');
  ok(!pb11.length && !A.erreursPage.length, 'la proposition : mise en page à 412 px' + (pb11.length ? ' — ' + pb11.join(' ; ') : '') + (A.erreursPage.length ? ' — ' + A.erreursPage.join(' ; ') : ''));
  await A.ctx.close();

  // b) Le même téléphone dans une page sans clé ni session : « Se connecter avec l’empreinte », « J’ai une clé ».
  const Bp = await surVrai({ width: 412, height: 915 });
  const telB = await authentificateur(Bp.p, clesA.map(copie));
  await ouvrirFenetre(Bp.p);
  await Bp.p.waitForTimeout(400);
  ok(!!(await Bp.p.$('.sgn-acces [data-a="empreinte"]')) && !(await Bp.p.$('.sgn-cle')) && !!(await Bp.p.$('.sgn-acces [data-a="jaicle"]')),
    'ni session ni clé : « Se connecter avec l’empreinte » à la place du champ de la clé, avec « J’ai une clé »');
  ok((await requetes()).slice(-3).some((x) => x.m === 'POST' && x.p === '/auth/options/connexion' && !x.par), 'le défi est demandé d’avance, sans clé (l’empreinte part dans le geste même)');
  await Bp.p.click('[data-a="jaicle"]');
  ok(!!(await Bp.p.$('.sgn-acces .sgn-cle')) && !!(await Bp.p.$('.sgn-acces [data-a="sanscle"]')) && (await Bp.p.evaluate(() => document.activeElement && document.activeElement.classList.contains('sgn-cle'))),
    '« J’ai une clé » : l’ancien champ (le curseur y est), avec de quoi revenir à l’empreinte');
  await Bp.p.click('[data-a="sanscle"]');
  ok(!!(await Bp.p.$('.sgn-acces [data-a="empreinte"]')), '« Se connecter avec l’empreinte » y ramène');
  await Bp.p.fill('.sgn-texte', 'Envoyé sans clé : « Envoyer » demande l’empreinte');
  await Bp.p.click('.sgn-envoyer');
  await transmis(Bp.p);
  const sB = await sessionDe(Bp.p);
  ok((await webauthn(Bp.p)).get === 1 && (await derniere('/signaler')).par === 'session' && sB && sB.qui === 'marie', '« Envoyer » sans connexion : l’empreinte (une fois, connexion vérifiée par le relais), puis l’envoi avec la session de marie');
  await Bp.p.waitForTimeout(800);
  ok(!(await Bp.p.$('.sgn-offre')) && !Bp.erreursPage.length, 'connecté par l’empreinte : rien à proposer, aucune erreur JavaScript');
  const clesB = await telB.cles();
  await Bp.ctx.close();

  // c) Des demandes de marie dans tous les états, par le vrai /retour : captures avant / après (de vraies photos de la démo à 412 px).
  const shot = await surVrai({ width: 412, height: 915 });
  await shot.p.waitForSelector('.sgn-fab'); await shot.p.evaluate(() => window.Signaler.cacher());
  const jpeg = async () => 'data:image/jpeg;base64,' + (await shot.p.screenshot({ type: 'jpeg', quality: 70 })).toString('base64');
  const AVANT = await jpeg();
  await shot.p.evaluate(() => { const b = document.getElementById('panne'); b.textContent = 'Enregistrer'; b.style.cssText = 'background:#16a34a;color:#fff;border-color:#16a34a'; document.querySelector('h1').textContent = 'Une application de démonstration, corrigée'; });
  const APRES = await jpeg();
  await shot.ctx.close();
  const PR = (n, d = '770lab/home') => 'https://github.com/' + d + '/pull/' + n;
  const R1 = (await signalerNode('Le total des dossiers est faux sur l’accueil.')).ref;
  const r1 = await retourDe(R1, { etat: 'a_valider', resume: 'Le total est corrigé ; la PR attend ta validation.', liens: [PR(77)], images: { avant: AVANT, apres: APRES }, apercu: 'https://770lab.github.io/apercu/77/' });
  const R2 = (await signalerNode('Le bouton Enregistrer ne répond pas.')).ref;
  const r2 = await retourDe(R2, { etat: 'en_ligne', resume: 'Corrigé et vérifié en ligne.', liens: [PR(76)], images: { avant: AVANT, apres: APRES },
    annulation: { depot: '770lab/home', commits: ['0a1b2c3d4e5f6a7'], branche: 'main' } });
  const R3 = (await signalerNode('Le bouton Partager ne fait rien.', 'https://avinou-malkenou.web.app/cartes')).ref;
  const r3 = await retourDe(R3, { etat: 'a_valider', resume: 'Corrigé dans une PR.', liens: [PR(12, '770lab/avinou-malkenou')], images: { avant: AVANT, apres: APRES } });
  await ctl('routine', { trig_01UN: 429 });
  const R4 = (await signalerNode('La recherche est lente le soir.')).ref;
  await ctl('routine', { trig_01UN: 200 });
  const essais4 = (await ctl('appels')).slice(-2).map((a) => a.trig + ' ' + a.statut).join(', ');
  ok(R1 && R2 && R3 && R4 && r1.ok && r2.ok && r3.ok && essais4 === 'trig_01UN 429, trig_02DEUX 200', 'demandes rangées et revenues (à valider, en ligne, Avinou) ; l’abonnement 1 sans crédit (429) : le relais passe aussitôt au 2 (' + essais4 + ')');

  // d) La mise en page de la connexion, de la proposition, des cartes et de la visionneuse : 360, 412, 768, 1280 px, clair et sombre.
  for (const [w, ht] of [[360, 780], [412, 915], [768, 1024], [1280, 900]]) {
    for (const theme of ['light', 'dark']) {
      const nom = w + '-' + theme, q = await surVrai({ width: w, height: ht }, { theme });
      await authentificateur(q.p);   // l'empreinte de l'appareil, sans clé d'accès encore
      let pb = [];
      await ouvrirFenetre(q.p);
      await q.p.waitForSelector('.sgn-acces [data-a="empreinte"]');
      await q.p.waitForTimeout(250);
      pb = pb.concat(await controler(q.p));
      await capture(q.p, 'empreinte-connexion-' + nom + '.png');
      await q.p.$eval('.sgn-boite', (b) => { b.scrollTop = b.scrollHeight; });
      const lig = await q.p.$eval('.sgn-acces [data-a="empreinte"]', (b) => ({ h: b.getBoundingClientRect().height, l: parseFloat(getComputedStyle(b).lineHeight) || 20 }));
      if (lig.h > 52) pb.push('« Se connecter avec l’empreinte » sur deux lignes (' + Math.round(lig.h) + ' px)');
      await capture(q.p, 'empreinte-connexion-bas-' + nom + '.png');
      // La clé de paul (« J’ai une clé ») : un envoi, puis la proposition d'activer l'empreinte.
      await q.p.click('[data-a="jaicle"]');
      await q.p.fill('.sgn-cle', CLE_PAUL);
      await envoyerTexte(q.p, 'Essai de mise en page (' + nom + ')');
      const vue = !!(await q.p.waitForSelector('.sgn-offre', { timeout: 6000 }).catch(() => null));
      pb = pb.concat(await controler(q.p));
      await capture(q.p, 'empreinte-offre-' + nom + '.png');
      // La session de marie : ses demandes, avec les captures avant / après.
      await q.p.evaluate((s) => localStorage.setItem('signaler_session_v1', JSON.stringify(s)), sB);
      await q.p.evaluate(() => window.Signaler.demandes('toutes'));
      await q.p.waitForSelector('.sgn-carte[data-id="' + R1 + '"]', { timeout: 10000 });
      await imagesChargees(q.p, '.sgn-carte[data-id="' + R3 + '"]');
      pb = pb.concat(await controler(q.p));
      await capture(q.p, 'cartes-' + nom + '.png');
      await versCarte(q.p, R2);
      await imagesChargees(q.p, '.sgn-carte[data-id="' + R2 + '"], .sgn-carte[data-id="' + R1 + '"]');
      pb = pb.concat(await controler(q.p));
      await capture(q.p, 'cartes-actions-' + nom + '.png');
      await q.p.click('.sgn-carte[data-id="' + R1 + '"] [data-k="avant"]');
      await q.p.waitForFunction(() => { const i = document.querySelector('.sgn-vis img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 8000 });
      pb = pb.concat(await controler(q.p));
      const vi = await boite(q.p, '.sgn-vis img');
      await capture(q.p, 'visionneuse-' + nom + '.png');
      ok(vue && (vi.w > w * 0.6 || vi.h > ht * 0.6) && vi.x >= 0 && vi.x + vi.w <= w && vi.y + vi.h <= ht && !pb.length && !q.erreursPage.length,
        nom + ' : connexion, proposition, cartes avant / après, visionneuse (' + Math.round(vi.w) + ' × ' + Math.round(vi.h) + ') : rien ne déborde, 3 boutons par rangée au plus, ni italique ni émoji'
        + (pb.length ? ' — ' + [...new Set(pb)].join(' ; ') : '') + (q.erreursPage.length ? ' — ' + q.erreursPage.join(' ; ') : ''));
      await q.ctx.close();
    }
  }

  // e) « Mes demandes » de bout en bout, au doigt (412 px), avec le même téléphone.
  const Dp = await surVrai({ width: 412, height: 915 }, { toucher: true });
  await authentificateur(Dp.p, clesB.map(copie));
  await Dp.p.waitForSelector('.sgn-fab');
  await Dp.p.evaluate(() => window.Signaler.demandes('toutes'));
  await Dp.p.waitForSelector('.sgn-acces [data-a="empreinte"]');
  ok(/Pour voir tes demandes/.test(await texte(Dp.p, '.sgn-acces')) && !(await Dp.p.$('.sgn-cle')), '« Mes demandes » sans connexion : « Se connecter avec l’empreinte » d’abord');
  await Dp.p.tap('.sgn-acces [data-a="empreinte"]');
  await Dp.p.waitForSelector('.sgn-carte[data-id="' + R1 + '"]', { timeout: 15000 });
  ok((await webauthn(Dp.p)).get === 1 && (await derniere('/demandes')).par === 'session', 'connecté par l’empreinte, la liste s’ouvre (GET /demandes avec la session)');
  let c1 = await carteVue(Dp.p, R1), c2 = await carteVue(Dp.p, R2), c3 = await carteVue(Dp.p, R3), c4 = await carteVue(Dp.p, R4);
  const piece = (v) => v.startsWith('Avant ' + VRAI + '/piece/') || v.startsWith('Après ' + VRAI + '/piece/');
  ok(c1.pil === 'à valider' && c1.meta.endsWith(' · via abonnement 1') && c1.rangs.map((r) => r.join(' | ')).join(' / ') === 'Mettre en ligne | Voir la PR / Ouvrir dans Claude | Voir l’aperçu'
    && c1.vign.length === 2 && c1.vign.every(piece) && /attend ta validation/.test(c1.notes), 'à valider : « via abonnement 1 », avant / après (servies par le relais), « Mettre en ligne » et « Voir la PR », puis les liens');
  ok(c2.pil === 'en ligne' && c2.rangs.map((r) => r.join(' | ')).join(' / ') === 'Annuler / Ouvrir dans Claude | Voir la PR' && c2.vign.length === 2, 'en ligne, avec de quoi annuler : « Annuler »');
  ok(c3.pil === 'à valider' && / · Avinou Malkenou · /.test(c3.meta) && /mis en ligne par son propriétaire, depuis son Mac/.test(c3.notes) && !c3.rangs.flat().includes('Mettre en ligne') && c3.rangs[0].join() === 'Voir la PR',
    'Avinou Malkenou à valider : pas de « Mettre en ligne », une ligne dit que son propriétaire le met en ligne depuis son Mac');
  ok(c4.pil === 'en cours' && c4.meta.endsWith(' · via abonnement 2') && !c4.rangs.flat().some((t) => /Renvoyer/.test(t)), 'prise par l’abonnement 2 (le 1 sans crédit), en cours depuis peu : pas de « Renvoyer »');
  ok((await Dp.p.$$eval('.sgn-filtre', (l) => l.map((x) => x.textContent.replace(/\s+/g, ' ').trim()))).join(' | ').includes('À traiter 2') && (await Dp.p.textContent('.sgn-badge')) === '2',
    '« À traiter » compte les deux modifications à valider (le nombre du rond aussi)');
  // « Mettre en ligne », connecté par l'empreinte à l'instant : pas d'empreinte de plus.
  let n0 = (await ctl('appels')).length;
  await Dp.p.tap('.sgn-carte[data-id="' + R1 + '"] [data-a="valider"]');
  await etatDit(Dp.p, /^Mise en ligne lancée/);
  let av = (await ctl('appels')).slice(n0);
  ok((await webauthn(Dp.p)).get === 1 && av.length === 1 && av[0].text.startsWith(Coeur.MARQUE_VALIDER) && av[0].text.includes(PR(77)) && av[0].text.includes('Validé par : marie'),
    '« Mettre en ligne » (connecté par l’empreinte) : pas d’empreinte de plus ; la routine reçoit le travail VALIDER avec la PR');
  c1 = await carteVue(Dp.p, R1);
  ok(c1.pil === 'mise en ligne en cours' && !c1.rangs.flat().includes('Mettre en ligne'), 'la carte passe à « mise en ligne en cours »');
  await versCarte(Dp.p, R1);
  await capture(Dp.p, 'mise-en-ligne-lancee-412-light.png');
  ok((await retourDe(R1, { etat: 'en_ligne', resume: 'Fusionnée et vérifiée sur la vraie adresse.', images: { apres: APRES }, annulation: { depot: '770lab/home', commits: ['89abcdef0123'] } })).ok, 'la routine renvoie « en ligne », avec de quoi annuler');
  // « Annuler » : un toucher court ne fait rien ; garder appuyé 1,2 s lance l'annulation.
  await versCarte(Dp.p, R2);
  const selA = '.sgn-carte[data-id="' + R2 + '"] [data-a="annuler"]';
  n0 = (await ctl('appels')).length;
  await Dp.p.tap(selA);
  await Dp.p.waitForTimeout(300);
  ok(/^Pas annulé : garde le doigt/.test(await texte(Dp.p, '.sgn-etat')) && (await ctl('appels')).length === n0 && (await carteVue(Dp.p, R2)).pil === 'en ligne', '« Annuler » touché brièvement : rien ne part, on dit de garder appuyé');
  const bA = await boite(Dp.p, selA);
  await doigt(Dp.p, 'touchStart', bA.cx, bA.cy);
  await attendre(600);
  const mi = await Dp.p.$eval(selA, (b) => ({ tient: b.classList.contains('sgn-tient'), t: getComputedStyle(b, '::before').transform }));
  await capture(Dp.p, 'annuler-appui-412-light.png');
  await attendre(800);
  await doigt(Dp.p, 'touchEnd');
  await etatDit(Dp.p, /^Annulation lancée/);
  av = (await ctl('appels')).slice(n0);
  ok(mi.tient && av.length === 1 && av[0].text.startsWith(Coeur.MARQUE_ANNULER) && av[0].text.includes('0a1b2c3d4e5f6a7'), '« Annuler » gardé appuyé 1,4 s (il se remplit) : la routine reçoit le travail ANNULER avec le commit à défaire');
  ok((await carteVue(Dp.p, R2)).pil === 'annulation en cours', 'la carte passe à « annulation en cours »');
  ok((await retourDe(R2, { etat: 'annulee', resume: 'Le changement est retiré ; le site est revenu comme avant.' })).ok, 'la routine renvoie « annulee »');
  await actualiser(Dp.p, true);
  ok((await carteVue(Dp.p, R2)).pil === 'annulée' && !(await Dp.p.$(selA)), 'après « Actualiser » : « annulée », plus de bouton Annuler');
  // La visionneuse : avant / après en plein écran, Échap ou « Fermer ».
  await versCarte(Dp.p, R1);
  await Dp.p.tap('.sgn-carte[data-id="' + R1 + '"] [data-k="avant"]');
  await Dp.p.waitForFunction(() => { const i = document.querySelector('.sgn-vis img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 8000 });
  const v1 = await Dp.p.evaluate(() => ({ b: [...document.querySelectorAll('.sgn-vis button')].map((x) => x.textContent + (x.getAttribute('aria-pressed') === 'true' ? '*' : '')).join(' | '),
    l: document.querySelector('.sgn-vis-l').textContent, f: document.activeElement && document.activeElement.textContent }));
  await Dp.p.tap('.sgn-vis [data-v="apres"]');
  const v2 = await Dp.p.evaluate(() => ({ l: document.querySelector('.sgn-vis-l').textContent, src: document.querySelector('.sgn-vis img').getAttribute('src') }));
  ok(v1.b === 'Avant* | Après | Fermer' && v1.l === 'Avant le changement' && v1.f === 'Fermer' && v2.l === 'Après le changement (en ligne)' && v2.src.startsWith(VRAI + '/piece/'),
    'toucher « Avant » : la capture en plein écran (Avant / Après / Fermer), « Après » montre l’autre');
  await capture(Dp.p, 'visionneuse-apres-412-light.png');
  await Dp.p.keyboard.press('Escape');
  ok(!(await Dp.p.$('.sgn-vis')) && !!(await Dp.p.$('.sgn-boite')), 'Échap ferme la capture en plein écran, pas la fenêtre');
  await Dp.p.tap('.sgn-carte[data-id="' + R1 + '"] [data-k="apres"]');
  await Dp.p.waitForSelector('.sgn-vis');
  await Dp.p.tap('.sgn-vis [data-v="fermer"]');
  ok(!(await Dp.p.$('.sgn-vis')) && (await Dp.p.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-k'))) === 'apres', '« Fermer » aussi ; le focus revient sur la vignette');
  // Connecté par l'empreinte il y a plus de 5 minutes : « Mettre en ligne » part TOUT DE SUITE, sans seconde empreinte
  // (choix du propriétaire, 2026-10-22 : la clé ou la session suffit, la page et le relais d'accord).
  const R5 = (await signalerNode('Le menu se ferme tout seul.')).ref;
  await retourDe(R5, { etat: 'a_valider', resume: 'Corrigé dans une PR.', liens: [PR(78)], images: { avant: AVANT, apres: APRES } });
  await ctl('decalage', { ms: 6 * 60000 });
  await Dp.p.evaluate((ms) => { const n = Date.now.bind(Date); Date.now = () => n() + ms; }, 6 * 60000);
  await actualiser(Dp.p, true);
  let j0 = (await requetes()).length, g0 = (await webauthn(Dp.p)).get;
  n0 = (await ctl('appels')).length;
  await versCarte(Dp.p, R5);
  await Dp.p.tap('.sgn-carte[data-id="' + R5 + '"] [data-a="valider"]');
  await etatDit(Dp.p, /^Mise en ligne lancée/);
  let suite = (await requetes()).slice(j0).filter((x) => x.m === 'POST').map((x) => x.p.replace(R5, '<réf>'));
  av = (await ctl('appels')).slice(n0);
  ok((await webauthn(Dp.p)).get === g0 && suite.join(', ') === '/demandes/<réf>/valider' && av.length === 1 && av[0].text.includes(PR(78)),
    'connecté par l’empreinte il y a 6 minutes : « Mettre en ligne » part sans seconde empreinte (' + suite.join(', ') + ')');
  // Le relais, 12 minutes après l'empreinte (sa montre avance) : la session suffit toujours, pas de 403.
  const R6 = (await signalerNode('Le bouton Imprimer est caché.')).ref;
  await retourDe(R6, { etat: 'a_valider', resume: 'Corrigé dans une PR.', liens: [PR(79)] });
  await ctl('decalage', { ms: 12 * 60000 });
  await actualiser(Dp.p, true);
  j0 = (await requetes()).length; g0 = (await webauthn(Dp.p)).get; n0 = (await ctl('appels')).length;
  await versCarte(Dp.p, R6);
  await Dp.p.tap('.sgn-carte[data-id="' + R6 + '"] [data-a="valider"]');
  await etatDit(Dp.p, /^Mise en ligne lancée/);
  suite = (await requetes()).slice(j0).filter((x) => x.m === 'POST').map((x) => x.p.replace(R6, '<réf>'));
  av = (await ctl('appels')).slice(n0);
  ok((await webauthn(Dp.p)).get === g0 && suite.join(', ') === '/demandes/<réf>/valider' && av.length === 1 && av[0].text.includes(PR(79)),
    'le relais 12 minutes après l’empreinte : la session suffit, mise en ligne sans 403 (' + suite.join(', ') + ')');
  // Sans nouvelle depuis 15 minutes : « Renvoyer » et « Renvoyer sur l’autre abonnement ».
  await ctl('decalage', { ms: 17 * 60000 });
  await actualiser(Dp.p, true);
  await Dp.p.waitForFunction((id) => !!document.querySelector('.sgn-carte[data-id="' + id + '"] [data-ab]'), R4, { timeout: 8000 }).catch(() => {});
  c4 = await carteVue(Dp.p, R4);
  ok(c4.rangs[0].join(' | ') === 'Renvoyer | Renvoyer sur l’autre abonnement' && /Pas de nouvelle de Claude depuis plus de 15 minutes/.test(c4.notes) && (await derniere('/routine')).par === 'session',
    'en cours, sans nouvelle depuis 15 minutes : « Renvoyer » et « Renvoyer sur l’autre abonnement » (les abonnements lus par GET /routine)');
  await versCarte(Dp.p, R4);
  await capture(Dp.p, 'autre-abonnement-412-light.png');
  pb11 = await controler(Dp.p);
  n0 = (await ctl('appels')).length;
  await Dp.p.tap('.sgn-carte[data-id="' + R4 + '"] [data-ab="1"]');
  await etatDit(Dp.p, /^Renvoyée à Claude \(abonnement 1\)\.$/);
  av = (await ctl('appels')).slice(n0);
  c4 = await carteVue(Dp.p, R4);
  ok(av.length === 1 && av[0].trig === 'trig_01UN' && av[0].text.includes('La recherche est lente le soir.') && c4.meta.endsWith(' · via abonnement 1') && !c4.rangs.flat().some((t) => /Renvoyer/.test(t)),
    '« Renvoyer sur l’autre abonnement » : la routine du 1 (choisie, même notée sans crédit), la carte dit « via abonnement 1 »');
  ok(!pb11.length, 'mise en page des cartes à 412 px' + (pb11.length ? ' — ' + pb11.join(' ; ') : ''));
  const boiteNoire = JSON.stringify(await Dp.p.evaluate(() => window.Signaler._journal()));
  ok(!boiteNoire.includes((await sessionDe(Dp.p)).session.split('.')[1]) && !/auth\/|Bearer/.test(boiteNoire), 'la boîte noire ne garde rien des appels du bouton (ni /auth, ni la session)');
  // La session expire (30 jours passés à la montre du relais) : 401, la page l'oublie et redemande l'empreinte.
  await ctl('decalage', { ms: 31 * 24 * 3600000 });
  await actualiser(Dp.p, true);
  await Dp.p.waitForSelector('.sgn-erreur', { timeout: 8000 }).catch(() => {});
  ok(/^Ta connexion a expiré/.test(await texte(Dp.p, '.sgn-erreur')) && !(await sessionDe(Dp.p)) && !!(await Dp.p.$('.sgn-acces [data-a="empreinte"]')),
    'session expirée au relais (401) : la page l’oublie, le dit, et propose l’empreinte');
  await capture(Dp.p, 'session-expiree-412-light.png');
  await Dp.p.tap('.sgn-acces [data-a="empreinte"]');
  await Dp.p.waitForSelector('.sgn-carte', { timeout: 15000 });
  ok(!!(await sessionDe(Dp.p)) && (await derniere('/demandes')).par === 'session', 'l’empreinte de nouveau : une session neuve, la liste revient');
  // Un appareil retiré (depuis le pupitre) : ses sessions ne valent plus rien, tout de suite ; l'empreinte est refusée.
  const mes = await enNode('/auth/appareils');
  const retire = mes.ok && mes.appareils.length === 1 ? await enNode('/auth/appareils/' + mes.appareils[0].id + '/retirer', { corps: {} }) : {};
  await actualiser(Dp.p, true);
  await Dp.p.waitForSelector('.sgn-erreur', { timeout: 8000 }).catch(() => {});
  ok(retire.ok && /^Ta connexion a expiré \(ou cet appareil a été retiré\)/.test(await texte(Dp.p, '.sgn-erreur')) && !(await sessionDe(Dp.p)), 'appareil retiré : la session est refusée aussitôt, la page l’oublie');
  await Dp.p.tap('.sgn-acces [data-a="empreinte"]');
  await etatDit(Dp.p, /^Empreinte refusée par le relais : appareil inconnu ou retiré/);
  ok(!(await sessionDe(Dp.p)) && !!(await Dp.p.$('.sgn-acces [data-a="empreinte"]')), 'et l’empreinte de cet appareil est refusée, on le dit');
  ok(!Dp.erreursPage.length, 'aucune erreur JavaScript' + (Dp.erreursPage.length ? ' — ' + Dp.erreursPage.join(' ; ') : ''));
  await ctl('decalage', { ms: 0 });
  await Dp.ctx.close();

  // f) Un ordinateur qui n'a que la clé d'équipe (ni session, ni clé d'accès pour ce site ; l'empreinte pourtant réglée sur le
  // relais) : « Mettre en ligne » part TOUT DE SUITE, sans demander l'empreinte (choix du propriétaire, 2026-10-22 : l'empreinte
  // sert à se connecter, plus à valider).
  const R7 = (await signalerNode('La date est en anglais.')).ref;
  await retourDe(R7, { etat: 'a_valider', resume: 'Corrigé dans une PR.', liens: [PR(80)], images: { avant: AVANT, apres: APRES } });
  const E = await surVrai({ width: 768, height: 1024 }, { cle: CLE, theme: 'dark' });
  await authentificateur(E.p);
  await E.p.waitForSelector('.sgn-fab');
  await E.p.evaluate(() => window.Signaler.demandes('toutes'));
  await E.p.waitForSelector('.sgn-carte[data-id="' + R7 + '"] [data-a="valider"]', { timeout: 10000 });
  pb11 = await controler(E.p);
  await capture(E.p, 'cle-seule-a-valider-768-dark.png');
  n0 = (await ctl('appels')).length;
  j0 = (await requetes()).length;
  await E.p.click('.sgn-carte[data-id="' + R7 + '"] [data-a="valider"]');
  await etatDit(E.p, /^Mise en ligne lancée/);
  av = (await ctl('appels')).slice(n0);
  suite = (await requetes()).slice(j0).filter((x) => x.m === 'POST').map((x) => x.p.replace(R7, '<réf>') + ' (' + x.par + ')');
  ok((await webauthn(E.p)).get === 0 && (await webauthn(E.p)).create === 0 && !(await sessionDe(E.p)) && suite.join(', ') === '/demandes/<réf>/valider (cle)'
    && av.length === 1 && av[0].text.startsWith(Coeur.MARQUE_VALIDER) && av[0].text.includes(PR(80)) && av[0].text.includes('Validé par : marie'),
    'la clé d’équipe seule : « Mettre en ligne » part (travail VALIDER), sans aucune empreinte demandée (' + suite.join(', ') + ')');
  ok(!(await E.p.$('.sgn-offre')) && !/empreinte/i.test(await texte(E.p, '.sgn-etat')), 'et rien ne parle d’empreinte à ce moment-là');
  await capture(E.p, 'cle-seule-met-en-ligne-768-dark.png');
  // « Annuler » à la souris : garder le bouton appuyé.
  ok((await retourDe(R7, { etat: 'en_ligne', resume: 'En ligne.', annulation: { depot: '770lab/home', commits: ['fedcba987654'] } })).ok, 'retour « en ligne »');
  await actualiser(E.p, false);
  const bE = await boite(E.p, '.sgn-carte[data-id="' + R7 + '"] [data-a="annuler"]');
  n0 = (await ctl('appels')).length;
  await E.p.mouse.move(bE.cx, bE.cy); await E.p.mouse.down(); await attendre(1400); await E.p.mouse.up();
  await etatDit(E.p, /^Annulation lancée/);
  ok((await ctl('appels')).slice(n0).some((a) => a.text.startsWith(Coeur.MARQUE_ANNULER) && a.text.includes('fedcba987654')), '« Annuler » gardé appuyé à la souris : le travail ANNULER part');
  ok(!pb11.length && !E.erreursPage.length, '768 px sombre : mise en page' + (pb11.length ? ' — ' + pb11.join(' ; ') : '') + (E.erreursPage.length ? ' — ' + E.erreursPage.join(' ; ') : ''));
  // g) « Annuler » à la souris (Chrome sur Mac, trackpad) à 360 px après un clic trop court, puis à 1280 px sur une liste qu'on
  // vient d'ouvrir : pendant l'appui, rien ne bouge au-dessus du bouton et il garde le pointeur (sinon Chrome voyait la souris
  // « sortir » du bouton immobile et l'appui tombait).
  for (const [w, hh, court] of [[360, 740, true], [1280, 800, false]]) {
    const R = (await signalerNode('Le titre est coupé (' + w + ' px).')).ref, sha = 'abcabc' + w + '0';
    ok((await retourDe(R, { etat: 'en_ligne', resume: 'En ligne.', images: { avant: AVANT, apres: APRES }, annulation: { depot: '770lab/home', commits: [sha] } })).ok, w + ' px : retour « en ligne »');
    await E.p.keyboard.press('Escape');
    await E.p.setViewportSize({ width: w, height: hh });
    await E.p.evaluate(() => window.Signaler.demandes('toutes'));
    const sel = '.sgn-carte[data-id="' + R + '"] [data-a="annuler"]';
    await E.p.waitForSelector(sel, { timeout: 10000 });
    // La liste en haut (comme à l'ouverture) : sans défilement, Chrome ne recale rien, un message qui change de hauteur décale le bouton.
    await E.p.$eval('.sgn-boite', (b) => { b.scrollTop = 0; });
    ok((await boite(E.p, sel)).y + 40 < hh, w + ' px : la nouvelle demande est en tête, son « Annuler » se voit sans défiler');
    n0 = (await ctl('appels')).length;
    if (court) {
      const b0 = await boite(E.p, sel);
      await E.p.mouse.click(b0.cx, b0.cy);
      await etatDit(E.p, /^Pas annulé : garde le doigt/);
      ok((await ctl('appels')).length === n0, w + ' px : clic trop court à la souris : rien ne part');
    }
    const b1 = await boite(E.p, sel);
    await E.p.mouse.move(b1.cx, b1.cy); await E.p.mouse.down();
    await attendre(500);
    const b2 = await boite(E.p, sel), tient = await E.p.$eval(sel, (b) => b.classList.contains('sgn-tient'));
    await capture(E.p, 'souris-annuler-' + w + '-dark.png');
    await attendre(900); await E.p.mouse.up();
    await etatDit(E.p, /^Annulation lancée/);
    ok(tient && Math.abs(b2.y - b1.y) < 1 && (await ctl('appels')).slice(n0).some((a) => a.text.startsWith(Coeur.MARQUE_ANNULER) && a.text.includes(sha)),
      w + ' px : « Annuler » gardé appuyé à la souris' + (court ? ' après un clic trop court' : ' sur une liste qu’on vient d’ouvrir') + ' : le bouton ne bouge pas, le travail ANNULER part'
      + (tient && Math.abs(b2.y - b1.y) < 1 ? '' : ' (tient ' + tient + ', décalage ' + (b2.y - b1.y) + ' px)'));
  }
  await E.ctx.close();
  // h) Une page dont la CSP refuse les images du relais mais admet blob: (img-src 'self' data: blob:, comme Avinou Malkenou qui
  // n'admet le relais qu'en connect-src) : les captures sont relues par fetch et montrées depuis la mémoire, en vignette et en grand.
  {
    const G = await surVrai({ width: 412, height: 915 }, { cle: CLE, csp: true });
    await G.p.waitForSelector('.sgn-fab');
    await G.p.evaluate(() => window.Signaler.demandes('toutes'));
    await G.p.waitForSelector('.sgn-carte .sgn-ap', { timeout: 10000 });
    const vues = await G.p.waitForFunction(() => {
      const im = [...document.querySelectorAll('.sgn-ap img')];
      return im.length >= 2 && im.every((i) => i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0) && !document.querySelector('.sgn-ap-ko');
    }, null, { timeout: 8000 }).then(() => true, () => false);
    await G.p.$eval('.sgn-ap[data-k="apres"]', (b) => b.scrollIntoView({ block: 'center' }));
    await capture(G.p, 'images-memoire-412-light.png');
    await G.p.click('.sgn-ap[data-k="apres"]');
    const grand = await G.p.waitForFunction(() => { const i = document.querySelector('.sgn-vis img'); return !!(i && i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0); }, null, { timeout: 8000 }).then(() => true, () => false);
    await capture(G.p, 'images-memoire-grand-412-light.png');
    ok(vues && grand, 'page dont la CSP refuse les images du relais (blob: admis) : les captures avant / après sont relues par fetch et montrées, en vignette et en grand'
      + (vues ? '' : ' (vignettes absentes)') + (grand ? '' : ' (visionneuse vide)'));
    await G.p.keyboard.press('Escape');
    // Verrouillage (Avinou Malkenou) : oublier() libère les images gardées en mémoire.
    const libere = await G.p.evaluate(async () => {
      const u = document.querySelector('.sgn-ap img') ? document.querySelector('.sgn-ap img').src : '';
      window.Signaler.oublier();
      try { await fetch(u); return false; } catch (e) { return true; }
    });
    ok(libere, 'oublier() libère les captures gardées en mémoire (l’adresse blob: ne répond plus)');
    // Verrouillage puis déverrouillage (config.js d'Avinou Malkenou : oublier() + cacher(), puis oublier() + montrer()) : le rond
    // existe déjà, la liste oubliée est relue et le nombre des demandes à traiter revient sans ouvrir la feuille.
    const nb = () => G.p.evaluate(() => { const n = document.querySelector('.sgn-badge'); return n && n.style.display !== 'none' ? n.textContent : ''; });
    await G.p.evaluate(() => { window.Signaler.cacher(); window.Signaler.oublier(); });
    const cache = await nb();
    await G.p.evaluate(() => { window.Signaler.oublier(); window.Signaler.montrer(); });
    const revient = await G.p.waitForFunction(() => { const n = document.querySelector('.sgn-badge'); return !!n && n.style.display !== 'none' && Number(n.textContent) > 0; }, null, { timeout: 8000 }).then(() => true, () => false);
    ok(cache === '' && revient && !(await G.p.$('.sgn-fond')), 'verrouillage puis déverrouillage (oublier, montrer) : le nombre des demandes à traiter revient, la feuille reste fermée'
      + (cache === '' ? '' : ' (nombre encore montré après oublier : ' + cache + ')') + (revient ? '' : ' (nombre absent après montrer)'));
    const pbM = await controler(G.p);
    ok(!pbM.length && !G.erreursPage.length, '412 px, images relues : mise en page' + (pbM.length ? ' — ' + pbM.join(' ; ') : '') + (G.erreursPage.length ? ' — ' + G.erreursPage.join(' ; ') : ''));
    await G.ctx.close();
  }
  // h2) Une page qui refuse aussi blob: (img-src 'self' data:) : la vignette le dit au lieu d'un cadre vide, et la toucher ouvre la
  // capture dans un nouvel onglet (adresse du relais).
  {
    const G = await surVrai({ width: 412, height: 915 }, { cle: CLE, csp: 'strict' });
    const LOGG = []; G.p.on('console', (m) => LOGG.push(m.type() + ': ' + m.text())); G.p.on('requestfailed', (r) => LOGG.push('échec ' + r.method() + ' ' + r.url() + ' ' + (r.failure() || {}).errorText));
    await G.p.waitForSelector('.sgn-fab');
    await G.p.evaluate(() => window.Signaler.demandes('toutes'));
    await G.p.waitForSelector('.sgn-carte .sgn-ap', { timeout: 10000 }).catch(async (e) => {
      await capture(G.p, 'images-refusees-ko.png');
      console.log('  (liste : ' + (await G.p.evaluate(() => (document.querySelector('.sgn-boite') || document.body).innerText.replace(/\s+/g, ' ').slice(0, 600))) + ')\n' + LOGG.join('\n'));
      throw e;
    });
    const ko = await G.p.waitForFunction(() => document.querySelectorAll('.sgn-ap.sgn-ap-ko').length >= 2, null, { timeout: 8000 }).then(() => true, () => false);
    const selV = '.sgn-ap.sgn-ap-ko[data-k="avant"]';
    await G.p.$eval(selV, (b) => b.scrollIntoView({ block: 'center' }));
    await capture(G.p, 'images-refusees-412-light.png');
    const [onglet] = await Promise.all([G.ctx.waitForEvent('page', { timeout: 8000 }), G.p.click(selV)]);
    ok(ko && /\/piece\/[0-9a-f]{32}$/.test(onglet.url()) && onglet.url().startsWith(VRAI) && !(await G.p.$('.sgn-vis')),
      'page qui refuse les images du relais : la vignette dit « Image bloquée par cette page », la toucher ouvre la capture dans un onglet');
    const pbG = await controler(G.p);
    ok(!pbG.length && !G.erreursPage.length, '412 px, images refusées : mise en page' + (pbG.length ? ' — ' + pbG.join(' ; ') : '') + (G.erreursPage.length ? ' — ' + G.erreursPage.join(' ; ') : ''));
    await G.ctx.close();
  }
  }
  console.log('  captures : ' + CAPTURES);
} catch (e) { ko++; console.log('  ✗ exception : ' + (e && e.stack || e)); }
finally { await navigateur.close(); site.close(); relais.close(); await fil.terminate(); }

console.log(ko ? '\n✗ ' + ko + ' échec(s)' : '\n✓ tout passe');
process.exit(ko ? 1 : 0);
