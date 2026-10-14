// Le relais tel quel (relay/coeur.mjs et relay/cloudflare/worker.mjs) : un faux stockage R2, une fausse routine. Aucun appel réseau.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../relay/coeur.mjs';
import worker, { signaler } from '../relay/cloudflare/worker.mjs';

const ORIGINE = 'https://app.exemple.fr';
const ROUTINE = 'https://api.anthropic.com/v1/claude_code/routines/trig_01TESTROUTINE/fire';
const CLE_MARIE = 'k7Qe9mWz4Lp2Xr8T';
const env0 = () => ({ ORIGINES: ORIGINE, DEPOT: 'exemple/app', ROUTINE_URL: ROUTINE, ROUTINE_JETON: 'sk-ant-oat01-FAUX', CLES: 'marie:' + CLE_MARIE + ',paul:Zr2mN8vB5qK1wY7c', PIECES: r2() });
function r2() {
  const objets = new Map();
  return { objets, put: async (k, v, o) => { objets.set(k, { v: v, o: o }); }, get: async (k) => (objets.has(k) ? { body: objets.get(k).v, httpMetadata: objets.get(k).o.httpMetadata } : null) };
}
const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const requete = (corps, entetes) => new Request('https://relais.exemple.dev/signaler', { method: 'POST',
  headers: Object.assign({ 'Content-Type': 'application/json', Origin: ORIGINE, 'X-Signaler-Cle': CLE_MARIE }, entetes || {}), body: typeof corps === 'string' ? corps : JSON.stringify(corps) });
function routine(reponses) {
  const appels = [];
  const f = async (url, init) => {
    appels.push({ url, init, corps: JSON.parse(init.body) });
    const r = (reponses || [])[appels.length - 1] || { status: 200, json: { type: 'routine_fire', claude_code_session_id: 'session_01X', claude_code_session_url: 'https://claude.ai/code/session_01X' } };
    if (r.jette) throw new Error('réseau coupé');
    return { ok: r.status < 300, status: r.status, json: async () => r.json || {} };
  };
  return { appels, fetch: f, attendre: async () => {} };
}
const signalement = (extra) => Object.assign({ type: 'bug', texte: 'Le bouton Enregistrer ne fait rien', captures: [{ donnees: PNG_1x1, ou: 'Fiche client' }],
  contexte: { url: 'https://app.exemple.fr/clients/42', titre: 'Client 42', version: '1.4.2', appareil: 'iPhone', taille: '390×844', erreurs: ['✖ TypeError: x is undefined'] } }, extra || {});

test('les clés d’équipe : le nom vient de la clé, une clé courte ou inconnue est refusée', () => {
  assert.deepEqual(C.verifierCle(CLE_MARIE, 'marie:' + CLE_MARIE + ',paul:Zr2mN8vB5qK1wY7c'), { ok: true, nom: 'marie' });
  assert.equal(C.verifierCle('Zr2mN8vB5qK1wY7c', 'marie:' + CLE_MARIE + ',paul:Zr2mN8vB5qK1wY7c').nom, 'paul');
  assert.equal(C.verifierCle('mauvaise-cle-de-16c', 'marie:' + CLE_MARIE).ok, false);
  assert.equal(C.verifierCle('court', 'x:court').ok, false, 'une clé de moins de 16 caractères ne vaut rien, même déclarée');
  assert.equal(C.verifierCle(CLE_MARIE, '').ok, false, 'sans liste : refus');
});

test('les origines : seulement celles de la liste', () => {
  assert.equal(C.origineAutorisee('https://app.exemple.fr', 'https://app.exemple.fr/, https://autre.fr'), true);
  assert.equal(C.origineAutorisee('https://pirate.fr', 'https://app.exemple.fr'), false);
  assert.equal(C.origineAutorisee('', 'https://app.exemple.fr'), false);
  assert.equal(C.origineAutorisee('https://app.exemple.fr', ''), false, 'liste vide : refus');
});

test('le signalement est vérifié : types d’image, poids, nombre, vide', () => {
  assert.equal(C.lireSignalement(signalement()).ok, true);
  assert.equal(C.lireSignalement(signalement({ captures: [{ donnees: 'data:text/html;base64,PGgxPg==' }] })).ok, false, 'pas de HTML déguisé en image');
  assert.equal(C.lireSignalement(signalement({ captures: Array.from({ length: 7 }, () => ({ donnees: PNG_1x1 })) })).ok, false, '7 images : refus');
  assert.equal(C.lireSignalement({ type: 'bug', texte: '   ' }).ok, false, 'rien à lire : refus');
  const s = C.lireSignalement(signalement({ texte: 'x'.repeat(9000) })).s;
  assert.equal(s.texte.length, C.LIMITES.texte, 'le texte est borné');
  assert.equal(C.lireSignalement(signalement({ audio: { donnees: 'data:audio/webm;codecs=opus;base64,GkXfow==', duree: '0:05' } })).s.audio.mime, 'audio/webm');
});

test('le texte de la routine porte tout ce qu’il faut, sous la limite de l’API', () => {
  const s = C.lireSignalement(signalement()).s;
  const t = C.texteRoutine({ s, ref: 'abc123', qui: 'marie', depot: 'exemple/app', pieces: [{ genre: 'image', url: 'https://relais/piece/' + 'a'.repeat(32), ou: 'Fiche client' }] });
  for (const morceau of ['Dépôt : exemple/app', 'Référence : abc123', 'Signalé par : marie', 'Version : 1.4.2', 'TypeError: x is undefined', 'Le bouton Enregistrer ne fait rien', 'CAPTURES', '— Fiche client'])
    assert.ok(t.includes(morceau), morceau);
  const long = C.texteRoutine({ s: Object.assign({}, s, { texte: 'y'.repeat(70000) }), ref: 'r', qui: 'q', pieces: [] });
  assert.ok(long.length <= C.LIMITES.texteRoutine);
});

