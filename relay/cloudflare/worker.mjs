// Le relais « 🐞 Signaler » en Cloudflare Worker (offre gratuite suffisante). Il reçoit le signalement de la page, range captures et
// note vocale (R2 ou Workers KV), prévient la routine Claude Code, et garde chaque DEMANDE avec son état (« Mes demandes » du bouton).
// Réglages (voir wrangler.toml et INSTALL.md) :
//   vars    ORIGINES  les adresses des pages autorisées, séparées par des virgules (« https://app.exemple.fr ») ; leur nom d'hôte
//                     est aussi le rpId de la connexion par empreinte
//           DEPOT     le dépôt GitHub à corriger (« proprietaire/depot »), recopié dans le texte de la routine
//           MONTRER_SUIVI « oui » : la page reçoit le lien de la session Claude (après l'envoi, et dans « Mes demandes »)
//           NOM_RP    (facultatif) le nom montré par le téléphone à l'inscription d'une empreinte (« 770lab » par défaut)
//   secrets ROUTINE_URL   https://api.anthropic.com/v1/claude_code/routines/trig_…/fire   (abonnement Claude 1)
//           ROUTINE_JETON le jeton de CETTE routine (sk-ant-oat01-…)
//           ROUTINE_URL_2 / ROUTINE_JETON_2 (facultatifs) la routine du second abonnement Claude, prise quand le premier refuse
//           CLES          les clés d'équipe : « marie:<clé>,paul:<clé> » (16 caractères au moins chacune) ; c'est aussi la liste
//                         de l'équipe. Pour chaque nom, seule la clé la plus RÉCENTE vaut : celle créée depuis le pupitre
//                         (/auth/cle/nouvelle) remplace celle de CLES ; changer ensuite CLES pour ce nom (au Terminal) remplace
//                         à son tour la clé du pupitre
//           SESSION_SECRET (facultatif) 32 caractères aléatoires au moins : la connexion par empreinte (sans lui, les routes /auth
//                         répondent 503 et tout le reste marche comme avant)
//   stockage (facultatif) : R2 PIECES, ou Workers KV PIECES_KV (inclus dans l'offre gratuite, sans abonnement R2 ; fichiers
//           effacés après 30 jours, demandes et leurs captures avant / après 180 jours après leur dernière nouvelle). Sans
//           stockage, le signalement part sans les fichiers (le texte le dit), sans « Mes demandes », interrupteur ni empreinte
//
// Routes : POST /signaler · GET /piece/<id> (une capture, la note, une capture avant / après, sous une adresse de 128 bits)
//          GET /demandes (les miennes) · POST /demandes/<réf>/renvoyer (pas partie, ou sans nouvelle depuis 15 min ; { abonnement })
//          POST /demandes/<réf>/annuler (en ligne) · POST /demandes/<réf>/valider (à valider ; connecté par l'empreinte, d'un
//          appareil de confiance) · POST /demandes/<réf>/regler · POST /demandes/<réf>/rouvrir (la marque « Réglé » de l'Atelier)
//          POST /retour (la routine, de serveur à serveur : l'état de la demande, ses captures, de quoi annuler, avec son jeton)
//          GET /etat[?projet=<id>] · POST /etat (interrupteurs et mode de chaque projet) · GET / POST /routine (les abonnements)
//          /auth/… (la connexion par empreinte : options/inscription, inscription, options/connexion, connexion, appareils,
//          appareils/<id>/retirer, verifier ; cle/nouvelle = une nouvelle clé d'équipe, empreinte de moins de 5 min d'un appareil de
//          confiance) · OPTIONS (CORS)
// « Ma clé ou ma session » : chaque route qui accepte la clé d'équipe (X-Signaler-Cle) accepte aussi Authorization: Bearer <session>.
// Appareil DE CONFIANCE (C.appareilDeConfiance) : inscrit avec la session d'un appareil de confiance, ou avec la clé seule quand la
// personne n'avait encore jamais eu d'appareil, ou avant ce changement. Un appareil inscrit avec la clé seule alors que la personne
// en a déjà eu un (une clé volée suffit pour cela) se connecte et signale comme avant, mais ne crée pas de clé et ne met pas en ligne.
import * as C from '../coeur.mjs';
import * as P from '../push.mjs';

const PIECE_RX = /^\/piece\/([0-9a-f]{32})$/;
const DEMANDE_RX = /^\/demandes\/([0-9a-f]{12})\/(renvoyer|annuler|valider|regler|rouvrir)$/;
const RETIRER_RX = /^\/auth\/appareils\/([A-Za-z0-9_-]{16,400})\/retirer$/;
const KV_DUREE_S = 30 * 24 * 3600;
const SANS_STOCKAGE = 'le relais n’a pas de stockage';
const COUPE = { ok: false, coupe: true, erreur: 'le bouton est coupé depuis le pupitre' };
const PAS_REGLE = { ok: false, erreur: 'connexion par empreinte pas encore réglée' };
const NON_AUTORISEE = { ok: false, erreur: 'page non autorisée' };
const SESSION_REFUSEE = { ok: false, cle: true, session: true, erreur: 'connexion expirée ou appareil retiré : reconnecte-toi avec ton empreinte' };
// L'appareil de la session n'est pas de confiance (inscrit avec la clé seule) : 403 « confiance » (pas « empreinte » : reposer le
// doigt sur CET appareil n'y changerait rien ; il faut celui d'un appareil de confiance, le téléphone par exemple).
const PAS_DE_CONFIANCE_CLE = { ok: false, confiance: true, erreur: 'Cet appareil a été ajouté avec la clé d’équipe seule : une nouvelle clé se crée avec l’empreinte d’un appareil de confiance (ton téléphone).' };
const PAS_DE_CONFIANCE_VALIDER = { ok: false, confiance: true, erreur: 'cet appareil a été ajouté avec la clé d’équipe seule : mets en ligne avec l’empreinte d’un appareil de confiance (ton téléphone)' };

