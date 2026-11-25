-- SafePark pilot schema (D1 / SQLite)
CREATE TABLE IF NOT EXISTS owners (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  phone TEXT,
  telegram_chat_id TEXT,
  notify_email INTEGER DEFAULT 1,
  notify_push INTEGER DEFAULT 1,
  quiet_start INTEGER,            -- minutes from midnight local, NULL = off
  quiet_end INTEGER,
  unavailable INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cars (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  code TEXT UNIQUE NOT NULL,      -- public code embedded in the QR URL
  car_type TEXT NOT NULL,         -- e.g. "سيدان بيضاء"
  plate TEXT,                     -- full plate, never shown raw to senders
  plate_check INTEGER DEFAULT 0,  -- 1 = require last 3 plate digits (abuse mode)
  disabled INTEGER DEFAULT 0,     -- lost sticker
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  car_id TEXT NOT NULL REFERENCES cars(id),
  sender_key TEXT NOT NULL,       -- secret token the sender keeps (private reply link)
  sender_email TEXT,              -- optional reply notice, hidden from owner
  sender_ip TEXT,
  blocked INTEGER DEFAULT 0,
  reported INTEGER DEFAULT 0,
  report_reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_msg_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  direction TEXT NOT NULL,        -- 'in' = sender->owner, 'out' = owner->sender
  reason TEXT,
  body TEXT NOT NULL,
  photo_key TEXT,                 -- R2 object key, EXIF-stripped
  urgent INTEGER DEFAULT 0,
  held INTEGER DEFAULT 0,         -- notification held by quiet hours
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rate_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,             -- 'sender_hour' | 'car_day'
  bucket TEXT NOT NULL,           -- sender ip, or car id
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS captchas (
  id TEXT PRIMARY KEY,
  answer TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  endpoint TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_conv_car ON conversations(car_id);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_rate ON rate_events(kind, bucket, created_at);

CREATE TABLE IF NOT EXISTS photos (
  key TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
