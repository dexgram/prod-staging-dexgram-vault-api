CREATE TABLE IF NOT EXISTS users (
  client_code TEXT PRIMARY KEY,
  bucket_id   TEXT NOT NULL,
  quota_gb    INTEGER NOT NULL,
  used_bytes  INTEGER NOT NULL DEFAULT 0,
  uploads_count   INTEGER NOT NULL DEFAULT 0,
  downloads_count INTEGER NOT NULL DEFAULT 0,
  subscription_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT
);

CREATE TABLE IF NOT EXISTS files (
  file_id     TEXT PRIMARY KEY,
  client_code TEXT NOT NULL,
  object_key  TEXT NOT NULL,
  size_bytes  INTEGER,
  mime_type   TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at  TEXT,
  FOREIGN KEY (client_code) REFERENCES users(client_code)
);

CREATE INDEX IF NOT EXISTS idx_files_client_active ON files(client_code, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_deleted ON files(client_code, deleted_at);
