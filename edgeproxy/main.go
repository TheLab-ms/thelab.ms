package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
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
	"os/signal"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	qrcode "github.com/skip2/go-qrcode"
	_ "modernc.org/sqlite"
)

// ────────────────────────────────────────────────────────────────────────
// Startup and listener routing
// ────────────────────────────────────────────────────────────────────────

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	lan := flag.String("lan", ":80", "LAN controller/config listen address")
	tunnel := flag.String("tunnel", ":8080", "cloudflared origin listen address (loopback or trusted subnet)")
	data := flag.String("data", "/data", "persistent data directory (one process only)")
	flag.Parse()
	log.Printf("edge proxy starting data=%q", *data)
	e, err := openEdge(*data)
	if err != nil {
		return err
	}
	defer e.close()
	e.workerAuth, err = loadWorkerAuth(os.Getenv("CONWAYEDGE_WORKER_ISSUER"), os.Getenv("CONWAYEDGE_PUBLIC_URL"))
	if err != nil {
		return err
	}
	e.signingKey, err = loadSigningSeed(os.Getenv("CONWAYEDGE_SIGNING_SEED"))
	if err != nil {
		return err
	}
	log.Printf("edge proxy authentication configured worker=%t fob_signing=%t", e.workerAuth != nil, e.signingKey != nil)
	lanHandler, tunnelHandler := e.routes()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go e.workerAuth.run(ctx)
	senderDone := make(chan struct{})
	go func() {
		defer close(senderDone)
		e.runSwipeSender(ctx)
	}()
	defer func() { stop(); <-senderDone }()
	local, err := net.Listen("tcp", *lan)
	if err != nil {
		return err
	}
	defer local.Close()
	cloud, err := net.Listen("tcp", *tunnel)
	if err != nil {
		return err
	}
	defer cloud.Close()
	// The tunnel listener may bind a trusted subnet for a separate cloudflared
	// host. Firewall it to that host; machine APIs also verify Worker JWTs.
	errors := make(chan error, 2)
	for _, endpoint := range []struct {
		listener net.Listener
		handler  http.Handler
	}{{local, lanHandler}, {cloud, tunnelHandler}} {
		server := &http.Server{
			Handler:           endpoint.handler,
			ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second,
			WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second,
			MaxHeaderBytes: 16 << 10,
			BaseContext:    func(net.Listener) context.Context { return ctx },
		}
		defer func() {
			shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := server.Shutdown(shutdown); err != nil {
				_ = server.Close()
			}
		}()
		go func() { errors <- server.Serve(endpoint.listener) }()
		log.Printf("listening on %s", endpoint.listener.Addr())
	}
	select {
	case <-ctx.Done():
		log.Printf("edge proxy shutting down: %v", ctx.Err())
		return nil
	case err := <-errors:
		log.Printf("edge proxy listener stopped: %v", err)
		stop()
		return err
	}
}

func secretEqual(a, b string) bool {
	x, y := sha256.Sum256([]byte(a)), sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(x[:], y[:]) == 1
}

func (e *edge) routes() (http.Handler, http.Handler) {
	lan, tunnel := http.NewServeMux(), http.NewServeMux()
	lan.HandleFunc("POST /api/fobs", e.fobs)
	for _, path := range []string{"/kiosk", "/kiosk/app.js", "/kiosk/style.css", "/kiosk/favicon.svg"} {
		lan.HandleFunc("GET "+path, kioskAsset)
	}
	lan.HandleFunc("POST /kiosk/claims", e.issueKioskClaim)
	lan.HandleFunc("/{$}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		e.configure(w, r)
	})
	tunnel.HandleFunc("PUT /api/goal", e.goal)
	tunnel.HandleFunc("GET /api/goal", e.getGoal)
	tunnel.HandleFunc("PATCH /api/goal", e.patchGoal)
	tunnel.HandleFunc("GET /api/kiosk/claim", e.getKioskClaim)
	tunnel.HandleFunc("GET /machines", e.printers.dashboard)
	tunnel.HandleFunc("GET /machines/content", e.printers.dashboard)
	tunnel.HandleFunc("GET /machines/images/{image}", e.printers.snapshot)
	tunnel.HandleFunc("GET /machines/app.js", printerScript)
	return logRequests("lan", lan), logRequests("tunnel", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.URL.Path == "/machines" || strings.HasPrefix(r.URL.Path, "/machines/") {
			w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")
			w.Header().Set("Referrer-Policy", "no-referrer")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
		} else if !e.workerAuth.verify(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		tunnel.ServeHTTP(w, r)
	}))
}

// ────────────────────────────────────────────────────────────────────────
// Request logging
// ────────────────────────────────────────────────────────────────────────

type requestLogWriter struct {
	http.ResponseWriter
	status, bytes int
}

// Preserve ResponseController support, including camera write deadlines.
func (w *requestLogWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *requestLogWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	if status >= 200 || status == http.StatusSwitchingProtocols {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *requestLogWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(body)
	w.bytes += n
	return n, err
}

func logRequests(listener string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		response := &requestLogWriter{ResponseWriter: w}
		completed := false
		defer func() {
			status := response.status
			if status == 0 && completed {
				status = http.StatusOK
			}
			// Queries, headers, and bodies can contain credentials or controller data.
			log.Printf("HTTP request listener=%s method=%q path=%q remote=%q status=%d bytes=%d duration=%s completed=%t",
				listener, r.Method, r.URL.EscapedPath(), r.RemoteAddr, status, response.bytes, time.Since(start), completed)
		}()
		next.ServeHTTP(response, r)
		completed = true
	})
}

// ────────────────────────────────────────────────────────────────────────
// Worker authentication and key refresh
// ────────────────────────────────────────────────────────────────────────

const workerKeyRefresh = 5 * time.Minute
const workerKeyMaxAge = time.Hour
const workerKeyRetry = 5 * time.Second
const workerKeyRetryMax = time.Minute
const workerClockSkew = int64(5) // Seconds; expiration and the 60-second lifetime remain strict.

