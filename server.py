#!/usr/bin/env python3
"""
Dev server for Amiga Invisible — the local stand-in for apps_script.gs.
Serves this folder AND answers the same API, so index.html needs no changes:

    GET  /data.json   -> {"event": {...}, "people": [names], "drawn": bool, "recheck": n}
    POST /submit      -> {"action": "join" | "me" | "wishlist" | "seen", "name", "pin", ...}
                         {"action": "admin", "admin": pin, "do": check|draw|redraw|undraw|wipe}

State lives in local_data.json next to this script (gitignored): the local
equivalent of the Sheet's event / people / draw tabs. Edit it by hand to set
exclusions, exactly as you would in the Sheet.

The local admin PIN is 0000 ("admin" in local_data.json). The real one lives only
in the Sheet's event tab: this file is in a public repo. The draw also runs from here:

    python3 server.py 8000            run the server
    python3 server.py draw            do the draw (refuses if one exists)
    python3 server.py draw --force    throw the draw away and redo it
    python3 server.py check           validate exclusions without drawing
    python3 server.py reset           delete local_data.json

Phone on the same wifi:  http://$(ipconfig getifaddr en0):8000/
"""
import json, os, random, re, sys, tempfile, threading, unicodedata
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "local_data.json")
MAX_TRIES = 20000
LOCK = threading.Lock()

EMPTY = {
    "event": {"nombre": "Amiga Invisible", "presupuesto": "20 €", "fecha": "24 de diciembre",
              "organizador": "Alon", "nota": ""},
    "admin": "0000",  # local only; the real PIN is in the Sheet
    "people": [],     # {name, pin, wishlist, exclusions, joinedAt}
    "draw": [],       # {giver, receiver, seenAt, changedAt}
}


def read():
    if os.path.exists(DATA):
        try:
            with open(DATA, encoding="utf-8") as f:
                d = json.load(f)
            for k, v in EMPTY.items():
                d.setdefault(k, json.loads(json.dumps(v)))
            return d
        except Exception:
            pass
    return json.loads(json.dumps(EMPTY))


def write(d):
    tmp = tempfile.NamedTemporaryFile("w", dir=HERE, suffix=".tmp", delete=False, encoding="utf-8")
    json.dump(d, tmp, indent=1, ensure_ascii=False)
    tmp.close()
    os.replace(tmp.name, DATA)      # atomic: readers never see a half-written file


def nkey(x):
    s = unicodedata.normalize("NFKD", str(x or ""))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", s)).strip()


def find(people, name):
    k = nkey(name)
    return next((p for p in people if nkey(p["name"]) == k), None)


def state(d):
    """Public. From the draw it exposes counts and never a name."""
    drawn = bool(d["draw"])
    return {"event": d["event"], "people": [p["name"] for p in d["people"]],
            "drawn": drawn,
            "recheck": sum(1 for r in d["draw"] if r.get("changedAt") and not r.get("seenAt")),
            "pending": sum(1 for p in d["people"] if not giver_row(d, p["name"])) if drawn else 0}


def giver_row(d, name):
    k = nkey(name)
    return next((r for r in d["draw"] if nkey(r["giver"]) == k), None)


def mine(d, me):
    """Everything ONE authenticated person may see: their own draw row, no other."""
    out = state(d)
    out.update(ok=True, me={"name": me["name"], "wishlist": me.get("wishlist", "")}, match=None)
    row = giver_row(d, me["name"])
    if row:
        r = find(d["people"], row["receiver"])
        out["match"] = {"name": r["name"] if r else row["receiver"],
                        "wishlist": r.get("wishlist", "") if r else "",
                        "changed": bool(row.get("changedAt") and not row.get("seenAt"))}
    return out


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def handle(p):
    d = read()
    action = str(p.get("action", ""))
    if action == "join":
        name = re.sub(r"\s+", " ", str(p.get("name", ""))).strip()[:40]
        pin = str(p.get("pin", "")).strip()
        if len(nkey(name)) < 2:
            return {"error": "bad_name"}
        if not re.fullmatch(r"\d{4}", pin):
            return {"error": "bad_pin_format"}
        if find(d["people"], name):
            return {"error": "exists"}
        me = {"name": name, "pin": pin, "wishlist": str(p.get("wishlist") or "").strip()[:1000],
              "exclusions": "", "joinedAt": now_iso()}
        d["people"].append(me)     # after the draw: no assignment until the admin re-draws
        write(d)
        return mine(d, me)
    if action == "admin":
        if not d.get("admin"):
            return {"error": "no_admin"}
        if str(p.get("admin") or "").strip() != str(d["admin"]):
            return {"error": "bad_admin"}
        what, msg = str(p.get("do") or "check"), ""
        if what in ("draw", "redraw"):
            msg, err = do_draw(d, force=(what == "redraw"))
            if err:
                return {"error": "draw", "detail": err}
        elif what == "undraw":
            d["draw"], msg = [], "Sorteo anulado."
        elif what == "wipe":
            d["draw"], d["people"], msg = [], [], "Todo borrado: ni personas ni sorteo."
        elif what != "check":
            return {"error": "bad_action"}
        write(d)
        out = state(d)          # public state only: never anybody's assignment
        out.update(ok=True, msg=msg)
        return out
    if action not in ("me", "wishlist", "seen"):
        return {"error": "bad_action"}
    me = find(d["people"], p.get("name"))
    if not me:
        return {"error": "no_user"}
    if not me.get("pin") or str(p.get("pin") or "").strip() != me["pin"]:
        return {"error": "bad_pin"}          # no lockout: family app, by choice
    if action == "wishlist":
        me["wishlist"] = str(p.get("wishlist") or "").strip()[:1000]
        write(d)
    if action == "seen":
        row = giver_row(d, me["name"])
        if row and not row.get("seenAt"):
            row["seenAt"] = now_iso()
            write(d)
    return mine(d, me)


