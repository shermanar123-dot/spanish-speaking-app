// ====================================================================
// Habla Diario — app.js
// ====================================================================

// --- Auth State ---
let currentUser = null;
let assessmentHistory = [];
let rpHistory = [];
let rpScenario = "";
let userProfile = null;
let lastDrills = [];
let isAutoPlaying = false;
let isRapidFire = false;
let isMissionActive = false;
let stopSessionRequested = false;

// --- Utilities ---
function escapeHTML(str) {
  if (!str) return '';
  return String(str).replace(/[&<>'"]/g, tag => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[tag]));
}

function loading() {
  return `<div class="loading"><div class="dot"></div><div class="dot"></div><div class="dot"></div><span>Generating...</span></div>`;
}

function msgHTML(type, text, label) {
  const safeText = escapeHTML(text);
  const safeLabel = escapeHTML(label);
  const speakerBtn = type === 'waiter' ? ` <span class="speaker-btn" onclick="event.stopPropagation();speakText('${safeText.replace(/'/g, "\\'")}')">🔊</span>` : '';
  return `<div class="msg ${type}"><div class="msg-label">${safeLabel}</div>${safeText}${speakerBtn}</div>`;
}

// --- API Helper ---
async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// --- Tabs ---
function showTab(id, el) {
  // Stop all TTS and sessions immediately when switching tabs
  window.speechSynthesis.cancel();
  stopSessionRequested = true;
  isAutoPlaying = false;
  isRapidFire = false;
  const stopBtn = document.getElementById('stop-btn');
  if (stopBtn) stopBtn.style.display = 'none';

  // Close user menu on tab switch
  const menu = document.getElementById('user-menu');
  if (menu) menu.style.display = 'none';

  document.querySelectorAll('.panel').forEach(p => p.classList.remove('on'));
  document.querySelectorAll('.tb').forEach(t => t.classList.remove('on'));
  const target = document.getElementById('tab-' + id);
  if (target) target.classList.add('on');
  if (el) el.classList.add('on');
  if (id === 'home') loadStatus();
  if (id === 'profile') loadProfile();
}

// --- Auth UI ---
function showLogin() {
  document.getElementById('signup-form').style.display = 'none';
  document.getElementById('login-form').style.display = 'block';
  document.getElementById('login-error').textContent = '';
  document.getElementById('signup-error').textContent = '';
}

function showSignup() {
  document.getElementById('login-form').style.display = 'none';
  document.getElementById('signup-form').style.display = 'block';
  document.getElementById('login-error').textContent = '';
  document.getElementById('signup-error').textContent = '';
}

async function signup() {
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const errEl = document.getElementById('signup-error');
  errEl.textContent = '';

  if (!email) { errEl.textContent = 'Email is required.'; return; }
  if (password.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; return; }

  try {
    document.querySelector('#signup-form .auth-btn').disabled = true;
    const data = await api('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    if (data.success) {
      currentUser = data.user;
      document.getElementById('auth-overlay').style.display = 'none';
      document.getElementById('user-menu').style.display = 'block';
      document.getElementById('header-user-btn').style.display = 'flex';
      updateUserHeader();
      localStorage.removeItem('habla_onboarding_done');
      loadStatus();
      setTimeout(showOnboarding, 800);
      showConfetti();
    }
  } catch (e) {
    errEl.textContent = e.message;
  }
  document.querySelector('#signup-form .auth-btn').disabled = false;
}

async function login() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';

  if (!email || !password) { errEl.textContent = 'Email and password required.'; return; }

  try {
    document.querySelector('#login-form .auth-btn').disabled = true;
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    if (data.success) {
      currentUser = data.user;
      document.getElementById('auth-overlay').style.display = 'none';
      document.getElementById('user-menu').style.display = 'block';
      document.getElementById('header-user-btn').style.display = 'flex';
      updateUserHeader();
      loadStatus();
    }
  } catch (e) {
    errEl.textContent = e.message;
  }
  document.querySelector('#login-form .auth-btn').disabled = false;
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch(e) {}
  currentUser = null;
  userProfile = null;
  document.getElementById('auth-overlay').style.display = 'flex';
  document.getElementById('user-menu').style.display = 'none';
  document.getElementById('header-user-btn').style.display = 'none';
  document.getElementById('login-email').value = '';
  document.getElementById('login-password').value = '';
}

function toggleUserMenu() {
  const menu = document.getElementById('user-menu');
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

// Close user menu when clicking outside it
document.addEventListener('click', function(e) {
  const menu = document.getElementById('user-menu');
  const btn = document.getElementById('header-user-btn');
  if (menu && menu.style.display === 'block' && 
      !menu.contains(e.target) && !btn.contains(e.target)) {
    menu.style.display = 'none';
  }
});

function updateUserHeader() {
  if (currentUser) {
    document.getElementById('header-user-icon').textContent = currentUser.email ? '👤' : '👤';
    document.getElementById('user-name').textContent = currentUser.username || currentUser.email.split('@')[0];
    document.getElementById('user-email').textContent = currentUser.email;
  }
}

// Check auth on load
async function checkAuth() {
  try {
    const data = await api('/api/auth/me');
    if (data.authenticated) {
      currentUser = data.user;
      document.getElementById('auth-overlay').style.display = 'none';
      document.getElementById('user-menu').style.display = 'block';
      document.getElementById('header-user-btn').style.display = 'flex';
      updateUserHeader();
      loadStatus();
      
      // Show onboarding for new users (no level set = first time)
      if (!localStorage.getItem('habla_onboarding_done')) {
        setTimeout(showOnboarding, 800);
      }
      return;
    }
  } catch(e) {}
  // Show auth overlay
  document.getElementById('auth-overlay').style.display = 'flex';
  document.getElementById('user-menu').style.display = 'none';
  document.getElementById('header-user-btn').style.display = 'none';
}

// --- Load Profile Tab ---
async function loadProfile() {
  if (!currentUser) return;
  document.getElementById('prof-email').textContent = currentUser.email;
  document.getElementById('prof-joined').textContent = 'Recently';
  
  try {
    const data = await api('/api/user/status');
    if (data.profile && data.profile.level) {
      document.getElementById('prof-level').textContent = data.profile.level;
    }
  } catch(e) {}
  
  document.getElementById('prof-tier').textContent = currentUser.isPaid ? 'Premium' : 'Free';
}

// --- Status & Home ---
async function loadStatus() {
  if (!currentUser) return;
  try {
    const data = await api('/api/user/status');
    userProfile = data.profile;
    
    const streak = data.progress.streak || 0;
    const mins = data.progress.total_minutes || 0;
    const drills = data.progress.drills_done || 0;
    
    document.getElementById('stat-streak').innerText = streak;
    document.getElementById('stat-drills').innerText = drills;
    
    // Animate progress ring
    const goal = 15;
    const pct = Math.min(mins / goal, 1);
    const circumference = 2 * Math.PI * 50; // r=50
    const offset = circumference * (1 - pct);
    const ringEl = document.getElementById('progress-ring-fill');
    if (ringEl) {
      ringEl.style.strokeDasharray = circumference;
      ringEl.style.strokeDashoffset = circumference;
      // Trigger animation on next frame
      requestAnimationFrame(() => {
        ringEl.style.strokeDashoffset = offset;
      });
      // Color based on progress
      if (pct >= 1) ringEl.style.stroke = '#48C9B0';
      else if (pct >= 0.5) ringEl.style.stroke = '#FFD93D';
      else ringEl.style.stroke = '#6C63FF';
    }
    document.getElementById('ring-mins').innerText = mins;
    
    // Level badge
    const levelBadge = document.getElementById('header-level-badge-sm');
    const levelBadgeMenu = document.getElementById('header-level-badge');
    
    if (userProfile && userProfile.level) {
      document.getElementById('stat-level').innerText = userProfile.level;
      levelBadge.textContent = userProfile.level;
      levelBadge.style.display = 'inline-flex';
      levelBadgeMenu.textContent = userProfile.level;
      
      document.getElementById('home-assessment-intro').style.display = 'none';
      document.getElementById('home-profile').style.display = 'block';
      
      document.getElementById('home-prof-level').innerText = userProfile.level;
      document.getElementById('home-prof-str').innerText = userProfile.strengths;
      document.getElementById('home-prof-weak').innerText = userProfile.weaknesses;
      const date = new Date(userProfile.last_assessed);
      document.getElementById('home-prof-date').innerText = date.toLocaleDateString();
    } else {
      document.getElementById('stat-level').innerText = '?';
      levelBadge.style.display = 'none';
      document.getElementById('home-assessment-intro').style.display = 'block';
      document.getElementById('home-profile').style.display = 'none';
    }
  } catch (e) {
    console.error(e);
  }
}

async function reviewMistakes() {
  const area = document.getElementById('mistakes-review-area');
  const list = document.getElementById('mistakes-list');
  area.style.display = 'block';
  list.innerHTML = loading();
  area.scrollIntoView({ behavior: 'smooth' });

  try {
    const data = await api('/api/user/mistakes');
    
    if (!data.length) {
      list.innerHTML = `<div style="padding:20px; text-align:center; color:var(--text-muted);">No mistakes found yet. Keep practicing!</div>`;
      return;
    }

    list.innerHTML = data.map(m => `
      <div class="drill-item" style="cursor:default; border-left:4px solid var(--incorrect); margin-bottom:12px;">
        <div style="font-size:12px; text-transform:uppercase; color:var(--text-light); font-weight:800; margin-bottom:4px;">You said:</div>
        <div style="color:var(--text-main); font-weight:600; margin-bottom:8px;">"${m.original_text}"</div>
        <div style="font-size:12px; text-transform:uppercase; color:var(--text-light); font-weight:800; margin-bottom:4px;">Coach Correction:</div>
        <div style="color:var(--secondary); font-weight:700;">${m.correction}</div>
      </div>
    `).join('');
  } catch (e) {
    list.innerHTML = `<div style="color:red">Failed to load mistakes.</div>`;
  }
}

// --- Confetti ---
function showConfetti() {
  const colors = ['#6C63FF', '#FF6B6B', '#FFD93D', '#48C9B0', '#C084FC'];
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9999;overflow:hidden;';
  document.body.appendChild(container);
  
  for (let i = 0; i < 50; i++) {
    const confetti = document.createElement('div');
    const color = colors[Math.floor(Math.random() * colors.length)];
    const left = Math.random() * 100;
    const delay = Math.random() * 2;
    const size = Math.random() * 10 + 5;
    confetti.style.cssText = `
      position:absolute;left:${left}%;top:-20px;width:${size}px;height:${size}px;
      background:${color};border-radius:${Math.random() > 0.5 ? '50%' : '2px'};
      animation:confettiFall ${Math.random() * 2 + 2}s ease-in ${delay}s forwards;
    `;
    container.appendChild(confetti);
  }
  
  setTimeout(() => container.remove(), 4000);
}

// Inject confetti keyframes
const styleSheet = document.createElement('style');
styleSheet.textContent = `@keyframes confettiFall { 0% { opacity:1; transform:translateY(0) rotate(0deg); } 100% { opacity:0; transform:translateY(100vh) rotate(720deg); } }`;
document.head.appendChild(styleSheet);

// --- Onboarding ---
let onboardingStep = 1;

function showOnboarding() {
  document.getElementById('onboarding-overlay').style.display = 'flex';
  onboardingStep = 1;
  document.getElementById('onboarding-step-1').style.display = 'block';
  document.getElementById('onboarding-step-2').style.display = 'none';
  document.getElementById('onboarding-step-3').style.display = 'none';
  document.querySelectorAll('.onboarding-dot').forEach((d, i) => {
    d.classList.toggle('active', i === 0);
  });
  document.getElementById('onboarding-next-btn').textContent = 'Next →';
}

function nextOnboardingStep() {
  // Hide current step
  document.getElementById(`onboarding-step-${onboardingStep}`).style.display = 'none';
  document.querySelectorAll('.onboarding-dot')[onboardingStep - 1].classList.remove('active');
  
  onboardingStep++;
  
  if (onboardingStep > 3) {
    dismissOnboarding();
    return;
  }
  
  document.getElementById(`onboarding-step-${onboardingStep}`).style.display = 'block';
  document.querySelectorAll('.onboarding-dot')[onboardingStep - 1].classList.add('active');
  
  if (onboardingStep === 3) {
    document.getElementById('onboarding-next-btn').textContent = 'Let\'s go! 🎉';
  } else {
    document.getElementById('onboarding-next-btn').textContent = 'Next →';
  }
  
  // Re-trigger card animation
  const card = document.getElementById('onboarding-card');
  card.style.animation = 'none';
  card.offsetHeight; // reflow
  card.style.animation = 'bounceIn 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
}

function dismissOnboarding() {
  document.getElementById('onboarding-overlay').style.display = 'none';
  localStorage.setItem('habla_onboarding_done', 'true');
}

// --- Voice Integration ---
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let recognitionSilenceTimer = null;
if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.lang = 'es-ES';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
}

// Detect iOS Safari for workarounds
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

function clearSilenceTimer() {
  if (recognitionSilenceTimer) {
    clearTimeout(recognitionSilenceTimer);
    recognitionSilenceTimer = null;
  }
}

function toggleMic(inputId, btnId) {
  if (!recognition) {
    alert("Speech recognition not supported in this browser.");
    return;
  }
  const btn = document.getElementById(btnId);
  const input = document.getElementById(inputId);

  if (btn.classList.contains('recording')) {
    recognition.stop();
    btn.classList.remove('recording');
    clearSilenceTimer();
    return;
  }

  // On iOS, re-create the recognition object each time to avoid stale state
  if (isIOS()) {
    try { recognition.abort(); } catch(e) {}
    recognition = new SpeechRecognition();
  }

  recognition.lang = 'es';  // Use generic 'es' — iOS Safari struggles with 'es-ES'
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    clearSilenceTimer();
    // Grab the most recent transcript (works with continuous=true)
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript = event.results[i][0].transcript;
    }
    if (!transcript.trim()) return;

    input.value = transcript;
    btn.classList.remove('recording');
    
    // Stop listening once we have words
    try { recognition.stop(); } catch(e) {}

    if (inputId === 'assessment-input') {
      const scoreContainer = document.getElementById('assessment-score-container');
      if (scoreContainer) {
        const accuracy = Math.round(Math.pow(event.results[event.results.length-1][0].confidence, 2.5) * 100);
        document.getElementById('assessment-score-fill').style.width = accuracy + '%';
        document.getElementById('assessment-score-val').innerText = accuracy + '%';
        scoreContainer.style.display = 'flex';
      }
    }

    setTimeout(() => {
        if (inputId === 'assessment-input') sendAssessmentMsg();
        else if (inputId === 'rp-input') sendRpMsg();
    }, 1500);
  };

  recognition.onerror = (event) => {
    console.error("Speech recognition error", event.error);
    btn.classList.remove('recording');
    clearSilenceTimer();
    // Show a helpful message for common iOS errors
    if (event.error === 'no-speech' || event.error === 'audio-capture') {
      input.placeholder = "Mic issue — check permissions and try again";
    }
  };

  recognition.onend = () => {
    btn.classList.remove('recording');
    clearSilenceTimer();
  };

  try {
    recognition.start();
    btn.classList.add('recording');
    // If no result fires within 15s, stop recording so user knows
    recognitionSilenceTimer = setTimeout(() => {
      if (btn.classList.contains('recording')) {
        recognition.stop();
        btn.classList.remove('recording');
        clearSilenceTimer();
        // Show a helpful hint
        input.placeholder = "Didn't catch that — tap 🎤 and speak clearly";
      }
    }, 15000);
  } catch(e) {
    console.log(e);
    btn.classList.remove('recording');
  }
}

