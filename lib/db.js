import Database from 'better-sqlite3';
const db = globalThis.__db ??= new Database(process.env.NOISY_DB || '/opt/noisy/data/panel.db');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pw TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user', ingest_key TEXT UNIQUE NOT NULL, quota_mb INTEGER NOT NULL DEFAULT 0,
  used_in INTEGER NOT NULL DEFAULT 0, used_out INTEGER NOT NULL DEFAULT 0,
  bitrate_kbps INTEGER NOT NULL DEFAULT 4500, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, user TEXT, event TEXT NOT NULL, detail TEXT);`);
try { db.exec('ALTER TABLE users ADD COLUMN reencode INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN publishing INTEGER NOT NULL DEFAULT 0'); } catch {}
db.exec(`CREATE TABLE IF NOT EXISTS destinations(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL,
  key_enc TEXT NOT NULL, key_hint TEXT NOT NULL, want INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  last_in INTEGER NOT NULL DEFAULT 0, last_out INTEGER NOT NULL DEFAULT 0)`);
export const log = (user, event, detail = '') =>
  db.prepare('INSERT INTO logs(ts,user,event,detail) VALUES(?,?,?,?)').run(Date.now(), String(user ?? '').slice(0, 64), event, String(detail).slice(0, 200));
export default db;
