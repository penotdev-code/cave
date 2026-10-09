'use strict';
/* Plan Vivant — rendu des plans issus du DWG (format « plan-vivant/2 ») et zoom/déplacement.
   Utilisé par la vue principale (app.js) et par l'onglet de gestion des plans (plans-admin.js).
   Exposé en window.PVPlan. */

const PVPlan = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (n, a = {}, p) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); if (p) p.appendChild(e); return e; };
  const r1 = v => Math.round(v * 10) / 10;

  /* ---------- géométrie ---------- */
  // parts = [[contour, trou, trou…], …] ; un tracé SVG en règle pair-impair
  const partsD = parts => parts.map(poly => poly.map(r => 'M' + r.map(p => r1(p[0]) + ' ' + r1(p[1])).join('L') + 'Z').join('')).join('');
  const polyD = poly => 'M' + poly.map(p => p.join(' ')).join('L') + 'Z';
  const shapeD = g => g.parts ? partsD(g.parts) : polyD(g.poly);
  const isV2 = L => !!(L.bg || (L.lots[0] && L.lots[0].parts));
  function ringArea(r) { let a = 0; for (let i = 0; i < r.length; i++) { const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length]; a += x1 * y2 - x2 * y1; } return a / 2; }
  // Surface en m² (contours moins trous)
  const areaM2 = (parts, scale) => parts.reduce((t, poly) => t + Math.abs(ringArea(poly[0])) - poly.slice(1).reduce((h, r) => h + Math.abs(ringArea(r)), 0), 0) / (scale * scale);
  function pointInRing(p, r) {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if ((r[i][1] > p[1]) !== (r[j][1] > p[1]) && p[0] < (r[j][0] - r[i][0]) * (p[1] - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
    }
    return c;
  }
  const pointInParts = (p, parts) => parts.some(poly => pointInRing(p, poly[0]) && !poly.slice(1).some(h => pointInRing(p, h)));
  function bounds(parts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const poly of parts) for (const [x, y] of poly[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0, y0, x1, y1];
  }

  /* ---------- fond de plan et textes ---------- */
  const BG_ORDER = ['poche', 'details', 'escaliers', 'embrasures', 'fenetres', 'portes', 'murs'];
  function background(svg, L) {
    const g = el('g', { class: 'bg', 'pointer-events': 'none' }, svg);
    for (const k of BG_ORDER) if (L.bg && L.bg[k]) el('path', { d: L.bg[k], class: 'bg-' + k }, g);
    return g;
  }
  function texts(svg, L, { rooms = true } = {}) {
    const g = el('g', { class: 'txt', 'pointer-events': 'none' }, svg);
    for (const t of L.texts || []) {
      const [x, y, s, size, rot, kind] = t;
      if (kind === 'piece' && !rooms) continue;
      const e = el('text', { x, y, 'text-anchor': 'middle', 'dominant-baseline': 'central', class: kind === 'repere' ? 'p-label' : 'p-room' }, g);
      if (size) e.style.fontSize = size + 'px';
      if (rot) e.setAttribute('transform', `rotate(${rot} ${x} ${y})`);
      e.textContent = s;
    }
    return g;
  }

  /* ---------- zoom et déplacement ---------- */
  // Molette (autour du pointeur), glisser pour déplacer, pincer à deux doigts.
  // onView(upp) : unités de plan par pixel écran, pour garder les étiquettes lisibles.
  function zoomable(svg, { onView } = {}) {
    let full = [0, 0, 100, 100], vb = full.slice();
    const pointers = new Map();
    let pan = null, pinch = null, moved = false;
    const box = () => svg.getBoundingClientRect();
    // Le SVG garde ses proportions (meet) : unités par pixel = max des deux axes
    const upp = () => { const b = box(); return Math.max(vb[2] / (b.width || 1), vb[3] / (b.height || 1)); };
    function apply() {
      svg.setAttribute('viewBox', vb.map(r1).join(' '));
      onView && onView(upp());
    }
    function toPlan(cx, cy) {
      const b = box(), u = upp();
      const ox = vb[0] + (vb[2] - b.width * u) / 2, oy = vb[1] + (vb[3] - b.height * u) / 2;
      return [ox + (cx - b.left) * u, oy + (cy - b.top) * u];
    }
    function zoomAt(f, cx, cy) {
      const [px, py] = cx == null ? [vb[0] + vb[2] / 2, vb[1] + vb[3] / 2] : toPlan(cx, cy);
      const w = Math.min(full[2] * 1.5, Math.max(full[2] / 60, vb[2] / f)), h = w * vb[3] / vb[2];
      vb = [px - (px - vb[0]) * w / vb[2], py - (py - vb[1]) * h / vb[3], w, h];
      apply();
    }
    svg.addEventListener('wheel', e => { e.preventDefault(); zoomAt(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015)), e.clientX, e.clientY); }, { passive: false });
    svg.addEventListener('pointerdown', e => {
      if (e.button > 0) return;
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      moved = false;
      if (pointers.size === 1) pan = { x: e.clientX, y: e.clientY, vb: vb.slice() };
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), vb: vb.slice() }; pan = null; }
    });
    svg.addEventListener('pointermove', e => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        vb = pinch.vb.slice(); zoomAt(d / pinch.d, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2); moved = true; return;
      }
      if (!pan || svg.dataset.drawing) return;
      const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      if (!moved) svg.setPointerCapture(e.pointerId);
      moved = true;
      const u = upp();
      vb = [pan.vb[0] - dx * u, pan.vb[1] - dy * u, vb[2], vb[3]];
      apply();
    });
    const end = e => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; if (!pointers.size) pan = null; };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    // Un « clic » qui était en fait un déplacement ne doit pas sélectionner un lot
    svg.addEventListener('click', e => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
    new ResizeObserver(() => onView && onView(upp())).observe(svg);
    return {
      reset(v) { full = v.slice(); vb = v.slice(); apply(); },
      fit() { vb = full.slice(); apply(); },
      zoom(f) { zoomAt(f); },
      focus([x0, y0, x1, y1], pad = 0.6) {
        const w = Math.max(x1 - x0, full[2] / 25) * (1 + pad * 2), h = Math.max(y1 - y0, full[3] / 25) * (1 + pad * 2);
        const k = Math.max(w / full[2], h / full[3]);
        vb = [(x0 + x1) / 2 - full[2] * k / 2, (y0 + y1) / 2 - full[3] * k / 2, full[2] * k, full[3] * k];
        apply();
      },
      toPlan, upp, get view() { return vb.slice(); },
    };
  }

  // Étiquettes lisibles quel que soit le zoom : au moins `px` pixels à l'écran
  function labelScale(upp, base, px) { return Math.max(1, (px * upp) / base); }

  return { el, partsD, shapeD, isV2, areaM2, pointInParts, pointInRing, bounds, ringArea, background, texts, zoomable, labelScale };
})();
window.PVPlan = PVPlan;