// --- Assessment ---
async function startAssessment() {
  if (!currentUser) return;
  isMissionActive = false;
  assessmentHistory = [];
  document.getElementById('home-assessment-intro').style.display = 'none';
  document.getElementById('home-profile').style.display = 'none';
  document.getElementById('home-assessment-area').style.display = 'block';
  const chatBox = document.getElementById('assessment-chat');
  chatBox.innerHTML = loading();
  
  try {
    const data = await api('/api/assessment', { method: 'POST', body: JSON.stringify({}) });
    chatBox.innerHTML = msgHTML('waiter', data.reply, 'Assessor');
    assessmentHistory.push({ role: "user", parts: [{ text: "Start the assessment." }] });
    assessmentHistory.push({ role: "model", parts: [{ text: data.reply }] });
    speakText(data.reply);
  } catch(e) {
    chatBox.innerHTML = `<div style="color:red">Failed to start assessment.</div>`;
  }
}

async function sendAssessmentMsg() {
  const input = document.getElementById('assessment-input');
  const userText = input.value.trim();
  if (!userText) return;
  input.value = '';

  const chatBox = document.getElementById('assessment-chat');
  chatBox.innerHTML += msgHTML('user-msg', userText, 'You');
  
  const loadDiv = document.createElement('div');
  loadDiv.innerHTML = loading();
  chatBox.appendChild(loadDiv);
  chatBox.scrollTop = chatBox.scrollHeight;

  try {
    const data = await api('/api/assessment', {
      method: 'POST',
      body: JSON.stringify({ history: assessmentHistory, userMessage: userText })
    });
    
    assessmentHistory.push({ role: "user", parts: [{ text: userText }] });
    loadDiv.remove();

    if (data.complete) {
      chatBox.innerHTML += msgHTML('waiter', data.reply, 'Assessor');
      document.getElementById('home-assessment-area').style.display = 'none';
      showConfetti();
      loadStatus();
    } else {
      const full = data.reply;
      const parts = full.split(/CORRECTION:/i);
      const reply = parts[0].trim();
      const correction = parts[1] ? parts[1].trim() : null;

      chatBox.innerHTML += msgHTML('waiter', reply, 'Assessor');
      if (correction) {
        chatBox.innerHTML += msgHTML('correction', correction, 'Correction');
      }
      assessmentHistory.push({ role: "model", parts: [{ text: full }] });
      speakText(reply);
    }
  } catch(e) {
    loadDiv.remove();
    let errorMsg = "An error occurred.";
    if (e.message.includes("Too many requests")) errorMsg = "You're speaking too fast! Please wait a minute (Rate Limit).";
    else errorMsg = e.message;
    chatBox.innerHTML += `<div style="color:var(--incorrect);text-align:center;padding:10px;font-weight:bold;">${errorMsg}</div>`;
  }
  chatBox.scrollTop = chatBox.scrollHeight;
}

