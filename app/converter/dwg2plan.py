#!/usr/bin/env python3
"""
Convertit le plan DWG (ou DXF) du géomètre en plan pour Plan Vivant.

    dwg2plan.py plan.dwg [--listing 30_LOCAUX.xlsx] [-o plan.json] [--rapport rapport.json]

Ce que le convertisseur lit dans le dessin :
  - les niveaux : une présentation (onglet) par niveau, avec sa fenêtre sur le modèle ;
  - le fond de plan : murs, pochage, portes, fenêtres, escaliers, détails ;
  - les noms des pièces (calque INFO_DESIGNATION) et les repères (INFO_ORIENTATION) ;
  - les lots : surfaces du calque COPRO_APLAT, numérotées par COPRO_TEXTE_NUM_LOT ;
  - les parties communes : surfaces jaunes (couleur 51) de COPRO_APLAT.

Rattachement des surfaces aux lots (fiabilité avant tout) :
  1. une hachure qui contient un numéro appartient entièrement à ce lot ;
  2. un morceau sans numéro qui touche un seul lot lui est rattaché (marqué « auto ») ;
  3. sinon il reste « à vérifier » : rien n'est deviné.

Toutes les coordonnées sont en unités de plan : 1 m = SCALE unités, axe y vers le bas.
"""
import argparse, json, math, os, re, subprocess, sys, tempfile, unicodedata
from collections import defaultdict

import ezdxf
import ezdxf.recover
from ezdxf import bbox as zbbox
from ezdxf import path as zpath
from shapely.geometry import Point, Polygon, MultiPolygon, GeometryCollection
from shapely.ops import unary_union
from shapely import make_valid

SCALE = 40.0          # unités de plan par mètre
TOL = 0.01            # précision de l'aplatissement des courbes (m)
TOUCH = 0.15          # distance (m) en dessous de laquelle deux surfaces « se touchent »
MIN_PART = 0.10       # m² : en dessous, un morceau isolé est un résidu de dessin
COMMON_COLORS = {51}  # jaune : parties communes
BG_LAYERS = {
    "murs": ["DAO_MUR"],
    "poche": ["DAO_POCHAGE"],
    "embrasures": ["DAO_EMBRASURE"],
    "portes": ["DAO_PORTE"],
    "fenetres": ["DAO_FENETRE"],
    "escaliers": ["DAO_ESCALIER_ASCENSEUR"],
    "details": ["DAO_DETAIL", "DAO_BRISIS_POUTRE_VIDSUP", "DAO_1M80_LIMITE", "DAO_TOITURE"],
}
LEVEL_NAMES = {"s-sol": "Sous-sol", "ssol": "Sous-sol", "rdc": "RDC", "r1": "1er étage", "r2": "2e étage",
               "r3": "3e étage", "r4": "4e étage", "r5": "5e étage", "r6": "6e étage"}


# ---------------------------------------------------------------- lecture
def read_drawing(src):
    """DWG → DXF avec LibreDWG, réparation des textes coupés, lecture tolérante."""
    tmp = None
    if src.lower().endswith(".dwg"):
        tmp = tempfile.mkdtemp()
        dxf = os.path.join(tmp, "plan.dxf")
        r = subprocess.run(["dwg2dxf", "-y", "-o", dxf, src], capture_output=True, text=True)
        if not os.path.exists(dxf):
            raise SystemExit("Conversion DWG impossible : " + (r.stderr or r.stdout)[-500:])
        src = dxf
    # dwg2dxf laisse parfois un retour à la ligne dans un texte : on recolle
    lines = open(src, encoding="utf-8", errors="replace").read().split("\n")
    out, i = [], 0
    while i < len(lines) - 1:
        code, val = lines[i], lines[i + 1]
        i += 2
        while i < len(lines) and not lines[i].strip().lstrip("-").isdigit():
            val += lines[i]
            i += 1
        out += [code, val]
    fixed = os.path.join(tmp or tempfile.mkdtemp(), "plan-ok.dxf")
    open(fixed, "w", encoding="utf-8").write("\n".join(out) + "\n")
    doc, auditor = ezdxf.recover.readfile(fixed)
    return doc


def text_of(e):
    return (e.plain_text() if e.dxftype() == "MTEXT" else e.dxf.text).strip()


def centre(e):
    b = zbbox.extents([e], fast=False)
    if not b.has_data:
        return None
    c = b.center
    return (c.x, c.y)


