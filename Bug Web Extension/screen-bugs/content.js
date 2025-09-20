(() => {
  if (window.__screenBugsInjected) return;
  window.__screenBugsInjected = true;

  const CONTAINER_ID = "__screen_bugs_container__";
  const BEETLE_LAYER_CLASS = "__screen_bugs_beetle_layer__";
  const EYE_TRACKER_ID = "__eye_tracker_dot__";

  // --- Z-LAYERS ---
  const Z = { BALL: 20, SCATTER: 30, SCATTER_OVER: 35, BEETLE: 40, EYE_TRACKER: 50 };

  const state = { 
    beetles: [], 
    scatters: [], 
    engineRaf: null, 
    running: false, 
    lastTs: 0, 
    accum: 0, 
    dtFixed: 1/60,
    eyeTracking: {
      active: false,
      dot: null,
      lastGaze: { x: 0, y: 0 },
      calibrationMode: false,
      calibrationPoints: [],
      currentCalibrationIndex: 0
    }
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

  // =================== EYE TRACKING ===================
  function createEyeTrackerDot() {
    if (state.eyeTracking.dot) return state.eyeTracking.dot;
    
    const container = ensureContainer();
    const dot = document.createElement("div");
    dot.id = EYE_TRACKER_ID;
    Object.assign(dot.style, {
      position: "fixed",
      width: "12px",
      height: "12px",
      borderRadius: "50%",
      backgroundColor: "#ff4444",
      border: "2px solid #fff",
      boxShadow: "0 0 8px rgba(255, 68, 68, 0.6)",
      pointerEvents: "none",
      zIndex: String(Z.EYE_TRACKER),
      transform: "translate(-50%, -50%)",
      transition: "all 0.1s ease-out",
      opacity: "0.8"
    });
    
    container.appendChild(dot);
    state.eyeTracking.dot = dot;
    return dot;
  }

  function createCalibrationPoint(x, y, index) {
    const container = ensureContainer();
    const point = document.createElement("div");
    point.className = "__calibration_point__";
    Object.assign(point.style, {
      position: "fixed",
      left: `${x}px`,
      top: `${y}px`,
      width: "20px",
      height: "20px",
      borderRadius: "50%",
      backgroundColor: "#4CAF50",
      border: "3px solid #fff",
      boxShadow: "0 0 12px rgba(76, 175, 80, 0.8)",
      transform: "translate(-50%, -50%)",
      zIndex: String(Z.EYE_TRACKER + 1),
      cursor: "pointer",
      pointerEvents: "auto",
      animation: "pulse 1.5s infinite"
    });

    // Add pulsing animation
    if (!document.getElementById("__calibration_styles__")) {
      const style = document.createElement("style");
      style.id = "__calibration_styles__";
      style.textContent = `
        @keyframes pulse {
          0% { transform: translate(-50%, -50%) scale(1); }
          50% { transform: translate(-50%, -50%) scale(1.2); }
          100% { transform: translate(-50%, -50%) scale(1); }
        }
      `;
      document.head.appendChild(style);
    }

    // Add click handler for calibration
    point.addEventListener("click", () => {
      if (window.webgazer && state.eyeTracking.calibrationMode) {
        // Record calibration point
        window.webgazer.recordScreenPosition(x, y, 'click');
        point.style.backgroundColor = "#2196F3";
        point.style.animation = "none";
        
        setTimeout(() => {
          point.remove();
          state.eyeTracking.currentCalibrationIndex++;
          
          if (state.eyeTracking.currentCalibrationIndex < state.eyeTracking.calibrationPoints.length) {
            const nextPoint = state.eyeTracking.calibrationPoints[state.eyeTracking.currentCalibrationIndex];
            createCalibrationPoint(nextPoint.x, nextPoint.y, state.eyeTracking.currentCalibrationIndex);
          } else {
            // Calibration complete
            finishCalibration();
          }
        }, 500);
      }
    });

    container.appendChild(point);
    return point;
  }

  function startEyeTracking(options = {}) {
    if (!window.webgazer) {
      console.error("WebGazer.js not loaded");
      chrome.runtime.sendMessage({
        type: "EYE_TRACKING_ERROR",
        payload: { error: "WebGazer.js not loaded" }
      });
      return;
    }

    try {
      state.eyeTracking.active = true;
      createEyeTrackerDot();

      // Configure WebGazer
      window.webgazer
        .setGazeListener((data, timestamp) => {
          if (data && state.eyeTracking.active && state.eyeTracking.dot && !state.eyeTracking.calibrationMode) {
            const x = data.x;
            const y = data.y;
            
            // Update dot position
            state.eyeTracking.dot.style.left = `${x}px`;
            state.eyeTracking.dot.style.top = `${y}px`;
            state.eyeTracking.lastGaze = { x, y };

            // Send data to background script
            chrome.runtime.sendMessage({
              type: "EYE_TRACKING_DATA",
              payload: { x, y, timestamp }
            });
          }
        })
        .begin();

      // Hide the video preview if requested
      if (!options.showVideo) {
        setTimeout(() => {
          const video = document.getElementById('webgazerVideoFeed');
          if (video) {
            video.style.display = 'none';
          }
        }, 1000);
      }

      // Hide prediction points if requested
      if (!options.showPredictions) {
        window.webgazer.showPredictionPoints(false);
      }

      console.log("Eye tracking started");
      
    } catch (error) {
      console.error("Error starting eye tracking:", error);
      chrome.runtime.sendMessage({
        type: "EYE_TRACKING_ERROR",
        payload: { error: error.message }
      });
    }
  }

  function stopEyeTracking() {
    if (window.webgazer) {
      window.webgazer.end();
    }
    
    state.eyeTracking.active = false;
    state.eyeTracking.calibrationMode = false;
    
    if (state.eyeTracking.dot) {
      state.eyeTracking.dot.remove();
      state.eyeTracking.dot = null;
    }

    // Clean up calibration points
    document.querySelectorAll(".__calibration_point__").forEach(el => el.remove());
    
    // Hide video feed
    const video = document.getElementById('webgazerVideoFeed');
    if (video) {
      video.style.display = 'none';
    }

    console.log("Eye tracking stopped");
  }

  function startCalibration() {
    if (!window.webgazer) {
      console.error("WebGazer.js not loaded");
      return;
    }

    state.eyeTracking.calibrationMode = true;
    state.eyeTracking.currentCalibrationIndex = 0;
    
    // Define calibration points (9-point calibration)
    const margin = 100;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    
    state.eyeTracking.calibrationPoints = [
      // Corners
      { x: margin, y: margin },
      { x: vw - margin, y: margin },
      { x: vw - margin, y: vh - margin },
      { x: margin, y: vh - margin },
      // Center and mid-points
      { x: vw / 2, y: vh / 2 },
      { x: vw / 2, y: margin },
      { x: vw - margin, y: vh / 2 },
      { x: vw / 2, y: vh - margin },
      { x: margin, y: vh / 2 }
    ];

    // Start WebGazer if not already started
    if (!state.eyeTracking.active) {
      startEyeTracking({ showVideo: true, showPredictions: false });
    }

    // Create first calibration point
    setTimeout(() => {
      if (state.eyeTracking.calibrationPoints.length > 0) {
        const firstPoint = state.eyeTracking.calibrationPoints[0];
        createCalibrationPoint(firstPoint.x, firstPoint.y, 0);
        
        // Show instructions
        showCalibrationInstructions();
      }
    }, 1500);
  }

  function showCalibrationInstructions() {
    const instructions = document.createElement("div");
    instructions.id = "__calibration_instructions__";
    instructions.innerHTML = `
      <div style="
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0, 0, 0, 0.8);
        color: white;
        padding: 15px 25px;
        border-radius: 8px;
        font-family: Arial, sans-serif;
        font-size: 14px;
        z-index: ${Z.EYE_TRACKER + 10};
        text-align: center;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      ">
        👁️ <strong>Eye Tracking Calibration</strong><br>
        Click on each green dot while looking at it<br>
        <small>Point ${state.eyeTracking.currentCalibrationIndex + 1} of ${state.eyeTracking.calibrationPoints.length}</small>
      </div>
    `;
    
    ensureContainer().appendChild(instructions);
  }

  function finishCalibration() {
    state.eyeTracking.calibrationMode = false;
    
    // Remove instructions
    const instructions = document.getElementById("__calibration_instructions__");
    if (instructions) {
      instructions.remove();
    }

    // Hide video feed after calibration
    setTimeout(() => {
      const video = document.getElementById('webgazerVideoFeed');
      if (video) {
        video.style.display = 'none';
      }
    }, 1000);

    // Show completion message
    const completion = document.createElement("div");
    completion.innerHTML = `
      <div style="
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(76, 175, 80, 0.9);
        color: white;
        padding: 20px 30px;
        border-radius: 8px;
        font-family: Arial, sans-serif;
        font-size: 16px;
        z-index: ${Z.EYE_TRACKER + 10};
        text-align: center;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      ">
        ✅ <strong>Calibration Complete!</strong><br>
        Eye tracking is now active
      </div>
    `;
    
    ensureContainer().appendChild(completion);
    
    setTimeout(() => {
      completion.remove();
    }, 3000);

    chrome.runtime.sendMessage({
      type: "CALIBRATION_COMPLETE",
      payload: { timestamp: Date.now() }
    });

    console.log("Eye tracking calibration completed");
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

    // Eye tracking attraction
    eyeAttractRadius: 300,  // pixels from eye gaze
    wEyeAttract: 1.5,       // attraction strength to eye position
    eyeOrbitRadius: 50,     // how close bugs will get to eye position

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

    // -------- per-bug personality
    const p = {
      // small % variations so they don't sync
      wSep:  BOIDS_CFG.wSeparation * rand(0.9, 1.25),
      wAli:  BOIDS_CFG.wAlignment  * rand(0.7, 1.15),
      wCoh:  BOIDS_CFG.wCohesion   * rand(0.6, 1.1),
      wAtt:  BOIDS_CFG.wAttract    * rand(0.9, 1.4),
      wEyeAtt: BOIDS_CFG.wEyeAttract * rand(0.7, 1.8), // eye attraction personality
      jitterAccel: BOIDS_CFG.jitterAccel * rand(0.8, 1.4),
      neighborR: BOIDS_CFG.neighborRadius * rand(0.85, 1.15),
      sepR: BOIDS_CFG.separationRadius * rand(0.9, 1.2),
      // wander (Reynolds): angle & strength
      wanderTheta: rand(0, Math.PI*2),
      wanderRate: rand(1.5, 3.2),      // rad/s change
      wanderStrength: rand(80, 160),   // px/s^2
      // orbit assignment
      orbitR: rand(BOIDS_CFG.orbitMin, BOIDS_CFG.orbitMax),
      orbitPhi: rand(0, Math.PI*2),
      orbitSpeed: rand(0.6, 1.4),      // rad/s around dung
      tangentialBias: BOIDS_CFG.tangentialBias * rand(0.7, 1.3)
    };

    return {
      el, s, p,
      get x(){return x + s/2;},
      get y(){return y + s/2;},
      _cell:null, _vx:vx, _vy:vy,

      updateBoid(dt){
        vw=window.innerWidth; vh=window.innerHeight;
        const px=this.x, py=this.y;

        // --- neighbors -> collect nearest up to cap
        const candidates=grid.neighbors(this, p.neighborR);
        // compute squared distances and pick closest few
        const neigh = [];
        for(let i=0;i<candidates.length;i++){
          const n=candidates[i]; if(n===this) continue;
          const dx=n.x-px, dy=n.y-py; const d2=dx*dx+dy*dy;
          if(d2===0 || d2>p.neighborR*p.neighborR) continue;
          neigh.push({n, d2});
        }
        neigh.sort((a,b)=>a.d2-b.d2);
        if(neigh.length>BOIDS_CFG.neighborCap) neigh.length = BOIDS_CFG.neighborCap;

        // accumulators
        let sepX=0, sepY=0, aliX=0, aliY=0, cohX=0, cohY=0;
        const ncount = neigh.length;
        for(let i=0;i<ncount;i++){
          const m = neigh[i].n;
          const dx = m.x - px, dy = m.y - py;
          const d2 = neigh[i].d2;
          if(d2 < p.sepR*p.sepR){
            const d = Math.sqrt(d2)||1;
            // inverse falloff for stronger push when too close
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

        // --- wander (Reynolds)
        p.wanderTheta += (rand(-1,1)*p.wanderRate) * dt;
        let wx = Math.cos(p.wanderTheta), wy = Math.sin(p.wanderTheta);
        wx *= p.wanderStrength; wy *= p.wanderStrength;

        // --- EYE TRACKING ATTRACTION ---
        let eyeAx = 0, eyeAy = 0, eyeBias = 0;
        if (state.eyeTracking.active && state.eyeTracking.lastGaze.x && state.eyeTracking.lastGaze.y) {
          const eyeX = state.eyeTracking.lastGaze.x;
          const eyeY = state.eyeTracking.lastGaze.y;
          const eyeDx = eyeX - px, eyeDy = eyeY - py;
          const eyeDist = Math.hypot(eyeDx, eyeDy);
          
          if (eyeDist < BOIDS_CFG.eyeAttractRadius && eyeDist > BOIDS_CFG.eyeOrbitRadius) {
            // Attract to eye position but maintain some orbit distance
            const eyeNx = eyeDx / eyeDist, eyeNy = eyeDy / eyeDist;
            const targetDist = BOIDS_CFG.eyeOrbitRadius;
            const desiredX = eyeX - eyeNx * targetDist;
            const desiredY = eyeY - eyeNy * targetDist;
            
            const toDesiredX = desiredX - px, toDesiredY = desiredY - py;
            const desiredVelX = (toDesiredX / Math.hypot(toDesiredX, toDesiredY)) * BOIDS_CFG.maxSpeed * 0.6;
            const desiredVelY = (toDesiredY / Math.hypot(toDesiredX, toDesiredY)) * BOIDS_CFG.maxSpeed * 0.6;
            
            eyeAx = (desiredVelX - vx) * p.wEyeAtt;
            eyeAy = (desiredVelY - vy) * p.wEyeAtt;
            
            // Bias factor affects other behaviors
            eyeBias = Math.max(0, 1 - eyeDist / BOIDS_CFG.eyeAttractRadius);
          }
        }

        // --- attraction (SEEK to personal orbit point + tangential swirl)
        let attAx=0, attAy=0, dungBias=0;
        const nd=nearestDung(px,py);
        if(nd){
          // advance personal orbit phase
          p.orbitPhi += p.orbitSpeed * dt;
          const goalX = nd.x + Math.cos(p.orbitPhi) * (nd.r + p.orbitR);
          const goalY = nd.y + Math.sin(p.orbitPhi) * (nd.r + p.orbitR);
          // desired velocity toward orbit point
          const toGX = goalX - px, toGY = goalY - py;
          const dG = Math.hypot(toGX,toGY)||1;
          const desiredX = (toGX/dG) * BOIDS_CFG.maxSpeed;
          const desiredY = (toGY/dG) * BOIDS_CFG.maxSpeed;
          // add a small tangential component (perpendicular) for swirl
          const tx = -toGY/dG, ty = toGX/dG;
          const swirlX = tx * BOIDS_CFG.maxSpeed * p.tangentialBias;
          const swirlY = ty * BOIDS_CFG.maxSpeed * p.tangentialBias;

          let steerX = (desiredX + swirlX) - vx;
          let steerY = (desiredY + swirlY) - vy;
          ({x:steerX, y:steerY} = limit(steerX, steerY, BOIDS_CFG.maxAccel));

          // distance-based gain: strong inside radius, faint tail beyond
          const d = Math.hypot(nd.x - px, nd.y - py);
          const near = Math.max(0, 1 - d / BOIDS_CFG.attractRadius);
          const far  = 1 / (1 + 0.004 * d);
          const gain = near + far;
          attAx = steerX * p.wAtt * gain;
          attAy = steerY * p.wAtt * gain;
          dungBias = gain;
        }

        // --- combine accelerations (eye tracking has priority over dung when active)
        const totalBias = Math.max(eyeBias, dungBias);
        let ax = p.wSep*sepX + p.wAli*aliX + p.wCoh*cohX + attAx + eyeAx + wx;
        let ay = p.wSep*sepY + p.wAli*aliY + p.wCoh*cohY + attAy + eyeAy + wy;

        // --- soft edge steer (relaxed if something is pulling)
        const soften = totalBias > 0.25 ? 0.35 : 1.0;
        const m = BOIDS_CFG.wallSoft;
        if(px < m) ax += soften * (m - px) / m * BOIDS_CFG.maxAccel * 0.15;
        if(py < m) ay += soften * (m - py) / m * BOIDS_CFG.maxAccel * 0.15;
        if(px > vw - m) ax -= soften * (px - (vw - m)) / m * BOIDS_CFG.maxAccel * 0.15;
        if(py > vh - m) ay -= soften * (py - (vh - m)) / m * BOIDS_CFG.maxAccel * 0.15;

        // --- per-bug extra jitter (reduced when attracted to eye)
        let jx = rand(-1,1), jy = rand(-1,1);
        ({x:jx,y:jy}=norm(jx,jy));
        const jitterReduction = eyeBias > 0.3 ? 0.3 : 1.0; // calmer near eyes
        jx *= (p.jitterAccel * jitterReduction); jy *= (p.jitterAccel * jitterReduction);
        ax += jx; ay += jy;

        // --- integrate
        ({x:ax,y:ay}=limit(ax,ay,BOIDS_CFG.maxAccel));
        vx += ax * dt; vy += ay * dt;
        ({x:vx,y:vy}=limit(vx,vy,BOIDS_CFG.maxSpeed));
        x += vx * dt; y += vy * dt;

        // --- hard bounce
        if(BOIDS_CFG.wallBounce){
          const minS=BOIDS_CFG.minEdgeSpeed;
          if(x<0){ x=0; vx=Math.abs(vx)<minS?minS:Math.abs(vx); }
          if(y<0){ y=0; vy=Math.abs(vy)<minS?minS:Math.abs(vy); }
          if(x>vw-this.s){ x=vw-this.s; vx=-(Math.abs(vx)<minS?minS:Math.abs(vx)); }
          if(y>vh-this.s){ y=vh-this.s; vy=-(Math.abs(vy)<minS?minS:Math.abs(vy)); }
        }else{
          x=clamp(x,0,vw-this.s); y=clamp(y,0,vh-this.s);
        }

        // pose
        const rot=(Math.atan2(vy,vx)*180)/Math.PI;
        this.el.style.left=`${x}px`; this.el.style.top=`${y}px`; this.el.style.transform=`rotate(${rot}deg)`;

        // --- Lift bug above dung ball when overlapping ---
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

        // expose vel for neighbors
        this._vx=vx; this._vy=vy;
      },

      dispose(){ try{el.remove();}catch{} }
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
      if(state.beetles.length===0 && state.scatters.length===0 && !state.eyeTracking.active){ stopEngine(); return; }
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
    stopEyeTracking(); // Also stop eye tracking
    c.querySelectorAll(`.${BEETLE_LAYER_CLASS}`).forEach(el=>el.remove());
    c.querySelectorAll("img.__screen_bug__").forEach(el=>el.remove());
    c.querySelectorAll(".__calibration_point__").forEach(el=>el.remove());
    const instructions = document.getElementById("__calibration_instructions__");
    if (instructions) instructions.remove();
    const styles = document.getElementById("__calibration_styles__");
    if (styles) styles.remove();
    if(!c.firstChild) c.remove();
  }

  // =================== Bridge
  chrome.runtime.onMessage.addListener((msg)=>{
    if(msg?.type==="INJECT_BUGS") injectBugs(msg.payload||{});
    else if(msg?.type==="DUNG_BEETLE") spawnDungBeetle(msg.payload||{});
    else if(msg?.type==="CLEAR_BUGS") clearBugs();
    else if(msg?.type==="START_EYE_TRACKING") startEyeTracking(msg.payload||{});
    else if(msg?.type==="STOP_EYE_TRACKING") stopEyeTracking();
    else if(msg?.type==="CALIBRATE_EYE_TRACKING") startCalibration();
  });

  document.addEventListener("visibilitychange",()=>{ if(!state.running) return; if(!document.hidden) state.lastTs=performance.now(); });
  window.addEventListener("blur", ()=>{ if(state.running) state.lastTs=performance.now(); });
  window.addEventListener("keydown",(e)=>{ if(e.key==="Escape") clearBugs(); }, {capture:true});
})();