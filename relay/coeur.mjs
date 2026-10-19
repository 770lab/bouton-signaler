// Le cœur du relais « 🐞 Signaler » : des fonctions pures, sans dépendance, communes à tous les hébergements
// (Cloudflare Worker, Node, fonction serverless…). Le relais est la SEULE pièce qui connaît le jeton de la routine Claude :
// il ne quitte jamais le serveur.
//
//   page (signaler.js) ──POST /signaler──▶ relais ──POST …/routines/trig_…/fire──▶ routine Claude Code
//                                           │                                      (une session : corrige, teste, ouvre une PR)
//                                           ├─ range captures et note vocale, les sert sous une adresse impossible à deviner
//                                           └─ garde la DEMANDE (« Mes demandes » du bouton) ◀──POST /retour── la routine, à la fin :
//                                              son état (PR à relire, question…), avec un jeton propre à cette demande

export const LIMITES = {
  texte: 4000,              // le texte écrit ou dicté
  captures: 6,              // images par signalement
  captureOctets: 2_000_000, // une image (JPEG/PNG/WebP) une fois décodée
  audioOctets: 4_000_000,   // la note vocale (≈ 3 min)
  erreurs: 10,              // dernières erreurs de la page
  corpsOctets: 20_000_000,  // le corps JSON entier (le base64 grossit d'un tiers)
  texteRoutine: 60_000,     // l'API des routines accepte 65 536 caractères
  retourOctets: 4_096,      // le corps de POST /retour (envoyé par la routine)
  etatOctets: 1_024,        // le corps de POST /etat (l'interrupteur du pupitre)
  resume: 500,              // le résumé renvoyé par la routine
  liens: 5,                 // liens renvoyés (PR…), https seulement
  lien: 300,                // longueur d'un lien
  demandesIndex: 50,        // demandes gardées dans la liste de chaque personne
  demandesListe: 20,        // demandes rendues par GET /demandes
  demandeDureeS: 180 * 24 * 3600, // une demande s'efface 180 jours après sa dernière nouvelle (Workers KV)
};

const ROUTINE_RX = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9]+\/fire$/;
const IMAGE_RX = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;
const AUDIO_RX = /^data:(audio\/(?:webm|ogg|mp4|mpeg|wav|x-m4a|aac))(?:;[^,]*)?;base64,([A-Za-z0-9+/=]+)$/;

const propre = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);

// Comparaison en temps constant : la durée ne dit pas combien de caractères d'une clé étaient justes.
export function egaux(a, b) {
  a = String(a || ''); b = String(b || '');
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

// LES CLÉS D'ÉQUIPE. `liste` = « marie:k7Qe…,paul:Zr2m… » (le secret CLES du relais). Chaque personne reçoit SA clé, la tape une fois
// dans la fenêtre du bouton (gardée dans son navigateur). Le nom vient de la clé, jamais de la page : on sait qui a signalé.
// Une clé de moins de 16 caractères est ignorée (trop facile à deviner). Rend { ok, nom } ou { ok: false }.
export function verifierCle(cle, liste) {
  cle = String(cle || '').trim();
  if (cle.length < 16) return { ok: false };
  let trouve = null;
  String(liste || '').split(',').map((x) => x.trim()).filter(Boolean).forEach((ligne) => {
    const i = ligne.indexOf(':');
    const nom = i > 0 ? ligne.slice(0, i).trim() : 'équipe';
    const k = i > 0 ? ligne.slice(i + 1).trim() : ligne;
    if (k.length >= 16 && egaux(k, cle) && !trouve) trouve = nom;
  });
  return trouve ? { ok: true, nom: propre(trouve, 60) } : { ok: false };
}

// Les adresses de page qui ont le droit d'appeler le relais (« https://app.exemple.fr,https://exemple.fr »). Liste vide : refus.
export function origineAutorisee(origine, liste) {
  const o = String(origine || '').trim().replace(/\/+$/, '');
  if (!o) return false;
  return String(liste || '').split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean).some((x) => x === o);
}