# ---------------------------------------------------------------- niveaux
def find_levels(doc):
    """Une présentation = un niveau : sa grande fenêtre donne la zone du modèle."""
    levels = []
    for lay in doc.layouts:
        if lay.name.lower() == "model":
            continue
        vps = [v for v in lay.query("VIEWPORT") if v.dxf.view_height > 2]
        if not vps:
            continue
        vp = max(vps, key=lambda v: v.dxf.view_height)
        h = vp.dxf.view_height
        w = h * vp.dxf.width / vp.dxf.height
        c = vp.dxf.view_center_point
        titles = [text_of(t) for t in lay if t.dxftype() in ("TEXT", "MTEXT")]
        title = next((t for t in titles if re.search(r"(étage|chaussée|sol|niveau|combles)$", t, re.I)), "")
        key = re.sub(r"[^a-z0-9-]", "", lay.name.lower())
        levels.append({"layout": lay.name, "title": title, "name": LEVEL_NAMES.get(key, title or lay.name),
                       "rect": (c.x - w / 2, c.y - h / 2, c.x + w / 2, c.y + h / 2), "cy": c.y})
    levels.sort(key=lambda l: l["cy"])
    used = set()
    for L in levels:
        base = re.sub(r"[^a-z0-9]+", "-", unicodedata.normalize("NFKD", L["name"]).encode("ascii", "ignore").decode().lower()).strip("-") or "niveau"
        lid, n = base, 2
        while lid in used:
            lid, n = f"{base}-{n}", n + 1
        used.add(lid)
        L["id"] = lid
    if not levels:  # pas de présentation exploitable : tout le dessin = un niveau
        b = zbbox.extents(doc.modelspace(), fast=True)
        levels = [{"layout": "Model", "title": "", "name": "Plan", "id": "plan", "cy": 0,
                   "rect": (b.extmin.x, b.extmin.y, b.extmax.x, b.extmax.y)}]
    return levels


def level_of(pt, levels):
    for L in levels:
        x0, y0, x1, y1 = L["rect"]
        if x0 <= pt[0] <= x1 and y0 <= pt[1] <= y1:
            return L
    return None


# ---------------------------------------------------------------- géométrie
class Frame:
    """Repère d'un niveau : mètres (y vers le haut) → unités de plan (y vers le bas)."""

    def __init__(self, x0, y1):
        self.x0, self.y1 = x0, y1

    def p(self, x, y):
        return (round((x - self.x0) * SCALE, 1), round((self.y1 - y) * SCALE, 1))

    def fmt(self, x, y):
        u, v = self.p(x, y)
        return f"{u:g} {v:g}"


def entity_paths(e):
    try:
        if e.dxftype() == "HATCH":
            return list(zpath.from_hatch(e))
        if e.dxftype() in ("TEXT", "MTEXT", "DIMENSION", "INSERT", "POINT", "VIEWPORT", "ATTDEF"):
            return []
        return [zpath.make_path(e)]
    except Exception:
        return []


def path_d(paths, fr, close_fill=False):
    out = []
    for p in paths:
        pts = list(p.flattening(TOL))
        if len(pts) < 2:
            continue
        seg = "M" + fr.fmt(pts[0].x, pts[0].y) + "".join("L" + fr.fmt(v.x, v.y) for v in pts[1:])
        if close_fill or p.is_closed:
            seg += "Z"
        out.append(seg)
    return "".join(out)


def ring(p):
    pts = [(v.x, v.y) for v in p.flattening(TOL)]
    if len(pts) >= 3 and pts[0] != pts[-1]:
        pts.append(pts[0])
    return pts


def hatch_geometry(e):
    """Surface d'une hachure ou d'une polyligne fermée (règle pair-impair pour les îles)."""
    geom = None
    for p in entity_paths(e):
        r = ring(p)
        if len(r) < 4:
            continue
        g = make_valid(Polygon(r))
        geom = g if geom is None else geom.symmetric_difference(g)
    if geom is None:
        return None
    polys = [g for g in getattr(geom, "geoms", [geom]) if isinstance(g, (Polygon, MultiPolygon)) and not g.is_empty]
    return unary_union(polys) if polys else None


def parts_of(g):
    return [p for p in getattr(g, "geoms", [g]) if isinstance(p, Polygon) and not p.is_empty]


def filled(g):
    """La même surface sans ses trous (pour savoir si un numéro est « dedans »)."""
    return unary_union([Polygon(p.exterior) for p in parts_of(g)])


