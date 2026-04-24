
// ══════════════════════════════════════════════════════
// SECTION 1: TUNABLE SETTINGS
// These control how fast/strict the detection is
// ══════════════════════════════════════════════════════

let STAB    = 8;    // How many consecutive frames must show same letter before adding it
                    // Lower = faster detection, Higher = less accidental letters
let CONF    = 0.40; // Minimum confidence score (0.0-1.0) to accept a prediction
                    // Lower = detects more (but more errors), Higher = only confident detections
let COOL    = 700;  // Milliseconds to wait before same letter can be added again
                    // Prevents one sign from adding the same letter many times
let SEND_MS = 100;  // Milliseconds between sending frames to the server
                    // 100ms = 10 predictions per second maximum

// ══════════════════════════════════════════════════════
// SECTION 2: STATE VARIABLES
// These track what's happening at any given moment
// ══════════════════════════════════════════════════════

let running     = false;  // Is the camera currently active and predicting?
let camStream   = null;   // The MediaStream object from the user's camera
let animId      = null;   // requestAnimationFrame ID (lets us cancel the loop)
let lastSentAt  = 0;      // Timestamp of last frame sent to server
let fpsT        = performance.now();  // Timestamp for FPS calculation
let fpsN        = 0;      // Frame counter for FPS calculation

let serverOk    = false;  // Is the Python server running?
let pendingReq  = false;  // Is a request to /predict currently in flight?
                          // KEY: prevents sending new request before previous finishes
                          // Without this: requests pile up → lag → freezing

// Sentence builder state
let currentWord = '';   // Letters being typed right now (not yet committed as a word)
let sentence    = '';   // The full sentence being built (committed words)

// Stability tracking
let stabLetter  = null; // Which letter is currently being held
let stabCount   = 0;    // How many frames we've seen the same letter in a row
let lastAddedAt = 0;    // Timestamp when last letter was committed

let uploadedFile = null;  // The File object from the upload zone

// Session ID — unique identifier for this browser session
// Used so the database can group letter events with their session
let sessionId = 'sess_' + Math.random().toString(36).slice(2) + Date.now();

// ══════════════════════════════════════════════════════
// SECTION 3: UTILITY HELPERS
// ══════════════════════════════════════════════════════

let toastTimer;
function toast(msg, ms = 2000) {
  const t = $('toast');
  t.textContent = msg;          // Set the message
  t.classList.add('show');      // CSS class makes it slide up
  clearTimeout(toastTimer);     // Cancel any existing timer
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);  // Schedule hide
}

// ══════════════════════════════════════════════════════
// SECTION 4: SERVER CHECK
// When the page loads, check if Python server is running
// ══════════════════════════════════════════════════════

async function checkServer() {
 
  try {
    const r = await fetch('/health', { signal: AbortSignal.timeout(2500) });
    const d = await r.json();   // Parse JSON response body

    serverOk = true;
    $('srv-chip').className = 'srv-chip ok';
    $('srv-txt').textContent = `Server OK · ${d.classes} classes`;

    // Load history and stats now that server is confirmed running
    loadHistory();
    loadStats();

  } catch(e) {
    // fetch() throws if network error or timeout
    serverOk = false;
    $('srv-chip').className = 'srv-chip err';
    $('srv-txt').textContent = 'Offline — run: python server.py';
    $('api-alert').classList.add('show');   // Show warning in upload tab
  }
}
checkServer();  // Run immediately when page loads

// ══════════════════════════════════════════════════════
// SECTION 5: TAB SWITCHING
// Shows/hides different pages (webcam, upload, history)
// ══════════════════════════════════════════════════════

function switchMode(m) {
  // Remove 'active' class from all tabs
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  // Add 'active' to the clicked tab
  $('tab-' + m).classList.add('active');

  // Show/hide each page section
  $('main-cam').style.display  = m === 'cam'  ? 'grid' : 'none';
  $('main-up').style.display   = m === 'up'   ? 'grid' : 'none';
  $('main-hist').style.display = m === 'hist' ? 'grid' : 'none';
}


function buildRings() {
 
  const container = $('rings');
  container.innerHTML = '';  // Clear existing rings

  for (let i = 0; i < STAB; i++) {
    const d = document.createElement('div');
    d.className = 'ring';
    d.id = 'rng' + i;
    container.appendChild(d);
  }
}
buildRings();  // Build rings on page load

function updateRings(n) {
  
  for (let i = 0; i < STAB; i++) {
    const r = $('rng' + i);
    if (r) r.classList.toggle('on', i < n);  // 'on' class = filled/lit ring
  }
}