function decoder64(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

// LE SIGNALEMENT REÇU, VÉRIFIÉ. Rend { ok: true, s } ou { ok: false, erreur }. Rien de ce qui arrive n'est cru tel quel :
// longueurs bornées, images et son décodés et pesés, types sur liste blanche.
export function lireSignalement(corps) {
  if (!corps || typeof corps !== 'object' || Array.isArray(corps)) return { ok: false, erreur: 'signalement illisible' };
  const c = (corps.contexte && typeof corps.contexte === 'object') ? corps.contexte : {};
  const s = {
    type: corps.type === 'idee' ? 'idee' : 'bug',
    texte: propre(corps.texte, LIMITES.texte),
    contexte: {
      url: propre(c.url, 500), titre: propre(c.titre, 200), appareil: propre(c.appareil, 300), taille: propre(c.taille, 30),
      version: propre(c.version, 80), utilisateur: propre(c.utilisateur, 120), langue: propre(c.langue, 20),
      erreurs: (Array.isArray(c.erreurs) ? c.erreurs : []).slice(-LIMITES.erreurs).map((e) => propre(e, 400)).filter(Boolean),
    },
    captures: [],
    audio: null,
  };
  const caps = Array.isArray(corps.captures) ? corps.captures : [];
  if (caps.length > LIMITES.captures) return { ok: false, erreur: 'trop d’images (' + LIMITES.captures + ' au plus)' };
  for (const x of caps) {
    const m = IMAGE_RX.exec(String((x && x.donnees) || ''));
    if (!m) return { ok: false, erreur: 'image illisible' };
    const octets = decoder64(m[2]);
    if (octets.length > LIMITES.captureOctets) return { ok: false, erreur: 'image trop lourde' };
    s.captures.push({ mime: m[1], octets: octets, ou: propre(x.ou, 200) });
  }
  if (corps.audio && corps.audio.donnees) {
    const m = AUDIO_RX.exec(String(corps.audio.donnees));
    if (!m) return { ok: false, erreur: 'note vocale illisible' };
    const octets = decoder64(m[2]);
    if (octets.length > LIMITES.audioOctets) return { ok: false, erreur: 'note vocale trop longue' };
    s.audio = { mime: m[1], octets: octets, duree: propre(corps.audio.duree, 10) };
  }
  if (!s.texte && !s.captures.length && !s.audio) return { ok: false, erreur: 'signalement vide' };
  return { ok: true, s: s };
}

// Un identifiant impossible à deviner (128 bits) : la référence du signalement et l'adresse de chaque pièce.
export function nouvelId() {
  const u = new Uint8Array(16);
  crypto.getRandomValues(u);
  return Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };
export const extension = (mime) => EXT[mime] || 'bin';

// LE TEXTE QUE LIT LA ROUTINE (le champ `text` de l'API). Pur. `pieces` : [{ genre: 'image'|'audio', url, ou?, duree? }] — les adresses
// où le relais sert les fichiers ; vide si le relais n'a pas de stockage (le texte le dit). `retour` : { url, id, cle } quand le relais
// garde les demandes — le bloc RETOUR est alors ajouté tout à la fin, jamais coupé.
export function texteRoutine(x) {
  const s = x.s, c = s.contexte, L = [];
  L.push('SIGNALEMENT (bouton 🐞 Signaler) — ' + (s.type === 'idee' ? '💡 idée' : '🐞 bug'));
  if (x.depot) L.push('Dépôt : ' + propre(x.depot, 200));
  L.push('Référence : ' + x.ref);
  L.push('Signalé par : ' + (x.qui || '?') + (c.utilisateur && c.utilisateur !== x.qui ? ' (compte dans l’application : ' + c.utilisateur + ')' : '')
    + ' · le ' + new Date(x.quand || Date.now()).toISOString());
  [['Page', c.url], ['Titre de la page', c.titre], ['Version', c.version], ['Appareil', c.appareil], ['Écran', c.taille], ['Langue', c.langue]]
    .forEach(([k, v]) => { if (v) L.push(k + ' : ' + v); });
  if (c.erreurs.length) { L.push('Dernières erreurs de la page :'); c.erreurs.forEach((e) => L.push('  · ' + e)); }
  L.push('', 'CE QUE DIT LA PERSONNE :', s.texte ? s.texte : '(rien d’écrit — voir les captures' + (s.audio ? ' et la note vocale' : '') + ')');
  const imgs = (x.pieces || []).filter((p) => p.genre === 'image'), son = (x.pieces || []).find((p) => p.genre === 'audio');
  if (imgs.length) { L.push('', 'CAPTURES (à télécharger et regarder) :'); imgs.forEach((p, i) => L.push('  ' + (i + 1) + ') ' + p.url + (p.ou ? '  — ' + p.ou : ''))); }
  else if (s.captures.length) L.push('', '(' + s.captures.length + ' capture(s) reçue(s) mais pas gardée(s) : le relais n’a pas de stockage)');
  if (son) L.push('', 'NOTE VOCALE (non transcrite, ' + (s.audio && s.audio.duree ? s.audio.duree : '?') + ') : ' + son.url);
  else if (s.audio) L.push('', '(note vocale reçue mais pas gardée : le relais n’a pas de stockage)');
  // Ce qu'écrit la personne ne peut pas imiter le bloc RETOUR du relais : seul le dernier, écrit ci-dessous, en est un.
  let t = L.join('\n').replace(/ajout\S*\s+par\s+le\s+relais/gi, 'cité par la personne');
  const bloc = x.retour ? blocRetour(x.retour) : '';
  const max = LIMITES.texteRoutine - (bloc ? bloc.length + 2 : 0);
  if (t.length > max) t = t.slice(0, max - 20) + '\n… (tronqué)';
  return bloc ? t + '\n\n' + bloc : t;
}

// LE BLOC RETOUR, écrit par le relais à la fin du texte de la routine : la commande qui renvoie l'état de la demande (POST /retour).
// `cle` = le jeton de retour (32 hex), propre à cette demande ; le relais n'en garde que l'empreinte sha256.
export const MARQUE_RETOUR = 'RETOUR (ajouté par le relais, pas par la personne)';
export const ETATS_RETOUR = {
  a_relire: 'PR ouverte, à relire par le propriétaire',
  question: 'tu poses une question : écris-la dans resume ET dans ta réponse finale',
  rien: 'rien à changer',
  echec: 'tu n’as pas pu le faire',
  en_ligne: 'déjà en ligne',
};
export const ETATS = ['envoyee', 'pas_partie'].concat(Object.keys(ETATS_RETOUR));
export const REF_RX = /^[0-9a-f]{12}$/;
const JETON_RX = /^[0-9a-f]{32}$/;

export function blocRetour(o) {
  const url = String(o.url || '');
  if (!REF_RX.test(String(o.id)) || !JETON_RX.test(String(o.cle)) || !/^https?:\/\/[^\s"'\\]+$/.test(url)) throw new Error('bloc RETOUR : réglage invalide');
  const corps = '{"id":"' + o.id + '","cle":"' + o.cle + '","etat":"a_relire","resume":"<une ou deux phrases simples>","liens":["<lien de la PR>"]}';
  return [
    MARQUE_RETOUR + ' : à la fin, envoie TOUJOURS l\'état de cette demande :',
    'curl -sS -X POST "' + url + '" -H "Content-Type: application/json" -d \'' + corps + '\'',
    'etat possibles : ' + Object.keys(ETATS_RETOUR).map((k) => k + ' (' + ETATS_RETOUR[k] + ')').join(', ') + '.',
    'Dans resume, pas d’apostrophe droite (elle couperait la commande) : écris ’. Sans PR : "liens":[].',
  ].join('\n');
}

// Le texte sans son bloc RETOUR (c'est ce que garde la demande : le jeton n'est écrit nulle part), et le même avec un bloc neuf.
export function sansRetour(texte) {
  texte = String(texte || '');
  const i = texte.lastIndexOf(MARQUE_RETOUR);
  return (i >= 0 ? texte.slice(0, i) : texte).replace(/\s+$/, '');
}
export const avecRetour = (texte, retour) => sansRetour(texte) + '\n\n' + blocRetour(retour);

// L'empreinte sha256 (hex) d'un texte, par crypto.subtle (Workers, Node 18+, navigateurs).
export async function sha256Hex(texte) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(texte == null ? '' : texte)));
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('');
}

