// Le bouton dans un VRAI navigateur (Chromium, via Playwright), contre le VRAI relais (relay/cloudflare/worker.mjs servi par Node),
// avec un faux stockage R2 et une fausse routine : aucune donnée ne sort, aucun appel à Claude.
//   node tests/bouton.navigateur.mjs        (Playwright doit être installé : npm i -D playwright, ou global)
// html2canvas : servi depuis tests/.cache/ s'il y est (le navigateur du test ne va pas sur Internet), sinon depuis cdnjs.
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { signaler } from '../relay/cloudflare/worker.mjs';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch (e) { console.log('⊘ Playwright absent : test du navigateur non joué'); process.exit(0); }

let ko = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) ko++; };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };

// Le site de démonstration (la racine du dépôt, en statique).
const site = http.createServer((req, res) => {
  const p = join(RACINE, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(RACINE) || !existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' }); res.end(readFileSync(p));
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const ORIGINE = 'http://127.0.0.1:' + site.address().port;

// Le relais : le vrai code du Worker, derrière un petit serveur Node.
const CLE = 'k7Qe9mWz4Lp2Xr8T';
const objets = new Map(), appels = [];
const env = { ORIGINES: ORIGINE, DEPOT: 'exemple/app', ROUTINE_URL: 'https://api.anthropic.com/v1/claude_code/routines/trig_01TEST/fire', ROUTINE_JETON: 'sk-ant-oat01-FAUX',
  CLES: 'marie:' + CLE, PIECES: { put: async (k, v, o) => objets.set(k, { v, o }), get: async () => null } };
const fausseRoutine = async (url, init) => { appels.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ claude_code_session_id: 'session_01X', claude_code_session_url: 'https://claude.ai/code/session_01X' }) }; };
const relais = http.createServer(async (req, res) => {
  const morceaux = []; for await (const m of req) morceaux.push(m);
  const corps = Buffer.concat(morceaux);
  const r = new Request('http://127.0.0.1' + req.url, { method: req.method, headers: req.headers, body: req.method === 'POST' ? corps : undefined });
  let rep;
  if (req.method === 'OPTIONS') rep = new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': ORIGINE, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Signaler-Cle' } });
  else rep = await signaler(r, env, { fetch: fausseRoutine, attendre: async () => {} });
  res.writeHead(rep.status, Object.fromEntries(rep.headers)); res.end(Buffer.from(await rep.arrayBuffer()));
});
await new Promise((r) => relais.listen(0, '127.0.0.1', r));
const RELAIS = 'http://127.0.0.1:' + relais.address().port;

const navigateur = await chromium.launch();
const H2C = join(RACINE, 'tests', '.cache', 'html2canvas-1.4.1.min.js');
async function page(taille) {
  const ctx = await navigateur.newContext({ viewport: taille, permissions: [] });
  const p = await ctx.newPage();
  if (existsSync(H2C)) await p.route('https://cdnjs.cloudflare.com/**', (route) => route.fulfill({ contentType: 'text/javascript', body: readFileSync(H2C, 'utf8') }));
  const erreursPage = []; p.on('pageerror', (e) => erreursPage.push(String(e)));
  await p.goto(ORIGINE + '/demo/index.html?relais=' + encodeURIComponent(RELAIS));
  return { p, ctx, erreursPage };
}

try {
  console.log('1. Un signalement complet, sur téléphone (390 × 844)');
  const { p, ctx, erreursPage } = await page({ width: 390, height: 844 });
  await p.click('#panne');                                   // une erreur dans la console de la page
  const fab = await p.waitForSelector('.sgn-fab');
  const bf = await fab.boundingBox();
  ok(bf && bf.x + bf.width <= 390 && bf.y + bf.height <= 844 && bf.width >= 44, 'la coccinelle est à l’écran, assez grande pour un doigt (≥ 44 px)');
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
  await p.click('[data-a="capturer"]');
  await p.waitForFunction(() => document.querySelectorAll('.sgn-v img').length === 2, null, { timeout: 15000 });
  ok(true, '« Capturer l’écran » ajoute une seconde capture');
  await p.fill('.sgn-texte', 'Le bouton Enregistrer ne fait rien sur le devis D-0042');
  await p.fill('.sgn-cle', CLE);
  await p.screenshot({ path: join(RACINE, 'tests', '.cache', 'fenetre-telephone.png') });
  await p.click('.sgn-envoyer');
  await p.waitForSelector('.sgn-etat.ok', { timeout: 15000 });
  ok(/Transmis à Claude/.test(await p.textContent('.sgn-etat')), 'la page dit « Transmis à Claude » avec la référence');
  ok(appels.length === 1, 'la routine est prévenue une fois');
  const t = (appels[0] && appels[0].text) || '';
  ok(t.includes('Le bouton Enregistrer ne fait rien sur le devis D-0042') && t.includes('Signalé par : marie') && t.includes('compte dans l’application : marie@exemple.fr'), 'le texte, la personne (d’après sa clé) et son compte');
  ok(t.includes('TypeError: devis.client is undefined') && t.includes('Version : demo-1.0') && t.includes('Écran : 390×844'), 'les erreurs de la page, la version, la taille de l’écran');
  const imgs = [...objets.values()].filter((o) => o.o.customMetadata.genre === 'image');
  ok(imgs.length === 2 && imgs.every((o) => o.o.httpMetadata.contentType === 'image/jpeg' && o.v.length > 1000), 'les deux captures sont rangées (JPEG)');
  ok((t.match(/\/piece\/[0-9a-f]{32}/g) || []).length === 2, 'leurs adresses sont dans le texte de la routine');
  ok(erreursPage.length === 0, 'aucune erreur JavaScript du bouton lui-même');
  await ctx.storageState().then(() => {});

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
  await o.p.screenshot({ path: join(RACINE, 'tests', '.cache', 'fenetre-ordinateur.png') });
  await o.ctx.close();
} catch (e) { ko++; console.log('  ✗ exception : ' + (e && e.stack || e)); }
finally { await navigateur.close(); site.close(); relais.close(); }

console.log(ko ? '\n✗ ' + ko + ' échec(s)' : '\n✓ tout passe');
process.exit(ko ? 1 : 0);
