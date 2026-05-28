const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const basicAuth = require('express-basic-auth');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { GoogleGenAI } = require('@google/genai');
const db = require('./database');
const prompts = require('./prompt_templates');

dotenv.config();

const app = express();

// Trust proxy for ngrok/reverse proxy setups
app.set('trust proxy', 1);

// --- Session middleware ---
app.use(session({
  secret: process.env.SESSION_SECRET || 'habla-diario-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

// --- CORS ---
const allowedOrigins = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',') : ['http://localhost:3000', 'http://localhost:8000', 'http://127.0.0.1:8000'];
app.use(cors({
  origin: function(origin, callback){
    if(!origin) return callback(null, true);
    if(allowedOrigins.indexOf(origin) === -1){
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// --- Rate limiting ---
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: 'Too many requests from this IP, please try again after a minute'
});
app.use(limiter);

// --- Auth middleware ---
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

function requireAdmin(req, res, next) {
  const users = {};
  users[process.env.APP_USER || 'admin'] = process.env.APP_PASSWORD || 'secret';
  const auth = basicAuth({ users, challenge: true, realm: 'Habla Diario Admin' });
  auth(req, res, next);
}

// --- Stripe config (Phase 3) ---
const STRIPE_ENABLED = !!process.env.STRIPE_SECRET_KEY;
const FREE_USER_LIMIT = parseInt(process.env.FREE_USER_LIMIT || '20');

// Check if free tier is full
function checkFreeTier(req, res, next) {
  if (req.session.userId && !req.session.isPaid && !req.session.isAdmin) {
    db.get('SELECT is_paid FROM users WHERE id = ?', [req.session.userId], (err, row) => {
      if (err) return next(err);
      if (!row || (!row.is_paid && STRIPE_ENABLED)) {
        db.get('SELECT COUNT(*) as cnt FROM users WHERE is_admin = 0', [], (err2, countRow) => {
          if (err2) return next(err2);
          if (!row || !row.is_paid) {
            req.userIsFree = true;
          }
          next();
        });
      } else {
        next();
      }
    });
  } else {
    next();
  }
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL_NAME = 'gemini-2.5-flash';

// ---- AUTH ROUTES ----

// Signup
app.post('/api/auth/signup', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required.' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  try {
    // Check if email already exists
    const existing = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    // Check free tier limit
    const userCount = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as cnt FROM users WHERE is_admin = 0', [], (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.cnt : 0);
      });
    });

    if (userCount >= FREE_USER_LIMIT && !req.session.isPaid) {
      return res.status(403).json({ error: `Free tier is limited to ${FREE_USER_LIMIT} users. Please contact the developer for access.` });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    
    const result = await new Promise((resolve, reject) => {
      db.run('INSERT INTO users (email, username, password_hash, created_at) VALUES (?, ?, ?, datetime("now"))',
        [email.toLowerCase(), email.split('@')[0], hashedPassword],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });

    // Create progress row for new user
    db.run('INSERT OR IGNORE INTO progress (user_id, total_minutes, drills_done, streak, last_active) VALUES (?, 0, 0, 0, date("now"))', [result]);

    req.session.userId = result;
    req.session.isPaid = false;
    req.session.isAdmin = false;

    res.json({ success: true, user: { id: result, email: email.toLowerCase(), username: email.split('@')[0] } });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required.' });
  }

  try {
    const user = await new Promise((resolve, reject) => {
      db.get('SELECT id, email, username, password_hash, is_admin, is_paid FROM users WHERE email = ?', [email.toLowerCase()], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    req.session.userId = user.id;
    req.session.isPaid = !!user.is_paid;
    req.session.isAdmin = !!user.is_admin;

    res.json({ success: true, user: { id: user.id, email: user.email, username: user.username } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed.' });
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// Check current session
app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) {
    return res.json({ authenticated: false });
  }
  db.get('SELECT id, email, username, is_admin, is_paid, created_at FROM users WHERE id = ?', [req.session.userId], (err, user) => {
    if (err || !user) {
      return res.json({ authenticated: false });
    }
    res.json({ authenticated: true, user: { id: user.id, email: user.email, username: user.username, isAdmin: !!user.is_admin, isPaid: !!user.is_paid } });
  });
});

// ---- API ROUTES (require auth) ----

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
app.get('/api/user/status', requireAuth, (req, res) => {
  const userId = req.session.userId;
  db.get('SELECT * FROM progress WHERE user_id = ?', [userId], (err, progress) => {
    if (err) return res.status(500).json({ error: err.message });
    getProfile(userId).then(profile => {
      res.json({ progress: progress || {}, profile: profile || {} });
    });
  });
});

app.post('/api/user/level', requireAuth, (req, res) => {
  const { level } = req.body;
  const userId = req.session.userId;
  if (!['A1', 'A2', 'B1', 'B2'].includes(level)) {
    return res.status(400).json({ error: 'Invalid level.' });
  }
  db.run(`INSERT OR REPLACE INTO assessment_profiles (user_id, level, strengths, weaknesses, last_assessed) 
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [userId, level, 'Manually Selected', 'Manually Selected'],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

// Get recent mistakes
app.get('/api/user/mistakes', requireAuth, (req, res) => {
  db.all('SELECT * FROM mistakes WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [req.session.userId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

// 2. Assessment
app.post('/api/assessment', requireAuth, async (req, res) => {
  let { history, userMessage } = req.body;
  const userId = req.session.userId;
  
  if (userMessage && (typeof userMessage !== 'string' || userMessage.length > 500)) {
    return res.status(400).json({ error: 'Message must be a string under 500 characters.' });
  }
  if (history && (!Array.isArray(history) || history.length > 20)) {
    return res.status(400).json({ error: 'History is invalid or too long.' });
  }

  const systemPrompt = prompts.getAssessmentPrompt();
  
  try {
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
    
    if (userMessage && reply.includes('CORRECTION:')) {
      const correction = reply.split(/CORRECTION:/i)[1].trim();
      saveMistake(userId, userMessage, correction);
    }

    if (reply.includes('{') && reply.includes('}')) {
      try {
        const jsonMatch = reply.match(/\{[\s\S]*\}/)[0];
        const profile = JSON.parse(jsonMatch);
        
        db.run(`INSERT OR REPLACE INTO assessment_profiles (user_id, level, strengths, weaknesses) 
                VALUES (?, ?, ?, ?)`, [userId, profile.level, profile.strengths, profile.weaknesses]);
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
app.post('/api/generate/drills', requireAuth, async (req, res) => {
  const { verb, tense, pattern } = req.body;
  const userId = req.session.userId;
  
  if (!VALID_VERBS.includes(verb) || !VALID_TENSES.includes(tense) || !VALID_PATTERNS.includes(pattern)) {
     return res.status(400).json({ error: 'Invalid selection. Please use the provided options.' });
  }

  const profile = await getProfile(userId);
  const systemPrompt = prompts.getDrillPrompt(profile, verb, tense, pattern);
  
  try {
    let rawText = await callGemini(systemPrompt, `Generate 6 drills for ${verb} in ${tense} using ${pattern} pattern.`);
    rawText = rawText.replace(/```json|```/g, "").trim();
    const data = JSON.parse(rawText);
    
    db.run('UPDATE progress SET drills_done = drills_done + 6 WHERE user_id = ?', [userId]);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. Generate Vocab
app.post('/api/generate/vocab', requireAuth, async (req, res) => {
  const { theme } = req.body;
  const userId = req.session.userId;
  
  if (!VALID_THEMES.includes(theme)) {
     return res.status(400).json({ error: 'Invalid theme selected.' });
  }

  const profile = await getProfile(userId);
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
app.post('/api/roleplay', requireAuth, async (req, res) => {
  const { scenario, history, userMessage } = req.body;
  const userId = req.session.userId;
  
  if (userMessage && (typeof userMessage !== 'string' || userMessage.length > 500)) {
    return res.status(400).json({ error: 'Message must be a string under 500 characters.' });
  }
  if (scenario && !VALID_SCENARIOS.includes(scenario)) {
    return res.status(400).json({ error: 'Invalid scenario.' });
  }
  if (history && (!Array.isArray(history) || history.length > 100)) {
    return res.status(400).json({ error: 'History is invalid or too long.' });
  }

  const profile = await getProfile(userId);
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
    
    if (userMessage && reply.includes('CORRECTION:')) {
      const correction = reply.split(/CORRECTION:/i)[1].trim();
      saveMistake(userId, userMessage, correction);
    }

    if(userMessage) {
      db.run('UPDATE progress SET total_minutes = total_minutes + 1 WHERE user_id = ?', [userId]);
    }

    res.json({ reply });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin routes (protected by basic auth)
app.get('/api/admin/users', requireAdmin, (req, res) => {
  db.all('SELECT id, email, username, is_paid, created_at FROM users ORDER BY created_at DESC', [], (err, users) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all('SELECT user_id, SUM(drills_done) as total_drills, SUM(total_minutes) as total_mins FROM progress GROUP BY user_id', [], (err2, progress) => {
      const progressMap = {};
      (progress || []).forEach(p => progressMap[p.user_id] = p);
      res.json({ users: users.map(u => ({ ...u, totalDrills: (progressMap[u.id] || {}).total_drills || 0, totalMinutes: (progressMap[u.id] || {}).total_mins || 0 })) });
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
