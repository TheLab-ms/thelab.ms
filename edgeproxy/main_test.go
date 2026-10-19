package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

const testKey = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"

// RFC 8032 test key, also used by the Worker interoperability test.
var testWorkerKey = ed25519.NewKeyFromSeed([]byte{
	0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c, 0xc4,
	0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae, 0x7f, 0x60,
})

func testAuth() *workerAuth {
	a, _ := newWorkerAuth("https://thelab.example", "https://edge.example")
	a.keys = map[string]ed25519.PublicKey{"test": testWorkerKey.Public().(ed25519.PublicKey)}
	a.fetched, a.attempted = time.Now(), time.Now()
	return a
}

func testEdge(t *testing.T) *edge {
	t.Helper()
	e, err := openEdge(t.TempDir(), testAuth())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.close)
	return e
}

func restartEdge(t *testing.T, e *edge) *edge {
	t.Helper()
	var path string
	if err := e.db.QueryRow("SELECT file FROM pragma_database_list WHERE name = 'main'").Scan(&path); err != nil {
		t.Fatal(err)
	}
	e.close()
	restarted, err := openEdge(filepath.Dir(path), testAuth())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(restarted.close)
	return restarted
}

func request(handler http.Handler, method, path, body string, headers ...string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	for i := 0; i < len(headers); i += 2 {
		r.Header.Set(headers[i], headers[i+1])
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func testWorkerClaims() map[string]any {
	return map[string]any{"iss": "https://thelab.example", "aud": "https://edge.example", "sub": "edge-sync", "scope": "edge:api", "iat": time.Now().Unix(), "exp": time.Now().Unix() + 60}
}

func printerClaims() map[string]any {
	claims := testWorkerClaims()
	claims["sub"], claims["scope"] = strings.Repeat("a", 32), "printers:read"
	return claims
}

func signWorkerClaims(header any, claims any) string {
	h, _ := json.Marshal(header)
	c, _ := json.Marshal(claims)
	data := base64.RawURLEncoding.EncodeToString(h) + "." + base64.RawURLEncoding.EncodeToString(c)
	return data + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(testWorkerKey, []byte(data)))
}

func workerTestToken(claims any) string {
	return signWorkerClaims(map[string]string{"alg": "EdDSA", "typ": "JWT", "kid": "test"}, claims)
}

func jwtRequest(handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	return request(handler, method, path, body, "Authorization", "Bearer "+workerTestToken(testWorkerClaims()))
}

func pushFobs(t *testing.T, e *edge, revision int, fobs string) {
	t.Helper()
	_, cloud := e.routes()
	if w := jwtRequest(cloud, "PUT", "/api/fobs", fmt.Sprintf(`{"revision":%d,"fobs":%s,"key":%q}`, revision, fobs, testKey)); w.Code != http.StatusNoContent {
		t.Fatalf("push revision %d: %d %s", revision, w.Code, w.Body.String())
	}
}

func storedAccess(t *testing.T, e *edge) (revision int64, fobs, key string) {
	t.Helper()
	if err := e.db.QueryRow("SELECT revision, fobs, key FROM access").Scan(&revision, &fobs, &key); err != nil {
		t.Fatal(err)
	}
	return
}

func countSwipes(t *testing.T, e *edge) int {
	t.Helper()
	var count int
	if err := e.db.QueryRow("SELECT count(*) FROM swipes").Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func execSQL(t *testing.T, e *edge, query string, args ...any) {
	t.Helper()
	if _, err := e.db.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}

// fakeWorker replaces the edge's outbound HTTP client.
type fakeWorker func(*http.Request) (*http.Response, error)

func (f fakeWorker) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func respond(status int, body string, headers ...string) *http.Response {
	response := &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}
	for i := 0; i < len(headers); i += 2 {
		response.Header.Set(headers[i], headers[i+1])
	}
	return response
}

// ────────────────────────────────────────────────────────────────────────
// Door controllers and the authorized fob list
// ────────────────────────────────────────────────────────────────────────

func TestControllerExchange(t *testing.T) {
	e := testEdge(t)
	lan, _ := e.routes()
	poll := func(body string, headers ...string) *httptest.ResponseRecorder {
		return request(lan, "POST", "/api/fobs", body, headers...)
	}
	if w := poll(`[{"fob":5,"allowed":true}]`); w.Code != http.StatusServiceUnavailable || countSwipes(t, e) != 0 {
		t.Fatalf("served or stored without a fob list: %d", w.Code)
	}
	pushFobs(t, e, 3, "[42,7,7]")
	w := poll(`[{"fob":5,"allowed":true},{"fob":4294967295,"allowed":false}]`)
	hash := sha256.Sum256([]byte("7,42,"))
	etag := fmt.Sprintf("%x", hash)
	if w.Code != 200 || w.Body.String() != "[7,42]" || w.Header().Get("Content-Length") != "6" || w.Header().Get("ETag") != etag {
		t.Fatalf("unexpected fob list: %d %q %v", w.Code, w.Body.String(), w.Header())
	}
	if w := poll("[]", "If-None-Match", etag); w.Code != http.StatusNotModified || w.Body.Len() != 0 {
		t.Fatalf("unchanged list not 304: %d", w.Code)
	}
	rows, err := e.db.Query("SELECT controller, fob, allowed FROM swipes ORDER BY sequence")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var controller string
		var fob, allowed int64
		_ = rows.Scan(&controller, &fob, &allowed)
		got = append(got, fmt.Sprintf("%s/%d/%d", controller, fob, allowed))
	}
	if strings.Join(got, ",") != "192.0.2.1/5/1,192.0.2.1/4294967295/0" {
		t.Fatalf("stored swipes: %v", got)
	}
}

