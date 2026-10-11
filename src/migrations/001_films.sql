CREATE TABLE films (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 100),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
  position INTEGER NOT NULL CHECK(position >= 0),
  watched BOOLEAN NOT NULL DEFAULT false,
  -- RFC3339 UTC text preserves nanoseconds in exports from the existing watchlist.
  watched_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT films_watched_date CHECK(watched OR watched_at IS NULL),
  CONSTRAINT films_position_unique UNIQUE(position) DEFERRABLE INITIALLY DEFERRED
);