function toggleSettings() {
  const btn  = $('stbtn');
  const body = $('stbody');
  const open = body.classList.toggle('open');  // toggle returns new state
  btn.classList.toggle('open', open);          // Rotate the arrow icon
}

// ══════════════════════════════════════════════════════
// SECTION 8: CAMERA
// Requests camera access, starts video stream
// ══════════════════════════════════════════════════════

async function startCam() {
  if (!serverOk) { toast('⚠ Run: python server.py first', 4000); return; }

  try {
   
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false
    });

    const vid = $('webcam');    // The <video> HTML element
    const can = $('overlay');   // The <canvas> for drawing boxes

    vid.srcObject = camStream;  // Attach camera stream to the video element

  
    vid.addEventListener('playing', () => {
      vid.style.opacity = '1';  // Make video visible (was opacity:0 to prevent flash)

      // Set canvas to EXACT same size as the video source
      // This ensures our overlay boxes align perfectly with the video
      can.width  = vid.videoWidth  || 640;
      can.height = vid.videoHeight || 480;

      // Show/hide UI elements
      $('vid-ph').style.display  = 'none';   // Hide placeholder
      $('vid-bar').style.display = 'flex';   // Show status bar
      $('sb-cursor').style.display = 'inline-block';  // Show blinking cursor

      running = true;
      renderLoop();  // Start the prediction loop

    }, { once: true });

    await vid.play();  // Start playing the video

    // Update Start button to show camera is live
    $('btn-start').className   = 'btn live';
    $('btn-start').textContent = '● Live';
    enableCtrls(true);   // Enable other control buttons
    toast('📷 Camera started!');

  } catch(err) {
    // Handle specific camera errors with helpful messages
    if (err.name === 'NotAllowedError')
      toast('⚠ Camera blocked — click the 🔒 icon and allow camera access', 5000);
    else if (err.name === 'NotFoundError')
      toast('⚠ No camera found — check your webcam is connected', 4000);
    else
      toast('⚠ Camera error: ' + err.message, 4000);
  }
}

function stopCam() {
  running = false;

  // Cancel the animation frame loop
  if (animId) { cancelAnimationFrame(animId); animId = null; }

  // Stop all camera tracks (releases the camera hardware)
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }

  const vid = $('webcam');
  const can = $('overlay');

  vid.srcObject = null;           // Disconnect stream from video element
  vid.style.opacity = '0';        // Hide video
  can.getContext('2d').clearRect(0, 0, can.width, can.height);  // Clear overlay

  $('vid-ph').style.display   = 'flex';   // Show placeholder
  $('vid-bar').style.display  = 'none';   // Hide status bar
  $('sb-cursor').style.display = 'none';  // Hide cursor

  $('btn-start').className   = 'btn start';
  $('btn-start').textContent = '▶ Start Camera';
  enableCtrls(false);    // Disable control buttons
  resetPredUI();         // Reset prediction display
  setHandStatus(false);
  toast('⏹ Stopped');
}

function enableCtrls(on) {
  
  ['btn-stop','btn-sp','btn-bk','btn-cl','btn-cp',
   'sbb-w','sbb-sv','sbb-d','sbb-c','sbb-cp'].forEach(id => {
    const e = $(id);
    if (e) e.disabled = !on;
  });
}



function renderLoop() {
  if (!running) return;  // Stop if camera was turned off


  fpsN++;
  const now = performance.now();
  if (now - fpsT >= 1000) {
    const f = fpsN; fpsN = 0; fpsT = now;
    $('fps-tag').textContent = f + ' FPS';
    $('fps-bar').textContent = f + ' FPS';
  }

  
  if (now - lastSentAt >= SEND_MS && !pendingReq) {
    lastSentAt = now;
    sendFrame();
  }

 
  animId = requestAnimationFrame(renderLoop);
}



async function sendFrame() {
  const vid = $('webcam');

  // Safety checks before capturing
  if (!vid || vid.readyState < 2 || vid.paused || vid.ended) return;
  // readyState < 2 means video data not loaded yet
  // HTMLMediaElement.HAVE_CURRENT_DATA = 2

  pendingReq = true;  // Lock: prevent new requests until this one finishes

  try {
 
    const cap = document.createElement('canvas');
    cap.width  = vid.videoWidth  || 640;
    cap.height = vid.videoHeight || 480;
    cap.getContext('2d').drawImage(vid, 0, 0, cap.width, cap.height);

   
    const b64 = cap.toDataURL('image/jpeg', 0.6).split(',')[1];

    const resp = await fetch('/predict', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ frame: b64, session_id: sessionId }),
      signal:  AbortSignal.timeout(2500)
    });

    if (!resp.ok) return;  // Server returned error status

    const data = await resp.json();  // Parse response JSON

    // Draw the hand box and skeleton on the overlay canvas
    drawOverlay(data, cap.width, cap.height);

    // Update UI and sentence builder based on prediction
    handlePrediction(data);

  } catch(e) {
    // Silently ignore errors (network timeout, server busy)
    // The loop will try again on the next cycle
  } finally {
    // 'finally' always runs even if there's an error
    pendingReq = false;  // Unlock: allow next request
  }
}

