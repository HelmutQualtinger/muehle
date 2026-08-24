import hashlib
import secrets
import socket

from flask import Flask, jsonify, render_template, request, session, url_for
from werkzeug.middleware.proxy_fix import ProxyFix

import ai
import game

app = Flask(__name__)
app.secret_key = secrets.token_hex(32)
# Trust the reverse proxy's X-Forwarded-Proto/Host so request.url / url_for(_external=True)
# report https:// (the proxy terminates TLS; the container only ever sees plain HTTP).
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)

# The reverse proxy sets a long Cache-Control on /static/*, so a stale
# game.js/style.css can outlive a redeploy in a visitor's browser. Hash each
# file's contents once at process start and append it as a query string in
# the template, so every deploy that actually changes a file's bytes forces
# a fresh fetch.
_ASSET_VERSIONS = {}


def _asset_version(filename):
    if filename not in _ASSET_VERSIONS:
        path = app.static_folder + "/" + filename
        with open(path, "rb") as f:
            _ASSET_VERSIONS[filename] = hashlib.md5(f.read()).hexdigest()[:8]
    return _ASSET_VERSIONS[filename]


app.jinja_env.globals["asset_version"] = _asset_version

DEFAULT_META = {"opponent": "human", "human_color": "white"}

# In-memory store for network games: {game_id: {"state", "tokens", "log"}}.
# Lost on server restart — fine for casual play, no persistence needed.
NET_GAMES = {}


def _get_state():
    state = session.get("state")
    if state is None:
        state = game.new_game()
        session["state"] = state
    return state


def _get_meta():
    meta = session.get("meta")
    if meta is None:
        meta = dict(DEFAULT_META)
        session["meta"] = meta
    return meta


def _save(state, meta):
    session["state"] = state
    session["meta"] = meta


def _is_human_turn(state, meta):
    if meta["opponent"] != "computer":
        return True
    return state["turn"] == meta["human_color"]


def _record_place(state, point, events):
    player = state["turn"]
    ok, err = game.place(state, point)
    if ok:
        events.append({"type": "place", "player": player, "point": point})
        if state["pending_removal"]:
            events.append({"type": "mill", "player": player, "point": point})
    return ok, err


def _record_move(state, frm, to, events):
    player = state["turn"]
    ok, err = game.move(state, frm, to)
    if ok:
        events.append({"type": "move", "player": player, "from": frm, "to": to})
        if state["pending_removal"]:
            events.append({"type": "mill", "player": player, "point": to})
    return ok, err


def _record_remove(state, point, events):
    player = state["turn"]
    ok, err = game.remove_stone(state, point)
    if ok:
        events.append({"type": "remove", "player": player, "point": point})
    return ok, err


def _run_computer(state, meta, events):
    if meta["opponent"] != "computer":
        return
    computer_color = game.OTHER[meta["human_color"]]
    while not state["winner"] and state["turn"] == computer_color:
        if state["pending_removal"]:
            ok, _ = _record_remove(state, ai.choose_action(state, computer_color)[1], events)
        elif state["phase"] == "placing":
            ok, _ = _record_place(state, ai.choose_action(state, computer_color)[1], events)
        else:
            _, frm, to = ai.choose_action(state, computer_color)
            ok, _ = _record_move(state, frm, to, events)
        if not ok:
            break


def _public_state(state, meta):
    return {
        "board": state["board"],
        "phase": state["phase"],
        "turn": state["turn"],
        "stonesToPlace": state["stones_to_place"],
        "stonesOnBoard": state["stones_on_board"],
        "pendingRemoval": state["pending_removal"],
        "winner": state["winner"],
        "message": state["message"],
        "points": game.POINTS,
        "edges": game.EDGES,
        "opponent": meta["opponent"],
        "humanColor": meta["human_color"],
        "computerColor": game.OTHER[meta["human_color"]] if meta["opponent"] == "computer" else None,
    }


def _color_for_token(entry, token):
    if not token:
        return None
    for color, tok in entry["tokens"].items():
        if tok == token:
            return color
    return None


def _public_net_state(entry, your_color):
    state = entry["state"]
    return {
        "board": state["board"],
        "phase": state["phase"],
        "turn": state["turn"],
        "stonesToPlace": state["stones_to_place"],
        "stonesOnBoard": state["stones_on_board"],
        "pendingRemoval": state["pending_removal"],
        "winner": state["winner"],
        "message": state["message"],
        "points": game.POINTS,
        "edges": game.EDGES,
        "yourColor": your_color,
        "seq": len(entry["log"]),
    }


