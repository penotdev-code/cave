'use strict';
/* Plan Vivant — interface : le plan à gauche, le tableau à droite, toujours synchronisés.
   La source des données (serveur ou démo) est un « backend » passé à PV.start(). */

const PV = (() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const NS = 'http://www.w3.org/2000/svg';
  const el = (n, a = {}, p) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); if (p) p.appendChild(e); return e; };
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const m2 = n => n == null ? '' : n.toFixed(1).replace('.', ',');
  const pad = n => String(n).padStart(2, '0');
  const fmtDate = iso => iso ? iso.slice(0, 10).split('-').reverse().join('/') : '';
  const fmtStamp = iso => { if (!iso) return ''; const d = new Date(iso); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} à ${pad(d.getHours())}h${pad(d.getMinutes())}`; };
  let toastT;
  const toast = msg => { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3500); };

  /* ---------- vocabulaire ---------- */
  const OCC = { loue: 'Loué', vacant: 'Vacant', preavis: 'Préavis', nr: 'À renseigner' };
  const OCCV = { loue: 'var(--st-loue)', vacant: 'var(--st-vacant)', preavis: 'var(--st-preavis)', nr: 'var(--st-nr)' };
  const DPE = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const DPEV = { A: 'var(--dpe-a)', B: 'var(--dpe-b)', C: 'var(--dpe-c)', D: 'var(--dpe-d)', E: 'var(--dpe-e)', F: 'var(--dpe-f)', G: 'var(--dpe-g)', '': 'var(--dpe-none)' };
  const EMPTY = { occ: 'nr', travaux: false, fin: '', dpe: '', dpeDate: '' };
  const isLogement = l => /^T\d/.test(l.type);
  function alerts(l, s) {
    const a = [];
    if (!isLogement(l)) return a;
    if (!s.dpe) a.push('DPE manquant (obligatoire pour louer)');
    if (s.dpe === 'G') a.push('Classe G : location interdite depuis 2025');
    if (s.dpe === 'F') a.push('Classe F : location interdite en 2028');
    if (s.dpe && s.dpeDate && s.dpeDate < '2021-07-01') a.push('DPE de plus de 10 ans ou d’avant juillet 2021 : à refaire');
    return a;
  }

  function start(B) {
    const PLAN = B.plan;
    const LEVELS = PLAN.levels;
    const LOTS = [];
    LEVELS.forEach(L => L.lots.forEach(g => {
      const ref = PLAN.ref[g.lot] || { type: '', locaux: [] };
      const surf = ref.locaux.reduce((t, x) => t + (x[2] || 0), 0);
      LOTS.push({ id: g.lot, level: L, geo: g, type: ref.type, locaux: ref.locaux, surf: ref.locaux.length && surf ? surf : null,
        niveaux: ref.locaux.length ? [...new Set(ref.locaux.map(x => x[1]))].join(', ') : L.name });
    }));
    const byId = Object.fromEntries(LOTS.map(l => [l.id, l]));

    const S = { level: LEVELS[0], color: 'occ', filter: null, all: false, sel: null, open: null, drafts: {},
      lots: {}, comments: [], journal: [], canWrite: B.canWrite, canInternal: B.canInternal };
    const T = id => ({ ...EMPTY, ...(S.lots[id] || {}) });
    const cmts = id => S.comments.filter(c => c.lot === id);

    $('#building').textContent = PLAN.immeuble || '';
    $('#who').textContent = B.me ? B.me.name + (S.canWrite ? '' : ' · consultation') : '';
    $('#logout').hidden = !B.logout;
    $('#history-btn').hidden = !S.canInternal;
    $('#hint').textContent = S.canWrite
      ? 'Cliquez un lot sur le plan ou une ligne du tableau. Modifiez directement dans le tableau : tout est enregistré aussitôt.'
      : 'Cliquez un lot sur le plan ou une ligne du tableau pour le retrouver de l’autre côté. Accès en consultation.';

    /* ===================== PLAN ===================== */
    const svg = $('#plan');
    function drawLevel() {
      const L = S.level;
      svg.innerHTML = '';
      svg.setAttribute('viewBox', L.vb.join(' '));
      svg.setAttribute('aria-label', 'Plan · ' + L.name);
      const defs = el('defs', {}, svg);
      const p = el('pattern', { id: 'hatch', width: 12, height: 12, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
      el('rect', { width: 4, height: 12, fill: 'var(--signal)', opacity: .75 }, p);
      L.texts.forEach(([x, y, t]) => { const e = el('text', { x, y, 'text-anchor': 'middle', class: 'p-label' }, svg); e.textContent = t; });
      L.halls.forEach(h => {
        el('polygon', { points: h.poly.join(' '), class: 'p-hall' }, svg);
        const xs = h.poly.map(q => q[0]), ys = h.poly.map(q => q[1]);
        const t = el('text', { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 + 4, 'text-anchor': 'middle', class: 'p-room' }, svg); t.textContent = h.label;
      });
      L.lots.forEach(g => {
        const l = byId[g.lot];
        const G = el('g', { class: 'lot', tabindex: 0, role: 'button', 'aria-label': 'Lot ' + g.lot, 'data-lot': g.lot }, svg);
        const pts = g.poly.join(' ');
        l.base = el('polygon', { class: 'base', points: pts }, G);
        l.hatch = el('polygon', { points: pts, fill: 'url(#hatch)', 'pointer-events': 'none' }, G);
        g.walls.forEach(w => el('line', { x1: w[0], y1: w[1], x2: w[2], y2: w[3], class: 'p-wall' }, G));
        g.rooms.forEach(([x, y, n]) => { const t = el('text', { x, y, 'text-anchor': 'middle', class: 'p-room' }, G); t.textContent = n; });
        el('polygon', { class: 'outline', points: pts }, G);
        const [tx, ty] = g.tag, r = g.lot.length > 3 ? 27 : 23;
        el('circle', { cx: tx, cy: ty, r, class: 'p-tag' }, G);
        const lt = el('text', { x: tx, y: ty + 6, 'text-anchor': 'middle', class: 'p-num' }, G); lt.textContent = g.lot;
        if (g.extra) { const e = el('text', { x: tx, y: ty + r + 18, 'text-anchor': 'middle', class: 'p-extra' }, G); e.textContent = g.extra; }
        l.badge = el('g', { transform: `translate(${tx + r + 4} ${ty - r - 2})`, 'pointer-events': 'none' }, G);
        el('circle', { r: 11, class: 'p-badge' }, l.badge);
        l.badgeT = el('text', { y: 4.5, 'text-anchor': 'middle', class: 'p-badge-t' }, l.badge);
        l.warn = el('g', { transform: `translate(${tx - r - 4} ${ty - r - 2})`, 'pointer-events': 'none' }, G);
        el('path', { d: 'M0 -12 L12 9 L-12 9 Z', class: 'p-warn' }, l.warn);
        const wt = el('text', { y: 6, 'text-anchor': 'middle', class: 'p-warn-t' }, l.warn); wt.textContent = '!';
        G.addEventListener('click', () => select(l, 'plan'));
        G.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(l, 'plan'); } });
        G.addEventListener('mouseenter', () => hover(l.id, true));
        G.addEventListener('mouseleave', () => hover(l.id, false));
      });
      $$('#levels button').forEach(b => b.setAttribute('aria-pressed', b.dataset.level === L.id));
    }
    const matches = l => {
      if (!S.filter) return true;
      const s = T(l.id);
      if (S.filter === 'travaux') return s.travaux;
      if (S.filter === 'alertes') return alerts(l, s).length > 0;
      if (S.filter.startsWith('dpe:')) return s.dpe === S.filter.slice(4);
      return s.occ === S.filter;
    };
    function paintPlan() {
      S.level.lots.forEach(g => {
        const l = byId[g.lot], s = T(l.id);
        l.base.setAttribute('fill', S.color === 'occ' ? OCCV[s.occ] : DPEV[s.dpe]);
        l.hatch.style.display = s.travaux ? '' : 'none';
        const n = cmts(l.id).length;
        l.badge.style.display = n ? '' : 'none'; l.badgeT.textContent = n;
        l.warn.style.display = alerts(l, s).length ? '' : 'none';
        const G = l.base.parentNode;
        G.classList.toggle('is-sel', S.sel === l);
        G.classList.toggle('dim', !matches(l));
      });
    }

    /* ===================== LÉGENDE = FILTRES ===================== */
    function renderLegend() {
      const pool = S.all ? LOTS : LOTS.filter(l => l.level === S.level);
      const count = f => pool.filter(l => { const s = T(l.id); return f(l, s); }).length;
      let chips;
      if (S.color === 'occ') chips = Object.keys(OCC).map(k => [k, OCC[k], `<span class="sw" style="background:${OCCV[k]}"></span>`, count((l, s) => s.occ === k)]);
      else chips = DPE.concat('').map(k => ['dpe:' + k, k || 'Sans DPE', `<span class="sw" style="background:${DPEV[k]}"></span>`, count((l, s) => s.dpe === k)]);
      chips.push(['travaux', 'En travaux', '<span class="sw sw-hatch"></span>', count((l, s) => s.travaux)]);
      chips.push(['alertes', 'Alertes', '<span class="sw-warn">!</span>', count((l, s) => alerts(l, s).length > 0)]);
      $('#legend').innerHTML = chips.filter(c => c[3] || S.filter === c[0]).map(([k, lab, sw, n]) =>
        `<button type="button" class="chip" data-f="${esc(k)}" aria-pressed="${S.filter === k}">${sw}${esc(lab)} <b>${n}</b></button>`).join('')
        + (S.filter ? '<button type="button" class="chip clear" data-f="">Tout afficher ✕</button>' : '');
      $$('#legend .chip').forEach(b => b.addEventListener('click', () => { S.filter = b.dataset.f && S.filter !== b.dataset.f ? b.dataset.f : null; refresh(); }));
    }

    /* ===================== TABLEAU ===================== */
    const tbody = $('#tbody');
    const ro = () => !S.canWrite;
    function rowHtml(l) {
      const s = T(l.id), al = alerts(l, s), n = cmts(l.id).length, last = cmts(l.id).slice(-1)[0];
      const occCell = ro() ? `<span class="pill" style="background:${OCCV[s.occ]}">${OCC[s.occ]}</span>`
        : `<select class="in-occ" data-k="occ" aria-label="Occupation du lot ${l.id}" style="background:${OCCV[s.occ]}">${Object.entries(OCC).map(([k, v]) => `<option value="${k}" ${k === s.occ ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
      const trvCell = ro() ? (s.travaux ? `Oui${s.fin ? ' · ' + esc(s.fin) : ''}` : '<span class="muted">—</span>')
        : `<label class="trv"><input type="checkbox" data-k="travaux" ${s.travaux ? 'checked' : ''} aria-label="Travaux en cours, lot ${l.id}"></label>${s.travaux ? `<input type="text" class="in-fin" data-k="fin" value="${esc(s.fin)}" placeholder="fin prévue" aria-label="Fin prévue des travaux">` : ''}`;
      const dpeCell = ro() ? `<span class="dpe ${s.dpe === 'G' ? 'g' : ''}" style="background:${DPEV[s.dpe]}">${s.dpe || '—'}</span>`
        : `<select class="in-dpe ${s.dpe === 'G' ? 'g' : ''}" data-k="dpe" aria-label="Classe DPE du lot ${l.id}" style="background:${DPEV[s.dpe]}"><option value="">—</option>${DPE.map(k => `<option ${k === s.dpe ? 'selected' : ''}>${k}</option>`).join('')}</select>`;
      const dateCell = ro() || !s.dpe ? (fmtDate(s.dpeDate) ? `<span class="muted">${fmtDate(s.dpeDate)}</span>` : '') : `<input type="date" data-k="dpeDate" value="${esc(s.dpeDate)}" aria-label="Date du DPE">`;
      return `<tr class="row ${S.sel === l ? 'is-sel' : ''}" data-lot="${l.id}">
        <th scope="row"><span class="num">${l.id}</span>${al.length ? `<span class="warn" title="${esc(al.join(' · '))}">!</span>` : ''}<span class="sub">${[l.type, l.surf ? m2(l.surf) + ' m²' : ''].filter(Boolean).join(' · ') || '&nbsp;'}</span></th>
        ${S.all ? `<td>${esc(l.level.name)}</td>` : ''}
        <td>${occCell}</td><td class="c-trv">${trvCell}</td><td><span class="c-dpe">${dpeCell}${dateCell}</span></td>
        <td><button type="button" class="cm ${S.open === l.id ? 'open' : ''}" data-act="cm" aria-expanded="${S.open === l.id}">
          <span class="bubble ${n ? 'on' : ''}">${n || '+'}</span><span class="cm-last">${last ? esc(last.txt) : (S.canWrite ? 'Ajouter' : '')}</span></button></td>
      </tr>${S.open === l.id ? detailHtml(l) : ''}`;
    }
    function detailHtml(l) {
      const list = cmts(l.id), d = S.drafts[l.id] || { txt: '', vis: S.canInternal ? 'int' : 'sh' };
      return `<tr class="detail" data-lot="${l.id}"><td colspan="${S.all ? 6 : 5}"><div class="thread">
        ${l.locaux.length ? `<p class="ids">${l.locaux.map(x => `${esc(x[0])} <span class="muted">(${esc(x[1])}${x[2] != null ? ', ' + m2(x[2]) + ' m²' : ''})</span>`).join(' · ')}</p>` : ''}
        ${list.length ? list.map(c => `<div class="msg"><div class="meta"><b>${esc(c.auteur || 'Quelqu’un')}</b> · ${fmtStamp(c.at)}${c.vis === 'int' ? ' · <span class="tag-int">interne</span>' : ''}</div>${esc(c.txt)}</div>`).join('') : '<p class="muted">Pas encore de commentaire.</p>'}
        ${S.canWrite ? `<div class="compose">
          <textarea data-k="draft" rows="2" placeholder="Écrire un commentaire sur le lot ${l.id}…" aria-label="Nouveau commentaire">${esc(d.txt)}</textarea>
          <div class="compose-bar">
            ${S.canInternal ? `<div class="seg small" role="group" aria-label="Visible par"><button type="button" data-vis="int" aria-pressed="${d.vis === 'int'}">Équipe seulement</button><button type="button" data-vis="sh" aria-pressed="${d.vis === 'sh'}">Visible par les partenaires</button></div>` : '<span></span>'}
            <button type="button" class="btn" data-act="send">Ajouter</button>
          </div></div>` : ''}
      </div></td></tr>`;
    }
    function lotsShown() { return (S.all ? LOTS : LOTS.filter(l => l.level === S.level)).filter(matches).sort((a, b) => (S.all ? LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) : 0) || a.id - b.id); }
    function renderTable() {
      $('#col-level').hidden = !S.all;
      const act = document.activeElement, keep = act && tbody.contains(act) && act.closest('tr');
      // si l'on est en train d'écrire dans une ligne, on ne la redessine pas
      if (keep && (act.tagName === 'TEXTAREA' || act.type === 'text' || act.type === 'date')) {
        $$('tr.row', tbody).forEach(tr => { if (tr !== keep && !tr.contains(act)) { const l = byId[tr.dataset.lot]; if (l) tr.classList.toggle('is-sel', S.sel === l); } });
        return;
      }
      const rows = lotsShown();
      tbody.innerHTML = rows.map(rowHtml).join('') || `<tr><td colspan="8" class="muted empty">Aucun lot ne correspond. <button type="button" class="link" data-act="clear">Tout afficher</button></td></tr>`;
      $('#count').textContent = `${rows.length} lot${rows.length > 1 ? 's' : ''}`;
    }

    // délégation d'événements sur le tableau
    tbody.addEventListener('change', e => {
      const t = e.target, tr = t.closest('tr'), k = t.dataset.k; if (!tr || !k || k === 'draft') return;
      const l = byId[tr.dataset.lot], s = T(l.id);
      const next = { ...s, [k]: t.type === 'checkbox' ? t.checked : t.value.trim() };
      if (k === 'travaux' && !t.checked) next.fin = '';
      save(l, next);
      if (k === 'travaux' && t.checked) setTimeout(() => $(`tr.row[data-lot="${l.id}"] .in-fin`)?.focus(), 0);
    });
    tbody.addEventListener('input', e => { const t = e.target; if (t.dataset.k === 'draft') { const id = t.closest('tr').dataset.lot; S.drafts[id] = { ...(S.drafts[id] || { vis: S.canInternal ? 'int' : 'sh' }), txt: t.value }; } });
    tbody.addEventListener('click', e => {
      const t = e.target, tr = t.closest('tr'); if (!tr) return;
      if (t.closest('[data-act="clear"]')) { S.filter = null; refresh(); return; }
      const l = byId[tr.dataset.lot]; if (!l) return;
      const vis = t.closest('[data-vis]');
      if (vis) { S.drafts[l.id] = { ...(S.drafts[l.id] || { txt: '' }), vis: vis.dataset.vis }; $$('[data-vis]', tr).forEach(b => b.setAttribute('aria-pressed', b === vis)); return; }
      if (t.closest('[data-act="send"]')) { send(l); return; }
      if (t.closest('[data-act="cm"]')) { S.open = S.open === l.id ? null : l.id; select(l, 'table'); if (S.open) setTimeout(() => $(`tr.detail[data-lot="${l.id}"] textarea`)?.focus(), 0); return; }
      if (tr.classList.contains('row') && !t.closest('select,input,label,button')) select(l, 'table');
    });
    tbody.addEventListener('focusin', e => { const tr = e.target.closest('tr.row'); if (tr && S.sel !== byId[tr.dataset.lot]) { S.sel = byId[tr.dataset.lot]; paintPlan(); $$('tr.row', tbody).forEach(r => r.classList.toggle('is-sel', r === tr)); } });
    tbody.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.dataset.k === 'draft') send(byId[e.target.closest('tr').dataset.lot]); });
    tbody.addEventListener('mouseover', e => { const tr = e.target.closest('tr'); if (tr) hover(tr.dataset.lot, true); });
    tbody.addEventListener('mouseout', e => { const tr = e.target.closest('tr'); if (tr && !tr.contains(e.relatedTarget)) hover(tr.dataset.lot, false); });

    function hover(id, on) {
      const l = byId[id]; if (!l) return;
      if (l.base && l.level === S.level) l.base.parentNode.classList.toggle('hover', on);
      $$(`#tbody tr[data-lot="${id}"]`).forEach(tr => tr.classList.toggle('hover', on));
    }
    function select(l, from) {
      if (!l) return;
      S.sel = l;
      if (l.level !== S.level && !S.all) { S.level = l.level; drawLevel(); }
      else if (l.level !== S.level) { S.level = l.level; drawLevel(); }
      if (!matches(l)) S.filter = null;
      refresh();
      const tr = $(`#tbody tr.row[data-lot="${l.id}"]`);
      if (tr && from !== 'table') {
        tr.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        tr.classList.remove('flash'); void tr.offsetWidth; tr.classList.add('flash');
        if (innerWidth < 1100) $('#table-pane').scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
      if (from === 'table' && innerWidth < 1100) $('#plan-pane').scrollIntoView({ block: 'start', behavior: 'smooth' });
    }

    /* ===================== ÉCRITURES ===================== */
    const setSync = (s, txt) => { const e = $('#sync'); e.dataset.s = s; e.textContent = txt; };
    let chain = Promise.resolve();
    const queue = fn => (chain = chain.then(fn, fn));
    function save(l, next) {
      const body = { occ: next.occ, travaux: !!next.travaux, fin: next.travaux ? next.fin || '' : '', dpe: next.dpe || '', dpeDate: next.dpeDate || '' };
      S.lots[l.id] = { ...(S.lots[l.id] || {}), ...body, maj: new Date().toISOString() };
      refresh();
      queue(async () => {
        setSync('busy', 'Enregistrement…');
        try { await B.saveLot(l.id, body); setSync('ok', 'Enregistré'); } catch (e) { onError(e); }
      });
    }
    function send(l) {
      const d = S.drafts[l.id] || {}, txt = (d.txt || '').trim();
      if (!txt) { $(`tr.detail[data-lot="${l.id}"] textarea`)?.focus(); return; }
      const vis = S.canInternal ? (d.vis || 'int') : 'sh';
      S.comments.push({ lot: l.id, txt, vis, at: new Date().toISOString(), auteur: B.me ? B.me.name : 'Vous' });
      S.drafts[l.id] = { txt: '', vis };
      document.activeElement?.blur();
      refresh();
      queue(async () => {
        setSync('busy', 'Enregistrement…');
        try { await B.addComment(l.id, txt, vis); setSync('ok', 'Enregistré'); } catch (e) { S.drafts[l.id] = { txt, vis }; onError(e); }
      });
    }
    function onError(e) {
      if (e && e.readOnly) { S.canWrite = S.canInternal = false; toast('Votre accès est en consultation : la modification n’a pas été enregistrée.'); refresh(); setSync('ro', 'Consultation'); return; }
      setSync('err', 'Non enregistré');
      toast((e && e.message) || 'La modification n’a pas pu être enregistrée. Vérifiez la connexion puis réessayez.');
      B.reload && B.reload();
    }

    /* ===================== EXPORT EXCEL ===================== */
    function buildWorkbook() {
      const lotsRows = LOTS.slice().sort((a, b) => a.id - b.id).map(l => {
        const s = T(l.id), tr = S.lots[l.id] || {};
        return { 'N° lot': +l.id, 'Locaux (identifiants)': l.locaux.map(x => x[0]).join(' | '), 'Niveaux': l.niveaux, 'Type': l.type, 'Surface m²': l.surf ?? '',
          'Occupation': OCC[s.occ], 'Travaux': s.travaux ? 'Oui' : 'Non', 'Fin travaux prévue': s.fin, 'DPE': s.dpe, 'Date DPE': s.dpeDate ? new Date(s.dpeDate + 'T00:00:00') : '',
          'Alertes': alerts(l, s).join(' / '), 'Nb commentaires': cmts(l.id).length, 'Dernier commentaire': (cmts(l.id).slice(-1)[0] || {}).txt || '', 'Mis à jour': tr.maj ? new Date(tr.maj) : '' };
      });
      const locRows = [];
      LOTS.forEach(l => l.locaux.forEach(x => locRows.push({ 'Identifiant': x[0], 'N° lot': +l.id, 'Niveau': x[1], 'Surface m²': x[2] ?? '' })));
      const cmRows = S.comments.slice().sort((a, b) => a.lot - b.lot || (a.at || '').localeCompare(b.at || '')).map(c => ({ 'N° lot': +c.lot, 'Date': c.at ? new Date(c.at) : '', 'Auteur': c.auteur || '', 'Visible par': c.vis === 'int' ? 'Équipe' : 'Partenaires', 'Commentaire': c.txt }));
      const wb = XLSX.utils.book_new();
      const add = (rows, name, widths) => { const ws = XLSX.utils.json_to_sheet(rows, { cellDates: true, dateNF: 'dd/mm/yyyy' }); ws['!cols'] = widths.map(w => ({ wch: w })); if (rows.length) ws['!autofilter'] = { ref: ws['!ref'] }; XLSX.utils.book_append_sheet(wb, ws, name); };
      add(lotsRows, 'LOTS', [8, 34, 14, 10, 10, 14, 8, 18, 5, 11, 50, 10, 50, 12]);
      add(locRows, 'LOCAUX', [16, 8, 8, 10]);
      add(cmRows, 'COMMENTAIRES', [8, 12, 18, 12, 80]);
      if (S.canInternal) add(S.journal.map(e => ({ 'Date': e.at ? new Date(e.at) : '', 'Auteur': e.auteur || '', 'N° lot': +e.lot, 'Modification': e.txt })), 'HISTORIQUE', [12, 18, 8, 60]);
      return wb;
    }
    $('#export').addEventListener('click', async () => {
      if (!window.XLSX) { toast('Le module Excel n’a pas pu se charger. Rechargez la page.'); return; }
      const d = new Date(), name = `Plan-Vivant_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.xlsx`;
      const buf = XLSX.write(buildWorkbook(), { bookType: 'xlsx', type: 'array', cellDates: true });
      try { await B.saveFile(name, buf); } catch (e) { if (e && e.message) toast(e.message); }
    });

    /* ===================== HISTORIQUE ===================== */
    const hist = $('#history');
    function renderHistory() {
      $('#history-list').innerHTML = S.journal.length ? S.journal.map(e => `<li><span class="muted">${fmtStamp(e.at)}</span><span><b>${esc(e.auteur || 'Quelqu’un')}</b> · lot ${esc(e.lot)} · ${esc(e.txt)}</span></li>`).join('') : '<li class="muted">Aucune modification pour l’instant.</li>';
    }
    $('#history-btn').addEventListener('click', () => { renderHistory(); hist.hidden = false; $('#history-close').focus(); });
    $('#history-close').addEventListener('click', () => { hist.hidden = true; $('#history-btn').focus(); });
    hist.addEventListener('click', e => { if (e.target === hist) hist.hidden = true; });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !hist.hidden) hist.hidden = true; });

    /* ===================== CONTRÔLES ===================== */
    $('#levels').innerHTML = LEVELS.map(L => `<button type="button" data-level="${L.id}">${esc(L.name)}</button>`).join('');
    $$('#levels button').forEach(b => b.addEventListener('click', () => { S.level = LEVELS.find(L => L.id === b.dataset.level); S.open = null; drawLevel(); refresh(); }));
    $$('[data-color]').forEach(b => b.addEventListener('click', () => { S.color = b.dataset.color; S.filter = null; $$('[data-color]').forEach(o => o.setAttribute('aria-pressed', o === b)); refresh(); }));
    $('#all').addEventListener('change', e => { S.all = e.target.checked; refresh(); });
    $('#searchform').addEventListener('submit', e => {
      e.preventDefault();
      const q = $('#q').value.trim().replace(/\s/g, '').toLowerCase(); if (!q) return;
      const l = byId[q] || LOTS.find(x => q.length > 2 && x.locaux.some(y => y[0].replace(/\s/g, '').toLowerCase().includes(q)));
      if (l) { $('#q').value = ''; select(l, 'search'); } else toast(`Aucun lot « ${$('#q').value.trim()} » sur les plans.`);
    });

    function refresh() { paintPlan(); renderLegend(); renderTable(); if (!hist.hidden) renderHistory(); }

    /* ===================== DONNÉES ===================== */
    setSync(S.canWrite ? 'ok' : 'ro', S.canWrite ? 'À jour' : 'Consultation');
    drawLevel();
    B.subscribe(st => {
      S.lots = st.lots || {}; S.comments = (st.comments || []).slice().sort((a, b) => (a.at || '').localeCompare(b.at || '')); S.journal = st.journal || [];
      if (typeof st.canWrite === 'boolean') { S.canWrite = st.canWrite; S.canInternal = st.canInternal; }
      refresh();
    });
    refresh();
  }
  return { start };
})();

