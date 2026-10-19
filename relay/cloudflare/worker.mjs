// Le relais « 🐞 Signaler » en Cloudflare Worker (offre gratuite suffisante). Il reçoit le signalement de la page, range captures et
// note vocale (R2 ou Workers KV), prévient la routine Claude Code, et garde chaque DEMANDE avec son état (« Mes demandes » du bouton).
// Réglages (voir wrangler.toml et INSTALL.md) :
//   vars    ORIGINES  les adresses des pages autorisées, séparées par des virgules (« https://app.exemple.fr »)
//           DEPOT     le dépôt GitHub à corriger (« proprietaire/depot »), recopié dans le texte de la routine
//           MONTRER_SUIVI « oui » : la page reçoit le lien de la session Claude (après l'envoi, et dans « Mes demandes »)
//   secrets ROUTINE_URL   https://api.anthropic.com/v1/claude_code/routines/trig_…/fire
//           ROUTINE_JETON le jeton de CETTE routine (sk-ant-oat01-…)
//           CLES          les clés d'équipe : « marie:<clé>,paul:<clé> » (16 caractères au moins chacune)
//   stockage (facultatif) : R2 PIECES, ou Workers KV PIECES_KV (inclus dans l'offre gratuite, sans abonnement R2 ; fichiers
//           effacés après 30 jours, demandes 180 jours après leur dernière nouvelle). Sans stockage, le signalement part sans
//           les fichiers (le texte le dit), sans « Mes demandes » ni interrupteur
//
// Routes : POST /signaler · GET /piece/<id> (une capture ou la note, sous une adresse de 128 bits)
//          GET /demandes (les miennes, d'après ma clé) · POST /demandes/<réf>/renvoyer (une demande pas partie)
//          POST /retour (la routine, de serveur à serveur : l'état de la demande, avec son jeton)
//          GET /etat[?projet=<id>] · POST /etat (les interrupteurs du pupitre : le bouton activé ou coupé partout, ou dans un
//          projet de C.PROJETS) · OPTIONS (CORS)
import * as C from '../coeur.mjs';

const PIECE_RX = /^\/piece\/([0-9a-f]{32})$/;
const RENVOI_RX = /^\/demandes\/([0-9a-f]{12})\/renvoyer$/;
const KV_DUREE_S = 30 * 24 * 3600;
const SANS_STOCKAGE = 'le relais n’a pas de stockage';
const COUPE = { ok: false, coupe: true, erreur: 'le bouton est coupé depuis le pupitre' };

// Le stockage, ramené à une seule forme : put/get pour les pièces (forme R2 : { body, httpMetadata }), lireTexte/ecrireTexte pour
// les demandes et l'interrupteur (du JSON). Workers KV : chaque pièce s'efface d'elle-même au bout de 30 jours, une demande au bout
// de la durée donnée ; sans durée (liste d'une personne, interrupteur), rien ne s'efface. R2 n'efface rien de lui-même (sauf règle
// de cycle de vie posée sur le bucket).
function stockage(env) {
  if (env.PIECES) {
    const r2 = env.PIECES;
    return {
      put: (id, octets, o) => r2.put(id, octets, o),
      get: (id) => r2.get(id),
      lireTexte: async (cle) => {
        const o = await r2.get(cle);
        if (!o) return null;
        return typeof o.text === 'function' ? o.text() : new Response(o.body).text();
      },
      // Étiqueté comme les pièces (genre) : « demande », « demandes » (une liste) ou « etat ».
      ecrireTexte: (cle, texte) => r2.put(cle, texte, { httpMetadata: { contentType: 'application/json' }, customMetadata: { genre: cle.split(':')[0] } }),
    };
  }
  const kv = env.PIECES_KV;
  if (!kv) return null;
  return {
    put: (id, octets, o) => kv.put(id, octets, { expirationTtl: KV_DUREE_S,
      metadata: Object.assign({ contentType: o.httpMetadata.contentType }, o.customMetadata || {}) }),
    get: async (id) => {
      const r = await kv.getWithMetadata(id, { type: 'arrayBuffer' });
      return r && r.value !== null ? { body: r.value, httpMetadata: { contentType: (r.metadata || {}).contentType } } : null;
    },
    lireTexte: (cle) => kv.get(cle),
    ecrireTexte: (cle, texte, dureeS) => (dureeS ? kv.put(cle, texte, { expirationTtl: dureeS }) : kv.put(cle, texte)),
  };
}

