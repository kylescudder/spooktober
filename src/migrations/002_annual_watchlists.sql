-- The original watchlist belongs to the app's first season, even if this
-- migration is applied in a later year. New writes always supply their year.
ALTER TABLE films ADD COLUMN year INTEGER NOT NULL DEFAULT 2026
  CHECK (year BETWEEN 1900 AND 9999);
ALTER TABLE films ALTER COLUMN year DROP DEFAULT;
ALTER TABLE films DROP CONSTRAINT films_position_unique;
ALTER TABLE films ADD CONSTRAINT films_position_unique
  UNIQUE (year, position) DEFERRABLE INITIALLY DEFERRED;
