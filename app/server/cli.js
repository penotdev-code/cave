'use strict';
// Gestion des comptes en ligne de commande.
//   node server/cli.js ajouter <email> <gestion|lecture> "<Nom affiché>"
//   node server/cli.js liste
//   node server/cli.js mot-de-passe <email>
//   node server/cli.js role <email> <gestion|lecture>
//   node server/cli.js supprimer <email>
const crypto = require('node:crypto');
const { q, hashPassword } = require('./db');

const [cmd, email, a, b] = process.argv.slice(2);
const ROLES = ['gestion', 'lecture'];
const newPassword = () => crypto.randomBytes(12).toString('base64url');
const die = msg => { console.error(msg); process.exit(1); };
const find = () => q.userByEmail.get(email || '') || die(`Aucun compte pour ${email}.`);

switch (cmd) {
  case 'ajouter': {
    if (!email || !ROLES.includes(a)) die('Usage : ajouter <email> <gestion|lecture> "<Nom affiché>"');
    if (q.userByEmail.get(email)) die(`Le compte ${email} existe déjà.`);
    const pw = newPassword();
    q.insertUser.run(email, b || email.split('@')[0], a, hashPassword(pw), new Date().toISOString());
    console.log(`Compte créé : ${email} (${a})\nMot de passe : ${pw}\nTransmettez-le par un canal sûr.`);
    break;
  }
  case 'liste':
    for (const u of q.listUsers.all()) console.log(`${u.email.padEnd(36)} ${u.role.padEnd(8)} ${u.name}`);
    break;
  case 'mot-de-passe': {
    const u = find(), pw = newPassword();
    q.setPw.run(hashPassword(pw), u.id); q.delUserSessions.run(u.id);
    console.log(`Nouveau mot de passe pour ${u.email} : ${pw}`);
    break;
  }
  case 'role': {
    const u = find(); if (!ROLES.includes(a)) die('Rôle : gestion ou lecture');
    q.setRole.run(a, u.id); q.delUserSessions.run(u.id);
    console.log(`${u.email} est maintenant « ${a} ».`);
    break;
  }
  case 'supprimer': {
    const u = find(); q.delUser.run(u.id);
    console.log(`Compte ${u.email} supprimé.`);
    break;
  }
  default:
    die('Commandes : ajouter, liste, mot-de-passe, role, supprimer');
}