// ══════════════════════════════════════════════════════
// SECTION 11: DRAW OVERLAY
// Draws the hand skeleton and bounding box on the canvas
// ══════════════════════════════════════════════════════

function drawOverlay(data, vw, vh) {
  
  const can = $('overlay');
  const ctx = can.getContext('2d');  // 2D drawing context
  ctx.clearRect(0, 0, can.width, can.height);  // Erase previous frame's drawings

  if (!data.detected) return;  // No hand → nothing to draw

  const conf = data.confidence || 0;

 
  const sx = can.width  / (vw || can.width);
  const sy = can.height / (vh || can.height);

  // ── Draw hand skeleton ──
  if (data.landmarks && data.landmarks.length === 21) {
    const lm = data.landmarks;

    
    const px = i => lm[i][0] * can.width;
    const py = i => lm[i][1] * can.height;

  
    const CONN = [
      [0,1],[1,2],[2,3],[3,4],        // Thumb
      [0,5],[5,6],[6,7],[7,8],        // Index finger
      [0,9],[9,10],[10,11],[11,12],   // Middle finger
      [0,13],[13,14],[14,15],[15,16], // Ring finger
      [0,17],[17,18],[18,19],[19,20], // Pinky
      [5,9],[9,13],[13,17]            // Palm connections
    ];

   
    ctx.strokeStyle = 'rgba(37,99,235,0.5)';  // Blue semi-transparent
    ctx.lineWidth   = 1.5;
    CONN.forEach(([a, b]) => {
      ctx.beginPath();
      ctx.moveTo(px(a), py(a));
      ctx.lineTo(px(b), py(b));
      ctx.stroke();
    });

    // Draw dots at each landmark position
    lm.forEach((pt, i) => {
      ctx.beginPath();
      ctx.arc(pt[0] * can.width, pt[1] * can.height, i === 0 ? 5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? '#1d4ed8' : 'rgba(59,130,246,0.8)';  // Wrist = darker
      ctx.fill();
    });
  }

  // ── Draw bounding box ──
  if (data.hand_box) {
    const b = data.hand_box;

    // Scale from server pixel coords to canvas coords
    const x1 = b.x1 * sx, y1 = b.y1 * sy;
    const x2 = b.x2 * sx, y2 = b.y2 * sy;
    const w  = x2 - x1, h = y2 - y1;

    // Opacity increases with confidence (more confident = more visible box)
    const alpha = 0.4 + conf * 0.55;

    // Draw rectangle around hand
    ctx.strokeStyle = `rgba(37,99,235,${alpha})`;
    ctx.lineWidth   = 2;
    ctx.strokeRect(x1, y1, w, h);

    // Draw corner accent marks (the L-shaped corners)
    const cs = 14;  // Corner size in pixels
    ctx.lineWidth   = 2.5;
    ctx.strokeStyle = `rgba(37,99,235,${Math.min(1, alpha + 0.3)})`;
    // Each corner: [corner_x, corner_y, x_direction, y_direction]
    [[x1,y1,1,1],[x2,y1,-1,1],[x1,y2,1,-1],[x2,y2,-1,-1]].forEach(([cx, cy, dx, dy]) => {
      ctx.beginPath();
      ctx.moveTo(cx + dx * cs, cy);  // Start: out along x
      ctx.lineTo(cx, cy);            // Corner
      ctx.lineTo(cx, cy + dy * cs);  // End: out along y
      ctx.stroke();
    });

    // Draw label badge above the box
    if (data.letter && data.letter !== 'nothing') {
      const lbl = `${data.letter}   ${(conf * 100).toFixed(0)}%`;
      ctx.font = 'bold 13px DM Mono,monospace';
      const tw  = ctx.measureText(lbl).width + 16;  // Badge width = text + padding
      const bx  = x1;
      const by  = Math.max(y1 - 26, 2);  // Badge above the box, minimum y=2

      // Badge background
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.roundRect(bx, by, tw, 20, 4);  // Rounded rectangle
      ctx.fill();

      // Badge text
      ctx.fillStyle = `rgba(37,99,235,${Math.min(1, alpha + 0.2)})`;
      ctx.fillText(lbl, bx + 8, by + 14);
    }
  }
}

// ══════════════════════════════════════════════════════
// SECTION 12: HANDLE PREDICTION
// Updates UI and sentence builder based on server response
// ══════════════════════════════════════════════════════

function handlePrediction(data) {

  const hasSign = data.detected
               && data.letter
               && data.letter !== 'nothing'
               && data.letter !== null;

  setHandStatus(hasSign);  // Update the "hand detected" status indicator

  if (!hasSign) {
  
    if (stabCount > 0) { stabCount = Math.max(0, stabCount - 2); updateStabUI(); }
    resetPredUI();
    return;
  }

  const letter = data.letter;
  const conf   = data.confidence || 0;

  // Update the large prediction display and top-5 list
  updatePredUI(letter, conf, data.top5 || []);

  // Update the sentence builder's letter display
  updateSBLetter(letter, conf);

  // If confidence is below our threshold, don't count toward stability
  if (conf < CONF) { stabCount = 0; updateStabUI(); return; }

 
  if (letter === stabLetter) stabCount = Math.min(stabCount + 1, STAB);
  else { stabLetter = letter; stabCount = 1; }

  updateStabUI();    // Update stability progress bar
  updateRings(stabCount);  // Update ring dots

 
  if (stabCount >= STAB && Date.now() - lastAddedAt >= COOL) {
    commitLetter(letter);
    lastAddedAt = Date.now();  // Record when this letter was added
    stabCount   = 0;           // Reset for next letter
    updateStabUI();
  }
}

// ══════════════════════════════════════════════════════
// SECTION 13: LETTER / WORD / SENTENCE BUILDER
// The core translation logic
// ══════════════════════════════════════════════════════

function commitLetter(letter) {

  if (letter === 'space')   { commitWord(); return; }
  if (letter === 'del')     { doBack();     return; }
  if (letter === 'nothing') return;

  currentWord += letter;           // Add to current word
  $('sb-word').textContent = currentWord;  // Update display
  flashLetters();                  // Brief animation

  fetchSuggestions(currentWord);   // Get word suggestions for new prefix
  toast(`+ ${letter}`, 350);       // Quick toast notification
}

function commitWord() {
 
  if (!currentWord) return;  // Nothing to commit

  // Add space separator if needed (not if sentence already ends with space)
  if (sentence && !sentence.endsWith(' ')) sentence += ' ';
  sentence += currentWord;

  currentWord = '';
  $('sb-word').textContent = '';    // Clear word display
  $('sb-sent').textContent = sentence;  // Update sentence display
  clearSuggestions();               // Clear suggestion pills
  toast('✓ Word added', 600);
}

function insertSuggestion(word) {
  
  if (sentence && !sentence.endsWith(' ')) sentence += ' ';
  sentence    += word;
  currentWord  = '';
  $('sb-word').textContent = '';
  $('sb-sent').textContent = sentence;
  clearSuggestions();
  toast(`✓ "${word}" inserted`, 700);
}

function manualSpace() {
 
  commitWord();
  if (!sentence.endsWith(' ')) sentence += ' ';
  $('sb-sent').textContent = sentence;
}

function doBack() {
 
  if (currentWord.length > 0) {
    currentWord = currentWord.slice(0, -1);  // Remove last char
    $('sb-word').textContent = currentWord;
    fetchSuggestions(currentWord);  // Update suggestions
  } else {
    // Remove last word from sentence
    sentence = sentence.trimEnd();       // Remove trailing space
    const i  = sentence.lastIndexOf(' ');
    sentence = i >= 0 ? sentence.slice(0, i + 1) : '';  // Remove last word
    $('sb-sent').textContent = sentence;
  }
}

function clearAll() {
  currentWord  = '';
  sentence     = '';
  stabCount    = 0;
  stabLetter   = null;
  $('sb-word').textContent = '';
  $('sb-sent').textContent = '';
  updateStabUI();
  updateRings(0);
  clearSuggestions();
  toast('🗑 Cleared');
}

function copyText() {
  const full = (sentence + currentWord).trim();
  if (!full) { toast('Nothing to copy yet', 1500); return; }
  // navigator.clipboard.writeText = modern clipboard API
  // .then() runs when copy succeeds
  navigator.clipboard.writeText(full).then(() => toast('📋 Copied!'));
}

// ══════════════════════════════════════════════════════
// SECTION 14: SAVE TO DATABASE
// ══════════════════════════════════════════════════════

async function saveSession() {
  const full = (sentence + currentWord).trim();
  if (!full) { toast('Nothing to save yet', 1500); return; }
  if (!serverOk) { toast('⚠ Server offline', 2000); return; }

  try {
   
    const resp = await fetch('/save_session', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        sentence:   full,
        source:     'webcam',
        session_id: sessionId
      })
    });
    const d = await resp.json();

    if (d.saved) {
      toast('✅ Saved to history!', 2000);
      sessionId = 'sess_' + Math.random().toString(36).slice(2) + Date.now();  // New session ID
      loadHistory();  // Refresh history tab
      loadStats();    // Refresh stats
    }
  } catch(e) {
    toast('❌ Could not save — is server running?', 2500);
  }
}