// Le stockage, ramené à une seule forme : put/get pour les pièces (forme R2 : { body, httpMetadata }), lireTexte/ecrireTexte pour
// les demandes, les appareils et les réglages (du JSON), effacer (null si le stockage ne sait pas). Workers KV : chaque pièce
// s'efface d'elle-même au bout de 30 jours (ou de `dureeS`), une demande au bout de la durée donnée ; sans durée (liste d'une
// personne, interrupteur, appareil), rien ne s'efface. R2 n'efface rien de lui-même (sauf règle de cycle de vie posée sur le bucket).
function stockage(env) {
  if (env.PIECES) {
    const r2 = env.PIECES;
    return {
      put: (id, octets, o) => r2.put(id, octets, { httpMetadata: o.httpMetadata, customMetadata: o.customMetadata }),
      get: (id) => r2.get(id),
      lireTexte: async (cle) => {
        const o = await r2.get(cle);
        if (!o) return null;
        return typeof o.text === 'function' ? o.text() : new Response(o.body).text();
      },
      // Étiqueté comme les pièces (genre) : « demande », « demandes » (une liste), « etat », « appareil », « defi »…
      ecrireTexte: (cle, texte) => r2.put(cle, texte, { httpMetadata: { contentType: 'application/json' }, customMetadata: { genre: cle.split(':')[0] } }),
      effacer: typeof r2.delete === 'function' ? (cle) => r2.delete(cle) : null,
    };
  }
  const kv = env.PIECES_KV;
  if (!kv) return null;
  return {
    put: (id, octets, o) => kv.put(id, octets, { expirationTtl: o.dureeS || KV_DUREE_S,
      metadata: Object.assign({ contentType: o.httpMetadata.contentType }, o.customMetadata || {}) }),
    get: async (id) => {
      const r = await kv.getWithMetadata(id, { type: 'arrayBuffer' });
      return r && r.value !== null ? { body: r.value, httpMetadata: { contentType: (r.metadata || {}).contentType } } : null;
    },
    lireTexte: (cle) => kv.get(cle),
    ecrireTexte: (cle, texte, dureeS) => (dureeS ? kv.put(cle, texte, { expirationTtl: dureeS }) : kv.put(cle, texte)),
    effacer: typeof kv.delete === 'function' ? (cle) => kv.delete(cle) : null,
  };
}
// Effacer une clé. Un stockage qui ne sait pas effacer (option B sans delete) reçoit une « pierre tombale », lue comme absente.
const effacer = (st, cle) => (st.effacer ? st.effacer(cle) : st.ecrireTexte(cle, JSON.stringify({ retire: true }), 3 * C.LIMITES.defiDureeS));

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
// Les interrupteurs et les modes. Stockage absent ou en panne : activés, modes par défaut (le bouton marche comme avant plutôt que
// de se taire sans raison).
async function etatDuBouton(st) {
  if (!st) return C.etatBouton(null);
  try { return C.etatBouton(lireJson(await st.lireTexte(C.CLE_ETAT))); } catch (e) { return C.etatBouton(null); }
}
async function lireAppareil(st, id) {
  if (!C.ID_APPAREIL_RX.test(String(id))) return null;
  const ap = lireJson(await st.lireTexte(C.cleAppareil(id)));
  return C.appareilValide(ap, id) ? ap : null;
}
async function appareilsDe(st, qui) {
  const ids = lireJson(await st.lireTexte(C.cleAppareils(qui)));
  const liste = await Promise.all((Array.isArray(ids) ? ids : []).filter((id) => C.ID_APPAREIL_RX.test(String(id))).map((id) => lireAppareil(st, id)));
  return liste.filter((ap) => ap && ap.qui === qui).sort((x, y) => (y.creeLe || 0) - (x.creeLe || 0));
}

function entetesCors(req, env) {
  const o = req.headers.get('Origin') || '';
  const h = { 'Vary': 'Origin' };
  if (C.origineAutorisee(o, env.ORIGINES)) {
    h['Access-Control-Allow-Origin'] = o;
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type, X-Signaler-Cle, Authorization';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}
const json = (corps, statut, entetes) => new Response(JSON.stringify(corps), { status: statut || 200,
  headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, entetes || {}) });

// Une session (Authorization: Bearer …) : signature juste, pas expirée, appareil toujours inscrit (et à ce rpId), personne toujours
// dans CLES. Rend { ok, p, appareil } ou { ok: false }.
async function sessionValide(env, jeton) {
  const st = stockage(env);
  if (!st || !C.secretSessionValide(env.SESSION_SECRET)) return { ok: false };
  const s = await C.lireSession(jeton, env.SESSION_SECRET, Date.now());
  if (!s.ok) return s;
  const ap = await lireAppareil(st, s.p.app);
  if (!ap || ap.qui !== s.p.qui || ap.rpId !== s.p.rp) return { ok: false, erreur: 'appareil retiré' };
  if (!C.nomsDesCles(env.CLES).includes(s.p.qui)) return { ok: false, erreur: 'personne retirée' };
  return { ok: true, p: s.p, appareil: ap };
}

// Une clé d'équipe (X-Signaler-Cle) : pour chaque nom de CLES, seule la plus RÉCENTE vaut (C.deciderCle) : la clé créée depuis le
// pupitre (rangée sous « cle:<nom> », son empreinte seulement) tant que CLES n'a pas changé pour ce nom depuis, sinon celle de CLES
// (le Terminal, plus récent, l'emporte). « cle:<nom> » est lu une fois par requête, pour chaque nom de CLES seulement. Workers KV peut mettre jusqu'à 60 s à propager une nouvelle clé d'un lieu à l'autre : pendant ce
// temps, ailleurs, l'ancienne marche encore et la nouvelle pas encore (rien à faire, la page le dit). Sans stockage : CLES seul,
// comme avant. Stockage en panne : l'erreur remonte (500), plutôt que d'accepter une clé peut-être remplacée.
async function cleEquipe(env, cle) {
  const st = stockage(env);
  if (!st) return C.verifierCle(cle, env.CLES);
  if (String(cle || '').trim().length < 16) return { ok: false };
  const noms = C.nomsDesCles(env.CLES);
  const lus = await Promise.all(noms.map(async (nom) => lireJson(await st.lireTexte(C.cleCle(nom)))));
  return C.deciderCle(cle, env.CLES, Object.fromEntries(noms.map((nom, i) => [nom, lus[i]])));
}

// Les vérifications communes aux routes des pages : l'origine (exigée, ou seulement vérifiée quand il y en a une), puis la session
// (Authorization: Bearer) ou la clé d'équipe (X-Signaler-Cle, voir cleEquipe), qui donnent le nom. Rend { qui, session, appareil }
// (session et appareil : null avec la clé) ou { refus: Response }.
// Une session refusée (expirée, appareil retiré) : 401 avec « session: true » (la page l'oublie et propose l'empreinte).
async function acces(req, env, cors, origineFacultative) {
  const o = req.headers.get('Origin');
  if ((o || !origineFacultative) && !C.origineAutorisee(o, env.ORIGINES)) return { refus: json(NON_AUTORISEE, 403, cors) };
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get('Authorization') || '');
  let refusee = false;
  if (m) {
    const s = await sessionValide(env, m[1]);
    if (s.ok) return { qui: s.p.qui, session: s.p, appareil: s.appareil };
    refusee = true;
  }
  const qui = await cleEquipe(env, req.headers.get('X-Signaler-Cle'));
  if (qui.ok) return { qui: qui.nom, session: null, appareil: null };
  if (refusee) return { refus: json(SESSION_REFUSEE, 401, cors) };
  return { refus: json({ ok: false, cle: true, erreur: 'clé d’équipe absente ou inconnue' }, 401, cors) };
}

// Un petit corps JSON (retour, interrupteur, empreinte…), pesé en octets. Rend { corps } ou { trop: true } ou { illisible: true }.
// `videPermis` : un corps vide vaut {} (et seul un objet est accepté).
async function petitCorps(req, max, videPermis) {
  if (Number(req.headers.get('Content-Length') || 0) > max) return { trop: true };
  let t;
  try { t = await req.text(); } catch (e) { return { illisible: true }; }
  if (new TextEncoder().encode(t).length > max) return { trop: true };
  if (videPermis && !t.trim()) return { corps: {} };
  let c;
  try { c = JSON.parse(t); } catch (e) { return { illisible: true }; }
  if (videPermis && (!c || typeof c !== 'object' || Array.isArray(c))) return { illisible: true };
  return { corps: c };
}