func TestControllerValidation(t *testing.T) {
	e := testEdge(t)
	lan, _ := e.routes()
	pushFobs(t, e, 1, "[1]")
	batch := "[" + strings.Repeat(`{"fob":4294967295,"allowed":false},`, 512)
	for _, body := range []string{"", "null", "{}", `{"fob":1,"allowed":true}`, "[] []", "[", batch + `{"fob":1,"allowed":true}]`} {
		if w := request(lan, "POST", "/api/fobs", body); w.Code != http.StatusBadRequest {
			t.Fatalf("accepted %.40q: %d", body, w.Code)
		}
	}
	if countSwipes(t, e) != 0 {
		t.Fatal("rejected batch stored swipes")
	}
	// Invalid swipes are dropped without failing the batch, so the
	// controller still receives its fob list.
	if w := request(lan, "POST", "/api/fobs", `[{"fob":0,"allowed":true},{"fob":1},{"fob":1,"allowed":"yes"},{"fob":-1,"allowed":true},`+
		`{"fob":1,"allowed":true,"extra":1},null,7,{"fob":9,"allowed":true}]`); w.Code != 200 || w.Body.String() != "[1]" || countSwipes(t, e) != 1 {
		t.Fatalf("mixed batch: %d %q, %d swipes", w.Code, w.Body.String(), countSwipes(t, e))
	}
	if w := request(lan, "POST", "/api/fobs", strings.TrimSuffix(batch, ",")+"]"); w.Code != 200 || countSwipes(t, e) != 513 {
		t.Fatalf("maximum batch rejected: %d", w.Code)
	}
	if w := request(lan, "GET", "/api/fobs", ""); w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET controller route: %d", w.Code)
	}
}