def fill_bubbles(g, points):
    """Le géomètre découpe une bulle blanche autour de chaque numéro : on la rebouche.
    Les autres trous (cages d'escalier, courettes…) sont conservés."""
    out = []
    for p in parts_of(g):
        keep = [r for r in p.interiors if not any(Polygon(r).buffer(0.05).contains(Point(pt)) for pt in points)]
        out.append(Polygon(p.exterior, keep))
    return unary_union(out)


def geom_parts(g, fr):
    """Surface → [[contour, trou, trou…], …] en coordonnées de plan (modifiables point par point)."""
    out = []
    for poly in parts_of(g):
        poly = poly.simplify(0.005)  # supprime les points alignés (< 5 mm)
        rings = []
        for r in [poly.exterior, *poly.interiors]:
            pts = [list(fr.p(*xy)) for xy in list(r.coords)[:-1]]
            if len(pts) >= 3:
                rings.append(pts)
        if rings:
            out.append(rings)
    return out


# ---------------------------------------------------------------- listing Excel
def read_listing(path):
    import openpyxl
    ws = openpyxl.load_workbook(path, data_only=True, read_only=True).worksheets[0]
    rows = [[c for c in r] for r in ws.iter_rows(values_only=True)]
    head = next(i for i, r in enumerate(rows) if sum(v is not None for v in r) >= 2)
    H = [str(h or "").strip() for h in rows[head]]
    norm = lambda s: unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    col = lambda *pats: next((i for i, h in enumerate(H) if any(re.search(p, norm(h)) for p in pats)), None)
    c_id, c_lot, c_type = col(r"^id\s*local"), col(r"n.{0,3}\s*de\s*lot", r"^lot"), col(r"^type logement", r"^type")
    c_surf, c_etage = col(r"^surface"), col(r"^etage$")
    ref = {}
    for r in rows[head + 1:]:
        lot = r[c_lot] if c_lot is not None else None
        if lot in (None, ""):
            continue
        lot = str(lot).strip()
        if re.fullmatch(r"\d+\.0", lot):
            lot = lot[:-2]
        entry = ref.setdefault(lot, {"type": "", "locaux": []})
        if c_type is not None and r[c_type] and not entry["type"]:
            entry["type"] = str(r[c_type]).strip()
        surf = r[c_surf] if c_surf is not None else None
        entry["locaux"].append([str(r[c_id]).strip() if c_id is not None and r[c_id] else "",
                                str(r[c_etage]).strip() if c_etage is not None and r[c_etage] is not None else "",
                                round(float(surf), 2) if isinstance(surf, (int, float)) else None])
    return ref


# ---------------------------------------------------------------- conversion
def level_key(s):
    """« Sous-sol » / « Cave » → cave, « RDC » / « 0 » → 0, « 2e étage » / « 2 » → 2."""
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower()
    if re.search(r"cave|sous|s-sol", s):
        return "cave"
    if re.search(r"rdc|rez|^0$", s.strip()):
        return "0"
    m = re.search(r"\d+", s)
    return m.group(0) if m else s.strip()


