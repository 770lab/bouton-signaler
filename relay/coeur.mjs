// Le cœur du relais « 🐞 Signaler » : des fonctions pures, sans dépendance, communes à tous les hébergements
// (Cloudflare Worker, Node, fonction serverless…). Le relais est la SEULE pièce qui connaît le jeton de la routine Claude :
// il ne quitte jamais le serveur.
//
//   page (signaler.js) ──POST /signaler──▶ relais ──POST …/routines/trig_…/fire──▶ routine Claude Code
//                                           │                                      (une session : corrige, teste, ouvre une PR)
//                                           ├─ range captures et note vocale, les sert sous une adresse impossible à deviner
//                                           └─ garde la DEMANDE (« Mes demandes » du bouton) ◀──POST /retour── la routine, à la fin :
//                                              son état (en ligne, à valider, question…), ses captures avant / après et ce
//                                              qu'il faut pour annuler, avec un jeton propre à cette demande
//
// Ce fichier porte aussi : la connexion par EMPREINTE (WebAuthn : CBOR, clés COSE, signatures, jeton de session signé HMAC),
// le MODE de chaque projet (direct / à valider), les DEUX abonnements Claude (et le passage de l'un à l'autre), le journal de la
// page et les éléments entourés recopiés dans le texte de la routine, les travaux ANNULER / VALIDER écrits par le relais, les
// clés d'équipe créées depuis le pupitre (« Nouvelle clé », avec l'empreinte) et les appareils DE CONFIANCE (une clé d'équipe
// seule inscrit un appareil, jamais un appareil qui crée une clé ou met en ligne).

export const LIMITES = {
  texte: 4000,              // le texte écrit ou dicté
  captures: 6,              // images par signalement
  captureOctets: 2_000_000, // une image (JPEG/PNG/WebP) une fois décodée
  audioOctets: 4_000_000,   // la note vocale (≈ 3 min)
  erreurs: 10,              // dernières erreurs de la page
  corpsOctets: 20_000_000,  // le corps JSON entier (le base64 grossit d'un tiers)
  texteRoutine: 60_000,     // l'API des routines accepte 65 536 caractères
  retourOctets: 5_000_000,  // le corps de POST /retour (envoyé par la routine, captures avant / après comprises)
  imageRetourOctets: 1_500_000, // une capture avant ou après, une fois décodée
  etatOctets: 1_024,        // le corps de POST /etat (l'interrupteur du pupitre), de /routine, de « Renvoyer »
  resume: 500,              // le résumé renvoyé par la routine
  liens: 5,                 // liens renvoyés (PR…), https seulement
  lien: 300,                // longueur d'un lien
  demandesIndex: 50,        // demandes gardées dans la liste de chaque personne
  demandesListe: 20,        // demandes rendues par GET /demandes
  demandeDureeS: 180 * 24 * 3600, // une demande s'efface 180 jours après sa dernière nouvelle (Workers KV) ; ses captures avant / après aussi
  elements: 10,             // éléments de la page entourés sur les captures
  journal: 200,             // événements de la boîte noire (les 30 dernières secondes)
  journalTexte: 8000,       // le journal tel qu'il est recopié dans le texte de la routine
  authOctets: 65_536,       // le corps des routes /auth (une attestation avec ses certificats tient en quelques Ko)
  defiDureeS: 300,          // un défi WebAuthn vaut 5 minutes, une seule fois
  sessionDureeMs: 30 * 24 * 3600 * 1000, // une session (après l'empreinte) vaut 30 jours (choix du propriétaire, 2026-10-21 ; 12 h avant)
  fraicheMs: 5 * 60 * 1000, // « empreinte fraîche » : posée il y a 5 minutes au plus (mettre en ligne)
  appareils: 20,            // appareils (clés d'accès) par personne
  appareilIdOctets: 255,    // l'identifiant d'une clé d'accès (une clé KV fait 512 octets au plus)
  renvoiApresMs: 15 * 60 * 1000, // une demande « en cours » sans nouvelle depuis 15 minutes peut être renvoyée
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

// LES ÉLÉMENTS ENTOURÉS (contexte.elements) : pour chaque trait tracé sur une capture, l'élément de la page dessous, tel que le
// bouton l'a relevé ({ ecran?, chemin, balise, id, classes, texte, onclick }). Des données de la page : bornées, jamais crues.
export function lireElement(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const classes = (Array.isArray(x.classes) ? x.classes : String(x.classes || '').split(/\s+/))
    .map((k) => propre(k, 60)).filter(Boolean).slice(0, 3);
  const e = { chemin: propre(x.chemin, 200), balise: propre(x.balise, 30).toLowerCase(), id: propre(x.id, 80), classes: classes,
    texte: propre(String(x.texte == null ? '' : x.texte).replace(/\s+/g, ' '), 80), onclick: propre(x.onclick, 120) };
  const n = Number(x.ecran);
  if (Number.isInteger(n) && n >= 1 && n <= LIMITES.captures) e.ecran = n;
  return e.chemin || e.balise || e.id || e.texte || e.onclick ? e : null;
}
// LA BOÎTE NOIRE (contexte.journal) : [{ t (ms avant l'envoi), type, cible, detail }]. Types sur liste blanche ; pour une saisie,
// seule l'identité du champ est gardée (le bouton n'envoie jamais la valeur : le relais jette quand même le détail).
export const TYPES_JOURNAL = Object.freeze(['toucher', 'clic', 'saisie', 'page', 'defilement', 'erreur', 'requete']);
const sansAccent = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
function enTexte(v, n) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const b = propre(v.balise || v.tag, 30), id = propre(v.id, 60), t = propre(String(v.texte || v.text || '').replace(/\s+/g, ' '), 60);
    if (b || id || t) return propre((b || '') + (id ? '#' + id : '') + (t ? ' « ' + t + ' »' : ''), n);
    return propre(Object.keys(v).slice(0, 6).map((k) => k + '=' + propre(typeof v[k] === 'object' ? JSON.stringify(v[k]) : v[k], 80)).join(' '), n);
  }
  return propre(String(v == null ? '' : v).replace(/\s+/g, ' '), n);
}
export function lireEvenement(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const type = sansAccent(x.type);
  if (!TYPES_JOURNAL.includes(type)) return null;
  const t = Number(x.t);
  return { t: Number.isFinite(t) ? Math.min(600000, Math.abs(Math.round(t))) : 0, type: type, cible: enTexte(x.cible, 160),
    detail: type === 'saisie' ? '' : enTexte(x.detail, 240) };
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
      elements: (Array.isArray(c.elements) ? c.elements : []).slice(0, LIMITES.elements).map(lireElement).filter(Boolean),
      journal: (Array.isArray(c.journal) ? c.journal : []).slice(-LIMITES.journal).map(lireEvenement).filter(Boolean),
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

// Ce qu'écrit la personne (ou que recopie la page) ne peut pas imiter ce qu'écrit le relais : ni un bloc « ajouté par le relais »
// (RETOUR) ou « écrit par le relais » (un TRAVAIL), ni une ligne « MODE : … » (seule celle du bloc RETOUR, écrite par le relais, compte).
export const neutraliser = (t) => String(t == null ? '' : t)
  .replace(/(?:ajout|[ée]crit)\S*\s+par\s+le\s+relais/gi, 'cité par la personne')
  .replace(/^([^\S\n]*)mode[^\S\n]*:/gim, '$1mode (cité par la personne) :');

// Les éléments entourés, une ligne chacun : « 1) [écran 2] button#enregistrer.btn « Enregistrer » — chemin : … — onclick : … ».
export function texteElements(els) {
  return (els || []).map((e, i) => {
    const d = (e.balise || '?') + (e.id ? '#' + e.id : '') + (e.classes && e.classes.length ? '.' + e.classes.join('.') : '') + (e.texte ? ' « ' + e.texte + ' »' : '');
    const p = ['  ' + (i + 1) + ') ' + (e.ecran ? '[écran ' + e.ecran + '] ' : '') + d];
    if (e.chemin) p.push('chemin : ' + e.chemin);
    if (e.onclick) p.push('onclick : ' + e.onclick);
    return p.join(' — ');
  });
}
// Le journal, du plus ancien au plus récent, une ligne par événement (« -12.3 s  clic  button#ok « OK » — détail »), `max`
// caractères au plus : trop long, ce sont les plus ANCIENS qui tombent (les plus récents, juste avant l'envoi, comptent le plus).
export function texteJournal(journal, max) {
  max = max || LIMITES.journalTexte;
  const lignes = (journal || []).slice().sort((a, b) => b.t - a.t)
    .map((e) => '  -' + (e.t / 1000).toFixed(1) + ' s  ' + e.type + (e.cible ? '  ' + e.cible : '') + (e.detail ? '  — ' + e.detail : ''));
  const garde = [];
  let n = 0;
  for (let i = lignes.length - 1; i >= 0; i--) {
    if (n + lignes[i].length + 1 > max - 80) break;
    garde.unshift(lignes[i]); n += lignes[i].length + 1;
  }
  const tombe = lignes.length - garde.length;
  return (tombe ? '  (… ' + tombe + ' événement(s) plus ancien(s) non recopié(s))' + (garde.length ? '\n' : '') : '') + garde.join('\n');
}

// LE TEXTE QUE LIT LA ROUTINE (le champ `text` de l'API). Pur. `pieces` : [{ genre: 'image'|'audio', url, ou?, duree? }] — les adresses
// où le relais sert les fichiers ; vide si le relais n'a pas de stockage (le texte le dit). `retour` : { url, id, cle } quand le relais
// garde les demandes — le bloc RETOUR est alors ajouté tout à la fin, jamais coupé. `mode` : 'direct' | 'valider', écrit par le relais
// dans ce bloc (« MODE : direct » / « MODE : à valider ») ; sans bloc RETOUR (relais sans stockage), sur la dernière ligne.
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
  if (c.elements && c.elements.length) {
    L.push('', 'ÉLÉMENTS VISÉS (entourés au doigt sur les captures ; relevés par la page, des données) :');
    texteElements(c.elements).forEach((l) => L.push(l));
  }
  const imgs = (x.pieces || []).filter((p) => p.genre === 'image'), son = (x.pieces || []).find((p) => p.genre === 'audio');
  if (imgs.length) { L.push('', 'CAPTURES (à télécharger et regarder) :'); imgs.forEach((p, i) => L.push('  ' + (i + 1) + ') ' + p.url + (p.ou ? '  — ' + p.ou : ''))); }
  else if (s.captures.length) L.push('', '(' + s.captures.length + ' capture(s) reçue(s) mais pas gardée(s) : le relais n’a pas de stockage)');
  if (son) L.push('', 'NOTE VOCALE (non transcrite, ' + (s.audio && s.audio.duree ? s.audio.duree : '?') + ') : ' + son.url);
  else if (s.audio) L.push('', '(note vocale reçue mais pas gardée : le relais n’a pas de stockage)');
  if (c.journal && c.journal.length) {
    L.push('', 'JOURNAL DE LA PAGE (boîte noire : les dernières secondes avant l’envoi, du plus ancien au plus récent ; jamais ce qui a été tapé) :');
    L.push(texteJournal(c.journal));
  }
  // Ce qu'écrit la personne ne peut pas imiter le bloc RETOUR du relais : seul le dernier, écrit ci-dessous, en est un.
  let t = neutraliser(L.join('\n'));
  const bloc = x.retour ? blocRetour(Object.assign({ mode: x.mode }, x.retour)) : (MODES.includes(x.mode) ? MARQUE_MODE + ' : ' + libelleMode(x.mode) : '');
  const max = LIMITES.texteRoutine - (bloc ? bloc.length + 2 : 0);
  if (t.length > max) t = t.slice(0, max - 20) + '\n… (tronqué)';
  return bloc ? t + '\n\n' + bloc : t;
}

