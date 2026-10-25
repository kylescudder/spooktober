-- The pre-Drizzle schema (src/migrations 001 and 002 plus their history table),
-- used to test that the Drizzle baseline adopts existing databases.
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
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
INSERT INTO schema_migrations (version) VALUES (1);
-- The original watchlist belongs to the app's first season, even if this
-- migration is applied in a later year. New writes always supply their year.
ALTER TABLE films ADD COLUMN year INTEGER NOT NULL DEFAULT 2026
  CHECK (year BETWEEN 1900 AND 9999);
ALTER TABLE films ALTER COLUMN year DROP DEFAULT;
ALTER TABLE films DROP CONSTRAINT films_position_unique;
ALTER TABLE films ADD CONSTRAINT films_position_unique
  UNIQUE (year, position) DEFERRABLE INITIALLY DEFERRED;
INSERT INTO schema_migrations (version) VALUES (2);
