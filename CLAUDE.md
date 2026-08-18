# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Mühle (Nine Men's Morris): a Flask backend serving a vanilla HTML/CSS/JS frontend. The board is rendered as a 3D scene (Three.js, WebGL) and driven entirely through a small JSON API — there is no client-side game logic beyond rendering and input handling; all rules are enforced server-side.

## Commands

Dependency management and running is via `uv` (see `pyproject.toml` / `uv.lock`).

```bash
uv run python app.py        # start the dev server on http://localhost:5001/
uv add <package>             # add a dependency
```

There is no test suite, linter, or build step configured. Ad-hoc verification during development is typically done by importing `game.py`/`ai.py` directly in a `uv run python -c "..."` one-liner, or by driving `app.py`'s Flask routes through `app.test_client()`.

The server prints its LAN URL on startup (for same-network multiplayer testing) and binds to `0.0.0.0`. `debug=False` is intentional — the Werkzeug interactive debugger is a remote-code-execution risk once the server is reachable from other machines on the network, so do not re-enable `debug=True` without also restricting the bind address back to loopback-only.

## Architecture

**`game.py`** — pure game engine, no Flask/HTTP awareness. Defines the 24-point board graph (`POINTS`, `EDGES`, `ADJACENCY`), the 16 mill lines (`MILLS`, `MILLS_BY_POINT`), and the state machine transitions `place()` / `move()` / `remove_stone()` operating on a plain state dict (`new_game()`). Turn order, mill detection, the mill-capture protection rule (can't remove a stone that's part of a mill unless *all* of the opponent's stones are in mills), the placing→moving phase transition, the flying phase (exactly 3 stones left → move anywhere), and stalemate/win detection all live here. `clone_state()` is a fast shallow-ish copy used by the AI search (`copy.deepcopy` is intentionally avoided for performance).

**`ai.py`** — minimax with alpha-beta pruning for the computer opponent. Operates one atomic action (`place`/`move`/`remove`) per search ply rather than one full "turn", since `game.py`'s `state["turn"]` already encodes whose turn is next (including staying with the same player through a mill-then-capture sequence) — this means the search tree needs no separate bookkeeping for phases. `legal_actions()`/`apply_action()` mirror `game.py`'s validation. `choose_action()` does iterative deepening (depth 1, 2, 3, …) under a `TIME_BUDGET_SECONDS` wall-clock budget rather than a fixed depth — a `_SearchTimeout` raised mid-search is caught per-depth so only a *fully completed* depth's result is ever used, keeping per-move latency bounded regardless of branching factor while searching much deeper in the (small-branching) endgame than in the (large-branching) placing phase. `_action_priority()` orders each node's actions (mill-forming first, then by `POINT_WEIGHT` — the degree of a point in `game.ADJACENCY`, favoring the four middle-ring "cross" points) before search, improving alpha-beta pruning. `evaluate()` weighs material, mobility (with a stalemate-proximity bonus/penalty near zero legal moves), open mill threats (with an extra bonus once a side has an unblockable double threat), and the same `POINT_WEIGHT` positional table.

**`app.py`** — Flask routes and three distinct play modes, all funneling through the same `_record_place`/`_record_move`/`_record_remove` helpers (which apply a `game.py` action and append a structured event — `{"type": "place"|"move"|"mill"|"remove", ...}` — to an event list):

- **Local (hotseat / vs-computer)**: state lives in the Flask session cookie (`session["state"]`, `session["meta"]`). `_run_computer()` loops calling `ai.choose_action()` and applying it until it's the human's turn again or the game ends — this can chain multiple actions (e.g. place → form mill → remove) within a single request. The accumulated `events` list is returned to the client for animation.
- **Network play** (`/g/<game_id>?t=<token>`): games live in the in-memory `NET_GAMES` dict (lost on server restart — no persistence layer). Each game has two secret tokens (one per color) baked into per-player URLs; a client can only act as the color whose token it presents. Unlike local mode, each game keeps a *persistent* event log (`entry["log"]`) with sequence numbers; clients poll `GET /api/net/<id>/state?since=<seq>` to fetch only new events and replay them, rather than diffing full board snapshots. A `"reset"` event type signals a rematch to polling clients.
- The **same event-replay mechanism drives animation/sound for all three modes** on the frontend — this is the key invariant to preserve when touching either side of the API: any new server-side action must emit an event of a type the frontend's `applyEventToLive()` (in `game.js`) knows how to fold into its local board projection.

**`static/js/game.js`** — single IIFE (still no bundler/build step — edit and refresh), but loaded as an ES module (`<script type="module">`) so it can `import` Three.js and its `OrbitControls`/`CSS3DRenderer` addons from a CDN via an `importmap` in `templates/index.html` (`unpkg.com/three@…`); this is the one place the frontend depends on an external library. Key pieces:
- The board is a Three.js scene rendered into `#stage`, built once (`initThree` + `buildBoardSkeleton`) then updated in place (`render`) by diffing `state.board` against tracked meshes (`stoneEls`). Two layers overlap inside `#stage`: a WebGL `<canvas>` underneath (board slab, point markers, stone meshes) and a `CSS3DRenderer` layer on top.
- The CSS3D layer doesn't hold new markup — at startup `setupControls()`/`mountControl()` detaches the real HTML control panels (header actions, settings, network panel, status, player stocks) out of the hidden `#controls-src` container in `templates/index.html` and re-mounts each as a `CSS3DObject` positioned in 3D space around the board, so `templates/index.html`'s ids/classes/Jinja branches stay the single source of truth for what controls exist even though they're never shown in normal page flow.
- Point/stone interaction is raycasting-based (`raycastPick`) rather than DOM click listeners: `pointHitMeshes` are invisible larger hit-cylinders layered over the small visible point markers (same click-miss problem SVG had, solved the same way). `onPointerDown`/`onPointerUp` compare cursor start/end position to distinguish a click from an `OrbitControls` camera drag before dispatching to `onPointClick`/`onStoneClick`.
- Animations that used to be CSS keyframes/SVG classes are now per-frame tweens applied in `animate()`: stone pop-in (`popTweens`, a back-out ease on mesh scale), mill-flash (`millTweens`, emissive intensity decay on the mill's line meshes), and the pulsing glow on legal-move markers / removable stones (driven straight off `Math.sin(now * …)` each frame, no tween list needed since they're states, not one-shot events).
- `processResult()` replays a response's `events` array with a short delay between steps (`EVENT_DELAY_MS`), driving both the mill-flash animation and the synthesized Web Audio sound effects (`Sound` object — everything is generated tones, no audio assets).
- Network mode polls `pollNetwork()` on an interval and feeds new events through the same `processResult()` path used for direct action responses.
- `canAct()` is the single gate for whether a click is allowed to do anything (checks whose turn it is against `yourColor` in network mode); local hotseat mode has no such restriction since one browser controls both colors.

**`templates/index.html`** — server-rendered per route: `game_id` is `None` on `/` (renders the local-play settings UI) and set on `/g/<id>` (renders the network invite panel instead). `window.MUEHLE_GAME_ID` is how `game.js` learns which mode it's in. The visible page body is just `#stage` (the 3D canvas mount point); the actual control markup — header actions, settings, network panel, status line, player stocks — lives inside `hidden` `#controls-src`, which `game.js` empties into the 3D scene at startup (see above). An `importmap` `<script>` maps bare `three`/`three/addons/` specifiers to CDN URLs for the `type="module"` game script.
