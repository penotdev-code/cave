'use strict';
// Base SQLite (module natif de Node 22) : comptes, sessions, suivi des lots, commentaires, journal.
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'plan-vivant.sqlite'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('gestion', 'lecture')),
    pw TEXT NOT NULL,
    created TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lots (
    id TEXT PRIMARY KEY,
    occ TEXT NOT NULL DEFAULT 'nr',
    travaux INTEGER NOT NULL DEFAULT 0,
    fin TEXT NOT NULL DEFAULT '',
    dpe TEXT NOT NULL DEFAULT '',
    dpe_date TEXT NOT NULL DEFAULT '',
    maj TEXT,
    maj_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY,
    lot TEXT NOT NULL,
    txt TEXT NOT NULL,
    vis TEXT NOT NULL CHECK (vis IN ('int', 'sh')),
    at TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS journal (
    id INTEGER PRIMARY KEY,
    lot TEXT NOT NULL,
    txt TEXT NOT NULL,
    at TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS comments_lot ON comments(lot);
  CREATE INDEX IF NOT EXISTS journal_at ON journal(at);
`);

/* ---------- mots de passe ---------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function checkPassword(pw, stored) {
  const [kind, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, got);
}
// Empreinte factice : on calcule toujours un scrypt, même pour un e-mail inconnu.
const DUMMY = hashPassword(crypto.randomBytes(12).toString('hex'));

/* ---------- comptes ---------- */
const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT id, email, name, role FROM users WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO users (email, name, role, pw, created) VALUES (?, ?, ?, ?, ?)'),
  setPw: db.prepare('UPDATE users SET pw = ? WHERE id = ?'),
  setRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
  delUser: db.prepare('DELETE FROM users WHERE id = ?'),
  listUsers: db.prepare('SELECT id, email, name, role, created FROM users ORDER BY email'),
  names: db.prepare('SELECT id, name FROM users'),

  insSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)'),
  getSession: db.prepare('SELECT u.id, u.email, u.name, u.role, s.expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'),
  delSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  delUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires < ?'),

  lots: db.prepare('SELECT id, occ, travaux, fin, dpe, dpe_date, maj, maj_by FROM lots'),
  getLot: db.prepare('SELECT * FROM lots WHERE id = ?'),
  upsertLot: db.prepare(`INSERT INTO lots (id, occ, travaux, fin, dpe, dpe_date, maj, maj_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET occ = excluded.occ, travaux = excluded.travaux, fin = excluded.fin, dpe = excluded.dpe,
    dpe_date = excluded.dpe_date, maj = excluded.maj, maj_by = excluded.maj_by`),
  commentsAll: db.prepare('SELECT id, lot, txt, vis, at, user_id FROM comments ORDER BY at, id'),
  commentsShared: db.prepare("SELECT id, lot, txt, vis, at, user_id FROM comments WHERE vis = 'sh' ORDER BY at, id"),
  insComment: db.prepare('INSERT INTO comments (lot, txt, vis, at, user_id) VALUES (?, ?, ?, ?, ?)'),
  journal: db.prepare('SELECT id, lot, txt, at, user_id FROM journal ORDER BY at DESC, id DESC LIMIT 500'),
  insJournal: db.prepare('INSERT INTO journal (lot, txt, at, user_id) VALUES (?, ?, ?, ?)'),
};

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, q, tx, hashPassword, checkPassword, DUMMY, DATA_DIR };