func TestFobPushRevisions(t *testing.T) {
	e := testEdge(t)
	_, cloud := e.routes()
	pushFobs(t, e, 5, "[3,1,2,1]")
	pushFobs(t, e, 4, "[9]")
	if revision, fobs, key := storedAccess(t, e); revision != 5 || fobs != "[1,2,3]" || key != testKey {
		t.Fatalf("older revision changed the list: %d %s", revision, fobs)
	}
	pushFobs(t, e, 5, "[4]")
	pushFobs(t, e, 6, "[]")
	if revision, fobs, _ := storedAccess(t, e); revision != 6 || fobs != "[]" {
		t.Fatalf("newer revision not stored: %d %s", revision, fobs)
	}
	newKey := strings.Repeat("ab", 32)
	if w := jwtRequest(cloud, "PUT", "/api/fobs", fmt.Sprintf(`{"revision":2,"fobs":[8],"key":%q}`, newKey)); w.Code != 204 {
		t.Fatal(w.Code)
	}
	if revision, fobs, key := storedAccess(t, e); revision != 6 || fobs != "[]" || key != newKey {
		t.Fatal("key from an older revision was not stored", revision, fobs, key)
	}
	tooMany := "[" + strings.Repeat("1,", 512) + "1]"
	for _, body := range []string{
		`{"fobs":[],"key":"` + testKey + `"}`, `{"revision":-1,"fobs":[],"key":"` + testKey + `"}`,
		`{"revision":1.5,"fobs":[],"key":"` + testKey + `"}`, `{"revision":7,"key":"` + testKey + `"}`,
		`{"revision":7,"fobs":[0],"key":"` + testKey + `"}`, `{"revision":7,"fobs":[4294967296],"key":"` + testKey + `"}`,
		`{"revision":7,"fobs":` + tooMany + `,"key":"` + testKey + `"}`, `{"revision":7,"fobs":[]}`,
		`{"revision":7,"fobs":[],"key":"` + strings.ToUpper(testKey) + `"}`, `{"revision":7,"fobs":[],"key":"` + testKey + `0"}`,
		`{"revision":7,"fobs":[],"key":"` + testKey + `","extra":1}`,
	} {
		if w := jwtRequest(cloud, "PUT", "/api/fobs", body); w.Code != http.StatusBadRequest {
			t.Fatalf("accepted %s: %d", body, w.Code)
		}
	}
	if revision, _, _ := storedAccess(t, e); revision != 6 {
		t.Fatal("invalid push changed state")
	}
	e = restartEdge(t, e)
	if revision, fobs, _ := storedAccess(t, e); revision != 6 || fobs != "[]" || !e.lastPush.IsZero() {
		t.Fatal("restart lost the list or kept the push time", revision, fobs)
	}
}

// ────────────────────────────────────────────────────────────────────────
// Worker authentication
// ────────────────────────────────────────────────────────────────────────