type workerAuth struct {
	issuer, audience   string
	mu                 sync.Mutex
	keys               map[string]ed25519.PublicKey
	expires, attempted time.Time
	client             *http.Client
}

func loadWorkerAuth(issuer, audience string) (*workerAuth, error) {
	if issuer == "" && audience == "" {
		return nil, nil
	}
	for _, value := range []string{issuer, audience} {
		u, err := url.Parse(value)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || value != "https://"+u.Host {
			return nil, fmt.Errorf("Worker issuer and public URL must be HTTPS origins without trailing slashes")
		}
	}
	return &workerAuth{issuer: issuer, audience: audience, client: &http.Client{
		Timeout:       5 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}

// Caller holds mu. Failures never extend the last successful key set's lifetime.
func (a *workerAuth) refresh(ctx context.Context) (err error) {
	a.attempted = time.Now()
	log.Printf("Worker JWKS download started issuer=%q", a.issuer)
	defer func() {
		if err != nil {
			if ctx.Err() == nil {
				log.Printf("Worker JWKS download failed issuer=%q duration=%s error=%q", a.issuer, time.Since(a.attempted), err)
			}
		} else {
			log.Printf("Worker JWKS download succeeded issuer=%q keys=%d duration=%s", a.issuer, len(a.keys), time.Since(a.attempted))
		}
	}()
	req, err := http.NewRequestWithContext(ctx, "GET", a.issuer+"/.well-known/edge-jwks.json", nil)
	if err != nil {
		return err
	}
	response, err := a.client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("JWKS returned %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil {
		return err
	}
	if len(body) > 65536 {
		return fmt.Errorf("JWKS too large")
	}
	var jwks struct {
		Keys []struct{ Kid, Kty, Crv, Alg, Use, X string } `json:"keys"`
	}
	if json.Unmarshal(body, &jwks) != nil || jwks.Keys == nil || len(jwks.Keys) > 32 {
		return fmt.Errorf("invalid JWKS")
	}
	keys := make(map[string]ed25519.PublicKey)
	for _, key := range jwks.Keys {
		if key.Kty != "OKP" || key.Crv != "Ed25519" || key.Alg != "EdDSA" || key.Use != "sig" || key.Kid == "" {
			continue
		}
		x, err := base64.RawURLEncoding.Strict().DecodeString(key.X)
		if err != nil || len(x) != ed25519.PublicKeySize || keys[key.Kid] != nil {
			return fmt.Errorf("invalid or duplicate JWKS key")
		}
		keys[key.Kid] = ed25519.PublicKey(x)
	}
	// An empty key set deliberately revokes all keys.
	a.keys, a.expires = keys, time.Now().Add(workerKeyMaxAge)
	return nil
}

func (a *workerAuth) refreshKeys(ctx context.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.refresh(ctx)
}

func (a *workerAuth) run(ctx context.Context) {
	a.runRefresh(ctx, workerKeyRefresh)
}

func (a *workerAuth) runRefresh(ctx context.Context, interval time.Duration) {
	if a == nil {
		return
	}
	timer := time.NewTimer(0)
	defer timer.Stop()
	retry := workerKeyRetry
	for ctx.Err() == nil {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			if ctx.Err() != nil {
				return
			}
			delay := interval
			if err := a.refreshKeys(ctx); err != nil {
				delay = retry
				retry = min(retry*2, workerKeyRetryMax)
				if ctx.Err() == nil {
					log.Printf("Worker JWKS retry scheduled in=%s", delay)
				}
			} else {
				retry = workerKeyRetry
			}
			timer.Reset(delay)
		}
	}
}

func (a *workerAuth) key(ctx context.Context, kid string) ed25519.PublicKey {
	a.mu.Lock()
	defer a.mu.Unlock()
	if (a.keys[kid] == nil || !time.Now().Before(a.expires)) && time.Since(a.attempted) >= time.Minute {
		_ = a.refresh(ctx)
	}
	if !time.Now().Before(a.expires) {
		return nil
	}
	return a.keys[kid]
}

func (a *workerAuth) verify(r *http.Request) bool {
	return a.verifyAt(r, time.Now().Unix())
}

func (a *workerAuth) verifyAt(r *http.Request, now int64) bool {
	if err := a.validateAt(r, now); err != nil {
		log.Printf("Worker authentication rejected method=%q path=%q reason=%q", r.Method, r.URL.EscapedPath(), err)
		return false
	}
	return true
}

func (a *workerAuth) validateAt(r *http.Request, now int64) error {
	if a == nil {
		return fmt.Errorf("Worker authentication is not configured")
	}
	values := r.Header.Values("Authorization")
	if len(values) != 1 || len(values[0]) > 4096 || !strings.HasPrefix(values[0], "Bearer ") {
		return fmt.Errorf("missing or invalid Bearer authorization")
	}
	parts := strings.Split(strings.TrimPrefix(values[0], "Bearer "), ".")
	if len(parts) != 3 {
		return fmt.Errorf("malformed JWT")
	}
	decode := base64.RawURLEncoding.Strict().DecodeString
	header, err := decode(parts[0])
	if err != nil {
		return fmt.Errorf("malformed JWT header encoding")
	}
	var metadata struct{ Alg, Typ, Kid string }
	if decodeJSON(header, &metadata) != nil || metadata.Alg != "EdDSA" || metadata.Typ != "JWT" || metadata.Kid == "" {
		return fmt.Errorf("unsupported or malformed JWT header")
	}
	key := a.key(r.Context(), metadata.Kid)
	if key == nil {
		return fmt.Errorf("signing key unavailable (unknown key ID or expired JWKS cache)")
	}
	sig, err := decode(parts[2])
	if err != nil || !ed25519.Verify(key, []byte(parts[0]+"."+parts[1]), sig) {
		return fmt.Errorf("invalid JWT signature")
	}
	payload, err := decode(parts[1])
	if err != nil {
		return fmt.Errorf("malformed JWT payload encoding")
	}
	var claims struct {
		Issuer    string `json:"iss"`
		Audience  string `json:"aud"`
		Subject   string `json:"sub"`
		Scope     string `json:"scope"`
		Issued    int64  `json:"iat"`
		Expires   int64  `json:"exp"`
		NotBefore int64  `json:"nbf"`
	}
	if json.Unmarshal(payload, &claims) != nil {
		return fmt.Errorf("malformed JWT claims")
	}
	// Only report claim values after signature verification. Never log the token.
	if claims.Issuer != a.issuer {
		return fmt.Errorf("issuer mismatch: got %q, want CONWAYEDGE_WORKER_ISSUER=%q (Worker SITE_URL)", claims.Issuer, a.issuer)
	}
	if claims.Audience != a.audience {
		return fmt.Errorf("audience mismatch: got %q, want CONWAYEDGE_PUBLIC_URL=%q (Worker EDGE_URL)", claims.Audience, a.audience)
	}
	if claims.Subject != "edge-sync" || claims.Scope != "edge:api" {
		return fmt.Errorf("invalid JWT subject or scope")
	}
	if claims.Issued <= 0 || claims.Expires <= claims.Issued || claims.Expires-claims.Issued > 60 {
		return fmt.Errorf("invalid JWT lifetime: iat=%d exp=%d", claims.Issued, claims.Expires)
	}
	if claims.Issued > now+workerClockSkew || claims.NotBefore > now+workerClockSkew {
		return fmt.Errorf("JWT is not yet valid; check edge clock: now=%d iat=%d nbf=%d skew_allowance=%ds", now, claims.Issued, claims.NotBefore, workerClockSkew)
	}
	if claims.Expires <= now {
		return fmt.Errorf("JWT expired; check edge clock or request delay: now=%d exp=%d", now, claims.Expires)
	}
	return nil
}

// ────────────────────────────────────────────────────────────────────────
// SQLite state and transactions
// ────────────────────────────────────────────────────────────────────────

const swipeRetention = 7 * 24 * time.Hour

var (
	errGoalConflict = errors.New("older or conflicting goal version")
	errNoGoal       = errors.New("no goal received yet")
)

type edge struct {
	db         *sql.DB
	configMu   sync.Mutex // Orders configuration commits and printer lifecycle changes.
	config     []printerConfig
	csrf       string
	printers   printerSet
	signingKey ed25519.PrivateKey
	workerAuth *workerAuth
	swipeWake  chan struct{}
}

const schema = `
CREATE TABLE IF NOT EXISTS goal (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version BETWEEN 0 AND 9007199254740991),
  fobs TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS goal_patch (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), patch TEXT NOT NULL);
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
  fob INTEGER NOT NULL CHECK (fob BETWEEN 1 AND 4294967295),
  allowed INTEGER NOT NULL CHECK (allowed IN (0, 1))
);
DROP INDEX IF EXISTS pending_swipes;
DROP INDEX IF EXISTS swipe_history;
CREATE INDEX IF NOT EXISTS swipe_expiry ON swipes(time);
CREATE TABLE IF NOT EXISTS kiosk_claims (
  id TEXT PRIMARY KEY,
  fob INTEGER NOT NULL CHECK (fob BETWEEN 1 AND 4294967295),
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS kiosk_claim_expiry ON kiosk_claims(expires);
`

func openEdge(dir string) (*edge, error) {
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
	u := url.URL{Scheme: "file", Path: path}
	q := url.Values{"_pragma": {"journal_mode(WAL)", "synchronous(FULL)", "busy_timeout(5000)"}}
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	e := &edge{db: db, csrf: rand.Text(), swipeWake: make(chan struct{}, 1)}
	if err := e.initialize(); err != nil {
		db.Close()
		return nil, fmt.Errorf("open edge database: %w", err)
	}
	e.printers.replace(e.config)
	return e, nil
}

func (e *edge) initialize() error {
	return e.transaction(context.Background(), func(tx *sql.Tx) error {
		if _, err := tx.Exec(schema); err != nil {
			return err
		}
		// Upgrade the acknowledgment-based store without changing retained events.
		var acknowledged int
		if err := tx.QueryRow("SELECT count(*) FROM pragma_table_info('swipes') WHERE name = 'acknowledged'").Scan(&acknowledged); err != nil {
			return err
		}
		if acknowledged != 0 {
			if _, err := tx.Exec("ALTER TABLE swipes DROP COLUMN acknowledged"); err != nil {
				return err
			}
		}
		// New and upgraded stores enqueue all retained history for idempotent delivery.
		for _, column := range []struct{ table, name, definition string }{
			{"goal", "event_signing_key", "TEXT NOT NULL DEFAULT ''"},
			{"swipes", "delivered", "INTEGER NOT NULL DEFAULT 0 CHECK (delivered IN (0, 1))"},
		} {
			var count int
			if err := tx.QueryRow("SELECT count(*) FROM pragma_table_info(?) WHERE name = ?", column.table, column.name).Scan(&count); err != nil {
				return err
			}
			if count == 0 {
				if _, err := tx.Exec("ALTER TABLE " + column.table + " ADD COLUMN " + column.name + " " + column.definition); err != nil {
					return err
				}
			}
		}
		if _, err := tx.Exec("CREATE INDEX IF NOT EXISTS swipe_outbox ON swipes(sequence) WHERE delivered = 0"); err != nil {
			return err
		}
		var data []byte
		if err := tx.QueryRow("SELECT config FROM printer_config WHERE singleton = 1").Scan(&data); err != nil {
			return err
		}
		var err error
		e.config, err = parsePrinters(data)
		if err != nil {
			return err
		}
		err = tx.QueryRow("SELECT fobs FROM goal WHERE singleton = 1").Scan(&data)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if err == nil {
			canonical, err := normalizeGoal(data)
			if err != nil {
				return err
			}
			if !bytes.Equal(data, canonical) {
				return fmt.Errorf("stored goal is not canonical JSON")
			}
		}
		return pruneSwipes(tx)
	})
}

func (e *edge) close() {
	e.configMu.Lock()
	defer e.configMu.Unlock()
	e.printers.close()
	_ = e.db.Close()
}

func (e *edge) transaction(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := e.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func (e *edge) storeGoal(ctx context.Context, version int64, body []byte, eventKey string) error {
	result, err := e.db.ExecContext(ctx, `INSERT INTO goal(singleton, version, fobs, event_signing_key) VALUES (1, ?, ?, ?)
ON CONFLICT(singleton) DO UPDATE SET version = excluded.version, fobs = excluded.fobs, event_signing_key = excluded.event_signing_key
WHERE excluded.version > goal.version OR (excluded.version = goal.version AND excluded.fobs = goal.fobs AND excluded.event_signing_key = goal.event_signing_key)`, version, string(body), eventKey)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err == nil && n == 0 {
		return errGoalConflict
	}
	if err == nil {
		e.wakeSwipes()
	}
	return err
}

type controllerSwipe struct {
	Fob     uint32 `json:"fob"`
	Allowed bool   `json:"allowed"`
}

type swipe struct {
	ID         string    `json:"id"`
	Time       time.Time `json:"time"`
	Controller string    `json:"controller"`
	Fob        uint32    `json:"fob"`
	Allowed    bool      `json:"allowed"`
}

func pruneSwipes(tx *sql.Tx) error {
	_, err := tx.Exec("DELETE FROM swipes WHERE delivered = 1 AND time < ?", time.Now().Add(-swipeRetention).UnixNano())
	return err
}

// The goal read and complete batch insertion share a transaction. HTTP success
// (including 304) is sent only after the batch commits.
func (e *edge) controllerPoll(ctx context.Context, ip string, events []controllerSwipe) ([]byte, error) {
	var body []byte
	err := e.transaction(ctx, func(tx *sql.Tx) error {
		if err := tx.QueryRow("SELECT fobs FROM goal WHERE singleton = 1").Scan(&body); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return errNoGoal
			}
			return err
		}
		if len(events) == 0 {
			return nil
		}
		stmt, err := tx.Prepare("INSERT INTO swipes(id, time, controller, fob, allowed) VALUES (?, ?, ?, ?, ?)")
		if err != nil {
			return err
		}
		defer stmt.Close()
		now := time.Now().UTC().UnixNano()
		for _, event := range events {
			if _, err := stmt.Exec(rand.Text(), now, ip, event.Fob, event.Allowed); err != nil {
				return err
			}
		}
		return pruneSwipes(tx)
	})
	if err == nil && len(events) > 0 {
		e.wakeSwipes()
	}
	return body, err
}