const lireJson = (t) => { try { return t ? JSON.parse(t) : null; } catch (e) { return null; } };
async function lireDemande(st, id) {
  const d = lireJson(await st.lireTexte(C.cleDemande(id)));
  return d && typeof d === 'object' && d.id === id ? d : null;
}
const ecrireDemande = (st, d) => st.ecrireTexte(C.cleDemande(d.id), JSON.stringify(d), C.LIMITES.demandeDureeS);
async function lireIndex(st, qui) {
  const x = lireJson(await st.lireTexte(C.cleIndex(qui)));
  return Array.isArray(x) ? x : [];
}
// Les interrupteurs (général et par projet). Stockage absent ou en panne : activés (le bouton marche comme avant plutôt que de se
// taire sans raison).
async function etatDuBouton(st) {
  if (!st) return C.etatBouton(null);
  try { return C.etatBouton(lireJson(await st.lireTexte(C.CLE_ETAT))); } catch (e) { return C.etatBouton(null); }
}

function entetesCors(req, env) {
  const o = req.headers.get('Origin') || '';
  const h = { 'Vary': 'Origin' };
  if (C.origineAutorisee(o, env.ORIGINES)) {
    h['Access-Control-Allow-Origin'] = o;
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type, X-Signaler-Cle';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}
const json = (corps, statut, entetes) => new Response(JSON.stringify(corps), { status: statut || 200,
  headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, entetes || {}) });

// Les vérifications communes aux routes des pages : l'origine (exigée, ou seulement vérifiée quand il y en a une), puis la clé
// d'équipe, qui donne le nom. Rend { qui } ou { refus: Response }.
function acces(req, env, cors, origineFacultative) {
  const o = req.headers.get('Origin');
  if ((o || !origineFacultative) && !C.origineAutorisee(o, env.ORIGINES)) return { refus: json({ ok: false, erreur: 'page non autorisée' }, 403, cors) };
  const qui = C.verifierCle(req.headers.get('X-Signaler-Cle'), env.CLES);
  if (!qui.ok) return { refus: json({ ok: false, cle: true, erreur: 'clé d’équipe absente ou inconnue' }, 401, cors) };
  return { qui: qui.nom };
}

// Un petit corps JSON (retour, interrupteur), pesé en octets. Rend { corps } ou { trop: true } ou { illisible: true }.
async function petitCorps(req, max) {
  if (Number(req.headers.get('Content-Length') || 0) > max) return { trop: true };
  let t;
  try { t = await req.text(); } catch (e) { return { illisible: true }; }
  if (new TextEncoder().encode(t).length > max) return { trop: true };
  try { return { corps: JSON.parse(t) }; } catch (e) { return { illisible: true }; }
}

export async function signaler(req, env, outils) {
  outils = outils || {};
  const cors = entetesCors(req, env);
  const a = acces(req, env, cors);
  if (a.refus) return a.refus;
  const taille = Number(req.headers.get('Content-Length') || 0);
  if (taille > C.LIMITES.corpsOctets) return json({ ok: false, erreur: 'signalement trop lourd' }, 413, cors);
  const st = stockage(env);
  // Coupé depuis le pupitre (partout, ou dans le projet de la page) : rien n'est rangé, la routine n'est pas appelée.
  const interrupteurs = await etatDuBouton(st);
  if (!interrupteurs.actif) return json(COUPE, 403, cors);
  let corps;
  try { const t = await req.text(); if (t.length > C.LIMITES.corpsOctets) return json({ ok: false, erreur: 'signalement trop lourd' }, 413, cors); corps = JSON.parse(t); }
  catch (e) { return json({ ok: false, erreur: 'signalement illisible' }, 400, cors); }
  const lu = C.lireSignalement(corps);
  if (!lu.ok) return json({ ok: false, erreur: lu.erreur }, 400, cors);
  // Le projet vient de l'adresse de la page (la même règle que le bouton).
  if (!C.boutonActif(interrupteurs, C.projetDeLaPage(lu.s.contexte.url))) return json(COUPE, 403, cors);
  const s = lu.s, ref = C.nouvelId().slice(0, 12), base = new URL(req.url).origin, pieces = [];
  if (st) {
    const ranger = async (genre, mime, octets, extra) => {
      const id = C.nouvelId();
      await st.put(id, octets, { httpMetadata: { contentType: mime }, customMetadata: { ref: ref, genre: genre } });
      pieces.push(Object.assign({ genre: genre, url: base + '/piece/' + id }, extra || {}));
    };
    for (const c of s.captures) await ranger('image', c.mime, c.octets, { ou: c.ou });
    if (s.audio) await ranger('audio', s.audio.mime, s.audio.octets, {});
  }
  // Le jeton de retour : écrit dans le texte de la routine (bloc RETOUR), jamais rangé ; seule son empreinte l'est.
  const quand = Date.now(), jeton = st ? C.nouvelId() : '';
  const texte = C.texteRoutine({ s: s, ref: ref, qui: a.qui, depot: env.DEPOT, pieces: pieces, quand: quand,
    retour: st ? { url: base + '/retour', id: ref, cle: jeton } : null });
  const r = await C.prevenirRoutine({ url: env.ROUTINE_URL, jeton: env.ROUTINE_JETON, texte: texte, fetch: outils.fetch, attendre: outils.attendre });
  let demande = false;
  if (st) {
    // Une demande qui ne se range pas (quota du stockage…) ne change rien à la réponse : la routine, elle, a été prévenue ou non.
    try {
      await ecrireDemande(st, C.nouvelleDemande({ id: ref, qui: a.qui, s: s, quand: quand, r: r, retourHash: await C.sha256Hex(jeton), texteRoutine: texte }));
      await st.ecrireTexte(C.cleIndex(a.qui), JSON.stringify(C.indexAvec(await lireIndex(st, a.qui), ref)));
      demande = true;
    } catch (e) { demande = false; }
  }
  // Le journal ne porte que des compteurs : ni le texte, ni les fichiers, ni les jetons.
  console.log('[signaler]', JSON.stringify({ ref: ref, qui: a.qui, images: s.captures.length, audio: !!s.audio, ok: r.ok, statut: r.statut || 0, demande: demande }));
  if (!r.ok) return json({ ok: false, ref: ref, erreur: C.messageRoutine(r) }, 502, cors);
  return json({ ok: true, ref: ref, suivi: env.MONTRER_SUIVI === 'oui' ? r.suivi : '' }, 200, cors);
}

// GET /demandes : les 20 dernières demandes de la personne dont c'est la clé, la plus récente d'abord.
export async function demandes(req, env) {
  const cors = entetesCors(req, env);
  const a = acces(req, env, cors);
  if (a.refus) return a.refus;
  const st = stockage(env);
  if (!st) return json({ ok: true, demandes: [], stockage: false }, 200, cors);
  const ids = (await lireIndex(st, a.qui)).slice(0, C.LIMITES.demandesListe);
  const liste = (await Promise.all(ids.map((id) => (C.REF_RX.test(String(id)) ? lireDemande(st, id) : null))))
    .filter((d) => d && d.qui === a.qui)
    .sort((x, y) => (y.creeLeMs || 0) - (x.creeLeMs || 0))
    .map((d) => C.demandePublique(d, { suivi: env.MONTRER_SUIVI === 'oui' }));
  return json({ ok: true, demandes: liste }, 200, cors);
}

// POST /demandes/<réf>/renvoyer : relance la routine pour une demande « pas partie », avec un jeton de retour neuf.
export async function renvoyer(req, env, outils, id) {
  outils = outils || {};
  const cors = entetesCors(req, env);
  const a = acces(req, env, cors);
  if (a.refus) return a.refus;
  const st = stockage(env);
  if (!st) return json({ ok: false, erreur: SANS_STOCKAGE }, 503, cors);
  const d = await lireDemande(st, id);
  // La demande d'un autre : la même réponse qu'une réf. inconnue.
  if (!d || d.qui !== a.qui) return json({ ok: false, erreur: 'demande introuvable' }, 404, cors);
  const suivi = env.MONTRER_SUIVI === 'oui';
  if (d.etat !== 'pas_partie' || !d.texteRoutine) return json({ ok: false, erreur: 'cette demande est déjà partie', demande: C.demandePublique(d, { suivi: suivi }) }, 409, cors);
  if (!C.boutonActif(await etatDuBouton(st), C.projetDeLaDemande(d))) return json(COUPE, 403, cors);
  const jeton = C.nouvelId(), quand = Date.now();
  const texte = C.avecRetour(d.texteRoutine, { url: new URL(req.url).origin + '/retour', id: id, cle: jeton });
  const r = await C.prevenirRoutine({ url: env.ROUTINE_URL, jeton: env.ROUTINE_JETON, texte: texte, fetch: outils.fetch, attendre: outils.attendre });
  const x = C.apresEnvoi(d, r, { quand: quand, retourHash: await C.sha256Hex(jeton), texteRoutine: texte });
  await ecrireDemande(st, x);
  console.log('[renvoyer]', JSON.stringify({ ref: id, qui: a.qui, ok: r.ok, statut: r.statut || 0 }));
  return json({ ok: true, demande: C.demandePublique(x, { suivi: suivi }) }, 200, cors);
}

// POST /retour : la routine renvoie l'état de la demande (de serveur à serveur : ni origine exigée, ni CORS). Le jeton est comparé
// par son empreinte, en temps constant ; une réf. inconnue et un mauvais jeton reçoivent EXACTEMENT la même réponse.
export async function retour(req, env) {
  const b = await petitCorps(req, C.LIMITES.retourOctets);
  if (b.trop) return json({ ok: false, erreur: 'retour trop lourd' }, 413);
  if (b.illisible) return json({ ok: false, erreur: 'retour illisible' }, 400);
  const v = C.lireRetour(b.corps);
  if (!v.ok && !v.refus) return json({ ok: false, erreur: v.erreur }, 400);
  const st = stockage(env);
  const empreinte = await C.sha256Hex(v.ok ? v.r.cle : '');
  const d = v.ok && st ? await lireDemande(st, v.r.id) : null;
  if (!d || !C.egaux(empreinte, d.retourHash || '')) return json({ ok: false }, 403);
  const x = C.apresRetour(d, v.r, Date.now());
  await ecrireDemande(st, x);
  console.log('[retour]', JSON.stringify({ ref: x.id, qui: x.qui, etat: x.etat, liens: (x.liens || []).length }));
  return json({ ok: true }, 200);
}

// GET /etat : les interrupteurs, lisibles par tous (sans clé) ; le bouton les lit avant de se montrer. « actif » = le GÉNÉRAL
// (comme avant), « projets » = celui de chaque projet de C.PROJETS. Avec ?projet=<id> : en plus « projet » et « effectif »
// (le général ET ce projet : ce que le bouton de ce projet doit faire). Un id inconnu : 400.
// Une page hors d'ORIGINES le lit AUSSI (Access-Control-Allow-Origin « * », réponse sans clé ni secret), avec `origine: false` :
// sans cela, le navigateur cache le refus et le bouton d'un projet oublié dans ORIGINES croit le relais injoignable, au lieu
// de dire « page non autorisée ». Elle ne reçoit ni « depuis » ni « par » (le nom de qui a coupé) : elle n'en a pas besoin.
// Les autres routes restent fermées à ces pages (pas d'en-têtes CORS, préliminaire OPTIONS refusé).
export async function etat(req, env) {
  const o = req.headers.get('Origin'), autre = !!o && !C.origineAutorisee(o, env.ORIGINES);
  const entetes = autre ? { 'Vary': 'Origin', 'Access-Control-Allow-Origin': '*' } : entetesCors(req, env);
  const q = new URL(req.url).searchParams, projet = q.has('projet') ? q.get('projet') : null;
  if (projet !== null && !C.estProjet(projet)) return json({ ok: false, erreur: 'projet inconnu' }, 400, entetes);
  const v = C.vueEtat(await etatDuBouton(stockage(env)), { projet: projet, masquer: autre });
  if (autre) v.origine = false;
  return json(v, 200, entetes);
}

// POST /etat { actif } : activer ou couper le bouton partout ; { actif, projet } : dans ce projet seulement. Clé d'équipe exigée,
// d'où que vienne l'appel. La réponse : l'état complet, comme GET /etat (avec « projet » et « effectif » pour un projet).
export async function changerEtat(req, env) {
  const cors = entetesCors(req, env);
  const a = acces(req, env, cors, true);
  if (a.refus) return a.refus;
  const st = stockage(env);
  if (!st) return json({ ok: false, erreur: SANS_STOCKAGE }, 503, cors);
  const b = await petitCorps(req, C.LIMITES.etatOctets);
  const v = b.corps !== undefined ? C.lireEtatBouton(b.corps) : { ok: false, erreur: b.trop ? 'réglage trop lourd' : 'réglage illisible' };
  if (!v.ok) return json({ ok: false, erreur: v.erreur }, 400, cors);
  const e = C.changerEtatBouton(lireJson(await st.lireTexte(C.CLE_ETAT)), v.actif, a.qui, Date.now(), v.projet);
  await st.ecrireTexte(C.CLE_ETAT, JSON.stringify(e));
  console.log('[etat]', JSON.stringify({ actif: v.actif, projet: v.projet || 'tous', qui: a.qui }));
  return json(C.vueEtat(C.etatBouton(e), { projet: v.projet }), 200, cors);
}

async function piece(id, env) {
  const st = stockage(env);
  if (!st) return new Response('introuvable', { status: 404 });
  const o = await st.get(id);
  if (!o) return new Response('introuvable', { status: 404 });
  return new Response(o.body, { headers: { 'Content-Type': (o.httpMetadata && o.httpMetadata.contentType) || 'application/octet-stream',
    'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' } });
}

// L'aiguillage. `outils` ({ fetch, attendre }) sert aux tests : une fausse routine.
export async function routeur(req, env, outils) {
  const u = new URL(req.url), p = u.pathname, m = req.method;
  // /retour n'est appelé que de serveur à serveur : pas de CORS, même pour une page autorisée.
  if (m === 'OPTIONS') return new Response(null, { status: 204, headers: p === '/retour' ? { 'Vary': 'Origin' } : entetesCors(req, env) });
  try {
    if (m === 'POST' && p === '/signaler') return await signaler(req, env, outils);
    if (m === 'GET' && p === '/demandes') return await demandes(req, env);
    const r = RENVOI_RX.exec(p);
    if (m === 'POST' && r) return await renvoyer(req, env, outils, r[1]);
    if (m === 'POST' && p === '/retour') return await retour(req, env);
    if (m === 'GET' && p === '/etat') return await etat(req, env);
    if (m === 'POST' && p === '/etat') return await changerEtat(req, env);
    const x = PIECE_RX.exec(p);
    if (m === 'GET' && x) return await piece(x[1], env);
  } catch (e) {
    // Une panne (stockage plein…) rend une réponse JSON lisible par la page ; le journal ne garde que la route et le genre d'erreur.
    console.log('[erreur]', JSON.stringify({ route: m + ' ' + p.replace(/[0-9a-f]{12,32}/g, '…'), genre: (e && e.name) || '?' }));
    return json({ ok: false, erreur: 'le relais a eu un problème, réessaie dans un moment' }, 500, p === '/retour' ? {} : entetesCors(req, env));
  }
  return new Response('introuvable', { status: 404 });
}

export default {
  fetch(req, env) { return routeur(req, env); },
};
