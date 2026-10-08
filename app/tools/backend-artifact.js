/* Backend de la démo publiée sur claude.ai : base partagée de la page (capability db).
   Collections : lots/{n°}, partages/*, interne/* (équipe), journal/* (équipe). */
(() => {
  const $ = s => document.querySelector(s);
  const PLAN = window.PV_PLAN;
  const OCC = { nr: 'À renseigner', loue: 'Loué', preavis: 'Préavis', vacant: 'Vacant' };
  const local = () => {
    // Hors de claude.ai (fichier ouvert en local) : démo en mémoire, rien n'est enregistré.
    const st = { lots: {}, comments: [], journal: [] };
    let fn = () => {};
    const banner = $('#hint'); setTimeout(() => { banner.textContent = 'Démo locale : les modifications disparaissent au rechargement de la page.'; }, 0);
    return {
      plan: PLAN, me: { name: 'Vous' }, canWrite: true, canInternal: true,
      subscribe(f) { fn = f; f(st); },
      async saveLot(id, b) { st.lots[id] = { ...b, maj: new Date().toISOString() }; st.journal.unshift({ lot: id, txt: 'Lot modifié', at: new Date().toISOString(), auteur: 'Vous' }); },
      async addComment(lot, txt, vis) { st.comments.push({ lot, txt, vis, at: new Date().toISOString(), auteur: 'Vous' }); },
      saveFile(name, buf) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([buf])); a.download = name; a.click(); },
    };
  };
  async function boot() {
    $('#app').hidden = false;
    if (!window.claude || !window.claude.use) { PV.start(local()); return; }
    const [db, user, dl] = await Promise.all([claude.use('db'), claude.use('user'), claude.use('downloads')]);
    if (!db) { PV.start(local()); return; }
    const me = user ? await user.id() : null;
    const w = user ? await user.can('data.write') : null;
    let canWrite = w !== false;
    const names = {};
    let myName = 'Vous';
    if (user) { try { const v = await user.me(); if (v && v.name) myName = v.name; } catch {} }
    const raw = { lots: {}, sh: [], int: [], journal: [] };
    let listener = () => {}, pend = false;
    const label = x => (x.by && names[x.by]) || x.auteur || 'Quelqu’un';
    const emit = () => {
      if (pend) return; pend = true;
      requestAnimationFrame(() => {
        pend = false;
        listener({
          lots: raw.lots,
          comments: raw.sh.map(c => ({ ...c, vis: 'sh', auteur: label(c) })).concat(raw.int.map(c => ({ ...c, vis: 'int', auteur: label(c) }))),
          journal: raw.journal.map(j => ({ ...j, auteur: label(j) })),
          canWrite, canInternal: canWrite,
        });
        resolveNames();
      });
    };
    async function resolveNames() {
      if (!user) return;
      const ids = [...new Set([...raw.sh, ...raw.int, ...raw.journal].map(x => x.by).filter(id => id && !(id in names)))];
      if (!ids.length) return;
      const ps = await user.profiles(ids);
      ids.forEach(id => { names[id] = (ps[id] && ps[id].name) || ''; });
      emit();
    }
    const writeErr = e => {
      if (e && e.code === 'invalid_argument') { canWrite = false; emit(); throw Object.assign(new Error(''), { readOnly: true }); }
      if (e && e.code === 'quota_exceeded') throw new Error('La base de la démo est pleine : modification non enregistrée.');
      throw new Error('La modification n’a pas pu être enregistrée. Vérifiez la connexion puis réessayez.');
    };
    const ops = {};
    PV.start({
      plan: PLAN, me: { name: myName }, canWrite, canInternal: canWrite,
      subscribe(fn) {
        listener = fn;
        db.collection('lots').onSnapshot(s => { const t = {}; s.docs.forEach(d => t[d.id] = d.data()); raw.lots = t; emit(); });
        db.collection('partages').orderBy('at').limit(1000).onSnapshot(s => { raw.sh = s.docs.map(d => d.data()); emit(); });
        db.collection('interne').orderBy('at').limit(1000).onSnapshot(s => { raw.int = s.docs.map(d => d.data()); emit(); });
        db.collection('journal').orderBy('at', 'desc').limit(300).onSnapshot(s => { raw.journal = s.docs.map(d => d.data()); emit(); });
      },
      async saveLot(id, b) {
        const before = { occ: 'nr', travaux: false, fin: '', dpe: '', dpeDate: '', ...(raw.lots[id] || {}) };
        const now = new Date().toISOString();
        const changes = [];
        if (before.occ !== b.occ) changes.push(`Occupation : ${OCC[before.occ]} → ${OCC[b.occ]}`);
        if (!!before.travaux !== b.travaux) changes.push(`Travaux : ${b.travaux ? 'en cours' : 'terminés'}`);
        if (b.travaux && before.fin !== b.fin) changes.push(`Fin des travaux : ${b.fin || '—'}`);
        if (before.dpe !== b.dpe) changes.push(`DPE : ${before.dpe || '—'} → ${b.dpe || '—'}`);
        if (before.dpeDate !== b.dpeDate) changes.push(`Date DPE : ${b.dpeDate ? b.dpeDate.split('-').reverse().join('/') : '—'}`);
        const prev = ops[id] || Promise.resolve();
        const run = prev.then(async () => {
          try {
            await db.doc('lots/' + id).set({ ...b, maj: now, majBy: me });
            for (const c of changes) await db.collection('journal').add({ lot: id, txt: c, at: now, by: me });
          } catch (e) { writeErr(e); }
        });
        ops[id] = run.catch(() => {});
        return run;
      },
      async addComment(lot, txt, vis) {
        const at = new Date().toISOString();
        try {
          await db.collection(vis === 'int' ? 'interne' : 'partages').add({ lot, txt, at, by: me });
          await db.collection('journal').add({ lot, txt: `Commentaire ${vis === 'int' ? 'équipe' : 'partagé'} ajouté`, at, by: me });
        } catch (e) { writeErr(e); }
      },
      async saveFile(name, buf) {
        if (!dl) throw new Error('L’enregistrement de fichier n’est pas disponible dans cette vue.');
        try { await dl.save({ filename: name, data: new Uint8Array(buf) }); }
        catch (e) { if (e && e.code === 'declined') return; throw new Error(e && e.code === 'rate_limited' ? 'Une demande d’enregistrement est déjà ouverte.' : 'L’enregistrement du fichier n’a pas abouti.'); }
      },
    });
  }
  boot();
})();