func (e *edge) retainedSwipes(ctx context.Context) ([]swipe, error) {
	events := []swipe{}
	err := e.transaction(ctx, func(tx *sql.Tx) error {
		if err := pruneSwipes(tx); err != nil {
			return err
		}
		rows, err := tx.Query("SELECT id, time, controller, fob, allowed FROM swipes ORDER BY sequence")
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var event swipe
			var timestamp int64
			if err := rows.Scan(&event.ID, &timestamp, &event.Controller, &event.Fob, &event.Allowed); err != nil {
				return err
			}
			event.Time = time.Unix(0, timestamp).UTC()
			events = append(events, event)
		}
		return rows.Err()
	})
	return events, err
}

func (e *edge) storePrinters(ctx context.Context, printers []printerConfig) error {
	e.configMu.Lock()
	defer e.configMu.Unlock()
	data, _ := json.Marshal(printers)
	if _, err := e.db.ExecContext(ctx, "UPDATE printer_config SET config = ? WHERE singleton = 1", string(data)); err != nil {
		return err
	}
	e.config = printers
	e.printers.replace(printers)
	return nil
}

// ────────────────────────────────────────────────────────────────────────
// Controller and goal-state APIs
// ────────────────────────────────────────────────────────────────────────

func decodeJSON(data []byte, value any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(value); err != nil {
		return err
	}
	if d.Decode(new(any)) != io.EOF {
		return fmt.Errorf("expected one JSON value")
	}
	return nil
}