// PRÉVENIR LA ROUTINE. L'API n'a pas de clé d'idempotence (deux appels = deux sessions) : un second essai SEULEMENT sur une réponse
// 500/503 (la session n'a pas été créée), jamais après une coupure réseau ni un 429. Le jeton ne part que vers une adresse de routine.
// Rend { ok, session, suivi } ou { ok: false, coupe?, statut?, erreur }.
export async function prevenirRoutine(o) {
  const url = String(o.url || '').trim(), jeton = String(o.jeton || '').trim();
  if (!url || !jeton) return { ok: false, coupe: true, erreur: 'routine non réglée (ROUTINE_URL / ROUTINE_JETON)' };
  if (!ROUTINE_RX.test(url)) return { ok: false, coupe: true, erreur: 'ROUTINE_URL n’est pas l’adresse d’une routine (…/routines/trig_…/fire)' };
  const f = o.fetch || fetch, attendre = o.attendre || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let essai = 1; essai <= 2; essai++) {
    let rep, corps = {};
    try {
      rep = await f(url, { method: 'POST', headers: { Authorization: 'Bearer ' + jeton, 'anthropic-version': '2023-06-01',
        'anthropic-beta': 'experimental-cc-routine-2026-04-01', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: String(o.texte || '') }) });
    } catch (e) { return { ok: false, erreur: 'routine injoignable : ' + propre(e && e.message, 120) }; }
    try { corps = await rep.json(); } catch (e) { corps = {}; }
    if (rep.ok && corps && corps.claude_code_session_id) {
      const suivi = String(corps.claude_code_session_url || '');
      return { ok: true, session: propre(corps.claude_code_session_id, 120), suivi: /^https:\/\/claude\.ai\//.test(suivi) ? propre(suivi, 300) : '' };
    }
    if ((rep.status === 500 || rep.status === 503) && essai === 1) { await attendre(2000); continue; }
    const err = (corps && corps.error) || {};
    return { ok: false, statut: rep.status, erreur: 'routine ' + rep.status + (err.type ? ' ' + propre(err.type, 40) : '') + (err.message ? ' : ' + propre(err.message, 160) : '') };
  }
  return { ok: false, erreur: 'routine indisponible' };
}