// --- Drills ---
function stopSession() {
  stopSessionRequested = true;
  window.speechSynthesis.cancel();
}

async function autoPlayDrills() {
  if (isAutoPlaying || isRapidFire || !lastDrills.length) return;
  isAutoPlaying = true;
  stopSessionRequested = false;
  const btn = document.getElementById('autoplay-btn');
  const stopBtn = document.getElementById('stop-btn');
  btn.innerText = 'Playing...';
  btn.disabled = true;
  stopBtn.style.display = 'inline-flex';

  for (let i = 0; i < lastDrills.length; i++) {
    if (stopSessionRequested) break;
    const drill = lastDrills[i];
    const items = document.querySelectorAll('.drill-item');
    items[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
    items[i].style.border = '2px solid var(--primary)';

    await new Promise(r => speakText(drill.base, r));
    if (stopSessionRequested) break;
    await new Promise(r => setTimeout(r, 500));
    if (stopSessionRequested) break;
    await new Promise(r => speakText(drill.cue, r));
    if (stopSessionRequested) break;
    await new Promise(r => setTimeout(r, 3500));
    if (stopSessionRequested) break;
    items[i].classList.add('revealed');
    await new Promise(r => speakText(drill.answer, r));
    items[i].style.border = '2px solid var(--border-color)';
    await new Promise(r => setTimeout(r, 1500));
  }

  isAutoPlaying = false;
  btn.innerText = 'Auto-Play (Hands-Free)';
  btn.disabled = false;
  stopBtn.style.display = 'none';
}

async function startRapidFireDrills() {
  if (isAutoPlaying || isRapidFire || !lastDrills.length) return;
  isRapidFire = true;
  stopSessionRequested = false;
  const btn = document.getElementById('rapid-btn');
  const stopBtn = document.getElementById('stop-btn');
  const waitMs = parseInt(document.getElementById('rapid-speed').value) || 3000;
  
  btn.innerText = 'Rapid-Fire...';
  btn.disabled = true;
  stopBtn.style.display = 'inline-flex';

  for (let i = 0; i < lastDrills.length; i++) {
    if (stopSessionRequested) break;
    const drill = lastDrills[i];
    const items = document.querySelectorAll('.drill-item');
    items[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
    items[i].style.border = '2px solid var(--incorrect)';

    const cueToSay = drill.translation ? drill.translation : drill.cue;
    const utterance = new SpeechSynthesisUtterance(cueToSay);
    utterance.lang = 'en-US';
    window.speechSynthesis.speak(utterance);
    
    await new Promise(r => setTimeout(r, waitMs + 500)); 
    if (stopSessionRequested) break;
    
    items[i].classList.add('revealed');
    items[i].style.border = '2px solid var(--secondary)';
    await new Promise(r => speakText(drill.answer, r));
    
    items[i].style.border = '2px solid var(--border-color)';
    await new Promise(r => setTimeout(r, 1000));
  }

  isRapidFire = false;
  btn.innerText = '🚀 Rapid-Fire';
  btn.disabled = false;
  stopBtn.style.display = 'none';
}

async function generateDrills() {
  const verb = document.getElementById('drill-verb').value;
  const tense = document.getElementById('drill-tense').value;
  const pattern = document.getElementById('drill-pattern').value;
  const out = document.getElementById('drill-output');
  const btn = document.getElementById('drill-gen-btn');
  out.innerHTML = loading();
  btn.disabled = true;

  try {
    const data = await api('/api/generate/drills', {
      method: 'POST',
      body: JSON.stringify({ verb, tense, pattern })
    });
    lastDrills = data.drills;
    
    const conj = data.conjugation;
    const formatConj = (val) => {
      if (Array.isArray(val) && val.length === 2) {
        return `<span style="color:var(--text-main);">${val[0]}</span><span style="color:#ef4444; font-weight:900;">${val[1]}</span>`;
      }
      return val;
    };

    const conjHTML = conj ? `
      <div class="card" style="margin-top: 15px; background: rgba(0,0,0,0.02); border: 1px dashed var(--border-color);">
        <div class="card-label" style="background: var(--primary); color: white;">Conjugation: ${conj.verb}</div>
        <div class="card-body">
          <div style="display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: repeat(3, auto); grid-auto-flow: column; gap: 8px;">
            <div class="drill-item" style="padding: 8px; margin: 0; cursor: default;"><span style="font-weight:800; color:var(--text-light); font-size:11px;">YO</span><br><strong style="font-size:16px;">${formatConj(conj.yo)} <span class="speaker-btn" onclick="event.stopPropagation();speakText('${String(conj.yo).replace(/'/g, "\\'")}')">🔊</span></strong></div>
            <div class="drill-item" style="padding: 8px; margin: 0; cursor: default;"><span style="font-weight:800; color:var(--text-light); font-size:11px;">TÚ</span><br><strong style="font-size:16px;">${formatConj(conj.tu)} <span class="speaker-btn" onclick="event.stopPropagation();speakText('${String(conj.tu).replace(/'/g, "\\'")}')">🔊</span></strong></div>
            <div class="drill-item" style="padding: 8px; margin: 0; cursor: default;"><span style="font-weight:800; color:var(--text-light); font-size:11px;">ÉL/ELLA/UD.</span><br><strong style="font-size:16px;">${formatConj(conj.el_ella_usted)} <span class="speaker-btn" onclick="event.stopPropagation();speakText('${String(conj.el_ella_usted).replace(/'/g, "\\'")}')">🔊</span></strong></div>
            <div class="drill-item" style="padding: 8px; margin: 0; cursor: default;"><span style="font-weight:800; color:var(--text-light); font-size:11px;">NOSOTROS/AS</span><br><strong style="font-size:16px;">${formatConj(conj.nosotros_as)} <span class="speaker-btn" onclick="event.stopPropagation();speakText('${String(conj.nosotros_as).replace(/'/g, "\\'")}')">🔊</span></strong></div>
            <div class="drill-item" style="padding: 8px; margin: 0; cursor: default;"><span style="font-weight:800; color:var(--text-light); font-size:11px;">VOSOTROS/AS</span><br><strong style="font-size:16px;">${formatConj(conj.vosotros_as)} <span class="speaker-btn" onclick="event.stopPropagation();speakText('${String(conj.vosotros_as).replace(/'/g, "\\'")}')">🔊</span></strong></div>
            <div class="drill-item" style="padding: 8px; margin: 0; cursor: default;"><span style="font-weight:800; color:var(--text-light); font-size:11px;">ELLOS/ELLAS/UDS.</span><br><strong style="font-size:16px;">${formatConj(conj.ellos_ellas_ustedes)} <span class="speaker-btn" onclick="event.stopPropagation();speakText('${String(conj.ellos_ellas_ustedes).replace(/'/g, "\\'")}')">🔊</span></strong></div>
          </div>
        </div>
      </div>
    ` : '';

    out.innerHTML = `<div class="card">
      <div class="card-label">${verb} · ${tense} · ${pattern}</div>
      <div style="display:flex;gap:10px;margin-bottom:15px;flex-wrap:wrap;">
        <button class="gen-btn" style="flex:1" id="autoplay-btn" onclick="autoPlayDrills()">Auto-Play</button>
        <button class="gen-btn" style="flex:1; background:var(--warning); border-bottom-color:var(--warning-shadow);" id="rapid-btn" onclick="startRapidFireDrills()">🚀 Rapid-Fire</button>
        <button class="gen-btn" style="flex:1; background:var(--incorrect); border-bottom-color:var(--incorrect-shadow); display:none;" id="stop-btn" onclick="stopSession()">⏹ Stop</button>
      </div>
      ${data.drills.map(d => `<div class="drill-item" onclick="this.classList.toggle('revealed')">
        <div class="drill-es">${d.base} <span class="speaker-btn" onclick="event.stopPropagation();speakText('${d.base.replace(/'/g, "\\'")}')">🔊</span></div>
        <div class="drill-cue">Cue: <strong>${d.cue}</strong> · <span style="color:var(--text-light)">${d.translation}</span></div>
        <div class="drill-ans">→ ${d.answer} <span class="speaker-btn" onclick="event.stopPropagation();speakText('${d.answer.replace(/'/g, "\\'")}')">🔊</span></div>
      </div>`).join('')}
      <button class="reveal-all" style="width:100%; margin-top:10px;" onclick="document.querySelectorAll('.drill-item').forEach(d=>d.classList.add('revealed'))">Reveal all answers</button>
    </div>
    ${conjHTML}`;
  } catch(e) {
    out.innerHTML = `<div class="card"><div class="card-body" style="color:red">${e.message}</div></div>`;
  }
  btn.disabled = false;
}

