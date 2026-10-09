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

/* ---------- référentiel du plan ----------
   La version publiée dans l'onglet « Plans » ; à défaut, le plan livré avec l'application. */
const FALLBACK_PLAN = path.join(PUBLIC, 'plan.json');
const CONVERTER_URL = process.env.CONVERTER_URL || 'http://convertisseur:8000';
let PLAN, PLAN_JSON, PLAN_ID, LOT_IDS;
const lotIdsOf = plan => new Set(plan.levels.flatMap(l => [...l.lots.map(x => x.lot), ...(l.pending || []).map(x => x.lot)]));
function loadPlan() {
  const row = q.planActive.get();
  PLAN_JSON = row ? row.data : fs.readFileSync(FALLBACK_PLAN, 'utf8');
  PLAN = JSON.parse(PLAN_JSON);
  PLAN_ID = row ? row.id : 0;
  LOT_IDS = lotIdsOf(PLAN);
}
loadPlan();
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
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Fichier ou requête trop volumineux'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, limit = 64 * 1024) {
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) throw Object.assign(new Error('JSON attendu'), { status: 415 });
  const buf = await readBody(req, limit);
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch { throw Object.assign(new Error('JSON invalide'), { status: 400 }); }
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
function broadcast(event = 'change') { for (const res of streams) res.write(`event: ${event}\ndata: {}\n\n`); }
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

  if (pathname.startsWith('/api/plans')) return plansApi(req, res, pathname, user);

  return send(res, 404, { error: 'Introuvable.' });
}

/* ---------- onglet « Plans » : versions, import DWG, retouches, publication ---------- */
const PLAN_MAX = 25 * 1024 * 1024;
const num = v => typeof v === 'number' && Number.isFinite(v);
const pt = p => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1]);
const ringOk = r => Array.isArray(r) && r.length >= 3 && r.length <= 20000 && r.every(pt);
const partsOk = ps => Array.isArray(ps) && ps.length <= 200 && ps.every(poly => Array.isArray(poly) && poly.length >= 1 && poly.length <= 200 && poly.every(ringOk));
const strOk = (s, max) => typeof s === 'string' && s.length <= max;
const dOk = d => strOk(d, 5e6) && /^[MLZ0-9 .\-]*$/.test(d);
// Contrôle strict de la structure : un plan abîmé ne doit jamais pouvoir être publié.
function checkPlan(p) {
  const errs = [];
  if (!p || typeof p !== 'object' || !Array.isArray(p.levels) || !p.levels.length || p.levels.length > 40) return ['Aucun niveau.'];
  const ids = new Set();
  p.levels.forEach((L, i) => {
    const where = `Niveau ${i + 1}`;
    if (!/^[a-z0-9-]{1,40}$/.test(L.id || '') || ids.has(L.id)) errs.push(`${where} : identifiant invalide ou en double.`);
    ids.add(L.id);
    if (!strOk(L.name, 60) || !L.name.trim()) errs.push(`${where} : nom manquant.`);
    if (!Array.isArray(L.vb) || L.vb.length !== 4 || !L.vb.every(num)) errs.push(`${where} : cadre invalide.`);
    if (L.bg && (typeof L.bg !== 'object' || !Object.values(L.bg).every(dOk))) errs.push(`${where} : fond de plan invalide.`);
    if (!Array.isArray(L.lots)) { errs.push(`${where} : liste des lots manquante.`); return; }
    const seen = new Set();
    for (const lot of L.lots) {
      if (!/^[0-9A-Za-z]{1,12}$/.test(lot.lot || '')) { errs.push(`${L.name} : numéro de lot invalide « ${String(lot.lot).slice(0, 20)} ».`); continue; }
      if (seen.has(lot.lot)) errs.push(`${L.name} : le lot ${lot.lot} apparaît deux fois.`);
      seen.add(lot.lot);
      if (lot.parts !== undefined ? !partsOk(lot.parts) : !Array.isArray(lot.poly)) errs.push(`${L.name} : forme du lot ${lot.lot} invalide.`);
      if (!pt(lot.tag)) errs.push(`${L.name} : position du numéro du lot ${lot.lot} invalide.`);
    }
    for (const k of ['halls', 'orphans', 'pending', 'texts']) if (L[k] !== undefined && !Array.isArray(L[k])) errs.push(`${where} : ${k} invalide.`);
    for (const h of L.halls || []) if (h.parts !== undefined ? !partsOk(h.parts) : !Array.isArray(h.poly)) errs.push(`${L.name} : partie commune invalide.`);
    for (const o of L.orphans || []) if (!partsOk(o.parts)) errs.push(`${L.name} : zone à vérifier invalide.`);
    for (const x of L.pending || []) if (!/^[0-9A-Za-z]{1,12}$/.test(x.lot || '') || !pt(x.tag)) errs.push(`${L.name} : numéro à placer invalide.`);
    for (const t of L.texts || []) if (!Array.isArray(t) || !num(t[0]) || !num(t[1]) || !strOk(t[2], 120)) { errs.push(`${L.name} : texte invalide.`); break; }
  });
  if (p.ref && typeof p.ref !== 'object') errs.push('Référentiel des lots invalide.');
  return errs.slice(0, 30);
}
const planMeta = (r, names) => ({ id: r.id, label: r.label, source: r.source, status: r.status, rev: r.rev, created: r.created,
  createdBy: names[r.created_by] || '', updated: r.updated, updatedBy: names[r.updated_by] || '', published: r.published, size: r.size,
  active: r.id === PLAN_ID });

