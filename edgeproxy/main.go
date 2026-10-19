package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// ────────────────────────────────────────────────────────────────────────
// Startup and listener routing
// ────────────────────────────────────────────────────────────────────────

func main() {
	lan := flag.String("lan", ":80", "LAN listen address (controllers, kiosk, printer configuration)")
	tunnel := flag.String("tunnel", ":8080", "cloudflared origin listen address (Worker and printer APIs)")
	data := flag.String("data", "/data", "persistent data directory (one process only)")
	flag.Parse()
	auth, err := newWorkerAuth(os.Getenv("CONWAYEDGE_WORKER_ISSUER"), os.Getenv("CONWAYEDGE_PUBLIC_URL"))
	if err != nil {
		log.Fatal(err)
	}
	e, err := openEdge(*data, auth)
	if err != nil {
		log.Fatal(err)
	}
	lanHandler, tunnelHandler := e.routes()
	go e.run(context.Background())
	errs := make(chan error, 2)
	go func() { errs <- serve(*lan, lanHandler) }()
	go func() { errs <- serve(*tunnel, tunnelHandler) }()
	// SQLite commits are durable and swipe IDs make uploads idempotent, so an
	// abrupt exit loses nothing.
	log.Fatal(<-errs)
}

func serve(addr string, handler http.Handler) error {
	log.Printf("listening on %s", addr)
	server := &http.Server{Addr: addr, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second,
		WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	return server.ListenAndServe()
}

func secretEqual(a, b string) bool {
	x, y := sha256.Sum256([]byte(a)), sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(x[:], y[:]) == 1
}

func (e *edge) routes() (http.Handler, http.Handler) {
	lan, tunnel := http.NewServeMux(), http.NewServeMux()
	lan.HandleFunc("POST /api/fobs", e.controller)
	lan.HandleFunc("/{$}", e.configure)
	// Only these exact paths are forwarded with the edge credential.
	for _, route := range []string{"GET /kiosk", "GET /kiosk/app.js", "GET /kiosk/style.css", "GET /assets/favicon.svg", "POST /kiosk/claims"} {
		lan.HandleFunc(route, e.kiosk)
	}
	tunnel.HandleFunc("PUT /api/fobs", e.putFobs)
	tunnel.HandleFunc("GET /api/printers", e.printers.status)
	tunnel.HandleFunc("GET /machines/images/{image}", e.printers.snapshot)
	return lan, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		scope := "edge:api"
		if r.URL.Path == "/api/printers" || strings.HasPrefix(r.URL.Path, "/machines/images/") {
			// Browsers read printer data directly with short-lived member tokens.
			scope = "printers:read"
			w.Header().Set("Access-Control-Allow-Origin", e.auth.issuer)
			if r.Method == http.MethodOptions {
				w.Header().Set("Access-Control-Allow-Methods", "GET")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		if !e.auth.verify(r, scope) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		tunnel.ServeHTTP(w, r)
	})
}

// ────────────────────────────────────────────────────────────────────────
// Worker authentication
// ────────────────────────────────────────────────────────────────────────

const (
	keyRefresh = 5 * time.Minute // Refetch keys this often while in use.
	keyRetry   = time.Minute     // Minimum time between key downloads.
	keyMaxAge  = time.Hour       // Stop trusting keys that cannot be refreshed.
)

var clock = time.Now // Replaced by tests that verify fixed tokens.

type workerAuth struct {
	issuer, audience   string
	client             *http.Client
	mu                 sync.Mutex
	keys               map[string]ed25519.PublicKey
	fetched, attempted time.Time
}

func newWorkerAuth(issuer, audience string) (*workerAuth, error) {
	for _, value := range []string{issuer, audience} {
		u, err := url.Parse(value)
		if err != nil || u.Scheme != "https" || u.Host == "" || value != "https://"+u.Host {
			return nil, errors.New("CONWAYEDGE_WORKER_ISSUER and CONWAYEDGE_PUBLIC_URL must be HTTPS origins without trailing slashes")
		}
	}
	return &workerAuth{issuer: issuer, audience: audience, client: &http.Client{
		Timeout:       10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}

// key downloads the Worker's JWKS on demand: when the cache is old or an
// unknown key ID appears (for example after rotation), at most once a minute.
func (a *workerAuth) key(kid string) ed25519.PublicKey {
	a.mu.Lock()
	defer a.mu.Unlock()
	if (a.keys[kid] == nil || time.Since(a.fetched) > keyRefresh) && time.Since(a.attempted) >= keyRetry {
		a.attempted = time.Now()
		if keys, err := a.download(); err != nil {
			log.Printf("Worker JWKS download failed: %v", err)
		} else {
			a.keys, a.fetched = keys, a.attempted
		}
	}
	if time.Since(a.fetched) > keyMaxAge {
		return nil
	}
	return a.keys[kid]
}

func (a *workerAuth) download() (map[string]ed25519.PublicKey, error) {
	response, err := a.client.Get(a.issuer + "/.well-known/edge-jwks.json")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("JWKS returned %d", response.StatusCode)
	}
	var jwks struct {
		Keys []struct{ Kid, Kty, Crv, X string }
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&jwks); err != nil {
		return nil, err
	}
	keys := make(map[string]ed25519.PublicKey)
	for _, key := range jwks.Keys {
		x, err := base64.RawURLEncoding.DecodeString(key.X)
		if err == nil && key.Kty == "OKP" && key.Crv == "Ed25519" && key.Kid != "" && len(x) == ed25519.PublicKeySize {
			keys[key.Kid] = x
		}
	}
	return keys, nil
}

// verify accepts only a Worker-signed EdDSA JWT for this edge, with the given
// scope and a lifetime of at most 60 seconds.
func (a *workerAuth) verify(r *http.Request, scope string) bool {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	parts := strings.Split(token, ".")
	if !ok || len(token) > 4096 || len(parts) != 3 {
		return false
	}
	var header struct{ Alg, Kid string }
	var claims struct {
		Iss, Aud, Scope string
		Iat, Exp        int64
	}
	if decodeSegment(parts[0], &header) != nil || header.Alg != "EdDSA" {
		return false
	}
	key := a.key(header.Kid)
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if key == nil || err != nil || !ed25519.Verify(key, []byte(parts[0]+"."+parts[1]), signature) || decodeSegment(parts[1], &claims) != nil {
		return false
	}
	now := clock().Unix()
	// Allow five seconds of clock skew for issue time; expiry stays strict.
	return claims.Iss == a.issuer && claims.Aud == a.audience && claims.Scope == scope &&
		claims.Iat <= now+5 && claims.Exp > now && claims.Exp-claims.Iat <= 60
}

func decodeSegment(segment string, value any) error {
	data, err := base64.RawURLEncoding.DecodeString(segment)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, value)
}

// ────────────────────────────────────────────────────────────────────────
// SQLite state
// ────────────────────────────────────────────────────────────────────────

const schema = `
CREATE TABLE IF NOT EXISTS access (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL,
  fobs TEXT NOT NULL,
  key TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS printer_config (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  config TEXT NOT NULL
);
INSERT OR IGNORE INTO printer_config VALUES (1, '[]');
CREATE TABLE IF NOT EXISTS swipes (
  sequence INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  time INTEGER NOT NULL,
  controller TEXT NOT NULL,
  fob INTEGER NOT NULL,
  allowed INTEGER NOT NULL
);
DROP TABLE IF EXISTS goal;
DROP TABLE IF EXISTS goal_patch;
DROP TABLE IF EXISTS kiosk_claims;
`

type edge struct {
	db       *sql.DB
	auth     *workerAuth
	client   *http.Client // Outbound requests to the Worker.
	configMu sync.Mutex   // Orders configuration commits and printer lifecycle changes.
	config   []printerConfig
	csrf     string
	printers printerSet
	wake     chan struct{}
	syncMu   sync.Mutex
	// In memory, so every restart starts out of date and requests a sync.
	lastPush, lastSyncRequest time.Time
}

func openEdge(dir string, auth *workerAuth) (*edge, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	path, err := filepath.Abs(filepath.Join(dir, "edge.db"))
	if err != nil {
		return nil, err
	}
	// Create with private permissions before SQLite creates its journal files.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	u := url.URL{Scheme: "file", Path: path, RawQuery: url.Values{"_pragma": {"journal_mode(WAL)", "synchronous(FULL)", "busy_timeout(5000)"}}.Encode()}
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	e := &edge{db: db, auth: auth, csrf: rand.Text(), wake: make(chan struct{}, 1), client: &http.Client{
		Timeout:       20 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
	var data []byte
	if _, err = db.Exec(schema); err == nil {
		err = db.QueryRow("SELECT config FROM printer_config").Scan(&data)
	}
	if err == nil {
		e.config, err = parsePrinters(data)
	}
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("open edge database: %w", err)
	}
	e.printers.replace(e.config)
	return e, nil
}

func (e *edge) close() {
	e.configMu.Lock()
	defer e.configMu.Unlock()
	e.printers.close()
	_ = e.db.Close()
}

func readJSON(w http.ResponseWriter, r *http.Request, value any, limit int64) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	d.DisallowUnknownFields()
	if err := d.Decode(value); err != nil || d.Decode(new(any)) != io.EOF {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return false
	}
	return true
}

func storageError(w http.ResponseWriter, err error) {
	log.Printf("storage: %v", err)
	http.Error(w, "storage unavailable; retry later", http.StatusInternalServerError)
}

// ────────────────────────────────────────────────────────────────────────
// Door controllers and the authorized fob list
// ────────────────────────────────────────────────────────────────────────

type controllerSwipe struct {
	Fob     uint32 `json:"fob"`
	Allowed *bool  `json:"allowed"`
}

// controller stores a batch of swipes and returns the authorized fob list.
// Success (including 304) is sent only after the batch commits.
func (e *edge) controller(w http.ResponseWriter, r *http.Request) {
	var raw []json.RawMessage
	// A compact batch of 512 swipes with maximum uint32 IDs exceeds 16 KiB.
	if !readJSON(w, r, &raw, 32<<10) {
		return
	}
	if raw == nil || len(raw) > 512 {
		http.Error(w, "expected an array of at most 512 swipes", http.StatusBadRequest)
		return
	}
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	// A controller cannot fix a swipe it already recorded, so rejecting the
	// batch would only stall its fob list. Drop invalid swipes instead.
	input := make([]controllerSwipe, 0, len(raw))
	for _, message := range raw {
		var event controllerSwipe
		d := json.NewDecoder(bytes.NewReader(message))
		d.DisallowUnknownFields()
		if d.Decode(&event) == nil && event.Fob != 0 && event.Allowed != nil {
			input = append(input, event)
		}
	}
	tx, err := e.db.BeginTx(r.Context(), nil)
	if err != nil {
		storageError(w, err)
		return
	}
	defer tx.Rollback()
	var fobs []byte
	if err := tx.QueryRow("SELECT fobs FROM access").Scan(&fobs); errors.Is(err, sql.ErrNoRows) {
		// The controller keeps its cached list and its unsent swipes.
		http.Error(w, "waiting for the first fob list from the Worker", http.StatusServiceUnavailable)
		return
	} else if err != nil {
		storageError(w, err)
		return
	}
	now := time.Now().UnixNano()
	for _, event := range input {
		if _, err := tx.Exec("INSERT INTO swipes(id, time, controller, fob, allowed) VALUES (?, ?, ?, ?, ?)", rand.Text(), now, ip, event.Fob, *event.Allowed); err != nil {
			storageError(w, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		storageError(w, err)
		return
	}
	if dropped := len(raw) - len(input); dropped > 0 {
		log.Printf("controller %s: dropped %d invalid swipes", ip, dropped)
	}
	if len(input) > 0 {
		e.wakeSender()
	}
	var ids []uint32
	_ = json.Unmarshal(fobs, &ids)
	// Firmware hashes decimal IDs followed by commas, not the JSON response.
	hash := sha256.New()
	for _, id := range ids {
		fmt.Fprintf(hash, "%d,", id)
	}
	etag := fmt.Sprintf("%x", hash.Sum(nil))
	w.Header().Set("Cache-Control", "no-store")
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("ETag", etag)
	// Firmware does not decode chunked transfer encoding.
	w.Header().Set("Content-Length", strconv.Itoa(len(fobs)))
	_, _ = w.Write(fobs)
}

// putFobs accepts the Worker's authorized fob list. Revisions come from D1 and
// only move forward, so concurrent or reordered pushes cannot regress the list.
func (e *edge) putFobs(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Revision *int64   `json:"revision"`
		Fobs     []uint32 `json:"fobs"`
		Key      string   `json:"key"`
	}
	if !readJSON(w, r, &input, 16<<10) {
		return
	}
	if input.Revision == nil || *input.Revision < 0 || input.Fobs == nil || len(input.Fobs) > 512 || slices.Contains(input.Fobs, 0) ||
		len(input.Key) != 64 || strings.Trim(input.Key, "0123456789abcdef") != "" {
		http.Error(w, "expected a nonnegative revision, at most 512 nonzero fobs, and a 64-character hex key", http.StatusBadRequest)
		return
	}
	slices.Sort(input.Fobs)
	fobs, _ := json.Marshal(slices.Compact(input.Fobs))
	// SQLite evaluates every SET expression against the old row.
	if _, err := e.db.ExecContext(r.Context(), `INSERT INTO access VALUES (1, ?1, ?2, ?3) ON CONFLICT(singleton) DO UPDATE SET
		fobs = CASE WHEN excluded.revision >= revision THEN excluded.fobs ELSE fobs END,
		revision = max(revision, excluded.revision), key = excluded.key`, *input.Revision, string(fobs), input.Key); err != nil {
		storageError(w, err)
		return
	}
	e.syncMu.Lock()
	e.lastPush = time.Now()
	e.syncMu.Unlock()
	log.Printf("fob list received revision=%d fobs=%d", *input.Revision, len(input.Fobs))
	e.wakeSender() // A new key may unblock pending swipes.
	w.WriteHeader(http.StatusNoContent)
}

// ────────────────────────────────────────────────────────────────────────
// Swipe upload and sync requests
// ────────────────────────────────────────────────────────────────────────

const (
	swipeRetry = 30 * time.Second
	syncCheck  = time.Minute
	syncSpace  = 10 * time.Minute // Matches the Worker's global rate limit.
	syncStale  = 3 * time.Hour    // Access changes are pushed; silence this long is suspicious.
)

func (e *edge) wakeSender() {
	select {
	case e.wake <- struct{}{}:
	default:
	}
}

func (e *edge) run(ctx context.Context) {
	retry := time.NewTimer(0)
	check := time.NewTicker(syncCheck)
	defer check.Stop()
	e.requestSyncIfStale(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-check.C:
			e.requestSyncIfStale(ctx)
			continue
		case <-e.wake:
		case <-retry.C:
		}
		if err := e.uploadSwipes(ctx); err != nil && ctx.Err() == nil {
			log.Printf("swipe upload failed; retrying in %s: %v", swipeRetry, err)
			retry.Reset(swipeRetry)
		}
	}
}

type swipe struct {
	ID         string    `json:"id"`
	Time       time.Time `json:"time"`
	Controller string    `json:"controller"`
	Fob        uint32    `json:"fob"`
	Allowed    bool      `json:"allowed"`
}

// uploadSwipes sends the outbox in batches, deleting each only after the
// Worker commits it. Event IDs make a retried batch idempotent.
func (e *edge) uploadSwipes(ctx context.Context) error {
	for {
		var key string
		var revision int64
		err := e.db.QueryRowContext(ctx, "SELECT key, revision FROM access").Scan(&key, &revision)
		if errors.Is(err, sql.ErrNoRows) {
			return nil // Swipes wait for the first push, which wakes the sender.
		} else if err != nil {
			return err
		}
		events, last, err := e.pendingSwipes(ctx)
		if err != nil || len(events) == 0 {
			return err
		}
		body, _ := json.Marshal(events)
		req, err := http.NewRequestWithContext(ctx, "POST", e.auth.issuer+"/webhooks/edge/swipes", bytes.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("Content-Type", "application/json")
		// The Worker pushes a fresh list if this revision is out of date.
		req.Header.Set("X-Edge-Revision", strconv.FormatInt(revision, 10))
		response, err := e.client.Do(req)
		if err != nil {
			return err
		}
		response.Body.Close()
		if response.StatusCode == http.StatusUnauthorized {
			e.markStale() // The key changed; a sync delivers the new one.
		}
		if response.StatusCode != http.StatusNoContent {
			return fmt.Errorf("Worker returned %d", response.StatusCode)
		}
		if _, err := e.db.ExecContext(ctx, "DELETE FROM swipes WHERE sequence <= ?", last); err != nil {
			return err
		}
		log.Printf("uploaded swipes=%d", len(events))
	}
}

func (e *edge) pendingSwipes(ctx context.Context) ([]swipe, int64, error) {
	rows, err := e.db.QueryContext(ctx, "SELECT sequence, id, time, controller, fob, allowed FROM swipes ORDER BY sequence LIMIT 512")
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var events []swipe
	var last, timestamp int64
	for rows.Next() {
		var event swipe
		if err := rows.Scan(&last, &event.ID, &timestamp, &event.Controller, &event.Fob, &event.Allowed); err != nil {
			return nil, 0, err
		}
		event.Time = time.Unix(0, timestamp).UTC()
		events = append(events, event)
	}
	return events, last, rows.Err()
}

func (e *edge) markStale() {
	e.syncMu.Lock()
	e.lastPush = time.Time{}
	e.syncMu.Unlock()
}

// requestSyncIfStale asks the Worker for a push when this edge may have
// missed one. The request is unauthenticated and rate limited by the Worker.
func (e *edge) requestSyncIfStale(ctx context.Context) {
	e.syncMu.Lock()
	due := time.Since(e.lastPush) > syncStale && time.Since(e.lastSyncRequest) >= syncSpace
	if due {
		e.lastSyncRequest = time.Now()
	}
	e.syncMu.Unlock()
	if !due {
		return
	}
	req, err := http.NewRequestWithContext(ctx, "POST", e.auth.issuer+"/webhooks/edge/sync", nil)
	if err != nil {
		return
	}
	response, err := e.client.Do(req)
	if err != nil {
		log.Printf("sync request failed: %v", err)
		return
	}
	response.Body.Close()
	log.Printf("sync requested status=%d", response.StatusCode)
}

// ────────────────────────────────────────────────────────────────────────
// LAN kiosk proxy
// ────────────────────────────────────────────────────────────────────────

// kiosk forwards a fixed kiosk path to the Worker with the edge credential. The
// LAN is trusted to enroll fobs; members still confirm on their own phones.
func (e *edge) kiosk(w http.ResponseWriter, r *http.Request) {
	var key string
	if err := e.db.QueryRowContext(r.Context(), "SELECT key FROM access").Scan(&key); err != nil {
		http.Error(w, `{"error":"Fob enrollment is not available yet. Please try again shortly."}`, http.StatusServiceUnavailable)
		return
	}
	path := strings.Fields(r.Pattern)[1]
	var body io.Reader
	if r.Method == http.MethodPost {
		body = http.MaxBytesReader(w, r.Body, 1024)
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, e.auth.issuer+path, body)
	if err != nil {
		http.Error(w, "invalid request", http.StatusInternalServerError)
		return
	}
	req.Header.Set("Authorization", "Bearer "+key)
	if contentType := r.Header.Get("Content-Type"); contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	response, err := e.client.Do(req)
	if err != nil {
		http.Error(w, `{"error":"Fob enrollment is temporarily unavailable. Please scan again."}`, http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	for _, name := range []string{"Content-Type", "Cache-Control", "Content-Security-Policy", "Referrer-Policy", "X-Content-Type-Options", "X-Robots-Tag"} {
		if value := response.Header.Get(name); value != "" {
			w.Header().Set(name, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(response.Body, 1<<20))
}
