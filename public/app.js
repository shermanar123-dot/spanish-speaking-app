// UI & Tabs
function escapeHTML(str) {
  if (!str) return '';
  return String(str).replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag]));
}

function showTab(id, el) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('on'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('on'));
  const target = document.getElementById('tab-' + id);
  if (target) target.classList.add('on');
  if (el) el.classList.add('on');
  if (id === 'home') loadStatus();
}

function loading() {
  return `<div class="loading"><div class="dot"></div><div class="dot"></div><div class="dot"></div><span>Generating...</span></div>`;
}

function msgHTML(type, text, label) {
  const safeText = escapeHTML(text);
  const safeLabel = escapeHTML(label);
  let btn = type === 'waiter' ? `<button class="speaker-btn" onclick="speakText(this.parentElement.innerText.replace('${safeLabel}', ''))">🔊</button>` : '';
  return `<div class="msg ${type}"><div class="msg-label">${safeLabel}</div>${safeText}${btn}</div>`;
}

// State
let assessmentHistory = [];
let rpHistory = [];
let rpScenario = "";
let userProfile = null;
let lastDrills = [];
let isAutoPlaying = false;
let isRapidFire = false;
let isMissionActive = false;
let stopSessionRequested = false;

// Initial Load
async function loadStatus() {
  try {
    const res = await fetch('/api/user/status');
    const data = await res.json();
    userProfile = data.profile;
    
    document.getElementById('stat-streak').innerText = data.progress.streak || 0;
    document.getElementById('stat-mins').innerText = data.progress.total_minutes || 0;
    document.getElementById('stat-drills').innerText = data.progress.drills_done || 0;
    
    // UI logic for first-timer vs repeat user on HOME tab
    const intro = document.getElementById('home-assessment-intro');
    const profileCard = document.getElementById('home-profile');
    const assessmentArea = document.getElementById('home-assessment-area');

    if (userProfile && userProfile.level) {
      document.getElementById('stat-level').innerText = userProfile.level;
      
      // Show results, Hide intro
      intro.style.display = 'none';
      profileCard.style.display = 'block';
      
      // Update data
      document.getElementById('home-prof-level').innerText = userProfile.level;
      document.getElementById('home-prof-str').innerText = userProfile.strengths;
      document.getElementById('home-prof-weak').innerText = userProfile.weaknesses;
      const date = new Date(userProfile.last_assessed);
      document.getElementById('home-prof-date').innerText = date.toLocaleDateString();
    } else {
      // First timer
      document.getElementById('stat-level').innerText = '?';
      intro.style.display = 'block';
      profileCard.style.display = 'none';
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
    const res = await fetch('/api/user/mistakes');
    const data = await res.json();
    
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

// Voice Integration (Web Speech API)
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.lang = 'es-ES'; // Spanish input
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
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
    return;
  }

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    const confidence = event.results[0][0].confidence;
    input.value = transcript;
    btn.classList.remove('recording');
    
    // Display Pronunciation Score (Only for Assessment)
    if (inputId === 'assessment-input') {
      const scoreContainer = document.getElementById('assessment-score-container');
      const scoreFill = document.getElementById('assessment-score-fill');
      const scoreVal = document.getElementById('assessment-score-val');
      
      if (scoreContainer) {
        let accuracy = Math.round(Math.pow(confidence, 2.5) * 100);
        scoreContainer.style.display = 'flex';
        scoreFill.style.width = accuracy + '%';
        scoreVal.innerText = accuracy + '%';
        
        if (accuracy >= 88) scoreFill.style.background = 'var(--secondary)';
        else if (accuracy >= 65) scoreFill.style.background = '#f59e0b';
        else scoreFill.style.background = '#ef4444';
      }
    }

    // Auto-send after a short delay
    setTimeout(() => {
        if (inputId === 'assessment-input') sendAssessmentMsg();
        else if (inputId === 'rp-input') sendRpMsg();
    }, 1500);
  };

  recognition.onerror = (event) => {
    console.error("Speech recognition error", event.error);
    btn.classList.remove('recording');
  };

  recognition.onend = () => {
    btn.classList.remove('recording');
  };

  try {
    recognition.start();
    btn.classList.add('recording');
  } catch(e) {
    console.log(e);
  }
}

