// js/script.js

// Constants
// Base letter count with mobile override
const BASE_NUM_LETTERS = 600;
const NUM_LETTERS = window.innerWidth < 1024
  ? Math.floor(BASE_NUM_LETTERS / 2)  // half on narrow screens
  : BASE_NUM_LETTERS;
const EXPAND_DUR = 3000;    // ms expand (3 s)
const CONTRACT_DUR = 2000;  // ms contract (2 s)
const FADE_IN_DUR = 1000;   // ms for full fade-in
const FADE_OUT_DUR = 500;   // ms for fade-out during contract
// Clear-zone ratio: larger on mobile for bigger blank space
const MAX_RADIUS_RATIO = window.innerWidth < 768 
  ? 0.45   // 50% of viewport on mobile
  : 0.3;  // 30% on desktop

// Smooth drift/wobble constants
const DRIFT_AMP = 10;      // max position offset in px
const ROT_AMP = 5;         // max rotation offset in degrees
const DRIFT_PERIOD = 15000; // drift cycle in ms (slower drift)
const QUOTE_DRIFT_AMP = 5;   // small positional drift for quote letters
const QUOTE_ROT_AMP  = 10;   // increased rotational drift for quote letters

// Global state
const container = document.getElementById("soup-container");
const clearZone = document.getElementById("clear-zone");
const messageContainer = document.getElementById("message-container");
let messageVisible = false;
const letters = [];
let clearStart = null;
let maxClearRadius = 0;
let quotes = [];  // will be populated from Google Sheet
const SHEET_ID = "1sg6EYIZh4KXZnqSpqmNCEFjCtqeKokUn-JDsGUrz984";      // replace with your sheet ID
const SHEET_NAME = "Eugene Quotes";                // replace with your sheet name/tab

// Cursor repulsion
let cursorX = null, cursorY = null;
const CURSOR_RADIUS = 150;       // radius of repulsion in px
const CURSOR_STRENGTH = 0.8;     // increased repulsion strength

// Click position for clear bubble
let clickX = null;
let clickY = null;