// ══════════════════════════════════════════════════════
// SECTION 15: WORD SUGGESTIONS
// Fetches suggestions from server as user types
// ══════════════════════════════════════════════════════

let suggestDebounce = null;  // Timer for debouncing

async function fetchSuggestions(prefix) {
  /**
   * DEBOUNCING: wait 150ms after the last change before sending request
   * Without debounce: "HEL" triggers requests for H, HE, HEL separately
   * With debounce: only sends request for "HEL" after you stop typing
   */
  clearTimeout(suggestDebounce);

  if (!prefix || prefix.length < 1) { clearSuggestions(); return; }

  suggestDebounce = setTimeout(async () => {
    try {
      /**
       * GET request to /suggest?prefix=HEL
       * encodeURIComponent handles special characters in the prefix
       */
      const resp = await fetch(`/suggest?prefix=${encodeURIComponent(prefix)}`,
        { signal: AbortSignal.timeout(1500) });
      const d = await resp.json();
      renderSuggestions(d.suggestions || []);
    } catch(e) {
      clearSuggestions();
    }
  }, 150);  // 150ms debounce delay
}

function renderSuggestions(words) {
  const strip = $('suggest-pills');
  if (!words.length) {
    strip.innerHTML = '<span class="sug-pill empty">No suggestions yet</span>';
    return;
  }
  /**
   * Create a button pill for each suggestion
   * onclick="insertSuggestion('${w}')" calls the function with the word
   * We escape HTML entities to prevent XSS attacks
   */
  strip.innerHTML = words.map(w =>
    `<button class="sug-pill" onclick="insertSuggestion('${w.replace(/'/g, "\\'")}')">${w}</button>`
  ).join('');
}