func TestWorkerTokens(t *testing.T) {
	a := testAuth()
	verify := func(token, scope string) bool {
		r := httptest.NewRequest("GET", "/", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		return a.verify(r, scope)
	}
	if !verify(workerTestToken(testWorkerClaims()), "edge:api") || !verify(workerTestToken(printerClaims()), "printers:read") {
		t.Fatal("valid tokens rejected")
	}
	if verify(workerTestToken(testWorkerClaims()), "printers:read") || verify(workerTestToken(printerClaims()), "edge:api") {
		t.Fatal("token accepted for another scope")
	}
	now := time.Now().Unix()
	for _, tc := range []struct {
		key   string
		value any
	}{
		{"iss", "https://evil.example"}, {"aud", "https://other.example"}, {"scope", "edge:api printers:read"}, {"scope", nil},
		{"iat", now + 6}, {"iat", 1.5}, {"exp", now}, {"exp", now + 61}, {"exp", nil}, {"iat", nil},
	} {
		claims := testWorkerClaims()
		claims[tc.key] = tc.value
		if verify(workerTestToken(claims), "edge:api") {
			t.Fatalf("accepted %s=%v", tc.key, tc.value)
		}
	}
	skewed := testWorkerClaims()
	skewed["iat"], skewed["exp"] = now+5, now+60
	if !verify(workerTestToken(skewed), "edge:api") {
		t.Fatal("five seconds of issue-time skew rejected")
	}
	for _, header := range []any{
		map[string]string{"alg": "none", "kid": "test"}, map[string]string{"alg": "HS256", "kid": "test"},
		map[string]string{"alg": "EdDSA", "kid": "unknown"}, map[string]string{"alg": "EdDSA"},
	} {
		if verify(signWorkerClaims(header, testWorkerClaims()), "edge:api") {
			t.Fatalf("accepted header %v", header)
		}
	}
	valid := workerTestToken(testWorkerClaims())
	for _, token := range []string{"", "x.y.z", valid + "x", valid + ".x", strings.Repeat("a", 4097)} {
		if verify(token, "edge:api") {
			t.Fatal("accepted malformed token")
		}
	}
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Authorization", "bearer "+valid)
	if a.verify(r, "edge:api") {
		t.Fatal("accepted a non-Bearer scheme")
	}
	a.keys["test"] = ed25519.NewKeyFromSeed(make([]byte, 32)).Public().(ed25519.PublicKey)
	if verify(valid, "edge:api") {
		t.Fatal("wrong signing key accepted")
	}
}

func TestWorkerKeyDownload(t *testing.T) {
	var downloads atomic.Int32
	var mu sync.Mutex
	jwks := func(kid string) string {
		return fmt.Sprintf(`{"keys":[{"kid":%q,"kty":"OKP","crv":"Ed25519","x":%q},{"kid":"rsa","kty":"RSA","x":"AQAB"}]}`,
			kid, base64.RawURLEncoding.EncodeToString(testWorkerKey.Public().(ed25519.PublicKey)))
	}
	body, status := jwks("test"), 200
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		downloads.Add(1)
		mu.Lock()
		defer mu.Unlock()
		if r.URL.Path != "/.well-known/edge-jwks.json" {
			t.Errorf("unexpected JWKS path %s", r.URL.Path)
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()
	a, err := newWorkerAuth(server.URL, "https://edge.example")
	if err != nil {
		t.Fatal(err)
	}
	a.client = server.Client()
	claims := testWorkerClaims()
	claims["iss"] = server.URL
	verify := func(kid string) bool {
		r := httptest.NewRequest("GET", "/", nil)
		r.Header.Set("Authorization", "Bearer "+signWorkerClaims(map[string]string{"alg": "EdDSA", "kid": kid}, claims))
		return a.verify(r, "edge:api")
	}
	if !verify("test") || !verify("test") || downloads.Load() != 1 {
		t.Fatalf("keys not downloaded once on demand: %d", downloads.Load())
	}
	if verify("rotated") || verify("rotated") || downloads.Load() != 1 {
		t.Fatal("unknown key IDs must not download more than once a minute")
	}
	mu.Lock()
	body = jwks("rotated")
	mu.Unlock()
	a.attempted = time.Now().Add(-keyRetry)
	if !verify("rotated") || verify("test") || downloads.Load() != 2 {
		t.Fatal("rotated key not picked up after the retry interval")
	}
	// Failed refreshes keep recent keys but never extend their lifetime.
	mu.Lock()
	status = 500
	mu.Unlock()
	a.fetched, a.attempted = time.Now().Add(-keyRefresh-time.Second), time.Now().Add(-keyRetry)
	if !verify("rotated") || downloads.Load() != 3 {
		t.Fatal("failed refresh discarded recent keys")
	}
	a.fetched, a.attempted = time.Now().Add(-keyMaxAge-time.Second), time.Now().Add(-keyRetry)
	if verify("rotated") {
		t.Fatal("expired keys trusted after failed refresh")
	}
	for _, value := range []string{"", "http://thelab.example", "https://thelab.example/", "https://user@thelab.example"} {
		if _, err := newWorkerAuth(value, "https://edge.example"); err == nil {
			t.Fatalf("accepted issuer %q", value)
		}
		if _, err := newWorkerAuth("https://thelab.example", value); err == nil {
			t.Fatalf("accepted audience %q", value)
		}
	}
}

func TestWorkerGeneratedJWT(t *testing.T) {
	// Generated by site/src/edge.js with the RFC test key and Date.now()=1800000000000.
	const token = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6ImtQcktfcW14VldhWVZBOXd3QkY2SXVvM3ZWeno3VHhIQ1R3WEJ5Z3JTNGsifQ.eyJpc3MiOiJodHRwczovL3RoZWxhYi5leGFtcGxlIiwiYXVkIjoiaHR0cHM6Ly9lZGdlLmV4YW1wbGUiLCJzdWIiOiJlZGdlLXN5bmMiLCJzY29wZSI6ImVkZ2U6YXBpIiwiaWF0IjoxODAwMDAwMDAwLCJleHAiOjE4MDAwMDAwNjB9.c9kUt-WlqySz-RDa62Q4wgwoV9a0XMGole4SYlWp1xJEKBhSKTsERxcoIUMih0TiU2Wa1UodgU7AM8qfz5zjAw"
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"keys":[{"crv":"Ed25519","kty":"OKP","x":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo","kid":"kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k","alg":"EdDSA","use":"sig"}]}`))
	}))
	defer server.Close()
	a, _ := newWorkerAuth(server.URL, "https://edge.example")
	a.client = server.Client()
	if a.key("kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k") == nil {
		t.Fatal("Worker JWKS not accepted")
	}
	a.issuer = "https://thelab.example"
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	defer func() { clock = time.Now }()
	clock = func() time.Time { return time.Unix(1800000001, 0) }
	if !a.verify(r, "edge:api") {
		t.Fatal("Worker JWT and JWKS are not interoperable")
	}
	clock = func() time.Time { return time.Unix(1800000060, 0) }
	if a.verify(r, "edge:api") {
		t.Fatal("expired Worker token accepted")
	}
}

func TestTunnelRoutes(t *testing.T) {
	e := testEdge(t)
	lan, cloud := e.routes()
	edgeToken, printerToken := "Bearer "+workerTestToken(testWorkerClaims()), "Bearer "+workerTestToken(printerClaims())
	for _, tc := range []struct {
		method, path, auth string
		want               int
	}{
		{"PUT", "/api/fobs", "", 401}, {"PUT", "/api/fobs", printerToken, 401}, {"PUT", "/api/fobs", edgeToken, 400},
		{"GET", "/api/printers", "", 401}, {"GET", "/api/printers", edgeToken, 401}, {"GET", "/api/printers", printerToken, 200},
		{"GET", "/machines/images/missing.jpg", edgeToken, 401}, {"GET", "/machines/images/missing.jpg", printerToken, 404},
		{"POST", "/api/printers", printerToken, 405}, {"GET", "/api/goal", edgeToken, 404}, {"GET", "/api/goal", printerToken, 401},
		{"GET", "/api/kiosk/claim", edgeToken, 404}, {"POST", "/api/fobs", edgeToken, 405}, {"GET", "/", edgeToken, 404},
		{"GET", "/kiosk", edgeToken, 404},
	} {
		w := request(cloud, tc.method, tc.path, "", "Authorization", tc.auth)
		if w.Code != tc.want || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s %s: %d, want %d", tc.method, tc.path, w.Code, tc.want)
		}
	}
	for _, path := range []string{"/api/printers", "/machines/images/camera.jpg"} {
		w := request(cloud, "OPTIONS", path, "", "Origin", "https://thelab.example", "Access-Control-Request-Method", "GET", "Access-Control-Request-Headers", "authorization")
		if w.Code != 204 || w.Header().Get("Access-Control-Allow-Origin") != "https://thelab.example" ||
			w.Header().Get("Access-Control-Allow-Headers") != "Authorization" || w.Header().Get("Access-Control-Allow-Methods") != "GET" ||
			w.Header().Get("Access-Control-Allow-Credentials") != "" {
			t.Fatalf("preflight %s: %d %v", path, w.Code, w.Header())
		}
		if w := request(cloud, "GET", path, "", "Authorization", "Bearer x"); w.Code != 401 || w.Header().Get("Access-Control-Allow-Origin") != "https://thelab.example" {
			t.Fatal("printer denial unreadable by the dashboard")
		}
	}
	if w := request(cloud, "OPTIONS", "/api/fobs", ""); w.Code != 401 || w.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("Worker API allows cross-origin access")
	}
	for _, path := range []string{"/api/printers", "/machines/images/x.jpg"} {
		if w := request(lan, "GET", path, ""); w.Code != 404 {
			t.Fatalf("printer data exposed on LAN: %s %d", path, w.Code)
		}
	}
	if w := request(lan, "PUT", "/api/fobs", "{}"); w.Code != 405 {
		t.Fatal("fob push exposed on LAN")
	}
}