// LE BLOC RETOUR, écrit par le relais à la fin du texte de la routine : la commande qui renvoie l'état de la demande (POST /retour).
// `cle` = le jeton de retour (32 hex), propre à cette demande ; le relais n'en garde que l'empreinte sha256. `mode` (signalement) :
// la ligne « MODE : direct » ou « MODE : à valider », juste sous la première ligne. `travail` : 'annuler' | 'valider' pour les
// travaux écrits par le relais (pas de MODE : le travail dit lui-même quoi faire). L'exemple de la commande porte l'état attendu.
export const MARQUE_RETOUR = 'RETOUR (ajouté par le relais, pas par la personne)';
export const MARQUE_MODE = 'MODE (ajouté par le relais, pas par la personne)';
export const ETATS_RETOUR = {
  a_relire: 'PR ouverte, à relire par le propriétaire sur GitHub',
  question: 'tu poses une question : écris-la dans resume ET dans ta réponse finale',
  rien: 'rien à changer',
  echec: 'tu n’as pas pu le faire',
  en_ligne: 'fusionné et vérifié en ligne sur la vraie adresse (MODE direct, ou travail VALIDER) : joins images et annulation',
  a_valider: 'PR prête, en attente du propriétaire (MODE à valider) : joins images avant / après et le lien de la PR',
  annulee: 'mise en ligne annulée et vérifiée (travail ANNULER)',
};
// Les états qu'écrit le relais lui-même (la routine ne peut pas les renvoyer).
export const ETATS_RELAIS = ['envoyee', 'pas_partie', 'en_cours_annulation', 'en_cours_validation'];
export const ETATS = ETATS_RELAIS.concat(Object.keys(ETATS_RETOUR));
export const LIBELLES_ETATS = Object.freeze({ envoyee: 'en cours', pas_partie: 'pas partie', a_relire: 'à relire', question: 'question',
  rien: 'rien à faire', echec: 'échec', en_ligne: 'en ligne', a_valider: 'à valider', annulee: 'annulée',
  en_cours_annulation: 'annulation en cours', en_cours_validation: 'mise en ligne en cours' });
// Ce qui attend le propriétaire (le petit nombre rouge du bouton).
export const A_TRAITER = Object.freeze(['question', 'a_relire', 'a_valider', 'pas_partie']);
// Une session Claude travaille (et peut être renvoyée si elle ne donne aucune nouvelle pendant 15 minutes).
export const EN_COURS = Object.freeze(['envoyee', 'en_cours_annulation', 'en_cours_validation']);
export const REF_RX = /^[0-9a-f]{12}$/;
const JETON_RX = /^[0-9a-f]{32}$/;

export function blocRetour(o) {
  const url = String(o.url || '');
  if (!REF_RX.test(String(o.id)) || !JETON_RX.test(String(o.cle)) || !/^https?:\/\/[^\s"'\\]+$/.test(url)) throw new Error('bloc RETOUR : réglage invalide');
  const exemple = o.travail === 'annuler' ? 'annulee' : o.travail === 'valider' ? 'en_ligne'
    : o.mode === 'direct' ? 'en_ligne' : o.mode === 'valider' ? 'a_valider' : 'a_relire';
  const corps = '{"id":"' + o.id + '","cle":"' + o.cle + '","etat":"' + exemple + '","resume":"<une ou deux phrases simples>","liens":["<lien de la PR>"]}';
  const L = [MARQUE_RETOUR + ' : à la fin, envoie TOUJOURS l\'état de cette demande :'];
  if (!o.travail && MODES.includes(o.mode)) L.push('MODE : ' + libelleMode(o.mode));
  L.push('curl -sS -X POST "' + url + '" -H "Content-Type: application/json" -d \'' + corps + '\'',
    'etat possibles : ' + Object.keys(ETATS_RETOUR).map((k) => k + ' (' + ETATS_RETOUR[k] + ')').join(', ') + '.',
    'Avec les captures avant / après ("images": {"avant": "data:image/jpeg;base64,…", "apres": "…"}, 1,5 Mo au plus chacune), ce qu’il faut '
      + 'pour annuler ("annulation": {"depot": "proprietaire/depot", "commits": ["<sha>"], "branche": "main"}) ou un aperçu ("apercu": "https://…") : '
      + 'écris le même JSON dans un fichier et envoie-le avec : curl -sS -X POST "' + url + '" -H "Content-Type: application/json" --data-binary @retour.json',
    'Dans resume, pas d’apostrophe droite (elle couperait la commande) : écris ’. Sans PR : "liens":[].');
  return L.join('\n');
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

// Retry-After (des secondes, ou une date HTTP) → une attente en ms (0 : rien de lisible), 7 jours au plus.
export function attenteDe(valeur, maintenant) {
  const v = String(valeur == null ? '' : valeur).trim();
  if (!v) return 0;
  const ms = /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v) - (maintenant || Date.now());
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 7 * 24 * 3600 * 1000) : 0;
}

// PRÉVENIR LA ROUTINE. L'API n'a pas de clé d'idempotence (deux appels = deux sessions) : un second essai SEULEMENT sur une réponse
// 500/503/529 (la session n'a pas été créée), jamais après une coupure réseau ni un 429. Le jeton ne part que vers une adresse de routine.
// `suffixe` : '' (abonnement 1) ou '_2' (abonnement 2), pour nommer le bon réglage dans les messages.
// Rend { ok, session, suivi } ou { ok: false, coupe?, statut?, attenteMs?, erreur }.
export async function prevenirRoutine(o) {
  const url = String(o.url || '').trim(), jeton = String(o.jeton || '').trim(), sfx = o.suffixe || '';
  if (!url || !jeton) return { ok: false, coupe: true, erreur: 'routine non réglée (ROUTINE_URL' + sfx + ' / ROUTINE_JETON' + sfx + ')' };
  if (!ROUTINE_RX.test(url)) return { ok: false, coupe: true, erreur: 'ROUTINE_URL' + sfx + ' n’est pas l’adresse d’une routine (…/routines/trig_…/fire)' };
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
    if ((rep.status === 500 || rep.status === 503 || rep.status === 529) && essai === 1) { await attendre(2000); continue; }
    const err = (corps && corps.error) || {};
    const r = { ok: false, statut: rep.status, erreur: 'routine ' + rep.status + (err.type ? ' ' + propre(err.type, 40) : '') + (err.message ? ' : ' + propre(err.message, 160) : '') };
    if (rep.status === 429) {
      const ra = rep.headers && typeof rep.headers.get === 'function' ? rep.headers.get('retry-after') : null;
      const ms = attenteDe(ra, Date.now());
      if (ms) r.attenteMs = ms;
    }
    return r;
  }
  return { ok: false, erreur: 'routine indisponible' };
}

// Le message que reçoit la page (et que garde la demande) quand la routine n'a pas été prévenue.
export const messageRoutine = (r) => propre(r.coupe ? 'le relais n’est pas encore relié à Claude' : 'Claude n’a pas pu être prévenu (' + r.erreur + ')', 600);