// Fetch quotes from Google Sheets on load
fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?sheet=${SHEET_NAME}`)
  .then(res => res.text())
  .then(text => {
    // Strip the leading function wrapper
    const json = JSON.parse(text.match(/google\.visualization\.Query\.setResponse\(([\s\S]*)\)/)[1]);
    const rows = json.table.rows;
    // Assume first column has the quote text
    quotes = rows.map(r => r.c[0]?.v).filter(Boolean);
  })
  .catch(err => console.error("Failed to load quotes:", err));

// Shake handler attachment
function addShakeListener() {
  let lastAcc = { x: 0, y: 0, z: 0 };
  window.addEventListener('devicemotion', e => {
    // prefer acceleration without gravity (true shake), fallback otherwise
    const a = e.acceleration;
    if (!a) return;  // only proceed if true accelerometer data is available
    // compute change from last frame
    const dx = (a.x || 0) - lastAcc.x;
    const dy = (a.y || 0) - lastAcc.y;
    const dz = (a.z || 0) - lastAcc.z;
    const delta = Math.hypot(dx, dy, dz);
    const now = Date.now();
    if (delta > SHAKE_THRESHOLD && now - lastShakeTime > SHAKE_COOLDOWN) {
      lastShakeTime = now;
      triggerClear();
    }
    // update lastAcc for next event
    lastAcc = { x: a.x || 0, y: a.y || 0, z: a.z || 0 };
  });
}

// --- Motion permission helper (for iOS/Android) ---
async function enableMotion() {
  if (typeof DeviceMotionEvent?.requestPermission === 'function') {
    try {
      const state = await DeviceMotionEvent.requestPermission();
      console.log('Motion permission:', state);
      if (state === 'granted') {
        addShakeListener();
      }
    } catch (e) {
      console.error('Motion permission error', e);
    }
  }
}

let motionEnabled = false;
// Prompt for permission on first touch
window.addEventListener('touchstart', async () => {
  if (!motionEnabled) {
    await enableMotion();
    motionEnabled = true;
  }
}, { once: true });

// On platforms without motion-permission API (e.g. Android Chrome), attach immediately
if (typeof DeviceMotionEvent?.requestPermission !== 'function') {
  addShakeListener();
}

// Helpers
function lerp(a, b, t) { return a + (b - a) * t; }
function easeOut6(t) { return 1 - Math.pow(1 - t, 6); }

// 1) Generate jittered-grid targets
function generateTargets() {
  const w = window.innerWidth, h = window.innerHeight;
  const aspect = w / h;
  let cols = Math.round(Math.sqrt(NUM_LETTERS * aspect));
  let rows = Math.ceil(NUM_LETTERS / cols);
  const cellW = w / cols, cellH = h / rows;
  const pts = [];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      pts.push({
        x: i * cellW + Math.random() * cellW,
        y: j * cellH + Math.random() * cellH
      });
    }
  }
  // shuffle & limit
  pts.sort(() => Math.random() - 0.5);
  return pts.slice(0, NUM_LETTERS);
}

// 2) Initialize letters at targets
function initSoup() {
  const targets = generateTargets();
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  maxClearRadius = Math.min(window.innerWidth, window.innerHeight) * MAX_RADIUS_RATIO;

  for (let i = 0; i < NUM_LETTERS; i++) {
    const t = targets[i];
    const img = document.createElement("img");
    img.src = `images/${"abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]}.svg`;
    img.className = "letter";
    container.appendChild(img);
    // start near target with small jitter
    const jitter = 5;
    letters.push({
      el: img,
      restX: t.x,
      restY: t.y,
      x: t.x + (Math.random() * 2 - 1) * jitter,
      y: t.y + (Math.random() * 2 - 1) * jitter,
      rotation: Math.random() * 360,
      rotationSpeed: (Math.random() - 0.5) * 0.02,
      driftOffset: Math.random() * DRIFT_PERIOD,
      vx: 0,
      vy: 0
    });
  }

  // Only click/tap triggers the bubble, clamped to viewport edges
  window.addEventListener("click", e => {
    const r = maxClearRadius;
    // clamp so circle stays fully on-screen
    clickX = Math.min(Math.max(e.clientX, r), window.innerWidth  - r);
    clickY = Math.min(Math.max(e.clientY, r), window.innerHeight - r);
    triggerClear();
  });

  // No initial hidden class; CSS handles default hidden state
  animate();
}