function clearSuggestions() {
  $('suggest-pills').innerHTML = '<span class="sug-pill empty">Sign letters to see suggestions</span>';
}

// ══════════════════════════════════════════════════════
// SECTION 16: UI UPDATE FUNCTIONS
// ══════════════════════════════════════════════════════

function updatePredUI(letter, conf, top5) {
  $('pred-ltr').textContent  = letter || '—';
  $('pred-desc').textContent = aslDesc(letter);
  $('pc-fill').style.width   = (conf * 100) + '%';
  $('pc-pct').textContent    = (conf * 100).toFixed(0) + '%';

  if (top5 && top5.length) {
    $('topn-list').innerHTML = top5.map(t => `
      <div class="trow">
        <div class="tltr">${t.letter}</div>
        <div class="tbar"><div class="tfill" style="width:${(t.confidence*100).toFixed(0)}%"></div></div>
        <div class="tpct">${(t.confidence*100).toFixed(0)}%</div>
      </div>`).join('');
  }
}

function resetPredUI() {
  $('pred-ltr').textContent  = '—';
  $('pred-desc').textContent = 'No sign detected';
  $('pc-fill').style.width   = '0%';
  $('pc-pct').textContent    = '0%';
}

function updateSBLetter(letter, conf) {
  $('sb-big').textContent   = letter;
  $('sb-name').textContent  = aslDesc(letter);
  $('sb-cfill').style.width = (conf * 100) + '%';
  $('sb-cpct').textContent  = (conf * 100).toFixed(0) + '%';
}

function updateStabUI() {
  const pct = STAB > 0 ? (stabCount / STAB * 100) : 0;
  $('stab-fill').style.width = pct + '%';
  $('stab-n').textContent    = `${stabCount} / ${STAB}`;
}

function flashLetters() {
  [$('pred-ltr'), $('sb-big')].forEach(el => {
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 230);
  });
}

function setHandStatus(on) {
  $('hdot').className  = 'hdot ' + (on ? 'on' : 'off');
  $('htext').textContent = on ? 'Hand detected ✓' : 'No hand in frame';
}

// ══════════════════════════════════════════════════════
// SECTION 17: KEYBOARD SHORTCUTS
// ══════════════════════════════════════════════════════