async function plansApi(req, res, pathname, user) {
  const method = req.method, now = new Date().toISOString();
  const names = () => Object.fromEntries(q.names.all().map(r => [r.id, r.name]));
  let m;

  if (pathname === '/api/plans' && method === 'GET') {
    const lf = q.fileMeta.get('listing'), n = names();
    return send(res, 200, { plans: q.plansList.all().map(r => planMeta(r, n)), activeId: PLAN_ID,
      listing: lf ? { filename: lf.filename, uploaded: lf.uploaded, size: lf.size, by: n[lf.uploaded_by] || '' } : null }, { 'Cache-Control': 'no-store' });
  }

  // Listing Excel de référence (utilisé à l'import d'un DWG : types, surfaces, identifiants)
  if (pathname === '/api/plans/listing' && method === 'POST') {
    const buf = await readBody(req, 10 * 1024 * 1024);
    if (buf.subarray(0, 2).toString('latin1') !== 'PK') return send(res, 400, { error: 'Ce fichier n’est pas un classeur Excel (.xlsx).' });
    const filename = clean(decodeURIComponent(req.headers['x-nom-fichier'] || 'listing.xlsx'), 200);
    q.filePut.run('listing', filename, buf, now, user.id);
    return send(res, 200, { ok: true });
  }

  // Import d'un DWG (ou DXF) : conversion par le service interne → nouveau brouillon
  if (pathname === '/api/plans/import' && method === 'POST') {
    const buf = await readBody(req, 40 * 1024 * 1024);
    const filename = clean(decodeURIComponent(req.headers['x-nom-fichier'] || 'plan.dwg'), 200);
    const head = buf.subarray(0, 6).toString('latin1');
    if (!/^AC10\d\d$/.test(head) && !/\.dxf$/i.test(filename)) return send(res, 400, { error: 'Ce fichier n’est pas un plan AutoCAD (.dwg ou .dxf).' });
    const lf = q.fileGet.get('listing');
    let r;
    try {
      r = await fetch(CONVERTER_URL + '/convertir', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dwg: buf.toString('base64'), nom: filename, listing: lf ? Buffer.from(lf.data).toString('base64') : null }),
        signal: AbortSignal.timeout(180000) });
    } catch { return send(res, 503, { error: 'Le service de conversion ne répond pas. Réessayez dans une minute.' }); }
    const out = await r.json().catch(() => ({}));
    if (!r.ok) return send(res, 422, { error: out.error || 'Conversion impossible.' });
    out.plan.immeuble = out.plan.immeuble || PLAN.immeuble || '';
    const errs = checkPlan(out.plan);
    if (errs.length) return send(res, 422, { error: 'Le plan converti est incomplet : ' + errs.join(' ') });
    const label = `Import ${filename} du ${now.slice(0, 10).split('-').reverse().join('/')}`;
    const id = q.planInsert.run(label, filename, JSON.stringify(out.plan), JSON.stringify(out.rapport), now, user.id, now, user.id).lastInsertRowid;
    return send(res, 200, { id: Number(id), rapport: out.rapport });
  }

  if ((m = pathname.match(/^\/api\/plans\/(\d+)$/))) {
    const row = q.planGet.get(Number(m[1]));
    if (!row) return send(res, 404, { error: 'Version introuvable.' });
    if (method === 'GET') {
      return send(res, 200, { ...planMeta({ ...row, size: row.data.length }, names()), data: JSON.parse(row.data), rapport: row.rapport ? JSON.parse(row.rapport) : null,
        lotsWithData: q.lotsWithData.all().map(r => r.id) }, { 'Cache-Control': 'no-store' });
    }
    if (method === 'PUT') {
      if (row.status !== 'brouillon') return send(res, 409, { error: 'Seul un brouillon peut être modifié.' });
      const b = await readJson(req, PLAN_MAX);
      const errs = checkPlan(b.data);
      if (errs.length) return send(res, 400, { error: errs.join(' ') });
      const label = clean(b.label, 120) || row.label;
      const r = q.planSave.run(label, JSON.stringify(b.data), now, user.id, row.id, Number(b.rev));
      if (!r.changes) return send(res, 409, { error: 'Ce brouillon a été modifié ailleurs entre-temps. Rechargez-le.' });
      return send(res, 200, { ok: true, rev: row.rev + 1 });
    }
    if (method === 'DELETE') {
      if (row.status === 'publie') return send(res, 409, { error: 'La version publiée ne peut pas être supprimée.' });
      q.planDelete.run(row.id);
      return send(res, 200, { ok: true });
    }
  }

  // Nouveau brouillon à partir d'une version (publiée, archivée ou brouillon)
  if ((m = pathname.match(/^\/api\/plans\/(\d+)\/copier$/)) && method === 'POST') {
    const row = q.planGet.get(Number(m[1]));
    if (!row) return send(res, 404, { error: 'Version introuvable.' });
    const id = q.planInsert.run(`Copie de « ${row.label} »`.slice(0, 120), row.source, row.data, row.rapport, now, user.id, now, user.id).lastInsertRowid;
    return send(res, 200, { id: Number(id) });
  }

  // Publication : le brouillon devient le plan de tout le monde
  if ((m = pathname.match(/^\/api\/plans\/(\d+)\/publier$/)) && method === 'POST') {
    const row = q.planGet.get(Number(m[1]));
    if (!row) return send(res, 404, { error: 'Version introuvable.' });
    if (row.status === 'publie') return send(res, 409, { error: 'Cette version est déjà publiée.' });
    const b = await readJson(req);
    const data = JSON.parse(row.data);
    const errs = checkPlan(data);
    if (errs.length) return send(res, 400, { error: errs.join(' ') });
    // Lots qui ont des informations (occupation, DPE, commentaires) et disparaîtraient du plan
    const ids = lotIdsOf(data), lost = q.lotsWithData.all().map(r => r.id).filter(id => !ids.has(id));
    if (lost.length && !b.confirmer) return send(res, 409, { error: 'confirmation', lotsPerdus: lost });
    tx(() => { q.planArchiveAll.run(); q.planPublish.run(now, row.id); });
    loadPlan();
    broadcast('plan');
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
    if (pathname === '/plan.json') {
      if (!currentUser(req)) return send(res, 401, { error: 'Connexion requise.' });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Plan-Version': String(PLAN_ID) });
      return res.end(PLAN_JSON);
    }
    return serveStatic(req, res, pathname);
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Erreur interne.' });
    if (!e.status) console.error(e);
  }
});
server.listen(PORT, HOST, () => console.log(`Plan Vivant à l’écoute sur http://${HOST}:${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
