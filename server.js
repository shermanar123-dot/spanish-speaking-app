const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const basicAuth = require('express-basic-auth');
const { GoogleGenAI } = require('@google/genai');
const db = require('./database');
const prompts = require('./prompt_templates');

dotenv.config();

const app = express();

// --- 1. Security: Basic Authentication ---
// Protects the entire app from unauthorized access (Issue 5)
const users = {};
users[process.env.APP_USER || 'admin'] = process.env.APP_PASSWORD || 'secret';
app.use(basicAuth({
  users: users,
  challenge: true,
  realm: 'Habla Diario'
}));

// --- 2. Security: Rate Limiting ---
// Limits each IP to 30 requests per minute to prevent API abuse (Issue 2)
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // Limit each IP to 30 requests per `window`
  message: 'Too many requests from this IP, please try again after a minute'
});
app.use(limiter);

// --- 3. Security: CORS Policy ---
// Only allows requests from specified origins (Issue 3)
const allowedOrigins = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',') : ['http://localhost:3000', 'http://localhost:8000', 'http://127.0.0.1:8000'];
app.use(cors({
  origin: function(origin, callback){
    if(!origin) return callback(null, true);
    if(allowedOrigins.indexOf(origin) === -1){
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  }
}));

app.use(express.json({ limit: '1mb' })); // Limit JSON body size
app.use(express.static('public'));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL_NAME = 'gemini-2.5-flash';

// Helper to get user profile
const getProfile = (userId) => {
  return new Promise((resolve) => {
    db.get('SELECT * FROM assessment_profiles WHERE user_id = ?', [userId], (err, row) => {
      resolve(row || null);
    });
  });
};

// HELPER: Generate Content with Gemini
async function callGemini(systemInstruction, userPrompt) {
  try {
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: userPrompt,
      config: {
        systemInstruction: systemInstruction,
        temperature: 0.7
      }
    });
    return response.text;
  } catch (error) {
    console.error("Gemini API Error:", error);
    throw new Error('Failed to generate content from AI.');
  }
}

// HELPER: Save mistake to DB
const saveMistake = (userId, original, correction) => {
  if (!correction || correction.toLowerCase().includes('perfecto') || correction.toLowerCase().includes('no errors')) return;
  db.run('INSERT INTO mistakes (user_id, original_text, correction) VALUES (?, ?, ?)', [userId, original, correction]);
};

// 1. Get User Profile and Progress
app.get('/api/user/status', (req, res) => {
  const userId = 1; // Default user
  db.get('SELECT * FROM progress WHERE user_id = ?', [userId], async (err, progress) => {
    const profile = await getProfile(userId);
    res.json({ progress: progress || {}, profile: profile || {} });
  });
});