function speakText(text, onEnd = null) {
  if (!window.speechSynthesis) return;
  const cleanText = text.split("CORRECTION:")[0].trim();
  const utterance = new SpeechSynthesisUtterance(cleanText);
  utterance.lang = 'es-ES';
  if (onEnd) {
    utterance.onend = onEnd;
  }
  window.speechSynthesis.speak(utterance);
}

// Assessment Flow
async function startAssessment() {
  isMissionActive = false;
  assessmentHistory = [];
  document.getElementById('home-assessment-intro').style.display = 'none';
  document.getElementById('home-profile').style.display = 'none';
  document.getElementById('home-assessment-area').style.display = 'block';
  const chatBox = document.getElementById('assessment-chat');
  chatBox.innerHTML = loading();
  
  try {
    const res = await fetch('/api/assessment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await res.json();
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
    const res = await fetch('/api/assessment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: assessmentHistory, userMessage: userText })
    });
    
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText);
    }
    
    const data = await res.json();
    
    assessmentHistory.push({ role: "user", parts: [{ text: userText }] });
    loadDiv.remove();

    if (data.complete) {
      chatBox.innerHTML += msgHTML('waiter', data.reply, 'Assessor');
      document.getElementById('home-assessment-area').style.display = 'none';
      loadStatus(); // This will show the profile card
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
    if (e.message.includes("Too many requests")) errorMsg = "You're speaking too fast! Please wait a minute before sending another message (Rate Limit).";
    else if (e.message.includes("error")) {
      try { errorMsg = JSON.parse(e.message).error; } catch(err) { errorMsg = e.message; }
    }
    chatBox.innerHTML += `<div style="color:var(--incorrect);text-align:center;padding:10px;font-weight:bold;">${errorMsg}</div>`;
  }
  chatBox.scrollTop = chatBox.scrollHeight;
}

// Drills Flow
function stopSession() {
  stopSessionRequested = true;
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
    const res = await fetch('/api/generate/drills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verb, tense, pattern })
    });
    const data = await res.json();
    lastDrills = data;
    
    out.innerHTML = `<div class="card">
      <div class="card-label">${verb} · ${tense} · ${pattern}</div>
      <div style="display:flex;gap:10px;margin-bottom:15px;flex-wrap:wrap;">
        <button class="gen-btn" style="flex:1" id="autoplay-btn" onclick="autoPlayDrills()">Auto-Play (Hands-Free)</button>
        <button class="gen-btn" style="flex:1; background:var(--warning); border-bottom-color:var(--warning-shadow);" id="rapid-btn" onclick="startRapidFireDrills()">🚀 Rapid-Fire</button>
        <button class="gen-btn" style="flex:1; background:var(--incorrect); border-bottom-color:var(--incorrect-shadow); display:none;" id="stop-btn" onclick="stopSession()">⏹ Stop session</button>
      </div>
      ${data.map((d,i) => `<div class="drill-item" onclick="this.classList.toggle('revealed')">
        <div class="drill-es">${d.base}</div>
        <div class="drill-cue">Cue: <strong>${d.cue}</strong> &nbsp;·&nbsp; <span style="color:var(--text-light)">${d.translation}</span></div>
        <div class="drill-ans">→ ${d.answer} <button class="speaker-btn" style="position:relative;top:0;right:0;margin-left:8px" onclick="event.stopPropagation(); speakText('${d.answer.replace(/'/g, "\\'")}')">🔊</button></div>
      </div>`).join('')}
      <button class="reveal-all" style="width:100%; margin-top:10px; background:var(--bg-input); color:var(--text-main)" onclick="document.querySelectorAll('.drill-item').forEach(d=>d.classList.add('revealed'))">Reveal all answers</button>
    </div>`;
  } catch(e) {
    out.innerHTML = `<div class="card"><div class="card-body" style="color:red">Generation failed.</div></div>`;
  }
  btn.disabled = false;
}

async function startDailyMission() {
  if (!userProfile || !userProfile.level) {
    alert("Please take the Assessment or select your level first so we can tailor your practice.");
    showTab('home', document.querySelector('.tab:nth-child(1)'));
    return;
  }
  
  isMissionActive = true;
  showTab('drill', document.querySelector('.tab:nth-child(2)'));
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
    const res = await fetch('/api/user/level', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level })
    });
    if (res.ok) {
      loadStatus();
    } else {
      alert("Failed to set level.");
    }
  } catch (e) {
    console.error(e);
    alert("Failed to set level.");
  }
}