// ────────────────────────────────────────────────────────────────────────
// Swipe upload and sync requests
// ────────────────────────────────────────────────────────────────────────

func addSwipes(t *testing.T, e *edge, count int) {
	t.Helper()
	lan, _ := e.routes()
	body := "[" + strings.TrimSuffix(strings.Repeat(`{"fob":7,"allowed":true},`, count), ",") + "]"
	if w := request(lan, "POST", "/api/fobs", body); w.Code != 200 {
		t.Fatalf("store swipes: %d", w.Code)
	}
}

func TestUploadSwipes(t *testing.T) {
	e := testEdge(t)
	var mu sync.Mutex
	var batches [][]swipe
	status := 500
	e.client.Transport = fakeWorker(func(r *http.Request) (*http.Response, error) {
		mu.Lock()
		defer mu.Unlock()
		if r.Method != "POST" || r.URL.String() != "https://thelab.example/webhooks/edge/swipes" ||
			r.Header.Get("Authorization") != "Bearer "+testKey || r.Header.Get("X-Edge-Revision") != "9" || r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("unexpected upload: %s %s %v", r.Method, r.URL, r.Header)
		}
		var batch []swipe
		if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
			t.Error(err)
		}
		batches = append(batches, batch)
		return respond(status, ""), nil
	})
	if err := e.uploadSwipes(context.Background()); err != nil || len(batches) != 0 {
		t.Fatal("uploaded without a key", err)
	}
	pushFobs(t, e, 9, "[7]")
	addSwipes(t, e, 512)
	addSwipes(t, e, 1)
	if err := e.uploadSwipes(context.Background()); err == nil || countSwipes(t, e) != 513 {
		t.Fatal("failed upload deleted swipes", err)
	}
	status = 204
	if err := e.uploadSwipes(context.Background()); err != nil || countSwipes(t, e) != 0 {
		t.Fatal("successful upload kept swipes", err)
	}
	if len(batches) != 3 || len(batches[1]) != 512 || len(batches[2]) != 1 || batches[1][0].ID != batches[0][0].ID {
		t.Fatalf("unexpected batches: %d", len(batches))
	}
	first := batches[1][0]
	if first.Controller != "192.0.2.1" || first.Fob != 7 || !first.Allowed || first.Time.Location() != time.UTC || time.Since(first.Time) > time.Minute {
		t.Fatalf("unexpected event: %+v", first)
	}
	e.lastPush = time.Now()
	status = 401
	addSwipes(t, e, 1)
	if err := e.uploadSwipes(context.Background()); err == nil || countSwipes(t, e) != 1 || !e.lastPush.IsZero() {
		t.Fatal("rejected key did not mark the edge stale")
	}
}