// Le message que reçoit la page (et que garde la demande) quand la routine n'a pas été prévenue.
export const messageRoutine = (r) => (r.coupe ? 'le relais n’est pas encore relié à Claude' : 'Claude n’a pas pu être prévenu (' + r.erreur + ')');

// LES DEMANDES (« Mes demandes » du bouton). Rangées sous « demande:<réf> » ; la liste de chaque personne sous « demandes:<nom> »
// (les 50 dernières réfs, la plus récente d'abord) ; les interrupteurs du pupitre (général et par projet) sous « etat ».
// Aucune de ces clés n'a la forme d'une pièce (32 hex) : GET /piece ne peut pas les lire.
export const CLE_ETAT = 'etat';
export const cleDemande = (id) => 'demande:' + id;
export const cleIndex = (qui) => 'demandes:' + qui;

// La demande telle qu'elle est rangée juste après l'appel à la routine (avec son projet, d'après l'adresse de la page ; null
// pour une page d'aucun projet). `s` = le signalement vérifié (lireSignalement),
// `r` = la réponse de prevenirRoutine, `retourHash` = l'empreinte du jeton de retour, `texteRoutine` = le texte SANS son bloc RETOUR.
export function nouvelleDemande(o) {
  const s = o.s, c = s.contexte;
  const d = { id: o.id, creeLeMs: o.quand, majLeMs: o.quand, qui: o.qui, type: s.type, texte: s.texte,
    page: { url: c.url, titre: c.titre }, projet: projetDeLaPage(c.url), captures: s.captures.length, audio: !!s.audio, etat: 'envoyee' };
  return apresEnvoi(d, o.r, o);
}

// Après un appel à la routine (le premier, ou « Renvoyer ») : envoyée (avec le lien de la session) ou pas partie (avec la raison).
export function apresEnvoi(d, r, o) {
  const x = Object.assign({}, d, { majLeMs: o.quand, retourHash: o.retourHash, texteRoutine: sansRetour(o.texteRoutine) });
  delete x.sessionUrl; delete x.erreur;
  if (r && r.ok) { x.etat = 'envoyee'; if (r.suivi) x.sessionUrl = r.suivi; }
  else { x.etat = 'pas_partie'; x.erreur = propre(messageRoutine(r || {}), 300); }
  return x;
}

// Après un retour de la routine. Un champ absent du retour garde sa valeur d'avant (question, puis PR à relire…).
export function apresRetour(d, r, quand) {
  const x = Object.assign({}, d, { etat: r.etat, majLeMs: quand });
  delete x.erreur;
  if (r.resume !== undefined) x.resume = r.resume;
  if (r.liens !== undefined) x.liens = r.liens;
  return x;
}

