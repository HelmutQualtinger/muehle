import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS3DRenderer, CSS3DObject } from "three/addons/renderers/CSS3DRenderer.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

(() => {
  "use strict";

  const EVENT_DELAY_MS = 380;
  const NET_POLL_MS = 1800;

  const boardEl = document.getElementById("stage");
  const controlsSrc = document.getElementById("controls-src");
  const statusEl = document.getElementById("status");
  const stockWhiteEl = document.getElementById("stock-white");
  const stockBlackEl = document.getElementById("stock-black");
  const newGameBtn = document.getElementById("new-game-btn");
  const muteBtn = document.getElementById("mute-btn");
  const musicBtn = document.getElementById("music-btn");
  const rulesBtn = document.getElementById("rules-btn");
  const rulesModal = document.getElementById("rules-modal");
  const rulesCloseBtn = document.getElementById("rules-close-btn");
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

  // -------------------------------------------------------- background music --
  // A synthesized loop of the "Sunrise" fanfare that opens Richard Strauss's
  // "Also sprach Zarathustra" (1896) — the musical composition is public
  // domain (Strauss died 1949); this is an original oscillator rendition,
  // not a recording of any performance.

  const Music = (() => {
    let ctx = null;
    let enabled = localStorage.getItem("muehle_music") === "1";
    let playing = false;
    let timer = null;

    const LOOP_SECONDS = 42;
    const C1 = 32.7, C2 = 65.41, C3 = 130.81, G3 = 196.0, C4 = 261.63, G4 = 392.0, C5 = 523.25, E4 = 329.63;

    function ensureCtx() {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") ctx.resume();
      return ctx;
    }

    function tone(freq, start, duration, type, peak) {
      const c = ensureCtx();
      const t0 = c.currentTime + start;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(peak, t0 + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(gain).connect(c.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.05);
    }

    // Brass-ish stack: fundamental sawtooth plus a square a fifth up (for
    // bite) and a soft octave-up sine (for shimmer) — thin single oscillators
    // don't read as "brass fanfare" on their own.
    function brass(freq, start, duration, peak) {
      tone(freq, start, duration, "sawtooth", peak);
      tone(freq, start, duration, "square", peak * 0.3);
      tone(freq * 2, start, duration * 0.85, "sine", peak * 0.2);
    }

    // Trombones: an octave below the trumpet line, rounder (no square bite,
    // softer attack) — the lower brass that joins as the fanfare swells.
    function trombone(freq, start, duration, peak) {
      tone(freq / 2, start + 0.03, duration, "sawtooth", peak * 0.7);
      tone(freq / 2, start + 0.03, duration * 0.8, "triangle", peak * 0.35);
    }

    function timpaniRoll(start, duration, gap, peak) {
      for (let t = 0; t < duration; t += gap) {
        tone(C2, start + t, gap * 0.9, "triangle", peak);
      }
    }

    // The three-fold "Sunrise" fanfare — root (C4), fifth above (G4), then
    // the octave above the root (C5) struck twice, short and punchy ("Daa —
    // Daa — da-da") rather than held — over a sustained pedal C, each
    // statement louder than the last, answered by a timpani roll, resolving
    // into the climactic chord.
    const NOTE_GAP = 2.0;
    const NOTE_DUR = 2.2;
    const OCTAVE_HIT_DUR = 0.45;
    const OCTAVE_HIT_GAP = 0.55;

    function playFanfareOnce() {
      tone(C1, 0, 40, "sine", 0.05);
      tone(C2, 0, 40, "sine", 0.07); // pedal drone

      const statements = [
        { base: 1.5, peak: 0.045, rollPeak: 0.03, rollGap: 0.2, rollDur: 0.9, trombones: false },
        { base: 13.0, peak: 0.08, rollPeak: 0.06, rollGap: 0.16, rollDur: 1.1, trombones: true },
        { base: 24.5, peak: 0.13, rollPeak: 0.09, rollGap: 0.12, rollDur: 1.6, trombones: true },
      ];
      statements.forEach(({ base, peak, rollPeak, rollGap, rollDur, trombones }) => {
        brass(C4, base, NOTE_DUR, peak);
        brass(G4, base + NOTE_GAP, NOTE_DUR, peak);
        const c5At = base + NOTE_GAP * 2;
        brass(C5, c5At, OCTAVE_HIT_DUR, peak + 0.02);
        brass(C5, c5At + OCTAVE_HIT_GAP, OCTAVE_HIT_DUR, peak + 0.03);
        timpaniRoll(c5At + OCTAVE_HIT_GAP, rollDur, rollGap, rollPeak);
        if (trombones) {
          trombone(C4, base, NOTE_DUR, peak);
          trombone(G4, base + NOTE_GAP, NOTE_DUR, peak);
          trombone(C5, c5At, OCTAVE_HIT_DUR, peak + 0.02);
          trombone(C5, c5At + OCTAVE_HIT_GAP, OCTAVE_HIT_DUR, peak + 0.03);
        }
      });

      // Climactic chord — full brass, trombones anchoring the bottom.
      const chordAt = 34.0;
      [C3, G3, C4, G4, C5, E4].forEach((f) => tone(f, chordAt, 4.2, "sawtooth", 0.09));
      [C2, C3, G3].forEach((f) => trombone(f * 2, chordAt, 4.0, 0.13));
      timpaniRoll(chordAt, 2.2, 0.14, 0.09);
      // A long silence tail before the loop repeats.
    }

    function scheduleLoop() {
      if (!playing) return;
      playFanfareOnce();
      timer = setTimeout(() => { if (playing) scheduleLoop(); }, LOOP_SECONDS * 1000);
    }

    function start() {
      if (playing) return;
      playing = true;
      ensureCtx();
      scheduleLoop();
    }

    function stop() {
      playing = false;
      if (timer) clearTimeout(timer);
      timer = null;
    }

    return {
      toggle() {
        enabled = !enabled;
        localStorage.setItem("muehle_music", enabled ? "1" : "0");
        if (enabled) start(); else stop();
        return enabled;
      },
      isEnabled() { return enabled; },
      resumeIfEnabled() { if (enabled) start(); },
    };
  })();

  document.addEventListener("pointerdown", () => Music.resumeIfEnabled(), { once: true });

  function updateMusicUI() {
    const on = Music.isEnabled();
    musicBtn.textContent = on ? "🎵" : "🎵🚫";
    musicBtn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  musicBtn.addEventListener("click", () => {
    Music.toggle();
    updateMusicUI();
  });
  updateMusicUI();
  updateMuteUI();

  // ------------------------------------------------------------ rules modal --

  function openRulesModal() {
    rulesModal.hidden = false;
  }

  function closeRulesModal() {
    rulesModal.hidden = true;
  }

  rulesBtn.addEventListener("click", openRulesModal);
  rulesCloseBtn.addEventListener("click", closeRulesModal);
  rulesModal.querySelector(".rules-modal__backdrop").addEventListener("click", closeRulesModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !rulesModal.hidden) closeRulesModal();
  });

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

  // ------------------------------------------------------------- 3D scene --

  const STONE_RADIUS = 0.34;
  const STONE_HEIGHT = 0.22;
  const MARKER_HEIGHT = 0.03;
  const STONE_Y = MARKER_HEIGHT + STONE_HEIGHT / 2;
  const BRASS = 0xf0d29a;
  const MILL_GLOW = 0xff6a4d;
  const CSS3D_SCALE = 0.01; // 1 CSS px == 0.01 world units

  // Ground-level glow halo shown under a stone: red for "you may capture
  // this", green for "the opponent just placed/moved this one".
  const AURA_INNER = STONE_RADIUS + 0.05;
  const AURA_OUTER = STONE_RADIUS + 0.26;
  const AURA_Y = MARKER_HEIGHT + 0.004;
  const AURA_RED = 0xff3b30;
  const AURA_GREEN = 0x3ee27a;

  const stoneGeometry = new THREE.CylinderGeometry(STONE_RADIUS - 0.02, STONE_RADIUS, STONE_HEIGHT, 40);
  const pointMarkerGeometry = new THREE.CylinderGeometry(0.13, 0.15, MARKER_HEIGHT, 24);
  const pointHitGeometry = new THREE.CylinderGeometry(0.42, 0.42, 0.5, 16);
  const auraGeometry = new THREE.RingGeometry(AURA_INNER, AURA_OUTER, 48);

  let sceneReady = false;
  let renderer, cssRenderer, scene, cssScene, camera, controls;
  let lineGroup, pointGroup, stoneGroup, boardMesh;
  let spaceshipGroup = null;
  let worldPoints = [];
  let pointMarkerMeshes = [];
  let pointHitMeshes = [];
  let auraMeshes = [];
  let lineMeshByKey = new Map();
  let stoneEls = new Array(24).fill(null); // { mesh, baseY }
  let popTweens = [];
  let millTweens = [];
  let raycaster = new THREE.Raycaster();
  let pointerDownAt = null;
  let marbleColorTex, marbleBumpTex, metalRoughTex, stoneNoiseTex, stoneCapTex, stoneCapNormalTex, boardUndersideTex;
  let lastSetPoint = null;
  let lastSetOwner = null;

  function edgeKey(a, b) {
    return a < b ? `${a}_${b}` : `${b}_${a}`;
  }

  function backOut(t) {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  // -------------------------------------------------- procedural textures --
  // Generated on a <canvas> at startup rather than shipped as image assets,
  // matching the "no bundler, no binary assets" approach used elsewhere
  // (e.g. the parchment's noise texture) — see CLAUDE.md.

  function makeCanvas(size) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    return c;
  }

  // Wandering, branching vein strokes (unlike wood grain's parallel lines,
  // marble veins meander at all angles and fork) shared by the color and
  // bump variants so the two stay registered with each other. An optional
  // glow ({color, blur}) softens each stroke into a blurred, luminous line
  // instead of a crisp one — canvas shadowBlur is a real blur filter, so it
  // both softens the vein's edge and gives it a halo in one pass.
  function drawMarbleVeins(ctx, size, strokeFn, glow) {
    if (glow) {
      ctx.shadowColor = glow.color;
      ctx.shadowBlur = glow.blur;
    }
    for (let i = 0; i < 22; i++) {
      let x = Math.random() * size;
      let y = Math.random() * size;
      let angle = Math.random() * Math.PI * 2;
      const segments = 40 + Math.floor(Math.random() * 70);
      ctx.strokeStyle = strokeFn();
      ctx.lineWidth = 0.6 + Math.random() * 1.8;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let s = 0; s < segments; s++) {
        angle += (Math.random() - 0.5) * 0.9;
        x += Math.cos(angle) * 6;
        y += Math.sin(angle) * 6;
        ctx.lineTo(x, y);
        if (Math.random() < 0.04 && s < segments - 8) {
          // occasional fork, a short branch off the main vein
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x, y);
        }
      }
      ctx.stroke();
    }
    if (glow) ctx.shadowBlur = 0;
  }

  // Shared green-marble base (gradient + cloudy blotches + glowing veins),
  // used for both the board's visible top and its hidden underside so they
  // read as the same stone.
  function paintMarbleBase(ctx, size) {
    const grad = ctx.createLinearGradient(0, 0, size, size);
    grad.addColorStop(0, "#173d30");
    grad.addColorStop(0.5, "#215945");
    grad.addColorStop(1, "#1a4536");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    // soft cloudy blotches beneath the veining, typical of natural stone —
    // a mix of lighter and darker green patches for depth
    for (let i = 0; i < 10; i++) {
      const cx = Math.random() * size, cy = Math.random() * size, r = size * (0.08 + Math.random() * 0.21);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      const light = Math.random() > 0.5;
      g.addColorStop(0, light ? "rgba(120, 165, 140, 0.14)" : "rgba(10, 30, 22, 0.16)");
      g.addColorStop(1, light ? "rgba(120, 165, 140, 0)" : "rgba(10, 30, 22, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // Verde-marble veining: pale cream veins with occasional near-black
    // ones, softened and glowing rather than crisp hairlines.
    drawMarbleVeins(
      ctx,
      size,
      () =>
        Math.random() > 0.3
          ? `rgba(226, 228, 210, ${0.14 + Math.random() * 0.24})`
          : `rgba(12, 24, 18, ${0.15 + Math.random() * 0.2})`,
      { color: "rgba(206, 244, 200, 0.65)", blur: size * 0.016 }
    );
  }

  function makeMarbleColorTexture() {
    const size = 512;
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext("2d");
    paintMarbleBase(ctx, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  function makeMarbleBumpTexture() {
    const size = 512;
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, size, size);
    // Polished marble is otherwise flat, so keep the veins as the only
    // relief — a shallow groove along each vein, not a raised ridge.
    drawMarbleVeins(ctx, size, () => "rgba(0,0,0,0.1)");
    const tex = new THREE.CanvasTexture(canvas);
    return tex;
  }

  // A hidden note on the underside of the board — the -y face never faces
  // the camera in normal play (the camera stays high, looking down), so
  // this is a little easter egg for anyone who flips the board around: the
  // full rule set, engraved in the same blackletter face as the rules
  // modal's parchment (.parchment__rules in style.css).
  const UNDERSIDE_RULES = [
    ["Setzphase.", "Jede Seite setzt 9 Steine, abwechselnd."],
    ["Mühle.", "Drei in einer Reihe schlägt einen Stein."],
    ["Schutz.", "Steine in einer Mühle sind sicher."],
    ["Zugphase.", "Danach zieht man auf freie Nachbarn."],
    ["Fliegen.", "Bei 3 Steinen darf man springen."],
    ["Sieg.", "Wer nur noch 2 Steine hat, verliert."],
  ];
  const UNDERSIDE_FONT = 'UnifrakturMaguntia, Cinzel, Georgia, serif';

  function paintBoardUndersideTexture(ctx, size) {
    paintMarbleBase(ctx, size);
    const lineHeight = 72;
    const titleHeight = 120;
    const blockHeight = titleHeight + UNDERSIDE_RULES.length * lineHeight + 60;
    const top = size / 2 - blockHeight / 2;
    // A dark scrim behind the text keeps it legible over the marble's
    // glowing veins without hiding them entirely.
    ctx.fillStyle = "rgba(10, 20, 16, 0.5)";
    ctx.fillRect(size * 0.06, top, size * 0.88, blockHeight);

    ctx.textBaseline = "alphabetic";
    ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
    ctx.shadowBlur = 10;

    ctx.textAlign = "center";
    ctx.fillStyle = "#f3e6c2";
    ctx.font = `56px ${UNDERSIDE_FONT}`;
    ctx.fillText("Die Regeln", size / 2, top + 78);

    ctx.textAlign = "left";
    ctx.font = `32px ${UNDERSIDE_FONT}`;
    const textLeft = size * 0.09;
    let y = top + titleHeight + 44;
    UNDERSIDE_RULES.forEach(([label, body]) => {
      ctx.fillStyle = "#e8c98a";
      ctx.fillText(label, textLeft, y);
      const labelWidth = ctx.measureText(label + " ").width;
      ctx.fillStyle = "#f3e6c2";
      ctx.fillText(body, textLeft + labelWidth, y);
      y += lineHeight;
    });
    ctx.shadowBlur = 0;
  }

  function makeBoardUndersideTexture() {
    const size = 1024;
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext("2d");
    paintBoardUndersideTexture(ctx, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    // UnifrakturMaguntia is a webfont loaded via Google Fonts; if it hasn't
    // finished downloading yet, the paint above silently falls back to the
    // generic serif. Repaint once it's actually ready so the underside
    // always reads in gothic script, not just after a cache-warm reload.
    if (document.fonts && document.fonts.load) {
      document.fonts
        .load(`56px ${UNDERSIDE_FONT}`)
        .then(() => document.fonts.load(`32px ${UNDERSIDE_FONT}`))
        .then(() => {
          paintBoardUndersideTexture(ctx, size);
          tex.needsUpdate = true;
        })
        .catch(() => {});
    }
    return tex;
  }

  function makeSpeckleTexture(size) {
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 128 + (Math.random() - 0.5) * 70;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  // Fewer, wider bands than a fine sine read reliably even when the stone
  // occupies only a small part of the screen (a fine pattern gets
  // mip-blurred to flat gray at a distance; thick bands survive). Height is
  // in [-1, 1]; the tanh sharpens a soft sine into near-flat ridges/grooves
  // with a narrow transition, reading as much deeper grooves once amplified.
  const STONE_RING_COUNT = 4;
  function stoneRingHeight(rFrac) {
    const r = Math.min(1, rFrac);
    return Math.tanh(Math.sin(r * STONE_RING_COUNT * Math.PI * 2) * 3.2);
  }

  // Concentric turned-groove rings like a draughts/checkers piece, radiating
  // out from the texture's center. CylinderGeometry maps a cap's UVs to a
  // circle inscribed in the square texture (center 0.5,0.5, radius 0.5), so
  // this lines up as true rings when used on the stone's top/bottom caps.
  // Used as a roughnessMap (grayscale height, not physically a normal).
  function makeStoneCapTexture(size) {
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(size, size);
    const cx = size / 2;
    const cy = size / 2;
    const maxR = size * 0.5;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const ring = stoneRingHeight(Math.sqrt(dx * dx + dy * dy) / maxR) * 120;
        const speckle = (Math.random() - 0.5) * 12;
        const v = 128 + ring + speckle;
        const idx = (y * size + x) * 4;
        img.data[idx] = img.data[idx + 1] = img.data[idx + 2] = v;
        img.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    return tex;
  }

  // A proper tangent-space normal map (not a bump/height map) derived from
  // the same ring height field via finite differences. Normal maps drive
  // lighting far more strongly and reliably than bumpMap's on-the-fly
  // derivative, and are what MeshPhysicalMaterial.clearcoatNormalMap
  // requires — without this the glossy clearcoat sits smooth on top and
  // visually flattens the grooves, especially on the lighter stones.
  function makeStoneCapNormalTexture(size) {
    const cx = size / 2;
    const cy = size / 2;
    const maxR = size * 0.5;
    const height = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - cx;
        const dy = y - cy;
        height[y * size + x] = stoneRingHeight(Math.sqrt(dx * dx + dy * dy) / maxR);
      }
    }
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(size, size);
    const strength = 6;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const x1 = Math.min(size - 1, x + 1);
        const y1 = Math.min(size - 1, y + 1);
        const hc = height[y * size + x];
        const nx = -(height[y * size + x1] - hc) * strength;
        const ny = -(height[y1 * size + x] - hc) * strength;
        const nz = 1;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        const idx = (y * size + x) * 4;
        img.data[idx] = (nx / len) * 0.5 * 255 + 127.5;
        img.data[idx + 1] = (ny / len) * 0.5 * 255 + 127.5;
        img.data[idx + 2] = (nz / len) * 0.5 * 255 + 127.5;
        img.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    return tex;
  }

  function makeSkyTexture() {
    const w = 1024, h = 512;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "#04060d");
    grad.addColorStop(0.35, "#0a1130");
    grad.addColorStop(0.55, "#0d1a42");
    grad.addColorStop(0.78, "#0a1130");
    grad.addColorStop(1, "#03040a");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // soft distant galaxies / nebulae
    [
      { x: 0.18 * w, y: 0.32 * h, r: 150, c: "rgba(130, 95, 210, 0.24)" },
      { x: 0.78 * w, y: 0.2 * h, r: 120, c: "rgba(80, 165, 215, 0.2)" },
      { x: 0.55 * w, y: 0.66 * h, r: 170, c: "rgba(205, 110, 175, 0.16)" },
      { x: 0.35 * w, y: 0.78 * h, r: 100, c: "rgba(90, 130, 220, 0.14)" },
    ].forEach(({ x, y, r, c }) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, c);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.random() * Math.PI);
      ctx.scale(1, 0.55);
      ctx.translate(-x, -y);
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      ctx.restore();
    });

    // faint milky-way band
    ctx.save();
    ctx.translate(w * 0.5, h * 0.42);
    ctx.rotate(-0.22);
    const band = ctx.createLinearGradient(-w, 0, w, 0);
    band.addColorStop(0, "rgba(255,255,255,0)");
    band.addColorStop(0.5, "rgba(210,220,255,0.10)");
    band.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = band;
    ctx.fillRect(-w, -h * 0.1, w * 2, h * 0.2);
    ctx.restore();

    // scattered stars
    for (let i = 0; i < 700; i++) {
      const x = Math.random() * w;
      const y = Math.random() * h;
      const r = Math.random() * 1.3 + 0.2;
      ctx.fillStyle = `rgba(255,255,255,${0.35 + Math.random() * 0.55})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // a handful of brighter, glowing stars
    for (let i = 0; i < 16; i++) {
      const x = Math.random() * w;
      const y = Math.random() * h * 0.92;
      const g = ctx.createRadialGradient(x, y, 0, x, y, 6);
      g.addColorStop(0, "rgba(255,255,255,0.9)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.mapping = THREE.EquirectangularReflectionMapping;
    return tex;
  }

  function makeStarField() {
    const count = 900;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 44 + Math.random() * 6;
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.16,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    return new THREE.Points(geo, mat);
  }

  // A small stylized TOS-era starship (saucer + neck + engineering hull +
  // twin nacelles) that drifts through the night-sky backdrop. Built from
  // primitives only — no model asset — so it stays a light background prop.
  function makeSpaceship() {
    const group = new THREE.Group();

    const hullMat = new THREE.MeshStandardMaterial({
      color: 0xe8e4d8,
      roughness: 0.4,
      metalness: 0.25,
      envMapIntensity: 0.9,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x8a9a5b,
      roughness: 0.5,
      metalness: 0.15,
    });
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x2c2c30,
      roughness: 0.5,
      metalness: 0.3,
    });
    const bussardMat = new THREE.MeshStandardMaterial({
      color: 0xff5a2a,
      emissive: 0xff3a10,
      emissiveIntensity: 1.6,
      roughness: 0.3,
    });
    const deflectorMat = new THREE.MeshStandardMaterial({
      color: 0xffb060,
      emissive: 0xff8030,
      emissiveIntensity: 1,
      roughness: 0.3,
    });

    // primary hull (saucer section)
    const saucer = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.05, 0.16, 40), hullMat);
    group.add(saucer);
    const saucerTrim = new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.03, 8, 40), trimMat);
    saucerTrim.rotation.x = Math.PI / 2;
    saucerTrim.position.y = 0.06;
    group.add(saucerTrim);
    const bridge = new THREE.Mesh(new THREE.SphereGeometry(0.22, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), hullMat);
    bridge.position.y = 0.08;
    group.add(bridge);

    // neck strut down to the engineering hull
    const neck = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.42, 0.46), hullMat);
    neck.position.set(0, -0.28, -0.82);
    neck.rotation.x = 0.55;
    group.add(neck);

    // secondary (engineering) hull, capsule-shaped
    const secHull = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 1.5, 20), hullMat);
    secHull.rotation.x = Math.PI / 2;
    secHull.position.set(0, -0.55, -1.75);
    group.add(secHull);
    const secFrontCap = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), hullMat);
    secFrontCap.position.set(0, -0.55, -1.0);
    group.add(secFrontCap);
    const secRearCap = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), hullMat);
    secRearCap.position.set(0, -0.55, -2.5);
    group.add(secRearCap);
    const deflector = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), deflectorMat);
    deflector.position.set(0, -0.55, -0.95);
    group.add(deflector);

    // twin warp nacelles on pylons
    [-1, 1].forEach((side) => {
      const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.34, 0.95), hullMat);
      pylon.position.set(side * 0.55, -0.16, -2.0);
      pylon.rotation.x = -0.25;
      pylon.rotation.z = side * 0.1;
      group.add(pylon);

      const nacelle = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 1.7, 20), hullMat);
      nacelle.rotation.x = Math.PI / 2;
      nacelle.position.set(side * 0.72, 0.05, -2.05);
      group.add(nacelle);

      const nacelleTrim = new THREE.Mesh(new THREE.CylinderGeometry(0.145, 0.145, 0.05, 20), darkMat);
      nacelleTrim.rotation.x = Math.PI / 2;
      nacelleTrim.position.set(side * 0.72, 0.05, -1.75);
      group.add(nacelleTrim);

      const bussard = new THREE.Mesh(new THREE.SphereGeometry(0.145, 16, 12), bussardMat);
      bussard.position.set(side * 0.72, 0.05, -1.2);
      group.add(bussard);
    });

    group.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = false;
        obj.receiveShadow = false;
      }
    });
    group.scale.setScalar(1.4);
    return group;
  }

  function initThree() {
    if (sceneReady) return;
    sceneReady = true;

    scene = new THREE.Scene();
    cssScene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(46, 1, 0.1, 100);
    camera.position.set(0, 8.6, 8.4);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    boardEl.appendChild(renderer.domElement);

    // Procedural IBL so the brass/stone materials get real specular
    // reflections instead of looking flat-shaded — no HDR asset needed.
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    marbleColorTex = makeMarbleColorTexture();
    marbleBumpTex = makeMarbleBumpTexture();
    boardUndersideTex = makeBoardUndersideTexture();
    metalRoughTex = makeSpeckleTexture(256);
    stoneNoiseTex = makeSpeckleTexture(256);
    stoneCapTex = makeStoneCapTexture(256);
    stoneCapNormalTex = makeStoneCapNormalTexture(256);
    // Mipmapping would blur the rings to flat gray once a stone is more
    // than a couple hundred pixels away from the camera — keep full detail
    // at any distance instead.
    stoneCapTex.generateMipmaps = false;
    stoneCapTex.minFilter = THREE.LinearFilter;
    stoneCapNormalTex.generateMipmaps = false;
    stoneCapNormalTex.minFilter = THREE.LinearFilter;
    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    [marbleColorTex, marbleBumpTex, metalRoughTex, stoneNoiseTex, stoneCapTex, stoneCapNormalTex].forEach((t) => { t.anisotropy = maxAniso; });

    // Night-sky backdrop: a starfield + soft galaxy blobs painted on a
    // canvas and mapped as a proper rotating skybox (not a flat CSS image),
    // plus a THREE.Points layer for crisp pinpoint stars on top.
    scene.background = makeSkyTexture();
    scene.add(makeStarField());

    spaceshipGroup = makeSpaceship();
    scene.add(spaceshipGroup);

    cssRenderer = new CSS3DRenderer();
    cssRenderer.domElement.classList.add("css3d-layer");
    boardEl.appendChild(cssRenderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.4, -1.1);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.zoomSpeed = 0.8;
    controls.minDistance = 3.5;
    controls.maxDistance = 28;
    controls.minPolarAngle = 0.25;
    controls.maxPolarAngle = Math.PI - 0.25;
    controls.enablePan = false;

    scene.add(new THREE.AmbientLight(0xfff6e4, 0.75));

    const key = new THREE.DirectionalLight(0xffedc4, 1.15);
    key.position.set(4, 8, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -7;
    key.shadow.camera.right = 7;
    key.shadow.camera.top = 7;
    key.shadow.camera.bottom = -7;
    scene.add(key);

    const fill = new THREE.DirectionalLight(0xd8e4ff, 0.3);
    fill.position.set(-5, 4, -4);
    scene.add(fill);

    const boardGeo = new THREE.BoxGeometry(8.4, 0.5, 8.4);
    const boardMat = new THREE.MeshPhysicalMaterial({
      map: marbleColorTex,
      bumpMap: marbleBumpTex,
      bumpScale: 0.008,
      roughness: 0.32,
      roughnessMap: metalRoughTex,
      metalness: 0.02,
      clearcoat: 0.5,
      clearcoatRoughness: 0.25,
      envMapIntensity: 0.9,
    });
    const boardBottomMat = new THREE.MeshStandardMaterial({
      map: boardUndersideTex,
      roughness: 0.7,
      metalness: 0,
    });
    // BoxGeometry face/material-group order is [+x, -x, +y, -y, +z, -z] —
    // slot 3 is the underside, the one face the camera never sees.
    boardMesh = new THREE.Mesh(boardGeo, [boardMat, boardMat, boardMat, boardBottomMat, boardMat, boardMat]);
    boardMesh.position.y = -0.25;
    boardMesh.receiveShadow = true;
    scene.add(boardMesh);

    lineGroup = new THREE.Group();
    pointGroup = new THREE.Group();
    stoneGroup = new THREE.Group();
    scene.add(lineGroup, pointGroup, stoneGroup);

    setupControls();

    new ResizeObserver(onResize).observe(boardEl);
    onResize();
    // CSS3DObject elements only enter the live document once CSS3DRenderer
    // has rendered at least one frame — do that synchronously now so code
    // that immediately queries the document (e.g. the first render() call)
    // doesn't see them as detached.
    cssRenderer.render(cssScene, camera);

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointermove", onPointerMove);

    requestAnimationFrame(animate);
  }

  function onResize() {
    const w = boardEl.clientWidth;
    const h = boardEl.clientHeight || w;
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    cssRenderer.setSize(w, h);
  }

  // ---------------------------------------------------- 3D-embedded controls --

  function mountControl(el, x, y, z, rotX = 0, rotY = 0, rotZ = 0) {
    if (!el) return;
    el.remove();
    const obj = new CSS3DObject(el);
    obj.position.set(x, y, z);
    obj.rotation.set(rotX, rotY, rotZ);
    obj.scale.set(CSS3D_SCALE, CSS3D_SCALE, CSS3D_SCALE);
    cssScene.add(obj);
    return obj;
  }

  function setupControls() {
    mountControl(controlsSrc.querySelector(".header__actions"), 0, 2.7, -6.3, -0.3);
    mountControl(controlsSrc.querySelector("#local-settings"), 0, 1.8, -5.5, -0.3);
    mountControl(controlsSrc.querySelector("#network-panel"), 0, 1.8, -5.5, -0.3);
    mountControl(controlsSrc.querySelector("#status"), 0, 1.15, -4.8, -0.3);
    mountControl(controlsSrc.querySelector(".player--black"), -5.3, 0.85, -0.5, -0.08, 0.7);
    mountControl(controlsSrc.querySelector(".player--white"), 5.3, 0.85, -0.5, -0.08, -0.7);
  }

  function animate(now) {
    requestAnimationFrame(animate);
    controls.update();

    popTweens = popTweens.filter((pt) => {
      const t = Math.min(1, (now - pt.start) / 260);
      pt.mesh.scale.setScalar(t >= 1 ? 1 : Math.max(0, backOut(t)));
      return t < 1;
    });

    millTweens = millTweens.filter((mt) => {
      const t = Math.min(1, (now - mt.start) / 900);
      mt.mesh.material.emissive.setHex(MILL_GLOW);
      mt.mesh.material.emissiveIntensity = 0.9 * (1 - t);
      return t < 1;
    });

    const pulse = 0.5 + 0.5 * Math.sin(now * 0.005);
    pointMarkerMeshes.forEach((m) => {
      if (!m) return;
      if (m.userData.legal) {
        m.material.emissive.setHex(BRASS);
        m.material.emissiveIntensity = 0.25 + 0.5 * pulse;
      } else {
        m.material.emissiveIntensity = 0;
      }
    });

    auraMeshes.forEach((aura) => {
      if (!aura || !aura.visible) return;
      aura.material.opacity = 0.35 + 0.4 * pulse;
      const scale = 1 + 0.06 * pulse;
      aura.scale.set(scale, scale, 1);
    });

    stoneEls.forEach((entry) => {
      if (!entry) return;
      const { mesh } = entry;
      if (mesh.userData.removable) {
        setStoneEmissive(mesh, MILL_GLOW, 0.15 + 0.45 * pulse);
      } else if (mesh.userData.selected) {
        setStoneEmissive(mesh, BRASS, 0.3 + 0.3 * pulse);
      } else {
        mesh.material.forEach((m) => { m.emissiveIntensity = 0; });
      }
      const targetY = entry.baseY + (mesh.userData.selected ? 0.12 : 0);
      mesh.position.y += (targetY - mesh.position.y) * 0.2;
    });

    if (spaceshipGroup) {
      // The camera sits high and always looks down toward the board, so
      // the only part of the sky actually inside its view cone is a low
      // band just above table height, well behind the board — not high
      // overhead. Cruise the ship back and forth through that band.
      const t = now * 0.00015;
      const cx = 0, cz = -11, radiusX = 10, radiusZ = 2, baseY = 0.7, bobAmp = 0.25;
      const pos = (a) => new THREE.Vector3(
        cx + radiusX * Math.sin(a),
        baseY + Math.sin(a * 0.5) * bobAmp,
        cz + radiusZ * Math.cos(a),
      );
      const here = pos(t);
      const ahead = pos(t + 0.01);
      spaceshipGroup.position.copy(here);
      spaceshipGroup.lookAt(ahead);
    }

    renderer.render(scene, camera);
    cssRenderer.render(cssScene, camera);
  }

  function clearGroup(group) {
    while (group.children.length) {
      const child = group.children.pop();
      group.remove(child);
      child.geometry?.dispose();
      child.material?.dispose();
    }
  }

  function disposeStones() {
    stoneEls.forEach((entry) => {
      if (!entry) return;
      stoneGroup.remove(entry.mesh);
      disposeMaterial(entry.mesh.material);
    });
    stoneEls = new Array(24).fill(null);
  }

  function makeLineMesh(pa, pb) {
    const dir = new THREE.Vector3().subVectors(pb, pa);
    const length = dir.length();
    const mid = new THREE.Vector3().addVectors(pa, pb).multiplyScalar(0.5);
    const geo = new THREE.BoxGeometry(length, 0.045, 0.09);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xdcb571,
      roughness: 0.3,
      roughnessMap: metalRoughTex,
      metalness: 0.8,
      envMapIntensity: 1.15,
      emissive: 0x000000,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(mid.x, 0.008, mid.z);
    mesh.rotation.y = -Math.atan2(dir.z, dir.x);
    mesh.receiveShadow = true;
    return mesh;
  }

  function makeStoneMesh(owner) {
    const isWhite = owner === "white";
    const base = {
      color: isWhite ? 0xe9d6a8 : 0x211c16,
      roughness: isWhite ? 0.4 : 0.35,
      metalness: isWhite ? 0.06 : 0.1,
      clearcoat: 0.6,
      clearcoatRoughness: 0.22,
      envMapIntensity: 1,
      emissive: 0x000000,
    };
    // Side (torso) keeps the plain speckled finish; top/bottom caps get the
    // concentric turned-groove rings of a draughts/checkers piece.
    const sideMat = new THREE.MeshPhysicalMaterial({
      ...base,
      roughnessMap: stoneNoiseTex,
      bumpMap: stoneNoiseTex,
      bumpScale: 0.004,
    });
    const capMat = new THREE.MeshPhysicalMaterial({
      ...base,
      roughnessMap: stoneCapTex,
      normalMap: stoneCapNormalTex,
      normalScale: new THREE.Vector2(1.8, 1.8),
      // Perturb the glossy clearcoat layer too, not just the base coat —
      // otherwise the smooth clearcoat sits on top and visually flattens
      // the grooves, especially on the lighter (white) stones.
      clearcoatNormalMap: stoneCapNormalTex,
      clearcoatNormalScale: new THREE.Vector2(1.4, 1.4),
    });
    const mesh = new THREE.Mesh(stoneGeometry, [sideMat, capMat, capMat]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  function setStoneEmissive(mesh, hex, intensity) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mats.forEach((m) => {
      m.emissive.setHex(hex);
      m.emissiveIntensity = intensity;
    });
  }

  function disposeMaterial(material) {
    if (Array.isArray(material)) {
      material.forEach((m) => m.dispose());
    } else {
      material.dispose();
    }
  }

  function buildBoardSkeleton(points, edges) {
    initThree();
    disposeStones();
    clearGroup(lineGroup);
    clearGroup(pointGroup);
    lineMeshByKey.clear();
    pointMarkerMeshes = [];
    pointHitMeshes = [];
    auraMeshes = [];
    selectedPoint = null;
    lastSetPoint = null;
    lastSetOwner = null;

    worldPoints = points.map(([x, y]) => new THREE.Vector3(x - 3, 0, y - 3));

    edges.forEach(([a, b]) => {
      const mesh = makeLineMesh(worldPoints[a], worldPoints[b]);
      lineGroup.add(mesh);
      lineMeshByKey.set(edgeKey(a, b), mesh);
    });

    points.forEach((_, i) => {
      const pos = worldPoints[i];

      const marker = new THREE.Mesh(
        pointMarkerGeometry,
        new THREE.MeshStandardMaterial({
          color: 0x2e5445,
          bumpMap: marbleBumpTex,
          bumpScale: 0.012,
          roughness: 0.4,
          roughnessMap: metalRoughTex,
          metalness: 0.04,
          envMapIntensity: 0.7,
          emissive: 0x000000,
        })
      );
      marker.position.set(pos.x, MARKER_HEIGHT / 2, pos.z);
      marker.receiveShadow = true;
      pointGroup.add(marker);
      pointMarkerMeshes[i] = marker;

      const hit = new THREE.Mesh(
        pointHitGeometry,
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
      );
      hit.position.set(pos.x, 0.12, pos.z);
      hit.userData.point = i;
      pointGroup.add(hit);
      pointHitMeshes[i] = hit;

      const aura = new THREE.Mesh(
        auraGeometry,
        new THREE.MeshBasicMaterial({
          color: AURA_RED,
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      aura.rotation.x = -Math.PI / 2;
      aura.position.set(pos.x, AURA_Y, pos.z);
      aura.visible = false;
      pointGroup.add(aura);
      auraMeshes[i] = aura;
    });
  }

  // ------------------------------------------------------------- picking --

  function ndcFromEvent(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
  }

  function raycastPick(e) {
    raycaster.setFromCamera(ndcFromEvent(e), camera);

    const stoneMeshes = stoneEls.filter(Boolean).map((entry) => entry.mesh);
    const stoneHits = raycaster.intersectObjects(stoneMeshes, false);
    if (stoneHits.length) {
      const mesh = stoneHits[0].object;
      return { kind: "stone", point: mesh.userData.point, owner: mesh.userData.owner };
    }

    const hitMeshes = pointHitMeshes.filter(Boolean);
    const pointHits = raycaster.intersectObjects(hitMeshes, false);
    if (pointHits.length) {
      return { kind: "point", point: pointHits[0].object.userData.point };
    }
    return null;
  }

  function onPointerDown(e) {
    pointerDownAt = { x: e.clientX, y: e.clientY };
  }

  function onPointerUp(e) {
    if (!pointerDownAt) return;
    const dx = e.clientX - pointerDownAt.x;
    const dy = e.clientY - pointerDownAt.y;
    pointerDownAt = null;
    if (Math.hypot(dx, dy) > 6) return; // treat as a camera drag, not a click

    const hit = raycastPick(e);
    if (!hit) return;
    if (hit.kind === "stone") onStoneClick(hit.point, hit.owner);
    else onPointClick(hit.point);
  }

  function onPointerMove(e) {
    if (!renderer) return;
    const hit = busy ? null : raycastPick(e);
    renderer.domElement.style.cursor = busy ? "wait" : hit ? "pointer" : "grab";
  }

  // --------------------------------------------------------------- board --

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

    pointMarkerMeshes.forEach((m, i) => {
      if (!m) return;
      const isEmpty = state.board[i] === null;
      m.userData.legal = isEmpty && legalTargets.has(i);
    });

    state.board.forEach((owner, i) => {
      const existing = stoneEls[i];
      if (owner === null) {
        if (existing) {
          stoneGroup.remove(existing.mesh);
          disposeMaterial(existing.mesh.material);
          stoneEls[i] = null;
        }
        return;
      }

      let entry = existing;
      if (!entry) {
        const mesh = makeStoneMesh(owner);
        const pos = worldPoints[i];
        mesh.position.set(pos.x, STONE_Y, pos.z);
        mesh.userData.point = i;
        mesh.userData.owner = owner;
        stoneGroup.add(mesh);
        entry = { mesh, baseY: STONE_Y };
        stoneEls[i] = entry;
        if (animateNew) {
          mesh.scale.setScalar(0);
          popTweens.push({ mesh, start: performance.now() });
        }
      }

      entry.mesh.userData.removable = !busy && !!state.pendingRemoval && owner !== state.turn && isRemovable(i);
      entry.mesh.userData.selected = selectedPoint === i;
    });

    auraMeshes.forEach((aura, i) => {
      if (!aura) return;
      const entry = stoneEls[i];
      if (!entry) {
        aura.visible = false;
        return;
      }
      if (entry.mesh.userData.removable) {
        aura.visible = true;
        aura.material.color.setHex(AURA_RED);
      } else if (i === lastSetPoint && lastSetOwner !== null && entry.mesh.userData.owner !== state.turn) {
        aura.visible = true;
        aura.material.color.setHex(AURA_GREEN);
      } else {
        aura.visible = false;
      }
    });
  }

  function flashMill(point, owner) {
    const mill = millsContaining(point).find((m) => m.every((p) => state.board[p] === owner));
    if (!mill) return;
    [[mill[0], mill[1]], [mill[1], mill[2]]].forEach(([a, b]) => {
      const mesh = lineMeshByKey.get(edgeKey(a, b));
      if (mesh) millTweens.push({ mesh, start: performance.now() });
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
      lastSetPoint = ev.point;
      lastSetOwner = ev.player;
    } else if (ev.type === "move") {
      live.board[ev.from] = null;
      live.board[ev.to] = ev.player;
      live.turn = ev.player;
      live.pendingRemoval = false;
      live.message = `${label} zieht.`;
      lastSetPoint = ev.to;
      lastSetOwner = ev.player;
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
      if (ev.point === lastSetPoint) {
        lastSetPoint = null;
        lastSetOwner = null;
      }
    } else if (ev.type === "reset") {
      live.board = new Array(24).fill(null);
      live.phase = "placing";
      live.turn = "white";
      live.stonesToPlace = { white: 9, black: 9 };
      live.stonesOnBoard = { white: 0, black: 0 };
      live.pendingRemoval = false;
      live.winner = null;
      live.message = "Neues Spiel gestartet.";
      lastSetPoint = null;
      lastSetOwner = null;
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

  function dismissInvite(yourColor) {
    localStorage.setItem(`muehle_invite_dismissed_${NET_GAME_ID}`, "1");
    document.querySelector(".invite")?.remove();
    const panelText = document.querySelector("#network-panel p");
    if (panelText) panelText.textContent = `Du spielst als ${yourColor === "white" ? "Weiss" : "Schwarz"}.`;
  }

  function setupNetworkPanel(data) {
    if (!netYourColorEl) return;
    netYourColorEl.textContent = data.yourColor === "white" ? "Weiss" : "Schwarz";

    const dismissed = localStorage.getItem(`muehle_invite_dismissed_${NET_GAME_ID}`) === "1";
    const savedInvite = localStorage.getItem(`muehle_invite_${NET_GAME_ID}`);
    if (savedInvite && !dismissed) {
      inviteLinkInput.value = savedInvite;
      mailInviteBtn.href = buildMailto(savedInvite);
    } else {
      dismissInvite(data.yourColor);
    }
  }

  copyLinkBtn?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(inviteLinkInput.value);
      copyLinkBtn.textContent = "Kopiert!";
      setTimeout(() => dismissInvite(state?.yourColor), 900);
    } catch (e) {
      inviteLinkInput.select();
    }
  });

  mailInviteBtn?.addEventListener("click", () => {
    setTimeout(() => dismissInvite(state?.yourColor), 300);
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
