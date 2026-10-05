package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

type configuration struct {
	username  string
	password  string
	publicURL string
}

type application struct {
	db         *sql.DB
	files      fs.FS
	config     configuration
	credential [32]byte
}

func newApplication(db *sql.DB, files fs.FS, config configuration) (*application, error) {
	if config.username == "" || config.password == "" || strings.Contains(config.username, ":") {
		return nil, errors.New("set BASIC_AUTH_USERNAME and BASIC_AUTH_PASSWORD; the username cannot contain a colon")
	}
	if config.password == "replace-with-a-long-random-password" {
		return nil, errors.New("replace the example Basic Auth password before starting")
	}
	config.publicURL = strings.TrimSuffix(config.publicURL, "/")
	if config.publicURL != "" {
		parsed, err := url.Parse(config.publicURL)
		if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
			return nil, errors.New("PUBLIC_URL must be the full origin, e.g. https://films.example.com")
		}
	}
	return &application{db: db, files: files, config: config, credential: sha256.Sum256([]byte(config.username + ":" + config.password))}, nil
}

func privateHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "same-origin")
	w.Header().Set("X-Frame-Options", "DENY")
}

func (app *application) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	privateHeaders(w)
	if r.URL.Path == "/healthz" && (r.Method == "GET" || r.Method == "HEAD") {
		if err := app.db.PingContext(r.Context()); err != nil {
			http.Error(w, "unavailable", 503)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		if r.Method == "GET" {
			io.WriteString(w, "ok\n")
		}
		return
	}
	username, password, ok := r.BasicAuth()
	actual := sha256.Sum256([]byte(username + ":" + password))
	if !ok || len(r.Header.Get("Authorization")) > 2048 || subtle.ConstantTimeCompare(actual[:], app.credential[:]) != 1 {
		w.Header().Set("WWW-Authenticate", `Basic realm="Spooktober", charset="UTF-8"`)
		http.Error(w, "Please sign in to Kyle & Rhiann’s Spooktober watchlist.", 401)
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" && r.Method != "OPTIONS" {
		origin := app.config.publicURL
		if origin == "" {
			scheme := "http"
			if r.TLS != nil {
				scheme = "https"
			}
			origin = scheme + "://" + r.Host
		}
		if (r.Header.Get("Origin") != "" && r.Header.Get("Origin") != origin) || r.Header.Get("Sec-Fetch-Site") == "cross-site" || r.Header.Get("X-Spooktober-Request") != "1" {
			writeJSON(w, 403, map[string]string{"error": "This request is not allowed. Please use the watchlist page."})
			return
		}
		contentType := strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0])
		if !strings.EqualFold(contentType, "application/json") {
			writeJSON(w, 415, map[string]string{"error": "Please send film changes as JSON."})
			return
		}
	}
	if r.URL.Path == "/api/films" || strings.HasPrefix(r.URL.Path, "/api/") {
		app.serveAPI(w, r)
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "Method not allowed", 405)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/")
	if path == "" {
		path = "index.html"
	}
	if !fs.ValidPath(path) || strings.Contains(path, "\\") {
		http.NotFound(w, r)
		return
	}
	// Open explicit files, so directories cannot disclose asset listings.
	file, err := app.files.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	seeker, ok := file.(io.ReadSeeker)
	if !ok {
		http.Error(w, "unavailable", 503)
		return
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), seeker)
}

var newID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func decodeChange(w http.ResponseWriter, r *http.Request, destination any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 16384)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(destination); err != nil {
		var oversized *http.MaxBytesError
		if errors.As(err, &oversized) {
			return invalid(413, "This film change is too large.")
		}
		return invalid(400, "Please send a valid film change.")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return invalid(400, "Please send one valid film change.")
	}
	return nil
}

func (app *application) serveAPI(w http.ResponseWriter, r *http.Request) {
	var films []Film
	var err error
	switch {
	case r.URL.Path == "/api/films" && (r.Method == "GET" || r.Method == "HEAD"):
		films, err = listFilms(r.Context(), app.db)
	case r.URL.Path == "/api/films" && r.Method == "POST":
		var change struct {
			ID    string `json:"id"`
			Title string `json:"title"`
		}
		if err = decodeChange(w, r, &change); err == nil {
			change.Title = strings.TrimSpace(change.Title)
			if !newID.MatchString(change.ID) {
				err = invalid(400, "Please send a valid new film identifier.")
			} else if !validTitle(change.Title) {
				err = invalid(400, "Enter a film title between 1 and 200 characters.")
			} else {
				films, err = addFilm(r.Context(), app.db, change.ID, change.Title)
			}
		}
	case r.URL.Path == "/api/films/order" && r.Method == "PUT":
		var change struct {
			IDs []string `json:"ids"`
		}
		if err = decodeChange(w, r, &change); err == nil {
			if len(change.IDs) < 1 || len(change.IDs) > 1000 {
				err = invalid(400, "Please send a valid film order.")
			} else {
				seen := make(map[string]bool)
				for _, id := range change.IDs {
					if id == "" || len(id) > 100 || seen[id] {
						err = invalid(400, "Each film must appear once in the order.")
						break
					}
					seen[id] = true
				}
				if err == nil {
					films, err = reorderFilms(r.Context(), app.db, change.IDs)
				}
			}
		}
	case strings.HasPrefix(r.URL.Path, "/api/films/") && r.URL.Path != "/api/films/order" && r.Method == "PATCH":
		id := strings.TrimPrefix(r.URL.Path, "/api/films/")
		var change struct {
			Watched *bool `json:"watched"`
		}
		if err = decodeChange(w, r, &change); err == nil {
			if id == "" || len(id) > 100 || strings.Contains(id, "/") {
				err = invalid(404, "That film is no longer on the list. Please refresh.")
			} else if change.Watched == nil {
				err = invalid(400, "Watched must be true or false.")
			} else {
				films, err = markWatched(r.Context(), app.db, id, *change.Watched)
			}
		}
	default:
		writeJSON(w, 404, map[string]string{"error": "This watchlist route does not exist."})
		return
	}
	if err != nil {
		var clientError *filmError
		if errors.As(err, &clientError) {
			writeJSON(w, clientError.status, map[string]string{"error": clientError.message})
		} else {
			log.Printf("watchlist storage error: %v", err)
			writeJSON(w, 503, map[string]string{"error": "The watchlist is temporarily unavailable. Please try again."})
		}
		return
	}
	if r.Method == "HEAD" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(200)
		return
	}
	writeJSON(w, 200, watchlist{Films: films})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value)
}
