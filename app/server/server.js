'use strict';
// Plan Vivant — serveur HTTP : fichiers statiques, connexion, API de suivi, mises à jour en direct (SSE).
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { q, tx, checkPassword, DUMMY } = require('./db');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const SECURE_COOKIE = process.env.COOKIE_SECURE !== '0'; // à désactiver seulement en test local sans HTTPS
const SESSION_DAYS = 30;
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

/* ---------- référentiel du plan ---------- */
const PLAN = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'plan.json'), 'utf8'));
const LOT_IDS = new Set(PLAN.levels.flatMap(l => l.lots.map(x => x.lot)));
const OCC = { nr: 'Non renseigné', loue: 'Loué', preavis: 'Préavis reçu', vacant: 'Vacant' };

/* ---------- fichiers statiques ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' };
const nm = p => path.join(ROOT, 'node_modules', p);
const EXTRA = {
  '/vendor/xlsx.full.min.js': nm('xlsx/dist/xlsx.full.min.js'),
  '/fonts/archivo-500.woff2': nm('@fontsource/archivo/files/archivo-latin-500-normal.woff2'),
  '/fonts/archivo-700.woff2': nm('@fontsource/archivo/files/archivo-latin-700-normal.woff2'),
  '/fonts/archivo-800.woff2': nm('@fontsource/archivo/files/archivo-latin-800-normal.woff2'),
  '/fonts/public-sans-400.woff2': nm('@fontsource/public-sans/files/public-sans-latin-400-normal.woff2'),
  '/fonts/public-sans-600.woff2': nm('@fontsource/public-sans/files/public-sans-latin-600-normal.woff2'),
  '/fonts/plex-mono-400.woff2': nm('@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2'),
  '/fonts/plex-mono-500.woff2': nm('@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2'),
};
function serveStatic(req, res, pathname) {
  let file = EXTRA[pathname];
  if (!file) {
    const rel = pathname === '/' ? '/index.html' : pathname;
    file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, 'Introuvable');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Introuvable');
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.woff2' || pathname.startsWith('/vendor/') ? 'public, max-age=604800' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------- utilitaires HTTP ---------- */
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};
function send(res, code, body, headers = {}) {
  const isObj = typeof body === 'object';
  res.writeHead(code, { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return reject(Object.assign(new Error('JSON attendu'), { status: 415 }));
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 64 * 1024) { reject(Object.assign(new Error('Requête trop volumineuse'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('JSON invalide'), { status: 400 })); } });
    req.on('error', reject);
  });
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
function currentUser(req) {
  const t = cookies(req).pv_session;
  if (!t) return null;
  const u = q.getSession.get(sha(t));
  if (!u || u.expires < Date.now()) return null;
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}
// Protection CSRF : les requêtes qui modifient doivent venir de la même origine.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // navigateurs anciens / outils ; le cookie SameSite=Lax couvre le reste
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

/* ---------- limitation des tentatives de connexion ---------- */
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now(), a = (attempts.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
  attempts.set(ip, a);
  return a.length >= 10;
}

/* ---------- direct : Server-Sent Events ---------- */
const streams = new Set();
function broadcast() { for (const res of streams) res.write('event: change\ndata: {}\n\n'); }
setInterval(() => { for (const res of streams) res.write(': ping\n\n'); }, 25000).unref();
setInterval(() => q.purgeSessions.run(Date.now()), 3600 * 1000).unref();

/* ---------- état visible par un utilisateur ---------- */
function stateFor(user) {
  const names = Object.fromEntries(q.names.all().map(r => [r.id, r.name]));
  const lots = {};
  for (const r of q.lots.all()) lots[r.id] = { occ: r.occ, travaux: !!r.travaux, fin: r.fin, dpe: r.dpe, dpeDate: r.dpe_date, maj: r.maj, majPar: names[r.maj_by] || '' };
  const gestion = user.role === 'gestion';
  const comments = (gestion ? q.commentsAll : q.commentsShared).all().map(c => ({ id: c.id, lot: c.lot, txt: c.txt, vis: c.vis, at: c.at, auteur: names[c.user_id] || 'Compte supprimé' }));
  const journal = gestion ? q.journal.all().map(j => ({ id: j.id, lot: j.lot, txt: j.txt, at: j.at, auteur: names[j.user_id] || 'Compte supprimé' })) : [];
  return { me: user, lots, comments, journal };
}

