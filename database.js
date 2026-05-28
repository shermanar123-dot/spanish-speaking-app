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
        email TEXT UNIQUE,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        is_admin INTEGER DEFAULT 0,
        is_paid INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      // Safe migration: add columns if they don't exist
      db.run("ALTER TABLE users ADD COLUMN email TEXT", () => {});
      db.run("ALTER TABLE users ADD COLUMN password_hash TEXT", () => {});
      db.run("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0", () => {});
      db.run("ALTER TABLE users ADD COLUMN is_paid INTEGER DEFAULT 0", () => {});

      db.run(`CREATE TABLE IF NOT EXISTS assessment_profiles (
        user_id INTEGER PRIMARY KEY,
        level TEXT,
        strengths TEXT,
        weaknesses TEXT,
        last_assessed DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS progress (
        user_id INTEGER PRIMARY KEY,
        total_minutes INTEGER DEFAULT 0,
        drills_done INTEGER DEFAULT 0,
        streak INTEGER DEFAULT 0,
        last_active DATE,
        FOREIGN KEY (user_id) REFERENCES users (id)
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS mistakes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        original_text TEXT,
        correction TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
      )`);

      // Set demo user as admin if exists
      db.run("UPDATE users SET is_admin = 1, email = 'admin@habladiario.com' WHERE username = 'demo_user'");
      
      // Insert default admin user for MVP if no users exist
      db.get("SELECT COUNT(*) as cnt FROM users", [], (err, row) => {
        if (!err && row && row.cnt === 0) {
          db.run("INSERT INTO users (id, username, email, is_admin, is_paid) VALUES (1, 'demo_user', 'admin@habladiario.com', 1, 1)");
          db.run("INSERT OR IGNORE INTO progress (user_id, total_minutes, drills_done, streak, last_active) VALUES (1, 0, 0, 0, date('now'))");
        }
      });
    });
  }
});

module.exports = db;