// Vocab Flow
async function generateVocab() {
  const theme = document.getElementById('vocab-theme').value;
  const out = document.getElementById('vocab-output');
  const btn = document.getElementById('vocab-gen-btn');
  out.innerHTML = loading();
  btn.disabled = true;

  try {
    const res = await fetch('/api/generate/vocab', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme })
    });
    const data = await res.json();
    
    out.innerHTML = `<div style="margin-bottom:8px;font-size:13px;color:var(--text-muted)">Theme: <strong>${theme}</strong></div>
    <div class="vocab-grid">
      ${data.map(v => `<div class="vocab-card" onclick="this.classList.toggle('revealed')">
        <div class="vocab-es">${v.es} <button class="speaker-btn" style="position:relative;top:0;right:0;margin-left:8px" onclick="event.stopPropagation(); speakText('${v.es.replace(/'/g, "\\'")}')">🔊</button></div>
        <div class="vocab-en">${v.en}</div>
        <div class="vocab-ex">
          ${v.example_es} <button class="speaker-btn" style="position:relative;top:0;right:0;margin-left:8px" onclick="event.stopPropagation(); speakText('${v.example_es.replace(/'/g, "\\'")}')">🔊</button><br><em>${v.example_en}</em>
          <div style="margin-top: 10px;">
            <button class="gen-btn" style="font-size: 12px; padding: 4px 8px;" onclick="event.stopPropagation(); const b = this.nextElementSibling; b.style.display = b.style.display === 'block' ? 'none' : 'block';">Synonyms & Antonyms</button>
            <div style="display: none; margin-top: 8px; padding: 8px; background: rgba(0,0,0,0.05); border-radius: 4px; font-size: 0.9em; color: var(--text-main);">
              <strong>Synonyms:</strong> ${v.synonyms || 'N/A'}<br>
              <strong>Antonyms:</strong> ${v.antonyms || 'N/A'}
            </div>
          </div>
        </div>
      </div>`).join('')}
    </div>`;
  } catch(e) {
    out.innerHTML = `<div class="card"><div class="card-body" style="color:red">Generation failed.</div></div>`;
  }
  btn.disabled = false;
}

// Roleplay Flow
async function startRoleplay() {
  rpScenario = document.getElementById('rp-scenario').value;
  rpHistory = [];
  document.getElementById('rp-placeholder').style.display = 'none';
  document.getElementById('rp-area').style.display = 'block';
  document.getElementById('rp-tag').textContent = rpScenario;
  const chatBox = document.getElementById('rp-chat');
  chatBox.innerHTML = loading();
  document.getElementById('rp-start-btn').disabled = true;

  try {
    const res = await fetch('/api/roleplay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: rpScenario })
    });
    const data = await res.json();
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
  
  const scoreContainer = document.getElementById('rp-score-container');
  if (scoreContainer) scoreContainer.style.display = 'none';
  
  console.log("Roleplay finished.");
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
    const res = await fetch('/api/roleplay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: rpScenario, history: rpHistory, userMessage: userText })
    });
    
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText);
    }
    
    const data = await res.json();
    
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
    if (e.message.includes("Too many requests")) errorMsg = "You're speaking too fast! Please wait a minute before sending another message (Rate Limit).";
    else if (e.message.includes("error")) {
      try { errorMsg = JSON.parse(e.message).error; } catch(err) { errorMsg = e.message; }
    }
    chatBox.innerHTML += `<div style="color:var(--incorrect);text-align:center;padding:10px;font-weight:bold;">${errorMsg}</div>`;
  }
  document.getElementById('rp-send-btn').disabled = false;
  chatBox.scrollTop = chatBox.scrollHeight;
}

// Init
loadStatus();

// Quick Translate
async function quickTranslate() {
  const input = document.getElementById('quick-translate-input');
  const text = input.value.trim();
  if (!text) return;
  
  const resultBox = document.getElementById('quick-translate-result');
  const resultText = document.getElementById('quick-translate-text');
  
  resultBox.style.display = 'flex';
  resultText.innerText = 'Translating...';
  resultText.style.color = 'var(--text-muted)';
  
  try {
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    
    resultText.innerText = data.translation;
    resultText.style.color = 'var(--primary)';
  } catch (e) {
    resultText.innerText = 'Error translating.';
    resultText.style.color = 'var(--incorrect)';
  }
}