func readJSON(w http.ResponseWriter, r *http.Request, value any, limit int64) bool {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil || decodeJSON(data, value) != nil {
		http.Error(w, fmt.Sprintf("invalid JSON (limit %d KiB)", limit>>10), http.StatusBadRequest)
		return false
	}
	return true
}

func storageError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errGoalConflict):
		http.Error(w, err.Error(), http.StatusConflict)
	case errors.Is(err, errNoGoal):
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
	default:
		log.Printf("storage: %v", err)
		http.Error(w, "storage unavailable; retry later", http.StatusInternalServerError)
	}
}

func normalizeGoal(data []byte) ([]byte, error) {
	var ids []uint32
	if err := json.Unmarshal(data, &ids); err != nil || ids == nil || len(ids) > 512 || slices.Contains(ids, 0) {
		return nil, fmt.Errorf("goal must be an array of at most 512 nonzero uint32 fob IDs")
	}
	slices.Sort(ids)
	ids = slices.Compact(ids)
	body, _ := json.Marshal(ids)
	return append(body, '\n'), nil
}

func controllerETag(body []byte) (string, error) {
	var ids []uint32
	if err := json.Unmarshal(body, &ids); err != nil {
		return "", err
	}
	// Firmware hashes decimal IDs followed by commas, not the JSON response.
	hash := sha256.New()
	for _, id := range ids {
		fmt.Fprintf(hash, "%d,", id)
	}
	return fmt.Sprintf("%x", hash.Sum(nil)), nil
}

func (e *edge) goal(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Version  *int64          `json:"version"`
		Fobs     json.RawMessage `json:"fobs"`
		EventKey string          `json:"event_signing_key"`
	}
	if !readJSON(w, r, &input, 16<<10) {
		return
	}
	if input.Version == nil || *input.Version < 0 || *input.Version > 9007199254740991 {
		http.Error(w, "version must be a nonnegative safe integer", http.StatusBadRequest)
		return
	}
	key, err := hex.DecodeString(input.EventKey)
	if err != nil || len(key) != 32 || hex.EncodeToString(key) != input.EventKey {
		http.Error(w, "event_signing_key must be 32 bytes encoded as lowercase hex", http.StatusBadRequest)
		return
	}
	body, err := normalizeGoal(input.Fobs)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := e.storeGoal(r.Context(), *input.Version, body, input.EventKey); err != nil {
		storageError(w, err)
		return
	}
	log.Printf("goal stored version=%d bytes=%d", *input.Version, len(body))
	w.WriteHeader(http.StatusNoContent)
}

