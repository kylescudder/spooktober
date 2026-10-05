CREATE TABLE IF NOT EXISTS films (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
  position INTEGER NOT NULL CHECK(position >= 0),
  watched INTEGER NOT NULL DEFAULT 0 CHECK(watched IN (0, 1)),
  watched_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
PRAGMA user_version = 1;