// ——— DEUX ABONNEMENTS CLAUDE ———
// Abonnement 1 = ROUTINE_URL / ROUTINE_JETON (comme avant), abonnement 2 (facultatif) = ROUTINE_URL_2 / ROUTINE_JETON_2 : deux
// routines, sur deux comptes Claude. Le relais prévient d'abord celui choisi au pupitre (« auto » : le 1 puis le 2), saute celui qui
// est noté indisponible (sauf s'ils le sont tous), et passe à l'autre aussitôt quand l'un refuse : 429 → indisponible jusqu'à
// Retry-After (1 h sans), 4xx → 6 h, avec la raison ; 500/503/529 → un second essai, puis l'autre. Une coupure réseau ou une autre
// réponse (502, 504…) : on ne sait pas si la session existe, on s'arrête là (jamais deux sessions pour une demande).
// L'état « routine » (rangé sans fin) : { choix: 'auto'|'1'|'2', depuis, par, indispo: { '1'|'2': { jusqua, raison } } }.
export const CLE_ROUTINE = 'routine';
export const CHOIX_ROUTINE = Object.freeze(['auto', '1', '2']);
export const INDISPO_429_MS = 3600 * 1000;
export const INDISPO_REFUS_MS = 6 * 3600 * 1000;
export function abonnementsDe(env) {
  env = env || {};
  return [['1', env.ROUTINE_URL, env.ROUTINE_JETON, ''], ['2', env.ROUTINE_URL_2, env.ROUTINE_JETON_2, '_2']].map(([id, url, jeton, suffixe]) => {
    url = String(url || '').trim(); jeton = String(jeton || '').trim();
    return { id: id, nom: 'Abonnement ' + id, url: url, jeton: jeton, suffixe: suffixe, regle: !!(url && jeton) };
  });
}
export function etatRoutine(x) {
  const e = { choix: 'auto', depuis: null, par: null, indispo: {} };
  if (!x || typeof x !== 'object' || Array.isArray(x)) return e;
  if (CHOIX_ROUTINE.includes(x.choix)) e.choix = x.choix;
  if (Number.isFinite(x.depuis)) e.depuis = x.depuis;
  if (x.par) e.par = propre(x.par, 60);
  const i = x.indispo && typeof x.indispo === 'object' && !Array.isArray(x.indispo) ? x.indispo : {};
  ['1', '2'].forEach((id) => {
    const y = Object.prototype.hasOwnProperty.call(i, id) ? i[id] : null;
    if (y && typeof y === 'object' && Number.isFinite(y.jusqua)) e.indispo[id] = { jusqua: y.jusqua, raison: propre(y.raison, 200) };
  });
  return e;
}
const indisponible = (e, id, maintenant) => !!(e.indispo[id] && e.indispo[id].jusqua > maintenant);
// L'ordre d'essai : le choisi d'abord (« auto » : 1 puis 2), sans ceux qui ne sont pas réglés ; les indisponibles sautés, sauf s'ils
// le sont tous (on les essaie alors quand même, dans l'ordre : l'indisponibilité a peut-être pris fin plus tôt).
export function ordreAbonnements(etat, abos, maintenant) {
  const e = etatRoutine(etat);
  const liste = (e.choix === '2' ? ['2', '1'] : ['1', '2']).map((id) => (abos || []).find((a) => a.id === id && a.regle)).filter(Boolean);
  const dispo = liste.filter((a) => !indisponible(e, a.id, maintenant));
  return dispo.length ? dispo : liste;
}
// « Renvoyer sur l'autre abonnement » : celui-là seul (même noté indisponible : la personne l'a demandé).
export const abonnementImpose = (abos, id) => (abos || []).filter((a) => a.id === id && a.regle);
// L'état « routine » après un essai sur l'abonnement `id`.
export function apresEssai(etat, id, r, maintenant) {
  const e = etatRoutine(etat);
  if (r && r.ok) { delete e.indispo[id]; return e; }
  const s = r && r.statut;
  if (s === 429) e.indispo[id] = { jusqua: maintenant + (r.attenteMs > 0 ? r.attenteMs : INDISPO_429_MS), raison: propre(r.erreur, 200) };
  else if (s >= 400 && s < 500) e.indispo[id] = { jusqua: maintenant + INDISPO_REFUS_MS, raison: propre(r.erreur, 200) };
  return e;
}
// Après un échec, essayer l'abonnement suivant ? Oui quand la session n'a sûrement pas été créée.
export const essayerLeSuivant = (r) => !!r && !r.ok && (!!r.coupe || (r.statut >= 400 && r.statut < 500) || [500, 503, 529].includes(r.statut));
// Prévenir la routine sur la liste donnée (ordreAbonnements ou abonnementImpose). Rend { r, etat } : r = { ok, session, suivi,
// abonnement } ou { ok: false, coupe?, statut?, erreur, raisons } ; etat = l'état « routine » à ranger (indisponibilités notées).
// `prefixer` : nommer l'abonnement dans le message (quand les deux sont réglés).
export async function prevenirAbonnements(o) {
  const liste = o.liste || [], maintenant = o.maintenant || Date.now;
  let e = etatRoutine(o.etat);
  if (!liste.length) return { r: { ok: false, coupe: true, erreur: 'routine non réglée (ROUTINE_URL / ROUTINE_JETON)' }, etat: e };
  const raisons = [];
  let dernier = null, coupes = 0;
  for (const a of liste) {
    const r = await prevenirRoutine({ url: a.url, jeton: a.jeton, suffixe: a.suffixe, texte: o.texte, fetch: o.fetch, attendre: o.attendre });
    e = apresEssai(e, a.id, r, maintenant());
    if (r.ok) return { r: Object.assign({}, r, { abonnement: a.id }), etat: e };
    dernier = r;
    if (r.coupe) coupes++;
    raisons.push({ abonnement: a.id, statut: r.statut || 0, erreur: r.erreur });
    if (!essayerLeSuivant(r)) break;
  }
  const erreur = raisons.map((x) => (o.prefixer ? 'abonnement ' + x.abonnement + ' : ' : '') + x.erreur).join(' ; ');
  const r = { ok: false, erreur: erreur, raisons: raisons };
  if (dernier.statut) r.statut = dernier.statut;
  if (coupes === raisons.length) r.coupe = true;   // aucun abonnement utilisable (adresse invalide) : « pas encore relié »
  return { r: r, etat: e };
}
// GET /routine : le choix et chaque abonnement (réglé ou non, indisponible jusqu'à quand et pourquoi). Jamais l'adresse ni le jeton.
export function vueRoutine(etat, abos, maintenant) {
  const e = etatRoutine(etat);
  return { ok: true, choix: e.choix, depuis: e.depuis, par: e.par, abonnements: (abos || []).map((a) => {
    const x = { id: a.id, nom: a.nom, regle: a.regle };
    if (a.regle && indisponible(e, a.id, maintenant)) x.indispo = { jusqua: e.indispo[a.id].jusqua, raison: e.indispo[a.id].raison };
    return x;
  }) };
}
// Corps de POST /routine : { choix: 'auto' | '1' | '2' } ; un abonnement non réglé ne se choisit pas.
export function lireChoixRoutine(corps, abos) {
  if (!corps || typeof corps !== 'object' || Array.isArray(corps) || !CHOIX_ROUTINE.includes(corps.choix))
    return { ok: false, erreur: 'choix illisible : {"choix": "auto"}, {"choix": "1"} ou {"choix": "2"}' };
  if (corps.choix !== 'auto' && !(abos || []).some((a) => a.id === corps.choix && a.regle)) {
    const sfx = corps.choix === '2' ? '_2' : '';
    return { ok: false, erreur: 'l’abonnement ' + corps.choix + ' n’est pas réglé (ROUTINE_URL' + sfx + ' / ROUTINE_JETON' + sfx + ')' };
  }
  return { ok: true, choix: corps.choix };
}
// Changer le choix efface les indisponibilités notées : le propriétaire qui choisit (après avoir rechargé ses crédits…) veut
// qu'on réessaie tout de suite.
export const changerChoixRoutine = (etat, choix, qui, quand) => ({ choix: choix, depuis: quand, par: propre(qui, 60) || null, indispo: {} });

// LES DEMANDES (« Mes demandes » du bouton). Rangées sous « demande:<réf> » ; la liste de chaque personne sous « demandes:<nom> »
// (les 50 dernières réfs, la plus récente d'abord) ; les interrupteurs du pupitre (général et par projet) sous « etat ».
// Aucune de ces clés n'a la forme d'une pièce (32 hex) : GET /piece ne peut pas les lire.
export const CLE_ETAT = 'etat';
export const cleDemande = (id) => 'demande:' + id;
export const cleIndex = (qui) => 'demandes:' + qui;

// La demande telle qu'elle est rangée juste après l'appel à la routine (avec son projet, d'après l'adresse de la page ; null
// pour une page d'aucun projet). `s` = le signalement vérifié (lireSignalement), `r` = la réponse de prevenirAbonnements
// (avec l'abonnement qui l'a prise), `retourHash` = l'empreinte du jeton de retour, `texteRoutine` = le texte (son bloc RETOUR est
// retiré avant d'être rangé), `mode` = le mode du projet écrit dans ce texte.
export function nouvelleDemande(o) {
  const s = o.s, c = s.contexte;
  const d = { id: o.id, creeLeMs: o.quand, majLeMs: o.quand, qui: o.qui, type: s.type, texte: s.texte,
    page: { url: c.url, titre: c.titre }, projet: projetDeLaPage(c.url), captures: s.captures.length, audio: !!s.audio, etat: 'envoyee' };
  return apresEnvoi(d, o.r, o);
}

// Après un appel à la routine (le premier, « Renvoyer », ou un travail ANNULER / VALIDER). Parti : l'état visé (`o.etat`, envoyée
// par défaut), l'heure de l'envoi, l'abonnement, le lien de la session, le jeton neuf. Pas parti : la raison dans `erreur` et
// « pas partie » — sauf avec `o.garder` (un travail sur une demande déjà en ligne / à valider, ou le renvoi d'une session muette) :
// l'état d'avant et son jeton de retour restent, seule la raison s'ajoute (on ne fait pas croire que rien n'est en ligne).
export function apresEnvoi(d, r, o) {
  const x = Object.assign({}, d, { majLeMs: o.quand });
  const texte = () => { if (o.texteRoutine !== undefined) x.texteRoutine = sansRetour(o.texteRoutine); if (o.mode) x.mode = o.mode; };
  if (r && r.ok) {
    x.etat = o.etat || 'envoyee'; x.envoyeLeMs = o.quand; x.retourHash = o.retourHash; texte();
    if (r.abonnement) x.abonnement = r.abonnement;
    delete x.sessionUrl; delete x.erreur;
    if (r.suivi) x.sessionUrl = r.suivi;
    delete x.regleeLeMs;   // repartie chez Claude : plus « réglée »
    return x;
  }
  x.erreur = messageRoutine(r || {});
  if (o.garder) return x;
  x.etat = 'pas_partie'; x.retourHash = o.retourHash; texte();
  delete x.sessionUrl;
  return x;
}

// Après un retour de la routine. Un champ absent du retour garde sa valeur d'avant (question, puis PR à relire…). `images` :
// { avant?, apres? } = les adresses où le relais sert les captures du retour (une seule envoyée : l'autre reste).
export function apresRetour(d, r, quand, images) {
  const x = Object.assign({}, d, { etat: r.etat, majLeMs: quand, retourLeMs: quand });
  delete x.erreur;
  if (r.resume !== undefined) x.resume = r.resume;
  if (r.liens !== undefined) x.liens = r.liens;
  if (r.apercu !== undefined) x.apercu = r.apercu;
  if (r.annulation === null) delete x.annulation;
  else if (r.annulation !== undefined) x.annulation = r.annulation;
  if (images && Object.keys(images).length) x.images = Object.assign({}, d.images, images);
  return x;
}

// « Réglé » / « Rouvrir » (l'Atelier) : la personne range elle-même une conversation dans « Réglé », sur tous ses appareils.
// Seulement une marque (regleeLeMs) : l'état, le résumé et les gestes restent ceux de Claude. Une demande qui repart chez Claude
// (renvoyer, annuler, valider : apresEnvoi) n'est plus réglée.
export function regler(d, quand) { return Object.assign({}, d, { regleeLeMs: quand }); }
export function rouvrir(d) { const x = Object.assign({}, d); delete x.regleeLeMs; return x; }
// « À vérifier » (21/10/2026, Yoann : « dans chaque conv rajoute un bouton à vérifier, comme ça je traite plus tard ») : une marque à soi,
// sur tous ses appareils, comme « Réglé » ; elle reste quand la demande repart chez Claude (on l'enlève soi-même).
export function verifier(d, quand) { return Object.assign({}, d, { averifierLeMs: quand }); }
export function deverifier(d) { const x = Object.assign({}, d); delete x.averifierLeMs; return x; }