// Prévenir la routine : les abonnements dans l'ordre (C.ordreAbonnements), ou celui imposé par « Renvoyer sur l'autre abonnement ».
// Les indisponibilités notées sont rangées sous « routine » (seulement si elles ont changé). Rend la réponse (avec `abonnement`).
async function prevenir(env, st, outils, texte, impose) {
  outils = outils || {};
  const abos = C.abonnementsDe(env);
  let avant = C.etatRoutine(null);
  if (st) { try { avant = C.etatRoutine(lireJson(await st.lireTexte(C.CLE_ROUTINE))); } catch (e) { /* lu comme vide */ } }
  const liste = impose ? C.abonnementImpose(abos, impose) : C.ordreAbonnements(avant, abos, Date.now());
  const x = await C.prevenirAbonnements({ liste: liste, etat: avant, texte: texte, fetch: outils.fetch, attendre: outils.attendre,
    prefixer: abos.filter((a) => a.regle).length > 1 });
  if (st && JSON.stringify(x.etat) !== JSON.stringify(avant)) { try { await st.ecrireTexte(C.CLE_ROUTINE, JSON.stringify(x.etat)); } catch (e) { /* tant pis */ } }
  return x.r;
}

export async function signaler(req, env, outils) {
  outils = outils || {};
  const cors = entetesCors(req, env);
  const a = await acces(req, env, cors);
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
  // Le projet vient de l'adresse de la page (la même règle que le bouton) ; son mode est écrit dans le texte de la routine.
  const projet = C.projetDeLaPage(lu.s.contexte.url);
  if (!C.boutonActif(interrupteurs, projet)) return json(COUPE, 403, cors);
  const mode = C.modeDuProjet(interrupteurs, projet);
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
  const texte = C.texteRoutine({ s: s, ref: ref, qui: a.qui, depot: env.DEPOT, pieces: pieces, quand: quand, mode: mode,
    retour: st ? { url: base + '/retour', id: ref, cle: jeton } : null });
  const r = await prevenir(env, st, outils, texte);
  let demande = false;
  if (st) {
    // Une demande qui ne se range pas (quota du stockage…) ne change rien à la réponse : la routine, elle, a été prévenue ou non.
    try {
      await ecrireDemande(st, C.nouvelleDemande({ id: ref, qui: a.qui, s: s, quand: quand, r: r, retourHash: await C.sha256Hex(jeton), texteRoutine: texte, mode: mode }));
      await st.ecrireTexte(C.cleIndex(a.qui), JSON.stringify(C.indexAvec(await lireIndex(st, a.qui), ref)));
      demande = true;
    } catch (e) { demande = false; }
  }
  // Le journal ne porte que des compteurs : ni le texte, ni les fichiers, ni les jetons.
  console.log('[signaler]', JSON.stringify({ ref: ref, qui: a.qui, par: a.session ? 'empreinte' : 'cle', images: s.captures.length, audio: !!s.audio,
    elements: s.contexte.elements.length, journal: s.contexte.journal.length, mode: mode, ok: r.ok, abonnement: r.abonnement || '', statut: r.statut || 0, demande: demande }));
  if (!r.ok) return json({ ok: false, ref: ref, erreur: C.messageRoutine(r) }, 502, cors);
  return json({ ok: true, ref: ref, suivi: env.MONTRER_SUIVI === 'oui' ? r.suivi : '' }, 200, cors);
}

// GET /demandes : les 20 dernières demandes de la personne (d'après sa clé ou sa session), la plus récente d'abord.
export async function demandes(req, env) {
  const cors = entetesCors(req, env);
  const a = await acces(req, env, cors);
  if (a.refus) return a.refus;
  const st = stockage(env);
  if (!st) return json({ ok: true, demandes: [], stockage: false }, 200, cors);
  const ids = (await lireIndex(st, a.qui)).slice(0, C.LIMITES.demandesListe), maintenant = Date.now();
  const liste = (await Promise.all(ids.map((id) => (C.REF_RX.test(String(id)) ? lireDemande(st, id) : null))))
    .filter((d) => d && d.qui === a.qui)
    .sort((x, y) => (y.creeLeMs || 0) - (x.creeLeMs || 0))
    .map((d) => C.demandePublique(d, { suivi: env.MONTRER_SUIVI === 'oui', maintenant: maintenant }));
  return json({ ok: true, demandes: liste }, 200, cors);
}

// Le début commun à renvoyer / annuler / valider : accès, stockage, la demande de CETTE personne (celle d'un autre : la même
// réponse qu'une réf. inconnue). Rend { a, st, d, cors } ou { refus: Response }.
async function maDemande(req, env, id) {
  const cors = entetesCors(req, env);
  const a = await acces(req, env, cors);
  if (a.refus) return { refus: a.refus };
  const st = stockage(env);
  if (!st) return { refus: json({ ok: false, erreur: SANS_STOCKAGE }, 503, cors) };
  const d = await lireDemande(st, id);
  if (!d || d.qui !== a.qui) return { refus: json({ ok: false, erreur: 'demande introuvable' }, 404, cors) };
  return { a: a, st: st, d: d, cors: cors };
}
const publique = (env, d) => C.demandePublique(d, { suivi: env.MONTRER_SUIVI === 'oui', maintenant: Date.now() });

// POST /demandes/<réf>/renvoyer [{ abonnement: "1"|"2" }] : relance la routine, avec un jeton de retour neuf, pour une demande
// « pas partie », ou dont la session ne donne aucune nouvelle depuis 15 minutes (en cours, annulation ou mise en ligne en cours :
// le même travail repart). Avec « abonnement » : sur celui-là seulement (« Renvoyer sur l'autre abonnement »).
export async function renvoyer(req, env, outils, id) {
  const m = await maDemande(req, env, id);
  if (m.refus) return m.refus;
  const { a, st, d, cors } = m, quand = Date.now();
  const b = await petitCorps(req, C.LIMITES.etatOctets, true);
  if (!b.corps) return json({ ok: false, erreur: b.trop ? 'demande trop lourde' : 'demande illisible' }, 400, cors);
  if (!C.peutRenvoyer(d, quand)) return json({ ok: false, erreur: 'cette demande est déjà partie', demande: publique(env, d) }, 409, cors);
  let impose = null;
  if (b.corps.abonnement !== undefined && b.corps.abonnement !== null) {
    impose = String(b.corps.abonnement);
    if (impose !== '1' && impose !== '2') return json({ ok: false, erreur: 'abonnement inconnu : "1" ou "2"' }, 400, cors);
    if (!C.abonnementImpose(C.abonnementsDe(env), impose).length) return json({ ok: false, erreur: 'l’abonnement ' + impose + ' n’est pas réglé' }, 409, cors);
  }
  const interrupteurs = await etatDuBouton(st), projet = C.projetDeLaDemande(d);
  if (!C.boutonActif(interrupteurs, projet)) return json(COUPE, 403, cors);
  const jeton = C.nouvelId(), retour = { url: new URL(req.url).origin + '/retour', id: id, cle: jeton };
  const o = { quand: quand, retourHash: await C.sha256Hex(jeton), etat: d.etat === 'pas_partie' ? 'envoyee' : d.etat, garder: d.etat !== 'pas_partie' };
  let texte;
  if (d.etat === 'en_cours_annulation') texte = C.avecRetour(C.texteAnnuler({ d: d, qui: a.qui, quand: quand, depot: env.DEPOT }), Object.assign({ travail: 'annuler' }, retour));
  else if (d.etat === 'en_cours_validation') texte = C.avecRetour(C.texteValider({ d: d, qui: a.qui, quand: quand, depot: env.DEPOT }), Object.assign({ travail: 'valider' }, retour));
  else {
    o.mode = C.modeDuProjet(interrupteurs, projet);
    texte = C.avecRetour(d.texteRoutine, Object.assign({ mode: o.mode }, retour));
    o.texteRoutine = texte;
  }
  const r = await prevenir(env, st, outils, texte, impose);
  const x = C.apresEnvoi(d, r, o);
  await ecrireDemande(st, x);
  console.log('[renvoyer]', JSON.stringify({ ref: id, qui: a.qui, etat: x.etat, impose: impose || '', ok: r.ok, abonnement: r.abonnement || '', statut: r.statut || 0 }));
  // Une session muette qui ne repart pas : l'état d'avant reste (elle travaille peut-être encore), la page lit « ok: false ».
  if (!r.ok && o.garder) return json({ ok: false, erreur: x.erreur, demande: publique(env, x) }, 502, cors);
  return json({ ok: true, demande: publique(env, x) }, 200, cors);
}