/* ===================== Backend « serveur » (VPS) ===================== */
(() => {
  if (window.PV_BACKEND === 'external') return;
  const $ = s => document.querySelector(s);
  async function json(method, url, body) {
    const r = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401 && url !== '/api/login') { location.reload(); throw new Error(''); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || 'Erreur du serveur.'), { status: r.status, readOnly: r.status === 403 });
    return data;
  }
  async function boot() {
    const r = await fetch('/api/state', { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) return showLogin();
    if (!r.ok) { document.body.textContent = 'Le serveur ne répond pas correctement. Réessayez dans un instant.'; return; }
    const initial = await r.json();
    const plan = await json('GET', '/plan.json');
    $('#app').hidden = false;
    let listener = () => {};
    const shape = st => ({ ...st, canWrite: st.me.role === 'gestion', canInternal: st.me.role === 'gestion' });
    const reload = async () => { try { listener(shape(await json('GET', '/api/state'))); } catch {} };
    PV.start({
      plan, me: initial.me, canWrite: initial.me.role === 'gestion', canInternal: initial.me.role === 'gestion',
      subscribe(fn) { listener = fn; fn(shape(initial)); },
      reload,
      saveLot: (id, body) => json('PUT', '/api/lots/' + encodeURIComponent(id), body),
      addComment: (lot, txt, vis) => json('POST', '/api/comments', { lot, txt, vis }),
      saveFile(name, buf) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })); a.download = name;
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      },
      logout: true,
    });
    let pend = false;
    const es = new EventSource('/api/events');
    es.addEventListener('change', () => { if (pend) return; pend = true; setTimeout(() => { pend = false; reload(); }, 200); });
    es.addEventListener('open', reload);
    $('#logout').addEventListener('click', async () => { es.close(); await fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); location.reload(); });
  }
  function showLogin() {
    $('#login').hidden = false; $('#lg-email').focus();
    $('#loginform').addEventListener('submit', async e => {
      e.preventDefault();
      const err = $('#lg-err'); err.hidden = true; $('#lg-btn').disabled = true;
      try { await json('POST', '/api/login', { email: $('#lg-email').value.trim(), password: $('#lg-pw').value }); location.reload(); return; }
      catch (x) { err.textContent = x.message || 'Connexion impossible.'; }
      err.hidden = false; $('#lg-btn').disabled = false;
    });
  }
  boot();
})();