def banned_sets(people, strict):
    """Mirror of banned_ in apps_script.gs. Returns (banned, idx, error)."""
    idx = {}
    for i, p in enumerate(people):
        k = nkey(p["name"])
        if k in idx:
            if strict:
                return None, None, 'Nombre repetido: "%s".' % p["name"]
            continue
        idx[k] = i
    banned = [{i} for i in range(len(people))]            # symmetric on purpose
    for a, p in enumerate(people):
        for raw in re.split(r"[,;\n]", str(p.get("exclusions") or "")):
            k = nkey(raw)
            if not k:
                continue
            if k not in idx:
                if strict:
                    return None, None, ('Exclusión de "%s": no hay nadie llamado "%s" en la lista.'
                                        % (p["name"], raw.strip()))
                continue
            banned[a].add(idx[k])
            banned[idx[k]].add(a)
    return banned, idx, None


def compute_draw(people):
    """Mirror of computeDraw_ in apps_script.gs. Returns (pairs, error)."""
    n = len(people)
    if n < 3:
        return None, "Hacen falta al menos 3 personas (hay %d)." % n
    banned, _, err = banned_sets(people, True)
    if err:
        return None, err
    for a, p in enumerate(people):
        if len(banned[a]) == n:
            return None, ('Imposible: "%s" tiene excluidas a todas las demás personas.'
                          % p["name"])
    order = list(range(n))
    for _ in range(MAX_TRIES):
        random.shuffle(order)
        if all(order[g] not in banned[g] for g in range(n)):
            return [[people[g]["name"], people[order[g]]["name"]] for g in range(n)], None
    return None, ("Imposible con estas exclusiones: tras %d intentos no hay ningún sorteo "
                  "válido. Quita alguna exclusión." % MAX_TRIES)


def do_draw(d, force=False, dry=False):
    """Mirror of doDraw_. Mutates d; the caller writes. Returns (msg, error)."""
    old = d["draw"]
    if old and not force and not dry:
        return None, "Ya hay un sorteo hecho (%d personas). No se ha cambiado nada." % len(old)
    pairs, err = compute_draw(d["people"])
    if err:
        return None, err
    if dry:
        return "Todo bien: %d personas, el sorteo es posible." % len(d["people"]), None
    rows = []
    for g, r in pairs:
        was = giver_row(d, g)
        looked = bool(was and (was.get("seenAt") or was.get("changedAt")))
        same = bool(was and nkey(was["receiver"]) == nkey(r))
        rows.append({"giver": g, "receiver": r,
                     "seenAt": was.get("seenAt", "") if same else "",
                     "changedAt": was.get("changedAt", "") if same else (now_iso() if looked else "")})
    d["draw"] = rows
    return "Sorteo hecho: %d personas." % len(rows), None


def cli_draw(force=False, dry=False):
    d = read()
    msg, err = do_draw(d, force, dry)
    if err:
        sys.exit("ERROR: " + err)
    if not dry:
        write(d)
    print(msg)


class Handler(SimpleHTTPRequestHandler):
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/data.json":
            return self._json(state(read()))
        # never serve the state file (PINs + draw) or the repo internals as static files
        if os.path.basename(path).startswith(("local_data", ".")) or "/.git" in path:
            return self._json({"error": "not found"}, 404)
        return SimpleHTTPRequestHandler.do_GET(self)

    def do_POST(self):
        if urlparse(self.path).path != "/submit":
            return self._json({"error": "not found"}, 404)
        try:
            n = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return self._json({"error": "server", "detail": "bad json"})
        with LOCK:
            # Apps Script answers errors with HTTP 200 + {error}; so do we
            return self._json(handle(payload))

    def log_message(self, fmt, *args):
        if "/data.json" not in (args[0] if args else ""):
            SimpleHTTPRequestHandler.log_message(self, fmt, *args)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "8000"
    if cmd == "draw":
        cli_draw(force="--force" in sys.argv)
    elif cmd == "check":
        cli_draw(dry=True)
    elif cmd == "reset":
        if os.path.exists(DATA):
            os.remove(DATA)
        print("local_data.json borrado")
    else:
        port = int(cmd)
        print("Serving on http://0.0.0.0:%d   (state: %s)" % (port, DATA))
        ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
