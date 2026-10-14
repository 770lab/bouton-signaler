// Le cœur du relais « 🐞 Signaler » : des fonctions pures, sans dépendance, communes à tous les hébergements
// (Cloudflare Worker, Node, fonction serverless…). Le relais est la SEULE pièce qui connaît le jeton de la routine Claude :
// il ne quitte jamais le serveur.
//
//   page (signaler.js) ──POST /signaler──▶ relais ──POST …/routines/trig_…/fire──▶ routine Claude Code
//                                           │                                      (une session : corrige, teste, ouvre une PR)
//                                           └─ range captures et note vocale, les sert sous une adresse impossible à deviner

export const LIMITES = {
  texte: 4000,              // le texte écrit ou dicté
  captures: 6,              // images par signalement
  captureOctets: 2_000_000, // une image (JPEG/PNG/WebP) une fois décodée
  audioOctets: 4_000_000,   // la note vocale (≈ 3 min)
  erreurs: 10,              // dernières erreurs de la page
  corpsOctets: 20_000_000,  // le corps JSON entier (le base64 grossit d'un tiers)
  texteRoutine: 60_000,     // l'API des routines accepte 65 536 caractères
};

const ROUTINE_RX = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/trig_[A-Za-z0-9]+\/fire$/;
const IMAGE_RX = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;
const AUDIO_RX = /^data:(audio\/(?:webm|ogg|mp4|mpeg|wav|x-m4a|aac))(?:;[^,]*)?;base64,([A-Za-z0-9+/=]+)$/;

const propre = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);

// Comparaison en temps constant : la durée ne dit pas combien de caractères d'une clé étaient justes.
function egaux(a, b) {
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
// où le relais sert les fichiers ; vide si le relais n'a pas de stockage (le texte le dit).
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
  let t = L.join('\n');
  if (t.length > LIMITES.texteRoutine) t = t.slice(0, LIMITES.texteRoutine - 20) + '\n… (tronqué)';
  return t;
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