func (e *edge) getGoal(w http.ResponseWriter, r *http.Request) {
	var version int64
	var fobs []byte
	var eventKey string
	err := e.db.QueryRowContext(r.Context(), "SELECT version, fobs, event_signing_key FROM goal WHERE singleton = 1").Scan(&version, &fobs, &eventKey)
	if errors.Is(err, sql.ErrNoRows) {
		err = errNoGoal
	}
	if err != nil {
		storageError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		Version  int64           `json:"version"`
		Fobs     json.RawMessage `json:"fobs"`
		EventKey string          `json:"event_signing_key,omitempty"`
	}{version, fobs, eventKey})
}

func (e *edge) patchGoal(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Base    *int64   `json:"base_version"`
		Version *int64   `json:"version"`
		Add     []uint32 `json:"add"`
		Remove  []uint32 `json:"remove"`
	}
	if !readJSON(w, r, &input, 16<<10) {
		return
	}
	if input.Base == nil || input.Version == nil || *input.Base < 0 || *input.Version <= *input.Base || *input.Version > 9007199254740991 ||
		input.Add == nil || input.Remove == nil || len(input.Add) > 512 || len(input.Remove) > 512 || slices.Contains(input.Add, 0) || slices.Contains(input.Remove, 0) {
		http.Error(w, "invalid goal diff", 400)
		return
	}
	slices.Sort(input.Add)
	input.Add = slices.Compact(input.Add)
	slices.Sort(input.Remove)
	input.Remove = slices.Compact(input.Remove)
	for _, id := range input.Add {
		if slices.Contains(input.Remove, id) {
			http.Error(w, "overlapping goal diff", 400)
			return
		}
	}
	patch, _ := json.Marshal(input)
	err := e.transaction(r.Context(), func(tx *sql.Tx) error {
		var version int64
		var body []byte
		if err := tx.QueryRow("SELECT version, fobs FROM goal WHERE singleton = 1").Scan(&version, &body); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return errNoGoal
			}
			return err
		}
		if version == *input.Version {
			var previous string
			err := tx.QueryRow("SELECT patch FROM goal_patch WHERE singleton = 1").Scan(&previous)
			if err == nil && previous == string(patch) {
				return nil
			}
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			return errGoalConflict
		}
		if version != *input.Base {
			return errGoalConflict
		}
		var ids []uint32
		if err := json.Unmarshal(body, &ids); err != nil {
			return err
		}
		ids = slices.DeleteFunc(ids, func(id uint32) bool { return slices.Contains(input.Remove, id) })
		ids = append(ids, input.Add...)
		slices.Sort(ids)
		ids = slices.Compact(ids)
		if len(ids) > 512 {
			return errGoalCapacity
		}
		body, _ = json.Marshal(ids)
		body = append(body, '\n')
		if _, err := tx.Exec("UPDATE goal SET version = ?, fobs = ? WHERE singleton = 1", *input.Version, string(body)); err != nil {
			return err
		}
		_, err := tx.Exec("INSERT INTO goal_patch VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET patch = excluded.patch", string(patch))
		return err
	})
	if errors.Is(err, errGoalCapacity) {
		http.Error(w, err.Error(), 400)
		return
	}
	if err != nil {
		storageError(w, err)
		return
	}
	log.Printf("goal diff stored base_version=%d version=%d added=%d removed=%d", *input.Base, *input.Version, len(input.Add), len(input.Remove))
	w.WriteHeader(http.StatusNoContent)
}

var errGoalCapacity = errors.New("goal exceeds 512 fobs")

