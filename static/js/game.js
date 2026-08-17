(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const EVENT_DELAY_MS = 380;
  const NET_POLL_MS = 1800;

  const boardEl = document.getElementById("board");
  const statusEl = document.getElementById("status");
  const stockWhiteEl = document.getElementById("stock-white");
  const stockBlackEl = document.getElementById("stock-black");
  const newGameBtn = document.getElementById("new-game-btn");
  const muteBtn = document.getElementById("mute-btn");
  const opponentChips = document.querySelectorAll("[data-opponent]");
  const colorGroup = document.querySelector(".settings__group--color");
  const colorChips = document.querySelectorAll("[data-color]");
  const netCreateBtn = document.getElementById("net-create-btn");
  const netYourColorEl = document.getElementById("net-your-color");
  const inviteLinkInput = document.getElementById("invite-link-input");
  const copyLinkBtn = document.getElementById("copy-link-btn");
  const mailInviteBtn = document.getElementById("mail-invite-btn");

  const NET_GAME_ID = window.MUEHLE_GAME_ID || null;
  const NET_TOKEN = new URLSearchParams(location.search).get("t");
  let netSeq = 0;

  let state = null;
  let selectedPoint = null;
  let pointEls = [];
  let stoneEls = new Array(24).fill(null);
  let busy = false;

  const settings = { opponent: "human", color: "white" };

  // ---------------------------------------------------------------- sound --

  const Sound = (() => {
    let ctx = null;
    let muted = localStorage.getItem("muehle_muted") === "1";

    function ensureCtx() {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") ctx.resume();
      return ctx;
    }

    function tone(freq, duration, type = "sine", peak = 0.18, delay = 0) {
      if (muted) return;
      const c = ensureCtx();
      const t0 = c.currentTime + delay;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(peak, t0 + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(gain).connect(c.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.02);
    }

    return {
      unlock: ensureCtx,
      place() { tone(520, 0.09, "triangle"); },
      move() { tone(420, 0.08, "triangle"); },
      mill() {
        tone(660, 0.12, "sine");
        tone(880, 0.14, "sine", 0.16, 0.09);
        tone(1100, 0.18, "sine", 0.14, 0.18);
      },
      capture() { tone(180, 0.16, "sawtooth", 0.14); },
      error() { tone(140, 0.14, "square", 0.12); },
      win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, "triangle", 0.16, i * 0.12)); },
      lose() { [400, 340, 280].forEach((f, i) => tone(f, 0.28, "sawtooth", 0.12, i * 0.15)); },
      toggleMute() {
        muted = !muted;
        localStorage.setItem("muehle_muted", muted ? "1" : "0");
        return muted;
      },
      isMuted() { return muted; },
    };
  })();

  document.addEventListener("pointerdown", () => Sound.unlock(), { once: true });

  function updateMuteUI() {
    const muted = Sound.isMuted();
    muteBtn.textContent = muted ? "🔇" : "🔊";
    muteBtn.setAttribute("aria-pressed", muted ? "true" : "false");
  }

  muteBtn.addEventListener("click", () => {
    Sound.toggleMute();
    updateMuteUI();
  });
  updateMuteUI();

  // ------------------------------------------------------------ settings --

  function syncSettingsUI(data) {
    settings.opponent = data.opponent;
    settings.color = data.humanColor;
    opponentChips.forEach((b) => b.classList.toggle("is-active", b.dataset.opponent === settings.opponent));
    colorGroup.hidden = settings.opponent !== "computer";
    colorChips.forEach((b) => b.classList.toggle("is-active", b.dataset.color === settings.color));
  }

  opponentChips.forEach((btn) => btn.addEventListener("click", () => {
    settings.opponent = btn.dataset.opponent;
    opponentChips.forEach((b) => b.classList.toggle("is-active", b === btn));
    colorGroup.hidden = settings.opponent !== "computer";
  }));

  colorChips.forEach((btn) => btn.addEventListener("click", () => {
    settings.color = btn.dataset.color;
    colorChips.forEach((b) => b.classList.toggle("is-active", b === btn));
  }));

  // ----------------------------------------------------------------- api --

  function api(path, body) {
    return fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Unbekannter Fehler");
      return data;
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // --------------------------------------------------------------- board --

  function buildBoardSkeleton(points, edges) {
    boardEl.innerHTML = "";

    const defs = document.createElementNS(SVG_NS, "defs");
    defs.innerHTML = `
      <radialGradient id="stoneWhite" cx="35%" cy="28%" r="75%">
        <stop offset="0%" stop-color="#fdf7e8"/>
        <stop offset="55%" stop-color="#e9d6a8"/>
        <stop offset="100%" stop-color="#b89860"/>
      </radialGradient>
      <radialGradient id="stoneBlack" cx="35%" cy="28%" r="75%">
        <stop offset="0%" stop-color="#5a564e"/>
        <stop offset="55%" stop-color="#221f1b"/>
        <stop offset="100%" stop-color="#000000"/>
      </radialGradient>
    `;
    boardEl.appendChild(defs);

    const lineGroup = document.createElementNS(SVG_NS, "g");
    edges.forEach(([a, b]) => {
      const [x1, y1] = points[a];
      const [x2, y2] = points[b];
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", x1);
      line.setAttribute("y1", y1);
      line.setAttribute("x2", x2);
      line.setAttribute("y2", y2);
      line.setAttribute("class", "board-line");
      lineGroup.appendChild(line);
    });
    boardEl.appendChild(lineGroup);

    const millFlashGroup = document.createElementNS(SVG_NS, "g");
    millFlashGroup.id = "mill-flash-group";
    boardEl.appendChild(millFlashGroup);

    const pointGroup = document.createElementNS(SVG_NS, "g");
    pointEls = points.map(([x, y], i) => {
      // Larger invisible hit target layered under the visible dot, so clicking
      // near (not just exactly on) a point registers — points are the smallest
      // targets on the board and are easy to miss otherwise.
      const hit = document.createElementNS(SVG_NS, "circle");
      hit.setAttribute("cx", x);
      hit.setAttribute("cy", y);
      hit.setAttribute("r", 0.34);
      hit.setAttribute("fill", "transparent");
      hit.dataset.point = i;
      hit.addEventListener("click", () => onPointClick(i));
      pointGroup.appendChild(hit);

      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("cx", x);
      c.setAttribute("cy", y);
      c.setAttribute("r", 0.16);
      c.setAttribute("class", "board-point");
      c.dataset.point = i;
      c.style.pointerEvents = "none";
      pointGroup.appendChild(c);
      return c;
    });
    boardEl.appendChild(pointGroup);

    const stoneGroup = document.createElementNS(SVG_NS, "g");
    stoneGroup.id = "stone-group";
    boardEl.appendChild(stoneGroup);

    stoneEls = new Array(24).fill(null);
  }

  function renderStock(el, color, toPlace) {
    el.className = `stock stock--${color}`;
    el.innerHTML = "";
    for (let i = 0; i < toPlace; i++) {
      const d = document.createElement("div");
      d.className = "stock__stone";
      el.appendChild(d);
    }
  }

  function legalDestinationsFrom(point) {
    if (!state || state.phase !== "moving") return new Set();
    const flying = state.stonesOnBoard[state.turn] === 3;
    if (flying) {
      return new Set(state.board.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0));
    }
    const targets = new Set();
    state.edges.forEach(([a, b]) => {
      if (a === point && state.board[b] === null) targets.add(b);
      if (b === point && state.board[a] === null) targets.add(a);
    });
    return targets;
  }

  function millsContaining(point) {
    const rings = [0, 8, 16].flatMap((base) => [
      [base, base + 1, base + 2],
      [base + 2, base + 3, base + 4],
      [base + 4, base + 5, base + 6],
      [base + 6, base + 7, base],
    ]);
    const spokes = [[1, 9, 17], [3, 11, 19], [5, 13, 21], [7, 15, 23]];
    return [...rings, ...spokes].filter((m) => m.includes(point));
  }

  function isRemovable(point) {
    const opponent = state.turn === "white" ? "black" : "white";
    const opponentPoints = state.board.map((v, i) => (v === opponent ? i : -1)).filter((i) => i >= 0);
    const inMill = (p) => millsContaining(p).some((mill) => mill.every((m) => state.board[m] === opponent));
    const nonMill = opponentPoints.filter((p) => !inMill(p));
    const allowed = nonMill.length > 0 ? nonMill : opponentPoints;
    return allowed.includes(point);
  }

  function render(animateNew) {
    if (!state) return;

    statusEl.textContent = state.message;
    statusEl.classList.remove("status--error");
    statusEl.classList.toggle("status--win", !!state.winner);

    renderStock(stockWhiteEl, "white", state.stonesToPlace.white);
    renderStock(stockBlackEl, "black", state.stonesToPlace.black);

    document.querySelector(".player--white").classList.toggle("player--active", !state.winner && state.turn === "white");
    document.querySelector(".player--black").classList.toggle("player--active", !state.winner && state.turn === "black");

    const legalTargets = selectedPoint !== null ? legalDestinationsFrom(selectedPoint) : new Set();

    pointEls.forEach((c, i) => {
      const isEmpty = state.board[i] === null;
      c.classList.toggle("is-empty-legal", isEmpty && legalTargets.has(i));
    });

    const stoneGroup = document.getElementById("stone-group");
    state.board.forEach((owner, i) => {
      const existing = stoneEls[i];
      if (owner === null) {
        if (existing) {
          existing.remove();
          stoneEls[i] = null;
        }
        return;
      }

      let circle = existing;
      const isNew = !circle;
      if (isNew) {
        circle = document.createElementNS(SVG_NS, "circle");
        const [x, y] = state.points[i];
        circle.setAttribute("cx", x);
        circle.setAttribute("cy", y);
        circle.setAttribute("r", 0.26);
        circle.dataset.point = i;
        circle.addEventListener("click", (ev) => {
          ev.stopPropagation();
          onStoneClick(i, owner);
        });
        stoneGroup.appendChild(circle);
        stoneEls[i] = circle;
      }

      circle.setAttribute("class", `stone stone-body--${owner}` + (isNew && animateNew ? " stone-enter" : ""));

      const canSelect =
        !state.winner &&
        !busy &&
        ((state.pendingRemoval && owner !== state.turn && isRemovable(i)) ||
          (!state.pendingRemoval && state.phase === "moving" && owner === state.turn));

      circle.classList.toggle("is-selectable", canSelect);
      circle.classList.toggle("is-selected", selectedPoint === i);
      circle.classList.toggle("is-removable", !busy && !!state.pendingRemoval && owner !== state.turn && isRemovable(i));
    });
  }

  function flashMill(point, owner) {
    const mill = millsContaining(point).find((m) => m.every((p) => state.board[p] === owner));
    if (!mill) return;
    const group = document.getElementById("mill-flash-group");
    mill.forEach((p, idx) => {
      if (idx === 2) return;
      const next = mill[idx + 1];
      const [x1, y1] = state.points[p];
      const [x2, y2] = state.points[next];
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", x1);
      line.setAttribute("y1", y1);
      line.setAttribute("x2", x2);
      line.setAttribute("y2", y2);
      line.setAttribute("class", "mill-flash is-active");
      group.appendChild(line);
      line.addEventListener("animationend", () => line.remove());
    });
  }

  function showError(message) {
    statusEl.textContent = message;
    statusEl.classList.add("status--error");
    Sound.error();
  }

  // ------------------------------------------------------------- replay --

  function cloneForReplay(s) {
    return { ...s, board: s.board.slice(), stonesToPlace: { ...s.stonesToPlace }, stonesOnBoard: { ...s.stonesOnBoard } };
  }

  function applyEventToLive(live, ev) {
    const label = ev.player === "white" ? "Weiss" : "Schwarz";
    if (ev.type === "place") {
      live.board[ev.point] = ev.player;
      live.stonesToPlace[ev.player] = Math.max(0, live.stonesToPlace[ev.player] - 1);
      live.stonesOnBoard[ev.player] += 1;
      live.turn = ev.player;
      live.pendingRemoval = false;
      live.message = `${label} setzt einen Stein.`;
    } else if (ev.type === "move") {
      live.board[ev.from] = null;
      live.board[ev.to] = ev.player;
      live.turn = ev.player;
      live.pendingRemoval = false;
      live.message = `${label} zieht.`;
    } else if (ev.type === "mill") {
      live.pendingRemoval = true;
      live.turn = ev.player;
      live.message = `${label} hat eine Mühle gebildet.`;
    } else if (ev.type === "remove") {
      const opponent = ev.player === "white" ? "black" : "white";
      live.board[ev.point] = null;
      live.stonesOnBoard[opponent] = Math.max(0, live.stonesOnBoard[opponent] - 1);
      live.pendingRemoval = false;
      live.message = `${label} entfernt einen Stein.`;
    } else if (ev.type === "reset") {
      live.board = new Array(24).fill(null);
      live.phase = "placing";
      live.turn = "white";
      live.stonesToPlace = { white: 9, black: 9 };
      live.stonesOnBoard = { white: 0, black: 0 };
      live.pendingRemoval = false;
      live.winner = null;
      live.message = "Neues Spiel gestartet.";
    }
  }

  function playSoundForEvent(ev) {
    if (ev.type === "place") Sound.place();
    else if (ev.type === "move") Sound.move();
    else if (ev.type === "mill") Sound.mill();
    else if (ev.type === "remove") Sound.capture();
  }

  function maybePlayEndgameSound(data) {
    if (!data.winner) return;
    if (NET_GAME_ID) {
      if (data.winner === data.yourColor) Sound.win();
      else Sound.lose();
    } else if (data.opponent === "computer") {
      if (data.winner === data.humanColor) Sound.win();
      else Sound.lose();
    } else {
      Sound.win();
    }
  }

  async function processResult(data) {
    const events = data.events || [];
    if (events.length === 0) {
      state = data;
      render(true);
      maybePlayEndgameSound(data);
      return;
    }

    let live = cloneForReplay(state);
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      applyEventToLive(live, ev);
      state = live;
      render(true);
      if (ev.type === "mill") flashMill(ev.point, ev.player);
      playSoundForEvent(ev);
      if (i < events.length - 1) await sleep(EVENT_DELAY_MS);
    }

    state = data;
    render(true);
    maybePlayEndgameSound(data);
  }

  async function withBusy(fn) {
    if (busy) return;
    busy = true;
    document.body.classList.add("is-busy");
    try {
      await fn();
    } finally {
      busy = false;
      document.body.classList.remove("is-busy");
      render(false);
    }
  }

  // -------------------------------------------------------------- input --

  function canAct() {
    if (!state || state.winner || busy) return false;
    if (NET_GAME_ID) return state.turn === state.yourColor;
    return true;
  }

  async function onPointClick(point) {
    if (!canAct()) return;

    if (state.phase === "placing" && !state.pendingRemoval && state.board[point] === null) {
      await withBusy(() => doPlace(point));
      return;
    }

    if (state.phase === "moving" && !state.pendingRemoval && selectedPoint !== null && state.board[point] === null) {
      await withBusy(() => doMove(selectedPoint, point));
    }
  }

  async function onStoneClick(point, owner) {
    if (!canAct()) return;

    if (state.pendingRemoval) {
      if (owner !== state.turn) await withBusy(() => doRemove(point));
      return;
    }

    if (state.phase === "moving" && owner === state.turn) {
      selectedPoint = selectedPoint === point ? null : point;
      render(false);
    }
  }

  function actionUrl(name) {
    return NET_GAME_ID ? `/api/net/${NET_GAME_ID}/${name}` : `/api/${name}`;
  }

  function withToken(body) {
    return NET_GAME_ID ? { ...body, t: NET_TOKEN } : body;
  }

  async function doPlace(point) {
    try {
      const data = await api(actionUrl("place"), withToken({ point }));
      if (NET_GAME_ID) netSeq = data.seq;
      await processResult(data);
    } catch (e) {
      showError(e.message);
    }
  }

  async function doMove(from, to) {
    try {
      const data = await api(actionUrl("move"), withToken({ from, to }));
      if (NET_GAME_ID) netSeq = data.seq;
      selectedPoint = null;
      await processResult(data);
    } catch (e) {
      showError(e.message);
      selectedPoint = null;
      render(false);
    }
  }

  async function doRemove(point) {
    try {
      const data = await api(actionUrl("remove"), withToken({ point }));
      if (NET_GAME_ID) netSeq = data.seq;
      await processResult(data);
    } catch (e) {
      showError(e.message);
    }
  }

  async function loadState() {
    const data = await api("/api/state");
    buildBoardSkeleton(data.points, data.edges);
    syncSettingsUI(data);
    state = data;
    render(false);
  }

  newGameBtn.addEventListener("click", () => withBusy(async () => {
    selectedPoint = null;

    if (NET_GAME_ID) {
      const data = await api(`/api/net/${NET_GAME_ID}/new_game`, { t: NET_TOKEN });
      netSeq = data.seq;
      await processResult(data);
      return;
    }

    const data = await api("/api/new_game", { opponent: settings.opponent, color: settings.color });
    buildBoardSkeleton(data.points, data.edges);
    syncSettingsUI(data);
    state = {
      board: new Array(24).fill(null),
      phase: "placing",
      turn: "white",
      stonesToPlace: { white: 9, black: 9 },
      stonesOnBoard: { white: 0, black: 0 },
      pendingRemoval: false,
      winner: null,
      message: "Neues Spiel gestartet.",
      points: data.points,
      edges: data.edges,
      opponent: data.opponent,
      humanColor: data.humanColor,
      computerColor: data.computerColor,
    };
    render(false);
    await processResult(data);
  }));

  // --------------------------------------------------------------- network --

  function buildMailto(url) {
    const subject = encodeURIComponent("Mühle – spiel mit mir!");
    const body = encodeURIComponent(
      `Ich lade dich zu einer Partie Mühle ein. Klick auf den Link, um mitzuspielen:\n\n${url}`
    );
    return `mailto:?subject=${subject}&body=${body}`;
  }

  function setupNetworkPanel(data) {
    if (!netYourColorEl) return;
    netYourColorEl.textContent = data.yourColor === "white" ? "Weiss" : "Schwarz";

    const savedInvite = localStorage.getItem(`muehle_invite_${NET_GAME_ID}`);
    if (savedInvite) {
      inviteLinkInput.value = savedInvite;
      mailInviteBtn.href = buildMailto(savedInvite);
    } else {
      document.querySelector(".invite")?.remove();
      const panelText = document.querySelector("#network-panel p");
      if (panelText) panelText.textContent = `Du spielst als ${data.yourColor === "white" ? "Weiss" : "Schwarz"}.`;
    }
  }

  copyLinkBtn?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(inviteLinkInput.value);
      const original = copyLinkBtn.textContent;
      copyLinkBtn.textContent = "Kopiert!";
      setTimeout(() => { copyLinkBtn.textContent = original; }, 1500);
    } catch (e) {
      inviteLinkInput.select();
    }
  });

  netCreateBtn?.addEventListener("click", () => withBusy(async () => {
    try {
      const data = await api("/api/net/create", {});
      localStorage.setItem(`muehle_invite_${data.gameId}`, data.inviteUrl);
      window.location.href = data.yourUrl;
    } catch (e) {
      showError(e.message);
    }
  }));

  async function pollNetwork() {
    if (busy || !state) return;
    try {
      const data = await api(`/api/net/${NET_GAME_ID}/state?t=${encodeURIComponent(NET_TOKEN)}&since=${netSeq}`);
      if (data.events && data.events.length) {
        await processResult(data);
      }
      netSeq = data.seq;
    } catch (e) {
      // transient poll failure — retry on the next tick
    }
  }

  async function initNetwork() {
    if (!NET_TOKEN) {
      showError("Ungültiger Link: kein Zugangstoken gefunden.");
      document.querySelector(".table")?.classList.add("is-hidden");
      return;
    }
    try {
      const data = await api(`/api/net/${NET_GAME_ID}/state?t=${encodeURIComponent(NET_TOKEN)}&since=0`);
      buildBoardSkeleton(data.points, data.edges);
      netSeq = data.seq;
      state = data;
      render(false);
      setupNetworkPanel(data);
      setInterval(pollNetwork, NET_POLL_MS);
    } catch (e) {
      showError(e.message);
      document.querySelector(".table")?.classList.add("is-hidden");
      document.getElementById("network-panel")?.remove();
    }
  }

  if (NET_GAME_ID) {
    initNetwork();
  } else {
    loadState().catch((e) => showError(e.message));
  }
})();