app.post('/api/user/level', (req, res) => {
  const { level } = req.body;
  if (!['A1', 'A2', 'B1', 'B2'].includes(level)) {
    return res.status(400).json({ error: 'Invalid level.' });
  }
  db.run(`INSERT OR REPLACE INTO assessment_profiles (user_id, level, strengths, weaknesses, last_assessed) 
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`, 
          [1, level, 'Manually Selected', 'Manually Selected'], 
          (err) => {
            if(err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
          });
});

// Get recent mistakes
app.get('/api/user/mistakes', (req, res) => {
  db.all('SELECT * FROM mistakes WHERE user_id = 1 ORDER BY created_at DESC LIMIT 10', [], (err, rows) => {
    res.json(rows || []);
  });
});

// 2. Assessment
app.post('/api/assessment', async (req, res) => {
  let { history, userMessage } = req.body;
  
  // --- 4. Security: Input Validation (Issue 4) ---
  if (userMessage && (typeof userMessage !== 'string' || userMessage.length > 500)) {
    return res.status(400).json({ error: 'Message must be a string under 500 characters.' });
  }
  if (history && (!Array.isArray(history) || history.length > 20)) {
    return res.status(400).json({ error: 'History is invalid or too long.' });
  }

  const systemPrompt = prompts.getAssessmentPrompt();
  
  try {
    // Construct chat history for the API
    let contents = history || [];
    if (userMessage) {
        contents.push({ role: "user", parts: [{ text: userMessage }] });
    } else {
        contents.push({ role: "user", parts: [{ text: "Start the assessment." }] });
    }

    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: contents,
      config: { systemInstruction: systemPrompt, temperature: 0.2 }
    });

    const reply = response.text;
    
    // Parse Correction and Save if exists
    if (userMessage && reply.includes('CORRECTION:')) {
      const correction = reply.split(/CORRECTION:/i)[1].trim();
      saveMistake(1, userMessage, correction);
    }

    // Check if the AI returned the final JSON profile
    if (reply.includes('{') && reply.includes('}')) {
      try {
        const jsonMatch = reply.match(/\{[\s\S]*\}/)[0];
        const profile = JSON.parse(jsonMatch);
        
        // Save to DB
        db.run(`INSERT OR REPLACE INTO assessment_profiles (user_id, level, strengths, weaknesses) 
                VALUES (?, ?, ?, ?)`, 
                [1, profile.level, profile.strengths, profile.weaknesses], 
                (err) => {
                  if(err) console.error("DB Error:", err);
                });
        return res.json({ complete: true, profile, reply: profile.feedback });
      } catch(e) {
        // Fallback if parsing fails
      }
    }
    
    res.json({ complete: false, reply });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Security Allow-lists ---
const VALID_VERBS = [
  "ser", "estar", "tener", "hacer", "poder", "decir", "ir", "ver", "dar", "saber",
  "querer", "llegar", "pasar", "deber", "poner", "parecer", "quedar", "creer",
  "hablar", "llevar", "dejar", "seguir", "encontrar", "llamar", "venir",
  "pensar", "salir", "volver", "tomar", "conocer", "vivir", "sentir", "tratar",
  "mirar", "contar", "empezar", "esperar", "escribir", "buscar", "entrar",
  "trabajar", "perder", "ocurrir", "entender", "pedir", "recibir", "recordar",
  "terminar", "permitir", "aparecer"
];
const VALID_TENSES = ["Present", "Preterite (Past)", "Imperfect (Past Continuous)", "Future", "Present Perfect", "Present Subjunctive"];
const VALID_PATTERNS = ["Substitution", "Transformation", "Response", "Translation", "Expansion"];
const VALID_THEMES = [
  "café and food ordering", "shopping and markets", "travel and transport",
  "work and daily routine", "health and body", "hotel check-in", "airport and flights",
  "hobbies and free time", "emergencies", "real estate and housing", "time and dates",
  "days, months, and years", "numbers and counting"
];
const VALID_SCENARIOS = [
  "ordering at a café in Madrid", "buying groceries at a market", "asking for directions in the street",
  "job interview or office meeting", "visiting a doctor", "checking in at a hotel",
  "checking in at the airport", "discussing hobbies and free time with a friend",
  "reporting an emergency or lost item", "looking for an apartment to rent",
  "making an appointment or scheduling a meeting", "planning a future event or birthday party",
  "discussing prices, quantities, and measurements"
];

// 3. Generate Drills
app.post('/api/generate/drills', async (req, res) => {
  const { verb, tense, pattern } = req.body;
  
  // Input Validation & Prompt Injection Mitigation
  if (!VALID_VERBS.includes(verb) || !VALID_TENSES.includes(tense) || !VALID_PATTERNS.includes(pattern)) {
     return res.status(400).json({ error: 'Invalid selection. Please use the provided options.' });
  }

  const profile = await getProfile(1);
  const systemPrompt = prompts.getDrillPrompt(profile, verb, tense, pattern);
  
  try {
    let rawText = await callGemini(systemPrompt, `Generate 6 drills for ${verb} in ${tense} using ${pattern} pattern.`);
    rawText = rawText.replace(/```json|```/g, "").trim();
    const data = JSON.parse(rawText);
    
    // Update progress
    db.run('UPDATE progress SET drills_done = drills_done + 6 WHERE user_id = 1');
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. Generate Vocab
app.post('/api/generate/vocab', async (req, res) => {
  const { theme } = req.body;
  
  // Input Validation & Prompt Injection Mitigation
  if (!VALID_THEMES.includes(theme)) {
     return res.status(400).json({ error: 'Invalid theme selected.' });
  }

  const profile = await getProfile(1);
  const systemPrompt = prompts.getVocabPrompt(profile, theme);
  
  try {
    let rawText = await callGemini(systemPrompt, `Generate 20 vocabulary words for ${theme}.`);
    rawText = rawText.replace(/```json|```/g, "").trim();
    const data = JSON.parse(rawText);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. Roleplay
app.post('/api/roleplay', async (req, res) => {
  const { scenario, history, userMessage } = req.body;
  
  // Input Validation
  if (userMessage && (typeof userMessage !== 'string' || userMessage.length > 500)) {
    return res.status(400).json({ error: 'Message must be a string under 500 characters.' });
  }
  // Mitigate prompt injection on structured scenario input
  if (scenario && !VALID_SCENARIOS.includes(scenario)) {
    return res.status(400).json({ error: 'Invalid scenario.' });
  }
  if (history && (!Array.isArray(history) || history.length > 100)) {
    return res.status(400).json({ error: 'History is invalid or too long.' });
  }

  const profile = await getProfile(1);
  const systemPrompt = prompts.getRoleplayPrompt(profile, scenario);
  
  try {
    let contents = history || [];
    if (userMessage) {
        contents.push({ role: "user", parts: [{ text: userMessage }] });
    } else {
        contents.push({ role: "user", parts: [{ text: "Start the scenario." }] });
    }

    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: contents,
      config: { systemInstruction: systemPrompt }
    });

    const reply = response.text;
    
    // Parse Correction and Save if exists
    if (userMessage && reply.includes('CORRECTION:')) {
      const correction = reply.split(/CORRECTION:/i)[1].trim();
      saveMistake(1, userMessage, correction);
    }

    // Update speaking minutes roughly (1 exchange = ~1 minute)
    if(userMessage) {
      db.run('UPDATE progress SET total_minutes = total_minutes + 1 WHERE user_id = 1');
    }

    res.json({ reply });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