def convert(src, listing=None):
    doc = read_drawing(src)
    msp = doc.modelspace()
    levels = find_levels(doc)
    report = {"source": os.path.basename(src), "niveaux": [], "alertes": []}

    # Tri des entités par niveau
    per = defaultdict(lambda: defaultdict(list))
    for e in msp:
        c = centre(e)
        if c is None:
            continue
        L = level_of(c, levels)
        if L is None:
            continue
        per[L["id"]][e.dxf.layer].append((e, c))

    out_levels = []
    for L in levels:
        ents = per[L["id"]]
        x0, y0, x1, y1 = L["rect"]
        # Cadre serré sur le dessin réel du niveau (hors cartouche)
        content = [e for lay, lst in ents.items() if lay.startswith(("DAO_", "COPRO_", "INFO_DES")) for e, _ in lst]
        b = zbbox.extents(content, fast=True) if content else None
        if b is not None and b.has_data:
            m = 1.0
            x0, y0, x1, y1 = b.extmin.x - m, b.extmin.y - m, b.extmax.x + m, b.extmax.y + m
        fr = Frame(x0, y1)
        W, Hh = round((x1 - x0) * SCALE), round((y1 - y0) * SCALE)

        # Fond de plan
        bg = {}
        for cls, layers in BG_LAYERS.items():
            d = "".join(path_d(entity_paths(e), fr, close_fill=(cls == "poche")) for lay in layers for e, _ in ents.get(lay, []))
            if d:
                bg[cls] = d

        # Textes : pièces et repères
        texts = []
        for lay, kind in (("INFO_DESIGNATION", "piece"), ("INFO_ORIENTATION", "repere")):
            for e, c in ents.get(lay, []):
                if e.dxftype() not in ("TEXT", "MTEXT"):
                    continue
                t = re.sub(r"\s+", " ", text_of(e))
                if not t:
                    continue
                h = e.dxf.char_height if e.dxftype() == "MTEXT" else e.dxf.height
                rot = e.dxf.get("rotation", 0) or 0
                texts.append([*fr.p(*c), t, round(h * SCALE, 1), round(-rot, 1), kind])

        # Numéros de lot (centre du texte) et bulles (cercles)
        labels = [(text_of(e), c) for e, c in ents.get("COPRO_TEXTE_NUM_LOT", []) if e.dxftype() == "TEXT" and text_of(e)]
        circles = [(e.dxf.center, e.dxf.radius) for e, _ in ents.get("COPRO_TEXTE_LOT", []) if e.dxftype() == "CIRCLE"]

        # Surfaces COPRO_APLAT
        items = []
        for e, _ in ents.get("COPRO_APLAT", []):
            g = hatch_geometry(e)
            if g is None or g.is_empty:
                continue
            items.append({"h": e.dxf.handle, "color": e.dxf.get("color"), "geom": g})

        lots = defaultdict(list)        # n° → [géométries]
        auto = defaultdict(list)        # n° → morceaux rattachés automatiquement (à confirmer)
        commons, loose = [], []
        for it in items:
            if it["color"] in COMMON_COLORS:
                commons.append(it["geom"])
                continue
            inside = sorted({n for n, c in labels if filled(it["geom"]).buffer(1e-6).contains(Point(c))})
            if len(inside) == 1:
                lots[inside[0]].append(it["geom"])
            elif len(inside) > 1:  # plusieurs lots dans une même hachure : on sépare morceau par morceau
                for part in parts_of(it["geom"]):
                    ns = sorted({n for n, c in labels if filled(part).buffer(1e-6).contains(Point(c))})
                    if len(ns) == 1:
                        lots[ns[0]].append(part)
                    else:
                        loose.append(part)
            else:
                loose.extend(parts_of(it["geom"]))

        # Numéros posés hors de toute surface colorée : à placer à la main (ou suggestion ci-dessous)
        pending = [(n, c) for n, c in labels if n not in lots]
        for n, c in pending:
            report["alertes"].append(f"{L['name']} : le n° {n} n'est dans aucune surface colorée.")

        # Morceaux sans numéro : rattachés seulement s'ils touchent un seul lot
        bubble_pts = [c for _, c in labels] + [(cc.x, cc.y) for cc, _ in circles]
        main = {n: fill_bubbles(unary_union(gs), bubble_pts) for n, gs in lots.items()}
        merged = dict(main)  # sert aux tests de voisinage ; les morceaux auto restent séparés en sortie
        orphans, dropped = [], 0
        changed = True
        while changed:  # un morceau rattaché peut à son tour rendre un voisin non ambigu
            changed = False
            rest = []
            for part in loose:
                if part.area < MIN_PART:
                    dropped += 1
                    continue
                near = sorted(n for n, g in merged.items() if part.distance(g) <= TOUCH)
                lost_nearby = any(part.distance(Point(c)) <= 1.2 for _, c in pending)
                if len(near) == 1 and not lost_nearby:
                    n = near[0]
                    merged[n] = unary_union([merged[n], part])
                    auto[n].append(part)
                    changed = True
                else:
                    rest.append(part)
            loose = rest
        for i, part in enumerate(loose):
            near = sorted(n for n, g in merged.items() if part.distance(g) <= TOUCH)
            # Suggestion : un numéro « orphelin » posé juste à côté (moins de 1,2 m)
            sugg = sorted(((round(part.distance(Point(c)), 2), n) for n, c in pending if part.distance(Point(c)) <= 1.2))
            c = part.representative_point()
            orphans.append({"id": f"{L['id']}-z{i + 1}", "parts": geom_parts(part, fr), "area": round(part.area, 2),
                            "tag": list(fr.p(c.x, c.y)), "candidats": near,
                            "suggestions": [{"lot": n, "distance": dist} for dist, n in sugg]})

        out_lots = []
        for n, g in sorted(merged.items(), key=lambda kv: (len(kv[0]), kv[0])):
            pts = [c for m, c in labels if m == n]
            # bulle : le cercle le plus proche du numéro
            tag = pts[0]
            if circles:
                cc, rr = min(circles, key=lambda cr: math.dist((cr[0].x, cr[0].y), tag))
                if math.dist((cc.x, cc.y), tag) < 1.0:
                    tag = (cc.x, cc.y)
            auto_parts = [{"parts": geom_parts(a, fr), "area": round(a.area, 2)} for a in auto[n]]
            lot = {"lot": n, "parts": geom_parts(main[n], fr) + [p for a in auto_parts for p in a["parts"]],
                   "tag": list(fr.p(*tag)), "area": round(g.area, 2)}
            if len(pts) > 1:
                lot["tags"] = [list(fr.p(*p)) for p in pts]
            if auto_parts:  # listés à part pour pouvoir les vérifier un par un dans l'éditeur
                lot["auto"] = auto_parts
            out_lots.append(lot)

        halls = []
        for g in parts_of(unary_union(commons)) if commons else []:
            if g.area < MIN_PART:
                continue
            names = [t for t in texts if g.buffer(0.2).contains(Point(t[0] / SCALE + x0, y1 - t[1] / SCALE))]
            c = g.representative_point()
            halls.append({"parts": geom_parts(g, fr), "label": names[0][2] if names else "", "tag": list(fr.p(c.x, c.y))})

        out_levels.append({"id": L["id"], "name": L["name"], "vb": [0, 0, W, Hh], "scale": SCALE,
                           "bg": bg, "texts": texts, "halls": halls, "lots": out_lots, "orphans": orphans,
                           # numéros présents sur ce niveau mais sans surface : contour à dessiner
                           "pending": [{"lot": n, "tag": list(fr.p(*c))} for n, c in pending]})
        report["niveaux"].append({"niveau": L["name"], "presentation": L["layout"], "lots": len(out_lots),
                                  "numeros": len(labels), "rattaches_auto": sum(1 for v in auto.values() if v),
                                  "a_verifier": len(orphans), "parties_communes": len(halls), "residus_ignores": dropped})

    plan = {"format": "plan-vivant/2", "immeuble": "", "source": os.path.basename(src), "levels": out_levels, "ref": {}}

    # Comparaison avec le listing
    on_plan = {l["lot"] for L in out_levels for l in L["lots"]}
    if listing:
        ref = read_listing(listing)
        plan["ref"] = ref
        report["listing"] = {
            "lots_listing": len(ref),
            "absents_du_plan": sorted(set(ref) - on_plan, key=lambda s: (len(s), s)),
            "absents_du_listing": sorted(on_plan - set(ref), key=lambda s: (len(s), s)),
        }
        ecarts = []
        for L in out_levels:
            for l in L["lots"]:
                r = ref.get(l["lot"])
                if not r:
                    continue
                tot = sum(x[2] or 0 for x in r["locaux"])
                if tot and abs(sum(m["area"] for M in out_levels for m in M["lots"] if m["lot"] == l["lot"]) - tot) / tot > 0.25:
                    ecarts.append(l["lot"])
        report["listing"]["surfaces_tres_differentes"] = sorted(set(ecarts), key=lambda s: (len(s), s))
        # Une grande surface sans numéro qui ressemble à un lot du listing absent du plan
        missing = set(ref) - on_plan
        for L in out_levels:
            for o in L["orphans"]:
                if o["candidats"] or o["area"] < 5:
                    continue
                for n in sorted(missing):
                    loc = [x for x in ref[n]["locaux"] if level_key(x[1]) == level_key(L["name"])]
                    surf = sum(x[2] or 0 for x in loc)
                    if loc and surf and abs(o["area"] - surf) / surf <= 0.25:
                        o["suggestions"].append({"lot": n, "listing": f"{ref[n]['type'] or 'lot'} de {surf:g} m² au listing"})
    report["total"] = {"lots": len(on_plan), "a_verifier": sum(len(L["orphans"]) for L in out_levels)}
    return plan, report


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source")
    ap.add_argument("--listing")
    ap.add_argument("-o", "--sortie", default="plan.json")
    ap.add_argument("--rapport")
    a = ap.parse_args()
    plan, report = convert(a.source, a.listing)
    json.dump(plan, open(a.sortie, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    if a.rapport:
        json.dump(report, open(a.rapport, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