def _preview_context():
    # Social-media crawlers (Facebook, WhatsApp, ...) sometimes hit the plain-HTTP
    # port directly rather than following an HTTPS redirect, and ProxyFix then
    # honestly reports scheme "http" from X-Forwarded-Proto. The site is only ever
    # meant to be shared as https, so the OG/Twitter tags hardcode that scheme
    # instead of trusting the scheme of whatever request happened to arrive.
    host = request.host
    return {
        "page_url": f"https://{host}{request.path}",
        "preview_image_url": f"https://{host}{url_for('static', filename='img/preview.jpg')}",
    }


@app.get("/")
def index():
    return render_template("index.html", game_id=None, **_preview_context())


@app.get("/g/<game_id>")
def net_game_page(game_id):
    return render_template(
        "index.html",
        game_id=game_id,
        page_title="Mühle — Partie beitreten",
        page_description="Du wurdest zu einer Partie Mühle eingeladen. Tritt jetzt bei und spiele live gegen deinen Gegner in 3D.",
        **_preview_context(),
    )


@app.get("/api/state")
def api_state():
    return jsonify({**_public_state(_get_state(), _get_meta()), "events": []})


@app.post("/api/new_game")
def api_new_game():
    data = request.get_json(silent=True) or {}
    opponent = data.get("opponent") if data.get("opponent") in ("human", "computer") else "human"
    human_color = data.get("color") if data.get("color") in ("white", "black") else "white"
    meta = {"opponent": opponent, "human_color": human_color}

    state = game.new_game()
    events = []
    _run_computer(state, meta, events)
    _save(state, meta)
    return jsonify({**_public_state(state, meta), "events": events})


@app.post("/api/place")
def api_place():
    data = request.get_json(silent=True) or {}
    point = data.get("point")
    if not isinstance(point, int):
        return jsonify({"error": "point (int) erforderlich"}), 400

    state, meta = _get_state(), _get_meta()
    if not _is_human_turn(state, meta):
        return jsonify({"error": "Der Computer ist am Zug.", **_public_state(state, meta)}), 400

    events = []
    ok, err = _record_place(state, point, events)
    if not ok:
        return jsonify({"error": err, **_public_state(state, meta)}), 400

    _run_computer(state, meta, events)
    _save(state, meta)
    return jsonify({**_public_state(state, meta), "events": events})


@app.post("/api/move")
def api_move():
    data = request.get_json(silent=True) or {}
    frm, to = data.get("from"), data.get("to")
    if not isinstance(frm, int) or not isinstance(to, int):
        return jsonify({"error": "from und to (int) erforderlich"}), 400

    state, meta = _get_state(), _get_meta()
    if not _is_human_turn(state, meta):
        return jsonify({"error": "Der Computer ist am Zug.", **_public_state(state, meta)}), 400

    events = []
    ok, err = _record_move(state, frm, to, events)
    if not ok:
        return jsonify({"error": err, **_public_state(state, meta)}), 400

    _run_computer(state, meta, events)
    _save(state, meta)
    return jsonify({**_public_state(state, meta), "events": events})


@app.post("/api/remove")
def api_remove():
    data = request.get_json(silent=True) or {}
    point = data.get("point")
    if not isinstance(point, int):
        return jsonify({"error": "point (int) erforderlich"}), 400

    state, meta = _get_state(), _get_meta()
    if not _is_human_turn(state, meta):
        return jsonify({"error": "Der Computer ist am Zug.", **_public_state(state, meta)}), 400

    events = []
    ok, err = _record_remove(state, point, events)
    if not ok:
        return jsonify({"error": err, **_public_state(state, meta)}), 400

    _run_computer(state, meta, events)
    _save(state, meta)
    return jsonify({**_public_state(state, meta), "events": events})


@app.post("/api/net/create")
def api_net_create():
    game_id = secrets.token_urlsafe(9)
    tokens = {"white": secrets.token_urlsafe(12), "black": secrets.token_urlsafe(12)}
    NET_GAMES[game_id] = {"state": game.new_game(), "tokens": tokens, "log": []}
    return jsonify({
        "gameId": game_id,
        "yourUrl": url_for("net_game_page", game_id=game_id, t=tokens["white"], _external=True),
        "inviteUrl": url_for("net_game_page", game_id=game_id, t=tokens["black"], _external=True),
    })


