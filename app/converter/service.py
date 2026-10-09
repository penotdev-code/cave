#!/usr/bin/env python3
"""
Service de conversion DWG → plan, appelé par l'application (réseau interne Docker
uniquement, jamais exposé sur Internet).

    POST /convertir   corps JSON : {"dwg": "<base64>", "nom": "plan.dwg", "listing": "<base64 xlsx>" | null}
                      réponse    : {"plan": {...}, "rapport": {...}}
    GET  /sante       « ok »
"""
import base64, json, os, shutil, tempfile, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import dwg2plan

MAX = 60 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/sante":
            return self._send(200, {"ok": True})
        self._send(404, {"error": "Introuvable"})

    def do_POST(self):
        if self.path != "/convertir":
            return self._send(404, {"error": "Introuvable"})
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX:
            return self._send(413, {"error": "Fichier trop volumineux"})
        tmp = tempfile.mkdtemp()
        try:
            req = json.loads(self.rfile.read(n))
            nom = os.path.basename(req.get("nom") or "plan.dwg")
            ext = ".dxf" if nom.lower().endswith(".dxf") else ".dwg"
            src = os.path.join(tmp, "plan" + ext)
            open(src, "wb").write(base64.b64decode(req["dwg"]))
            listing = None
            if req.get("listing"):
                listing = os.path.join(tmp, "listing.xlsx")
                open(listing, "wb").write(base64.b64decode(req["listing"]))
            plan, rapport = dwg2plan.convert(src, listing)
            plan["source"] = rapport["source"] = nom
            self._send(200, {"plan": plan, "rapport": rapport})
        except SystemExit as e:
            self._send(422, {"error": str(e)})
        except Exception as e:
            traceback.print_exc()
            self._send(422, {"error": "Le fichier n'a pas pu être converti : " + str(e)[:300]})
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def log_message(self, fmt, *args):
        print("convertisseur :", fmt % args, flush=True)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    print(f"Convertisseur DWG à l'écoute sur :{port}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