// Les PR GitHub parmi les liens d'une demande (ce que VALIDER fusionne).
const PR_RX = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}\/pull\/\d{1,7}\/?$/;
export const prsDe = (liens) => (Array.isArray(liens) ? liens : []).filter((l) => typeof l === 'string' && PR_RX.test(l));

// « Renvoyer » : une demande pas partie ; ou une session qui travaille (en cours, annulation ou mise en ligne en cours) et ne
// donne aucune nouvelle depuis 15 minutes (son abonnement n'a peut-être plus de crédit : « Renvoyer sur l'autre abonnement »).
export function peutRenvoyer(d, maintenant) {
  if (!d || typeof d !== 'object') return false;
  if (d.etat === 'pas_partie') return !!d.texteRoutine;
  if (!EN_COURS.includes(d.etat)) return false;
  if (d.etat === 'envoyee' && !d.texteRoutine) return false;
  if (d.etat === 'en_cours_annulation' && !d.annulation) return false;
  if (d.etat === 'en_cours_validation' && !prsDe(d.liens).length) return false;
  const t = Number(d.envoyeLeMs || d.majLeMs);
  return Number.isFinite(t) && t > 0 && maintenant - t > LIMITES.renvoiApresMs;
}
// Ce que la page peut proposer pour cette demande (le relais refuse tout le reste) : 'annuler' (en ligne, avec ce qu'il faut
// pour annuler), 'valider' (à valider, avec sa PR ; jamais Avinou Malkenou : son propriétaire le met en ligne depuis son Mac),
// 'renvoyer' (peutRenvoyer).
export function actionsDemande(d, maintenant) {
  if (!d || typeof d !== 'object') return [];
  const projet = projetDeLaDemande(d), a = [];
  if (d.etat === 'en_ligne' && d.annulation && projet !== 'avinou') a.push('annuler');
  if (d.etat === 'a_valider' && projet !== 'avinou' && prsDe(d.liens).length) a.push('valider');
  if (peutRenvoyer(d, maintenant)) a.push('renvoyer');
  return a;
}

// Ce qu'une page a le droit de voir d'une demande : une liste blanche. Jamais l'empreinte du jeton ni le texte de la routine.
// Le lien de la session Claude seulement si le relais le montre déjà après l'envoi (MONTRER_SUIVI = « oui »). Le projet : celui
// de la demande, ou, pour une demande rangée avant les projets, celui de l'adresse de sa page (absent : aucun projet).
// « actions » (seulement s'il y en a) : actionsDemande.
const CHAMPS_PUBLICS = ['id', 'creeLeMs', 'majLeMs', 'envoyeLeMs', 'qui', 'type', 'texte', 'page', 'projet', 'captures', 'audio', 'etat', 'erreur',
  'sessionUrl', 'resume', 'liens', 'mode', 'abonnement', 'images', 'apercu', 'annulation', 'regleeLeMs', 'averifierLeMs'];
export function demandePublique(d, o) {
  const x = {};
  CHAMPS_PUBLICS.forEach((k) => { if (d && d[k] !== undefined && d[k] !== null) x[k] = d[k]; });
  if (!(o && o.suivi)) delete x.sessionUrl;
  const projet = projetDeLaDemande(d);
  if (projet) x.projet = projet; else delete x.projet;
  const actions = actionsDemande(d, (o && o.maintenant) || Date.now());
  if (actions.length) x.actions = actions;
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

// CE QU'IL FAUT POUR ANNULER une mise en ligne (champ « annulation » du retour) : { depot: "proprietaire/depot", commits: [sha…],
// branche: "main", autres?: [{ depot, commits, branche }] } — « autres » pour un projet en deux dépôts (HavroutIA : la source et
// l'export publié), 3 au plus. Des sha hexadécimaux (7 à 40), 20 au plus par dépôt ; une branche qui ne commence pas par « - ».
const DEPOT_RX = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
const SHA_RX = /^[0-9a-f]{7,40}$/;
const BRANCHE_RX = /^(?![-/.])(?!.*\.\.)(?!.*\/\/)(?!.*[/.]$)[A-Za-z0-9._/-]{1,100}$/;
function uneAnnulation(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const depot = String(x.depot == null ? '' : x.depot).trim();
  const commits = (Array.isArray(x.commits) ? x.commits : [x.commits]).map((c) => String(c == null ? '' : c).trim().toLowerCase());
  const branche = x.branche === undefined || x.branche === null || x.branche === '' ? 'main' : String(x.branche).trim();
  if (!DEPOT_RX.test(depot) || !commits.length || commits.length > 20 || !commits.every((c) => SHA_RX.test(c)) || !BRANCHE_RX.test(branche)) return null;
  return { depot: depot, commits: commits.filter((c, i) => commits.indexOf(c) === i), branche: branche };
}
export function lireAnnulation(x) {
  const ko = { ok: false, erreur: 'annulation illisible : {"depot": "proprietaire/depot", "commits": ["<sha>"], "branche": "main"}' };
  const a = uneAnnulation(x);
  if (!a) return ko;
  if (x.autres !== undefined && x.autres !== null) {
    if (!Array.isArray(x.autres) || x.autres.length > 3) return ko;
    const autres = x.autres.map(uneAnnulation);
    if (autres.some((y) => !y)) return ko;
    if (autres.length) a.autres = autres;
  }
  return { ok: true, annulation: a };
}

// LE RETOUR DE LA ROUTINE (corps de POST /retour), vérifié. Rend { ok: true, r }, { ok: false, erreur } (corps mal formé : 400),
// ou { ok: false, refus: true } (réf. ou jeton qui n'ont pas la bonne forme : même refus qu'une réf. inconnue ou un mauvais jeton).
// En plus de etat / resume / liens : « images » { avant?, apres? } (data:image/jpeg|png|webp;base64,…, 1,5 Mo au plus chacune,
// rendues décodées : { mime, octets }), « annulation » (lireAnnulation ; null l'efface), « apercu » (un lien https).
export function lireRetour(corps) {
  if (!corps || typeof corps !== 'object' || Array.isArray(corps)) return { ok: false, erreur: 'retour illisible' };
  if (typeof corps.etat !== 'string' || !Object.prototype.hasOwnProperty.call(ETATS_RETOUR, corps.etat))
    return { ok: false, erreur: 'etat inconnu (' + Object.keys(ETATS_RETOUR).join(', ') + ')' };
  const id = typeof corps.id === 'string' ? corps.id : '', cle = typeof corps.cle === 'string' ? corps.cle : '';
  if (!REF_RX.test(id) || !JETON_RX.test(cle)) return { ok: false, refus: true };
  const r = { id: id, cle: cle, etat: corps.etat };
  if (corps.resume !== undefined && corps.resume !== null) r.resume = propre(corps.resume, LIMITES.resume);
  if (corps.liens !== undefined && corps.liens !== null) r.liens = liensPropres(corps.liens);
  if (corps.images !== undefined && corps.images !== null) {
    if (typeof corps.images !== 'object' || Array.isArray(corps.images))
      return { ok: false, erreur: 'images illisibles : {"avant": "data:image/jpeg;base64,…", "apres": "data:image/jpeg;base64,…"}' };
    const images = {};
    for (const k of ['avant', 'apres']) {
      const v = corps.images[k];
      if (v === undefined || v === null || v === '') continue;
      const m = IMAGE_RX.exec(String(v));
      if (!m) return { ok: false, erreur: 'image ' + k + ' illisible (data:image/jpeg, png ou webp en base64)' };
      const octets = decoder64(m[2]);
      if (octets.length > LIMITES.imageRetourOctets) return { ok: false, erreur: 'image ' + k + ' trop lourde (1,5 Mo au plus)' };
      images[k] = { mime: m[1], octets: octets };
    }
    if (Object.keys(images).length) r.images = images;
  }
  if (corps.annulation === null) r.annulation = null;
  else if (corps.annulation !== undefined) {
    const a = lireAnnulation(corps.annulation);
    if (!a.ok) return { ok: false, erreur: a.erreur };
    r.annulation = a.annulation;
  }
  if (corps.apercu !== undefined && corps.apercu !== null) { const l = liensPropres([corps.apercu]); if (l.length) r.apercu = l[0]; }
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
  { id: 'gescom', nom: 'GesCom' },
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
    if (chemin.startsWith('/gescom')) return 'gescom';
    return null;
  }
  if (hote === 'avinou-malkenou.web.app') return 'avinou';
  if (hote === 'koulam.app') return 'koulam';
  return null;
}
// Le projet d'une demande rangée : son champ « projet » (demandes récentes), sinon l'adresse de sa page (demandes d'avant).
export const projetDeLaDemande = (d) => (d && estProjet(d.projet) ? d.projet
  : projetDeLaPage(d && d.page && typeof d.page === 'object' ? d.page.url : ''));


// LE MODE DE CHAQUE PROJET : « direct » (la routine corrige, fusionne dans main, attend que ce soit en ligne : « en ligne », avec
// les captures avant / après et de quoi annuler) ou « valider » (elle ouvre la PR et s'arrête : « à valider » ; le propriétaire met
// en ligne d'un geste, avec son empreinte). Par défaut : direct pour Home, le pupitre et HavroutIA ; à valider pour Avinou Malkenou,
// qui ne passe JAMAIS en direct (ses règles : son propriétaire met en ligne lui-même, depuis son Mac / son coffre) ; KOULAM a sa
// propre bulle et sa propre routine (en direct) : son mode ne se règle pas ici. Une page d'aucun projet : à valider.
export const MODES = Object.freeze(['direct', 'valider']);
const MODE_PAR_DEFAUT = Object.freeze({ home: 'direct', pupitre: 'direct', havroutia: 'direct', avinou: 'valider', koulam: 'direct' });
export const MODE_FIGE = Object.freeze({ avinou: 'valider', koulam: 'direct' });
export const MESSAGES_MODE_FIGE = Object.freeze({
  avinou: 'Avinou Malkenou reste « à valider » : son propriétaire le met en ligne lui-même, depuis son Mac (son coffre).',
  koulam: 'KOULAM a sa propre bulle et sa propre routine (en direct) : son mode ne se règle pas ici.',
});
export const libelleMode = (m) => (m === 'direct' ? 'direct' : 'à valider');
function modeLu(id, x) {
  if (MODE_FIGE[id]) return MODE_FIGE[id];
  return x && typeof x === 'object' && MODES.includes(x.mode) ? x.mode : (MODE_PAR_DEFAUT[id] || 'valider');
}

