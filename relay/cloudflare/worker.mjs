// Le relais « 🐞 Signaler » en Cloudflare Worker (offre gratuite suffisante). Il reçoit le signalement de la page, range captures et
// note vocale dans R2, et prévient la routine Claude Code. Réglages (voir wrangler.toml et INSTALL.md) :
//   vars    ORIGINES  les adresses des pages autorisées, séparées par des virgules (« https://app.exemple.fr »)
//           DEPOT     le dépôt GitHub à corriger (« proprietaire/depot »), recopié dans le texte de la routine
//   secrets ROUTINE_URL   https://api.anthropic.com/v1/claude_code/routines/trig_…/fire
//           ROUTINE_JETON le jeton de CETTE routine (sk-ant-oat01-…)
//           CLES          les clés d'équipe : « marie:<clé>,paul:<clé> » (16 caractères au moins chacune)
//   R2      PIECES (facultatif) : sans lui, le signalement part sans les fichiers, et le texte le dit
//
// Routes : POST /signaler · GET /piece/<id> (une capture ou la note, sous une adresse de 128 bits) · OPTIONS (CORS)
import * as C from '../coeur.mjs';

const PIECE_RX = /^\/piece\/([0-9a-f]{32})$/;

function entetesCors(req, env) {
  const o = req.headers.get('Origin') || '';
  const h = { 'Vary': 'Origin' };
  if (C.origineAutorisee(o, env.ORIGINES)) {
    h['Access-Control-Allow-Origin'] = o;
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type, X-Signaler-Cle';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}
const json = (corps, statut, entetes) => new Response(JSON.stringify(corps), { status: statut || 200,
  headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, entetes || {}) });

export async function signaler(req, env, outils) {
  outils = outils || {};
  const cors = entetesCors(req, env);
  if (!C.origineAutorisee(req.headers.get('Origin'), env.ORIGINES)) return json({ ok: false, erreur: 'page non autorisée' }, 403, cors);
  const qui = C.verifierCle(req.headers.get('X-Signaler-Cle'), env.CLES);
  if (!qui.ok) return json({ ok: false, cle: true, erreur: 'clé d’équipe absente ou inconnue' }, 401, cors);
  const taille = Number(req.headers.get('Content-Length') || 0);
  if (taille > C.LIMITES.corpsOctets) return json({ ok: false, erreur: 'signalement trop lourd' }, 413, cors);
  let corps;
  try { const t = await req.text(); if (t.length > C.LIMITES.corpsOctets) return json({ ok: false, erreur: 'signalement trop lourd' }, 413, cors); corps = JSON.parse(t); }
  catch (e) { return json({ ok: false, erreur: 'signalement illisible' }, 400, cors); }
  const lu = C.lireSignalement(corps);
  if (!lu.ok) return json({ ok: false, erreur: lu.erreur }, 400, cors);
  const s = lu.s, ref = C.nouvelId().slice(0, 12), base = new URL(req.url).origin, pieces = [];
  if (env.PIECES) {
    const ranger = async (genre, mime, octets, extra) => {
      const id = C.nouvelId();
      await env.PIECES.put(id, octets, { httpMetadata: { contentType: mime }, customMetadata: { ref: ref, genre: genre } });
      pieces.push(Object.assign({ genre: genre, url: base + '/piece/' + id }, extra || {}));
    };
    for (const c of s.captures) await ranger('image', c.mime, c.octets, { ou: c.ou });
    if (s.audio) await ranger('audio', s.audio.mime, s.audio.octets, {});
  }
  const texte = C.texteRoutine({ s: s, ref: ref, qui: qui.nom, depot: env.DEPOT, pieces: pieces, quand: Date.now() });
  const r = await C.prevenirRoutine({ url: env.ROUTINE_URL, jeton: env.ROUTINE_JETON, texte: texte, fetch: outils.fetch, attendre: outils.attendre });
  // Le journal ne porte que des compteurs : ni le texte, ni les fichiers, ni le jeton.
  console.log('[signaler]', JSON.stringify({ ref: ref, qui: qui.nom, images: s.captures.length, audio: !!s.audio, ok: r.ok, statut: r.statut || 0 }));
  if (!r.ok) return json({ ok: false, ref: ref, erreur: r.coupe ? 'le relais n’est pas encore relié à Claude' : 'Claude n’a pas pu être prévenu (' + r.erreur + ')' }, 502, cors);
  return json({ ok: true, ref: ref, suivi: env.MONTRER_SUIVI === 'oui' ? r.suivi : '' }, 200, cors);
}

async function piece(id, env) {
  if (!env.PIECES) return new Response('introuvable', { status: 404 });
  const o = await env.PIECES.get(id);
  if (!o) return new Response('introuvable', { status: 404 });
  return new Response(o.body, { headers: { 'Content-Type': (o.httpMetadata && o.httpMetadata.contentType) || 'application/octet-stream',
    'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' } });
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: entetesCors(req, env) });
    if (req.method === 'POST' && u.pathname === '/signaler') return signaler(req, env);
    const m = PIECE_RX.exec(u.pathname);
    if (req.method === 'GET' && m) return piece(m[1], env);
    return new Response('introuvable', { status: 404 });
  },
};