document.addEventListener('keydown', e => {
  if (!running) return;  // Only work while camera is active
  if (e.key === ' ')                    { e.preventDefault(); commitWord(); }
  else if (e.key === 'Backspace')       { e.preventDefault(); doBack(); }
  else if (e.key.toLowerCase() === 'c' && !e.ctrlKey && !e.metaKey) clearAll();
});

// ══════════════════════════════════════════════════════
// SECTION 18: DRAG AND DROP (UPLOAD)
// ══════════════════════════════════════════════════════

function onDragEnter(e) { e.preventDefault(); $('drop-zone').classList.add('drag'); }
function onDragOver(e)  { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
function onDragLeave(e) {
  e.preventDefault();
  // Only remove 'drag' class if mouse truly left the drop zone
  // (not just moved over a child element inside it)
  if (!$('drop-zone').contains(e.relatedTarget)) $('drop-zone').classList.remove('drag');
}
function onDrop(e) {
  e.preventDefault(); $('drop-zone').classList.remove('drag');
  const file = e.dataTransfer.files[0];
  if (!file) { toast('⚠ No file detected'); return; }
  if (!file.type.match(/image.*/) && !file.type.match(/video.*/)) {
    toast('⚠ Images and videos only', 3000); return;
  }
  loadFile(file);
}

// ══════════════════════════════════════════════════════
// SECTION 19: FILE UPLOAD — FULLY FIXED
//
// THE BUG EXPLANATION:
// ════════════════════
// Old broken code in frontend:
//   fetch('/predict_image', {
//     method:  'POST',
//     headers: { 'Content-Type': 'application/json' },  ← THIS LINE BREAKS EVERYTHING
//     body:    formData
//   })
//
// WHY IT BROKE:
// When uploading files, the browser uses "multipart/form-data" encoding.
// The browser AUTOMATICALLY sets the Content-Type header to:
//   "multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxkTrZu0gW"
//
// The "boundary" is a unique string the browser generates.
// It separates different parts of the form in the request body.
// Flask's request.files uses the boundary to find where the file is.
//
// When we manually set Content-Type to 'application/json':
//   1. We OVERWRITE the browser's boundary string
//   2. Flask can't find the boundary → can't parse the form data
//   3. request.files is empty → "No file received" error
//
// THE FIX:
// Remove the 'headers' object entirely when sending FormData.
// The browser will automatically set the correct Content-Type + boundary.
// ══════════════════════════════════════════════════════

function loadFile(file) {
  if (!file) return;
  uploadedFile = file;

  const url   = URL.createObjectURL(file);  // Temporary local URL for preview
  const isVid = file.type.startsWith('video/');

  $('prev-wrap').style.display  = 'block';
  $('drop-zone').style.display  = 'none';
  $('prev-img').style.display   = isVid ? 'none'  : 'block';
  $('prev-vid').style.display   = isVid ? 'block' : 'none';
  $('annot-canvas').style.display = 'none';

  if (isVid) $('prev-vid').src = url;
  else       $('prev-img').src = url;

  $('analyze-btn').disabled = false;
  $('fr-results').style.display = 'none';
  $('up-txt').textContent = '';
  $('prog-wrap').style.display = 'none';
  setUpPred('—', '', 0, []);
  toast(`📁 ${file.name}`, 2000);
}

function removeFile() {
  uploadedFile = null;
  $('prev-wrap').style.display  = 'none';
  $('drop-zone').style.display  = 'block';
  $('analyze-btn').disabled     = true;
  $('file-inp').value           = '';
  $('prog-wrap').style.display  = 'none';
  $('fr-results').style.display = 'none';
  setUpPred('—', 'Upload a file to begin', 0, []);
}

async function analyzeFile() {
  if (!uploadedFile)  { toast('⚠ No file loaded'); return; }
  if (!serverOk)      { toast('⚠ Server offline — run: python server.py', 4000); return; }

  const btn   = $('analyze-btn');
  const fill  = $('prog-fill');
  const lbl   = $('prog-lbl');
  const isVid = uploadedFile.type.startsWith('video/');

  btn.disabled    = true;
  btn.textContent = '⏳ Analyzing...';
  $('prog-wrap').style.display = 'block';
  fill.style.width   = '10%';
  fill.style.background = '';  // Reset color (in case previous run showed red error)
  lbl.textContent = 'Uploading...';

  try {
    /**
     * FormData = the correct way to upload files
     * fd.append('file', uploadedFile) adds the file with key 'file'
     * This matches request.files['file'] on the server
     *
     * CRITICAL: No 'headers' option in fetch() when sending FormData!
     * Browser auto-sets: Content-Type: multipart/form-data; boundary=...
     */
    const fd = new FormData();
    fd.append('file', uploadedFile);  // Key must match request.files["file"] on server

    fill.style.width  = '40%';
    lbl.textContent   = isVid ? 'Processing video frames...' : 'Detecting hand landmarks...';

    // Choose endpoint based on file type
    const endpoint = isVid ? '/predict_video' : '/predict_image';

    // NO headers option — let browser set Content-Type automatically
    const resp = await fetch(endpoint, { method: 'POST', body: fd });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: 'HTTP ' + resp.status }));
      throw new Error(err.error || 'Server returned error ' + resp.status);
    }

    const data = await resp.json();
    fill.style.width = '100%';
    lbl.textContent  = '✓ Done!';

    if (isVid) showVideoResult(data);
    else       showImageResult(data);

    toast('✓ Analysis complete!');

  } catch(e) {
    lbl.textContent       = '❌ ' + e.message;
    fill.style.background = '#dc2626';  // Red error color
    toast('❌ Error: ' + e.message, 4000);
    console.error('[analyzeFile]', e);
  }

  btn.disabled    = false;
  btn.textContent = '🔍 Analyze Again';
}