/* ---------- validation ---------- */
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
function validLot(body) {
  const occ = body.occ in OCC ? body.occ : null;
  const dpe = ['', 'A', 'B', 'C', 'D', 'E', 'F', 'G'].includes(body.dpe) ? body.dpe : null;
  const dpeDate = body.dpeDate === '' || /^\d{4}-\d{2}-\d{2}$/.test(body.dpeDate || '') ? body.dpeDate : null;
  if (occ === null || dpe === null || dpeDate === null || typeof body.travaux !== 'boolean') return null;
  return { occ, travaux: body.travaux, fin: body.travaux ? clean(body.fin, 80) : '', dpe, dpeDate };
}
function describeChange(before, after) {
  const b = before || { occ: 'nr', travaux: 0, fin: '', dpe: '', dpe_date: '' }, out = [];
  if (b.occ !== after.occ) out.push(`Occupation : ${OCC[b.occ]} → ${OCC[after.occ]}`);
  if (!!b.travaux !== after.travaux) out.push(`Travaux : ${after.travaux ? 'en cours' : 'terminés'}`);
  if (after.travaux && b.fin !== after.fin) out.push(`Fin des travaux : ${after.fin || '—'}`);
  if (b.dpe !== after.dpe) out.push(`DPE : ${b.dpe || '—'} → ${after.dpe || '—'}`);
  if (b.dpe_date !== after.dpeDate) out.push(`Date DPE : ${after.dpeDate ? after.dpeDate.split('-').reverse().join('/') : '—'}`);
  return out;
}

/* ---------- routes ---------- */
async function api(req, res, pathname) {
  const method = req.method;
  if (method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'Origine refusée' });

  if (pathname === '/api/login' && method === 'POST') {
    // Derrière Caddy, l'adresse du visiteur est la dernière entrée de X-Forwarded-For.
    const xff = process.env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() : '';
    const ip = xff || req.socket.remoteAddress;
    if (tooMany(ip)) return send(res, 429, { error: 'Trop de tentatives. Réessayez dans 15 minutes.' });
    const body = await readJson(req);
    const u = q.userByEmail.get(clean(body.email, 200));
    const ok = checkPassword(String(body.password || ''), u ? u.pw : DUMMY) && !!u;
    if (!ok) { attempts.get(ip).push(Date.now()); return send(res, 401, { error: 'E-mail ou mot de passe incorrect.' }); }
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = Date.now() + SESSION_DAYS * 86400 * 1000;
    q.insSession.run(sha(token), u.id, expires);
    const cookie = `pv_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${SECURE_COOKIE ? '; Secure' : ''}`;
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }
  if (pathname === '/api/logout' && method === 'POST') {
    const t = cookies(req).pv_session; if (t) q.delSession.run(sha(t));
    return send(res, 200, { ok: true }, { 'Set-Cookie': `pv_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${SECURE_COOKIE ? '; Secure' : ''}` });
  }

  const user = currentUser(req);
  if (!user) return send(res, 401, { error: 'Connexion requise.' });

  if (pathname === '/api/state' && method === 'GET') return send(res, 200, stateFor(user), { 'Cache-Control': 'no-store' });

  if (pathname === '/api/events' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 5000\n\n');
    streams.add(res);
    req.on('close', () => streams.delete(res));
    return;
  }

  if (user.role !== 'gestion') return send(res, 403, { error: 'Votre accès est en lecture seule.' });

  let m;
  if ((m = pathname.match(/^\/api\/lots\/([0-9A-Za-z]+)$/)) && method === 'PUT') {
    const id = m[1];
    if (!LOT_IDS.has(id)) return send(res, 404, { error: 'Lot inconnu.' });
    const v = validLot(await readJson(req));
    if (!v) return send(res, 400, { error: 'Valeurs invalides.' });
    const now = new Date().toISOString();
    tx(() => {
      const before = q.getLot.get(id);
      const changes = describeChange(before, v);
      if (!changes.length) return;
      q.upsertLot.run(id, v.occ, v.travaux ? 1 : 0, v.fin, v.dpe, v.dpeDate, now, user.id);
      for (const c of changes) q.insJournal.run(id, c, now, user.id);
    });
    broadcast();
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/comments' && method === 'POST') {
    const b = await readJson(req);
    const lot = String(b.lot || ''), txt = clean(b.txt, 2000), vis = b.vis === 'int' ? 'int' : b.vis === 'sh' ? 'sh' : null;
    if (!LOT_IDS.has(lot) || !txt || !vis) return send(res, 400, { error: 'Commentaire invalide.' });
    const now = new Date().toISOString();
    tx(() => {
      q.insComment.run(lot, txt, vis, now, user.id);
      q.insJournal.run(lot, `Commentaire ${vis === 'int' ? 'interne' : 'partagé'} ajouté`, now, user.id);
    });
    broadcast();
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'Introuvable.' });
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return send(res, 400, 'Requête invalide'); }
  try {
    if (pathname === '/healthz') return send(res, 200, 'ok');
    if (pathname.startsWith('/api/')) return await api(req, res, pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Méthode non autorisée');
    if (pathname === '/plan.json' && !currentUser(req)) return send(res, 401, { error: 'Connexion requise.' });
    return serveStatic(req, res, pathname);
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Erreur interne.' });
    if (!e.status) console.error(e);
  }
});
server.listen(PORT, HOST, () => console.log(`Plan Vivant à l’écoute sur http://${HOST}:${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