// LES INTERRUPTEURS DU PUPITRE : un GÉNÉRAL (« Activé partout / Coupé partout ») et un PAR PROJET. Le bouton d'un projet se montre
// seulement si les deux sont activés. Rangés ensemble sous « etat » : { actif, depuis, par, projets: { <id>: { actif, depuis, par,
// mode } } }. Un projet absent (ou un ancien état sans « projets ») : activé, dans son mode par défaut.
// Corps de POST /etat : { actif: true|false } (le général), { actif: true|false, projet: "<id>" } (ce projet seulement),
// { projet: "<id>", mode: "direct"|"valider" } (son mode ; « actif » peut s'y ajouter).
export function lireEtatBouton(corps) {
  const illisible = { ok: false, erreur: 'réglage illisible : {"actif": true} ou {"actif": false}' };
  if (!corps || typeof corps !== 'object' || Array.isArray(corps)) return illisible;
  const aActif = typeof corps.actif === 'boolean', aMode = corps.mode !== undefined && corps.mode !== null;
  if ((!aActif && !aMode) || (corps.actif !== undefined && !aActif)) return illisible;
  if (aMode && !MODES.includes(corps.mode)) return { ok: false, erreur: 'mode inconnu : "direct" ou "valider"' };
  if (corps.projet === undefined || corps.projet === null) {
    if (aMode) return { ok: false, erreur: 'le mode se règle par projet : {"projet": "<id>", "mode": "direct"}' };
    return { ok: true, actif: corps.actif };
  }
  if (!estProjet(corps.projet)) return { ok: false, erreur: 'projet inconnu' };
  if (aMode && MODE_FIGE[corps.projet] && corps.mode !== MODE_FIGE[corps.projet]) return { ok: false, erreur: MESSAGES_MODE_FIGE[corps.projet] };
  const r = { ok: true, projet: corps.projet };
  if (aActif) r.actif = corps.actif;
  if (aMode) r.mode = corps.mode;
  return r;
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
  PROJETS.forEach(({ id }) => {
    const brut = Object.prototype.hasOwnProperty.call(p, id) ? p[id] : null;
    e.projets[id] = Object.assign(interrupteur(brut), { mode: modeLu(id, brut) });
  });
  return e;
}
// Le nouvel état à ranger (sans `projet` : le général ; avec : ce projet seulement, les autres ne bougent pas). Le même état que
// celui déjà rangé : « depuis » et « par » ne bougent pas (ils disent quand il a changé). `actif` absent : l'interrupteur ne bouge
// pas ; `mode` : le mode de ce projet (refusé pour un projet au mode fixe).
export function changerEtatBouton(stocke, actif, qui, quand, projet, mode) {
  const e = etatBouton(stocke);
  const basculer = (avant) => (typeof actif !== 'boolean' || (avant.actif === actif && avant.depuis !== null) ? avant
    : { actif: actif, depuis: quand, par: propre(qui, 60) || null });
  const aMode = mode !== undefined && mode !== null;
  if (projet === undefined || projet === null) {
    if (aMode) throw new Error('le mode se règle par projet');
    return Object.assign(basculer({ actif: e.actif, depuis: e.depuis, par: e.par }), { projets: e.projets });
  }
  if (!estProjet(projet)) throw new Error('projet inconnu');
  const avant = e.projets[projet];
  if (aMode && (!MODES.includes(mode) || (MODE_FIGE[projet] && mode !== MODE_FIGE[projet]))) throw new Error('mode refusé pour ce projet');
  e.projets[projet] = Object.assign(basculer({ actif: avant.actif, depuis: avant.depuis, par: avant.par }), { mode: aMode ? mode : avant.mode });
  return e;
}
// Le bouton de ce projet peut-il se montrer (et envoyer) ? Le général ET celui du projet. Sans projet : le général seul.
export function boutonActif(e, projet) {
  e = etatBouton(e);
  return e.actif && (!estProjet(projet) || e.projets[projet].actif);
}
// Le mode d'un projet (une page d'aucun projet : à valider).
export const modeDuProjet = (e, projet) => (estProjet(projet) ? etatBouton(e).projets[projet].mode : 'valider');
// La réponse de GET /etat (et de POST /etat). `o.projet` : ajoute « projet », « effectif » (général ET ce projet) et « mode ».
// `o.masquer` (une page hors d'ORIGINES) : ni « depuis » ni « par », nulle part (le nom de qui a coupé ne la regarde pas).
// « modes » : le mode de chaque projet (aussi dans chaque entrée de « projets »).
export function vueEtat(e, o) {
  e = etatBouton(e); o = o || {};
  const cache = (i) => (o.masquer ? { actif: i.actif, depuis: null, par: null } : { actif: i.actif, depuis: i.depuis, par: i.par });
  const v = Object.assign({ ok: true }, cache(e), { projets: {}, modes: {} });
  PROJETS.forEach(({ id }) => { v.projets[id] = Object.assign(cache(e.projets[id]), { mode: e.projets[id].mode }); v.modes[id] = e.projets[id].mode; });
  if (estProjet(o.projet)) { v.projet = o.projet; v.effectif = boutonActif(e, o.projet); v.mode = e.projets[o.projet].mode; }
  return v;
}
export const nomDuProjet = (id) => { const p = PROJETS.find((x) => x.id === id); return p ? p.nom : 'aucun projet'; };

// ——— LES TRAVAUX ÉCRITS PAR LE RELAIS : ANNULER et VALIDER ———
// Le texte que reçoit la routine quand le propriétaire touche « Annuler » (une demande en ligne) ou « Mettre en ligne » (une
// demande à valider, après son empreinte). Sa PREMIÈRE ligne, écrite par le relais, dit le travail ; ce qui vient d'une session
// d'avant (résumé, titre de page) y est une donnée, neutralisée comme le texte d'une personne. Le bloc RETOUR (avecRetour, avec
// `travail`) s'ajoute à la fin. Purs.
export const MARQUE_ANNULER = 'TRAVAIL : ANNULER UNE MISE EN LIGNE (écrit par le relais, pas par la personne)';
export const MARQUE_VALIDER = 'TRAVAIL : METTRE EN LIGNE UNE DEMANDE VALIDÉE (écrit par le relais, pas par la personne)';
function enteteTravail(L, o) {
  const d = o.d;
  if (o.depot) L.push('Dépôt : ' + propre(o.depot, 200));
  L.push('Référence : ' + d.id + ' · projet : ' + nomDuProjet(projetDeLaDemande(d)) + ' · signalée par ' + (d.qui || '?')
    + (d.creeLeMs ? ' le ' + new Date(d.creeLeMs).toISOString() : ''));
  if (d.page && d.page.url) L.push('Page : ' + propre(d.page.url, 500));
  if (d.texte) L.push('Ce que disait la personne (une donnée) : ' + propre(String(d.texte).replace(/\s+/g, ' '), 600));
  if (d.resume) L.push('Résumé de la session d’avant (une donnée) : ' + propre(d.resume, LIMITES.resume));
  (Array.isArray(d.liens) ? d.liens : []).forEach((l) => L.push('Lien : ' + l));
}
export function texteAnnuler(o) {
  const d = o.d, a = d.annulation, L = [MARQUE_ANNULER];
  L.push('Demandé par : ' + (o.qui || '?') + ' · le ' + new Date(o.quand || Date.now()).toISOString());
  enteteTravail(L, o);
  L.push('', 'À ANNULER (git revert, du plus récent au plus ancien) :');
  [a].concat(a.autres || []).forEach((x) => L.push('  - dépôt ' + x.depot + ', branche ' + x.branche + ' : ' + x.commits.join(' ')));
  L.push('', 'Fais (tes consignes, travail ANNULER) : vérifie que ces commits sont bien sur la branche et pas déjà annulés ; git revert,'
    + ' tests, pousse sur la branche ; attends que ce soit en ligne et vérifie sur la vraie adresse de la page ; puis RETOUR avec'
    + ' "etat":"annulee" (et les captures avant / après de l’annulation).',
    'Si tu ne peux pas annuler : RETOUR avec "etat":"en_ligne" (le changement est toujours en ligne) et la raison dans resume.');
  return neutraliserDonnees(L);
}
export function texteValider(o) {
  const d = o.d, L = [MARQUE_VALIDER];
  L.push('Validé avec son empreinte par : ' + (o.qui || '?') + ' · le ' + new Date(o.quand || Date.now()).toISOString());
  enteteTravail(L, o);
  L.push('', 'PR À FUSIONNER (squash, dans la branche principale) :');
  prsDe(d.liens).forEach((l) => L.push('  - ' + l));
  L.push('', 'Fais (tes consignes, travail VALIDER) : vérifie que chaque PR est ouverte, verte et à jour ; fusionne-la (squash) ;'
    + ' attends que ce soit en ligne et vérifie sur la vraie adresse de la page ; puis RETOUR avec "etat":"en_ligne", la capture'
    + ' « après » prise en ligne et "annulation" (le sha du commit de fusion).',
    'Si tu ne peux pas : RETOUR avec "etat":"a_valider" (la PR attend toujours) et la raison dans resume.');
  return neutraliserDonnees(L);
}
// La première ligne est celle du relais ; tout le reste passe par neutraliser (rien n'y imite un bloc du relais).
function neutraliserDonnees(L) { return L[0] + '\n' + neutraliser(L.slice(1).join('\n')); }

// ——— LA CONNEXION PAR EMPREINTE (WebAuthn, « clés d'accès ») ———
// Une personne qui a déjà une clé d'équipe (ou une session) inscrit son appareil (POST /auth/options/inscription puis
// /auth/inscription) ; ensuite elle se connecte par l'empreinte, sans rien taper (/auth/options/connexion puis /auth/connexion) et
// reçoit une SESSION de 30 jours : un jeton signé par le relais (HMAC-SHA256 avec le secret SESSION_SECRET), accepté partout où la
// clé d'équipe l'est (Authorization: Bearer <session>). Aucune bibliothèque : le CBOR, les clés COSE et les signatures sont lus ici.