func TestLegacySwipeOutbox(t *testing.T) {
	e := testEdge(t)
	execSQL(t, e, "DROP TABLE swipes")
	execSQL(t, e, `CREATE TABLE swipes (sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, time INTEGER NOT NULL,
		controller TEXT NOT NULL, fob INTEGER NOT NULL, allowed INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0)`)
	execSQL(t, e, "INSERT INTO swipes(id, time, controller, fob, allowed, delivered) VALUES ('old', 1, 'door', 7, 1, 1), ('pending', 2, 'door', 8, 0, 0)")
	execSQL(t, e, "CREATE TABLE goal (singleton INTEGER PRIMARY KEY, version INTEGER, fobs TEXT, event_signing_key TEXT)")
	e = restartEdge(t, e)
	var goal int
	if err := e.db.QueryRow("SELECT count(*) FROM sqlite_master WHERE name = 'goal'").Scan(&goal); err != nil || goal != 0 {
		t.Fatal("obsolete goal table kept", err)
	}
	pushFobs(t, e, 1, "[7]")
	addSwipes(t, e, 1)
	var ids []string
	e.client.Transport = fakeWorker(func(r *http.Request) (*http.Response, error) {
		var batch []swipe
		_ = json.NewDecoder(r.Body).Decode(&batch)
		for _, event := range batch {
			ids = append(ids, event.ID)
		}
		return respond(204, ""), nil
	})
	if err := e.uploadSwipes(context.Background()); err != nil || len(ids) != 3 || ids[0] != "old" || ids[1] != "pending" || countSwipes(t, e) != 0 {
		t.Fatalf("legacy outbox not uploaded: %v %v", ids, err)
	}
}