// Ce qu'une page a le droit de voir d'une demande : une liste blanche. Jamais l'empreinte du jeton ni le texte de la routine.
// Le lien de la session Claude seulement si le relais le montre déjà après l'envoi (MONTRER_SUIVI = « oui »). Le projet : celui
// de la demande, ou, pour une demande rangée avant les projets, celui de l'adresse de sa page (absent : aucun projet).
const CHAMPS_PUBLICS = ['id', 'creeLeMs', 'majLeMs', 'qui', 'type', 'texte', 'page', 'projet', 'captures', 'audio', 'etat', 'erreur', 'sessionUrl', 'resume', 'liens'];
export function demandePublique(d, o) {
  const x = {};
  CHAMPS_PUBLICS.forEach((k) => { if (d && d[k] !== undefined && d[k] !== null) x[k] = d[k]; });
  if (!(o && o.suivi)) delete x.sessionUrl;
  const projet = projetDeLaDemande(d);
  if (projet) x.projet = projet; else delete x.projet;
  return x;
}

// La liste d'une personne avec une réf de plus, en tête (sans doublon, 50 au plus).
export function indexAvec(ids, id) {
  return [id].concat((Array.isArray(ids) ? ids : []).filter((x) => x !== id && REF_RX.test(String(x)))).slice(0, LIMITES.demandesIndex);
}