// base64url (sans « = ») ↔ octets. Le décodage accepte aussi le base64 ordinaire (+ /) et les « = » de fin ; null si illisible.
export function b64u(octets) {
  const u = octets instanceof Uint8Array ? octets : new Uint8Array(octets);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function deB64u(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_+/-]*={0,2}$/.test(s)) return null;
  const t = s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (t.length % 4 === 1) return null;
  try { return decoder64(t + '==='.slice((t.length + 3) % 4)); } catch (e) { return null; }
}
const egauxOctets = (a, b) => {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
};
async function sha256(octets) { return new Uint8Array(await crypto.subtle.digest('SHA-256', octets)); }
const aleatoire = (n) => { const u = new Uint8Array(n); crypto.getRandomValues(u); return u; };

// UN DÉCODEUR CBOR MINIMAL (RFC 8949), ce qu'il faut pour WebAuthn : entiers, octets, textes, tableaux, tables (rendues en Map :
// les clés COSE sont des entiers), vrai / faux / nul, flottants, étiquettes (ignorées). Longueurs indéfinies refusées (CTAP2 n'en
// envoie pas), clé en double refusée, 16 niveaux au plus. Rend { valeur, fin } : `fin` = l'octet qui suit (une clé COSE est suivie
// d'autres données dans authenticatorData). Lève une erreur sur des données coupées ou mal formées.
export function lireCbor(octets, debut) {
  const u = octets instanceof Uint8Array ? octets : new Uint8Array(octets);
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  let i = debut || 0, profondeur = 0;
  const besoin = (n) => { if (!(n >= 0) || i + n > u.length) throw new Error('CBOR : données coupées'); };
  function longueur(info) {
    if (info < 24) return info;
    if (info === 24) { besoin(1); return u[i++]; }
    if (info === 25) { besoin(2); const v = dv.getUint16(i); i += 2; return v; }
    if (info === 26) { besoin(4); const v = dv.getUint32(i); i += 4; return v; }
    if (info === 27) {
      besoin(8); const haut = dv.getUint32(i), bas = dv.getUint32(i + 4); i += 8;
      if (haut > 0x1fffff) throw new Error('CBOR : entier trop grand');
      return haut * 4294967296 + bas;
    }
    throw new Error('CBOR : longueur indéfinie ou réservée');
  }
  function demi(h) {
    const signe = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    if (e === 0) return signe * f * Math.pow(2, -24);
    if (e === 31) return f ? NaN : signe * Infinity;
    return signe * (1 + f / 1024) * Math.pow(2, e - 15);
  }
  function element() {
    besoin(1);
    const b = u[i++], majeur = b >> 5, info = b & 31;
    if (majeur === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      if (info === 23) return undefined;
      if (info === 25) { besoin(2); const v = demi(dv.getUint16(i)); i += 2; return v; }
      if (info === 26) { besoin(4); const v = dv.getFloat32(i); i += 4; return v; }
      if (info === 27) { besoin(8); const v = dv.getFloat64(i); i += 8; return v; }
      throw new Error('CBOR : valeur simple inconnue');
    }
    const n = longueur(info);
    if (majeur === 0) return n;
    if (majeur === 1) return -1 - n;
    if (majeur === 2) { besoin(n); const o = u.slice(i, i + n); i += n; return o; }
    if (majeur === 3) { besoin(n); const t = new TextDecoder('utf-8', { fatal: true }).decode(u.subarray(i, i + n)); i += n; return t; }
    if (++profondeur > 16) throw new Error('CBOR : trop imbriqué');
    let v;
    if (majeur === 4) { v = []; for (let k = 0; k < n; k++) v.push(element()); }
    else if (majeur === 5) {
      v = new Map();
      for (let k = 0; k < n; k++) {
        const cle = element();
        if (typeof cle === 'object' && cle !== null) throw new Error('CBOR : clé de table non prise en charge');
        if (v.has(cle)) throw new Error('CBOR : clé en double');
        v.set(cle, element());
      }
    } else v = element();   // majeur 6 : une étiquette, ignorée
    profondeur--;
    return v;
  }
  const valeur = element();
  return { valeur: valeur, fin: i };
}

// authenticatorData : sha256(rpId) (32 octets), drapeaux (UP 0x01, UV 0x04, BE 0x08, BS 0x10, AT 0x40, ED 0x80), compteur (4 octets),
// puis, avec AT, attestedCredentialData (aaguid 16, longueur 2, identifiant, clé COSE en CBOR), puis, avec ED, les extensions.
// Lève une erreur si c'est coupé ou s'il reste des octets.
export const DRAPEAUX = Object.freeze({ UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 });
export function lireAuthData(octets) {
  const u = octets;
  if (!(u instanceof Uint8Array) || u.length < 37) throw new Error('authenticatorData trop court');
  const drapeaux = u[32];
  const x = { rpIdHash: u.slice(0, 32), drapeaux: drapeaux, up: !!(drapeaux & DRAPEAUX.UP), uv: !!(drapeaux & DRAPEAUX.UV),
    compteur: new DataView(u.buffer, u.byteOffset, u.byteLength).getUint32(33) };
  let i = 37;
  if (drapeaux & DRAPEAUX.AT) {
    if (u.length < i + 18) throw new Error('attestedCredentialData coupé');
    x.aaguid = u.slice(i, i + 16); i += 16;
    const n = (u[i] << 8) | u[i + 1]; i += 2;
    if (!n || u.length < i + n) throw new Error('identifiant de l’appareil coupé');
    x.idAppareil = u.slice(i, i + n); i += n;
    const c = lireCbor(u, i);
    x.cleCose = c.valeur; i = c.fin;
  }
  if (drapeaux & DRAPEAUX.ED) { const e = lireCbor(u, i); x.extensions = e.valeur; i = e.fin; }
  if (i !== u.length) throw new Error('authenticatorData : octets en trop');
  return x;
}

// Une clé COSE (Map) → { alg, jwk } pour crypto.subtle : EC2 P-256 (alg -7, ES256) ou RSA (alg -257, RS256, 2048 bits au moins).
// Toute autre clé est refusée (on n'en a demandé que deux).
export function coseVersJwk(m) {
  if (!(m instanceof Map)) throw new Error('clé de l’appareil illisible');
  const kty = m.get(1), alg = m.get(3);
  if (kty === 2 && alg === -7) {
    const x = m.get(-2), y = m.get(-3);
    if (m.get(-1) !== 1 || !(x instanceof Uint8Array) || x.length !== 32 || !(y instanceof Uint8Array) || y.length !== 32)
      throw new Error('clé EC2 illisible (P-256 attendu)');
    return { alg: -7, jwk: { kty: 'EC', crv: 'P-256', x: b64u(x), y: b64u(y) } };
  }
  if (kty === 3 && alg === -257) {
    let n = m.get(-1), e = m.get(-2);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array)) throw new Error('clé RSA illisible');
    let k = 0; while (k < n.length - 1 && n[k] === 0) k++; n = n.subarray(k);
    k = 0; while (k < e.length - 1 && e[k] === 0) k++; e = e.subarray(k);
    if (n.length < 256 || n.length > 1024 || !e.length || e.length > 8) throw new Error('clé RSA refusée (2048 bits au moins)');
    return { alg: -257, jwk: { kty: 'RSA', n: b64u(n), e: b64u(e) } };
  }
  throw new Error('genre de clé non pris en charge (ES256 ou RS256 seulement)');
}

// Une signature ECDSA en DER (SEQUENCE { INTEGER r, INTEGER s }, ce qu'envoie l'appareil) → r||s brut (ce que lit crypto.subtle).
export function derVersBrut(der, taille) {
  taille = taille || 32;
  const u = der instanceof Uint8Array ? der : new Uint8Array(der);
  let i = 0;
  const lire = () => { if (i >= u.length) throw new Error('signature coupée'); return u[i++]; };
  if (lire() !== 0x30) throw new Error('signature illisible');
  let L = lire();
  if (L & 0x80) { if (L !== 0x81) throw new Error('signature illisible'); L = lire(); }
  if (i + L !== u.length) throw new Error('signature : longueur fausse');
  const entier = () => {
    if (lire() !== 0x02) throw new Error('signature illisible');
    const n = lire();
    if (!n || n > taille + 1 || i + n > u.length) throw new Error('signature : entier hors limites');
    let v = u.subarray(i, i + n); i += n;
    if (v[0] & 0x80) throw new Error('signature : entier négatif');
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v.length > taille) throw new Error('signature : entier trop long');
    const out = new Uint8Array(taille); out.set(v, taille - v.length);
    return out;
  };
  const r = entier(), s = entier();
  if (i !== u.length) throw new Error('signature : octets en trop');
  const brut = new Uint8Array(2 * taille); brut.set(r, 0); brut.set(s, taille);
  return brut;
}

// La signature de l'appareil sur `donnees`, avec sa clé rangée (jwk). Rend true / false (jamais d'erreur).
export async function verifierSignature(alg, jwk, donnees, signature) {
  try {
    if (alg === -7) {
      const k = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, derVersBrut(signature), donnees);
    }
    if (alg === -257) {
      const k = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      return await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, k, signature, donnees);
    }
  } catch (e) { return false; }
  return false;
}

// Le rpId d'une origine permise : son nom d'hôte (« https://770lab.com » → « 770lab.com »). '' si ce n'est pas une origine.
export function rpIdDe(origine) {
  let u;
  try { u = new URL(String(origine || '').trim()); } catch (e) { return ''; }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) return '';
  return u.origin === String(origine).trim().replace(/\/+$/, '') ? u.hostname : '';
}
// Le défi : 32 octets aléatoires en base64url (43 caractères). Rangé « defi:<défi> » 5 minutes, effacé au premier usage.
export const nouveauDefi = () => b64u(aleatoire(32));
export const DEFI_RX = /^[A-Za-z0-9_-]{43}$/;
export const cleDefi = (defi) => 'defi:' + defi;
// Le défi que porte un clientDataJSON (base64url), pour retrouver celui qu'a rangé le relais ; '' si illisible.
export function defiDe(clientDataJSON) {
  const o = deB64u(clientDataJSON);
  if (!o || o.length > 4096) return '';
  try { const cd = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(o)); return cd && typeof cd.challenge === 'string' && DEFI_RX.test(cd.challenge) ? cd.challenge : ''; }
  catch (e) { return ''; }
}

