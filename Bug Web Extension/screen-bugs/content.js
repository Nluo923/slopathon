(() => {
  if (window.__screenBugsInjected) return;
  window.__screenBugsInjected = true;

  const CONTAINER_ID = "__screen_bugs_container__";
  const BEETLE_LAYER_CLASS = "__screen_bugs_beetle_layer__";

  // =================== Engine / State ===================
  const state = {
    scatterTimers: new Set(),
    beetles: [],
    engineRaf: null,
    running: false,
    lastTs: 0,
    accum: 0,
    dtFixed: 1 / 60,      // physics step
    renderThrottle: 1 / 60,
    _renderAccum: 0,
  };

  // Lower FPS if you want even less CPU:
  const ECONOMY_MODE = false; // set true to ~30fps
  if (ECONOMY_MODE) state.renderThrottle = 1 / 30;

  function randomBetween(a, b) { return Math.random() * (b - a) + a; }

  function ensureContainer() {
    let c = document.getElementById(CONTAINER_ID);
    if (c) return c;
    c = document.createElement("div");
    c.id = CONTAINER_ID;
    Object.assign(c.style, {
      position: "fixed",
      inset: "0",
      pointerEvents: "none",
      zIndex: "2147483647",
      overflow: "hidden",
    });
    document.documentElement.appendChild(c);
    return c;
  }

  // =================== Scatter Bugs (unchanged) ===================
  const BUG_SVGS = [
    `data:image/svg+xml;utf8,` + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="-16 -16 96 96"><g fill="#111" stroke="#111" stroke-width="3"><ellipse cx="32" cy="36" rx="20" ry="24"/><circle cx="32" cy="16" r="10"/><line x1="12" y1="36" x2="0" y2="30"/><line x1="12" y1="44" x2="0" y2="50"/><line x1="52" y1="36" x2="64" y2="30"/><line x1="52" y1="44" x2="64" y2="50"/><line x1="32" y1="6" x2="24" y2="0"/><line x1="32" y1="6" x2="40" y2="0"/></g></svg>`),
    `data:image/svg+xml;utf8,` + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="-16 -16 96 96"><g fill="#3b2f2f" stroke="#3b2f2f" stroke-width="3"><ellipse cx="32" cy="34" rx="18" ry="22"/><ellipse cx="32" cy="18" rx="10" ry="8"/><line x1="18" y1="32" x2="6" y2="26"/><line x1="18" y1="40" x2="6" y2="46"/><line x1="46" y1="32" x2="58" y2="26"/><line x1="46" y1="40" x2="58" y2="46"/><line x1="28" y1="10" x2="22" y2="2"/><line x1="36" y1="10" x2="42" y2="2"/></g></svg>`)
  ];

  function injectBugs({ count = 12, size = 48, animate = true } = {}) {
    const container = ensureContainer();
    const vw = window.innerWidth, vh = window.innerHeight;

    for (let i = 0; i < count; i++) {
      const bug = document.createElement("img");
      bug.src = BUG_SVGS[Math.floor(Math.random() * BUG_SVGS.length)];
      bug.className = "__screen_bug__";
      const s = size * randomBetween(0.85, 1.15);
      const x = randomBetween(0, vw - s);
      const y = randomBetween(0, vh - s);

      Object.assign(bug.style, {
        position: "absolute",
        left: `${x}px`,
        top: `${y}px`,
        width: `${s}px`,
        height: `${s}px`,
        transform: `rotate(${Math.floor(randomBetween(-30, 30))}deg)`,
        opacity: String(randomBetween(0.85, 1)),
        filter: "drop-shadow(0 2px 2px rgba(0,0,0,0.35))",
        willChange: "transform, left, top",
        transition: "transform 0.8s ease",
      });

      if (animate) {
        const drift = () => {
          const dx = randomBetween(-20, 20);
          const dy = randomBetween(-12, 12);
          const rot = randomBetween(-20, 20);
          const nx = Math.min(Math.max(0, parseFloat(bug.style.left) + dx), vw - s);
          const ny = Math.min(Math.max(0, parseFloat(bug.style.top) + dy), vh - s);
          bug.style.left = `${nx}px`;
          bug.style.top = `${ny}px`;
          bug.style.transform = `rotate(${rot}deg)`;
        };
        const timer = setInterval(drift, 1200 + Math.random() * 1000);
        state.scatterTimers.add(timer);
        bug.dataset.__timer = String(timer);
      }

      container.appendChild(bug);
    }
  }

  // =================== Texture generation & caches ===================
  const TEX_SZ = 128;

  // Offscreen sources (do not tie to any live drawing context)
  const noiseSrc = document.createElement("canvas");
  const crackSrc = document.createElement("canvas");
  noiseSrc.width = noiseSrc.height = TEX_SZ;
  crackSrc.width = crackSrc.height = TEX_SZ;

  // Build once
  (function buildNoise() {
    const g = noiseSrc.getContext("2d");
    g.fillStyle = "#5e3d23"; // darker, cooler brown
    g.fillRect(0, 0, TEX_SZ, TEX_SZ);
    const img = g.getImageData(0, 0, TEX_SZ, TEX_SZ);
    const d = img.data;
    for (let y = 0; y < TEX_SZ; y++) {
      for (let x = 0; x < TEX_SZ; x++) {
        const i = (y * TEX_SZ + x) * 4;
        const n1 = (Math.random() - 0.5) * 14;
        const n2 = (Math.random() - 0.5) * 7;
        const n = n1 + n2;
        d[i + 0] = Math.max(0, Math.min(255, d[i + 0] + n));
        d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n * 0.85));
        d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n * 0.55));
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    g.globalAlpha = 0.16;
    for (let k = 0; k < 8; k++) {
      const r = 10 + Math.random() * 22;
      const cx = Math.random() * TEX_SZ;
      const cy = Math.random() * TEX_SZ;
      const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, "rgba(0,0,0,0.35)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grad;
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  })();

  (function buildCracks() {
    const cg = crackSrc.getContext("2d");
    cg.clearRect(0, 0, TEX_SZ, TEX_SZ);
    cg.strokeStyle = "rgba(0,0,0,0.75)";
    cg.lineCap = "round";
    const lines = 90;
    for (let i = 0; i < lines; i++) {
      let x = Math.random() * TEX_SZ;
      let y = Math.random() * TEX_SZ;
      let segs = 6 + Math.floor(Math.random() * 8);
      let ang = randomBetween(0, Math.PI * 2);
      let lw = randomBetween(0.6, 1.6);
      cg.lineWidth = lw;
      cg.beginPath();
      cg.moveTo(x, y);
      for (let s = 0; s < segs; s++) {
        ang += randomBetween(-0.45, 0.45);
        const len = randomBetween(4, 10);
        x = (x + Math.cos(ang) * len + TEX_SZ) % TEX_SZ;
        y = (y + Math.sin(ang) * len + TEX_SZ) % TEX_SZ;
        cg.lineTo(x, y);
        if (Math.random() < 0.12) {
          cg.save();
          cg.lineWidth = lw * 0.7;
          const ang2 = ang + randomBetween(-1.2, 1.2);
          const bx = (x + Math.cos(ang2) * randomBetween(3, 8) + TEX_SZ) % TEX_SZ;
          const by = (y + Math.sin(ang2) * randomBetween(3, 8) + TEX_SZ) % TEX_SZ;
          cg.moveTo(x, y); cg.lineTo(bx, by);
          cg.restore();
        }
      }
      cg.stroke();
    }
  })();

  // Per-context pattern cache so patterns don't hold other contexts alive.
  const patternCache = new WeakMap(); // ctx -> {noise, cracks}
  function getPatterns(ctx) {
    let p = patternCache.get(ctx);
    if (p) return p;
    p = {
      noise: ctx.createPattern(noiseSrc, "repeat"),
      cracks: ctx.createPattern(crackSrc, "repeat"),
    };
    patternCache.set(ctx, p);
    return p;
  }

  // Vignette cache keyed by integer diameter. Small LRU to avoid unbounded growth.
  const vignetteCache = new Map(); // d -> offscreen canvas
  const VIGNETTE_LRU = [];
  const VIGNETTE_MAX = 32;
  function getVignette(d) {
    if (vignetteCache.has(d)) return vignetteCache.get(d);
    const c = document.createElement("canvas");
    c.width = c.height = d;
    const g = c.getContext("2d");
    const vg = g.createRadialGradient(d * 0.5, d * 0.5, d * 0.25, d * 0.5, d * 0.5, d * 0.55);
    vg.addColorStop(0, "rgba(0,0,0,0.0)");
    vg.addColorStop(1, "rgba(0,0,0,0.35)");
    g.fillStyle = vg;
    g.fillRect(0, 0, d, d);
    vignetteCache.set(d, c);
    VIGNETTE_LRU.push(d);
    if (VIGNETTE_LRU.length > VIGNETTE_MAX) {
      const old = VIGNETTE_LRU.shift();
      vignetteCache.delete(old);
    }
    return c;
  }

  // Draw ball (top-down look). Only creates gradients/patterns once per ctx or size.
  function drawBallTopDown(ctx, d, rollDeg) {
    const { noise, cracks } = getPatterns(ctx);

    ctx.clearRect(0, 0, d, d);

    // Clip to circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(d / 2, d / 2, d / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    // Base fill
    ctx.fillStyle = "#5e3d23";
    ctx.fillRect(0, 0, d, d);

    // Rotating albedo
    ctx.save();
    ctx.translate(d / 2, d / 2);
    ctx.rotate((rollDeg * Math.PI) / 180);
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = noise;
    const T = d * 1.6;
    ctx.fillRect(-T / 2, -T / 2, T, T);
    ctx.restore();

    // Rotating cracks
    ctx.save();
    ctx.translate(d / 2, d / 2);
    ctx.rotate((rollDeg * Math.PI) / 180);
    ctx.globalCompositeOperation = "multiply";
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = cracks;
    ctx.fillRect(-T / 2, -T / 2, T, T);
    ctx.globalAlpha = 1;
    ctx.restore();

    // Rim/roundness from cache (no per-frame gradient allocation)
    ctx.globalCompositeOperation = "multiply";
    ctx.drawImage(getVignette(d), 0, 0);

    ctx.restore();
  }

  // =================== Beetles (single engine) ===================
  function spawnDungBeetle({ speed = 180, maxBall = 160 } = {}) {
    const container = ensureContainer();

    const layer = document.createElement("div");
    layer.className = BEETLE_LAYER_CLASS;
    Object.assign(layer.style, { position: "absolute", inset: 0, pointerEvents: "none" });

    // Ball canvas
    const initialBall = 48;
    const ballCanvas = document.createElement("canvas");
    ballCanvas.width = initialBall;
    ballCanvas.height = initialBall;
    Object.assign(ballCanvas.style, {
      position: "absolute",
      width: `${initialBall}px`,
      height: `${initialBall}px`,
      willChange: "transform, left, top, width, height",
      imageRendering: "auto",
    });
    const bctx = ballCanvas.getContext("2d", { alpha: true });

    // Beetle
    const beetle = document.createElement("div");
    beetle.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="38" height="28" viewBox="0 0 76 56">
        <g fill="#1a1a1a" stroke="#1a1a1a" stroke-width="2">
          <ellipse cx="40" cy="34" rx="18" ry="14"/>
          <ellipse cx="28" cy="26" rx="10" ry="8"/>
          <line x1="50" y1="34" x2="62" y2="28"/>
          <line x1="50" y1="40" x2="62" y2="46"/>
          <line x1="30" y1="22" x2="26" y2="16"/>
          <line x1="30" y1="22" x2="34" y2="16"/>
        </g>
      </svg>`;
    Object.assign(beetle.style, {
      position: "absolute",
      width: "38px",
      height: "28px",
      transformOrigin: "50% 50%",
      willChange: "transform, left, top",
      filter: "drop-shadow(0 2px 2px rgba(0,0,0,0.35))",
    });

    layer.appendChild(ballCanvas);
    layer.appendChild(beetle);
    container.appendChild(layer);

    // Physics
    let diameter = initialBall, radius = diameter / 2;
    let x = randomBetween(radius + 20, window.innerWidth - radius - 20);
    let y = randomBetween(radius + 20, window.innerHeight - radius - 20);
    let heading = randomBetween(0, Math.PI * 2);
    let targetHeading = heading;
    const maxTurnRate = Math.PI / 2;
    const wanderEvery = 2.5;
    let timeToWander = wanderEvery;
    const wallTurnJitter = [15, 45];

    const pixelsPerGrow = 120;
    const growthPx = 2.5;
    let distSinceGrow = 0;
    let rollDeg = 0;

    // Resize hysteresis: only resize when size changes ≥ this many pixels
    const RESIZE_STEP = 4;
    let nextResizeAt = initialBall;

    function angDiff(a, b) {
      let d = (b - a + Math.PI) % (2 * Math.PI) - Math.PI;
      return d < -Math.PI ? d + 2 * Math.PI : d;
    }
    function pickNewTarget(base = heading) {
      const delta = (Math.random() * (Math.PI / 3)) - (Math.PI / 6);
      return base + delta;
    }
    function reflectHeadingOnWalls(h) {
      const vw = window.innerWidth, vh = window.innerHeight;
      const hitLeft = x - radius <= 0, hitRight = x + radius >= vw, hitTop = y - radius <= 0, hitBottom = y + radius >= vh;
      let newH = h;
      if (hitLeft || hitRight) newH = Math.PI - newH;
      if (hitTop || hitBottom) newH = -newH;
      if ((hitLeft || hitRight) && (hitTop || hitBottom)) newH = newH + Math.PI;
      const jitterDeg = randomBetween(wallTurnJitter[0], wallTurnJitter[1]) * (Math.random() < 0.5 ? -1 : 1);
      newH += (jitterDeg * Math.PI) / 180;
      return ((newH % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    }

    function placeAndRender(forceResize = false, seg = 0) {
      const targetD = Math.round(diameter);
      // resize only if forced or growth reached threshold
      if (forceResize || Math.abs(targetD - ballCanvas.width) >= RESIZE_STEP || targetD >= nextResizeAt + RESIZE_STEP) {
        ballCanvas.width = targetD;
        ballCanvas.height = targetD;
        ballCanvas.style.width = `${targetD}px`;
        ballCanvas.style.height = `${targetD}px`;
        nextResizeAt = targetD;
      }

      // Position
      ballCanvas.style.left = `${x - radius}px`;
      ballCanvas.style.top = `${y - radius}px`;

      // Rolling texture
      if (radius > 0 && seg > 0) rollDeg = (rollDeg + (seg / radius) * (180 / Math.PI)) % 360;

      drawBallTopDown(bctx, ballCanvas.width, rollDeg);

      // Beetle pose
      const pushOffset = Math.max(18, radius * 0.35);
      const bx = x - radius - pushOffset;
      const by = y + radius * 0.12;
      beetle.style.left = `${bx}px`;
      beetle.style.top = `${by - 14}px`;
      beetle.style.transform = `rotate(${Math.cos(heading) >= 0 ? 0 : 180}deg)`;
    }

    const beetleObj = {
      layer, ballCanvas, bctx, beetle,
      get alive() { return !!layer.isConnected; },
      update(dt) {
        // steer
        const dAng = angDiff(heading, targetHeading);
        const turn = Math.max(Math.min(dAng, maxTurnRate * dt), -maxTurnRate * dt);
        heading += turn;

        // move
        const dx = Math.cos(heading) * speed * dt;
        const dy = Math.sin(heading) * speed * dt;

        const oldX = x, oldY = y;
        x += dx; y += dy;

        // bounds & bounce
        let bounced = false;
        const vw = window.innerWidth, vh = window.innerHeight;
        if (x - radius < 0) { x = radius; bounced = true; }
        if (x + radius > vw) { x = vw - radius; bounced = true; }
        if (y - radius < 0) { y = radius; bounced = true; }
        if (y + radius > vh) { y = vh - radius; bounced = true; }

        if (bounced) {
          heading = reflectHeadingOnWalls(heading);
          targetHeading = pickNewTarget(heading);
          timeToWander = wanderEvery;
        } else {
          timeToWander -= dt;
          if (timeToWander <= 0) {
            targetHeading = pickNewTarget(heading);
            timeToWander = wanderEvery + randomBetween(-0.6, 0.6);
          }
        }

        // growth
        const seg = Math.hypot(x - oldX, y - oldY);
        distSinceGrow += seg;
        if (diameter < maxBall && distSinceGrow >= pixelsPerGrow) {
          const inc = Math.floor(distSinceGrow / pixelsPerGrow);
          diameter = Math.min(maxBall, diameter + inc * growthPx);
          radius = diameter / 2;
          distSinceGrow = distSinceGrow % pixelsPerGrow;
          placeAndRender(true, seg);
        } else {
          placeAndRender(false, seg);
        }
      },
      dispose() { try { layer.remove(); } catch {} }
    };

    state.beetles.push(beetleObj);
    placeAndRender(true, 0);
    startEngine();
  }

  // =================== rAF Engine ===================
  function startEngine() {
    if (state.running) return;
    state.running = true;
    state.lastTs = performance.now();
    state.accum = 0;
    state._renderAccum = 0;

    const loop = (ts) => {
      if (!state.running) return;
      const dt = Math.min(0.1, (ts - state.lastTs) / 1000);
      state.lastTs = ts;

      if (document.hidden) { state.engineRaf = requestAnimationFrame(loop); return; }

      state.accum += dt;
      state._renderAccum += dt;

      while (state.accum >= state.dtFixed) {
        for (let i = state.beetles.length - 1; i >= 0; i--) {
          const b = state.beetles[i];
          if (!b.alive) { state.beetles.splice(i, 1); continue; }
          b.update(state.dtFixed);
        }
        state.accum -= state.dtFixed;
      }

      if (state.beetles.length === 0) { stopEngine(); return; }

      if (state._renderAccum >= state.renderThrottle) {
        state._renderAccum = 0;
      }

      state.engineRaf = requestAnimationFrame(loop);
    };

    state.engineRaf = requestAnimationFrame(loop);
  }

  function stopEngine() {
    state.running = false;
    if (state.engineRaf) cancelAnimationFrame(state.engineRaf);
    state.engineRaf = null;
  }

  // =================== Clear ===================
  function clearBugs() {
    const c = document.getElementById(CONTAINER_ID);
    if (!c) return;

    for (const t of state.scatterTimers) clearInterval(t);
    state.scatterTimers.clear();

    for (const b of state.beetles) b.dispose();
    state.beetles = [];
    stopEngine();

    c.querySelectorAll(`.${BEETLE_LAYER_CLASS}`).forEach(el => el.remove());
    c.querySelectorAll("img.__screen_bug__").forEach(el => el.remove());

    if (!c.firstChild) c.remove();
  }

  // =================== Bridge & lifecycle ===================
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "INJECT_BUGS") injectBugs(msg.payload || {});
    else if (msg?.type === "DUNG_BEETLE") spawnDungBeetle(msg.payload || {});
    else if (msg?.type === "CLEAR_BUGS") clearBugs();
  });

  document.addEventListener("visibilitychange", () => {
    if (!state.running) return;
    if (!document.hidden) state.lastTs = performance.now();
  });

  window.addEventListener("blur", () => { if (state.running) state.lastTs = performance.now(); });

  window.addEventListener("keydown", (e) => { if (e.key === "Escape") clearBugs(); }, { capture: true });
})();
