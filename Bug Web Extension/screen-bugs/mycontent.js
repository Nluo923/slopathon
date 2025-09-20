// Connect to the gaze WebSocket
const gazeSocket = new WebSocket("ws://localhost:8001");

let gaze = { x: 0.5, y: 0.5, blink: false }; // normalized [0,1]

// Update gaze coordinates on message
gazeSocket.onmessage = (event) => {
    try {
        const data = JSON.parse(event.data);
        gaze = data;
    } catch(e) {
        console.error("Failed to parse gaze data", e);
    }
};

// Start Bug generation
(() => {
  if (window.__screenBugsInjected) return;
  window.__screenBugsInjected = true;

  const CONTAINER_ID = "__screen_bugs_container__";
  const BEETLE_LAYER_CLASS = "__screen_bugs_beetle_layer__";

  // --- Z-LAYERS ---
  const Z = { BALL: 20, SCATTER: 30, SCATTER_OVER: 35, BEETLE: 40 };

  const state = { beetles: [], scatters: [], engineRaf: null, running: false, lastTs: 0, accum: 0, dtFixed: 1/60 };

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

  // Global boid defaults (per-bug modifiers add personality)
  const BOIDS_CFG = {
    maxSpeed: 350,          // px/s
    maxAccel: 150,          // px/s^2
    neighborRadius: 130,
    separationRadius: 40,
    wSeparation: 1.3,
    wAlignment: 0.8,
    wCohesion: 0.45,        // lower cohesion => less clumping
    jitterAccel: 28,        // baseline wander; per-bug adds

    // Orbit-style attraction to dung (each bug has its own ring + phase)
    attractRadius: 720,     // detection radius (you can set 1020)
    wAttract: 2,          // global multiplier; per-bug adds
    orbitMin: 80,           // min ring radius around dung
    orbitMax: 180,          // max ring radius
    tangentialBias: 0.35,   // how much to add tangential swirl

    // Edges
    wallSoft: 140,
    wallBounce: true,
    minEdgeSpeed: 80,

    // Performance
    neighborCap: 7          // only consider closest N neighbors
  };

  // Spatial grid
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

  function createScatterBug({ size = 44 } = {}) {
    const container = ensureContainer();
    const el = document.createElement("img");
    el.src = BUG_SVGS[Math.floor(Math.random() * BUG_SVGS.length)];
    const s = size * (0.85 + Math.random() * 0.3);
    Object.assign(el.style, {
        position: "absolute",
        width: `${s}px`,
        height: `${s}px`,
        left: `0px`,
        top: `0px`,
        transform: `rotate(0deg)`,
        opacity: String(0.85 + Math.random() * 0.15),
        filter: "drop-shadow(0 2px 2px rgba(0,0,0,0.35))",
        willChange: "transform, left, top",
        zIndex: String(Z.SCATTER)
    });
    el.className = "__screen_bug__";
    container.appendChild(el);

    let vw = window.innerWidth, vh = window.innerHeight;
    let x = rand(0, vw - s), y = rand(0, vh - s);
    let vx = rand(-90, 90), vy = rand(-90, 90);

    // Per-bug personality
    const p = {
        wSep: BOIDS_CFG.wSeparation * rand(0.9, 1.25),
        wAli: BOIDS_CFG.wAlignment * rand(0.7, 1.15),
        wCoh: BOIDS_CFG.wCohesion * rand(0.6, 1.1),
        wAtt: BOIDS_CFG.wAttract * rand(0.9, 1.4),
        jitterAccel: BOIDS_CFG.jitterAccel * rand(0.8, 1.4),
        neighborR: BOIDS_CFG.neighborRadius * rand(0.85, 1.15),
        sepR: BOIDS_CFG.separationRadius * rand(0.9, 1.2),
        wanderTheta: rand(0, Math.PI * 2),
        wanderRate: rand(1.5, 3.2),
        wanderStrength: rand(80, 160),
        orbitR: rand(BOIDS_CFG.orbitMin, BOIDS_CFG.orbitMax),
        orbitPhi: rand(0, Math.PI * 2),
        orbitSpeed: rand(0.6, 1.4),
        tangentialBias: BOIDS_CFG.tangentialBias * rand(0.7, 1.3)
    };

    return {
        el, s, p,
        get x() { return x + s / 2; },
        get y() { return y + s / 2; },
        _cell: null, _vx: vx, _vy: vy,

        // STOP RADIUS
        
        updateBoid(dt) {
            const STOP_RADIUS = 500;
            vw = window.innerWidth; vh = window.innerHeight;
            let x = this.x - this.s/2;
            let y = this.y - this.s/2;
            let vx = this._vx;
            let vy = this._vy;
            const px = x + this.s/2, py = y + this.s/2;

            // --- neighbors, separation, alignment, cohesion (same as before) ---
            // ... your existing neighbor code ...

            // --- wander ---
            p.wanderTheta += (rand(-1,1) * p.wanderRate) * dt;
            let wx = Math.cos(p.wanderTheta) * p.wanderStrength;
            let wy = Math.sin(p.wanderTheta) * p.wanderStrength;

            // --- attraction to gaze ---
            const gazeX = gaze.x * vw;
            const gazeY = gaze.y * vh;
            const dxToGaze = gazeX - px;
            const dyToGaze = gazeY - py;
            const distToGaze = Math.hypot(dxToGaze, dyToGaze) || 1;

            let ax = 0, ay = 0;

            if(distToGaze >= STOP_RADIUS){
                ax = p.wSep * sepX + p.wAli * aliX + p.wCoh * cohX + wx;
                ay = p.wSep * sepY + p.wAli * aliY + p.wCoh * cohY + wy;
            }

            vx += ax * dt;
            vy += ay * dt;
            ({x: vx, y: vy} = limit(vx, vy, BOIDS_CFG.maxSpeed));
            x += vx * dt;
            y += vy * dt;

            // --- keep in bounds ---
            x = clamp(x, 0, vw - this.s);
            y = clamp(y, 0, vh - this.s);

            // --- pose ---
            const rot = (Math.atan2(vy, vx) * 180) / Math.PI;
            this.el.style.left = `${x}px`;
            this.el.style.top = `${y}px`;
            this.el.style.transform = `rotate(${rot}deg)`;

            this._vx = vx;
            this._vy = vy;
        },

        dispose() { try { el.remove(); } catch { } }
    };
}

  function injectBugs({count=12,size=48}={}){ for(let i=0;i<count;i++) state.scatters.push(createScatterBug({size})); startEngine(); }

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
        x=(x+Math.cos(ang)*len+TEX_SZ)%TEX_SZ; y=(y+Math.sin(ang)*len+TEX_SZ)%TEX_SZ;
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
  function drawBallTopDown(ctx,d,rollDeg){
    const {noise,cracks}=getPatterns(ctx);
    ctx.clearRect(0,0,d,d);
    ctx.save(); ctx.beginPath(); ctx.arc(d/2,d/2,d/2,0,Math.PI*2); ctx.closePath(); ctx.clip();
    ctx.fillStyle="#5e3d23"; ctx.fillRect(0,0,d,d);
    ctx.save(); ctx.translate(d/2,d/2); ctx.rotate((rollDeg*Math.PI)/180); ctx.globalCompositeOperation="multiply";
    ctx.fillStyle=noise; const T=d*1.6; ctx.fillRect(-T/2,-T/2,T,T); ctx.restore();
    ctx.save(); ctx.translate(d/2,d/2); ctx.rotate((rollDeg*Math.PI)/180); ctx.globalCompositeOperation="multiply"; ctx.globalAlpha=0.75;
    ctx.fillStyle=cracks; ctx.fillRect(-T/2,-T/2,T,T); ctx.globalAlpha=1; ctx.restore();
    ctx.globalCompositeOperation="multiply"; ctx.drawImage(getVignette(d),0,0);
    ctx.restore();
  }

  function spawnDungBeetle({speed=180,maxBall=160}={}){
    const container=ensureContainer();
    const layer=document.createElement("div");
    layer.className=BEETLE_LAYER_CLASS; Object.assign(layer.style,{position:"absolute",inset:0,pointerEvents:"none"});

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
        const dAng = angDiff(heading, targetHeading);
        const turn = Math.max(Math.min(dAng, maxTurnRate * dt), -maxTurnRate * dt);
        heading += turn;

        // --- calculate movement
        let dx = Math.cos(heading) * speed * dt;
        let dy = Math.sin(heading) * speed * dt;

        // --- gaze attraction
        const gazeX = gaze.x * window.innerWidth;
        const gazeY = gaze.y * window.innerHeight;
        const gx = gazeX - x;
        const gy = gazeY - y;
        const distG = Math.hypot(gx, gy) || 1;
        const gazeStrength = 1000; // adjust for responsiveness
        dx += (gx / distG) * gazeStrength * dt;
        dy += (gy / distG) * gazeStrength * dt;

        const oldX = x, oldY = y;
        x += dx; y += dy;

        // --- handle collisions with viewport walls
        let bounced = false;
        const vw = window.innerWidth, vh = window.innerHeight;
        if(x - radius < 0){ x = radius; bounced = true; }
        if(x + radius > vw){ x = vw - radius; bounced = true; }
        if(y - radius < 0){ y = radius; bounced = true; }
        if(y + radius > vh){ y = vh - radius; bounced = true; }

        if(bounced){ 
            heading = reflectHeadingOnWalls(heading); 
            targetHeading = pickNewTarget(heading); 
            timeToWander = wanderEvery; 
        } else { 
            timeToWander -= dt; 
            if(timeToWander <= 0){ 
                targetHeading = pickNewTarget(heading); 
                timeToWander = wanderEvery + rand(-0.6,0.6); 
            } 
        }

        // --- handle ball growth and rolling
        const seg = Math.hypot(x - oldX, y - oldY);
        distSinceGrow += seg;
        if(diameter < maxBall && distSinceGrow >= pixelsPerGrow){
            const inc = Math.floor(distSinceGrow / pixelsPerGrow);
            diameter = Math.min(maxBall, diameter + inc * growthPx); 
            radius = diameter / 2; 
            distSinceGrow %= pixelsPerGrow;
            placeAndRender(true, seg);
        } else placeAndRender(false, seg);

        // --- color change 
        const beetleLeft = x - radius;
        const beetleRight = x + radius;
        const beetleTop = y - radius;
        const beetleBottom = y + radius;

        if (gazeX+200 >= beetleLeft && gazeX-200 <= beetleRight &&
            gazeY+200 >= beetleTop && gazeY-200 <= beetleBottom) {
            beetle.querySelector('g').setAttribute('fill', 'blue');
        } else {
            beetle.querySelector('g').setAttribute('fill', '#1a1a1a');
        }
      },
      dispose(){ try{layer.remove();}catch{} }
    };

    state.beetles.push(beetleObj);
    placeAndRender(true,0);
    startEngine();
  }

  // =================== Engine loop (rebuild grid each step)
  function startEngine(){
    if(state.running) return; state.running=true; state.lastTs=performance.now(); state.accum=0;
    const loop=(ts)=>{
      if(!state.running) return;
      const dt=Math.min(0.1,(ts-state.lastTs)/1000); state.lastTs=ts;
      if(document.hidden){ state.engineRaf=requestAnimationFrame(loop); return; }
      state.accum+=dt;
      while(state.accum>=state.dtFixed){
        grid.clear(); for(let i=0;i<state.scatters.length;i++) grid.insert(state.scatters[i]);
        for(let i=state.beetles.length-1;i>=0;i--){ const b=state.beetles[i]; if(!b.alive){ state.beetles.splice(i,1); continue;} b.update(state.dtFixed); }
        for(let i=state.scatters.length-1;i>=0;i--){ const s=state.scatters[i]; if(!s.el.isConnected){ state.scatters.splice(i,1); continue;} s.updateBoid(state.dtFixed); }
        state.accum-=state.dtFixed;
      }
      if(state.beetles.length===0 && state.scatters.length===0){ stopEngine(); return; }
      state.engineRaf=requestAnimationFrame(loop);
    };
    state.engineRaf=requestAnimationFrame(loop);
  }
  function stopEngine(){ state.running=false; if(state.engineRaf) cancelAnimationFrame(state.engineRaf); state.engineRaf=null; }

  // =================== Clear
  function clearBugs(){
    const c=document.getElementById(CONTAINER_ID); if(!c) return;
    for(const b of state.beetles) b.dispose(); state.beetles=[];
    for(const s of state.scatters) s.dispose && s.dispose(); state.scatters=[];
    stopEngine();
    c.querySelectorAll(`.${BEETLE_LAYER_CLASS}`).forEach(el=>el.remove());
    c.querySelectorAll("img.__screen_bug__").forEach(el=>el.remove());
    if(!c.firstChild) c.remove();
  }

  // =================== Bridge
  chrome.runtime.onMessage.addListener((msg)=>{
    if(msg?.type==="INJECT_BUGS") injectBugs(msg.payload||{});
    else if(msg?.type==="DUNG_BEETLE") spawnDungBeetle(msg.payload||{});
    else if(msg?.type==="CLEAR_BUGS") clearBugs();
  });

  document.addEventListener("visibilitychange",()=>{ if(!state.running) return; if(!document.hidden) state.lastTs=performance.now(); });
  window.addEventListener("blur", ()=>{ if(state.running) state.lastTs=performance.now(); });
  window.addEventListener("keydown",(e)=>{ if(e.key==="Escape") clearBugs(); }, {capture:true});
})();