// Un travail ANNULER ou VALIDER : l'état « en cours » est rangé AVANT d'appeler la routine (deux touchers rapides ne lancent pas
// deux sessions) ; pas parti : l'état d'avant revient, avec la raison (502).
async function lancerTravail(req, env, outils, m, travail) {
  const { a, st, d, cors } = m, quand = Date.now(), id = d.id;
  const enCours = Object.assign({}, d, { etat: travail === 'annuler' ? 'en_cours_annulation' : 'en_cours_validation', majLeMs: quand });
  delete enCours.erreur;
  await ecrireDemande(st, enCours);
  const jeton = C.nouvelId(), retour = { url: new URL(req.url).origin + '/retour', id: id, cle: jeton, travail: travail };
  const t = (travail === 'annuler' ? C.texteAnnuler : C.texteValider)({ d: d, qui: a.qui, quand: quand, depot: env.DEPOT });
  const r = await prevenir(env, st, outils, C.avecRetour(t, retour));
  const x = r.ok ? C.apresEnvoi(enCours, r, { quand: quand, retourHash: await C.sha256Hex(jeton), etat: enCours.etat })
    : C.apresEnvoi(d, r, { quand: quand, garder: true });
  await ecrireDemande(st, x);
  console.log('[' + travail + ']', JSON.stringify({ ref: id, qui: a.qui, ok: r.ok, abonnement: r.abonnement || '', statut: r.statut || 0 }));
  if (!r.ok) return json({ ok: false, erreur: x.erreur, demande: publique(env, x) }, 502, cors);
  return json({ ok: true, demande: publique(env, x) }, 200, cors);
}

// POST /demandes/<réf>/annuler : une demande « en ligne » qui porte de quoi annuler → travail ANNULER (git revert, en ligne, RETOUR
// « annulee »). Jamais pour Avinou Malkenou (son propriétaire retire lui-même une mise en ligne, depuis son Mac).
export async function annuler(req, env, outils, id) {
  const m = await maDemande(req, env, id);
  if (m.refus) return m.refus;
  const { st, d, cors } = m, projet = C.projetDeLaDemande(d);
  if (projet === 'avinou') return json({ ok: false, erreur: 'Avinou Malkenou : c’est son propriétaire qui retire une mise en ligne, depuis son Mac (son coffre).', demande: publique(env, d) }, 409, cors);
  if (d.etat !== 'en_ligne' || !d.annulation) return json({ ok: false, erreur: 'rien à annuler : seule une demande en ligne, avec ce qu’il faut pour l’annuler, peut l’être', demande: publique(env, d) }, 409, cors);
  if (!C.boutonActif(await etatDuBouton(st), projet)) return json(COUPE, 403, cors);
  return lancerTravail(req, env, outils, m, 'annuler');
}

// POST /demandes/<réf>/valider : une demande « à valider » (avec sa PR) → travail VALIDER (fusion, en ligne, RETOUR « en_ligne »).
// Exige une SESSION de connexion par empreinte (30 jours ; plus de seconde empreinte de moins de 5 minutes, choix du propriétaire le
// 2026-10-21 ; la clé d'équipe seule ne suffit pas : 403 « empreinte: true », la page propose la connexion), d'un appareil DE CONFIANCE (sinon 403 « confiance: true » : une clé volée inscrit un appareil, et
// l'empreinte de cet appareil ne doit pas mettre en ligne). Jamais pour Avinou Malkenou : 409.
export async function valider(req, env, outils, id) {
  const m = await maDemande(req, env, id);
  if (m.refus) return m.refus;
  const { a, st, d, cors } = m, projet = C.projetDeLaDemande(d);
  if (projet === 'avinou') return json({ ok: false, erreur: 'Avinou Malkenou est mis en ligne par son propriétaire, depuis son Mac (son coffre) : rien à valider ici.', demande: publique(env, d) }, 409, cors);
  if (d.etat !== 'a_valider') return json({ ok: false, erreur: 'rien à mettre en ligne : cette demande n’est pas « à valider »', demande: publique(env, d) }, 409, cors);
  if (!C.prsDe(d.liens).length) return json({ ok: false, erreur: 'aucune PR à mettre en ligne dans cette demande', demande: publique(env, d) }, 409, cors);
  if (a.session && !C.appareilDeConfiance(a.appareil)) return json(PAS_DE_CONFIANCE_VALIDER, 403, cors);
  if (!a.session) return json({ ok: false, empreinte: true, erreur: 'connecte-toi avec ton empreinte pour mettre en ligne' }, 403, cors);
  if (!C.boutonActif(await etatDuBouton(st), projet)) return json(COUPE, 403, cors);
  return lancerTravail(req, env, outils, m, 'valider');
}

// POST /demandes/<réf>/regler · /rouvrir : la marque « Réglé » de l'Atelier (regleeLeMs), gardée par le relais pour que la
// personne la retrouve sur tous ses appareils. Ni routine, ni interrupteur : rien ne part chez Claude.
async function marquer(req, env, id, quoi) {
  const m = await maDemande(req, env, id);
  if (m.refus) return m.refus;
  const { a, st, d, cors } = m;
  const x = quoi === 'regler' ? C.regler(d, Date.now()) : C.rouvrir(d);
  await ecrireDemande(st, x);
  console.log('[' + quoi + ']', JSON.stringify({ ref: id, qui: a.qui }));
  return json({ ok: true, demande: publique(env, x) }, 200, cors);
}
export const regler = (req, env, outils, id) => marquer(req, env, id, 'regler');
export const rouvrir = (req, env, outils, id) => marquer(req, env, id, 'rouvrir');

