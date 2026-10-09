'use strict';
/* Plan Vivant — onglet « Plans » (comptes gestion) :
   versions du plan, import d'un DWG, retouche précise, contrôles, publication.

   Une version = le plan complet (format plan-vivant/2). Le plan « publié » est celui
   que tout le monde voit ; on retouche toujours un brouillon, puis on le publie. */

(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const P = window.PVPlan;
  const el = P.el;
  const fmtStamp = iso => { if (!iso) return ''; const d = new Date(iso), p = n => String(n).padStart(2, '0'); return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}h${p(d.getMinutes())}`; };
  const m2 = n => (Math.round(n * 10) / 10).toLocaleString('fr-FR') + ' m²';
  const natural = (a, b) => String(a).localeCompare(String(b), 'fr', { numeric: true });
  const clone = o => JSON.parse(JSON.stringify(o));
  const LOT_RE = /^[0-9A-Za-z]{1,12}$/;
  // « Sous-sol » / « Cave » → cave, « RDC » / « 0 » → 0, « 2e étage » / « 2 » → 2 (comme le convertisseur)
  const levelKey = s => {
    s = String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    if (/cave|sous|s-sol/.test(s)) return 'cave';
    if (/rdc|rez|^0$/.test(s)) return '0';
    const m = s.match(/\d+/); return m ? m[0] : s;
  };
  // Surface du listing pour un lot sur un niveau donné (locaux dont l'étage correspond)
  const listingArea = (r, lv) => r ? r.locaux.filter(x => levelKey(x[1]) === levelKey(lv.name)).reduce((t, x) => t + (x[2] || 0), 0) : 0;
  const STATUS = { brouillon: 'Brouillon', publie: 'En ligne', archive: 'Archivée' };
  let toastT;
  const toast = msg => { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 4000); };

  async function api(method, url, body, headers = {}) {
    const isBin = body instanceof Blob || body instanceof ArrayBuffer;
    const r = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store',
      headers: body && !isBin ? { 'Content-Type': 'application/json', ...headers } : headers,
      body: body ? (isBin ? body : JSON.stringify(body)) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || 'Erreur du serveur.'), { status: r.status, data });
    return data;
  }

  const root = $('#admin');
  if (!root) return;

  /* =================================================================
     ÉCRAN 1 : les versions
     ================================================================= */
  async function openAdmin() {
    document.body.classList.add('admin-open');
    root.hidden = false;
    $('#app').hidden = true;
    showList();
  }
  function closeAdmin() {
    if (ed && ed.dirty && !confirm('Des retouches ne sont pas enregistrées. Quitter quand même ?')) return;
    ed = null;
    root.hidden = true;
    document.body.classList.remove('admin-open');
    $('#app').hidden = false;
    if (needReload) location.reload();
  }
  let needReload = false;

  async function showList() {
    ed = null;
    $('#adm-list').hidden = false; $('#adm-editor').hidden = true;
    const box = $('#adm-versions');
    box.innerHTML = '<p class="muted">Chargement…</p>';
    let d;
    try { d = await api('GET', '/api/plans'); } catch (e) { box.innerHTML = `<p class="login-err">${esc(e.message)}</p>`; return; }
    $('#adm-listing').innerHTML = d.listing
      ? `<b>${esc(d.listing.filename)}</b> <span class="muted">· importé le ${fmtStamp(d.listing.uploaded)}${d.listing.by ? ' par ' + esc(d.listing.by) : ''}</span>`
      : '<span class="muted">Aucun listing : les types, surfaces et identifiants des locaux ne seront pas repris à l’import.</span>';
    if (!d.plans.length) {
      box.innerHTML = '<p class="muted">Aucune version pour l’instant : l’application affiche le plan provisoire livré avec elle. Importez le DWG du géomètre pour commencer.</p>';
      return;
    }
    box.innerHTML = `<table class="adm-table"><thead><tr><th>Version</th><th>État</th><th>Modifiée</th><th></th></tr></thead><tbody>
      ${d.plans.map(p => `<tr data-id="${p.id}">
        <td><b>${esc(p.label)}</b><span class="sub">${esc(p.source || '')}${p.createdBy ? ' · créée par ' + esc(p.createdBy) : ''}</span></td>
        <td><span class="badge st-${p.status}">${STATUS[p.status]}</span>${p.status === 'publie' && p.published ? `<span class="sub">depuis le ${fmtStamp(p.published)}</span>` : ''}</td>
        <td>${fmtStamp(p.updated)}${p.updatedBy ? `<span class="sub">${esc(p.updatedBy)}</span>` : ''}</td>
        <td class="adm-actions">
          ${p.status === 'brouillon' ? '<button type="button" class="btn" data-act="edit">Retoucher</button>' : '<button type="button" class="link" data-act="view">Voir</button><button type="button" class="link" data-act="copy">Créer un brouillon</button>'}
          ${p.status !== 'publie' ? '<button type="button" class="link danger" data-act="del">Supprimer</button>' : ''}
        </td></tr>`).join('')}</tbody></table>`;
  }
  $('#adm-versions').addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'), tr = e.target.closest('tr[data-id]');
    if (!b || !tr) return;
    const id = Number(tr.dataset.id), act = b.dataset.act;
    try {
      if (act === 'edit' || act === 'view') return openEditor(id);
      if (act === 'copy') { const r = await api('POST', `/api/plans/${id}/copier`); toast('Brouillon créé : vous pouvez le retoucher.'); return openEditor(r.id); }
      if (act === 'del') {
        if (!confirm('Supprimer définitivement cette version ?')) return;
        await api('DELETE', `/api/plans/${id}`); showList();
      }
    } catch (x) { toast(x.message); }
  });

  // Listing Excel de référence
  $('#adm-listing-file').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      await api('POST', '/api/plans/listing', f, { 'X-Nom-Fichier': encodeURIComponent(f.name) });
      toast('Listing enregistré : il sera utilisé au prochain import de DWG.');
      showList();
    } catch (x) { toast(x.message); }
  });

  // Import d'un DWG → conversion → nouveau brouillon
  $('#adm-dwg-file').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const st = $('#adm-import-state');
    st.hidden = false; st.className = 'adm-state'; st.textContent = `Conversion de « ${f.name} »… (environ 30 secondes)`;
    try {
      const r = await api('POST', '/api/plans/import', f, { 'X-Nom-Fichier': encodeURIComponent(f.name) });
      st.hidden = true;
      toast(`Plan converti : ${r.rapport.total.lots} lots, ${r.rapport.total.a_verifier} zone(s) à vérifier.`);
      openEditor(r.id);
    } catch (x) { st.className = 'adm-state err'; st.textContent = x.message; }
  });

  /* =================================================================
     ÉCRAN 2 : l'éditeur
     ================================================================= */
  let ed = null;  // { id, meta, plan, level, sel, mode, undo, redo, dirty, rev, ro }
  const svg = $('#adm-plan');
  let zoom = null;

  async function openEditor(id) {
    let v;
    try { v = await api('GET', `/api/plans/${id}`); } catch (x) { toast(x.message); return; }
    if (!P.isV2(v.data.levels[0])) { toast('Cette version utilise l’ancien format (schémas) : seule la retouche des plans importés d’un DWG est possible.'); return; }
    ed = { id, meta: v, plan: v.data, rapport: v.rapport, lotsWithData: new Set(v.lotsWithData), level: v.data.levels[0].id,
      sel: null, mode: 'select', undo: [], redo: [], dirty: false, rev: v.rev, ro: v.status !== 'brouillon', panel: 'check', snap: $('#ed-snap').checked };
    $('#adm-list').hidden = true; $('#adm-editor').hidden = false;
    $('#ed-label').value = v.label; $('#ed-label').disabled = ed.ro;
    $('#ed-status').textContent = STATUS[v.status]; $('#ed-status').className = 'badge st-' + v.status;
    root.classList.toggle('ro', ed.ro);
    if (!zoom) zoom = P.zoomable(svg, { onView: upp => { if (ed) { ed.upp = upp; scaleLabels(); } } });
    setSaved(ed.ro ? 'Lecture seule' : 'Enregistré');
    renderLevels();
    draw(true);
    renderPanel();
  }
  $('#ed-back').addEventListener('click', async () => {
    if (ed && ed.dirty && !confirm('Des retouches ne sont pas enregistrées. Revenir à la liste quand même ?')) return;
    showList();
  });

  const L = () => ed.plan.levels.find(x => x.id === ed.level);
  const scaleOf = lv => lv.scale || 40;
  const lotOn = (lv, n) => lv.lots.find(x => x.lot === n);
  function renderLevels() {
    $('#ed-levels').innerHTML = ed.plan.levels.map(lv => {
      const todo = (lv.orphans || []).length + (lv.pending || []).length + lv.lots.filter(x => x.auto && x.auto.length).length;
      return `<button type="button" data-level="${esc(lv.id)}" aria-pressed="${lv.id === ed.level}">${esc(lv.name)}${todo ? ` <span class="dot-todo">${todo}</span>` : ''}</button>`;
    }).join('');
  }
  $('#ed-levels').addEventListener('click', e => {
    const b = e.target.closest('[data-level]'); if (!b || !ed) return;
    ed.level = b.dataset.level; ed.sel = null; setMode('select'); renderLevels(); draw(true); renderPanel();
  });

  /* ---------- historique (annuler / rétablir) ---------- */
  // On mémorise les éléments modifiables du niveau (pas le fond de plan, qui ne change pas)
  const snap = () => ({ level: ed.level, levels: ed.plan.levels.map(lv => ({ id: lv.id, lots: clone(lv.lots), orphans: clone(lv.orphans || []), pending: clone(lv.pending || []), halls: clone(lv.halls || []) })) });
  function restore(s) {
    for (const x of s.levels) { const lv = ed.plan.levels.find(l => l.id === x.id); Object.assign(lv, { lots: x.lots, orphans: x.orphans, pending: x.pending, halls: x.halls }); }
    ed.level = s.level; ed.sel = null;
  }
  // Toute modification passe par change() : historique + enregistrement automatique
  function change(label, fn) {
    if (ed.ro) return;
    const before = snap();
    fn();
    ed.undo.push({ label, s: before }); if (ed.undo.length > 150) ed.undo.shift();
    ed.redo = [];
    for (const lv of ed.plan.levels) for (const lot of lv.lots) lot.area = Math.round(P.areaM2(lot.parts, scaleOf(lv)) * 100) / 100;
    markDirty(label);
    renderLevels(); draw(); renderPanel();
  }
  function undo() { if (!ed || !ed.undo.length) return; const u = ed.undo.pop(); ed.redo.push({ label: u.label, s: snap() }); restore(u.s); markDirty('Annulé : ' + u.label); renderLevels(); draw(); renderPanel(); }
  function redo() { if (!ed || !ed.redo.length) return; const u = ed.redo.pop(); ed.undo.push({ label: u.label, s: snap() }); restore(u.s); markDirty('Rétabli : ' + u.label); renderLevels(); draw(); renderPanel(); }
  $('#ed-undo').addEventListener('click', undo);
  $('#ed-redo').addEventListener('click', redo);

  /* ---------- enregistrement ---------- */
  let saveT = null, saving = null;
  function setSaved(t, err) { const s = $('#ed-saved'); s.textContent = t; s.classList.toggle('err', !!err); }
  function markDirty(label) {
    ed.dirty = true; setSaved('Modifications…');
    $('#ed-undo').disabled = !ed.undo.length; $('#ed-undo').title = ed.undo.length ? 'Annuler : ' + ed.undo[ed.undo.length - 1].label : '';
    $('#ed-redo').disabled = !ed.redo.length;
    clearTimeout(saveT); saveT = setTimeout(save, 1500);
  }
  async function save() {
    if (!ed || ed.ro || !ed.dirty) return;
    if (saving) { await saving; return save(); }
    const cur = ed; cur.dirty = false; setSaved('Enregistrement…');
    saving = api('PUT', `/api/plans/${cur.id}`, { rev: cur.rev, label: $('#ed-label').value.trim(), data: cur.plan })
      .then(r => { cur.rev = r.rev; if (ed === cur) setSaved(cur.dirty ? 'Modifications…' : 'Enregistré'); })
      .catch(x => { cur.dirty = true; if (ed === cur) setSaved('Non enregistré : ' + x.message, true); if (x.status !== 409) { clearTimeout(saveT); saveT = setTimeout(save, 5000); } })
      .finally(() => { saving = null; });
    await saving;
  }
  $('#ed-label').addEventListener('input', () => { if (ed && !ed.ro) markDirty('Nom de la version'); });
  window.addEventListener('beforeunload', e => { if (ed && ed.dirty) e.preventDefault(); });

  /* =================================================================
     DESSIN
     ================================================================= */
  function draw(resetView) {
    const lv = L();
    svg.innerHTML = '';
    const defs = el('defs', {}, svg);
    const pat = el('pattern', { id: 'adm-hatch', width: 10, height: 10, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
    el('rect', { width: 4, height: 10, fill: 'var(--bad)', opacity: .55 }, pat);
    P.background(svg, lv);
    for (const h of lv.halls || []) el('path', { d: P.shapeD(h), 'fill-rule': 'evenodd', class: 'e-hall' }, svg);
    for (const lot of lv.lots) {
      const sel = ed.sel && ed.sel.kind === 'lot' && ed.sel.lot === lot.lot;
      const G = el('g', { class: 'e-lot' + (sel ? ' is-sel' : '') + (ed.lotsWithData.has(lot.lot) ? ' has-data' : ''), 'data-lot': lot.lot }, svg);
      el('path', { d: P.partsD(lot.parts), 'fill-rule': 'evenodd', class: 'e-lot-fill' }, G);
      for (const a of lot.auto || []) el('path', { d: P.partsD(a.parts), 'fill-rule': 'evenodd', class: 'e-auto' }, G);
      if (sel && ed.sel.part != null && lot.parts[ed.sel.part]) el('path', { d: P.partsD([lot.parts[ed.sel.part]]), 'fill-rule': 'evenodd', class: 'e-part-sel' }, G);
    }
    for (const o of lv.orphans || []) {
      const sel = ed.sel && ed.sel.kind === 'orphan' && ed.sel.id === o.id;
      el('path', { d: P.partsD(o.parts), 'fill-rule': 'evenodd', class: 'e-orphan' + (sel ? ' is-sel' : ''), 'data-orphan': o.id }, svg);
    }
    P.texts(svg, lv);
    // Bulles des numéros (+ numéros encore sans surface)
    const tags = el('g', { class: 'e-tags' }, svg);
    for (const lot of lv.lots) tagEl(tags, lot.tag, lot.lot, 'lot', ed.sel && ed.sel.kind === 'lot' && ed.sel.lot === lot.lot);
    for (const p of lv.pending || []) tagEl(tags, p.tag, p.lot, 'pending', ed.sel && ed.sel.kind === 'pending' && ed.sel.lot === p.lot);
    drawEditLayer();
    if (resetView) zoom.reset(lv.vb);
    scaleLabels();
  }
  function tagEl(parent, [x, y], txt, kind, sel) {
    const g = el('g', { class: `e-tag ${kind}${sel ? ' is-sel' : ''}`, 'data-x': x, 'data-y': y, 'data-tag': txt, 'data-kind': kind, transform: `translate(${x} ${y})` }, parent);
    el('circle', { r: txt.length > 3 ? 26 : 22 }, g);
    const t = el('text', { y: 6, 'text-anchor': 'middle' }, g); t.textContent = kind === 'pending' ? txt + '?' : txt;
  }
  function scaleLabels() {
    if (!ed) return;
    const k = P.labelScale(ed.upp || 1, 22, 11);
    $$('.e-tag', svg).forEach(t => t.setAttribute('transform', `translate(${t.dataset.x} ${t.dataset.y}) scale(${k})`));
    svg.classList.toggle('rooms-off', 13 / (ed.upp || 1) < 7);
    const hr = 5 * (ed.upp || 1);  // poignées : 5 px à l'écran
    $$('.e-handle', svg).forEach(h => h.setAttribute('r', h.classList.contains('mid') ? hr * .7 : hr));
  }

  /* ---------- poignées de retouche de la forme sélectionnée ---------- */
  function drawEditLayer() {
    if (ed.ro || ed.mode !== 'shape' || !ed.sel || ed.sel.kind !== 'lot' || ed.sel.part == null) return;
    const lot = lotOn(L(), ed.sel.lot); if (!lot) return;
    const poly = lot.parts[ed.sel.part]; if (!poly) return;
    const g = el('g', { class: 'e-handles' }, svg);
    poly.forEach((ring, ri) => ring.forEach((p, vi) => {
      const q = ring[(vi + 1) % ring.length];
      el('circle', { cx: (p[0] + q[0]) / 2, cy: (p[1] + q[1]) / 2, class: 'e-handle mid', 'data-ri': ri, 'data-vi': vi, 'data-mid': 1 }, g);
    }));
    poly.forEach((ring, ri) => ring.forEach((p, vi) => el('circle', { cx: p[0], cy: p[1], class: 'e-handle', 'data-ri': ri, 'data-vi': vi }, g)));
  }

  /* ---------- aimantation : sommets des murs et des autres lots ---------- */
  let snapIdx = null;
  function snapIndex() {
    const lv = L(), key = lv.id + ':' + ed.undo.length;
    if (snapIdx && snapIdx.key === key) return snapIdx;
    const cell = 20, grid = new Map(), add = (x, y) => { const k = Math.floor(x / cell) + ',' + Math.floor(y / cell); (grid.get(k) || grid.set(k, []).get(k)).push([x, y]); };
    for (const c of ['murs', 'poche', 'embrasures']) {
      const d = lv.bg && lv.bg[c]; if (!d) continue;
      const nums = d.match(/-?\d+(\.\d+)?/g) || [];
      for (let i = 0; i + 1 < nums.length; i += 2) add(+nums[i], +nums[i + 1]);
    }
    for (const lot of lv.lots) for (const poly of lot.parts) for (const r of poly) for (const [x, y] of r) add(x, y);
    for (const h of lv.halls || []) for (const poly of h.parts || []) for (const r of poly) for (const [x, y] of r) add(x, y);
    snapIdx = { key, cell, grid };
    return snapIdx;
  }
  function snapPoint(p, skip) {
    if (!ed.snap) return p;
    const { cell, grid } = snapIndex(), rad = 8 * (ed.upp || 1);  // 8 px à l'écran
    let best = null, bd = rad;
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), n = Math.ceil(rad / cell);
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) for (const q of grid.get((cx + i) + ',' + (cy + j)) || []) {
      if (skip && q[0] === skip[0] && q[1] === skip[1]) continue;
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; best = q; }
    }
    return best ? [best[0], best[1]] : p;
  }
  $('#ed-snap').addEventListener('change', e => { if (ed) ed.snap = e.target.checked; });

  /* ---------- interactions sur le plan ---------- */
  const evPt = e => { const [x, y] = zoom.toPlan(e.clientX, e.clientY); return [Math.round(x * 10) / 10, Math.round(y * 10) / 10]; };
  let drag = null;
  svg.addEventListener('pointerdown', e => {
    if (!ed || ed.ro || e.button > 0) return;
    const h = e.target.closest('.e-handle');
    if (h && ed.mode === 'shape') {
      e.stopPropagation(); e.preventDefault();
      const ri = +h.dataset.ri, vi = +h.dataset.vi;
      const before = snap();
      const lot = lotOn(L(), ed.sel.lot), ring = lot.parts[ed.sel.part][ri];
      if (h.dataset.mid) { ring.splice(vi + 1, 0, evPt(e)); drag = { ri, vi: vi + 1, before, label: 'Ajout d’un point' }; }
      else drag = { ri, vi, before, label: 'Déplacement d’un point', orig: ring[vi].slice() };
      svg.dataset.drawing = '1';
      svg.setPointerCapture(e.pointerId);
      draw();
      return;
    }
    if (ed.mode === 'draw' || ed.mode === 'tag') svg.dataset.drawing = '1';
  }, true);
  svg.addEventListener('pointermove', e => {
    if (!ed) return;
    if (drag) {
      const lot = lotOn(L(), ed.sel.lot), ring = lot.parts[ed.sel.part][drag.ri];
      ring[drag.vi] = e.shiftKey ? evPt(e) : snapPoint(evPt(e), drag.orig);
      const hs = $$('.e-handle:not(.mid)', svg).filter(c => +c.dataset.ri === drag.ri && +c.dataset.vi === drag.vi)[0];
      if (hs) { hs.setAttribute('cx', ring[drag.vi][0]); hs.setAttribute('cy', ring[drag.vi][1]); }
      const sel = $('.e-part-sel', svg); if (sel) sel.setAttribute('d', P.partsD([lot.parts[ed.sel.part]]));
      return;
    }
    if (ed.mode === 'draw' && ed.draft) { ed.cursor = e.shiftKey ? evPt(e) : snapPoint(evPt(e)); drawDraft(); }
  });
  svg.addEventListener('pointerup', () => {
    delete svg.dataset.drawing;
    if (!drag) return;
    const d = drag; drag = null;
    ed.undo.push({ label: d.label, s: d.before }); ed.redo = [];
    const lv = L(), lot = lotOn(lv, ed.sel.lot); lot.area = Math.round(P.areaM2(lot.parts, scaleOf(lv)) * 100) / 100;
    markDirty(d.label); draw(); renderPanel();
  });
  // Double-clic sur un point : le supprimer (un contour garde au moins 3 points)
  svg.addEventListener('dblclick', e => {
    if (!ed || ed.ro) return;
    const h = e.target.closest('.e-handle:not(.mid)');
    if (h && ed.mode === 'shape') {
      const ri = +h.dataset.ri, vi = +h.dataset.vi;
      const lot = lotOn(L(), ed.sel.lot), ring = lot.parts[ed.sel.part][ri];
      if (ring.length <= 3) { toast('Un contour garde au moins 3 points.'); return; }
      change('Suppression d’un point', () => ring.splice(vi, 1));
      return;
    }
    if (ed.mode === 'draw' && ed.draft && ed.draft.length >= 3) { e.preventDefault(); finishDraft(); }
  });
  svg.addEventListener('click', e => {
    if (!ed) return;
    const p = evPt(e);
    if (ed.mode === 'draw' && !ed.ro) {
      const q = e.shiftKey ? p : snapPoint(p);
      const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 10 * (ed.upp || 1);
      if (ed.draft && ed.draft.length >= 3 && near(q, ed.draft[0])) return finishDraft();
      (ed.draft = ed.draft || []).push(q); drawDraft(); return;
    }
    if (ed.mode === 'tag' && !ed.ro) {
      const target = ed.sel;
      setMode('select');
      if (target && target.kind === 'lot') change(`Numéro du lot ${target.lot} déplacé`, () => { lotOn(L(), target.lot).tag = p; });
      else if (target && target.kind === 'pending') change(`Numéro ${target.lot} déplacé`, () => { L().pending.find(x => x.lot === target.lot).tag = p; });
      return;
    }
    // Sélection : bulle > zone à vérifier > lot (on retient la partie cliquée)
    const tag = e.target.closest('.e-tag');
    if (tag) { selectItem(tag.dataset.kind === 'pending' ? { kind: 'pending', lot: tag.dataset.tag } : { kind: 'lot', lot: tag.dataset.tag }); return; }
    const o = e.target.closest('[data-orphan]');
    if (o) { selectItem({ kind: 'orphan', id: o.dataset.orphan }); return; }
    const g = e.target.closest('.e-lot');
    if (g) {
      const lot = lotOn(L(), g.dataset.lot);
      const part = lot.parts.findIndex(poly => P.pointInParts(p, [poly]));
      selectItem({ kind: 'lot', lot: lot.lot, part: part >= 0 ? part : null });
      return;
    }
    if (ed.mode === 'select') selectItem(null);
  });
  document.addEventListener('keydown', e => {
    if (!ed || root.hidden) return;
    const typing = e.target.closest && e.target.closest('input, textarea, select');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); }
    else if (e.key === 'Escape') { if (ed.mode !== 'select') setMode('select'); else selectItem(null); }
    else if (e.key === 'Enter' && ed.mode === 'draw' && ed.draft && ed.draft.length >= 3) { e.preventDefault(); finishDraft(); }
  });

  /* ---------- modes : sélection, retouche de forme, dessin, numéro ---------- */
  function setMode(m, target) {
    ed.mode = m; ed.draft = null; ed.cursor = null; ed.drawFor = target || null;
    root.dataset.mode = m;
    const hint = $('#ed-hint');
    hint.hidden = m === 'select';
    hint.textContent = m === 'shape' ? 'Faites glisser les points (aimantés aux murs ; Maj = sans aimant). Cliquez sur un point intermédiaire pour en ajouter un, double-cliquez sur un point pour le supprimer. Échap pour terminer.'
      : m === 'draw' ? `Cliquez chaque angle${target && target.lot ? ` de la nouvelle surface du lot ${target.lot}` : ''} (aimantés aux murs ; Maj = sans aimant). Terminez sur le premier point, par un double-clic ou Entrée. Échap pour annuler.`
      : m === 'tag' ? 'Cliquez à l’endroit où placer le numéro. Échap pour annuler.' : '';
    draw();
  }
  function drawDraft() {
    let g = $('.e-draft', svg); if (g) g.remove();
    if (!ed.draft) return;
    g = el('g', { class: 'e-draft' }, svg);
    const pts = ed.draft.concat(ed.cursor ? [ed.cursor] : []);
    el('path', { d: 'M' + pts.map(p => p.join(' ')).join('L') + (pts.length > 2 ? 'Z' : '') }, g);
    ed.draft.forEach((p, i) => el('circle', { cx: p[0], cy: p[1], r: (i ? 4 : 7) * (ed.upp || 1) }, g));
  }
  function finishDraft() {
    const ring = ed.draft.filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
    const target = ed.drawFor; setMode('select');
    if (ring.length < 3) { toast('Il faut au moins 3 points.'); return; }
    const lv = L();
    let num = target && target.lot;
    if (!num) {
      num = (prompt('Numéro du lot pour cette surface :') || '').trim();
      if (!num) return;
      if (!LOT_RE.test(num)) { toast('Numéro invalide (lettres et chiffres uniquement).'); return; }
    }
    change(`Surface dessinée pour le lot ${num}`, () => addParts(lv, num, [[ring]], ring));
    selectItem({ kind: 'lot', lot: num });
  }
  // Ajoute des surfaces à un lot du niveau (le crée si besoin, en reprenant le numéro « à placer »)
  function addParts(lv, num, parts, fallbackRing) {
    let lot = lotOn(lv, num);
    if (lot) { lot.parts.push(...parts); return lot; }
    const pend = (lv.pending || []).find(x => x.lot === num);
    let tag = pend ? pend.tag : null;
    if (!tag) { const b = P.bounds(parts); tag = [Math.round((b[0] + b[2]) / 2), Math.round((b[1] + b[3]) / 2)]; }
    lot = { lot: num, parts, tag };
    lv.lots.push(lot);
    if (pend) lv.pending = lv.pending.filter(x => x !== pend);
    lv.lots.sort((a, b) => natural(a.lot, b.lot));
    return lot;
  }

  function selectItem(s) {
    ed.sel = s;
    if (ed.mode === 'shape' && (!s || s.kind !== 'lot' || s.part == null)) ed.mode = 'select';
    if (s) ed.panel = 'item';
    draw(); renderPanel();
  }
  function focusItem(s) {
    const lv = L();
    let parts = null, pt = null;
    if (s.kind === 'lot') { const lot = lotOn(lv, s.lot); parts = s.part != null ? [lot.parts[s.part]] : lot.parts; }
    else if (s.kind === 'orphan') parts = lv.orphans.find(o => o.id === s.id).parts;
    else if (s.kind === 'pending') pt = lv.pending.find(x => x.lot === s.lot).tag;
    if (parts) zoom.focus(P.bounds(parts), 1.5);
    else if (pt) zoom.focus([pt[0] - 80, pt[1] - 80, pt[0] + 80, pt[1] + 80], 1.5);
  }

  /* =================================================================
     PANNEAU : à vérifier, lots, contrôles, fiche de l'élément sélectionné
     ================================================================= */
  $('#ed-tabs').addEventListener('click', e => { const b = e.target.closest('[data-panel]'); if (!b || !ed) return; ed.panel = b.dataset.panel; if (b.dataset.panel !== 'item') { ed.sel = null; draw(); } renderPanel(); });

  function todoItems() {
    const out = [];
    for (const lv of ed.plan.levels) {
      for (const o of lv.orphans || []) out.push({ lv, kind: 'orphan', o });
      for (const p of lv.pending || []) out.push({ lv, kind: 'pending', p });
      for (const lot of lv.lots) for (const [i, a] of (lot.auto || []).entries()) out.push({ lv, kind: 'auto', lot, a, i });
    }
    return out;
  }
  function checks() {
    const ref = ed.plan.ref || {}, onPlan = new Map();
    for (const lv of ed.plan.levels) {
      for (const lot of lv.lots) { const e = onPlan.get(lot.lot) || { area: 0, levels: [] }; e.area += P.areaM2(lot.parts, scaleOf(lv)); e.levels.push(lv.name); onPlan.set(lot.lot, e); }
      for (const p of lv.pending || []) if (!onPlan.has(p.lot)) onPlan.set(p.lot, { area: 0, levels: [lv.name], pendingOnly: true });
    }
    const hasRef = Object.keys(ref).length > 0;
    const missing = hasRef ? Object.keys(ref).filter(n => !onPlan.has(n)).sort(natural) : [];
    const unknown = hasRef ? [...onPlan.keys()].filter(n => !ref[n]).sort(natural) : [];
    const gaps = [];
    if (hasRef) for (const lv of ed.plan.levels) for (const lot of lv.lots) {
      const s = listingArea(ref[lot.lot], lv), a = P.areaM2(lot.parts, scaleOf(lv));
      if (s > 0 && a > 0 && Math.abs(a - s) / s > 0.15) gaps.push({ n: lot.lot, lv: lv.name, lvId: lv.id, plan: a, listing: s });
    }
    gaps.sort((a, b) => natural(a.n, b.n));
    const lost = [...ed.lotsWithData].filter(n => !onPlan.has(n)).sort(natural);
    return { hasRef, missing, unknown, gaps, lost, onPlan, todo: todoItems().length };
  }

  function renderPanel() {
    if (!ed) return;
    const c = checks();
    $('#ed-count-todo').textContent = c.todo || '';
    $('#ed-count-lots').textContent = c.onPlan.size;
    $('#ed-count-check').textContent = (c.missing.length + c.unknown.length + c.gaps.length + c.lost.length) || '';
    if (ed.panel === 'item' && !ed.sel) ed.panel = 'check';
    $$('#ed-tabs [data-panel]').forEach(b => b.setAttribute('aria-pressed', b.dataset.panel === ed.panel));
    $('#ed-tab-item').hidden = !ed.sel;
    const box = $('#ed-panel');
    $('#ed-publish').disabled = ed.ro;
    if (ed.panel === 'check') box.innerHTML = panelTodo();
    else if (ed.panel === 'lots') box.innerHTML = panelLots();
    else if (ed.panel === 'controls') box.innerHTML = panelControls(c);
    else box.innerHTML = panelItem();
    $('#ed-shape').disabled = ed.ro || !(ed.sel && ed.sel.kind === 'lot' && ed.sel.part != null);
    $('#ed-shape').setAttribute('aria-pressed', ed.mode === 'shape');
    $('#ed-draw').setAttribute('aria-pressed', ed.mode === 'draw');
    $('#ed-draw').disabled = ed.ro;
    $('#ed-undo').disabled = !ed.undo.length; $('#ed-redo').disabled = !ed.redo.length;
  }
  const suggBtn = (lot, txt, extra = '') => `<button type="button" class="btn small" data-do="attach" data-lot="${esc(lot)}"${extra}>${txt}</button>`;
  function panelTodo() {
    const items = todoItems();
    if (!items.length) return '<p class="ok-msg">✓ Rien à vérifier : chaque surface est rattachée à un lot.</p>' + (ed.ro ? '' : '<p class="muted small">Pensez à consulter l’onglet « Contrôles » avant de publier.</p>');
    return `<p class="muted small">Cliquez sur un élément pour le voir sur le plan.</p><ul class="todo">${items.map(it => {
      if (it.kind === 'orphan') {
        const o = it.o;
        const sug = (o.suggestions || []).map(s => suggBtn(s.lot, `C’est le lot ${esc(s.lot)}`) + `<span class="why">${s.distance != null ? `numéro posé à ${String(s.distance).replace('.', ',')} m` : esc(s.listing || '')}</span>`).join('');
        const cand = (o.candidats || []).map(n => suggBtn(n, `Rattacher au ${esc(n)}`)).join('');
        return `<li data-go="orphan" data-level="${esc(it.lv.id)}" data-id="${esc(o.id)}"><div><b>Surface sans numéro</b> · ${esc(it.lv.name)} · ${m2(o.area)}</div>
          <div class="todo-act">${sug}${cand}${ed.ro ? '' : `<button type="button" class="link" data-do="pick">Autre lot…</button><button type="button" class="link" data-do="common">Partie commune</button><button type="button" class="link danger" data-do="drop">Supprimer</button>`}</div></li>`;
      }
      if (it.kind === 'pending') return `<li data-go="pending" data-level="${esc(it.lv.id)}" data-lot="${esc(it.p.lot)}"><div><b>Lot ${esc(it.p.lot)}</b> · ${esc(it.lv.name)} · numéro sans surface</div>
        <div class="todo-act">${ed.ro ? '' : `<button type="button" class="btn small" data-do="drawfor">Dessiner son contour</button><button type="button" class="link danger" data-do="droppending">Retirer ce numéro</button>`}</div></li>`;
      return `<li data-go="auto" data-level="${esc(it.lv.id)}" data-lot="${esc(it.lot.lot)}" data-i="${it.i}"><div><b>Rattachement automatique</b> · lot ${esc(it.lot.lot)} · ${esc(it.lv.name)} · ${m2(it.a.area)}</div>
        <div class="why">Surface sans numéro qui ne touche que ce lot.</div>
        <div class="todo-act">${ed.ro ? '' : `<button type="button" class="btn small" data-do="okauto">C’est juste</button><button type="button" class="link" data-do="undoauto">Détacher</button>`}</div></li>`;
    }).join('')}</ul>`;
  }
  function panelLots() {
    const ref = ed.plan.ref || {};
    const rows = [];
    for (const lv of ed.plan.levels) for (const lot of lv.lots) rows.push({ lv, lot });
    rows.sort((a, b) => natural(a.lot.lot, b.lot.lot) || ed.plan.levels.indexOf(a.lv) - ed.plan.levels.indexOf(b.lv));
    return `<input type="search" id="ed-lot-q" class="ed-search" placeholder="Chercher un lot…" aria-label="Chercher un lot" value="${esc(ed.lotQ || '')}">
      <ul class="lotlist">${rows.filter(r => !ed.lotQ || r.lot.lot.toLowerCase().includes(ed.lotQ.toLowerCase())).map(({ lv, lot }) => {
        const r = ref[lot.lot]; return `<li data-go="lot" data-level="${esc(lv.id)}" data-lot="${esc(lot.lot)}"><b>${esc(lot.lot)}</b><span>${esc(lv.name)} · ${m2(P.areaM2(lot.parts, scaleOf(lv)))}${lot.parts.length > 1 ? ` · ${lot.parts.length} surfaces` : ''}</span><span class="muted">${esc(r ? r.type : 'hors listing')}</span></li>`;
      }).join('')}</ul>`;
  }
  function panelControls(c) {
    const list = (arr, fmt) => arr.length ? `<ul class="ctl">${arr.map(fmt).join('')}</ul>` : '<p class="ok-msg">✓ Aucun</p>';
    const where = n => { for (const lv of ed.plan.levels) if (lotOn(lv, n)) return lv.id; return ''; };
    return `
      <h3>À vérifier <b>${c.todo}</b></h3>${c.todo ? '<p class="muted small">Voir l’onglet « À vérifier ».</p>' : '<p class="ok-msg">✓ Tout est rattaché</p>'}
      ${c.lost.length ? `<h3 class="danger">Lots avec des informations absents du plan <b>${c.lost.length}</b></h3><p class="muted small">Occupation, DPE ou commentaires déjà saisis : ces lots n’apparaîtraient plus sur le plan publié.</p>${list(c.lost, n => `<li><b>${esc(n)}</b></li>`)}` : ''}
      ${c.hasRef ? `
      <h3>Au listing mais pas sur le plan <b>${c.missing.length}</b></h3>${list(c.missing, n => { const r = ed.plan.ref[n]; return `<li><b>${esc(n)}</b> <span class="muted">${esc(r.type || '')} · ${esc(r.locaux.map(x => `${x[0]} (${x[1]}${x[2] != null ? ', ' + x[2] + ' m²' : ''})`).join(' · '))}</span></li>`; })}
      <h3>Sur le plan mais pas au listing <b>${c.unknown.length}</b></h3>${list(c.unknown, n => `<li data-go="lot" data-level="${esc(where(n))}" data-lot="${esc(n)}"><b>${esc(n)}</b></li>`)}
      <h3>Surfaces très différentes (plus de 15 %) <b>${c.gaps.length}</b></h3><p class="muted small">Surface dessinée au plan comparée au listing, niveau par niveau (le plan compte la surface au sol hachurée par le géomètre).</p>${list(c.gaps, g => `<li data-go="lot" data-level="${esc(g.lvId)}" data-lot="${esc(g.n)}"><b>${esc(g.n)}</b><span>${esc(g.lv)} · plan ${m2(g.plan)} · listing ${m2(g.listing)}</span><span class="muted">${g.plan > g.listing ? '+' : ''}${Math.round((g.plan - g.listing) / g.listing * 100)} %</span></li>`)}`
      : '<p class="muted">Aucun listing associé à cette version : importez le listing puis réimportez le DWG pour comparer.</p>'}`;
  }
  function panelItem() {
    const s = ed.sel, lv = L(), ref = ed.plan.ref || {};
    if (s.kind === 'orphan') {
      const o = lv.orphans.find(x => x.id === s.id); if (!o) return '';
      return `<h3>Surface sans numéro</h3><p>${esc(lv.name)} · ${m2(o.area)}</p>${ed.ro ? '' : `<div class="todo" data-level="${esc(lv.id)}" data-id="${esc(o.id)}">
        <div class="todo-act">${(o.suggestions || []).map(x => suggBtn(x.lot, `C’est le lot ${esc(x.lot)}`)).join('')}${(o.candidats || []).map(n => suggBtn(n, `Rattacher au ${esc(n)}`)).join('')}
        <button type="button" class="link" data-do="pick">Autre lot…</button><button type="button" class="link" data-do="common">Partie commune</button><button type="button" class="link danger" data-do="drop">Supprimer</button></div></div>`}`;
    }
    if (s.kind === 'pending') {
      return `<h3>Lot ${esc(s.lot)} · numéro sans surface</h3><p class="muted">${esc(lv.name)}. Le géomètre a posé ce numéro sans colorer le lot.</p>${ed.ro ? '' : `<div class="todo" data-level="${esc(lv.id)}" data-lot="${esc(s.lot)}"><div class="todo-act">
        <button type="button" class="btn small" data-do="drawfor">Dessiner son contour</button><button type="button" class="link" data-do="movetag">Déplacer le numéro</button><button type="button" class="link danger" data-do="droppending">Retirer ce numéro</button></div></div>`}`;
    }
    const lot = lotOn(lv, s.lot); if (!lot) return '';
    const r = ref[lot.lot], area = P.areaM2(lot.parts, scaleOf(lv));
    const sListing = listingArea(r, lv);
    const other = ed.plan.levels.filter(x => x !== lv && lotOn(x, lot.lot)).map(x => x.name);
    return `<h3>Lot ${esc(lot.lot)} ${ed.lotsWithData.has(lot.lot) ? '<span class="badge st-publie" title="Occupation, DPE ou commentaires déjà saisis">suivi</span>' : ''}</h3>
      <p>${esc(lv.name)} · ${m2(area)} au plan${sListing ? ` · ${m2(sListing)} au listing pour ce niveau` : ''}${other.length ? `<br><span class="muted">Aussi sur : ${esc(other.join(', '))}</span>` : ''}</p>
      ${r ? `<p class="muted small">${esc(r.type || '')} · ${esc(r.locaux.map(x => `${x[0]} (${x[1]}${x[2] != null ? ', ' + x[2] + ' m²' : ''})`).join(' · '))}</p>` : '<p class="muted small">Ce numéro n’est pas dans le listing.</p>'}
      <h4>Surfaces</h4><ul class="parts">${lot.parts.map((poly, i) => `<li class="${s.part === i ? 'is-sel' : ''}" data-part="${i}"><button type="button" class="link" data-do="part">Surface ${i + 1}</button> · ${m2(P.areaM2([poly], scaleOf(lv)))}${poly.length > 1 ? ` · ${poly.length - 1} trou(s)` : ''}
        ${ed.ro ? '' : `<span class="part-act"><button type="button" class="link" data-do="shape">Retoucher</button><button type="button" class="link" data-do="detach">Détacher</button><button type="button" class="link danger" data-do="delpart">Supprimer</button></span>`}</li>`).join('')}</ul>
      ${ed.ro ? '' : `<div class="todo-act"><button type="button" class="btn small" data-do="addpart">Ajouter une surface</button><button type="button" class="link" data-do="movetag">Déplacer le numéro</button><button type="button" class="link" data-do="rename">Changer le numéro</button><button type="button" class="link danger" data-do="dellot">Retirer du niveau</button></div>`}`;
  }

  // Actions du panneau
  $('#ed-panel').addEventListener('input', e => { if (e.target.id === 'ed-lot-q') { ed.lotQ = e.target.value; const pos = e.target.selectionStart; renderPanel(); const i = $('#ed-lot-q'); i.focus(); i.setSelectionRange(pos, pos); } });
  $('#ed-panel').addEventListener('click', e => {
    if (!ed) return;
    const b = e.target.closest('[data-do]'), row = e.target.closest('[data-level]');
    if (!b) {
      const go = e.target.closest('[data-go]');
      if (!go) return;
      if (go.dataset.level && go.dataset.level !== ed.level) { ed.level = go.dataset.level; renderLevels(); draw(true); }
      const k = go.dataset.go;
      const sel = k === 'orphan' ? { kind: 'orphan', id: go.dataset.id } : k === 'pending' ? { kind: 'pending', lot: go.dataset.lot } : { kind: 'lot', lot: go.dataset.lot, part: null };
      if (k === 'auto') { ed.sel = { kind: 'lot', lot: go.dataset.lot, part: null }; draw(); const lot = lotOn(L(), go.dataset.lot); zoom.focus(P.bounds(lot.auto[+go.dataset.i].parts), 2); renderPanel(); return; }
      ed.sel = sel;
      if (ed.panel !== 'check') ed.panel = 'item';  // depuis « Lots » ou « Contrôles » : on ouvre la fiche
      draw(); focusItem(sel); renderPanel(); return;
    }
    if (ed.ro) return;
    const lvId = row ? row.dataset.level : ed.level, lv = ed.plan.levels.find(x => x.id === lvId);
    if (lvId !== ed.level) { ed.level = lvId; renderLevels(); draw(true); }
    const act = b.dataset.do, s = ed.sel;
    const orphanId = row && row.dataset.id, o = orphanId ? lv.orphans.find(x => x.id === orphanId) : null;
    const attachOrphan = num => {
      change(`Surface rattachée au lot ${num}`, () => { addParts(lv, num, o.parts); lv.orphans = lv.orphans.filter(x => x !== o); });
      ed.sel = { kind: 'lot', lot: num, part: null }; ed.panel = 'check'; renderPanel();
    };
    if (act === 'attach' && o) return attachOrphan(b.dataset.lot);
    if (act === 'pick' && o) {
      const num = (prompt('Numéro du lot auquel rattacher cette surface :') || '').trim();
      if (!num) return; if (!LOT_RE.test(num)) return toast('Numéro invalide.');
      const ref = ed.plan.ref || {};
      if (Object.keys(ref).length && !ref[num] && !confirm(`Le lot ${num} n’est pas dans le listing. Rattacher quand même ?`)) return;
      return attachOrphan(num);
    }
    if (act === 'common' && o) return change('Surface marquée « partie commune »', () => { (lv.halls = lv.halls || []).push({ parts: o.parts, label: '', tag: o.tag }); lv.orphans = lv.orphans.filter(x => x !== o); ed.sel = null; });
    if (act === 'drop' && o) return change('Surface supprimée', () => { lv.orphans = lv.orphans.filter(x => x !== o); ed.sel = null; });
    if (act === 'drawfor') { const num = row.dataset.lot; ed.sel = { kind: 'pending', lot: num }; setMode('draw', { lot: num }); focusItem(ed.sel); return; }
    if (act === 'droppending') { const num = row.dataset.lot; if (!confirm(`Retirer le numéro ${num} de ce niveau ?`)) return; return change(`Numéro ${num} retiré`, () => { lv.pending = lv.pending.filter(x => x.lot !== num); ed.sel = null; }); }
    if (act === 'okauto' || act === 'undoauto') {
      const lot = lotOn(lv, row.dataset.lot), i = +row.dataset.i, a = lot.auto[i];
      if (act === 'okauto') return change(`Rattachement au lot ${lot.lot} confirmé`, () => { lot.auto.splice(i, 1); if (!lot.auto.length) delete lot.auto; });
      // Détacher : on retire la surface du lot et elle redevient « à vérifier »
      return change(`Surface détachée du lot ${lot.lot}`, () => {
        // Le convertisseur garde chaque morceau automatique comme une surface à part : on la retire telle quelle
        const same = poly => a.parts.some(ap => JSON.stringify(ap) === JSON.stringify(poly));
        lot.parts = lot.parts.filter(poly => !same(poly));
        lot.auto.splice(i, 1); if (!lot.auto.length) delete lot.auto;
        (lv.orphans = lv.orphans || []).push({ id: lv.id + '-d' + Date.now(), parts: a.parts, area: a.area, tag: a.parts[0][0][0], candidats: [lot.lot], suggestions: [] });
      });
    }
    // Actions sur le lot sélectionné
    const lot = s && s.kind === 'lot' ? lotOn(L(), s.lot) : null;
    const partIdx = e.target.closest('[data-part]') ? +e.target.closest('[data-part]').dataset.part : s && s.part;
    if (act === 'part') { ed.sel = { ...s, part: partIdx }; draw(); focusItem(ed.sel); renderPanel(); return; }
    if (act === 'shape') { ed.sel = { ...s, part: partIdx }; setMode('shape'); focusItem(ed.sel); renderPanel(); return; }
    if (act === 'movetag') { setMode('tag'); return; }
    if (act === 'addpart' && lot) { setMode('draw', { lot: lot.lot }); return; }
    if (act === 'detach' && lot) return change(`Surface détachée du lot ${lot.lot}`, () => {
      const [poly] = lot.parts.splice(partIdx, 1);
      (L().orphans = L().orphans || []).push({ id: L().id + '-d' + Date.now(), parts: [poly], area: Math.round(P.areaM2([poly], scaleOf(L())) * 100) / 100, tag: poly[0][0], candidats: [lot.lot], suggestions: [] });
      if (!lot.parts.length) { L().lots = L().lots.filter(x => x !== lot); ed.sel = null; } else ed.sel = { ...s, part: null };
    });
    if (act === 'delpart' && lot) {
      if (!confirm('Supprimer cette surface du lot ?')) return;
      return change(`Surface supprimée du lot ${lot.lot}`, () => { lot.parts.splice(partIdx, 1); if (!lot.parts.length) { L().lots = L().lots.filter(x => x !== lot); ed.sel = null; } else ed.sel = { ...s, part: null }; });
    }
    if (act === 'dellot' && lot) {
      const warn = ed.lotsWithData.has(lot.lot) && !ed.plan.levels.some(x => x !== L() && lotOn(x, lot.lot)) ? '\n\nAttention : ce lot a déjà des informations (occupation, DPE, commentaires) et ne figurerait plus sur aucun niveau.' : '';
      if (!confirm(`Retirer le lot ${lot.lot} de ce niveau ?${warn}`)) return;
      return change(`Lot ${lot.lot} retiré du niveau`, () => { L().lots = L().lots.filter(x => x !== lot); ed.sel = null; });
    }
    if (act === 'rename' && lot) {
      const num = (prompt(`Nouveau numéro pour le lot ${lot.lot} :`, lot.lot) || '').trim();
      if (!num || num === lot.lot) return; if (!LOT_RE.test(num)) return toast('Numéro invalide.');
      const existing = lotOn(L(), num);
      if (existing && !confirm(`Le lot ${num} existe déjà sur ce niveau : fusionner les deux ?`)) return;
      return change(`Lot ${lot.lot} renuméroté en ${num}`, () => {
        if (existing) { existing.parts.push(...lot.parts); L().lots = L().lots.filter(x => x !== lot); }
        else { lot.lot = num; L().lots.sort((a, b) => natural(a.lot, b.lot)); }
        ed.sel = { kind: 'lot', lot: num, part: null };
      });
    }
  });

  // Barre d'outils
  $('#ed-shape').addEventListener('click', () => { if (ed) setMode(ed.mode === 'shape' ? 'select' : 'shape'); renderPanel(); });
  $('#ed-draw').addEventListener('click', () => { if (ed) setMode(ed.mode === 'draw' ? 'select' : 'draw', ed.sel && ed.sel.kind === 'lot' ? { lot: ed.sel.lot } : ed.sel && ed.sel.kind === 'pending' ? { lot: ed.sel.lot } : null); renderPanel(); });
  $$('[data-ezoom]').forEach(b => b.addEventListener('click', () => { if (!zoom) return; const z = b.dataset.ezoom; if (z === 'fit') zoom.fit(); else zoom.zoom(z === 'in' ? 1.6 : 1 / 1.6); }));

  /* ---------- publication ---------- */
  $('#ed-publish').addEventListener('click', async () => {
    if (!ed || ed.ro) return;
    await save();
    if (ed.dirty) return toast('Enregistrement impossible : la version n’a pas été publiée.');
    const c = checks();
    const lines = [];
    if (c.todo) lines.push(`• ${c.todo} élément(s) encore à vérifier`);
    if (c.missing.length) lines.push(`• ${c.missing.length} lot(s) du listing absents du plan`);
    if (c.unknown.length) lines.push(`• ${c.unknown.length} lot(s) du plan absents du listing`);
    if (c.lost.length) lines.push(`• ${c.lost.length} lot(s) déjà suivis absents du plan : ${c.lost.join(', ')}`);
    const msg = 'Publier cette version ? Elle remplacera le plan affiché pour tout le monde (l’actuelle sera archivée et restera récupérable).' + (lines.length ? '\n\nPoints restants :\n' + lines.join('\n') : '\n\nTous les contrôles sont au vert.');
    if (!confirm(msg)) return;
    try {
      await api('POST', `/api/plans/${ed.id}/publier`, { confirmer: c.lost.length > 0 });
      needReload = true;
      toast('Version publiée : le plan est à jour pour tout le monde.');
      showList();
    } catch (x) {
      if (x.data && x.data.lotsPerdus) {
        if (!confirm(`Ces lots ont des informations et ne figurent pas sur cette version : ${x.data.lotsPerdus.join(', ')}.\nPublier quand même ? (leurs informations restent en base)`)) return;
        await api('POST', `/api/plans/${ed.id}/publier`, { confirmer: true }); needReload = true; toast('Version publiée.'); showList();
      } else toast(x.message);
    }
  });

  /* ---------- ouverture ---------- */
  $('#plans-btn').addEventListener('click', openAdmin);
  $('#admin-close').addEventListener('click', closeAdmin);
  window.PVAdmin = { open: openAdmin };
})();