@app.get("/api/net/<game_id>/state")
def api_net_state(game_id):
    entry = NET_GAMES.get(game_id)
    if not entry:
        return jsonify({"error": "Spiel nicht gefunden."}), 404
    color = _color_for_token(entry, request.args.get("t"))
    if not color:
        return jsonify({"error": "Ungültiger Zugangslink."}), 403

    since = max(0, request.args.get("since", type=int) or 0)
    return jsonify({**_public_net_state(entry, color), "events": entry["log"][since:]})


@app.post("/api/net/<game_id>/place")
def api_net_place(game_id):
    entry = NET_GAMES.get(game_id)
    if not entry:
        return jsonify({"error": "Spiel nicht gefunden."}), 404
    data = request.get_json(silent=True) or {}
    color = _color_for_token(entry, data.get("t"))
    if not color:
        return jsonify({"error": "Ungültiger Zugangslink."}), 403
    point = data.get("point")
    if not isinstance(point, int):
        return jsonify({"error": "point (int) erforderlich"}), 400

    state = entry["state"]
    if state["turn"] != color:
        return jsonify({"error": "Dein Gegner ist am Zug.", **_public_net_state(entry, color), "events": []}), 400

    before = len(entry["log"])
    ok, err = _record_place(state, point, entry["log"])
    if not ok:
        return jsonify({"error": err, **_public_net_state(entry, color), "events": []}), 400

    return jsonify({**_public_net_state(entry, color), "events": entry["log"][before:]})


@app.post("/api/net/<game_id>/move")
def api_net_move(game_id):
    entry = NET_GAMES.get(game_id)
    if not entry:
        return jsonify({"error": "Spiel nicht gefunden."}), 404
    data = request.get_json(silent=True) or {}
    color = _color_for_token(entry, data.get("t"))
    if not color:
        return jsonify({"error": "Ungültiger Zugangslink."}), 403
    frm, to = data.get("from"), data.get("to")
    if not isinstance(frm, int) or not isinstance(to, int):
        return jsonify({"error": "from und to (int) erforderlich"}), 400

    state = entry["state"]
    if state["turn"] != color:
        return jsonify({"error": "Dein Gegner ist am Zug.", **_public_net_state(entry, color), "events": []}), 400

    before = len(entry["log"])
    ok, err = _record_move(state, frm, to, entry["log"])
    if not ok:
        return jsonify({"error": err, **_public_net_state(entry, color), "events": []}), 400

    return jsonify({**_public_net_state(entry, color), "events": entry["log"][before:]})


@app.post("/api/net/<game_id>/remove")
def api_net_remove(game_id):
    entry = NET_GAMES.get(game_id)
    if not entry:
        return jsonify({"error": "Spiel nicht gefunden."}), 404
    data = request.get_json(silent=True) or {}
    color = _color_for_token(entry, data.get("t"))
    if not color:
        return jsonify({"error": "Ungültiger Zugangslink."}), 403
    point = data.get("point")
    if not isinstance(point, int):
        return jsonify({"error": "point (int) erforderlich"}), 400

    state = entry["state"]
    if state["turn"] != color:
        return jsonify({"error": "Dein Gegner ist am Zug.", **_public_net_state(entry, color), "events": []}), 400

    before = len(entry["log"])
    ok, err = _record_remove(state, point, entry["log"])
    if not ok:
        return jsonify({"error": err, **_public_net_state(entry, color), "events": []}), 400

    return jsonify({**_public_net_state(entry, color), "events": entry["log"][before:]})


@app.post("/api/net/<game_id>/new_game")
def api_net_new_game(game_id):
    entry = NET_GAMES.get(game_id)
    if not entry:
        return jsonify({"error": "Spiel nicht gefunden."}), 404
    data = request.get_json(silent=True) or {}
    color = _color_for_token(entry, data.get("t"))
    if not color:
        return jsonify({"error": "Ungültiger Zugangslink."}), 403

    before = len(entry["log"])
    entry["state"] = game.new_game()
    entry["log"].append({"type": "reset", "player": color})
    return jsonify({**_public_net_state(entry, color), "events": entry["log"][before:]})


def _detect_lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


if __name__ == "__main__":
    port = 5003
    lan_ip = _detect_lan_ip()
    print(f"Mühle läuft auf: http://localhost:{port}/")
    if lan_ip:
        print(f"Für Netzwerkspiele im selben WLAN/LAN, dieses Gerät im Browser öffnen: http://{lan_ip}:{port}/")
        print("(Online-Einladungslinks funktionieren nur für Personen im selben Netzwerk, ausser bei Port-Weiterleitung/Tunnel.)")
    # debug=False: the Werkzeug interactive debugger is an RCE risk once reachable
    # from other machines on the network, which network play requires.
    app.run(host="0.0.0.0", port=port, debug=False)