async function startDailyMission() {
  if (!currentUser) return;
  if (!userProfile || !userProfile.level) {
    alert("Please take the Assessment or select your level first.");
    showTab('home', document.querySelector('.tb[data-tab="home"]'));
    return;
  }
  
  isMissionActive = true;
  showTab('drill', document.querySelector('.tb[data-tab="drill"]'));
  document.getElementById('drill-verb').value = "tener";
  document.getElementById('drill-tense').value = userProfile.level.startsWith('A') ? "Preterite (Past)" : "Present Subjunctive";
  document.getElementById('drill-pattern').value = "Translation";
  await generateDrills();
  
  setTimeout(() => {
      if (!isMissionActive) return;
      startRapidFireDrills();
  }, 4000);
}

async function setManualLevel(source = 'intro') {
  const selectId = source === 'profile' ? 'manual-level-select-profile' : 'manual-level-select';
  const level = document.getElementById(selectId).value;
  try {
    const data = await api('/api/user/level', {
      method: 'POST',
      body: JSON.stringify({ level })
    });
    if (data.success) loadStatus();
  } catch (e) {
    console.error(e);
    alert("Failed to set level.");
  }
}

// --- Vocab ---
async function generateVocab() {
  const theme = document.getElementById('vocab-theme').value;
  const out = document.getElementById('vocab-output');
  const btn = document.getElementById('vocab-gen-btn');
  out.innerHTML = loading();
  btn.disabled = true;

  try {
    const data = await api('/api/generate/vocab', {
      method: 'POST',
      body: JSON.stringify({ theme })
    });
    
    out.innerHTML = `<div style="margin-bottom:8px;font-size:13px;color:var(--text-muted)">Theme: <strong>${theme}</strong></div>
    <div class="vocab-grid">
      ${data.map(v => `<div class="vocab-card" onclick="this.classList.toggle('revealed')">
        <div class="vocab-es">${v.es} <span class="speaker-btn" onclick="event.stopPropagation();speakText('${v.es.replace(/'/g, "\\'")}')">🔊</span></div>
        <div class="vocab-en">${v.en}</div>
        <div class="vocab-ex">
          ${v.example_es} <span class="speaker-btn" onclick="event.stopPropagation();speakText('${v.example_es.replace(/'/g, "\\'")}')">🔊</span><br><em>${v.example_en}</em>
        </div>
      </div>`).join('')}
    </div>`;
  } catch(e) {
    out.innerHTML = `<div class="card"><div class="card-body" style="color:red">${e.message}</div></div>`;
  }
  btn.disabled = false;
}