// 3) Trigger clear ripple
function triggerClear() {
  // Debug: log that triggerClear ran and the click coordinates
  console.log('triggerClear 🔔 clickX, clickY =', clickX, clickY);
  clearStart = performance.now();
  messageContainer.classList.remove('fade-out');
  // Lock the message-container size to full circle diameter
  const fullDia = maxClearRadius * 2;
  messageContainer.style.width  = `${fullDia}px`;
  messageContainer.style.height = `${fullDia}px`;
  // Show the message via CSS class
  messageContainer.classList.add('visible');
  // pick and display a new quote (if loaded)
  if (quotes.length > 0) {
    const q = quotes[Math.floor(Math.random() * quotes.length)];
    // insert each word as inline-block span with character images and real spaces
    messageContainer.innerHTML = "";
    q.split(" ").forEach((word, wi, arr) => {
      // Wrap each word in an inline-block span
      const wordSpan = document.createElement("span");
      wordSpan.className = "word";
      // Add each character image
      [...word].forEach(ch => {
        const img = document.createElement("img");
        img.src = `images/${ch.toLowerCase()}.svg`;
        img.alt = ch;
        img.className = "letter drift-letter";
        // Start fully hidden; opacity will be driven by our staggered fade-in
        img.style.opacity = 0;
        // assign random drift offsets (±5px) and rotation (±10deg)
        const dx = (Math.random() * 10 - 5).toFixed(2) + "px";
        const dy = (Math.random() * 10 - 5).toFixed(2) + "px";
        const dr = (Math.random() * 20 - 10).toFixed(2) + "deg";
        img.style.setProperty("--dx", dx);
        img.style.setProperty("--dy", dy);
        img.style.setProperty("--dr", dr);
        wordSpan.appendChild(img);
        // give each letter its own random phase for independent drift
        img._driftOffset = Math.random() * DRIFT_PERIOD;
      });
      messageContainer.appendChild(wordSpan);
      // Add a normal space text node between words
      if (wi < arr.length - 1) {
        messageContainer.appendChild(document.createTextNode(" "));
      }
    });
    // Debug: log the built HTML for the message
    console.log('after build:', messageContainer.innerHTML);
    // Show the message container (scales up via CSS)
    messageContainer.classList.remove('fade-out');
    messageContainer.classList.add('visible');

    // ---- Per-letter fade-in based on distance from center ----
    const letterImgs = messageContainer.querySelectorAll('img.letter');
    // Compute bubble center and max distance (corner)
    const containerRect = messageContainer.getBoundingClientRect();
    const centerX = containerRect.left + containerRect.width  / 2;
    const centerY = containerRect.top  + containerRect.height / 2;
    const maxDist = Math.hypot(containerRect.width / 2, containerRect.height / 2);
    // Fade parameters
    const fadeDur = 500;          // each letter fades over 500 ms
    const totalWindow = 1500;     // staggered start within 1.5 s so full in by 2 s
    letterImgs.forEach(img => {
      // start hidden
      img.style.opacity = '0';
      img.style.transition = `opacity ${fadeDur}ms ease-out`;
      // letter center
      const r = img.getBoundingClientRect();
      const lx = r.left + r.width  / 2;
      const ly = r.top  + r.height / 2;
      // normalized distance [0–1]
      const dist = Math.hypot(lx - centerX, ly - centerY);
      const norm = Math.min(dist / maxDist, 1);
      // delay proportional to distance
      const delay = norm * (totalWindow - fadeDur);
      setTimeout(() => {
        img.style.opacity = '1';
      }, delay);
    });

    // ---- Schedule per-letter fade-out at contraction start ----
    setTimeout(() => {
      letterImgs.forEach(img => {
        img.style.transition = 'opacity 500ms ease-in';
        img.style.opacity = '0';
      });
    }, EXPAND_DUR);
  }
}

