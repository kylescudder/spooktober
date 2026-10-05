package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
)

const testPassword = "test-only-credentials"

func testApplication(t *testing.T, publicURL string) *application {
	t.Helper()
	db, err := openDatabase(filepath.Join(t.TempDir(), "films.sqlite"), "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	app, err := newApplication(db, fstest.MapFS{
		"index.html":    &fstest.MapFile{Data: []byte("<h1>Spooktober</h1>")},
		"assets/app.js": &fstest.MapFile{Data: []byte("console.log('app')")},
	}, configuration{username: "spooktober", password: testPassword, publicURL: publicURL})
	if err != nil {
		t.Fatal(err)
	}
	return app
}

func request(app *application, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://localhost"+path, strings.NewReader(body))
	r.SetBasicAuth("spooktober", testPassword)
	if method != "GET" && method != "HEAD" {
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Spooktober-Request", "1")
		r.Header.Set("Origin", "http://localhost")
	}
	w := httptest.NewRecorder()
	app.ServeHTTP(w, r)
	return w
}

func responseFilms(t *testing.T, response *httptest.ResponseRecorder) []Film {
	t.Helper()
	if response.Code != 200 {
		t.Fatalf("unexpected response %d: %s", response.Code, response.Body.String())
	}
	var list watchlist
	if err := json.Unmarshal(response.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	return list.Films
}

func TestAuthenticationAndPrivateAssets(t *testing.T) {
	app := testApplication(t, "")
	for _, path := range []string{"/", "/api/films", "/assets/app.js", "/.env", "/data/films.sqlite"} {
		r := httptest.NewRequest("GET", path, nil)
		w := httptest.NewRecorder()
		app.ServeHTTP(w, r)
		if w.Code != 401 || !strings.HasPrefix(w.Header().Get("WWW-Authenticate"), "Basic ") {
			t.Fatalf("%s did not challenge anonymous access", path)
		}
		r.SetBasicAuth("spooktober", "wrong")
		w = httptest.NewRecorder()
		app.ServeHTTP(w, r)
		if w.Code != 401 {
			t.Fatal("wrong credentials accepted")
		}
	}
	for _, path := range []string{"/", "/assets/app.js"} {
		w := request(app, "GET", path, "")
		if w.Code != 200 || w.Header().Get("Cache-Control") != "private, no-store" {
			t.Fatalf("unexpected authorized static response: %d", w.Code)
		}
	}
	for _, path := range []string{"/assets/", "/../data/films.sqlite", "/.env", "/data/films.sqlite"} {
		if request(app, "GET", path, "").Code != 404 {
			t.Fatalf("unexpected file exposed at %s", path)
		}
	}
	for _, config := range []configuration{{}, {username: "name", password: "replace-with-a-long-random-password"}, {username: "bad:name", password: "password"}, {username: "name", password: "password", publicURL: "https://example.com/path"}} {
		if _, err := newApplication(app.db, app.files, config); err == nil {
			t.Fatal("invalid authentication or origin configuration accepted")
		}
	}
}

func TestCSRFAndJSONValidation(t *testing.T) {
	app := testApplication(t, "")
	for _, headers := range []map[string]string{
		{"Origin": "https://evil.example"},
		{"Sec-Fetch-Site": "cross-site"},
		{"X-Spooktober-Request": ""},
		{"Content-Type": "text/plain"},
		{"Content-Type": "application/json-evil"},
	} {
		r := httptest.NewRequest("PATCH", "http://localhost/api/films/film-01", strings.NewReader(`{"watched":true}`))
		r.SetBasicAuth("spooktober", testPassword)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Spooktober-Request", "1")
		r.Header.Set("Origin", "http://localhost")
		for name, value := range headers {
			r.Header.Set(name, value)
		}
		w := httptest.NewRecorder()
		app.ServeHTTP(w, r)
		if w.Code != 403 && w.Code != 415 {
			t.Fatalf("unsafe write accepted: %d", w.Code)
		}
	}
	cases := []struct {
		method, path, body string
		status             int
	}{
		{"PATCH", "/api/films/film-01", `{"watched":"true"}`, 400},
		{"PATCH", "/api/films/film-01", `{"watched":null}`, 400},
		{"PATCH", "/api/films/film-01", `null`, 400},
		{"PATCH", "/api/films/film-01", `{"watched":true}{"watched":false}`, 400},
		{"PATCH", "/api/films/missing", `{"watched":true}`, 404},
		{"PUT", "/api/films/order", `{"ids":["film-01","film-01"]}`, 400},
		{"PUT", "/api/films/order", `{"ids":["unknown"]}`, 409},
		{"PUT", "/api/films/order", `{"ids":[]}`, 400},
		{"POST", "/api/films", `{"id":"bad","title":"The Thing"}`, 400},
		{"POST", "/api/films", `{"id":"00000000-0000-4000-8000-000000000001","title":" "}`, 400},
		{"POST", "/api/films", `{"id":"00000000-0000-4000-8000-000000000001","title":"` + strings.Repeat("a", 20000) + `"}`, 413},
	}
	for _, test := range cases {
		if status := request(app, test.method, test.path, test.body).Code; status != test.status {
			t.Fatalf("%s %s: got %d, want %d", test.method, test.path, status, test.status)
		}
	}
	films := responseFilms(t, request(app, "GET", "/api/films", ""))
	if films[0].Watched || len(films) != 20 {
		t.Fatal("invalid writes changed film data")
	}
}

func TestHTTPSProxyOrigin(t *testing.T) {
	app := testApplication(t, "https://films.example.com")
	r := httptest.NewRequest("PATCH", "http://localhost/api/films/film-01", strings.NewReader(`{"watched":true}`))
	r.SetBasicAuth("spooktober", testPassword)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Spooktober-Request", "1")
	r.Header.Set("Origin", "https://films.example.com")
	w := httptest.NewRecorder()
	app.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("legitimate reverse proxy request failed: %d", w.Code)
	}
	r.Body = io.NopCloser(strings.NewReader(`{"watched":false}`))
	r.Header.Set("Origin", "https://evil.example")
	r.Header.Set("X-Forwarded-Host", "evil.example")
	r.Header.Set("X-Forwarded-Proto", "https")
	w = httptest.NewRecorder()
	app.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("forwarded headers bypassed configured origin")
	}
}