// --- Roleplay ---
async function startRoleplay() {
  if (!currentUser) return;
  rpScenario = document.getElementById('rp-scenario').value;
  rpHistory = [];
  document.getElementById('rp-placeholder').style.display = 'none';
  document.getElementById('rp-area').style.display = 'block';
  document.getElementById('rp-tag').textContent = rpScenario;
  const chatBox = document.getElementById('rp-chat');
  chatBox.innerHTML = loading();
  document.getElementById('rp-start-btn').disabled = true;

  try {
    const data = await api('/api/roleplay', {
      method: 'POST',
      body: JSON.stringify({ scenario: rpScenario })
    });
    rpHistory.push({ role: "user", parts: [{ text: "Start the scenario." }] });
    rpHistory.push({ role: "model", parts: [{ text: data.reply }] });
    chatBox.innerHTML = msgHTML('waiter', data.reply, 'Partner');
    speakText(data.reply);
  } catch(e) {
    chatBox.innerHTML = `<div style="color:red">Failed to start scenario.</div>`;
  }
  document.getElementById('rp-start-btn').disabled = false;
}

function finishRoleplay() {
  rpHistory = [];
  document.getElementById('rp-area').style.display = 'none';
  document.getElementById('rp-placeholder').style.display = 'block';
  document.getElementById('rp-chat').innerHTML = '';
  document.getElementById('rp-tag').textContent = '';
  document.getElementById('rp-start-btn').disabled = false;
}

