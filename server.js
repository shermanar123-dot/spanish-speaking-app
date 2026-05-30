const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const rateLimit = require('express-rate-limit');
const basicAuth = require('express-basic-auth');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { GoogleGenAI } = require('@google/genai');
const { Resend } = require('resend');
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

// Initialize Resend (optional — falls back gracefully if no key set)
function getResend() {
  if (process.env.RESEND_API_KEY) {
    try {
      return new Resend(process.env.RESEND_API_KEY);
    } catch(e) {
      console.warn('Resend init failed:', e.message);
    }
  }
  return null;
}

// ---- AUTH ROUTES ---- //

// Generate a 6-digit verification code
function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Helper: send verification email
async function sendVerificationEmail(email, code) {
  const resend = getResend();
  if (!resend) {
    console.log(`\n📧 NO RESEND KEY — verification code for ${email}: ${code}\n`);
    return true; // pretend success for development
  }
  try {
    await resend.emails.send({
      from: 'Habla Diario <verify@habladiario.app>',
      to: email,
      subject: 'Your Habla Diario verification code',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;">
          <h2 style="color:#58CC02;">Habla Diario</h2>
          <p style="font-size:16px;color:#333;">Your verification code is:</p>
          <div style="font-size:36px;font-weight:bold;color:#58CC02;letter-spacing:8px;text-align:center;padding:24px;background:#f0fdf0;border-radius:12px;margin:16px 0;">
            ${code}
          </div>
          <p style="font-size:14px;color:#888;">This code expires in 10 minutes.</p>
          <p style="font-size:14px;color:#888;">If you didn't create an account, you can ignore this email.</p>
        </div>
      `
    });
    return true;
  } catch (err) {
    console.error('Failed to send verification email:', err);
    return false;
  }
}

// Step 1: Signup — register pending user, send verification code
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
    // Check if email already exists AND verified
    const existing = await new Promise((resolve, reject) => {
      db.get('SELECT id, email_verified FROM users WHERE email = ?', [email.toLowerCase()], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (existing && existing.email_verified) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    // Check free tier limit
    const userCount = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as cnt FROM users WHERE is_admin = 0 AND email_verified = 1', [], (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.cnt : 0);
      });
    });

    if (userCount >= FREE_USER_LIMIT && !req.session.isPaid) {
      return res.status(403).json({ error: `Free tier is limited to ${FREE_USER_LIMIT} users.` });
    }

    // If existing unverified user, reuse; otherwise create placeholder
    let userId;
    const hashedPassword = await bcrypt.hash(password, 10);
    const username = email.split('@')[0];

    if (existing && !existing.email_verified) {
      userId = existing.id;
      // Update their password hash in case they changed it
      await new Promise((resolve, reject) => {
        db.run('UPDATE users SET password_hash = ?, username = ? WHERE id = ?', [hashedPassword, username, userId], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } else {
      userId = await new Promise((resolve, reject) => {
        db.run('INSERT INTO users (email, username, password_hash, email_verified, created_at) VALUES (?, ?, ?, 0, datetime("now"))',
          [email.toLowerCase(), username, hashedPassword],
          function(err) {
            if (err) reject(err);
            else resolve(this.lastID);
          }
        );
      });
      // Create progress row
      db.run('INSERT OR IGNORE INTO progress (user_id, total_minutes, drills_done, streak, last_active) VALUES (?, 0, 0, 0, date("now"))', [userId]);
    }

    // Generate and store verification code
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    // Delete any old codes for this email
    db.run('DELETE FROM verification_codes WHERE email = ?', [email.toLowerCase()]);

    await new Promise((resolve, reject) => {
      db.run('INSERT INTO verification_codes (email, code, password_hash, username, expires_at) VALUES (?, ?, ?, ?, ?)',
        [email.toLowerCase(), code, hashedPassword, username, expiresAt],
        function(err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    // Send the email
    await sendVerificationEmail(email, code);

    res.json({
      success: true,
      message: 'Verification code sent to your email.',
      email: email.toLowerCase()
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

// Step 2: Verify the code
app.post('/api/auth/verify-code', async (req, res) => {
  const { email, code } = req.body;

  if (!email || !code) {
    return res.status(400).json({ error: 'Email and code are required.' });
  }

  try {
    const row = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM verification_codes
         WHERE email = ? AND code = ? AND used = 0 AND expires_at > datetime('now')
         ORDER BY created_at DESC LIMIT 1`,
        [email.toLowerCase(), code],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!row) {
      return res.status(400).json({ error: 'Invalid or expired verification code.' });
    }

    // Mark code as used
    db.run('UPDATE verification_codes SET used = 1 WHERE id = ?', [row.id]);

    // Activate the user account
    const user = await new Promise((resolve, reject) => {
      db.get('SELECT id, email, username, is_admin, is_paid FROM users WHERE email = ?', [email.toLowerCase()], (err, user) => {
        if (err) reject(err);
        else resolve(user);
      });
    });

    if (!user) {
      return res.status(500).json({ error: 'User not found.' });
    }

    db.run('UPDATE users SET email_verified = 1 WHERE id = ?', [user.id]);

    // Log them in
    req.session.userId = user.id;
    req.session.isPaid = !!user.is_paid;
    req.session.isAdmin = !!user.is_admin;

    res.json({
      success: true,
      user: { id: user.id, email: user.email, username: user.username, isAdmin: !!user.is_admin, isPaid: !!user.is_paid }
    });
  } catch (err) {
    console.error('Verify code error:', err);
    res.status(500).json({ error: 'Verification failed.' });
  }
});