// Les notifications : un abonnement par appareil, rangés par personne (« push:<nom> », 10 au plus, le plus récent d'abord).
// Sans VAPID_PUBLIC et VAPID_PRIVEE : rien ne part (la page le sait par GET /push/cle).
const clePush = (qui) => 'push:' + qui;
const pushPret = (env) => !!(env.VAPID_PUBLIC && env.VAPID_PRIVEE);
async function lirePush(st, qui) {
  const x = lireJson(await st.lireTexte(clePush(qui)));
  return Array.isArray(x) ? x.map(P.abonnementValide).filter(Boolean) : [];
}
// Prévient la personne que sa demande a changé d'état : sur tous ses appareils ; un abonnement mort (404 / 410) est retiré. Une
// panne de push ne doit jamais empêcher d'enregistrer le retour : tout est attrapé.
async function notifier(env, st, d, outils) {
  if (!pushPret(env) || !P.ETATS_NOTIFIES.includes(d.etat)) return;
  try {
    const liste = await lirePush(st, d.qui);
    if (!liste.length) return;
    const message = P.messagePour(d, env.ATELIER_URL || 'https://770lab.com/atelier/');
    const o = { fetch: (outils && outils.fetch) || fetch, sujet: env.VAPID_SUJET || 'https://770lab.com/atelier/', publique: env.VAPID_PUBLIC, privee: env.VAPID_PRIVEE };
    const morts = [];
    const res = await Promise.all(liste.map((a) => P.envoyer(a, message, o).catch(() => ({ ok: false }))));
    res.forEach((r, i) => { if (r.gone) morts.push(liste[i].endpoint); });
    if (morts.length) await st.ecrireTexte(clePush(d.qui), JSON.stringify(liste.filter((a) => !morts.includes(a.endpoint))));
    console.log('[push]', JSON.stringify({ ref: d.id, etat: d.etat, appareils: liste.length, ok: res.filter((r) => r.ok).length, retires: morts.length }));
  } catch (e) { console.log('[push]', JSON.stringify({ ref: d.id, erreur: (e && e.name) || '?' })); }
}
// GET /push/cle : la clé publique (pour s'abonner) ; { pret: false } tant que le relais n'a pas ses clés.
export async function pushCle(req, env) {
  return json({ ok: true, pret: pushPret(env), cle: pushPret(env) ? env.VAPID_PUBLIC : null }, 200, entetesCors(req, env));
}
// POST /push/abonner { abonnement } · /push/desabonner { endpoint } : l'appareil de la personne (clé ou session).
export async function pushAbonner(req, env, retirer) {
  const cors = entetesCors(req, env);
  const a = await acces(req, env, cors);
  if (a.refus) return a.refus;
  const st = stockage(env);
  if (!st) return json({ ok: false, erreur: SANS_STOCKAGE }, 503, cors);
  if (!pushPret(env)) return json({ ok: false, erreur: 'les notifications ne sont pas encore réglées sur le relais' }, 503, cors);
  const b = await petitCorps(req, 4096);
  if (b.trop || b.illisible) return json({ ok: false, erreur: 'demande illisible' }, 400, cors);
  const reste = (await lirePush(st, a.qui));
  if (retirer) {
    const ep = String((b.corps || {}).endpoint || '');
    await st.ecrireTexte(clePush(a.qui), JSON.stringify(reste.filter((x) => x.endpoint !== ep)));
    return json({ ok: true }, 200, cors);
  }
  const ab = P.abonnementValide((b.corps || {}).abonnement);
  if (!ab) return json({ ok: false, erreur: 'abonnement refusé' }, 400, cors);
  await st.ecrireTexte(clePush(a.qui), JSON.stringify([ab].concat(reste.filter((x) => x.endpoint !== ab.endpoint)).slice(0, 10)));
  console.log('[push-abonner]', JSON.stringify({ qui: a.qui }));
  return json({ ok: true }, 200, cors);
}

// POST /retour : la routine renvoie l'état de la demande (de serveur à serveur : ni origine exigée, ni CORS). Le jeton est comparé
// par son empreinte, en temps constant ; une réf. inconnue et un mauvais jeton reçoivent EXACTEMENT la même réponse. Les captures
// avant / après ne sont rangées qu'APRÈS cette vérification (180 jours, comme la demande) et servies sous /piece/<id>.
export async function retour(req, env, outils) {
  const b = await petitCorps(req, C.LIMITES.retourOctets);
  if (b.trop) return json({ ok: false, erreur: 'retour trop lourd' }, 413);
  if (b.illisible) return json({ ok: false, erreur: 'retour illisible' }, 400);
  const v = C.lireRetour(b.corps);
  if (!v.ok && !v.refus) return json({ ok: false, erreur: v.erreur }, 400);
  const st = stockage(env);
  const empreinte = await C.sha256Hex(v.ok ? v.r.cle : '');
  const d = v.ok && st ? await lireDemande(st, v.r.id) : null;
  if (!d || !C.egaux(empreinte, d.retourHash || '')) return json({ ok: false }, 403);
  let images = null;
  if (v.r.images) {
    images = {};
    const base = new URL(req.url).origin;
    for (const k of Object.keys(v.r.images)) {
      const id = C.nouvelId(), im = v.r.images[k];
      await st.put(id, im.octets, { httpMetadata: { contentType: im.mime }, customMetadata: { ref: d.id, genre: k }, dureeS: C.LIMITES.demandeDureeS });
      images[k] = base + '/piece/' + id;
    }
  }
  const x = C.apresRetour(d, v.r, Date.now(), images);
  await ecrireDemande(st, x);
  // Les captures remplacées ne servent plus : effacées (si le stockage sait le faire).
  for (const k of Object.keys(images || {})) {
    const vieux = /\/piece\/([0-9a-f]{32})$/.exec(String((d.images || {})[k] || ''));
    if (vieux && st.effacer) { try { await st.effacer(vieux[1]); } catch (e) { /* elle s'effacera d'elle-même */ } }
  }
  await notifier(env, st, x, outils);
  console.log('[retour]', JSON.stringify({ ref: x.id, qui: x.qui, etat: x.etat, liens: (x.liens || []).length, images: Object.keys(images || {}).length, annulation: !!x.annulation }));
  return json({ ok: true }, 200);
}

// GET /etat : les interrupteurs et les modes, lisibles par tous (sans clé) ; le bouton les lit avant de se montrer. « actif » = le
// GÉNÉRAL (comme avant), « projets » = celui de chaque projet de C.PROJETS (avec son « mode »), « modes » = le mode de chaque projet.
// Avec ?projet=<id> : en plus « projet », « effectif » (le général ET ce projet : ce que le bouton de ce projet doit faire) et
// « mode ». Un id inconnu : 400.
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

// POST /etat { actif } : activer ou couper le bouton partout ; { actif, projet } : dans ce projet seulement ; { projet, mode } : le
// mode de ce projet (« direct » ou « valider » ; Avinou Malkenou et KOULAM ne changent pas : 400). Clé d'équipe ou session exigée,
// d'où que vienne l'appel. La réponse : l'état complet, comme GET /etat (avec « projet », « effectif » et « mode » pour un projet).
export async function changerEtat(req, env) {
  const cors = entetesCors(req, env);
  const a = await acces(req, env, cors, true);
  if (a.refus) return a.refus;
  const st = stockage(env);
  if (!st) return json({ ok: false, erreur: SANS_STOCKAGE }, 503, cors);
  const b = await petitCorps(req, C.LIMITES.etatOctets);
  const v = b.corps !== undefined ? C.lireEtatBouton(b.corps) : { ok: false, erreur: b.trop ? 'réglage trop lourd' : 'réglage illisible' };
  if (!v.ok) return json({ ok: false, erreur: v.erreur }, 400, cors);
  const e = C.changerEtatBouton(lireJson(await st.lireTexte(C.CLE_ETAT)), v.actif, a.qui, Date.now(), v.projet, v.mode);
  await st.ecrireTexte(C.CLE_ETAT, JSON.stringify(e));
  console.log('[etat]', JSON.stringify({ actif: v.actif === undefined ? '=' : v.actif, mode: v.mode || '=', projet: v.projet || 'tous', qui: a.qui }));
  return json(C.vueEtat(C.etatBouton(e), { projet: v.projet }), 200, cors);
}