async function sendRpMsg() {
  const input = document.getElementById('rp-input');
  const userText = input.value.trim();
  if (!userText) return;
  input.value = '';
  document.getElementById('rp-send-btn').disabled = true;

  const exitKeywords = ['adios', 'adiós', 'chau', 'hasta luego', 'terminar', 'finish'];
  if (exitKeywords.some(k => userText.toLowerCase().includes(k))) {
    const chatBox = document.getElementById('rp-chat');
    chatBox.innerHTML += msgHTML('user-msg', userText, 'You');
    setTimeout(() => {
      alert("Roleplay finished! ¡Hasta la próxima!");
      finishRoleplay();
    }, 1000);
    return;
  }

  const chatBox = document.getElementById('rp-chat');
  chatBox.innerHTML += msgHTML('user-msg', userText, 'You');
  
  const loadDiv = document.createElement('div');
  loadDiv.innerHTML = loading();
  chatBox.appendChild(loadDiv);
  chatBox.scrollTop = chatBox.scrollHeight;

  try {
    const data = await api('/api/roleplay', {
      method: 'POST',
      body: JSON.stringify({ scenario: rpScenario, history: rpHistory, userMessage: userText })
    });
    
    rpHistory.push({ role: "user", parts: [{ text: userText }] });
    loadDiv.remove();

    const full = data.reply;
    const parts = full.split(/CORRECTION:/i);
    const reply = parts[0].trim();
    const correction = parts[1] ? parts[1].trim() : null;

    rpHistory.push({ role: "model", parts: [{ text: full }] });
    
    chatBox.innerHTML += msgHTML('waiter', reply, 'Partner');
    speakText(reply);
    
    if (correction && !correction.toLowerCase().includes('no errors') && !correction.toLowerCase().includes('perfecto')) {
      chatBox.innerHTML += msgHTML('correction', correction, 'Correction');
    }
  } catch(e) {
    loadDiv.remove();
    let errorMsg = "An error occurred.";
    if (e.message.includes("Too many requests")) errorMsg = "You're speaking too fast! Please wait a minute (Rate Limit).";
    else errorMsg = e.message;
    chatBox.innerHTML += `<div style="color:var(--incorrect);text-align:center;padding:10px;font-weight:bold;">${errorMsg}</div>`;
  }
  document.getElementById('rp-send-btn').disabled = false;
  chatBox.scrollTop = chatBox.scrollHeight;
}

