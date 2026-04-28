/**
 * SQLite schema for the ValidatorShift hub.
 *
 * CRITICAL INVARIANT (architecture section 3): this database NEVER stores
 * private keys, keypairs, secrets, or signed transaction payloads. It is a
 * pure coordination/audit store: sessions, audit log, migration step status.
 * Do not add columns named `keypair`, `secret`, `private_key`, or `payload`.
 */
import Database from 'better-sqlite3'

/**
 * Open (or create) a SQLite database at `path`, configure pragmas, and
 * idempotently create the schema. Safe to call multiple times.
 */
export function initDb(path: string): Database.Database {
  const db = new Database(path)

  // Pragmas: WAL for concurrent reads, FK enforcement, NORMAL fsync (WAL-safe).
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')

  db.exec(SCHEMA_SQL)

  return db
}

/**
 * Idempotent DDL. NO PRIVATE KEYS — only coordination metadata and audit logs.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  state        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_code  ON sessions(code);
CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions(state);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  level      TEXT NOT NULL,
  agent      TEXT NOT NULL,
  message    TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_audit_log_session_ts
  ON audit_log(session_id, ts);

CREATE TABLE IF NOT EXISTS migration_steps (
  session_id  TEXT    NOT NULL,
  step_number INTEGER NOT NULL,
  status      TEXT    NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER,
  error       TEXT,
  PRIMARY KEY (session_id, step_number),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
`