// GET /routine : le choix d'abonnement et l'état de chacun (réglé, indisponible jusqu'à quand et pourquoi) ; POST /routine
// { choix: "auto"|"1"|"2" } le change (et efface les indisponibilités notées : on réessaie tout de suite). Clé ou session exigée.
export async function routine(req, env) {
  const cors = entetesCors(req, env);
  const a = await acces(req, env, cors, true);
  if (a.refus) return a.refus;
  const st = stockage(env), abos = C.abonnementsDe(env);
  const lu = st ? lireJson(await st.lireTexte(C.CLE_ROUTINE)) : null;
  if (req.method === 'GET') return json(C.vueRoutine(lu, abos, Date.now()), 200, cors);
  if (!st) return json({ ok: false, erreur: SANS_STOCKAGE }, 503, cors);
  const b = await petitCorps(req, C.LIMITES.etatOctets);
  const v = b.corps !== undefined ? C.lireChoixRoutine(b.corps, abos) : { ok: false, erreur: b.trop ? 'réglage trop lourd' : 'réglage illisible' };
  if (!v.ok) return json({ ok: false, erreur: v.erreur }, 400, cors);
  const e = C.changerChoixRoutine(lu, v.choix, a.qui, Date.now());
  await st.ecrireTexte(C.CLE_ROUTINE, JSON.stringify(e));
  console.log('[routine]', JSON.stringify({ choix: v.choix, qui: a.qui }));
  return json(C.vueRoutine(e, abos, Date.now()), 200, cors);
}

// ——— LA CONNEXION PAR EMPREINTE (/auth/…) ———
// Le rpId est le nom d'hôte de l'origine de la page (dans ORIGINES), l'origine attendue est cette origine exacte.
function rpDe(req, env) {
  const o = req.headers.get('Origin');
  if (!o || !C.origineAutorisee(o, env.ORIGINES)) return null;
  const rpId = C.rpIdDe(o);
  return rpId ? { origine: o.trim().replace(/\/+$/, ''), rpId: rpId } : null;
}
// Le défi rangé, retrouvé ET effacé (une seule fois, que la suite réussisse ou non). null : absent, expiré, d'un autre genre ou
// d'un autre site.
async function prendreDefi(st, defi, type, rp) {
  if (!C.DEFI_RX.test(String(defi))) return null;
  const d = lireJson(await st.lireTexte(C.cleDefi(defi)));
  if (!d) return null;
  await effacer(st, C.cleDefi(defi));
  return d.type === type && d.rpId === rp.rpId && d.exp > Date.now() ? d : null;
}
const credentialDe = (corps) => (corps && corps.credential && typeof corps.credential === 'object' ? corps.credential : corps);
const reponseDe = (cred) => (cred && typeof cred === 'object' && cred.response && typeof cred.response === 'object' ? cred.response : {});
async function nouvelleSessionPour(env, ap, rpId, quand) {
  const p = C.nouvelleSession({ qui: ap.qui, app: ap.id, rp: rpId, quand: quand });
  return { session: await C.signerSession(p, env.SESSION_SECRET), exp: p.exp, qui: p.qui };
}
const journalAuth = (x) => console.log('[auth]', JSON.stringify(x));

// POST /auth/options/inscription { nom } : il faut déjà une clé d'équipe ou une session. Les options de création (base64url), et le
// défi rangé « defi:<défi> » 5 minutes avec le nom, la personne, le rpId et « sur » : l'appareil sera-t-il DE CONFIANCE
// (C.inscriptionDeConfiance) — oui avec la session d'un appareil de confiance, ou avec la clé seule si la personne n'a jamais eu
// d'appareil (« appareils:<nom> » absent ; Workers KV met jusqu'à 60 s à propager cette liste d'un lieu à l'autre) ; non sinon.
async function optionsInscriptionRoute(req, env, st, cors) {
  const rp = rpDe(req, env);
  if (!rp) return json(NON_AUTORISEE, 403, cors);
  const a = await acces(req, env, cors);
  if (a.refus) return a.refus;
  const b = await petitCorps(req, C.LIMITES.etatOctets, true);
  if (!b.corps) return json({ ok: false, erreur: 'demande illisible' }, 400, cors);
  const tous = await appareilsDe(st, a.qui);
  if (tous.length >= C.LIMITES.appareils) return json({ ok: false, erreur: C.LIMITES.appareils + ' appareils au plus : retires-en un d’abord' }, 409, cors);
  const sur = C.inscriptionDeConfiance({ appareil: a.session ? a.appareil : null, jamaisInscrit: (await st.lireTexte(C.cleAppareils(a.qui))) === null });
  let pers = lireJson(await st.lireTexte(C.clePersonne(a.qui)));
  if (!pers || typeof pers.id !== 'string' || !pers.id) {
    pers = { id: C.nouvelIdPersonne(), creeLe: Date.now() };
    await st.ecrireTexte(C.clePersonne(a.qui), JSON.stringify(pers));
  }
  const defi = C.nouveauDefi();
  await st.ecrireTexte(C.cleDefi(defi), JSON.stringify({ type: 'inscription', qui: a.qui, rpId: rp.rpId, nom: C.nomAppareil(b.corps.nom),
    idPersonne: pers.id, sur: sur, exp: Date.now() + C.LIMITES.defiDureeS * 1000 }), C.LIMITES.defiDureeS);
  const o = C.optionsInscription({ rpId: rp.rpId, nomRp: env.NOM_RP, qui: a.qui, idPersonne: pers.id, defi: defi,
    exclure: tous.filter((ap) => ap.rpId === rp.rpId).map((ap) => ({ id: ap.id, transports: ap.transports })) });
  return json(Object.assign({ ok: true }, o, { publicKey: o }), 200, cors);
}

