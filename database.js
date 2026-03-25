const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'app.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database', err.message);
  } else {
    console.log('Connected to the SQLite database.');
    db.serialize(() => {
      // Create Users table
      db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      // Create Assessment Profiles table
      db.run(`CREATE TABLE IF NOT EXISTS assessment_profiles (
        user_id INTEGER PRIMARY KEY,
        level TEXT,
        strengths TEXT,
        weaknesses TEXT,
        last_assessed DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
      )`);

      // Create Progress table
      db.run(`CREATE TABLE IF NOT EXISTS progress (
        user_id INTEGER PRIMARY KEY,
        total_minutes INTEGER DEFAULT 0,
        drills_done INTEGER DEFAULT 0,
        streak INTEGER DEFAULT 0,
        last_active DATE,
        FOREIGN KEY (user_id) REFERENCES users (id)
      )`);

      // Create Mistakes table for Spaced Repetition (Issue: Fluency Vault)
      db.run(`CREATE TABLE IF NOT EXISTS mistakes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        original_text TEXT,
        correction TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
      )`);

      // Insert default user for MVP
      db.run(`INSERT OR IGNORE INTO users (id, username) VALUES (1, 'demo_user')`);
      db.run(`INSERT OR IGNORE INTO progress (user_id, total_minutes, drills_done, streak, last_active) VALUES (1, 0, 0, 0, date('now'))`);
    });
  }
});

module.exports = db;