function showImageResult(data) {
  if (!data.detected || !data.letter || data.letter === 'nothing') {
    setUpPred('?', 'No hand detected — ensure hand is clearly visible in the image', 0, []);
    $('up-txt').textContent = 'No hand found in image.';
    toast('No hand detected in image', 3000);
    return;
  }

  setUpPred(data.letter, aslDesc(data.letter), data.confidence, data.top5 || []);
  $('up-txt').textContent = data.letter;

  /**
   * Draw annotated result on canvas
   * We draw the original image first, then add the bounding box on top
   */
  const img = $('prev-img');
  const can = $('annot-canvas');
  can.width  = img.naturalWidth  || 640;
  can.height = img.naturalHeight || 480;
  const ctx  = can.getContext('2d');

  ctx.drawImage(img, 0, 0);  // Draw the original photo

  if (data.hand_box) {
    const b = data.hand_box;
    // For uploaded images: server coords are in processed image space
    // We need to scale to the DISPLAYED canvas size
    const scaleX = can.width  / Math.max(img.naturalWidth,  640);
    const scaleY = can.height / Math.max(img.naturalHeight, 480);
    const x1 = b.x1 / scaleX, y1 = b.y1 / scaleY;
    const x2 = b.x2 / scaleX, y2 = b.y2 / scaleY;

    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth   = 3;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

    ctx.font      = `bold ${Math.round(can.width * 0.04)}px DM Mono,monospace`;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(x1, Math.max(y1 - 26, 0), 150, 22);
    ctx.fillStyle = '#1d4ed8';
    ctx.fillText(`${data.letter}  ${(data.confidence * 100).toFixed(0)}%`, x1 + 6, Math.max(y1 - 8, 14));
  }

  can.style.display = 'block';
  img.style.display = 'none';  // Hide original, show annotated canvas
}

function showVideoResult(data) {
  if (!data.frames || !data.frames.length) {
    $('up-txt').textContent = 'No signs detected in video.';
    toast('No signs detected', 2500);
    return;
  }

  $('fr-results').style.display = 'block';
  $('fr-grid').innerHTML = data.frames.map(f =>
    `<div class="fr-pill">
      <span class="fr-ltr">${f.letter}</span>
      <span class="fr-conf">${(f.confidence * 100).toFixed(0)}%</span>
    </div>`
  ).join('');

  $('up-txt').textContent = data.sentence || '';

  if (data.frames[0]) {
    setUpPred(data.frames[0].letter, '', data.frames[0].confidence, data.frames[0].top5 || []);
  }
}

function setUpPred(letter, desc, conf, top5) {
  $('up-big').textContent   = letter;
  $('up-desc').textContent  = desc;
  $('up-cfill').style.width = (conf * 100) + '%';
  $('up-cpct').textContent  = (conf * 100).toFixed(0) + '%';

  if (top5 && top5.length) {
    $('up-topn').innerHTML = top5.map(t => `
      <div class="trow">
        <div class="tltr">${t.letter}</div>
        <div class="tbar"><div class="tfill" style="width:${(t.confidence*100).toFixed(0)}%"></div></div>
        <div class="tpct">${(t.confidence*100).toFixed(0)}%</div>
      </div>`).join('');
  }
}

function copyUpTxt() {
  const t = $('up-txt').textContent.trim();
  if (!t) { toast('Nothing to copy', 1500); return; }
  navigator.clipboard.writeText(t).then(() => toast('📋 Copied!'));
}

