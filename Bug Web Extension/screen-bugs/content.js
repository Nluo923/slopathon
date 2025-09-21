(() => {
  if (window.__screenBugsInjected) return;
  window.__screenBugsInjected = true;

  const CONTAINER_ID = "__screen_bugs_container__";
  const BEETLE_LAYER_CLASS = "__screen_bugs_beetle_layer__";

  // --- Z-LAYERS ---
  const Z = {
    BALL: 20,           // dung ball canvas
    EAT: 25,            // termites' black-pixel eat canvas
    SCATTER: 30,        // scatter bugs normal
    SCATTER_OVER: 35,   // scatter bug when overlapping dung
    TERMITE: 34,        // termite sprites (above black pixels, below beetle)
    SPIDER: 38,         // spiders below beetle, above most others
    BEETLE: 40          // beetle always on top
  };

  const state = {
    beetles: [],
    scatters: [],
    termites: [],
    engineRaf: null,
    running: false,
    lastTs: 0,
    accum: 0,
    dtFixed: 1/60
  };

  // -------- utils
  const rand = (a,b)=>Math.random()*(b-a)+a;
  const clamp=(v,lo,hi)=>(v<lo?lo:(v>hi?hi:v));
  const limit=(x,y,max)=>{const L=Math.hypot(x,y)||1; if(L>max){const s=max/L; return {x:x*s,y:y*s};} return {x,y};};
  const norm=(x,y)=>{const L=Math.hypot(x,y)||1; return {x:x/L,y:y/L,L};};

  function ensureContainer(){
    let c=document.getElementById(CONTAINER_ID);
    if(c) return c;
    c=document.createElement("div");
    c.id=CONTAINER_ID;
    Object.assign(c.style,{position:"fixed",inset:"0",pointerEvents:"none",zIndex:"2147483647",overflow:"hidden"});
    document.documentElement.appendChild(c);
    return c;
  }

  // =================== SCATTER BUGS = BOIDS (independent personalities + orbit attraction) ===================
  const BUG_SVGS=[
    `data:image/svg+xml;utf8,`+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="-16 -16 96 96"><g fill="#111" stroke="#111" stroke-width="3"><ellipse cx="32" cy="36" rx="20" ry="24"/><circle cx="32" cy="16" r="10"/><line x1="12" y1="36" x2="0" y2="30"/><line x1="12" y1="44" x2="0" y2="50"/><line x1="52" y1="36" x2="64" y2="30"/><line x1="52" y1="44" x2="64" y2="50"/><line x1="32" y1="6" x2="24" y2="0"/><line x1="32" y1="6" x2="40" y2="0"/></g></svg>`),
    `data:image/svg+xml;utf8,`+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="-16 -16 96 96"><g fill="#3b2f2f" stroke="#3b2f2f" stroke-width="3"><ellipse cx="32" cy="34" rx="18" ry="22"/><ellipse cx="32" cy="18" rx="10" ry="8"/><line x1="18" y1="32" x2="6" y2="26"/><line x1="18" y1="40" x2="6" y2="46"/><line x1="46" y1="32" x2="58" y2="26"/><line x1="46" y1="40" x2="58" y2="46"/><line x1="28" y1="10" x2="22" y2="2"/><line x1="36" y1="10" x2="42" y2="2"/></g></svg>`)
  ];

  const BOIDS_CFG = {
    maxSpeed: 130,
    maxAccel: 520,
    neighborRadius: 130,
    separationRadius: 40,
    wSeparation: 1.3,
    wAlignment: 0.8,
    wCohesion: 0.45,
    jitterAccel: 28,

    attractRadius: 520,
    wAttract: 1.4,
    orbitMin: 80,
    orbitMax: 180,
    tangentialBias: 0.35,

    wallSoft: 140,
    wallBounce: true,
    minEdgeSpeed: 80,
    neighborCap: 7
  };

  // Spatial grid for boids
  const grid = {
    cellSize: 120, map: new Map(),
    key(cx,cy){return `${cx}|${cy}`;},
    clear(){this.map.clear();},
    insert(a){const cs=this.cellSize; const cx=Math.floor(a.x/cs), cy=Math.floor(a.y/cs);
      const k=this.key(cx,cy); if(!this.map.has(k)) this.map.set(k,[]); this.map.get(k).push(a); a._cell={cx,cy};},
    neighbors(a,r){
      const cs=this.cellSize; const c=a._cell||{cx:Math.floor(a.x/cs),cy:Math.floor(a.y/cs)};
      const out=[]; const rc=1+Math.floor(r/cs);
      for(let dx=-rc;dx<=rc;dx++) for(let dy=-rc;dy<=rc;dy++){
        const arr=this.map.get(this.key(c.cx+dx,c.cy+dy)); if(!arr) continue;
        for(let i=0;i<arr.length;i++) out.push(arr[i]);
      }
      return out;
    }
  };

  function nearestDung(px,py){
    if(state.beetles.length===0) return null;
    let best=null, bd2=Infinity;
    for(const b of state.beetles){
      const dx=b.x-px, dy=b.y-py; const d2=dx*dx+dy*dy;
      if(d2<bd2){bd2=d2; best=b;}
    }
    if(!best) return null;
    return {x:best.x, y:best.y, r:best.r, dist:Math.sqrt(bd2)};
  }

  function createScatterBug({size=44}={}){
    const container=ensureContainer();
    const el=document.createElement("img");
    el.src=BUG_SVGS[Math.floor(Math.random()*BUG_SVGS.length)];
    const s=size*(0.85+Math.random()*0.3);
    Object.assign(el.style,{
      position:"absolute", width:`${s}px`, height:`${s}px`,
      left:`0px`, top:`0px`, transform:`rotate(0deg)`,
      opacity:String(0.85+Math.random()*0.15),
      filter:"drop-shadow(0 2px 2px rgba(0,0,0,0.35))",
      willChange:"transform, left, top",
      zIndex: String(Z.SCATTER)
    });
    el.className="__screen_bug__";
    container.appendChild(el);

    let vw=window.innerWidth, vh=window.innerHeight;
    let x=rand(0,vw-s), y=rand(0,vh-s);
    let vx=rand(-90,90), vy=rand(-90,90);

    // per-bug personality
    const p = {
      wSep:  BOIDS_CFG.wSeparation * rand(0.9, 1.25),
      wAli:  BOIDS_CFG.wAlignment  * rand(0.7, 1.15),
      wCoh:  BOIDS_CFG.wCohesion   * rand(0.6, 1.1),
      wAtt:  BOIDS_CFG.wAttract    * rand(0.9, 1.4),
      jitterAccel: BOIDS_CFG.jitterAccel * rand(0.8, 1.4),
      neighborR: BOIDS_CFG.neighborRadius * rand(0.85, 1.15),
      sepR: BOIDS_CFG.separationRadius * rand(0.9, 1.2),
      wanderTheta: rand(0, Math.PI*2),
      wanderRate: rand(1.5, 3.2),
      wanderStrength: rand(80, 160),
      orbitR: rand(BOIDS_CFG.orbitMin, BOIDS_CFG.orbitMax),
      orbitPhi: rand(0, Math.PI*2),
      orbitSpeed: rand(0.6, 1.4),
      tangentialBias: BOIDS_CFG.tangentialBias * rand(0.7, 1.3)
    };

    return {
      el, s, p,
      get x(){return x + s/2;},
      get y(){return y + s/2;},
      get r(){return s*0.42;},           // ~radius for collision
      _cell:null, _vx:vx, _vy:vy,

      updateBoid(dt){
        vw=window.innerWidth; vh=window.innerHeight;
        const px=this.x, py=this.y;

        // neighbors (closest few)
        const candidates=grid.neighbors(this, p.neighborR);
        const neigh = [];
        for(let i=0;i<candidates.length;i++){
          const n=candidates[i]; if(n===this) continue;
          const dx=n.x-px, dy=n.y-py; const d2=dx*dx+dy*dy;
          if(d2===0 || d2>p.neighborR*p.neighborR) continue;
          neigh.push({n, d2});
        }
        neigh.sort((a,b)=>a.d2-b.d2);
        if(neigh.length>BOIDS_CFG.neighborCap) neigh.length = BOIDS_CFG.neighborCap;

        let sepX=0, sepY=0, aliX=0, aliY=0, cohX=0, cohY=0;
        const ncount = neigh.length;
        for(let i=0;i<ncount;i++){
          const m = neigh[i].n;
          const dx = m.x - px, dy = m.y - py;
          const d2 = neigh[i].d2;
          if(d2 < p.sepR*p.sepR){
            const d = Math.sqrt(d2)||1;
            sepX -= dx/d * (p.sepR/Math.max(d,1));
            sepY -= dy/d * (p.sepR/Math.max(d,1));
          }
          aliX += m._vx||0; aliY += m._vy||0;
          cohX += m.x;      cohY += m.y;
        }
        if(ncount){
          ({x:sepX,y:sepY}=norm(sepX,sepY));
          aliX/=ncount; aliY/=ncount; ({x:aliX,y:aliY}=norm(aliX,aliY));
          cohX=(cohX/ncount)-px; cohY=(cohY/ncount)-py; ({x:cohX,y:cohY}=norm(cohX,cohY));
        }

        // wander
        p.wanderTheta += (rand(-1,1)*p.wanderRate) * dt;
        let wx = Math.cos(p.wanderTheta), wy = Math.sin(p.wanderTheta);
        wx *= p.wanderStrength; wy *= p.wanderStrength;

        // attraction to personal orbit point around dung
        let attAx=0, attAy=0, dungBias=0;
        const nd=nearestDung(px,py);
        if(nd){
          p.orbitPhi += p.orbitSpeed * dt;
          const goalX = nd.x + Math.cos(p.orbitPhi) * (nd.r + p.orbitR);
          const goalY = nd.y + Math.sin(p.orbitPhi) * (nd.r + p.orbitR);
          const toGX = goalX - px, toGY = goalY - py;
          const dG = Math.hypot(toGX,toGY)||1;
          const desiredX = (toGX/dG) * BOIDS_CFG.maxSpeed;
          const desiredY = (toGY/dG) * BOIDS_CFG.maxSpeed;
          const tx = -toGY/dG, ty = toGX/dG;
          const swirlX = tx * BOIDS_CFG.maxSpeed * p.tangentialBias;
          const swirlY = ty * BOIDS_CFG.maxSpeed * p.tangentialBias;
          let steerX = (desiredX + swirlX) - vx;
          let steerY = (desiredY + swirlY) - vy;
          ({x:steerX, y:steerY} = limit(steerX, steerY, BOIDS_CFG.maxAccel));
          const d = Math.hypot(nd.x - px, nd.y - py);
          const near = Math.max(0, 1 - d / BOIDS_CFG.attractRadius);
          const far  = 1 / (1 + 0.004 * d);
          const gain = near + far;
          attAx = steerX * p.wAtt * gain;
          attAy = steerY * p.wAtt * gain;
          dungBias = gain;
        }

        // combine accelerations
        let ax = p.wSep*sepX + p.wAli*aliX + p.wCoh*cohX + attAx + wx;
        let ay = p.wSep*sepY + p.wAli*aliY + p.wCoh*cohY + attAy + wy;

        // soft edge steer (relaxed if chasing dung)
        const soften = dungBias > 0.25 ? 0.35 : 1.0;
        const m = BOIDS_CFG.wallSoft;
        if(px < m) ax += soften * (m - px) / m * BOIDS_CFG.maxAccel * 0.15;
        if(py < m) ay += soften * (m - py) / m * BOIDS_CFG.maxAccel * 0.15;
        if(px > vw - m) ax -= soften * (px - (vw - m)) / m * BOIDS_CFG.maxAccel * 0.15;
        if(py > vh - m) ay -= soften * (py - (vh - m)) / m * BOIDS_CFG.maxAccel * 0.15;

        // integrate
        ({x:ax,y:ay}=limit(ax,ay,BOIDS_CFG.maxAccel));
        vx += ax * dt; vy += ay * dt;
        ({x:vx,y:vy}=limit(vx,vy,BOIDS_CFG.maxSpeed));
        x += vx * dt; y += vy * dt;

        // --- hard bounce (FIXED)
        if(BOIDS_CFG.wallBounce){
          const minS=BOIDS_CFG.minEdgeSpeed;
          if(x<0){ x=0; vx=Math.abs(vx)<minS?minS:Math.abs(vx); }
          if(y<0){ y=0; vy=Math.abs(vy)<minS?minS:Math.abs(vy); }
          if(x>vw - this.s){ x=vw - this.s; vx=-(Math.abs(vx)<minS?minS:Math.abs(vx)); }
          if(y>vh - this.s){ y=vh - this.s; vy=-(Math.abs(vy)<minS?minS:Math.abs(vy)); }
        }else{
          x=clamp(x,0,vw-this.s); y=clamp(y,0,vh-this.s);
        }

        // pose
        const rot=(Math.atan2(vy,vx)*180)/Math.PI;
        this.el.style.left=`${x}px`; this.el.style.top=`${y}px`; this.el.style.transform=`rotate(${rot}deg)`;

        // z-lift when overlapping dung ball
        let overDung = false;
        if (state.beetles.length) {
          const cx = this.x, cy = this.y;
          for (let i = 0; i < state.beetles.length; i++) {
            const b = state.beetles[i];
            const dx = b.x - cx, dy = b.y - cy;
            const dist2 = dx*dx + dy*dy;
            const thresh = (b.r + this.s * 0.35);
            if (dist2 <= thresh * thresh) { overDung = true; break; }
          }
        }
        this.el.style.zIndex = String(overDung ? Z.SCATTER_OVER : Z.SCATTER);

        this._vx=vx; this._vy=vy;
      },

      dispose(){ try{el.remove();}catch{} }
    };
  }

  function injectBugs({count=12,size=48}={}){ for(let i=0;i<count;i++) state.scatters.push(createScatterBug({size})); startEngine(); }

  // =================== TERMITES (two-segment body, eat screen by painting black) ===================
  const termites = {
    list: [],
    eatCanvas: null,
    eatCtx: null
  };

  // robust DPR-aware eat canvas
  function ensureEatCanvas(){
    if (termiteEatCtx()) return termites.eatCtx;

    const container = ensureContainer();
    const cvs = document.createElement("canvas");

    const applyCss = () => {
      Object.assign(cvs.style, {
        position: "absolute",
        left: "0",
        top: "0",
        width: `${window.innerWidth}px`,
        height: `${window.innerHeight}px`,
        zIndex: String(Z.EAT),
        pointerEvents: "none"
      });
    };

    const setDpr = () => {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      cvs.width = Math.floor(window.innerWidth * dpr);
      cvs.height = Math.floor(window.innerHeight * dpr);
      const ctx = cvs.getContext("2d", { alpha: true });
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      termites.eatCtx = ctx;
    };

    applyCss(); setDpr();
    termites.eatCanvas = cvs;
    container.appendChild(cvs);

    if (!ensureEatCanvas._boundResize) {
      ensureEatCanvas._boundResize = true;
      window.addEventListener("resize", () => {
        if (!termites.eatCanvas) return;
        applyCss(); setDpr(); // clears by design on resize
      }, { passive: true });
    }
    return termites.eatCtx;
  }

  function termiteEatCtx(){ return termites.eatCanvas && termites.eatCanvas.isConnected ? termites.eatCtx : null; }

  const TERMITE_CFG = {
    speed: 80,            // halved speed
    turnJitter: 3.2,      // rad/s random heading noise
    accel: 380,           // px/s^2 steering to heading
    eatSizeMin: 2,        // “mouth” radius
    eatSizeMax: 4,
    bouncePadding: 2
  };

  // two-segment (abdomen + thorax/head) termite visuals
  function createTermite({ size = 10 } = {}) {
    ensureEatCanvas();
    const container = ensureContainer();
    const el = document.createElement("div");
    Object.assign(el.style, {
      position: "absolute",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      transform: "translate(-50%, -50%) rotate(0deg)",
      left: "0px",
      top: "0px",
      zIndex: String(Z.TERMITE),
      pointerEvents: "none",
      willChange: "transform,left,top"
    });
    el.className = "__screen_termite__";

    // abdomen (bigger)
    const abdomen = document.createElement("div");
    Object.assign(abdomen.style, {
      width: `${size}px`,
      height: `${size * 0.75}px`,
      borderRadius: "50%",
      background: "rgba(255,80,80,0.95)",
      boxShadow: "0 1px 1px rgba(0,0,0,0.25)",
      marginRight: `${size * 0.15}px`
    });

    // thorax/head (smaller)
    const thorax = document.createElement("div");
    Object.assign(thorax.style, {
      width: `${size * 0.6}px`,
      height: `${size * 0.5}px`,
      borderRadius: "50%",
      background: "rgba(230,60,60,0.95)",
      boxShadow: "0 1px 1px rgba(0,0,0,0.2)"
    });

    el.appendChild(abdomen);
    el.appendChild(thorax);
    container.appendChild(el);

    let x = rand(20, window.innerWidth - 20);
    let y = rand(20, window.innerHeight - 20);
    let heading = rand(0, Math.PI * 2);
    let vx = Math.cos(heading) * TERMITE_CFG.speed * 0.6;
    let vy = Math.sin(heading) * TERMITE_CFG.speed * 0.6;
    const mouth = rand(TERMITE_CFG.eatSizeMin, TERMITE_CFG.eatSizeMax);

    return {
      el,
      get x(){ return x; },
      get y(){ return y; },
      get r(){ return size * 0.45; }, // approx radius for collision
      update(dt){
        heading += rand(-TERMITE_CFG.turnJitter, TERMITE_CFG.turnJitter) * dt;

        const desiredX = Math.cos(heading) * TERMITE_CFG.speed;
        const desiredY = Math.sin(heading) * TERMITE_CFG.speed;
        let ax = desiredX - vx, ay = desiredY - vy;
        ({x:ax,y:ay} = limit(ax, ay, TERMITE_CFG.accel));
        vx += ax * dt; vy += ay * dt;

        x += vx * dt; y += vy * dt;

        // bounce at edges
        const pad = TERMITE_CFG.bouncePadding;
        if (x < pad) { x = pad; vx = Math.abs(vx); heading = Math.atan2(vy, vx); }
        if (y < pad) { y = pad; vy = Math.abs(vy); heading = Math.atan2(vy, vx); }
        if (x > window.innerWidth - pad) { x = window.innerWidth - pad; vx = -Math.abs(vx); heading = Math.atan2(vy, vx); }
        if (y > window.innerHeight - pad) { y = window.innerHeight - pad; vy = -Math.abs(vy); heading = Math.atan2(vy, vx); }

        // draw "eaten" pixels (black)
        const g = termiteEatCtx() || ensureEatCanvas();
        g.fillStyle = "#000";
        g.beginPath(); g.arc(x, y, mouth, 0, Math.PI*2); g.fill();

        // pose sprite
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.transform = `translate(-50%, -50%) rotate(${(Math.atan2(vy, vx)*180)/Math.PI}deg)`;
      },
      dispose(){ try{el.remove();}catch{} }
    };
  }

  function releaseTermites({ count = 20, size = 10 } = {}) {
    ensureEatCanvas();
    for (let i = 0; i < count; i++) termites.list.push(createTermite({ size }));
    startEngine();
  }

  // =================== DUNG BEETLE (top-down rolling ball, perf-cached) ===================
  const TEX_SZ=128, noiseSrc=document.createElement("canvas"), crackSrc=document.createElement("canvas");
  noiseSrc.width=noiseSrc.height=TEX_SZ; crackSrc.width=crackSrc.height=TEX_SZ;

  (function buildNoise(){
    const g=noiseSrc.getContext("2d"); g.fillStyle="#5e3d23"; g.fillRect(0,0,TEX_SZ,TEX_SZ);
    const img=g.getImageData(0,0,TEX_SZ,TEX_SZ), d=img.data;
    for(let y=0;y<TEX_SZ;y++) for(let x=0;x<TEX_SZ;x++){
      const i=(y*TEX_SZ+x)*4, n=(Math.random()-0.5)*14 + (Math.random()-0.5)*7;
      d[i+0]=Math.max(0,Math.min(255,d[i+0]+n));
      d[i+1]=Math.max(0,Math.min(255,d[i+1]+n*0.85));
      d[i+2]=Math.max(0,Math.min(255,d[i+2]+n*0.55));
      d[i+3]=255;
    }
    g.putImageData(img,0,0);
    g.globalAlpha=0.16;
    for(let k=0;k<8;k++){
      const r=10+Math.random()*22, cx=Math.random()*TEX_SZ, cy=Math.random()*TEX_SZ;
      const grad=g.createRadialGradient(cx,cy,0,cx,cy,r);
      grad.addColorStop(0,"rgba(0,0,0,0.35)"); grad.addColorStop(1,"rgba(0,0,0,0)");
      g.fillStyle=grad; g.beginPath(); g.arc(cx,cy,r,0,Math.PI*2); g.fill();
    }
    g.globalAlpha=1;
  })();

  (function buildCracks(){
    const cg=crackSrc.getContext("2d"); cg.clearRect(0,0,TEX_SZ,TEX_SZ);
    cg.strokeStyle="rgba(0,0,0,0.75)"; cg.lineCap="round";
    const lines=90;
    for(let i=0;i<lines;i++){
      let x=Math.random()*TEX_SZ, y=Math.random()*TEX_SZ;
      let segs=6+Math.floor(Math.random()*8), ang=rand(0,Math.PI*2), lw=rand(0.6,1.6);
      cg.lineWidth=lw; cg.beginPath(); cg.moveTo(x,y);
      for(let s=0;s<segs;s++){
        ang+=rand(-0.45,0.45);
        const len=rand(4,10);
        x=(x+Math.cos(ang)*len+TEX_SZ)%TEX_SZ; y=(y+Math.sin(ang)*len)+TEX_SZ; y%=TEX_SZ;
        cg.lineTo(x,y);
        if(Math.random()<0.12){
          cg.save(); cg.lineWidth=lw*0.7;
          const ang2=ang+rand(-1.2,1.2);
          const bx=(x+Math.cos(ang2)*rand(3,8)+TEX_SZ)%TEX_SZ;
          const by=(y+Math.sin(ang2)*rand(3,8)+TEX_SZ)%TEX_SZ;
          cg.moveTo(x,y); cg.lineTo(bx,by); cg.restore();
        }
      }
      cg.stroke();
    }
  })();

  const patternCache=new WeakMap();
  function getPatterns(ctx){ let p=patternCache.get(ctx); if(p) return p; p={noise:ctx.createPattern(noiseSrc,"repeat"),cracks:ctx.createPattern(crackSrc,"repeat")}; patternCache.set(ctx,p); return p; }
  const vignetteCache=new Map(); const VIGNETTE_LRU=[], VIGNETTE_MAX=32;
  function getVignette(d){
    if(vignetteCache.has(d)) return vignetteCache.get(d);
    const c=document.createElement("canvas"); c.width=c.height=d; const g=c.getContext("2d");
    const vg=g.createRadialGradient(d*0.5,d*0.5,d*0.25,d*0.5,d*0.5,d*0.55);
    vg.addColorStop(0,"rgba(0,0,0,0.0)"); vg.addColorStop(1,"rgba(0,0,0,0.35)");
    g.fillStyle=vg; g.fillRect(0,0,d,d);
    vignetteCache.set(d,c); VIGNETTE_LRU.push(d);
    if(VIGNETTE_LRU.length>VIGNETTE_MAX) vignetteCache.delete(VIGNETTE_LRU.shift());
    return c;
  }

  // Lighter, warmer dung + safer 'T' scope + softer overlays
  function drawBallTopDown(ctx,d,rollDeg){
    const {noise,cracks}=getPatterns(ctx);
    const T = d * 1.6; // used in both overlays
    ctx.clearRect(0,0,d,d);
    ctx.save(); ctx.beginPath(); ctx.arc(d/2,d/2,d/2,0,Math.PI*2); ctx.closePath(); ctx.clip();

    // base fill (lighter brown)
    ctx.fillStyle="#7a4a24";
    ctx.fillRect(0,0,d,d);

    // noise overlay (slightly reduced strength)
    ctx.save(); ctx.translate(d/2,d/2); ctx.rotate((rollDeg*Math.PI)/180);
    ctx.globalCompositeOperation="multiply";
    ctx.globalAlpha = 0.7;
    ctx.fillStyle=noise; ctx.fillRect(-T/2,-T/2,T,T);
    ctx.restore();

    // cracks overlay (lighter)
    ctx.save(); ctx.translate(d/2,d/2); ctx.rotate((rollDeg*Math.PI)/180);
    ctx.globalCompositeOperation="multiply"; ctx.globalAlpha=0.55;
    ctx.fillStyle=cracks; ctx.fillRect(-T/2,-T/2,T,T);
    ctx.restore();

    // vignette (subtle)
    ctx.globalCompositeOperation="multiply";
    ctx.globalAlpha = 0.18;
    ctx.drawImage(getVignette(d),0,0);
    ctx.globalAlpha = 1;

    ctx.restore();
  }

  function spawnDungBeetle({speed=180,maxBall=160}={}){
    const container=ensureContainer();
    const layer=document.createElement("div");
    layer.className=BEETLE_LAYER_CLASS;
    Object.assign(layer.style,{
      position:"absolute",
      inset:0,
      pointerEvents:"none",
      zIndex: String(Z.BEETLE) // ensure entire beetle layer is above termite paint
    });

    const initialBall=48;
    const ballCanvas=document.createElement("canvas");
    ballCanvas.width=initialBall; ballCanvas.height=initialBall;
    Object.assign(ballCanvas.style,{
      position:"absolute", width:`${initialBall}px`, height:`${initialBall}px`,
      willChange:"transform, left, top, width, height", imageRendering:"auto",
      zIndex: String(Z.BALL)
    });
    const bctx=ballCanvas.getContext("2d",{alpha:true});

    const beetle=document.createElement("div");
    beetle.innerHTML=`<svg xmlns="http://www.w3.org/2000/svg" width="38" height="28" viewBox="0 0 76 56">
      <g fill="#1a1a1a" stroke="#1a1a1a" stroke-width="2">
        <ellipse cx="40" cy="34" rx="18" ry="14"/>
        <ellipse cx="28" cy="26" rx="10" ry="8"/>
        <line x1="50" y1="34" x2="62" y2="28"/>
        <line x1="50" y1="40" x2="62" y2="46"/>
        <line x1="30" y1="22" x2="26" y2="16"/>
        <line x1="30" y1="22" x2="34" y2="16"/>
      </g>
    </svg>`;
    Object.assign(beetle.style,{
      position:"absolute", width:"38px", height:"28px",
      transformOrigin:"50% 50%", willChange:"transform, left, top",
      filter:"drop-shadow(0 2px 2px rgba(0,0,0,0.35))",
      zIndex: String(Z.BEETLE)
    });

    layer.appendChild(ballCanvas);
    layer.appendChild(beetle);
    container.appendChild(layer);

    let diameter=initialBall, radius=diameter/2;
    let x=rand(radius+20,window.innerWidth-radius-20), y=rand(radius+20,window.innerHeight-radius-20);
    let heading=rand(0,Math.PI*2), targetHeading=heading;
    const maxTurnRate=Math.PI/2, wanderEvery=2.5; let timeToWander=wanderEvery;
    const wallTurnJitter=[15,45];
    const pixelsPerGrow=120, growthPx=2.5; let distSinceGrow=0; let rollDeg=0;
    const RESIZE_STEP=4;

    function angDiff(a,b){let d=(b-a+Math.PI)%(2*Math.PI)-Math.PI; return d<-Math.PI?d+2*Math.PI:d;}
    function pickNewTarget(base=heading){return base + ((Math.random()*(Math.PI/3))-(Math.PI/6));}
    function reflectHeadingOnWalls(h){
      const vw=window.innerWidth, vh=window.innerHeight;
      const hitLeft=x-radius<=0, hitRight=x+radius>=vw, hitTop=y-radius<=0, hitBottom=y+radius>=vh;
      let newH=h; if(hitLeft||hitRight) newH=Math.PI-newH; if(hitTop||hitBottom) newH=-newH; if((hitLeft||hitRight)&&(hitTop||hitBottom)) newH+=Math.PI;
      const jitterDeg=rand(wallTurnJitter[0],wallTurnJitter[1])*(Math.random()<0.5?-1:1);
      newH += (jitterDeg*Math.PI)/180;
      return ((newH%(2*Math.PI))+2*Math.PI)%(2*Math.PI);
    }

    function placeAndRender(forceResize=false, seg=0){
      const targetD=Math.round(diameter);
      if(forceResize || Math.abs(targetD-ballCanvas.width)>=RESIZE_STEP){
        ballCanvas.width=targetD; ballCanvas.height=targetD;
        ballCanvas.style.width=`${targetD}px`; ballCanvas.style.height=`${targetD}px`;
      }
      ballCanvas.style.left=`${x-radius}px`; ballCanvas.style.top=`${y-radius}px`;
      if(radius>0 && seg>0) rollDeg=(rollDeg + (seg/radius)*(180/Math.PI))%360;
      drawBallTopDown(bctx,ballCanvas.width,rollDeg);
      const pushOffset=Math.max(18, radius*0.35);
      const bx=x-radius-pushOffset, by=y+radius*0.12;
      beetle.style.left=`${bx}px`; beetle.style.top=`${by-14}px`;
      beetle.style.transform=`rotate(${Math.cos(heading)>=0?0:180}deg)`;
    }

    const beetleObj={
      layer, ballCanvas, bctx, beetle,
      get alive(){return !!layer.isConnected;},
      get x(){return x;}, get y(){return y;},
      get r(){return radius;},
      update(dt){
        const dAng=angDiff(heading,targetHeading);
        const turn=Math.max(Math.min(dAng,maxTurnRate*dt),-maxTurnRate*dt);
        heading+=turn;
        const dx=Math.cos(heading)*speed*dt, dy=Math.sin(heading)*speed*dt;
        const oldX=x, oldY=y; x+=dx; y+=dy;
        let bounced=false; const vw=window.innerWidth, vh=window.innerHeight;
        if(x-radius<0){x=radius; bounced=true;}
        if(x+radius>vw){x=vw-radius; bounced=true;}
        if(y-radius<0){y=radius; bounced=true;}
        if(y+radius>vh){y=vh-radius; bounced=true;}
        if(bounced){ heading=reflectHeadingOnWalls(heading); targetHeading=pickNewTarget(heading); timeToWander=wanderEvery; }
        else { timeToWander-=dt; if(timeToWander<=0){ targetHeading=pickNewTarget(heading); timeToWander=wanderEvery+rand(-0.6,0.6);} }
        const seg=Math.hypot(x-oldX,y-oldY);
        distSinceGrow+=seg;
        if(diameter<maxBall && distSinceGrow>=pixelsPerGrow){
          const inc=Math.floor(distSinceGrow/pixelsPerGrow);
          diameter=Math.min(maxBall, diameter + inc*growthPx); radius=diameter/2; distSinceGrow=distSinceGrow%pixelsPerGrow;
          placeAndRender(true, seg);
        } else placeAndRender(false, seg);
      },
      dispose(){ try{layer.remove();}catch{} }
    };

    state.beetles.push(beetleObj);
    placeAndRender(true,0);
    startEngine();
  }

  // =================== GAZE INPUT (singleton, used by spiders)
  const GAZE = (() => {
    const WS_URL = "ws://localhost:8001/";
    let ws = null, open = false;
    let u = 0.5, v = 0.5, valid = false, blink = false;
    let tx = window.innerWidth / 2, ty = window.innerHeight / 2;
    const SMOOTH = 0.22;
    function clamp01(n){ return n < 0 ? 0 : (n > 1 ? 1 : n); }
    function lerp(a,b,t){ return a + (b - a) * t; }
    function uvToViewport(uu, vv){ return { x: uu * window.innerWidth, y: vv * window.innerHeight }; }

    function connect(){
      try { ws = new WebSocket(WS_URL); } catch { ws = null; open = false; return; }
      ws.addEventListener("open", () => { open = true; });
      ws.addEventListener("close", () => { open = false; setTimeout(connect, 1000); });
      ws.addEventListener("error", () => { open = false; try{ ws.close(); }catch{} });
      ws.addEventListener("message", (e) => {
        try{
          const d = JSON.parse(e.data);
          if (typeof d.x === "number" && typeof d.y === "number") {
            u = clamp01(d.x); v = clamp01(d.y);
            blink = !!d.blink; valid = !blink;
          }
        }catch{}
      });
    }
    connect();

    function tick(dt){
      const p = uvToViewport(u, v);
      const t = 1 - Math.pow(1 - SMOOTH, Math.max(1, dt*60));
      tx = lerp(tx, p.x, t);
      ty = lerp(ty, p.y, t);
    }

    window.addEventListener("resize", () => { const p = uvToViewport(u, v); tx = p.x; ty = p.y; });

    return {
      step(dt){ tick(dt); },
      get(){ return { x: tx, y: ty, valid: open && valid, blink }; },
      mouseFallback(ev){ if (!open) { u = clamp01(ev.clientX / window.innerWidth); v = clamp01(ev.clientY / window.innerHeight); valid = true; blink = false; } }
    };
  })();
  window.addEventListener("mousemove", (ev) => GAZE.mouseFallback(ev));

  // =================== SPIDERS (8 legs, 3 bones/leg via SVG hierarchy) ===================
  const __SPIDERS__ = { list: [] };
  const SPIDER_CFG = {
    bodySize: 42,
    legLen: { coxa: 16, femur: 22, tibia: 22 },
    legWidth: 4,
    color: "#1b1b1b",
    maxSpeed: 300,
    accel: 420,
    turnJitter: 1.8,
    zIndex: Z.SPIDER,
    eatRadiusScale: 0.55 // fraction of bodySize used for collision
  };

  function createSpider({ x, y, size = SPIDER_CFG.bodySize } = {}) {
    const container = ensureContainer();

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", String(size * 2));
    svg.setAttribute("height", String(size * 2));
    svg.setAttribute("viewBox", `${-size} ${-size} ${size * 2} ${size * 2}`);
    Object.assign(svg.style, {
      position: "absolute",
      left: "0px",
      top: "0px",
      transform: "translate(-50%, -50%)",
      pointerEvents: "none",
      zIndex: String(SPIDER_CFG.zIndex),
      willChange: "transform"
    });

    const bodyG = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const abdomen = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
    abdomen.setAttribute("cx", "4");
    abdomen.setAttribute("cy", "2");
    abdomen.setAttribute("rx", String(size * 0.38));
    abdomen.setAttribute("ry", String(size * 0.33));
    abdomen.setAttribute("fill", SPIDER_CFG.color);
    const ceph = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
    ceph.setAttribute("cx", String(-size * 0.18));
    ceph.setAttribute("cy", String(-size * 0.06));
    ceph.setAttribute("rx", String(size * 0.22));
    ceph.setAttribute("ry", String(size * 0.18));
    ceph.setAttribute("fill", SPIDER_CFG.color);
    bodyG.appendChild(abdomen); bodyG.appendChild(ceph);

    // legs
    const legs = [];
    const shoulderRadius = size * 0.38;

    for (let i = 0; i < 8; i++) {
      const angle = (-Math.PI / 2) + (i - 3.5) * (Math.PI / 7) * 1.15;
      const ax = Math.cos(angle) * shoulderRadius;
      const ay = Math.sin(angle) * shoulderRadius;
      const angleDeg = (angle * 180) / Math.PI;

      const legRoot = document.createElementNS("http://www.w3.org/2000/svg", "g");
      legRoot.setAttribute("transform", `translate(${ax} ${ay})`);

      const yawG = document.createElementNS("http://www.w3.org/2000/svg", "g");
      yawG.setAttribute("transform", `rotate(${angleDeg})`);

      const coxaG = document.createElementNS("http://www.w3.org/2000/svg", "g");
      coxaG.setAttribute("transform", "rotate(0)");

      const coxa = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      coxa.setAttribute("x", "0");
      coxa.setAttribute("y", String(-SPIDER_CFG.legWidth / 2));
      coxa.setAttribute("width", String(SPIDER_CFG.legLen.coxa));
      coxa.setAttribute("height", String(SPIDER_CFG.legWidth));
      coxa.setAttribute("rx", String(SPIDER_CFG.legWidth / 2));
      coxa.setAttribute("fill", SPIDER_CFG.color);

      const femurG = document.createElementNS("http://www.w3.org/2000/svg", "g");
      femurG.setAttribute("transform", `translate(${SPIDER_CFG.legLen.coxa} 0) rotate(0)`);

      const femur = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      femur.setAttribute("x", "0");
      femur.setAttribute("y", String(-SPIDER_CFG.legWidth / 2));
      femur.setAttribute("width", String(SPIDER_CFG.legLen.femur));
      femur.setAttribute("height", String(SPIDER_CFG.legWidth));
      femur.setAttribute("rx", String(SPIDER_CFG.legWidth / 2));
      femur.setAttribute("fill", SPIDER_CFG.color);

      const tibiaG = document.createElementNS("http://www.w3.org/2000/svg", "g");
      tibiaG.setAttribute("transform", `translate(${SPIDER_CFG.legLen.femur} 0) rotate(0)`);

      const tibia = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      tibia.setAttribute("x", "0");
      tibia.setAttribute("y", String(-SPIDER_CFG.legWidth / 2));
      tibia.setAttribute("width", String(SPIDER_CFG.legLen.tibia));
      tibia.setAttribute("height", String(SPIDER_CFG.legWidth));
      tibia.setAttribute("rx", String(SPIDER_CFG.legWidth / 2));
      tibia.setAttribute("fill", SPIDER_CFG.color);

      tibiaG.appendChild(tibia);
      femurG.appendChild(femur);
      femurG.appendChild(tibiaG);
      coxaG.appendChild(coxa);
      coxaG.appendChild(femurG);
      yawG.appendChild(coxaG);
      legRoot.appendChild(yawG);
      bodyG.appendChild(legRoot);

      legs.push({
        yawG, coxaG, femurG, tibiaG,
        phase: (i % 2 === 0 ? 0 : Math.PI),
        noise: Math.random() * Math.PI * 2,
        baseYawDeg: angleDeg
      });
    }

    svg.appendChild(bodyG);
    container.appendChild(svg);

    let px = (typeof x === "number") ? x : Math.random() * (window.innerWidth - 60) + 30;
    let py = (typeof y === "number") ? y : Math.random() * (window.innerHeight - 60) + 30;
    let heading = Math.random() * Math.PI * 2;
    let vx = Math.cos(heading) * (SPIDER_CFG.maxSpeed * 0.3);
    let vy = Math.sin(heading) * (SPIDER_CFG.maxSpeed * 0.3);
    let gaitTime = 0;
    const eatR = size * SPIDER_CFG.eatRadiusScale;

    function setLegAngles(leg, baseYawDeg, coxaDeg, femurDeg, tibiaDeg) {
      leg.yawG.setAttribute("transform", `rotate(${baseYawDeg})`);
      leg.coxaG.setAttribute("transform", `rotate(${coxaDeg})`);
      leg.femurG.setAttribute("transform", `translate(${SPIDER_CFG.legLen.coxa} 0) rotate(${femurDeg})`);
      leg.tibiaG.setAttribute("transform", `translate(${SPIDER_CFG.legLen.femur} 0) rotate(${tibiaDeg})`);
    }

    function updateLegs(dt) {
      gaitTime += dt;
      const speed = Math.hypot(vx, vy);
      const stepHz = 1.2 + (speed / (SPIDER_CFG.maxSpeed + 1)) * 1.0;
      const phaseAdvance = 2 * Math.PI * stepHz * dt;

      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i];
        leg.phase += phaseAdvance;

        const swing = Math.sin(leg.phase + leg.noise * 0.2);
        const lift  = Math.max(0, Math.sin(leg.phase + Math.PI / 2)) ** 1.2;

        const baseYawDeg = leg.baseYawDeg;
        const coxaDeg  = swing * 18;
        const femurDeg = -10 + swing * 14 - lift * 12;
        const tibiaDeg =  8  - swing * 10 - lift * 16;

        setLegAngles(leg, baseYawDeg, coxaDeg, femurDeg, tibiaDeg);
      }
    }

    // simple "chomp" flash when eating
    function chompFlash(){
      const flash = document.createElement("div");
      Object.assign(flash.style,{
        position:"absolute", left:`${px}px`, top:`${py}px`,
        transform:"translate(-50%,-50%)",
        width:"18px", height:"18px", borderRadius:"50%",
        background:"rgba(255,255,255,0.7)", pointerEvents:"none",
        filter:"blur(1px)", zIndex:String(SPIDER_CFG.zIndex+1)
      });
      ensureContainer().appendChild(flash);
      requestAnimationFrame(()=>{ flash.style.transition="opacity 120ms ease, transform 120ms ease"; flash.style.opacity="0"; flash.style.transform="translate(-50%,-50%) scale(1.6)"; });
      setTimeout(()=>{ try{flash.remove();}catch{} }, 150);
    }

    // ==== SPIDER UPDATE: seek/arrive toward gaze + eat collisions ====
    return {
      el: svg,
      update(dt) {
        // advance smoothed gaze target
        GAZE.step(dt);

        const g = GAZE.get();
        const hasTarget = g.valid;

        // desired velocity
        let desiredX, desiredY;
        if (hasTarget) {
          const dx = g.x - px;
          const dy = g.y - py;
          const dist = Math.hypot(dx, dy) || 1;
          const arriveSpeed = Math.min(SPIDER_CFG.maxSpeed, dist * 3.0);
          desiredX = (dx / dist) * arriveSpeed;
          desiredY = (dy / dist) * arriveSpeed;
        } else {
          heading += (Math.random() * 2 - 1) * SPIDER_CFG.turnJitter * dt;
          desiredX = Math.cos(heading) * SPIDER_CFG.maxSpeed;
          desiredY = Math.sin(heading) * SPIDER_CFG.maxSpeed;
        }

        // steer with accel cap
        let ax = desiredX - vx, ay = desiredY - vy;
        const aLen = Math.hypot(ax, ay) || 1;
        const aMax = SPIDER_CFG.accel;
        if (aLen > aMax) { ax = (ax / aLen) * aMax; ay = (ay / aLen) * aMax; }
        vx += ax * dt; vy += ay * dt;

        // integrate
        px += vx * dt; py += vy * dt;

        // bounds
        const pad = 12;
        if (px < pad) { px = pad; vx = Math.abs(vx); heading = Math.atan2(vy, vx); }
        if (py < pad) { py = pad; vy = Math.abs(vy); heading = Math.atan2(vy, vx); }
        if (px > window.innerWidth - pad) { px = window.innerWidth - pad; vx = -Math.abs(vx); heading = Math.atan2(vy, vx); }
        if (py > window.innerHeight - pad) { py = window.innerHeight - pad; vy = -Math.abs(vy); heading = Math.atan2(vy, vx); }

        // ---- EAT COLLISIONS (scatter bugs + termites; skip dung beetles) ----
        // scatters
        for (let i = state.scatters.length - 1; i >= 0; i--) {
          const s = state.scatters[i];
          if (!s?.el?.isConnected) continue;
          const dx = s.x - px, dy = s.y - py;
          const hit = (dx*dx + dy*dy) <= Math.pow(eatR + (s.r ?? s.s*0.42), 2);
          if (hit) {
            chompFlash();
            s.dispose && s.dispose();  // engine will prune disconnected nodes
          }
        }
        // termites
        for (let i = state.termites.length - 1; i >= 0; i--) {
          const t = state.termites[i];
          if (!t?.el?.isConnected) continue;
          const dx = t.x - px, dy = t.y - py;
          const hit = (dx*dx + dy*dy) <= Math.pow(eatR + (t.r ?? 6), 2);
          if (hit) {
            chompFlash();
            t.dispose && t.dispose();
          }
        }

        // animate legs & pose
        updateLegs(dt);
        svg.style.left = `${px}px`;
        svg.style.top  = `${py}px`;
        svg.style.transform = `translate(-50%, -50%) rotate(${(Math.atan2(vy, vx) * 180) / Math.PI}deg)`;
      },
      dispose() { try { svg.remove(); } catch {} }
    };
  }

  function releaseSpiders({ count = 1, size = SPIDER_CFG.bodySize } = {}) {
    for (let i = 0; i < count; i++) __SPIDERS__.list.push(createSpider({ size }));
    startEngine();
  }

  // =================== Engine loop (fixed-step; rebuild grid each step)
  function startEngine(){
    if(state.running) return; state.running=true; state.lastTs=performance.now(); state.accum=0;
    const loop=(ts)=>{
      if(!state.running) return;
      const dt=Math.min(0.1,(ts-state.lastTs)/1000); state.lastTs=ts;
      if(document.hidden){ state.engineRaf=requestAnimationFrame(loop); return; }
      state.accum+=dt;
      while(state.accum>=state.dtFixed){
        // grid for scatter boids
        grid.clear(); for(let i=0;i<state.scatters.length;i++) grid.insert(state.scatters[i]);

        // beetles
        for(let i=state.beetles.length-1;i>=0;i--){ const b=state.beetles[i]; if(!b.alive){ state.beetles.splice(i,1); continue;} b.update(state.dtFixed); }

        // scatter boids
        for(let i=state.scatters.length-1;i>=0;i--){ const s=state.scatters[i]; if(!s.el.isConnected){ state.scatters.splice(i,1); continue;} s.updateBoid(state.dtFixed); }

        // termites (mirror state array for spider use)
        for(let i=termitiesMirrorSync(), j=termites.list.length-1;j>=0;j--){ const t=termites.list[j]; if(!t.el.isConnected){ termites.list.splice(j,1); continue;} t.update(state.dtFixed); }

        // spiders
        for (let i = __SPIDERS__.list.length - 1; i >= 0; i--) {
          const sp = __SPIDERS__.list[i];
          if (!sp.el?.isConnected) { __SPIDERS__.list.splice(i,1); continue; }
          sp.update(state.dtFixed);
        }

        state.accum-=state.dtFixed;
      }
      if(state.beetles.length===0 && state.scatters.length===0 && termites.list.length===0 && __SPIDERS__.list.length===0){ stopEngine(); return; }
      state.engineRaf=requestAnimationFrame(loop);
    };
    state.engineRaf=requestAnimationFrame(loop);
  }

  // keep a quick pointer for collisions (so spider sees current termites array as `state.termites`)
  function termitiesMirrorSync(){ state.termites = termites.list; }

  function stopEngine(){ state.running=false; if(state.engineRaf) cancelAnimationFrame(state.engineRaf); state.engineRaf=null; }

  // =================== Clear
  function clearBugs(){
    const c=document.getElementById(CONTAINER_ID); if(!c) return;

    for(const b of state.beetles) b.dispose(); state.beetles=[];
    for(const s of state.scatters) s.dispose && s.dispose(); state.scatters=[];
    for(const t of termites.list) t.dispose && t.dispose(); termites.list=[];
    state.termites = termites.list;

    // remove eat canvas (clears all black pixels)
    if (termites.eatCanvas && termites.eatCanvas.isConnected) { try { termites.eatCanvas.remove(); } catch {} }
    termites.eatCanvas = null; termites.eatCtx = null;

    // spiders
    for (const sp of __SPIDERS__.list) { try { sp.dispose(); } catch {} }
    __SPIDERS__.list.length = 0;

    stopEngine();

    c.querySelectorAll(`.${BEETLE_LAYER_CLASS}`).forEach(el=>el.remove());
    c.querySelectorAll("img.__screen_bug__").forEach(el=>el.remove());
    c.querySelectorAll(".__screen_termite__").forEach(el=>el.remove());
    c.querySelectorAll("svg").forEach(el=>{ if (el.parentElement===c || el.closest(`#${CONTAINER_ID}`)) el.remove(); });

    if(!c.firstChild) c.remove();

    if (ensureEatCanvas._boundResize) ensureEatCanvas._boundResize = false;
  }

  // =================== Bridge
  chrome.runtime.onMessage.addListener((msg)=>{
    if(msg?.type==="INJECT_BUGS") injectBugs(msg.payload||{});
    else if(msg?.type==="DUNG_BEETLE") spawnDungBeetle(msg.payload||{});
    else if(msg?.type==="RELEASE_TERMITES") releaseTermites(msg.payload||{});
    else if(msg?.type==="RELEASE_SPIDERS") releaseSpiders(msg.payload||{});
    else if(msg?.type==="CLEAR_BUGS") clearBugs();
  });

  document.addEventListener("visibilitychange",()=>{ if(!state.running) return; if(!document.hidden) state.lastTs=performance.now(); });
  window.addEventListener("blur", ()=>{ if(state.running) state.lastTs=performance.now(); });
  window.addEventListener("keydown",(e)=>{ if(e.key==="Escape") clearBugs(); }, {capture:true});
})();