// POST /auth/inscription <credential> (+ « nom », facultatif : le nom corrigé après la création, C.nomInscrit) : l'appareil vérifié
// est rangé (« appareil:<id> », sans fin, avec « sur » décidé aux options ; un défi d'avant ce champ : pas de confiance) et ajouté
// à la liste de la personne ; la réponse porte une session neuve.
async function inscription(req, env, st, cors) {
  const rp = rpDe(req, env);
  if (!rp) return json(NON_AUTORISEE, 403, cors);
  const b = await petitCorps(req, C.LIMITES.authOctets);
  if (!b.corps) return json({ ok: false, erreur: b.trop ? 'demande trop lourde' : 'demande illisible' }, b.trop ? 413 : 400, cors);
  const cred = credentialDe(b.corps), ch = C.defiDe(reponseDe(cred).clientDataJSON);
  const defi = ch ? await prendreDefi(st, ch, 'inscription', rp) : null;
  if (!defi) return json({ ok: false, erreur: 'défi expiré ou déjà utilisé : recommence' }, 400, cors);
  const v = await C.verifierInscription({ credential: cred, defi: ch, origine: rp.origine, rpId: rp.rpId });
  if (!v.ok) { journalAuth({ action: 'inscription', qui: defi.qui, rp: rp.rpId, ok: false, raison: v.erreur }); return json({ ok: false, erreur: v.erreur }, 400, cors); }
  if (!C.nomsDesCles(env.CLES).includes(defi.qui)) return json({ ok: false, erreur: 'cette personne n’a plus de clé d’équipe' }, 403, cors);
  if (await lireAppareil(st, v.id)) return json({ ok: false, erreur: 'cet appareil est déjà inscrit' }, 409, cors);
  const quand = Date.now();
  const ap = { id: v.id, qui: defi.qui, rpId: rp.rpId, nom: C.nomInscrit(b.corps.nom, defi.nom), alg: v.alg, jwk: v.jwk, signCount: v.signCount, idPersonne: defi.idPersonne,
    transports: v.transports, sur: defi.sur === true, creeLe: quand, vuLe: quand };
  await st.ecrireTexte(C.cleAppareil(v.id), JSON.stringify(ap));
  await st.ecrireTexte(C.cleAppareils(defi.qui), JSON.stringify(C.appareilsAvec(lireJson(await st.lireTexte(C.cleAppareils(defi.qui))), v.id)));
  journalAuth({ action: 'inscription', qui: defi.qui, rp: rp.rpId, alg: v.alg, sur: ap.sur, ok: true });
  const s = await nouvelleSessionPour(env, ap, rp.rpId, quand);
  return json(Object.assign({ ok: true, appareil: { id: ap.id, nom: ap.nom, rpId: ap.rpId, creeLe: ap.creeLe, sur: ap.sur } }, s), 200, cors);
}

// POST (ou GET) /auth/options/connexion : sans clé. Le défi (rangé « defi:<défi> » 5 minutes) et le rpId de la page.
async function optionsConnexionRoute(req, env, st, cors) {
  const rp = rpDe(req, env);
  if (!rp) return json(NON_AUTORISEE, 403, cors);
  const defi = C.nouveauDefi();
  await st.ecrireTexte(C.cleDefi(defi), JSON.stringify({ type: 'connexion', rpId: rp.rpId, exp: Date.now() + C.LIMITES.defiDureeS * 1000 }), C.LIMITES.defiDureeS);
  const o = C.optionsConnexion({ rpId: rp.rpId, defi: defi });
  return json(Object.assign({ ok: true }, o, { publicKey: o }), 200, cors);
}

// POST /auth/connexion <assertion> : la signature de l'appareil vérifiée avec sa clé rangée → une session de 30 jours.
async function connexion(req, env, st, cors) {
  const rp = rpDe(req, env);
  if (!rp) return json(NON_AUTORISEE, 403, cors);
  const b = await petitCorps(req, C.LIMITES.authOctets);
  if (!b.corps) return json({ ok: false, erreur: b.trop ? 'demande trop lourde' : 'demande illisible' }, b.trop ? 413 : 400, cors);
  const cred = credentialDe(b.corps), ch = C.defiDe(reponseDe(cred).clientDataJSON);
  const defi = ch ? await prendreDefi(st, ch, 'connexion', rp) : null;
  if (!defi) return json({ ok: false, erreur: 'défi expiré ou déjà utilisé : recommence' }, 400, cors);
  const brut = C.deB64u(cred && cred.rawId);
  const ap = brut ? await lireAppareil(st, C.b64u(brut)) : null;
  if (!ap) return json({ ok: false, erreur: 'appareil inconnu ou retiré : connecte-toi avec ta clé d’équipe, puis inscris cet appareil' }, 401, cors);
  if (!C.nomsDesCles(env.CLES).includes(ap.qui)) return json({ ok: false, erreur: 'cette personne n’a plus de clé d’équipe' }, 403, cors);
  const v = await C.verifierConnexion({ assertion: cred, defi: ch, origine: rp.origine, rpId: rp.rpId, appareil: ap });
  if (!v.ok) { journalAuth({ action: 'connexion', qui: ap.qui, rp: rp.rpId, ok: false, raison: v.erreur }); return json({ ok: false, erreur: v.erreur }, 401, cors); }
  const quand = Date.now();
  await st.ecrireTexte(C.cleAppareil(ap.id), JSON.stringify(Object.assign({}, ap, { signCount: v.signCount, vuLe: quand })));
  journalAuth({ action: 'connexion', qui: ap.qui, rp: rp.rpId, ok: true });
  const s = await nouvelleSessionPour(env, ap, rp.rpId, quand);
  return json(Object.assign({ ok: true }, s, { appareil: { id: ap.id, nom: ap.nom } }), 200, cors);
}

// GET /auth/appareils : les appareils de la personne (clé ou session), « actuel » = celui de la session.
async function listeAppareils(req, env, st, cors) {
  const a = await acces(req, env, cors);
  if (a.refus) return a.refus;
  const actuel = a.session ? a.session.app : null;
  return json({ ok: true, appareils: (await appareilsDe(st, a.qui)).map((ap) => C.appareilPublic(ap, actuel)) }, 200, cors);
}

// POST /auth/appareils/<id>/retirer : un des SIENS seulement ; ses sessions ne valent plus rien, tout de suite (vérifié à chaque usage).
async function retirer(req, env, st, cors, id) {
  const a = await acces(req, env, cors);
  if (a.refus) return a.refus;
  const ap = await lireAppareil(st, id);
  if (!ap || ap.qui !== a.qui) return json({ ok: false, erreur: 'appareil introuvable' }, 404, cors);
  await effacer(st, C.cleAppareil(id));
  await st.ecrireTexte(C.cleAppareils(a.qui), JSON.stringify(C.appareilsSans(lireJson(await st.lireTexte(C.cleAppareils(a.qui))), id)));
  journalAuth({ action: 'retirer', qui: a.qui, rp: ap.rpId, ok: true });
  const actuel = a.session && a.session.app !== id ? a.session.app : null;
  return json({ ok: true, appareils: (await appareilsDe(st, a.qui)).filter((x) => x.id !== id).map((x) => C.appareilPublic(x, actuel)) }, 200, cors);
}

// POST /auth/verifier { session } : pour un serveur (l'API du Mac) — la session est-elle valable ? { ok, valide, qui?, exp?, uv?,
// sur? } ; « sur » : son appareil est de confiance (false : inscrit avec la clé d'équipe seule, qu'une clé volée suffit à obtenir).
async function verifierRoute(req, env, cors) {
  const b = await petitCorps(req, 8192);
  if (!b.corps || typeof b.corps !== 'object' || Array.isArray(b.corps)) return json({ ok: false, erreur: 'demande illisible' }, 400, cors);
  const s = typeof b.corps.session === 'string' ? await sessionValide(env, b.corps.session) : { ok: false };
  if (!s.ok) return json({ ok: true, valide: false }, 200, cors);
  return json({ ok: true, valide: true, qui: s.p.qui, exp: s.p.exp, uv: s.p.uv, sur: C.appareilDeConfiance(s.appareil) }, 200, cors);
}