func (e *edge) fobs(w http.ResponseWriter, r *http.Request) {
	var input []struct {
		Fob     uint32 `json:"fob"`
		Allowed *bool  `json:"allowed"`
	}
	// A compact batch of 512 swipes with maximum uint32 IDs exceeds 16 KiB.
	if !readJSON(w, r, &input, 32<<10) {
		return
	}
	if input == nil || len(input) > 512 {
		http.Error(w, "expected an array of at most 512 swipes", http.StatusBadRequest)
		return
	}
	events := make([]controllerSwipe, 0, len(input))
	for _, event := range input {
		if event.Fob == 0 || event.Allowed == nil {
			http.Error(w, "each swipe requires a nonzero fob ID and boolean allowed", http.StatusBadRequest)
			return
		}
		events = append(events, controllerSwipe{Fob: event.Fob, Allowed: *event.Allowed})
	}
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	body, err := e.controllerPoll(r.Context(), ip, events)
	if err != nil {
		storageError(w, err)
		return
	}
	if len(events) > 0 {
		log.Printf("controller swipes stored controller=%q events=%d", ip, len(events))
	}
	etag, err := controllerETag(body)
	if err != nil {
		storageError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("ETag", etag)
	if e.signingKey != nil {
		w.Header().Set("X-Fob-Signature", base64.StdEncoding.EncodeToString(ed25519.Sign(e.signingKey, body)))
	}
	// Firmware does not decode chunked transfer encoding.
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	_, _ = w.Write(body)
}

func loadSigningSeed(path string) (ed25519.PrivateKey, error) {
	if path == "" {
		return nil, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open signing seed: %w", err)
	}
	defer f.Close()
	seed, err := io.ReadAll(io.LimitReader(f, ed25519.SeedSize+1))
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("signing seed must be exactly 32 raw bytes")
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// ────────────────────────────────────────────────────────────────────────
// Durable swipe delivery
// ────────────────────────────────────────────────────────────────────────

const swipePath = "/webhooks/edge/swipes"
const swipeInterval = 30 * time.Second

func (e *edge) wakeSwipes() {
	select {
	case e.swipeWake <- struct{}{}:
	default:
	}
}

func swipeSignature(key []byte, timestamp string, body []byte) string {
	mac := hmac.New(sha256.New, key)
	fmt.Fprintf(mac, "POST\n%s\n%s\n", swipePath, timestamp)
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func (e *edge) runSwipeSender(ctx context.Context) {
	if e.workerAuth == nil {
		return
	}
	client := &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	e.sendSwipes(ctx, e.workerAuth.issuer, client, swipeInterval)
}

// A leading flush followed by fixed windows. Notifications never reset the timer.
// Restart checks the persistent outbox immediately; failed flushes retry next window.
func (e *edge) sendSwipes(ctx context.Context, origin string, client *http.Client, interval time.Duration) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	active := false
	for {
		select {
		case <-ctx.Done():
			return
		case <-e.swipeWake:
			if !active {
				timer.Reset(0)
			}
		case <-timer.C:
			started := time.Now()
			attempted, err := e.flushSwipes(ctx, origin, client)
			if ctx.Err() != nil {
				return
			}
			if err != nil {
				log.Printf("swipe push failed: %v", err)
			}
			if attempted || err != nil {
				active = true
				delay := max(0, interval-time.Since(started))
				if err != nil {
					delay = interval
				}
				timer.Reset(delay)
			} else {
				active = false
			}
		}
	}
}

// Snapshot the high-water mark so continuous arrivals cannot prolong a flush.
func (e *edge) flushSwipes(ctx context.Context, origin string, client *http.Client) (bool, error) {
	var high int64
	if err := e.db.QueryRowContext(ctx, "SELECT coalesce(max(sequence), 0) FROM swipes WHERE delivered = 0").Scan(&high); err != nil {
		return false, err
	}
	if high == 0 {
		return false, e.transaction(ctx, pruneSwipes)
	}
	for {
		var secret string
		err := e.db.QueryRowContext(ctx, "SELECT event_signing_key FROM goal WHERE singleton = 1").Scan(&secret)
		if err != nil {
			return true, err
		}
		key, err := hex.DecodeString(secret)
		if err != nil || len(key) != 32 {
			return true, fmt.Errorf("waiting for event signing key in goal")
		}
		rows, err := e.db.QueryContext(ctx, "SELECT sequence, id, time, controller, fob, allowed FROM swipes WHERE delivered = 0 AND sequence <= ? ORDER BY sequence LIMIT 512", high)
		if err != nil {
			return true, err
		}
		events := []swipe{}
		var last int64
		for rows.Next() {
			var event swipe
			var timestamp int64
			if err = rows.Scan(&last, &event.ID, &timestamp, &event.Controller, &event.Fob, &event.Allowed); err != nil {
				break
			}
			event.Time = time.Unix(0, timestamp).UTC()
			events = append(events, event)
		}
		rowErr := rows.Err()
		rows.Close()
		if err != nil {
			return true, err
		}
		if rowErr != nil {
			return true, rowErr
		}
		if len(events) == 0 {
			return true, nil
		}
		body, err := json.Marshal(events)
		if err != nil {
			return true, err
		}
		// Controller addresses and generated IDs are bounded; 512 events fit easily.
		if len(body) > 256*1024 {
			return true, fmt.Errorf("swipe batch exceeds 256 KiB")
		}
		timestamp := strconv.FormatInt(time.Now().Unix(), 10)
		req, err := http.NewRequestWithContext(ctx, "POST", origin+swipePath, bytes.NewReader(body))
		if err != nil {
			return true, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Edge-Timestamp", timestamp)
		req.Header.Set("X-Edge-Signature", swipeSignature(key, timestamp, body))
		response, err := client.Do(req)
		if err != nil {
			return true, err
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		response.Body.Close()
		if response.StatusCode != http.StatusNoContent {
			return true, fmt.Errorf("Worker swipe response: %d", response.StatusCode)
		}
		if err := e.transaction(ctx, func(tx *sql.Tx) error {
			if _, err := tx.Exec("UPDATE swipes SET delivered = 1 WHERE delivered = 0 AND sequence <= ?", last); err != nil {
				return err
			}
			return pruneSwipes(tx)
		}); err != nil {
			return true, err
		}
		log.Printf("swipe batch delivered events=%d", len(events))
		if last == high {
			return true, nil
		}
	}
}

// ────────────────────────────────────────────────────────────────────────
// LAN kiosk assets and enrollment
// ────────────────────────────────────────────────────────────────────────

const kioskHTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Link your key fob | TheLab</title>
  <link rel="icon" href="/kiosk/favicon.svg">
  <link rel="stylesheet" href="/kiosk/style.css">
  <script src="/kiosk/app.js" defer></script>
</head>
<body class="kiosk-page">
  <div class="kiosk-shell">
    <header class="kiosk-header"><div class="kiosk-brand"><img src="/kiosk/favicon.svg" alt="" width="48" height="48">TheLab<span>Everyone’s makerspace</span></div><span class="kiosk-label">Key fob station</span></header>
    <main id="kiosk" class="kiosk-main" data-state="ready">
      <section id="standby" class="kiosk-standby" aria-label="Link your key fob">
        <div class="kiosk-reader" aria-hidden="true"><svg viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><rect x="24" y="39" width="56" height="40" rx="8" transform="rotate(-12 52 59)"/><circle cx="39" cy="60" r="5"/><path d="M86 43a25 25 0 0 1 0 34M96 33a39 39 0 0 1 0 54"/></svg></div>
        <p class="kiosk-intro">Hold your key fob near the reader<br>to link it to your membership.</p>
      </section>
      <section id="claim" class="kiosk-claim" aria-labelledby="claim-title" hidden>
        <div class="kiosk-claim-copy"><p class="kiosk-eyebrow">One more step</p><h1 id="claim-title">Finish on<br>your phone.</h1><p>Scan this QR code with your phone’s camera, sign in through Discord, then tap <strong>Link fob</strong>.</p><p id="expiry" class="kiosk-expiry"></p><button id="done" type="button" class="btn btn-outline">Cancel / start over</button></div>
        <div class="kiosk-qr-card"><img id="qr" alt="Scan to link your key fob"><p>Your membership. Your key.</p></div>
      </section>
      <div class="kiosk-status"><span class="kiosk-status-dot" aria-hidden="true"></span><p id="status" role="status" aria-live="polite">Ready when you are. Just tap your fob.</p></div>
      <noscript><p class="kiosk-noscript">Enable JavaScript to use the fob reader and display QR codes.</p></noscript>
    </main>
  </div>
</body>
</html>`

//go:embed app.js
var appJS string

const kioskCSS = `:root {
  --color-bg: #0d0d0d; --color-bg-alt: #141414; --color-border: #2a2a2a; --color-border-light: #333;
  --color-accent: #00c853; --color-accent-dark: #009624; --color-accent-glow: rgba(0, 200, 83, .15); --color-accent-subtle: rgba(0, 200, 83, .08);
  --color-heading: #fff; --color-text-muted: #999; --font-heading: system-ui, -apple-system, sans-serif; --font-body: monospace; --radius-lg: 12px;
}
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
.kiosk-page { font-family: var(--font-heading); line-height: 1.7; color: #e0e0e0; background: var(--color-bg); }
.btn { padding: .875rem 2rem; font: 600 .95rem var(--font-heading); border: 2px solid var(--color-border-light); border-radius: 8px; cursor: pointer; color: #e0e0e0; background: transparent; }
.btn:hover, .btn:focus-visible { border-color: var(--color-accent); color: var(--color-accent); }
.kiosk-shell { min-height: 100vh; min-height: 100svh; max-width: 1600px; margin: auto; padding: clamp(1.5rem, 4vw, 4rem); display: flex; flex-direction: column; gap: 2rem; }
.kiosk-header, .kiosk-brand, .kiosk-footer { display: flex; align-items: center; }
.kiosk-header { justify-content: space-between; gap: 1rem; }
.kiosk-brand { gap: .75rem; font-size: 1.8rem; font-weight: 700; color: var(--color-heading); }
.kiosk-brand span { margin-left: 1rem; font-size: .9rem; font-weight: 400; color: var(--color-text-muted); }
.kiosk-label, .kiosk-eyebrow { font-family: var(--font-body); font-size: .8rem; text-transform: uppercase; letter-spacing: .16em; }
.kiosk-label { border: 1px solid var(--color-border-light); border-radius: 999px; padding: .6rem 1rem; color: var(--color-text-muted); }
.kiosk-main { flex: 1; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 2rem; padding: 1rem 0; }
.kiosk-main [hidden] { display: none; }
.kiosk-standby { text-align: center; }
.kiosk-reader { display: grid; place-items: center; width: clamp(130px, 16vh, 190px); aspect-ratio: 1; margin: 0 auto 2rem; color: var(--color-accent); border: 1px solid var(--color-accent-dark); border-radius: 50%; background: var(--color-accent-subtle); box-shadow: 0 0 0 16px rgba(0, 200, 83, .03), 0 0 70px var(--color-accent-subtle); }
.kiosk-reader svg { width: 65%; height: 65%; }
.kiosk-eyebrow { color: var(--color-accent); margin-bottom: 1rem; }
.kiosk-main h1 { font-size: clamp(3rem, 6vw, 6.5rem); line-height: 1.05; letter-spacing: -.045em; color: var(--color-heading); margin: 0 0 1.5rem; }
.kiosk-main h1 span { color: var(--color-accent); }
.kiosk-intro, .kiosk-claim-copy > p:not(.kiosk-eyebrow) { font-size: clamp(1.1rem, 1.6vw, 1.5rem); color: var(--color-text-muted); line-height: 1.6; }
.kiosk-status { display: flex; justify-content: center; align-items: center; gap: .75rem; padding: .9rem 1.5rem; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-bg-alt); text-align: center; max-width: 760px; }
.kiosk-status-dot { flex: 0 0 8px; height: 8px; border-radius: 50%; background: var(--color-accent); box-shadow: 0 0 12px var(--color-accent-glow); }
[data-state="reading"] .kiosk-status-dot { animation: kiosk-pulse 1s ease-in-out infinite; }
[data-state="error"] .kiosk-status-dot { background: #ffb86b; }
#status[role="alert"] { color: #ffb86b; }
.kiosk-claim { display: grid; grid-template-columns: 1fr 1fr; align-items: center; gap: clamp(2rem, 5vw, 6rem); width: 100%; max-width: 1150px; }
.kiosk-claim-copy strong { color: var(--color-heading); }
.kiosk-claim-copy .kiosk-expiry { margin: 1.5rem 0; font-size: 1rem; }
.kiosk-qr-card { background: #fff; color: #333; padding: clamp(1rem, 2vw, 2rem); border-radius: 24px; text-align: center; box-shadow: 0 20px 80px rgba(0, 0, 0, .25); }
#qr { display: block; width: 100%; height: auto; aspect-ratio: 1; }
.kiosk-qr-card p { margin-top: .75rem; font-size: 1rem; }
.kiosk-footer { justify-content: space-between; flex-wrap: wrap; gap: 1.5rem; padding-top: 1.5rem; border-top: 1px solid var(--color-border); color: var(--color-text-muted); font-size: .9rem; }
.kiosk-footer ol { display: flex; flex-wrap: wrap; gap: 1.5rem; list-style: none; }
.kiosk-footer li span { color: var(--color-accent); font-family: var(--font-body); margin-right: .5rem; }
.kiosk-noscript { color: #ffb86b; text-align: center; }
@keyframes kiosk-pulse { 50% { opacity: .3; } }
@media (prefers-reduced-motion: reduce) { [data-state="reading"] .kiosk-status-dot { animation: none; } }
@media (max-width: 700px) {
  .kiosk-brand span { display: none; }
  .kiosk-label { font-size: .65rem; }
  .kiosk-claim { grid-template-columns: 1fr; max-width: 460px; text-align: center; }
  .kiosk-claim h1 br { display: none; }
  .kiosk-footer, .kiosk-footer ol { justify-content: center; text-align: center; }
}`

const kioskIcon = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3121.6 3121.6" role="img" aria-label="TheLab">
  <title>TheLab</title>
  <rect width="3121.6" height="3121.6" rx="561.9" fill="#0D0D0D"/>
  <g fill="#00C853">
    <path d="M300 431.2 820 431.2 820 606.2 475 606.2 475 2515.4 820 2515.4 820 2690.4 300 2690.4Z"/>
    <path d="M2821.6 431.2 2301.6 431.2 2301.6 606.2 2646.6 606.2 2646.6 2515.4 2301.6 2515.4 2301.6 2690.4 2821.6 2690.4Z"/>
  </g>
  <g fill="#FFFFFF">
    <g transform="translate(-1486.2 -4991.3)"><polygon points="2566.2,7296.7 2566.2,5807.5 2847.1,5807.5 2847.1,7041.4 3527.8,7041.4 3527.8,7296.7 "/></g>
  </g>
</svg>`

func kioskHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
}

func kioskAsset(w http.ResponseWriter, r *http.Request) {
	kioskHeaders(w)
	asset := map[string]struct{ contentType, body string }{
		"/kiosk":             {"text/html; charset=utf-8", kioskHTML},
		"/kiosk/app.js":      {"text/javascript; charset=utf-8", appJS},
		"/kiosk/style.css":   {"text/css; charset=utf-8", kioskCSS},
		"/kiosk/favicon.svg": {"image/svg+xml", kioskIcon},
	}[r.URL.Path]
	w.Header().Set("Content-Type", asset.contentType)
	_, _ = io.WriteString(w, asset.body)
}

type kioskClaim struct {
	ID      string `json:"id"`
	Fob     uint32 `json:"fob_id"`
	Created int64  `json:"created"`
	Expires int64  `json:"expires"`
}

func kioskJSON(w http.ResponseWriter, status int, value any) {
	kioskHeaders(w)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func kioskError(w http.ResponseWriter, status int, message string) {
	kioskJSON(w, status, map[string]string{"error": message})
}

func (e *edge) readKioskClaim(w http.ResponseWriter, r *http.Request) *kioskClaim {
	values := r.URL.Query()["token"]
	if len(values) != 1 || len(values[0]) != 64 || strings.Trim(values[0], "0123456789abcdef") != "" {
		kioskError(w, http.StatusGone, "This code is invalid or expired. Scan your fob again.")
		return nil
	}
	var claim kioskClaim
	err := e.db.QueryRowContext(r.Context(), "SELECT id, fob, created, expires FROM kiosk_claims WHERE id = ? AND expires > ?", values[0], time.Now().Unix()).Scan(&claim.ID, &claim.Fob, &claim.Created, &claim.Expires)
	if errors.Is(err, sql.ErrNoRows) {
		kioskError(w, http.StatusGone, "This code expired. Scan your fob again.")
		return nil
	}
	if err != nil {
		kioskError(w, http.StatusServiceUnavailable, "Fob enrollment is temporarily unavailable. Please scan again.")
		return nil
	}
	return &claim
}

// Only the authenticated tunnel listener exposes the fob behind a token.
func (e *edge) getKioskClaim(w http.ResponseWriter, r *http.Request) {
	if claim := e.readKioskClaim(w, r); claim != nil {
		kioskJSON(w, http.StatusOK, claim)
	}
}

func (e *edge) issueKioskClaim(w http.ResponseWriter, r *http.Request) {
	origin, err := url.Parse(r.Header.Get("Origin"))
	if err != nil || origin.Host != r.Host || (origin.Scheme != "http" && origin.Scheme != "https") || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" {
		kioskError(w, http.StatusForbidden, "Reload the kiosk and try again.")
		return
	}
	if strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/json" {
		kioskError(w, http.StatusUnsupportedMediaType, "Fob not recognized. Scan again.")
		return
	}
	var input struct {
		Fob uint32 `json:"fob_id"`
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1024))
	if err != nil || decodeJSON(body, &input) != nil || input.Fob == 0 {
		kioskError(w, http.StatusBadRequest, "Fob not recognized. Scan again.")
		return
	}
	if e.workerAuth == nil {
		kioskError(w, http.StatusServiceUnavailable, "Fob enrollment is not configured. Please ask a member for help.")
		return
	}
	var nonce [32]byte
	_, _ = rand.Read(nonce[:])
	created := time.Now().Unix()
	claim := kioskClaim{hex.EncodeToString(nonce[:]), input.Fob, created, created + 300}
	link := e.workerAuth.issuer + "/keyfob/bind?token=" + claim.ID
	qr, err := qrcode.Encode(link, qrcode.Medium, 512)
	if err == nil {
		err = e.transaction(r.Context(), func(tx *sql.Tx) error {
			if _, err := tx.Exec("DELETE FROM kiosk_claims WHERE expires <= ?", claim.Created); err != nil {
				return err
			}
			return tx.QueryRow(`INSERT INTO kiosk_claims(id, fob, created, expires)
				SELECT ?, ?, ?, ? WHERE (SELECT count(*) FROM kiosk_claims WHERE created > ?) < 30 RETURNING id`,
				claim.ID, claim.Fob, claim.Created, claim.Expires, claim.Created-60).Scan(&claim.ID)
		})
	}
	if errors.Is(err, sql.ErrNoRows) {
		kioskError(w, http.StatusTooManyRequests, "Too many scans. Please wait a minute.")
		return
	}
	if err != nil {
		kioskError(w, http.StatusServiceUnavailable, "Fob enrollment is temporarily unavailable. Please scan again.")
		return
	}
	kioskJSON(w, http.StatusCreated, map[string]any{"token": claim.ID, "url": link, "expires": claim.Expires, "qr": "data:image/png;base64," + base64.StdEncoding.EncodeToString(qr)})
}