func TestFilmChangesAndStaleOrder(t *testing.T) {
	app := testApplication(t, "")
	films := responseFilms(t, request(app, "GET", "/api/films", ""))
	if len(films) != 20 || films[0].Title != "Terrifier" {
		t.Fatal("original seed lost")
	}
	for i, film := range films {
		if film.Watched != (i == 5 || i == 14 || i == 16) || film.WatchedAt != nil {
			t.Fatal("initial watched flags or dates changed")
		}
	}
	films = responseFilms(t, request(app, "PATCH", "/api/films/film-06", `{"watched":true}`))
	if films[5].WatchedAt != nil {
		t.Fatal("repeated watched save invented an imported viewing date")
	}
	films = responseFilms(t, request(app, "PATCH", "/api/films/film-01", `{"watched":true}`))
	if !films[0].Watched || films[0].WatchedAt == nil {
		t.Fatal("watched status did not save")
	}
	date := *films[0].WatchedAt
	films = responseFilms(t, request(app, "PATCH", "/api/films/film-01", `{"watched":true}`))
	if *films[0].WatchedAt != date {
		t.Fatal("idempotent save changed the watched date")
	}
	body := `{"id":"00000000-0000-4000-8000-000000000001","title":"The Thing"}`
	responseFilms(t, request(app, "POST", "/api/films", body))
	films = responseFilms(t, request(app, "POST", "/api/films", body))
	if len(films) != 21 {
		t.Fatal("retry duplicated an added film")
	}
	if request(app, "POST", "/api/films", strings.Replace(body, "The Thing", "Alien", 1)).Code != 409 {
		t.Fatal("conflicting identifier silently replaced a film")
	}
	films = responseFilms(t, request(app, "PUT", "/api/films/order", `{"ids":["film-02","film-01"]}`))
	if films[0].ID != "film-02" || !films[1].Watched || films[len(films)-1].Title != "The Thing" {
		t.Fatal("reordering lost a watched flag or a concurrently added film")
	}
	films = responseFilms(t, request(app, "PATCH", "/api/films/film-01", `{"watched":false}`))
	if films[1].Watched || films[1].WatchedAt != nil {
		t.Fatal("unwatching did not clear the viewing date")
	}
}

func TestRestartExportAndImport(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "films.sqlite")
	db, err := openDatabase(path, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := markWatched(context.Background(), db, "film-01", true); err != nil {
		t.Fatal(err)
	}
	if _, err := reorderFilms(context.Background(), db, []string{"film-02", "film-01"}); err != nil {
		t.Fatal(err)
	}
	db.Close()
	db, err = openDatabase(path, "")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	films, err := listFilms(context.Background(), db)
	if err != nil || films[0].ID != "film-02" || !films[1].Watched {
		t.Fatal("restart lost saved data")
	}
	export := filepath.Join(directory, "backup.json")
	if err := exportFilms(db, export); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(export)
	if info.Mode().Perm() != 0600 {
		t.Fatal("export file is not private")
	}
	copy, err := openDatabase(filepath.Join(directory, "import.sqlite"), export)
	if err != nil {
		t.Fatal(err)
	}
	defer copy.Close()
	imported, err := listFilms(context.Background(), copy)
	if err != nil || imported[0].ID != films[0].ID || *imported[1].WatchedAt != *films[1].WatchedAt || imported[1].CreatedAt != films[1].CreatedAt {
		t.Fatal("export and import changed film state")
	}
	if other, err := openDatabase(path, export); err == nil {
		other.Close()
		t.Fatal("import overwrote an existing database")
	}
	broken := filepath.Join(directory, "broken.json")
	os.WriteFile(broken, []byte(`{"films":[{"id":"film-a","title":"Valid"},{"id":"film-a","title":"Duplicate"}]}`), 0600)
	if other, err := openDatabase(filepath.Join(directory, "rollback.sqlite"), broken); err == nil {
		other.Close()
		t.Fatal("invalid import succeeded")
	}
	clean, err := openDatabase(filepath.Join(directory, "rollback.sqlite"), "")
	if err != nil {
		t.Fatal(err)
	}
	defer clean.Close()
	rows, err := listFilms(context.Background(), clean)
	if err != nil || len(rows) != 20 || rows[0].ID != "film-01" {
		t.Fatal("failed import left a partial database")
	}
}

func TestConcurrentAddsKeepUniquePositions(t *testing.T) {
	app := testApplication(t, "")
	var group sync.WaitGroup
	for i := 0; i < 12; i++ {
		group.Add(1)
		go func(i int) {
			defer group.Done()
			body := fmt.Sprintf(`{"id":"00000000-0000-4000-8000-%012d","title":"Film %d"}`, i+1, i)
			if status := request(app, "POST", "/api/films", body).Code; status != http.StatusOK {
				t.Errorf("concurrent save failed: %d", status)
			}
		}(i)
	}
	group.Wait()
	films := responseFilms(t, request(app, "GET", "/api/films", ""))
	if len(films) != 32 {
		t.Fatal("concurrent adds lost a film")
	}
	for position, film := range films {
		if film.Position != position {
			t.Fatal("concurrent adds produced duplicate positions")
		}
	}
}