// POST /auth/cle/nouvelle {} : une nouvelle clé d'équipe pour la personne de la SESSION (« Nouvelle clé » du pupitre). Exige une
// session à empreinte de moins de 5 minutes d'un appareil DE CONFIANCE, comme « valider » : la clé d'équipe seule ne suffit pas, ni
// l'empreinte d'un appareil qu'elle a inscrit (une clé volée inscrit l'appareil de l'intrus ; il ne doit pas pouvoir en créer une
// autre et enfermer le propriétaire dehors : 403 « confiance »). La clé est tirée ici et rendue UNE fois (no-store) ; seule son
// empreinte est rangée sous « cle:<nom> » (sans fin), avec celle de la clé de CLES qu'elle remplace (C.nouvelleCleRangee) ; elle
// remplace aussi celle créée avant, et redevient la seule valable même si CLES avait changé au Terminal entre-temps. Ni la clé ni son empreinte ne vont au journal ; une panne n'y laisse que la route.
async function nouvelleCleRoute(req, env, st, cors) {
  if (!C.origineAutorisee(req.headers.get('Origin'), env.ORIGINES)) return json(NON_AUTORISEE, 403, cors);
  const b = await petitCorps(req, C.LIMITES.etatOctets, true);
  if (!b.corps) return json({ ok: false, erreur: b.trop ? 'demande trop lourde' : 'demande illisible' }, b.trop ? 413 : 400, cors);
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get('Authorization') || '');
  if (!m) return json({ ok: false, empreinte: true, erreur: 'Une nouvelle clé se crée seulement avec ton empreinte.' }, 403, cors);
  const s = await sessionValide(env, m[1]);
  if (!s.ok) return json(SESSION_REFUSEE, 401, cors);
  if (!C.appareilDeConfiance(s.appareil)) return json(PAS_DE_CONFIANCE_CLE, 403, cors);
  const quand = Date.now();
  if (!C.sessionFraiche(s.p, quand)) return json({ ok: false, empreinte: true, erreur: 'Ton empreinte date de plus de 5 minutes : pose de nouveau le doigt.' }, 403, cors);
  const cle = C.nouvelleCle();
  await st.ecrireTexte(C.cleCle(s.p.qui), JSON.stringify(await C.nouvelleCleRangee({ cle: cle, qui: s.p.qui, liste: env.CLES, quand: quand, app: s.p.app })));
  console.log('[cle]', JSON.stringify({ qui: s.p.qui }));
  return json({ ok: true, cle: cle, qui: s.p.qui, creeLe: quand }, 200, cors);
}

// Toutes les routes /auth : sans SESSION_SECRET (32 caractères au moins), 503 « pas encore réglée » ; sans stockage, 503 aussi.
async function auth(req, env, p, m) {
  const cors = entetesCors(req, env);
  if (!C.secretSessionValide(env.SESSION_SECRET)) return json(PAS_REGLE, 503, cors);
  const st = stockage(env);
  if (!st) return json({ ok: false, erreur: SANS_STOCKAGE }, 503, cors);
  if (m === 'POST' && p === '/auth/verifier') return verifierRoute(req, env, cors);
  if ((m === 'POST' || m === 'GET') && p === '/auth/options/connexion') return optionsConnexionRoute(req, env, st, cors);
  if (m === 'POST' && p === '/auth/connexion') return connexion(req, env, st, cors);
  if (m === 'POST' && p === '/auth/options/inscription') return optionsInscriptionRoute(req, env, st, cors);
  if (m === 'POST' && p === '/auth/inscription') return inscription(req, env, st, cors);
  if (m === 'GET' && p === '/auth/appareils') return listeAppareils(req, env, st, cors);
  if (m === 'POST' && p === '/auth/cle/nouvelle') return nouvelleCleRoute(req, env, st, cors);
  const x = RETIRER_RX.exec(p);
  if (m === 'POST' && x) return retirer(req, env, st, cors, x[1]);
  return new Response('introuvable', { status: 404 });
}

// Une pièce se lit aussi par fetch depuis une page d'ORIGINES (CORS) : une page dont la CSP refuse les images du relais
// (img-src) mais l'admet en connect-src (Avinou Malkenou) relit la capture avant / après et la montre depuis la mémoire.
async function piece(req, id, env) {
  const st = stockage(env);
  if (!st) return new Response('introuvable', { status: 404 });
  const o = await st.get(id);
  if (!o) return new Response('introuvable', { status: 404 });
  const cors = entetesCors(req, env);
  const h = { 'Content-Type': (o.httpMetadata && o.httpMetadata.contentType) || 'application/octet-stream',
    'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline', 'Vary': 'Origin' };
  if (cors['Access-Control-Allow-Origin']) h['Access-Control-Allow-Origin'] = cors['Access-Control-Allow-Origin'];
  return new Response(o.body, { headers: h });
}

// L'aiguillage. `outils` ({ fetch, attendre }) sert aux tests : une fausse routine.
export async function routeur(req, env, outils) {
  const u = new URL(req.url), p = u.pathname, m = req.method;
  // /retour n'est appelé que de serveur à serveur : pas de CORS, même pour une page autorisée.
  if (m === 'OPTIONS') return new Response(null, { status: 204, headers: p === '/retour' ? { 'Vary': 'Origin' } : entetesCors(req, env) });
  try {
    if (p.startsWith('/auth/')) return await auth(req, env, p, m);
    if (m === 'POST' && p === '/signaler') return await signaler(req, env, outils);
    if (m === 'GET' && p === '/demandes') return await demandes(req, env);
    const r = DEMANDE_RX.exec(p);
    if (m === 'POST' && r) return await ({ renvoyer: renvoyer, annuler: annuler, valider: valider, regler: regler, rouvrir: rouvrir })[r[2]](req, env, outils, r[1]);
    if (m === 'GET' && p === '/push/cle') return await pushCle(req, env);
    if (m === 'POST' && (p === '/push/abonner' || p === '/push/desabonner')) return await pushAbonner(req, env, p === '/push/desabonner');
    if (m === 'POST' && p === '/retour') return await retour(req, env, outils);
    if (m === 'GET' && p === '/etat') return await etat(req, env);
    if (m === 'POST' && p === '/etat') return await changerEtat(req, env);
    if ((m === 'GET' || m === 'POST') && p === '/routine') return await routine(req, env);
    const x = PIECE_RX.exec(p);
    if (m === 'GET' && x) return await piece(req, x[1], env);
  } catch (e) {
    // Une panne (stockage plein…) rend une réponse JSON lisible par la page ; le journal ne garde que la route et le genre d'erreur.
    console.log('[erreur]', JSON.stringify({ route: m + ' ' + p.replace(/[0-9a-f]{12,32}/g, '…').replace(/\/auth\/appareils\/[^/]+/, '/auth/appareils/…'), genre: (e && e.name) || '?' }));
    return json({ ok: false, erreur: 'le relais a eu un problème, réessaie dans un moment' }, 500, p === '/retour' ? {} : entetesCors(req, env));
  }
  return new Response('introuvable', { status: 404 });
}

export default {
  fetch(req, env) { return routeur(req, env); },
};