func TestSyncRequests(t *testing.T) {
	e := testEdge(t)
	var requests atomic.Int32
	e.client.Transport = fakeWorker(func(r *http.Request) (*http.Response, error) {
		if r.Method != "POST" || r.URL.String() != "https://thelab.example/webhooks/edge/sync" || r.Header.Get("Authorization") != "" || r.Body != nil {
			t.Errorf("unexpected sync request: %s %s", r.Method, r.URL)
		}
		requests.Add(1)
		return respond(202, ""), nil
	})
	ctx := context.Background()
	e.requestSyncIfStale(ctx)
	e.requestSyncIfStale(ctx)
	if requests.Load() != 1 {
		t.Fatalf("startup sync requests: %d", requests.Load())
	}
	e.lastSyncRequest = time.Now().Add(-syncSpace)
	e.requestSyncIfStale(ctx)
	if requests.Load() != 2 {
		t.Fatal("stale edge did not ask again after the spacing interval")
	}
	pushFobs(t, e, 1, "[]")
	e.lastSyncRequest = time.Time{}
	e.requestSyncIfStale(ctx)
	if requests.Load() != 2 {
		t.Fatal("fresh edge requested a sync")
	}
	e.lastPush = time.Now().Add(-syncStale - time.Second)
	e.requestSyncIfStale(ctx)
	if requests.Load() != 3 {
		t.Fatal("silent edge did not request a sync")
	}
}