// Les clés de rangement : l'appareil (« appareil:<id> »), la liste d'une personne (« appareils:<nom> »), son identifiant WebAuthn
// stable, tiré au hasard la première fois (« personne:<nom> »). Aucune n'a la forme d'une pièce (GET /piece ne les lit pas).
export const cleAppareil = (id) => 'appareil:' + id;
export const cleAppareils = (qui) => 'appareils:' + qui;
export const clePersonne = (qui) => 'personne:' + qui;
export const ID_APPAREIL_RX = /^[A-Za-z0-9_-]{16,400}$/;
export const nouvelIdPersonne = () => b64u(aleatoire(16));

// Les options de création (navigator.credentials.create, champ publicKey), en JSON (base64url). `exclure` : les appareils déjà
// inscrits de cette personne pour ce rpId ([{ id, transports? }]).
export function optionsInscription(o) {
  return { rp: { id: o.rpId, name: o.nomRp || '770lab' }, user: { id: o.idPersonne, name: o.qui, displayName: o.qui }, challenge: o.defi,
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' }, attestation: 'none',
    excludeCredentials: (o.exclure || []).map((a) => Object.assign({ type: 'public-key', id: a.id }, a.transports && a.transports.length ? { transports: a.transports } : {})),
    timeout: 120000 };
}
// Les options de connexion (navigator.credentials.get) : clés d'accès « découvrables », l'appareil propose lui-même la bonne.
export const optionsConnexion = (o) => ({ challenge: o.defi, rpId: o.rpId, userVerification: 'required', allowCredentials: [], timeout: 120000 });

const TRANSPORTS = ['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card'];
const ko = (erreur) => ({ ok: false, erreur: erreur });
function clientData(b64, attendu) {
  const brut = deB64u(b64);
  if (!brut || brut.length > 4096) throw new Error('clientDataJSON illisible');
  let cd;
  try { cd = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(brut)); } catch (e) { throw new Error('clientDataJSON illisible'); }
  if (!cd || typeof cd !== 'object') throw new Error('clientDataJSON illisible');
  if (cd.type !== attendu.type) throw new Error('ce n’est pas la bonne opération (' + propre(cd.type, 30) + ')');
  if (typeof cd.challenge !== 'string' || !egaux(cd.challenge, attendu.defi)) throw new Error('défi différent');
  if (cd.origin !== attendu.origine) throw new Error('origine différente');
  if (cd.crossOrigin === true) throw new Error('appel depuis un cadre d’une autre page');
  return brut;
}

// L'INSCRIPTION D'UN APPAREIL (le résultat de navigator.credentials.create, en JSON base64url). `defi` = le défi rangé (déjà
// retrouvé et effacé par le relais), `origine` = l'origine exacte de la page, `rpId` = son nom d'hôte. Vérifie : clientDataJSON
// (webauthn.create, défi, origine), attestationObject (CBOR), sha256(rpId), présence ET vérification de la personne (UP + UV),
// identifiant = rawId, clé ES256 ou RS256. L'attestation n'est pas vérifiée (demandée « none » : on ne fait confiance à aucun
// fabricant, seulement à la clé). Rend { ok, id, alg, jwk, signCount, transports } ou { ok: false, erreur }.
export async function verifierInscription(o) {
  try {
    const c = o.credential;
    if (!c || typeof c !== 'object' || c.type !== 'public-key' || !c.response || typeof c.response !== 'object') return ko('appareil illisible');
    const rawId = deB64u(c.rawId), id = deB64u(c.id);
    if (!rawId || !id || !egauxOctets(rawId, id)) return ko('identifiant de l’appareil incohérent');
    if (rawId.length < 16 || rawId.length > LIMITES.appareilIdOctets) return ko('identifiant de l’appareil hors limites');
    clientData(c.response.clientDataJSON, { type: 'webauthn.create', defi: o.defi, origine: o.origine });
    const ao = deB64u(c.response.attestationObject);
    if (!ao || ao.length > LIMITES.authOctets) return ko('attestationObject illisible');
    const att = lireCbor(ao);
    if (att.fin !== ao.length || !(att.valeur instanceof Map)) return ko('attestationObject illisible');
    const authData = att.valeur.get('authData');
    if (!(authData instanceof Uint8Array) || typeof att.valeur.get('fmt') !== 'string') return ko('attestationObject illisible');
    const ad = lireAuthData(authData);
    if (!egauxOctets(ad.rpIdHash, await sha256(new TextEncoder().encode(o.rpId)))) return ko('appareil inscrit pour un autre site');
    if (!ad.up) return ko('présence de la personne non confirmée');
    if (!ad.uv) return ko('empreinte (ou code de l’appareil) non vérifiée');
    if (!ad.idAppareil || !egauxOctets(ad.idAppareil, rawId)) return ko('identifiant de l’appareil incohérent');
    const k = coseVersJwk(ad.cleCose);
    if (c.response.publicKeyAlgorithm !== undefined && c.response.publicKeyAlgorithm !== k.alg) return ko('clé de l’appareil incohérente');
    const transports = (Array.isArray(c.response.transports) ? c.response.transports : []).filter((t) => TRANSPORTS.includes(t)).slice(0, 6);
    return { ok: true, id: b64u(rawId), alg: k.alg, jwk: k.jwk, signCount: ad.compteur, transports: transports };
  } catch (e) { return ko(propre(e && e.message, 120) || 'appareil illisible'); }
}

// LA CONNEXION (le résultat de navigator.credentials.get). `appareil` = l'appareil rangé (retrouvé par son identifiant). Vérifie :
// clientDataJSON (webauthn.get, défi, origine), sha256(rpId), UP + UV, l'appareil appartient à ce rpId, userHandle (s'il est donné)
// = celui de la personne, la signature sur authenticatorData || sha256(clientDataJSON), le compteur (s'il est tenu des deux côtés,
// il doit avancer : sinon l'appareil a peut-être été copié). Rend { ok, signCount } (le compteur à ranger) ou { ok: false, erreur }.
export async function verifierConnexion(o) {
  try {
    const a = o.assertion, ap = o.appareil;
    if (!a || typeof a !== 'object' || !a.response || typeof a.response !== 'object' || (a.type !== undefined && a.type !== 'public-key')) return ko('connexion illisible');
    const rawId = deB64u(a.rawId), id = deB64u(a.id);
    if (!rawId || !id || !egauxOctets(rawId, id) || b64u(rawId) !== ap.id) return ko('appareil incohérent');
    if (ap.rpId !== o.rpId) return ko('appareil inscrit pour un autre site');
    const cd = clientData(a.response.clientDataJSON, { type: 'webauthn.get', defi: o.defi, origine: o.origine });
    const authData = deB64u(a.response.authenticatorData), signature = deB64u(a.response.signature);
    if (!authData || !signature || authData.length > LIMITES.authOctets || signature.length > 1024) return ko('connexion illisible');
    const ad = lireAuthData(authData);
    if (!egauxOctets(ad.rpIdHash, await sha256(new TextEncoder().encode(o.rpId)))) return ko('connexion pour un autre site');
    if (!ad.up) return ko('présence de la personne non confirmée');
    if (!ad.uv) return ko('empreinte (ou code de l’appareil) non vérifiée');
    if (a.response.userHandle && ap.idPersonne) {
      const uh = deB64u(a.response.userHandle);
      if (!uh || b64u(uh) !== ap.idPersonne) return ko('cet appareil n’est pas celui de cette personne');
    }
    const h = await sha256(cd), donnees = new Uint8Array(authData.length + h.length);
    donnees.set(authData, 0); donnees.set(h, authData.length);
    if (!(await verifierSignature(ap.alg, ap.jwk, donnees, signature))) return ko('signature de l’appareil refusée');
    const avant = Number(ap.signCount) || 0;
    if (avant > 0 && ad.compteur > 0 && ad.compteur <= avant) return ko('compteur de l’appareil revenu en arrière : appareil peut-être copié');
    return { ok: true, signCount: Math.max(avant, ad.compteur) };
  } catch (e) { return ko(propre(e && e.message, 120) || 'connexion illisible'); }
}

// Un appareil rangé est-il utilisable ? (Retiré : effacé, ou marqué « retire » quand le stockage ne sait pas effacer.)
export const appareilValide = (ap, id) => !!(ap && typeof ap === 'object' && !ap.retire && ap.id === id && ap.qui && ap.rpId && ap.jwk
  && (ap.alg === -7 || ap.alg === -257));
// LES APPAREILS DE CONFIANCE (champ « sur » de l'appareil rangé). Quiconque a la clé d'équipe (volée, collée au mauvais endroit)
// peut inscrire SON appareil (une vraie clé d'accès sur son téléphone, ou un appareil logiciel : l'attestation « none » ne dit pas
// ce qu'il est, et c'est lui qui pose le drapeau UV) et reçoit aussitôt une session à empreinte fraîche. Cette session ne doit pas
// suffire à créer une nouvelle clé d'équipe (POST /auth/cle/nouvelle : l'ancienne cesserait de marcher, le propriétaire serait
// enfermé dehors, et le Terminal ne le sauverait pas : l'intrus, toujours inscrit, recréerait une clé) ni à mettre en ligne
// (POST /demandes/<réf>/valider). Ces deux gestes exigent un appareil DE CONFIANCE, c'est-à-dire inscrit :
//   - avec la session d'un appareil de confiance ;
//   - ou avec la clé seule quand la personne n'avait encore JAMAIS eu d'appareil (sa liste « appareils:<nom> » n'existe pas encore ;
//     retirer tous ses appareils ne rouvre pas cette porte : la liste reste, vide) ;
//   - ou avant ce changement (rangé sans le champ « sur ») : rien ne change pour les appareils déjà inscrits.
// Sinon (la clé seule, alors que la personne a déjà eu un appareil) : sur = false. Cet appareil se connecte, signale, lit et
// renvoie ses demandes comme avant ; « Nouvelle clé » et « Mettre en ligne » lui répondent 403 { confiance: true }.
export const appareilDeConfiance = (ap) => !!ap && typeof ap === 'object' && ap.sur !== false;
// Le nouvel appareil sera-t-il de confiance ? o : { appareil (celui de la session qui demande les options ; null = la clé seule),
// jamaisInscrit (la personne n'a jamais eu d'appareil) }. Décidé aux options d'inscription, rangé dans le défi, puis dans l'appareil.
export const inscriptionDeConfiance = (o) => (o && o.appareil ? appareilDeConfiance(o.appareil) : !!(o && o.jamaisInscrit === true));
// Ce qu'une page voit d'un appareil (« Mes appareils ») ; « sur » : de confiance (le pupitre marque les autres).
export const appareilPublic = (ap, actuel) => ({ id: ap.id, nom: ap.nom, rpId: ap.rpId, creeLe: ap.creeLe, vuLe: ap.vuLe || null, actuel: !!actuel && ap.id === actuel,
  sur: appareilDeConfiance(ap) });