// --- Speech (with cloud TTS fallback) ---
let cachedSpanishVoice = null;
let audioCache = {};

function findBestSpanishVoice() {
  const voices = window.speechSynthesis.getVoices();
  const preferred = ['Google español', 'Google es-ES', 'Microsoft Helena', 'Microsoft Laura', 'Microsoft Sabina'];
  // Try preferred names first
  for (const name of preferred) {
    const found = voices.find(v => v.name === name);
    if (found) return found;
  }
  // Try any Spanish voice
  const spanish = voices.find(v => v.lang && (v.lang.startsWith('es') || v.lang.startsWith('es-')));
  if (spanish) return spanish;
  // Fallback: any voice that has 'es' in lang
  const esFallback = voices.find(v => v.lang && v.lang.includes('es'));
  if (esFallback) return esFallback;
  return null;
}

function loadSpanishVoice() {
  if (cachedSpanishVoice) return;
  const v = findBestSpanishVoice();
  if (v) cachedSpanishVoice = v;
  if (!cachedSpanishVoice && window.speechSynthesis.getVoices().length > 0) {
    // If no Spanish voice found, just use any available voice
    cachedSpanishVoice = window.speechSynthesis.getVoices()[0];
  }
}

// Initialize voice loading
if (window.speechSynthesis) {
  loadSpanishVoice();
  window.speechSynthesis.onvoiceschanged = () => {
    loadSpanishVoice();
  };
}