func TestBackgroundLoop(t *testing.T) {
	e := testEdge(t)
	uploads, syncs := make(chan int, 10), make(chan struct{}, 10)
	e.client.Transport = fakeWorker(func(r *http.Request) (*http.Response, error) {
		if strings.HasSuffix(r.URL.Path, "/sync") {
			syncs <- struct{}{}
			return respond(202, ""), nil
		}
		var batch []swipe
		_ = json.NewDecoder(r.Body).Decode(&batch)
		uploads <- len(batch)
		return respond(204, ""), nil
	})
	pushFobs(t, e, 1, "[7]")
	addSwipes(t, e, 2)
	e.lastPush = time.Time{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { e.run(ctx); close(done) }()
	defer func() { cancel(); <-done }()
	wait := func(name string, ch any) {
		t.Helper()
		select {
		case <-ch.(chan struct{}):
		case <-time.After(5 * time.Second):
			t.Fatalf("%s did not happen", name)
		}
	}
	wait("startup sync request", syncs)
	for _, want := range []int{2, 1} {
		select {
		case got := <-uploads:
			if got != want {
				t.Fatalf("uploaded %d swipes, want %d", got, want)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("swipes were not uploaded")
		}
		addSwipes(t, e, 1) // A new swipe wakes the sender.
	}
}

// ────────────────────────────────────────────────────────────────────────
// LAN kiosk proxy
// ────────────────────────────────────────────────────────────────────────

func TestKioskProxy(t *testing.T) {
	e := testEdge(t)
	lan, _ := e.routes()
	var forwarded []*http.Request
	var bodies []string
	e.client.Transport = fakeWorker(func(r *http.Request) (*http.Response, error) {
		body := ""
		if r.Body != nil {
			data, err := io.ReadAll(r.Body)
			if err != nil {
				return nil, err
			}
			body = string(data)
		}
		forwarded, bodies = append(forwarded, r), append(bodies, body)
		return respond(201, `{"token":"t"}`, "Content-Type", "application/json", "Content-Security-Policy", "default-src 'none'", "Set-Cookie", "x=y", "Location", "https://other.example"), nil
	})
	if w := request(lan, "POST", "/kiosk/claims", `{"fob_id":7}`, "Content-Type", "application/json"); w.Code != 503 || len(forwarded) != 0 {
		t.Fatal("kiosk forwarded before the edge has its key")
	}
	pushFobs(t, e, 1, "[]")
	for _, path := range []string{"/kiosk", "/kiosk/app.js", "/kiosk/style.css", "/assets/favicon.svg"} {
		if w := request(lan, "GET", path, ""); w.Code != 201 {
			t.Fatalf("%s not forwarded: %d", path, w.Code)
		}
	}
	w := request(lan, "POST", "/kiosk/claims", `{"fob_id":7}`, "Content-Type", "application/json", "Authorization", "Bearer forged", "Cookie", "c=d")
	if w.Code != 201 || w.Body.String() != `{"token":"t"}` || w.Header().Get("Content-Type") != "application/json" ||
		w.Header().Get("Content-Security-Policy") != "default-src 'none'" || w.Header().Get("Set-Cookie") != "" || w.Header().Get("Location") != "" {
		t.Fatalf("unexpected kiosk response: %d %v", w.Code, w.Header())
	}
	last := forwarded[len(forwarded)-1]
	if last.Method != "POST" || last.URL.String() != "https://thelab.example/kiosk/claims" || last.Header.Get("Authorization") != "Bearer "+testKey ||
		last.Header.Get("Content-Type") != "application/json" || last.Header.Get("Cookie") != "" || bodies[len(bodies)-1] != `{"fob_id":7}` {
		t.Fatalf("unexpected forwarded request: %s %s %v", last.Method, last.URL, last.Header)
	}
	for i, path := range []string{"/kiosk", "/kiosk/app.js", "/kiosk/style.css", "/assets/favicon.svg"} {
		if forwarded[i].URL.String() != "https://thelab.example"+path || forwarded[i].Method != "GET" {
			t.Fatalf("forwarded %s as %s", path, forwarded[i].URL)
		}
	}
	count := len(forwarded)
	for _, tc := range []struct{ method, path string }{
		{"GET", "/kiosk/"}, {"GET", "/kiosk/other.js"}, {"GET", "/kiosk/../webhooks/edge/swipes"}, {"GET", "/kiosk/%2e%2e/webhooks/edge/swipes"},
		{"POST", "/kiosk/claims/../../webhooks/edge/swipes"}, {"POST", "/webhooks/edge/swipes"}, {"POST", "/kiosk"}, {"GET", "/kiosk/claims"},
		{"GET", "/assets/other.svg"}, {"GET", "/kiosk?x=../webhooks"},
	} {
		w := request(lan, tc.method, tc.path, "")
		if tc.path == "/kiosk?x=../webhooks" {
			if w.Code != 201 || forwarded[len(forwarded)-1].URL.String() != "https://thelab.example/kiosk" {
				t.Fatal("query string forwarded")
			}
			count++
			continue
		}
		if w.Code < 300 || len(forwarded) != count {
			t.Fatalf("%s %s forwarded: %d", tc.method, tc.path, w.Code)
		}
	}
	if w := request(lan, "POST", "/kiosk/claims", strings.Repeat("x", 1025)); w.Code == 201 {
		t.Fatal("oversized kiosk body forwarded")
	}
	e.client.Transport = fakeWorker(func(*http.Request) (*http.Response, error) { return nil, io.ErrUnexpectedEOF })
	if w := request(lan, "POST", "/kiosk/claims", "{}"); w.Code != http.StatusBadGateway || !json.Valid(bytes.TrimSpace(w.Body.Bytes())) {
		t.Fatalf("unreachable Worker: %d %s", w.Code, w.Body.String())
	}
}

// ────────────────────────────────────────────────────────────────────────
// Storage
// ────────────────────────────────────────────────────────────────────────

func TestStorageFailures(t *testing.T) {
	e := testEdge(t)
	lan, _ := e.routes()
	pushFobs(t, e, 1, "[7]")
	execSQL(t, e, "PRAGMA query_only = ON")
	if w := request(lan, "POST", "/api/fobs", `[{"fob":1,"allowed":true}]`); w.Code != 500 {
		t.Fatalf("failed swipe write acknowledged: %d", w.Code)
	}
	_, cloud := e.routes()
	if w := jwtRequest(cloud, "PUT", "/api/fobs", fmt.Sprintf(`{"revision":2,"fobs":[],"key":%q}`, testKey)); w.Code != 500 {
		t.Fatalf("failed push acknowledged: %d", w.Code)
	}
	execSQL(t, e, "PRAGMA query_only = OFF")
	if countSwipes(t, e) != 0 {
		t.Fatal("partial batch stored")
	}
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, "edge.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE TABLE printer_config (singleton INTEGER PRIMARY KEY, config TEXT); INSERT INTO printer_config VALUES (1, 'not json')"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if _, err := openEdge(dir, testAuth()); err == nil {
		t.Fatal("corrupt printer configuration accepted")
	}
}