// Le nom donné à un appareil à son inscription (« iPhone de Marie »), 60 caractères au plus.
export const nomAppareil = (x) => propre(typeof x === 'string' ? x.replace(/\s+/g, ' ') : '', 60) || 'Appareil';
// Le nom rangé à l'inscription : celui envoyé avec la clé d'accès créée (POST /auth/inscription { …, nom }), s'il y en a un, sinon
// celui des options (le défi). La page ne sait qu'APRÈS la création si la clé vit sur un autre appareil (le téléphone par QR code,
// une clé USB : authenticatorAttachment « cross-platform ») : elle corrige alors le nom. Mêmes caractères que nomAppareil.
export const nomInscrit = (x, nomDefi) => (typeof x === 'string' && propre(x.replace(/\s+/g, ' '), 60) ? nomAppareil(x) : nomAppareil(nomDefi));
// La liste des appareils d'une personne avec un de plus, en tête (sans doublon, LIMITES.appareils au plus) ; ou sans lui.
export const appareilsAvec = (ids, id) => [id].concat((Array.isArray(ids) ? ids : []).filter((x) => x !== id && ID_APPAREIL_RX.test(String(x)))).slice(0, LIMITES.appareils);
export const appareilsSans = (ids, id) => (Array.isArray(ids) ? ids : []).filter((x) => x !== id && ID_APPAREIL_RX.test(String(x)));

// LES SESSIONS. Jeton = base64url(JSON) + "." + base64url(HMAC-SHA256(SESSION_SECRET, première partie)). Contenu : { v: 1, qui,
// app (l'identifiant de l'appareil), rp, iat, exp (iat + 30 jours), uv (l'heure de l'empreinte) } — heures en millisecondes. Valable si
// la signature est juste (comparée en temps constant) et pas expirée ; le relais vérifie EN PLUS, à chaque usage, que l'appareil
// existe toujours (retiré = ses sessions ne valent plus rien) et que la personne a toujours une clé dans CLES (retirer quelqu'un de
// CLES retire aussi ses appareils). « Fraîche » : l'empreinte date de 5 minutes au plus (mettre en ligne).
export const secretSessionValide = (s) => typeof s === 'string' && s.trim().length >= 32;
async function hmac(secret, texte) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(secret).trim()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(texte)));
}
export const nouvelleSession = (o) => ({ v: 1, qui: o.qui, app: o.app, rp: o.rp, iat: o.quand, exp: o.quand + LIMITES.sessionDureeMs, uv: o.uv || o.quand });
export async function signerSession(p, secret) {
  if (!secretSessionValide(secret)) throw new Error('SESSION_SECRET absent ou trop court');
  const corps = b64u(new TextEncoder().encode(JSON.stringify(p)));
  return corps + '.' + await hmac(secret, corps);
}
export async function lireSession(jeton, secret, maintenant) {
  jeton = typeof jeton === 'string' ? jeton.trim() : '';
  if (!secretSessionValide(secret) || !jeton || jeton.length > 4096) return ko('session absente');
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(jeton);
  if (!m) return ko('session illisible');
  if (!egaux(m[2], await hmac(secret, m[1]))) return ko('session refusée');
  let p;
  try { p = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(deB64u(m[1]))); } catch (e) { return ko('session illisible'); }
  if (!p || typeof p !== 'object' || p.v !== 1 || typeof p.qui !== 'string' || !p.qui || typeof p.app !== 'string' || typeof p.rp !== 'string'
    || ![p.iat, p.exp, p.uv].every(Number.isFinite)) return ko('session illisible');
  if (p.exp <= maintenant) return ko('session expirée');
  if (p.iat > maintenant + 5 * 60 * 1000) return ko('session venue du futur');
  return { ok: true, p: p };
}
export const sessionFraiche = (p, maintenant) => !!p && Number.isFinite(p.uv) && maintenant - p.uv <= LIMITES.fraicheMs && p.uv <= maintenant + 60 * 1000;

// Les noms des personnes qui ont une clé dans CLES (la même lecture que verifierCle) : une session ne vaut que pour l'une d'elles.
export function nomsDesCles(liste) {
  const noms = [];
  String(liste || '').split(',').map((x) => x.trim()).filter(Boolean).forEach((ligne) => {
    const i = ligne.indexOf(':');
    const nom = propre(i > 0 ? ligne.slice(0, i).trim() : 'équipe', 60), k = i > 0 ? ligne.slice(i + 1).trim() : ligne;
    if (k.length >= 16 && !noms.includes(nom)) noms.push(nom);
  });
  return noms;
}

// ——— LES CLÉS D'ÉQUIPE CRÉÉES DEPUIS LE PUPITRE (POST /auth/cle/nouvelle) ———
// Le propriétaire touche « Nouvelle clé » et pose le doigt d'un appareil DE CONFIANCE (voir appareilDeConfiance : un appareil
// inscrit avec la clé seule ne le peut pas) : le relais tire une clé neuve et ne range que son EMPREINTE (sha256)
// sous « cle:<nom> » : { h, creeLe, envRevoque, app }. `envRevoque` = l'empreinte de la clé que CLES lui donnait à cet instant
// (de chacune, s'il en a plusieurs ; null s'il n'en a pas). Une 2e création remplace la 1re.
// LA CLÉ LA PLUS RÉCENTE EST LA SEULE VALABLE, qu'elle vienne du pupitre ou du Terminal (le Terminal est le secours quand une clé a
// fui : il doit gagner s'il est plus récent). Pour un nom de CLES, avec r = « cle:<nom> » et k = sa clé (ses clés) dans CLES :
//   - pas de r : seule k vaut (comme avant le pupitre) ;
//   - r et r.envRevoque = l'empreinte de k (CLES n'a pas bougé depuis la création au pupitre) : seule la clé rangée vaut, k est
//     refusée ;
//   - r et r.envRevoque ≠ l'empreinte de k (CLES changé au Terminal APRÈS la création au pupitre) : seule k vaut, la clé rangée est
//     périmée (une nouvelle création au pupitre la rend de nouveau la seule valable).
// Seule une personne présente dans CLES peut avoir une clé rangée : retirer quelqu'un de CLES retire tout.
// Workers KV met jusqu'à 60 s à propager une écriture d'un lieu à l'autre : la nouvelle clé (et le refus de l'ancienne) vaut
// partout dans la minute, rien à faire de plus.
export const cleCle = (qui) => 'cle:' + qui;
export const CLE_RX = /^[A-Za-z0-9_-]{24}$/;
const EMPREINTE_RX = /^[0-9a-f]{64}$/;
// 18 octets aléatoires → 24 caractères base64url (144 bits).
export const nouvelleCle = () => b64u(aleatoire(18));
// Les clés que CLES donne à ce nom (la même lecture que verifierCle : 16 caractères au moins).
function clesDuNom(liste, nom) {
  const cles = [];
  String(liste || '').split(',').map((x) => x.trim()).filter(Boolean).forEach((ligne) => {
    const i = ligne.indexOf(':');
    const n = propre(i > 0 ? ligne.slice(0, i).trim() : 'équipe', 60), k = i > 0 ? ligne.slice(i + 1).trim() : ligne;
    if (k.length >= 16 && n === nom) cles.push(k);
  });
  return cles;
}
// L'enregistrement rangé sous « cle:<qui> » (JAMAIS la clé elle-même). o : { cle, qui, liste (CLES), quand, app }.
export async function nouvelleCleRangee(o) {
  const hs = await Promise.all(clesDuNom(o.liste, o.qui).map(sha256Hex));
  return { h: await sha256Hex(o.cle), creeLe: o.quand, envRevoque: hs.length === 0 ? null : hs.length === 1 ? hs[0] : hs, app: o.app || null };
}
// L'enregistrement lu pour ce nom : { h, revoques: [empreintes] } ou null (absent, pierre tombale, illisible).
function cleRangeeLue(ranges, nom) {
  const x = ranges && typeof ranges === 'object' && Object.prototype.hasOwnProperty.call(ranges, nom) ? ranges[nom] : null;
  if (!x || typeof x !== 'object' || x.retire || typeof x.h !== 'string' || !EMPREINTE_RX.test(x.h)) return null;
  return { h: x.h, revoques: [].concat(x.envRevoque == null ? [] : x.envRevoque).filter((e) => typeof e === 'string' && EMPREINTE_RX.test(e)) };
}
// Les mêmes empreintes, dans n'importe quel ordre (CLES n'a pas bougé pour ce nom depuis la création au pupitre).
function memesEmpreintes(a, b) {
  const x = [...new Set(a)].sort(), y = [...new Set(b)].sort();
  return x.length === y.length && x.every((e, i) => egaux(e, y[i]));
}
// La clé présentée (X-Signaler-Cle) est-elle acceptée, et pour qui ? `ranges` = { <nom>: ce qui est lu sous « cle:<nom> » } pour
// les noms de nomsDesCles(liste). Pour chaque nom, la seule clé valable est la plus récente (voir plus haut) ; tous les noms sont
// passés en revue, comparaisons en temps constant ; le premier nom qui accepte la clé l'emporte (comme verifierCle). Rend { ok, nom,
// par: 'rangee'|'cles' }, ou { ok: false } avec, pour une clé connue mais plus valable, remplacee: true (la clé de CLES, remplacée
// depuis le pupitre) ou perimee: true (la clé du pupitre, CLES ayant changé depuis).
export async function deciderCle(cle, liste, ranges) {
  cle = String(cle || '').trim();
  if (cle.length < 16) return { ok: false };
  const h = await sha256Hex(cle);
  let trouve = null, refus = null;
  for (const nom of nomsDesCles(liste)) {
    const hk = await Promise.all(clesDuNom(liste, nom).map(sha256Hex));
    const r = cleRangeeLue(ranges, nom);
    const estK = hk.some((x) => egaux(h, x)), estR = !!r && egaux(h, r.h);
    const rangeeValable = !!r && memesEmpreintes(r.revoques, hk);
    if (rangeeValable ? estR : estK) { if (!trouve) trouve = { nom: nom, par: rangeeValable ? 'rangee' : 'cles' }; }
    else if (!refus && (estK || estR)) refus = estK ? { ok: false, remplacee: true } : { ok: false, perimee: true };
  }
  if (trouve) return { ok: true, nom: trouve.nom, par: trouve.par };
  return refus || { ok: false };
}
