CREATE TABLE IF NOT EXISTS canonical_backend (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  active_generation TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  activated_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS canonical_records (
  generation TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  expiration INTEGER,
  metadata TEXT,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (generation, key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS canonical_write_guard (
  token TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  ok INTEGER NOT NULL CHECK (ok = 1),
  PRIMARY KEY (token, sequence)
) WITHOUT ROWID;