// 4) Animation loop
function animate() {
  const now = performance.now();
  // Determine and clamp bubble center
  const r = maxClearRadius;
  const cxRaw = clickX != null ? clickX : window.innerWidth  / 2;
  const cyRaw = clickY != null ? clickY : window.innerHeight / 2;
  const cx = Math.min(Math.max(cxRaw, r), window.innerWidth  - r);
  const cy = Math.min(Math.max(cyRaw, r), window.innerHeight - r);

  // Compute clear-radius and toggle message visibility
  let clearRadius = 0;
  if (clearStart !== null) {
    const dt = now - clearStart;
    if (dt < EXPAND_DUR) {
      clearRadius = easeOut6(dt / EXPAND_DUR) * maxClearRadius;
    } else if (dt < EXPAND_DUR + CONTRACT_DUR) {
      const t2 = (dt - EXPAND_DUR) / CONTRACT_DUR;
      clearRadius = easeOut6(1 - t2) * maxClearRadius;
    } else {
      // animation complete
      clearStart = null;
      clearRadius = 0;
    }
  }
  // Size and position the clear-zone
  const diameter = clearRadius * 2;
  clearZone.style.width  = `${diameter}px`;
  clearZone.style.height = `${diameter}px`;
  clearZone.style.left   = `${cx - clearRadius}px`;
  clearZone.style.top    = `${cy - clearRadius}px`;

  // Removed: Match the message bubble’s size to the clear circle
  // const msgDiameter = clearRadius * 2;
  // messageContainer.style.width  = `${msgDiameter}px`;
  // messageContainer.style.height = `${msgDiameter}px`;

  // Once expansion completes, trigger CSS fade-out
  if (clearStart !== null) {
    const dt = now - clearStart;
    if (dt >= EXPAND_DUR) {
      // Start fade-out: keep container at full scale
      messageContainer.classList.add('fade-out');
      // Fade out each letter over FADE_OUT_DUR
      messageContainer.querySelectorAll('img.letter').forEach(img => {
        img.style.transition = `opacity ${FADE_OUT_DUR}ms ease-in`;
        img.style.opacity = '0';
      });
      // After fade-out completes, hide container
      setTimeout(() => {
        messageContainer.classList.remove('visible', 'fade-out');
      }, FADE_OUT_DUR);
      clearStart = null;
    }
  }

  // Position message container via JS-only centering
  const mw = messageContainer.offsetWidth;
  const mh = messageContainer.offsetHeight;
  messageContainer.style.left = `${cx - mw / 2}px`;
  messageContainer.style.top  = `${cy - mh / 2}px`;

  // ---- Cursor repulsion ----
  for (const l of letters) {
    if (cursorX !== null) {
      const dxC = l.x - cursorX;
      const dyC = l.y - cursorY;
      const distC = Math.hypot(dxC, dyC);
      if (distC < CURSOR_RADIUS && distC > 0) {
        const push = (1 - distC / CURSOR_RADIUS) * CURSOR_STRENGTH;
        const angC = Math.atan2(dyC, dxC);
        // apply immediate velocity kick
        l.vx += Math.cos(angC) * push;
        l.vy += Math.sin(angC) * push;
      }
    }
  }

  // Update each letter
  for (const l of letters) {
    // Apply velocity damping and update position by velocity
    l.vx *= 0.8;
    l.vy *= 0.8;
    l.x += l.vx;
    l.y += l.vy;

    // Determine destination
    const dx = l.restX - cx, dy = l.restY - cy;
    const dist = Math.hypot(dx, dy);
    let destX, destY;
    if (clearStart !== null) {
      if (dist < clearRadius) {
        const ang = Math.atan2(dy, dx);
        destX = cx + Math.cos(ang) * clearRadius;
        destY = cy + Math.sin(ang) * clearRadius;
      } else {
        destX = l.restX;
        destY = l.restY;
      }
    } else {
      destX = l.restX;
      destY = l.restY;
    }

    // Interpolate position
    const speed = clearStart === null ? 0.02 : 0.1; // slower movement
    l.x = lerp(l.x, destX, speed);
    l.y = lerp(l.y, destY, speed);

    // Smooth ambient drift and rotation
    const phase = ((now + l.driftOffset) % DRIFT_PERIOD) / DRIFT_PERIOD * 2 * Math.PI;
    const driftX = DRIFT_AMP * Math.sin(phase);
    const driftY = DRIFT_AMP * Math.cos(phase);
    const driftRot = ROT_AMP * Math.sin(phase);
    l.rotation += l.rotationSpeed;

    // Render
    l.el.style.transform =
      `translate(${l.x + driftX}px,${l.y + driftY}px) rotate(${l.rotation + driftRot}deg)`;
  }

  // ---- Animate each quote letter with its own drift only ----
  messageContainer.querySelectorAll("img.letter").forEach(img => {
    const phase = ((now + img._driftOffset) % DRIFT_PERIOD) / DRIFT_PERIOD * 2 * Math.PI;
    const dx = QUOTE_DRIFT_AMP * Math.sin(phase);
    const dy = QUOTE_DRIFT_AMP * Math.cos(phase);
    const dr = QUOTE_ROT_AMP  * Math.sin(phase);
    img.style.transform = `translate(${dx}px,${dy}px) rotate(${dr}deg)`;
    // no per-letter opacity adjustments; container handles full fade
  });

  requestAnimationFrame(animate);
}

initSoup();

// Update cursor position on mousemove
window.addEventListener('mousemove', e => {
  cursorX = e.clientX;
  cursorY = e.clientY;
});
// Update on touchmove
window.addEventListener('touchmove', e => {
  const t = e.touches[0];
  cursorX = t.clientX;
  cursorY = t.clientY;
});
// Clear on mouseout / touchend
window.addEventListener('mouseleave', () => { cursorX = cursorY = null; });
window.addEventListener('touchend', () => { cursorX = cursorY = null; });

// ---- Device shake detection ----
let lastShakeTime = 0;
const SHAKE_THRESHOLD = 12;    // higher threshold to prevent noise triggers
const SHAKE_COOLDOWN  = 1000;  // ms between shakes