test('le relais de bout en bout : clé, origine, pièces rangées, routine prévenue une fois', async () => {
  const env = env0(), R = routine();
  const rep = await signaler(requete(signalement()), env, R);
  const j = await rep.json();
  assert.equal(rep.status, 200); assert.equal(j.ok, true); assert.match(j.ref, /^[0-9a-f]{12}$/);
  assert.equal(j.suivi, '', 'le lien de suivi ne descend pas à la page par défaut');
  assert.equal(rep.headers.get('Access-Control-Allow-Origin'), ORIGINE);
  assert.equal(R.appels.length, 1);
  assert.equal(R.appels[0].url, ROUTINE);
  assert.equal(R.appels[0].init.headers.Authorization, 'Bearer sk-ant-oat01-FAUX');
  assert.equal(R.appels[0].init.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(Object.keys(R.appels[0].corps), ['text']);
  assert.ok(R.appels[0].corps.text.includes('Signalé par : marie'));
  assert.equal(env.PIECES.objets.size, 1, 'la capture est rangée');
  const [id] = [...env.PIECES.objets.keys()];
  assert.match(id, /^[0-9a-f]{32}$/, '128 bits : une adresse impossible à deviner');
  assert.ok(R.appels[0].corps.text.includes('https://relais.exemple.dev/piece/' + id));
  const piece = await worker.fetch(new Request('https://relais.exemple.dev/piece/' + id), env);
  assert.equal(piece.status, 200); assert.equal(piece.headers.get('Content-Type'), 'image/png'); assert.equal(piece.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal((await worker.fetch(new Request('https://relais.exemple.dev/piece/' + 'f'.repeat(32)), env)).status, 404);
});

test('les refus : sans clé, mauvaise origine, corps illisible — et rien ne part', async () => {
  const env = env0(), R = routine();
  let rep = await signaler(requete(signalement(), { 'X-Signaler-Cle': '' }), env, R);
  assert.equal(rep.status, 401); assert.equal((await rep.json()).cle, true, 'la page sait qu’il faut redemander la clé');
  rep = await signaler(requete(signalement(), { Origin: 'https://pirate.fr' }), env, R);
  assert.equal(rep.status, 403); assert.equal(rep.headers.get('Access-Control-Allow-Origin'), null);
  rep = await signaler(requete('{pas du json'), env, R);
  assert.equal(rep.status, 400);
  assert.equal(R.appels.length, 0); assert.equal(env.PIECES.objets.size, 0);
});

test('la routine : coupée sans secrets, 503 rejoué une fois, 429 et coupure jamais, adresse d’une routine seulement', async () => {
  let R = routine(), env = Object.assign(env0(), { ROUTINE_URL: '', ROUTINE_JETON: '' });
  let j = await (await signaler(requete(signalement()), env, R)).json();
  assert.equal(j.ok, false); assert.match(j.erreur, /pas encore relié/); assert.equal(R.appels.length, 0);
  R = routine(); env = Object.assign(env0(), { ROUTINE_URL: 'https://exemple.com/fire' });
  await signaler(requete(signalement()), env, R);
  assert.equal(R.appels.length, 0, 'le jeton ne part jamais vers une autre adresse');
  R = routine([{ status: 503, json: { type: 'error', error: { type: 'overloaded_error' } } }]);
  j = await (await signaler(requete(signalement()), env0(), R)).json();
  assert.equal(j.ok, true); assert.equal(R.appels.length, 2);
  R = routine([{ status: 429, json: { type: 'error', error: { type: 'rate_limit_error', message: 'trop' } } }]);
  j = await (await signaler(requete(signalement()), env0(), R)).json();
  assert.equal(j.ok, false); assert.equal(R.appels.length, 1); assert.match(j.erreur, /429/);
  R = routine([{ jette: true }]);
  await signaler(requete(signalement()), env0(), R);
  assert.equal(R.appels.length, 1, 'coupure réseau : on ne sait pas si la session existe, pas de second essai');
});

test('sans stockage R2 : le signalement part quand même, et le texte le dit', async () => {
  const env = Object.assign(env0(), { PIECES: undefined }), R = routine();
  const j = await (await signaler(requete(signalement()), env, R)).json();
  assert.equal(j.ok, true);
  assert.match(R.appels[0].corps.text, /pas gardée\(s\) : le relais n’a pas de stockage/);
});

test('CORS : la page autorisée reçoit les en-têtes, une autre non', async () => {
  const env = env0();
  const ok = await worker.fetch(new Request('https://relais.exemple.dev/signaler', { method: 'OPTIONS', headers: { Origin: ORIGINE } }), env);
  assert.equal(ok.status, 204); assert.equal(ok.headers.get('Access-Control-Allow-Origin'), ORIGINE);
  assert.match(ok.headers.get('Access-Control-Allow-Headers'), /X-Signaler-Cle/);
  const ko = await worker.fetch(new Request('https://relais.exemple.dev/signaler', { method: 'OPTIONS', headers: { Origin: 'https://pirate.fr' } }), env);
  assert.equal(ko.headers.get('Access-Control-Allow-Origin'), null);
});