// Resend verification code
app.post('/api/auth/resend-code', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  try {
    // Check the user exists and is unverified
    const user = await new Promise((resolve, reject) => {
      db.get('SELECT id, email_verified FROM users WHERE email = ?', [email.toLowerCase()], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!user) return res.status(400).json({ error: 'No account found with this email.' });
    if (user.email_verified) return res.status(400).json({ error: 'This email is already verified. Please log in.' });

    // Get the pending code info
    const pending = await new Promise((resolve, reject) => {
      db.get(
        'SELECT password_hash, username FROM verification_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1',
        [email.toLowerCase()],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    const code = generateCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    db.run('DELETE FROM verification_codes WHERE email = ?', [email.toLowerCase()]);

    await new Promise((resolve, reject) => {
      db.run('INSERT INTO verification_codes (email, code, password_hash, username, expires_at) VALUES (?, ?, ?, ?, ?)',
        [email.toLowerCase(), code, pending ? pending.password_hash : '', pending ? pending.username : '', expiresAt],
        function(err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    await sendVerificationEmail(email, code);
    res.json({ success: true, message: 'New verification code sent.' });
  } catch (err) {
    console.error('Resend code error:', err);
    res.status(500).json({ error: 'Failed to resend code.' });
  }
});

// Login — checks email is verified

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

    // Check if email is verified
    if (!user.email_verified) {
      return res.status(403).json({
        error: 'Please verify your email first.',
        needsVerification: true,
        email: user.email
      });
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

// Admin: delete user by email
app.post('/api/admin/delete-user', requireAuth, async (req, res) => {
  try {
    // Check if requester is admin
    const adminUser = await new Promise((resolve, reject) => {
      db.get('SELECT is_admin FROM users WHERE id = ?', [req.session.userId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    if (!adminUser || !adminUser.is_admin) {
      return res.status(403).json({ error: 'Admin access required.' });
    }

    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const emailLower = email.toLowerCase();
    const user = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM users WHERE email = ?', [emailLower], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!user) return res.status(404).json({ error: 'User not found.' });

    // Delete related records
    db.run('DELETE FROM progress WHERE user_id = ?', [user.id]);
    db.run('DELETE FROM mistakes WHERE user_id = ?', [user.id]);
    db.run('DELETE FROM assessment_profiles WHERE user_id = ?', [user.id]);
    db.run('DELETE FROM reset_tokens WHERE user_id = ?', [user.id]);
    db.run('DELETE FROM verification_codes WHERE email = ?', [emailLower]);
    db.run('DELETE FROM users WHERE id = ?', [user.id]);

    res.json({ success: true, message: `User ${emailLower} deleted.` });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: 'Failed to delete user.' });
  }
});

// Bootstrap: make current user an admin (only works if no admin exists)
app.post('/api/admin/bootstrap', requireAuth, async (req, res) => {
  try {
    const adminCount = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) as cnt FROM users WHERE is_admin = 1', [], (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.cnt : 0);
      });
    });
    if (adminCount > 0) {
      return res.status(403).json({ error: 'Admin already exists.' });
    }
    db.run('UPDATE users SET is_admin = 1, is_paid = 1 WHERE id = ?', [req.session.userId]);
    req.session.isAdmin = true;
    req.session.isPaid = true;
    res.json({ success: true, message: 'You are now admin.' });
  } catch (err) {
    console.error('Bootstrap error:', err);
    res.status(500).json({ error: 'Failed to bootstrap admin.' });
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

// ---- PASSWORD RESET (no email service — shows link on screen) ---- //
const crypto = require('crypto');

// Forgot password: generates a reset token for the given email
app.post('/api/auth/forgot-password', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  // Always return success to prevent email enumeration
  db.get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()], (err, user) => {
    if (err || !user) {
      return res.json({ success: true, message: 'If that email exists, a reset link has been generated.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    db.run('INSERT INTO reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
      [user.id, token, expiresAt],
      function(insertErr) {
        if (insertErr) {
          console.error('Token insert error:', insertErr);
          return res.json({ success: true, message: 'If that email exists, a reset link has been generated.' });
        }

        // For MVP: return the reset link directly (no email service yet)
        const resetLink = `${req.protocol}://${req.get('host')}/reset-password?token=${token}`;
        console.log('🔑 Reset link for', email, ':', resetLink);

        res.json({
          success: true,
          token: token, // Return token so the client can show the reset form
          message: 'Reset link generated. Click below to reset your password.'
        });
      }
    );
  });
});

// Verify reset token is valid
app.get('/api/auth/verify-reset-token', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ valid: false });

  db.get(
    `SELECT user_id FROM reset_tokens
     WHERE token = ? AND used = 0 AND expires_at > datetime('now')`,
    [token],
    (err, row) => {
      if (err || !row) return res.json({ valid: false });
      res.json({ valid: true });
    }
  );
});

// Reset password using a valid token
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password are required.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  try {
    const row = await new Promise((resolve, reject) => {
      db.get(
        `SELECT user_id FROM reset_tokens
         WHERE token = ? AND used = 0 AND expires_at > datetime('now')`,
        [token],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!row) return res.status(400).json({ error: 'Invalid or expired reset token.' });

    const hashedPassword = await bcrypt.hash(password, 10);

    // Update password and mark token as used
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashedPassword, row.user_id]);
    db.run('UPDATE reset_tokens SET used = 1 WHERE token = ?', [token]);

    res.json({ success: true, message: 'Password has been reset. Please log in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password.' });
  }
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

// ---- TTS (Text-to-Speech) using OpenAI ---- //
// In-memory LRU cache: maps text to base64 audio
const ttsCache = new Map();
const TTS_CACHE_MAX = 100;

app.post('/api/tts', requireAuth, async (req, res) => {
  const { text, voice: voiceOpt } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Text is required.' });
  }
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    return res.json({ fallback: true });
  }

  const cleaned = text.split("CORRECTION:")[0].trim();
  if (!cleaned) return res.json({ fallback: true });

  const voice = voiceOpt || 'nova'; // 'nova' is the best OpenAI voice for Spanish
  const cacheKey = `${voice}:${cleaned}`;

  // Check cache
  if (ttsCache.has(cacheKey)) {
    const cached = ttsCache.get(cacheKey);
    // Move to end (LRU)
    ttsCache.delete(cacheKey);
    ttsCache.set(cacheKey, cached);
    res.set({ 'Content-Type': 'audio/mpeg', 'Content-Length': cached.length });
    return res.send(Buffer.from(cached));
  }

  try {
    // Use tts-1 (faster) over tts-1-hd — speed matters more for real-time playback
    const resp = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: cleaned,
        voice: voice,
        response_format: 'mp3',
        speed: 0.95,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('OpenAI TTS error:', resp.status, errText);
      return res.json({ fallback: true });
    }
    const audioBuffer = await resp.arrayBuffer();
    const buf = Buffer.from(audioBuffer);

    // Cache it
    if (ttsCache.size >= TTS_CACHE_MAX) {
      const firstKey = ttsCache.keys().next().value;
      ttsCache.delete(firstKey);
    }
    ttsCache.set(cacheKey, buf);

    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': buf.length,
    });
    res.send(buf);
  } catch (err) {
    console.error('TTS error:', err);
    res.json({ fallback: true });
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
