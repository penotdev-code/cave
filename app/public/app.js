function main(PLAN, initial) {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const NS = 'http://www.w3.org/2000/svg';
  const el = (n, a = {}, p) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); if (p) p.appendChild(e); return e; };
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const m2 = n => n == null ? '' : n.toFixed(1).replace('.', ',');
  const pad = n => String(n).padStart(2, '0');
  const fmtDate = iso => iso ? iso.slice(0, 10).split('-').reverse().join('/') : '';
  const fmtStamp = iso => { if (!iso) return ''; const d = new Date(iso); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  let toastT;
  const toast = msg => { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3200); };

  const REF = PLAN.ref;
  const LEVELS = PLAN.levels;
  $('#building').textContent = PLAN.immeuble || '';

  const LOTS = [];
  LEVELS.forEach(L => L.lots.forEach(g => {
    const ref = REF[g.lot] || { type: '', locaux: [] };
    const surf = ref.locaux.reduce((t, l) => t + (l[2] || 0), 0);
    LOTS.push({ id: g.lot, level: L, geo: g, type: ref.type, locaux: ref.locaux, surf: ref.locaux.length && surf ? surf : null,
      niveaux: ref.locaux.length ? [...new Set(ref.locaux.map(l => l[1]))].join(', ') : L.name });
  }));
  const byId = Object.fromEntries(LOTS.map(l => [l.id, l]));

  /* ================= Vocabulaire ================= */
  const OCC = { nr: 'Non renseigné', loue: 'Loué', preavis: 'Préavis reçu', vacant: 'Vacant' };
  const OCCV = { nr: 'var(--st-nr)', loue: 'var(--st-loue)', preavis: 'var(--st-preavis)', vacant: 'var(--st-vacant)' };
  const DPEV = { A: 'var(--dpe-a)', B: 'var(--dpe-b)', C: 'var(--dpe-c)', D: 'var(--dpe-d)', E: 'var(--dpe-e)', F: 'var(--dpe-f)', G: 'var(--dpe-g)' };
  const isLogement = l => /^T\d/.test(l.type);
  function alerts(l, s) {
    const a = [];
    if (!isLogement(l)) return a;
    if (!s.dpe) a.push(['bad', 'DPE non renseigné : obligatoire pour louer.']);
    if (s.dpe === 'G') a.push(['bad', 'Classe G : logement non décent depuis le 1ᵉʳ janvier 2025, location impossible en l’état.']);
    if (s.dpe === 'F') a.push(['warn', 'Classe F : interdit à la location au 1ᵉʳ janvier 2028.']);
    if (s.dpe && s.dpeDate && s.dpeDate < '2021-07-01') a.push(['bad', 'DPE réalisé avant juillet 2021 : plus valable, à refaire.']);
    return a;
  }

  /* ================= État ================= */
  const EMPTY = { occ: 'nr', travaux: false, fin: '', dpe: '', dpeDate: '' };
  const S = {
    track: {}, comments: [], journal: [],
    level: LEVELS[0], layer: 'occupation', sym: { travaux: true, comments: true, alertes: true },
    focus: 'all', sel: byId['1201'], sort: ['id', 1],
    mode: 'connecting', canWrite: true, canInternal: true, me: null, names: {},
  };
  const T = id => ({ ...EMPTY, ...(S.track[id] || {}) });
  const cmtsOf = id => S.comments.filter(c => c.lot === id);
  const who = c => c.auteur || 'Quelqu’un';

  /* ================= Plan ================= */
  const svg = $('#plan');
  function drawLevel() {
    const L = S.level;
    svg.innerHTML = '';
    svg.setAttribute('viewBox', L.vb.join(' '));
    svg.setAttribute('aria-label', 'Plan · ' + L.name);
    const defs = el('defs', {}, svg);
    const p1 = el('pattern', { id: 'hatch', width: 12, height: 12, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
    el('rect', { width: 4, height: 12, fill: 'var(--signal)', opacity: .8 }, p1);
    L.texts.forEach(([x, y, t]) => { const e = el('text', { x, y, 'text-anchor': 'middle', 'font-family': 'var(--f-mono)', 'font-size': 13, 'letter-spacing': 3, fill: 'var(--muted)' }, svg); e.textContent = t; });
    L.halls.forEach(h => {
      el('polygon', { points: h.poly.join(' '), fill: 'var(--hall)', stroke: 'var(--wall)', 'stroke-width': 1.5 }, svg);
      const xs = h.poly.map(p => p[0]), ys = h.poly.map(p => p[1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const t = el('text', { x: cx, y: cy + 4, 'text-anchor': 'middle', 'font-size': 12, 'font-family': 'var(--f-body)', fill: 'var(--muted)' }, svg); t.textContent = h.label;
    });
    L.lots.forEach(g => {
      const l = byId[g.lot];
      const G = el('g', { class: 'lot', tabindex: 0, role: 'button', 'aria-label': 'Lot ' + g.lot, 'data-lot': g.lot }, svg);
      const pts = g.poly.join(' ');
      l.base = el('polygon', { class: 'base', points: pts }, G);
      l.hatch = el('polygon', { points: pts, fill: 'url(#hatch)', 'pointer-events': 'none' }, G);
      g.walls.forEach(w => el('line', { x1: w[0], y1: w[1], x2: w[2], y2: w[3], stroke: 'var(--wall)', 'stroke-width': 1.3, 'pointer-events': 'none' }, G));
      g.rooms.forEach(([x, y, n]) => { const t = el('text', { x, y, 'text-anchor': 'middle', 'font-size': 12, 'font-style': 'italic', 'font-family': 'var(--f-body)', fill: 'var(--muted)', 'pointer-events': 'none' }, G); t.textContent = n; });
      el('polygon', { class: 'sel', points: pts }, G);
      const [tx, ty] = g.tag;
      const r = g.lot.length > 3 ? 27 : 23;
      el('circle', { cx: tx, cy: ty, r, fill: 'var(--sheet)', stroke: 'var(--wall)', 'stroke-width': 1.3, 'pointer-events': 'none' }, G);
      const lt = el('text', { x: tx, y: ty + 6, 'text-anchor': 'middle', 'font-family': 'var(--f-body)', 'font-size': 17, 'font-weight': 600, fill: 'var(--ink)', 'pointer-events': 'none' }, G); lt.textContent = g.lot;
      if (g.extra) { const e = el('text', { x: tx, y: ty + r + 18, 'text-anchor': 'middle', 'font-family': 'var(--f-mono)', 'font-size': 11, fill: 'var(--muted)', 'pointer-events': 'none' }, G); e.textContent = g.extra; }
      l.bub = el('g', { transform: `translate(${tx + r + 20} ${ty - r + 2})`, 'pointer-events': 'none' }, G);
      el('path', { d: 'M-13 -11 h26 a4 4 0 0 1 4 4 v12 a4 4 0 0 1 -4 4 h-15 l-6 6 v-6 h-5 a4 4 0 0 1 -4 -4 v-12 a4 4 0 0 1 4 -4z', fill: 'var(--accent)' }, l.bub);
      l.bubT = el('text', { y: 4.5, 'text-anchor': 'middle', 'font-family': 'var(--f-mono)', 'font-size': 12, 'font-weight': 500, fill: 'var(--accent-ink)' }, l.bub);
      l.alr = el('g', { transform: `translate(${tx - r - 18} ${ty - r + 4})`, 'pointer-events': 'none' }, G);
      el('path', { d: 'M0 -13 L13 10 L-13 10 Z', fill: 'var(--bad)', stroke: 'var(--sheet)', 'stroke-width': 1.5 }, l.alr);
      const at = el('text', { y: 7, 'text-anchor': 'middle', 'font-family': 'var(--f-display)', 'font-size': 13, 'font-weight': 800, fill: '#fff' }, l.alr); at.textContent = '!';
      G.addEventListener('click', () => select(l));
      G.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(l); } });
    });
    $$('#levels button').forEach(b => b.setAttribute('aria-pressed', b.dataset.level === L.id));
  }
  const matchesFocus = (l, s) => {
    switch (S.focus) {
      case 'loue': case 'vacant': case 'preavis': case 'nr': return s.occ === S.focus;
      case 'travaux': return s.travaux;
      case 'alertes': return alerts(l, s).length > 0;
      case 'cmts': return cmtsOf(l.id).length > 0;
      default: return true;
    }
  };
  function paintPlan() {
    S.level.lots.forEach(g => {
      const l = byId[g.lot], s = T(l.id);
      let f = 'var(--st-nr)';
      if (S.layer === 'occupation') f = OCCV[s.occ] || f;
      if (S.layer === 'dpe') f = DPEV[s.dpe] || 'var(--dpe-none)';
      l.base.setAttribute('fill', f);
      l.hatch.style.display = S.sym.travaux && s.travaux ? '' : 'none';
      const n = cmtsOf(l.id).length;
      l.bub.style.display = S.sym.comments && n ? '' : 'none'; l.bubT.textContent = n;
      l.alr.style.display = S.sym.alertes && alerts(l, s).length ? '' : 'none';
      const G = l.base.parentNode;
      G.classList.toggle('is-sel', S.sel === l);
      G.classList.toggle('dim', !matchesFocus(l, s));
    });
    const Lg = $('#legend');
    let h = '';
    if (S.layer === 'occupation') h = Object.entries(OCC).map(([k, v]) => `<span><span class="sw" style="background:${OCCV[k]}"></span> ${v}</span>`).join('');
    else if (S.layer === 'dpe') h = Object.entries(DPEV).map(([k, v]) => `<span><span class="sw" style="background:${v}"></span> ${k}</span>`).join('') + '<span><span class="sw" style="background:var(--dpe-none)"></span> Non renseigné</span>';
    else h = '<span>Plan seul</span>';
    const schema = S.level.lots.some(g => g.schema);
    Lg.innerHTML = h + (schema ? `<span class="note">${S.level.id === 'rdc' ? '800, 801, 102 : schéma provisoire' : 'Schéma provisoire en attendant le DWG'}</span>` : '');
  }

  /* ================= Résumé ================= */
  function renderSummary() {
    const c = { all: LOTS.length, loue: 0, preavis: 0, vacant: 0, nr: 0, travaux: 0, alertes: 0, cmts: 0 };
    LOTS.forEach(l => { const s = T(l.id); c[s.occ]++; if (s.travaux) c.travaux++; if (alerts(l, s).length) c.alertes++; if (cmtsOf(l.id).length) c.cmts++; });
    const items = [['all', 'Tous les lots', ''], ['loue', 'Loués', OCCV.loue], ['vacant', 'Vacants', OCCV.vacant], ['preavis', 'Préavis reçus', OCCV.preavis],
      ['travaux', 'En travaux', 'url(#)'], ['alertes', 'Alertes DPE', ''], ['cmts', 'Avec commentaires', ''], ['nr', 'Non renseignés', OCCV.nr]];
    $('#summary').innerHTML = items.map(([k, lab, col]) => `<button type="button" class="stat" data-focus="${k}" aria-pressed="${S.focus === k}">
      <span class="n">${c[k]}</span><span class="l">${k === 'travaux' ? '<span class="sw" style="background:repeating-linear-gradient(45deg,var(--signal) 0 3px,transparent 3px 7px)"></span>' : col ? `<span class="sw" style="background:${col}"></span>` : ''}${lab}</span></button>`).join('');
    $$('#summary .stat').forEach(b => b.addEventListener('click', () => { S.focus = S.focus === b.dataset.focus ? 'all' : b.dataset.focus; renderAll(); }));
  }

  /* ================= Fiche ================= */
  const fiche = $('#fiche');
  let draft = '';
  function renderFiche() {
    const l = S.sel;
    if (!l) { fiche.innerHTML = '<p class="empty">Cliquez sur un lot du plan ou une ligne du tableau pour ouvrir sa fiche.</p>'; return; }
    const s = T(l.id), ro = !S.canWrite, dis = ro ? 'disabled' : '';
    const cm = cmtsOf(l.id), al = alerts(l, s);
    const tr = S.track[l.id];
    fiche.innerHTML = `
      <div class="fhead"><h2>Lot ${l.id}</h2><span class="mono muted" style="font-size:.82rem">${esc(l.type || 'type ?')}${l.surf ? ' · ' + m2(l.surf) + ' m²' : ''}</span></div>
      ${l.locaux.length ? `<dl class="kv">${l.locaux.map(x => `<dt>${x[1]}</dt><dd class="mono">${x[0]}${x[2] != null ? ' · ' + m2(x[2]) + ' m²' : ''}</dd>`).join('')}</dl>`
        : `<p class="muted" style="font-size:.84rem;margin:0">${l.level.name}. Identifiants et surfaces viendront de l’import de 30_LOCAUX.</p>`}
      ${al.map(([k, t]) => `<div class="alert ${k}">${t}</div>`).join('')}
      <label class="field"><span>Occupation</span>
        <select id="f-occ" ${dis}>${Object.entries(OCC).map(([k, v]) => `<option value="${k}" ${k === s.occ ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <div class="field"><span>Travaux</span>
        <div class="row"><label class="chk"><input type="checkbox" id="f-trv" ${s.travaux ? 'checked' : ''} ${dis}> En cours</label>
        <input type="text" id="f-fin" placeholder="fin prévue" value="${esc(s.fin)}" ${ro || !s.travaux ? 'disabled' : ''} style="flex:1;min-width:120px" aria-label="Fin prévue des travaux"></div></div>
      <div class="field"><span>DPE</span>
        <div class="row"><select id="f-dpe" ${dis} aria-label="Classe DPE"><option value="">Non renseigné</option>${'ABCDEFG'.split('').map(k => `<option ${k === s.dpe ? 'selected' : ''}>${k}</option>`).join('')}</select>
        <input type="date" id="f-dpd" value="${esc(s.dpeDate)}" ${dis} aria-label="Date du diagnostic"></div></div>
      ${tr && tr.maj ? `<p class="mono muted" style="font-size:.72rem;margin:0">Mis à jour le ${fmtStamp(tr.maj)}${tr.majPar ? ' par ' + esc(tr.majPar) : ''}</p>` : ''}
      <div class="field"><span>Commentaires (${cm.length})</span>
        <div class="cmts">${cm.length ? cm.map(c => `<div class="cmt"><div class="meta"><span>${esc(who(c))} · ${fmtStamp(c.at)}</span><span class="pill ${c.vis}">${c.vis === 'int' ? 'Interne' : 'Partagé'}</span></div>${esc(c.txt)}</div>`).join('') : '<span class="empty" style="font-size:.84rem">Aucun commentaire.</span>'}</div>
        ${ro ? '<div class="ro">Accès en lecture : vous voyez l’état des lots et les commentaires partagés.</div>' : `
        <textarea id="f-txt" placeholder="Ajouter un commentaire sur le lot ${l.id}…" aria-label="Nouveau commentaire">${esc(draft)}</textarea>
        <div class="row" style="justify-content:space-between">
          <select id="f-vis" aria-label="Visibilité">${S.canInternal ? '<option value="int">Interne (équipe)</option>' : ''}<option value="sh">Partagé avec les organismes</option></select>
          <button type="button" class="btn" id="f-add">Ajouter</button></div>`}
      </div>`;
    if (ro) return;
    const cur = () => ({ ...T(l.id) });
    $('#f-occ').addEventListener('change', e => saveLot(l, { ...cur(), occ: e.target.value }, `Occupation : ${OCC[s.occ]} → ${OCC[e.target.value]}`));
    $('#f-trv').addEventListener('change', e => saveLot(l, { ...cur(), travaux: e.target.checked, fin: e.target.checked ? cur().fin : '' }, `Travaux : ${e.target.checked ? 'en cours' : 'terminés'}`));
    $('#f-fin').addEventListener('change', e => saveLot(l, { ...cur(), fin: e.target.value.trim() }, `Fin des travaux : ${e.target.value.trim() || '—'}`));
    $('#f-dpe').addEventListener('change', e => saveLot(l, { ...cur(), dpe: e.target.value }, `DPE : ${s.dpe || '—'} → ${e.target.value || '—'}`));
    $('#f-dpd').addEventListener('change', e => saveLot(l, { ...cur(), dpeDate: e.target.value }, `Date DPE : ${fmtDate(e.target.value) || '—'}`));
    $('#f-txt').addEventListener('input', e => draft = e.target.value);
    $('#f-add').addEventListener('click', () => addComment(l, $('#f-txt').value.trim(), $('#f-vis').value));
  }

  /* ================= Tableau & journal ================= */
  const COLS = [['id', 'Lot'], ['niveaux', 'Niveaux'], ['type', 'Type'], ['surf', 'm²'], ['occ', 'Occupation'], ['travaux', 'Travaux'], ['dpe', 'DPE'], ['dpeDate', 'Date DPE'], ['al', 'Alertes'], ['cm', 'Comm.'], ['maj', 'Mis à jour']];
  function rowVal(l, k) {
    const s = T(l.id);
    switch (k) {
      case 'id': return +l.id; case 'surf': return l.surf ?? -1; case 'occ': return OCC[s.occ]; case 'travaux': return s.travaux ? 1 : 0;
      case 'dpe': return s.dpe || 'Z'; case 'dpeDate': return s.dpeDate || ''; case 'al': return alerts(l, s).length; case 'cm': return cmtsOf(l.id).length;
      case 'maj': return (S.track[l.id] || {}).maj || ''; default: return l[k] || '';
    }
  }
  function renderTable() {
    $('#thead').innerHTML = COLS.map(([k, n]) => `<th aria-sort="${S.sort[0] === k ? (S.sort[1] > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" data-sort="${k}">${n}${S.sort[0] === k ? (S.sort[1] > 0 ? ' ↑' : ' ↓') : ''}</button></th>`).join('');
    $$('#thead [data-sort]').forEach(b => b.addEventListener('click', () => { const k = b.dataset.sort; S.sort = [k, S.sort[0] === k ? -S.sort[1] : 1]; renderTable(); }));
    const rows = LOTS.filter(l => matchesFocus(l, T(l.id))).sort((a, b) => { const x = rowVal(a, S.sort[0]), y = rowVal(b, S.sort[0]); return (x > y ? 1 : x < y ? -1 : 0) * S.sort[1]; });
    $('#count').textContent = `${rows.length} lot${rows.length > 1 ? 's' : ''}${S.focus !== 'all' ? ' (filtre actif)' : ''}`;
    $('#tbody').innerHTML = rows.map(l => {
      const s = T(l.id), a = alerts(l, s).length, n = cmtsOf(l.id).length, tr = S.track[l.id];
      return `<tr data-lot="${l.id}" class="${S.sel === l ? 'is-sel' : ''}">
        <td class="mono"><b>${l.id}</b></td><td>${esc(l.niveaux)}</td><td>${esc(l.type) || '<span class="muted">—</span>'}</td><td class="mono num">${m2(l.surf) || '<span class="muted">—</span>'}</td>
        <td><span class="dot" style="background:${OCCV[s.occ]}"></span>${OCC[s.occ]}</td>
        <td>${s.travaux ? 'Oui' + (s.fin ? ' · ' + esc(s.fin) : '') : '<span class="muted">—</span>'}</td>
        <td>${s.dpe ? `<span class="dpe ${s.dpe === 'G' ? 'g' : ''}" style="background:${DPEV[s.dpe]}">${s.dpe}</span>` : '<span class="muted">—</span>'}</td>
        <td class="mono">${fmtDate(s.dpeDate) || '<span class="muted">—</span>'}</td>
        <td>${a ? `<span class="al">▲ ${a}</span>` : '<span class="muted">—</span>'}</td>
        <td class="mono">${n || '<span class="muted">—</span>'}</td><td class="mono">${tr && tr.maj ? fmtStamp(tr.maj).slice(0, 10) : '<span class="muted">—</span>'}</td></tr>`;
    }).join('') || `<tr><td colspan="${COLS.length}" class="muted">Aucun lot ne correspond au filtre.</td></tr>`;
    $$('#tbody tr[data-lot]').forEach(tr => tr.addEventListener('click', () => select(byId[tr.dataset.lot], true)));
  }
  function renderJournal() {
    const j = $('#journal');
    $('#tab-journal-btn').hidden = !S.canInternal;
    j.innerHTML = S.journal.length ? S.journal.map(e => `<li><span class="mono muted">${fmtStamp(e.at)}</span><span><b>${esc(who(e))}</b> · Lot ${esc(e.lot)} · ${esc(e.txt)}</span></li>`).join('')
      : '<li class="muted">Aucune modification enregistrée pour l’instant.</li>';
  }

  function renderAll() { paintPlan(); renderSummary(); renderFiche(); renderTable(); renderJournal(); }
  function select(l, fromTable) {
    if (!l) return;
    if (S.sel !== l) draft = '';
    S.sel = l;
    if (l.level !== S.level) { S.level = l.level; drawLevel(); }
    renderAll();
    if (fromTable && innerWidth < 1000) fiche.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ================= Écritures (API) ================= */
  const setSync = (s, txt) => { const e = $('#sync'); e.dataset.s = s; e.textContent = txt; };
  const syncIdle = () => S.canWrite ? setSync('ok', 'En ligne · synchronisé') : setSync('ro', 'En ligne · lecture seule');
  let chain = Promise.resolve();
  function queue(fn) { chain = chain.then(fn, fn); return chain; }
  async function call(method, url, body) {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
    if (r.status === 401) { location.reload(); throw new Error('session'); }
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw Object.assign(new Error(e.error || 'Erreur'), { status: r.status }); }
  }
  function saveLot(l, next) {
    const body = { occ: next.occ, travaux: !!next.travaux, fin: next.fin || '', dpe: next.dpe || '', dpeDate: next.dpeDate || '' };
    S.track[l.id] = { ...(S.track[l.id] || {}), ...body, maj: new Date().toISOString(), majPar: S.me.name };
    renderAll();
    return queue(async () => {
      setSync('busy', 'Enregistrement…');
      try { await call('PUT', '/api/lots/' + encodeURIComponent(l.id), body); syncIdle(); } catch (e) { onWriteError(e); }
      await reload();
    });
  }
  function addComment(l, txt, vis) {
    if (!txt) { $('#f-txt')?.focus(); return; }
    draft = '';
    S.comments.push({ lot: l.id, txt, vis, at: new Date().toISOString(), auteur: S.me.name });
    renderAll();
    return queue(async () => {
      setSync('busy', 'Enregistrement…');
      try { await call('POST', '/api/comments', { lot: l.id, txt, vis }); syncIdle(); } catch (e) { if (S.sel === l) draft = txt; onWriteError(e); }
      await reload();
    });
  }
  function onWriteError(e) {
    if (e.message === 'session') return;
    if (e.status === 403) { S.canWrite = false; S.canInternal = false; toast('Votre accès est en lecture seule : la modification n’a pas été enregistrée.'); syncIdle(); return; }
    setSync('err', 'Non enregistré'); toast((e.status && e.message) || 'La modification n’a pas pu être enregistrée. Vérifiez la connexion puis réessayez.');
  }

  /* ================= Export Excel ================= */
  function buildWorkbook() {
    const lotsRows = LOTS.slice().sort((a, b) => a.id - b.id).map(l => {
      const s = T(l.id), tr = S.track[l.id] || {};
      return { 'N° lot': +l.id, 'Locaux (identifiants)': l.locaux.map(x => x[0]).join(' | '), 'Niveaux': l.niveaux, 'Type': l.type, 'Surface m²': l.surf ?? '',
        'Occupation': OCC[s.occ], 'Travaux': s.travaux ? 'Oui' : 'Non', 'Fin travaux prévue': s.fin, 'DPE': s.dpe, 'Date DPE': s.dpeDate ? new Date(s.dpeDate + 'T00:00:00') : '',
        'Alertes': alerts(l, s).map(a => a[1]).join(' / '), 'Nb commentaires': cmtsOf(l.id).length, 'Mis à jour': tr.maj ? new Date(tr.maj) : '' };
    });
    const locRows = [];
    LOTS.forEach(l => l.locaux.forEach(x => locRows.push({ 'Identifiant': x[0], 'N° lot': +l.id, 'Niveau': x[1], 'Surface m²': x[2] ?? '' })));
    const cmRows = LOTS.flatMap(l => cmtsOf(l.id).map(c => ({ 'N° lot': +l.id, 'Date': c.at ? new Date(c.at) : '', 'Auteur': who(c), 'Visibilité': c.vis === 'int' ? 'Interne' : 'Partagé', 'Commentaire': c.txt })));
    const wb = XLSX.utils.book_new();
    const add = (rows, name, widths) => { const ws = XLSX.utils.json_to_sheet(rows, { cellDates: true, dateNF: 'dd/mm/yyyy' }); ws['!cols'] = widths.map(w => ({ wch: w })); if (rows.length) ws['!autofilter'] = { ref: ws['!ref'] }; XLSX.utils.book_append_sheet(wb, ws, name); };
    add(lotsRows, 'LOTS', [8, 34, 14, 10, 10, 14, 8, 18, 5, 11, 60, 10, 16]);
    add(locRows, 'LOCAUX', [16, 8, 8, 10]);
    add(cmRows, 'COMMENTAIRES', [8, 16, 18, 10, 80]);
    if (S.canInternal) add(S.journal.map(e => ({ 'Date': e.at ? new Date(e.at) : '', 'Auteur': who(e), 'N° lot': +e.lot, 'Modification': e.txt })), 'JOURNAL', [16, 18, 8, 60]);
    return wb;
  }
  $('#export').addEventListener('click', async () => {
    if (!window.XLSX) { toast('Le module Excel n’a pas pu se charger. Rechargez la page.'); return; }
    const d = new Date(), name = `Plan-Vivant_Tocqueville_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.xlsx`;
    const buf = XLSX.write(buildWorkbook(), { bookType: 'xlsx', type: 'array', cellDates: true });
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  /* ================= Contrôles ================= */
  $('#levels').innerHTML = LEVELS.map(L => `<button type="button" data-level="${L.id}">${L.name}</button>`).join('');
  $$('#levels button').forEach(b => b.addEventListener('click', () => { S.level = LEVELS.find(L => L.id === b.dataset.level); drawLevel(); paintPlan(); }));
  $$('[data-layer]').forEach(b => b.addEventListener('click', () => { S.layer = b.dataset.layer; $$('[data-layer]').forEach(o => o.setAttribute('aria-pressed', o === b)); paintPlan(); }));
  [['s-travaux', 'travaux'], ['s-comments', 'comments'], ['s-alertes', 'alertes']].forEach(([id, k]) => $('#' + id).addEventListener('change', e => { S.sym[k] = e.target.checked; paintPlan(); }));
  $('#searchform').addEventListener('submit', e => {
    e.preventDefault();
    const q = $('#q').value.trim();
    const l = byId[q] || LOTS.find(x => x.locaux.some(y => y[0].replace(/\s/g, '').toLowerCase().includes(q.replace(/\s/g, '').toLowerCase())) && q.length > 2);
    if (l) { select(l); $('#q').value = ''; } else toast(`Aucun lot « ${q} » sur les plans chargés.`);
  });
  $$('[role="tab"]').forEach(b => b.addEventListener('click', () => {
    $$('[role="tab"]').forEach(o => o.setAttribute('aria-selected', o === b));
    $('#tab-table').hidden = b.dataset.tab !== 'table'; $('#tab-journal').hidden = b.dataset.tab !== 'journal';
  }));

  drawLevel();
  renderAll();

  /* ================= Données serveur + direct ================= */
  function apply(st) {
    S.me = st.me; S.track = st.lots; S.comments = st.comments; S.journal = st.journal;
    S.canWrite = S.canInternal = st.me.role === 'gestion';
    $('#who').textContent = st.me.name + (S.canWrite ? '' : ' · lecture');
    syncIdle(); renderAll();
  }
  async function reload() {
    const r = await fetch('/api/state', { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
    if (!r) { setSync('err', 'Hors connexion'); return; }
    if (r.status === 401) { location.reload(); return; }
    if (r.ok) apply(await r.json());
  }
  apply(initial);
  let pend = false;
  const es = new EventSource('/api/events');
  es.addEventListener('change', () => { if (pend) return; pend = true; setTimeout(() => { pend = false; queue(reload); }, 150); });
  es.addEventListener('open', () => { queue(reload); });
  es.addEventListener('error', () => setSync('err', 'Reconnexion…'));
  $('#logout').addEventListener('click', async () => { es.close(); await fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); location.reload(); });
}

/* ================= Connexion ================= */
async function boot() {
  const $ = s => document.querySelector(s);
  const r = await fetch('/api/state', { credentials: 'same-origin', cache: 'no-store' });
  if (r.status === 401) {
    $('#login').hidden = false; $('#lg-email').focus();
    $('#loginform').addEventListener('submit', async e => {
      e.preventDefault();
      const err = $('#lg-err'); err.hidden = true; $('#lg-btn').disabled = true;
      try {
        const x = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('#lg-email').value.trim(), password: $('#lg-pw').value }) });
        if (x.ok) { location.reload(); return; }
        err.textContent = (await x.json().catch(() => ({}))).error || 'Connexion impossible.';
      } catch { err.textContent = 'Serveur injoignable. Vérifiez la connexion.'; }
      err.hidden = false; $('#lg-btn').disabled = false;
    });
    return;
  }
  if (!r.ok) { document.body.textContent = 'Le serveur ne répond pas correctement. Réessayez dans un instant.'; return; }
  const initial = await r.json();
  const plan = await (await fetch('/plan.json', { credentials: 'same-origin' })).json();
  $('#app').hidden = false;
  main(plan, initial);
}
boot();