// ══════════════════════════════════════════════════════
// SECTION 20: HISTORY AND STATS
// ══════════════════════════════════════════════════════

async function loadHistory() {
  try {
    const r = await fetch('/history');
    const d = await r.json();
    const el = $('hist-list');

    if (!d.history || !d.history.length) {
      el.innerHTML = `<div style="text-align:center;padding:24px;color:var(--tx3);font-size:.78rem;line-height:1.8;">
        No saved translations yet.<br>
        Start webcam, sign something, then click 💾 Save to keep it!
      </div>`;
      return;
    }

    el.innerHTML = d.history.map(h => `
      <div class="hist-entry" id="he-${h.id}">
        <div class="hist-sentence">${escHtml(h.sentence)}</div>
        <div class="hist-meta">
          <span>📅 ${formatDate(h.created_at)}</span>
          <span class="hist-src">${h.source || 'webcam'}</span>
          <span>${h.word_count} word${h.word_count !== 1 ? 's' : ''}</span>
        </div>
        <button class="hist-del" onclick="deleteSession(${h.id})" title="Delete this entry">✕</button>
      </div>`).join('');

  } catch(e) {
    $('hist-list').innerHTML = '<div style="padding:20px;color:var(--tx3);font-size:.78rem;">Could not load history. Is the server running?</div>';
  }
}

async function deleteSession(id) {
  try {
    await fetch('/history/' + id, { method: 'DELETE' });
    const el = $('he-' + id);
    if (el) {
      el.style.opacity   = '0';
      el.style.transform = 'translateX(20px)';
      el.style.transition = 'all .2s';
      setTimeout(() => el.remove(), 200);
    }
    toast('Deleted', 1200);
    loadStats();
  } catch(e) {
    toast('Could not delete', 2000);
  }
}

async function loadStats() {
  try {
    const r = await fetch('/stats');
    const d = await r.json();

    $('stat-sessions').textContent = d.total_sessions || 0;
    $('stat-letters').textContent  = d.total_letters  || 0;
    $('stat-words').textContent    = d.total_words    || 0;

    if (d.top_letters && d.top_letters.length) {
      $('top-letters').innerHTML = d.top_letters.map(l =>
        `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:var(--pill);background:var(--bg3);border:1px solid var(--brd);font-family:var(--mono);font-size:.7rem;">
          <strong style="color:var(--blue)">${l.letter}</strong>
          <span style="color:var(--tx3)">${l.count}×</span>
        </span>`
      ).join('');
    }

    if (d.top_words && d.top_words.length) {
      $('top-words').innerHTML = d.top_words.map(w =>
        `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:var(--pill);background:var(--bg3);border:1px solid var(--brd);font-family:var(--mono);font-size:.7rem;">
          <strong style="color:var(--green)">${w.word}</strong>
          <span style="color:var(--tx3)">${w.freq}×</span>
        </span>`
      ).join('');
    }
  } catch(e) {}
}

// ══════════════════════════════════════════════════════
// SECTION 21: UTILITY FUNCTIONS
// ══════════════════════════════════════════════════════

function formatDate(iso) {
  try {
    // Format: "16 Apr, 10:30 AM"
    return new Date(iso).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    });
  } catch(e) { return iso; }
}

function escHtml(text) {
  /**
   * Prevents XSS attacks by converting HTML special characters to entities
   * If sentence contains '<script>', it becomes '&lt;script&gt;' (safe text)
   */
  const div = document.createElement('div');
  div.textContent = text;  // Browser escapes the text automatically
  return div.innerHTML;    // Get the escaped HTML version
}

function aslDesc(l) {
  const m = {
    A:'Closed fist · thumb side',  B:'Flat hand · fingers together',
    C:'Curved C shape',            D:'Index up · others curve to thumb',
    E:'Fingers curled · thumb under', F:'OK-sign variation',
    G:'Point sideways',            H:'Two fingers pointing side',
    I:'Pinky up',                  J:'Pinky + hook motion',
    K:'Index and middle up',       L:'L-shape (index + thumb)',
    M:'Three fingers over thumb',  N:'Two fingers over thumb',
    O:'Round O shape',             P:'K pointing down',
    Q:'G pointing down',           R:'Crossed index + middle',
    S:'Fist · thumb over fingers', T:'Thumb between index + middle',
    U:'Two fingers up together',   V:'Peace sign (V shape)',
    W:'Three fingers up',          X:'Hooked index finger',
    Y:'Pinky + thumb out',         Z:'Index traces Z',
    space:'Space character',       del:'Delete last letter',
    nothing:'Sign unclear'
  };
  return m[l] || '';
}