// Track if cloud TTS is available (set after first attempt)
let cloudTTSAvailable = null; // null = unknown, true/false = known

// Play audio from a blob URL
function playAudioBlob(blobUrl, onEnd) {
  const audio = new Audio(blobUrl);
  audio.volume = 1.0;
  audio.onended = () => {
    URL.revokeObjectURL(blobUrl);
    if (onEnd) onEnd();
  };
  audio.onerror = (e) => {
    console.error('Audio playback error:', e);
    URL.revokeObjectURL(blobUrl);
    if (onEnd) onEnd();
  };
  audio.play().catch(e => {
    console.error('Audio play failed:', e);
    if (onEnd) onEnd();
  });
}

// Try cloud TTS first, fall back to Web Speech
async function speakText(text, onEnd = null) {
  const cleanText = text.split("CORRECTION:")[0].trim();
  if (!cleanText) { if (onEnd) onEnd(); return; }
  
  // Try cloud TTS if not ruled out
  if (cloudTTSAvailable !== false) {
    try {
      const resp = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: cleanText }),
      });
      
      const contentType = resp.headers.get('content-type') || '';
      
      if (contentType.includes('audio/mpeg') || contentType.includes('audio/')) {
        // Success — got audio back
        cloudTTSAvailable = true;
        const blob = await resp.blob();
        const blobUrl = URL.createObjectURL(blob);
        playAudioBlob(blobUrl, onEnd);
        return;
      }
      
      // Got JSON response — check if fallback
      const data = await resp.json();
      if (data.fallback) {
        cloudTTSAvailable = false;
        // Fall through to Web Speech
      } else {
        cloudTTSAvailable = true;
        if (onEnd) onEnd();
        return;
      }
    } catch (e) {
      console.warn('Cloud TTS failed, using Web Speech:', e);
      cloudTTSAvailable = false;
    }
  }
  
  // Fallback: Web Speech API
  if (!window.speechSynthesis) { if (onEnd) onEnd(); return; }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(cleanText);
  utterance.lang = 'es-ES';
  utterance.rate = 0.9;
  utterance.pitch = 1.0;
  if (cachedSpanishVoice) {
    utterance.voice = cachedSpanishVoice;
  }
  if (onEnd) utterance.onend = onEnd;
  window.speechSynthesis.speak(utterance);
}

// --- Init ---
checkAuth();
