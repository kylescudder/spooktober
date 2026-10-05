package main

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf16"

	_ "github.com/mattn/go-sqlite3"
)

//go:embed migrations/001_films.sql
var schema string

//go:embed seed.json
var seedJSON []byte

type Film struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	Position  int     `json:"position"`
	Watched   bool    `json:"watched"`
	WatchedAt *string `json:"watchedAt"`
	UpdatedAt string  `json:"updatedAt"`
	CreatedAt string  `json:"createdAt,omitempty"`
}

type watchlist struct {
	Films []Film `json:"films"`
}

type filmError struct {
	status  int
	message string
}

func (e *filmError) Error() string { return e.message }

func invalid(status int, message string) error { return &filmError{status, message} }

func timestamp() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func validTitle(title string) bool {
	length := len(utf16.Encode([]rune(title)))
	return length >= 1 && length <= 200
}

func openDatabase(path string, importPath string) (*sql.DB, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(absolute), 0700); err != nil {
		return nil, err
	}
	// Precreate with private permissions; SQLite's journal inherits them.
	file, err := os.OpenFile(absolute, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := file.Close(); err != nil {
		return nil, err
	}
	dsn := (&url.URL{Scheme: "file", Path: absolute}).String() + "?_busy_timeout=5000&_foreign_keys=on&_txlock=immediate&_journal_mode=DELETE&_synchronous=FULL"
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := initializeDatabase(db, importPath); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

func initializeDatabase(db *sql.DB, importPath string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var version int
	if err := tx.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version > 1 {
		return errors.New("this database requires a newer Spooktober version")
	}
	if version == 0 {
		if _, err := tx.Exec(schema); err != nil {
			return err
		}
	}
	var count int
	if err := tx.QueryRow("SELECT COUNT(*) FROM films").Scan(&count); err != nil {
		return err
	}
	if importPath != "" && count > 0 {
		return errors.New("import requires an empty database; existing films were left unchanged")
	}
	// Seed only a new database. Existing empty databases stay empty on restart.
	if count == 0 && (version == 0 || importPath != "") {
		data := seedJSON
		if importPath != "" {
			if importPath == "-" {
				data, err = io.ReadAll(io.LimitReader(os.Stdin, 1024*1024+1))
			} else {
				data, err = os.ReadFile(importPath)
			}
			if err != nil {
				return fmt.Errorf("read watchlist import: %w", err)
			}
			if len(data) > 1024*1024 {
				return errors.New("watchlist import exceeds 1 MiB")
			}
		}
		var list watchlist
		if err := json.Unmarshal(data, &list); err != nil || list.Films == nil || len(list.Films) > 1000 {
			return errors.New("import must contain a films array with at most 1000 films")
		}
		seen := make(map[string]bool)
		for position, film := range list.Films {
			film.Title = strings.TrimSpace(film.Title)
			if film.ID == "" || len(film.ID) > 100 || seen[film.ID] || !validTitle(film.Title) {
				return errors.New("import contains an invalid or repeated film")
			}
			seen[film.ID] = true
			if !film.Watched && film.WatchedAt != nil {
				return errors.New("an unwatched film cannot have a watched date")
			}
			for _, date := range []*string{film.WatchedAt, &film.UpdatedAt, &film.CreatedAt} {
				if date != nil && *date != "" {
					if _, err := time.Parse(time.RFC3339Nano, *date); err != nil {
						return errors.New("import contains an invalid film timestamp")
					}
				}
			}
			if film.UpdatedAt == "" {
				film.UpdatedAt = timestamp()
			}
			if film.CreatedAt == "" {
				film.CreatedAt = film.UpdatedAt
			}
			if _, err := tx.Exec("INSERT INTO films (id,title,position,watched,watched_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)", film.ID, film.Title, position, film.Watched, film.WatchedAt, film.CreatedAt, film.UpdatedAt); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

type queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func listFilms(ctx context.Context, db queryer) ([]Film, error) {
	rows, err := db.QueryContext(ctx, "SELECT id,title,position,watched,watched_at,updated_at,created_at FROM films ORDER BY position,id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	films := []Film{}
	for rows.Next() {
		var film Film
		if err := rows.Scan(&film.ID, &film.Title, &film.Position, &film.Watched, &film.WatchedAt, &film.UpdatedAt, &film.CreatedAt); err != nil {
			return nil, err
		}
		films = append(films, film)
	}
	return films, rows.Err()
}

func changeFilms(ctx context.Context, db *sql.DB, change func(*sql.Tx) error) ([]Film, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := change(tx); err != nil {
		return nil, err
	}
	films, err := listFilms(ctx, tx)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return films, nil
}

func addFilm(ctx context.Context, db *sql.DB, id, title string) ([]Film, error) {
	return changeFilms(ctx, db, func(tx *sql.Tx) error {
		var existing string
		err := tx.QueryRowContext(ctx, "SELECT title FROM films WHERE id=?", id).Scan(&existing)
		if err == nil {
			if existing != title {
				return invalid(409, "This film identifier has already been used. Please refresh.")
			}
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		now := timestamp()
		_, err = tx.ExecContext(ctx, "INSERT INTO films (id,title,position,watched,created_at,updated_at) SELECT ?,?,COALESCE(MAX(position)+1,0),0,?,? FROM films", id, title, now, now)
		return err
	})
}

func markWatched(ctx context.Context, db *sql.DB, id string, watched bool) ([]Film, error) {
	return changeFilms(ctx, db, func(tx *sql.Tx) error {
		now := timestamp()
		result, err := tx.ExecContext(ctx, "UPDATE films SET watched_at=CASE WHEN ?=0 THEN NULL WHEN watched=0 THEN ? ELSE watched_at END,watched=?,updated_at=? WHERE id=?", watched, now, watched, now, id)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count == 0 {
			return invalid(404, "That film is no longer on the list. Please refresh.")
		}
		return nil
	})
}

func reorderFilms(ctx context.Context, db *sql.DB, requested []string) ([]Film, error) {
	return changeFilms(ctx, db, func(tx *sql.Tx) error {
		films, err := listFilms(ctx, tx)
		if err != nil {
			return err
		}
		known := make(map[string]bool, len(films))
		for _, film := range films {
			known[film.ID] = true
		}
		seen := make(map[string]bool, len(requested))
		ids := append([]string{}, requested...)
		for _, id := range requested {
			if !known[id] {
				return invalid(409, "The film list has changed. Refresh it and try again.")
			}
			seen[id] = true
		}
		for _, film := range films {
			if !seen[film.ID] {
				ids = append(ids, film.ID)
			}
		}
		now := timestamp()
		for position, id := range ids {
			if _, err := tx.ExecContext(ctx, "UPDATE films SET position=?,updated_at=? WHERE id=?", position, now, id); err != nil {
				return err
			}
		}
		return nil
	})
}

func exportFilms(db *sql.DB, destination string) error {
	films, err := listFilms(context.Background(), db)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(watchlist{Films: films}, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(destination), ".spooktober-export-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err := file.Write(append(data, '\n')); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), destination)
}
