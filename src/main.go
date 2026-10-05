package main

import (
	"context"
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

//go:embed all:web
var webFiles embed.FS

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	addr := flag.String("addr", envOr("ADDR", "127.0.0.1:8080"), "HTTP listen address")
	databasePath := flag.String("db", envOr("DATABASE_PATH", "data/spooktober.sqlite"), "SQLite file")
	importPath := flag.String("import", "", "import a watchlist JSON file into an empty database; use - for stdin")
	exportPath := flag.String("export", "", "export the watchlist to JSON and exit")
	initializeOnly := flag.Bool("init", false, "initialize or import the database and exit")
	healthcheck := flag.Bool("healthcheck", false, "check the running HTTP server and exit")
	flag.Parse()
	if *healthcheck {
		_, port, err := net.SplitHostPort(*addr)
		if err != nil {
			return err
		}
		client := http.Client{Timeout: 3 * time.Second}
		response, err := client.Get("http://127.0.0.1:" + port + "/healthz")
		if err != nil {
			return err
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			return fmt.Errorf("healthcheck failed: %d", response.StatusCode)
		}
		return nil
	}
	db, err := openDatabase(*databasePath, *importPath)
	if err != nil {
		return err
	}
	defer db.Close()
	if *exportPath != "" {
		return exportFilms(db, *exportPath)
	}
	if *initializeOnly {
		return nil
	}
	files, err := fs.Sub(webFiles, "web/dist")
	if err != nil {
		return err
	}
	if _, err := fs.Stat(files, "index.html"); err != nil {
		return fmt.Errorf("build the frontend before compiling the server: %w", err)
	}
	app, err := newApplication(db, files, configuration{
		username:  os.Getenv("BASIC_AUTH_USERNAME"),
		password:  os.Getenv("BASIC_AUTH_PASSWORD"),
		publicURL: os.Getenv("PUBLIC_URL"),
	})
	if err != nil {
		return err
	}
	server := &http.Server{
		Addr: *addr, Handler: app,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		server.Shutdown(shutdown)
	}()
	log.Printf("Spooktober listening on %s; database: %s", *addr, *databasePath)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	<-shutdownDone
	return nil
}