// Les liens renvoyés : https seulement, 300 caractères au plus (un lien coupé ne mène nulle part : il est écarté), 5 au plus.
function liensPropres(liens) {
  const out = [];
  (Array.isArray(liens) ? liens : [liens]).forEach((l) => {
    if (typeof l !== 'string' || out.length >= LIMITES.liens) return;
    const s = l.trim();
    if (s.length > LIMITES.lien || !/^https:\/\/[^\s"'<>\\]+$/.test(s)) return;
    try { if (new URL(s).protocol !== 'https:') return; } catch (e) { return; }
    if (!out.includes(s)) out.push(s);
  });
  return out;
}

// LE RETOUR DE LA ROUTINE (corps de POST /retour), vérifié. Rend { ok: true, r }, { ok: false, erreur } (corps mal formé : 400),
// ou { ok: false, refus: true } (réf. ou jeton qui n'ont pas la bonne forme : même refus qu'une réf. inconnue ou un mauvais jeton).
export function lireRetour(corps) {
  if (!corps || typeof corps !== 'object' || Array.isArray(corps)) return { ok: false, erreur: 'retour illisible' };
  if (typeof corps.etat !== 'string' || !Object.prototype.hasOwnProperty.call(ETATS_RETOUR, corps.etat))
    return { ok: false, erreur: 'etat inconnu (' + Object.keys(ETATS_RETOUR).join(', ') + ')' };
  const id = typeof corps.id === 'string' ? corps.id : '', cle = typeof corps.cle === 'string' ? corps.cle : '';
  if (!REF_RX.test(id) || !JETON_RX.test(cle)) return { ok: false, refus: true };
  const r = { id: id, cle: cle, etat: corps.etat };
  if (corps.resume !== undefined && corps.resume !== null) r.resume = propre(corps.resume, LIMITES.resume);
  if (corps.liens !== undefined && corps.liens !== null) r.liens = liensPropres(corps.liens);
  return { ok: true, r: r };
}

// LES PROJETS qui portent le bouton, dans l'ordre du pupitre (une ligne par projet, chacune avec son interrupteur).
// KOULAM a sa propre bulle « Modifier avec Claude » et sa propre routine (un autre abonnement Claude) : il n'envoie rien à ce relais,
// il lit seulement GET /etat?projet=koulam pour savoir s'il peut montrer sa bulle.
export const PROJETS = Object.freeze([
  { id: 'home', nom: 'Home' },
  { id: 'pupitre', nom: 'Pupitre' },
  { id: 'havroutia', nom: 'HavroutIA' },
  { id: 'avinou', nom: 'Avinou Malkenou' },
  { id: 'koulam', nom: 'KOULAM' },
].map((p) => Object.freeze(p)));
export const estProjet = (id) => typeof id === 'string' && PROJETS.some((p) => p.id === id);

// Le projet d'une page, d'après son adresse (la même règle que le bouton) : 770lab.com/home/robots… → pupitre, 770lab.com/home… → home,
// 770lab.com/havroutia… → havroutia, avinou-malkenou.web.app → avinou, koulam.app → koulam. Une autre adresse : null (aucun projet,
// seul l'interrupteur général compte).
export function projetDeLaPage(url) {
  let u;
  try { u = new URL(String(url || '')); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const hote = u.hostname.toLowerCase().replace(/^www\./, ''), chemin = (u.pathname || '/').toLowerCase();
  if (hote === '770lab.com') {
    if (chemin.startsWith('/home/robots')) return 'pupitre';
    if (chemin.startsWith('/home')) return 'home';
    if (chemin.startsWith('/havroutia')) return 'havroutia';
    return null;
  }
  if (hote === 'avinou-malkenou.web.app') return 'avinou';
  if (hote === 'koulam.app') return 'koulam';
  return null;
}
// Le projet d'une demande rangée : son champ « projet » (demandes récentes), sinon l'adresse de sa page (demandes d'avant).
export const projetDeLaDemande = (d) => (d && estProjet(d.projet) ? d.projet
  : projetDeLaPage(d && d.page && typeof d.page === 'object' ? d.page.url : ''));

// LES INTERRUPTEURS DU PUPITRE : un GÉNÉRAL (« Activé partout / Coupé partout ») et un PAR PROJET. Le bouton d'un projet se montre
// seulement si les deux sont activés. Rangés ensemble sous « etat » : { actif, depuis, par, projets: { <id>: { actif, depuis, par } } }.
// Un projet absent (ou un ancien état sans « projets ») : activé.
// Corps de POST /etat : { actif: true|false } (le général) ou { actif: true|false, projet: "<id>" } (ce projet seulement).
export function lireEtatBouton(corps) {
  if (!corps || typeof corps !== 'object' || Array.isArray(corps) || typeof corps.actif !== 'boolean')
    return { ok: false, erreur: 'réglage illisible : {"actif": true} ou {"actif": false}' };
  if (corps.projet === undefined || corps.projet === null) return { ok: true, actif: corps.actif };
  if (!estProjet(corps.projet)) return { ok: false, erreur: 'projet inconnu' };
  return { ok: true, actif: corps.actif, projet: corps.projet };
}
// Un interrupteur tel qu'il est rangé → sa forme lisible. Rien de rangé (ou illisible) : activé.
function interrupteur(x) {
  if (!x || typeof x !== 'object' || typeof x.actif !== 'boolean') return { actif: true, depuis: null, par: null };
  return { actif: x.actif, depuis: Number.isFinite(x.depuis) ? x.depuis : null, par: x.par ? propre(x.par, 60) : null };
}
// L'état tel qu'il est rangé → ce que voit tout le monde : le général, et TOUS les projets de PROJETS (valeurs par défaut comprises).
export function etatBouton(x) {
  const e = interrupteur(x);
  const p = x && typeof x === 'object' && x.projets && typeof x.projets === 'object' && !Array.isArray(x.projets) ? x.projets : {};
  e.projets = {};
  PROJETS.forEach(({ id }) => { e.projets[id] = interrupteur(Object.prototype.hasOwnProperty.call(p, id) ? p[id] : null); });
  return e;
}
// Le nouvel état à ranger (sans `projet` : le général ; avec : ce projet seulement, les autres ne bougent pas). Le même état que
// celui déjà rangé : « depuis » et « par » ne bougent pas (ils disent quand il a changé).
export function changerEtatBouton(stocke, actif, qui, quand, projet) {
  const e = etatBouton(stocke);
  const basculer = (avant) => (avant.actif === actif && avant.depuis !== null ? avant : { actif: actif, depuis: quand, par: propre(qui, 60) || null });
  if (projet === undefined || projet === null) return Object.assign(basculer({ actif: e.actif, depuis: e.depuis, par: e.par }), { projets: e.projets });
  if (!estProjet(projet)) throw new Error('projet inconnu');
  e.projets[projet] = basculer(e.projets[projet]);
  return e;
}
// Le bouton de ce projet peut-il se montrer (et envoyer) ? Le général ET celui du projet. Sans projet : le général seul.
export function boutonActif(e, projet) {
  e = etatBouton(e);
  return e.actif && (!estProjet(projet) || e.projets[projet].actif);
}
// La réponse de GET /etat (et de POST /etat). `o.projet` : ajoute « projet » et « effectif » (général ET ce projet).
// `o.masquer` (une page hors d'ORIGINES) : ni « depuis » ni « par », nulle part (le nom de qui a coupé ne la regarde pas).
export function vueEtat(e, o) {
  e = etatBouton(e); o = o || {};
  const cache = (i) => (o.masquer ? { actif: i.actif, depuis: null, par: null } : { actif: i.actif, depuis: i.depuis, par: i.par });
  const v = Object.assign({ ok: true }, cache(e), { projets: {} });
  PROJETS.forEach(({ id }) => { v.projets[id] = cache(e.projets[id]); });
  if (estProjet(o.projet)) { v.projet = o.projet; v.effectif = boutonActif(e, o.projet); }
  return v;
}
