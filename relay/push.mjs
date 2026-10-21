// Notifications Web Push (RFC 8030 + VAPID RFC 8292 + chiffrement aes128gcm RFC 8291), avec WebCrypto seul : aucune dépendance.
// Sert au relais Cloudflare : quand la routine renvoie l'état d'une demande, la personne reçoit une notification sur ses appareils.

const enc = new TextEncoder();
export const b64u = (octets) => {
  let s = '';
  new Uint8Array(octets).forEach((o) => { s += String.fromCharCode(o); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const deB64u = (t) => {
  const s = atob(String(t).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (String(t).length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
const concat = (...l) => { const o = new Uint8Array(l.reduce((n, x) => n + x.length, 0)); let p = 0; l.forEach((x) => { o.set(x, p); p += x.length; }); return o; };

// Une paire de clés VAPID : { publique (65 octets, base64url), privee (JWK en JSON) }. Voir relay/vapid-cles.mjs.
export async function nouvellesClesVapid() {
  const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey));
  return { publique: b64u(pub), privee: JSON.stringify(await crypto.subtle.exportKey('jwk', k.privateKey)) };
}

// Un abonnement du navigateur, vérifié : adresse https d'un service Web Push connu (pas n'importe quelle adresse : le relais
// n'est pas un proxy), clés p256dh (65 octets) et auth (16 octets).
const SERVICES_RX = /^https:\/\/(?:[a-z0-9-]+\.)*(?:googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)\//;
export function abonnementValide(a) {
  if (!a || typeof a !== 'object' || typeof a.endpoint !== 'string' || a.endpoint.length > 600 || !SERVICES_RX.test(a.endpoint)) return null;
  const k = a.keys || {};
  try {
    if (deB64u(k.p256dh).length !== 65 || deB64u(k.auth).length !== 16) return null;
  } catch (e) { return null; }
  return { endpoint: a.endpoint, keys: { p256dh: k.p256dh, auth: k.auth } };
}

// L'en-tête Authorization « vapid » : un JWT ES256 qui nomme le service de push (aud), valable 12 h.
export async function enteteVapid(endpoint, sujet, publique, priveeJwk, maintenant) {
  const aud = new URL(endpoint).origin;
  const corps = b64u(enc.encode(JSON.stringify({ aud: aud, exp: Math.floor(maintenant / 1000) + 12 * 3600, sub: sujet })));
  const tete = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const cle = await crypto.subtle.importKey('jwk', JSON.parse(priveeJwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, cle, enc.encode(tete + '.' + corps));
  return 'vapid t=' + tete + '.' + corps + '.' + b64u(sig) + ', k=' + publique;
}

async function hkdf(sel, secret, info, longueur) {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: sel, info: info }, base, longueur * 8));
}

// Le corps chiffré (aes128gcm, un seul enregistrement) pour l'abonnement. `eph` et `sel` ne sont fournis que par les tests.
export async function chiffrer(abonnement, texte, eph, sel) {
  const ua = deB64u(abonnement.keys.p256dh), auth = deB64u(abonnement.keys.auth);
  const paire = eph || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', paire.publicKey));
  const uaCle = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const partage = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaCle }, paire.privateKey, 256));
  const ikm = await hkdf(auth, partage, concat(enc.encode('WebPush: info\0'), ua, asPub), 32);
  const s = sel || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(s, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(s, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const clair = concat(enc.encode(texte), new Uint8Array([2]));
  const cle = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const chiffre = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cle, clair));
  const tete = new Uint8Array(21 + asPub.length);
  tete.set(s, 0); new DataView(tete.buffer).setUint32(16, 4096); tete[20] = asPub.length; tete.set(asPub, 21);
  return concat(tete, chiffre);
}

// Envoie une notification (objet JSON : { titre, texte, url, tag }). Rend { ok, gone } (gone : l'abonnement n'existe plus, à retirer).
export async function envoyer(abonnement, message, o) {
  const corps = await chiffrer(abonnement, JSON.stringify(message));
  const r = await o.fetch(abonnement.endpoint, { method: 'POST', body: corps, headers: {
    'Authorization': await enteteVapid(abonnement.endpoint, o.sujet, o.publique, o.privee, o.maintenant || Date.now()),
    'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', 'TTL': String(o.ttl || 86400), 'Urgency': 'high' } });
  return { ok: r.status >= 200 && r.status < 300, gone: r.status === 404 || r.status === 410, statut: r.status };
}

// Le texte de la notification pour une demande qui vient de changer d'état.
const TITRES = {
  en_ligne: 'Réglé, en ligne', a_valider: 'À valider', a_relire: 'À relire', question: 'Claude te pose une question',
  rien: 'Rien à changer', echec: 'Pas réussi', annulee: 'Annulée, retirée de la ligne',
};
export function messagePour(d, base) {
  const resume = String(d.resume || '').replace(/\s+/g, ' ').trim();
  return { titre: TITRES[d.etat] || 'Ta demande a avancé', texte: resume.slice(0, 160) || 'Ouvre l’Atelier pour voir.',
    tag: 'demande-' + d.id, url: (base || '') + '#' + d.id };
}
export const ETATS_NOTIFIES = Object.keys(TITRES);
