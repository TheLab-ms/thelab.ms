package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// RFC 8032 test key, also used by the Worker interoperability test.
var testWorkerKey = ed25519.NewKeyFromSeed([]byte{
	0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c, 0xc4,
	0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae, 0x7f, 0x60,
})

func testWorkerAuth() *workerAuth {
	a, _ := loadWorkerAuth("https://thelab.example", "https://edge.example")
	a.keys = map[string]ed25519.PublicKey{"test": testWorkerKey.Public().(ed25519.PublicKey)}
	a.expires, a.attempted = time.Now().Add(time.Hour), time.Now()
	return a
}

func testWorkerClaims() map[string]any {
	return map[string]any{"iss": "https://thelab.example", "aud": "https://edge.example", "sub": "edge-sync", "scope": "edge:api", "iat": time.Now().Unix(), "exp": time.Now().Unix() + 60}
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

func TestWorkerJWTValidation(t *testing.T) {
	a := testWorkerAuth()
	verify := func(token string) bool {
		r := httptest.NewRequest("GET", "/api/swipes", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		return a.verify(r)
	}
	valid := workerTestToken(testWorkerClaims())
	if !verify(valid) {
		t.Fatal("valid JWT rejected")
	}
	for _, tc := range []struct {
		key   string
		value any
	}{
		{"iss", "https://evil.example"}, {"aud", "other"}, {"sub", "member"}, {"scope", "printers:read"},
		{"iat", 0}, {"iat", time.Now().Unix() + 10}, {"iat", 1.5}, {"exp", time.Now().Unix()},
		{"exp", time.Now().Unix() + 61}, {"exp", nil}, {"nbf", time.Now().Unix() + 30},
	} {
		claims := testWorkerClaims()
		claims[tc.key] = tc.value
		if verify(workerTestToken(claims)) {
			t.Fatalf("accepted %s=%v", tc.key, tc.value)
		}
	}
	for _, header := range []any{
		map[string]string{"alg": "none", "typ": "JWT", "kid": "test"},
		map[string]string{"alg": "HS256", "typ": "JWT", "kid": "test"},
		map[string]string{"alg": "EdDSA", "typ": "JWT", "kid": "unknown"},
		map[string]any{"alg": "EdDSA", "typ": "JWT", "kid": "test", "jku": "https://evil.example/keys"},
		map[string]any{"alg": "EdDSA", "typ": "JWT", "kid": "test", "crit": []string{"exp"}},
	} {
		if verify(signWorkerClaims(header, testWorkerClaims())) {
			t.Fatal("accepted invalid header")
		}
	}
	for _, token := range []string{"", "x.y.z", valid + "x", strings.Repeat("a", 4097)} {
		if verify(token) {
			t.Fatal("accepted invalid token")
		}
	}
	a.keys["test"] = ed25519.NewKeyFromSeed(make([]byte, 32)).Public().(ed25519.PublicKey)
	if verify(valid) {
		t.Fatal("wrong signing key accepted")
	}
}

func TestWorkerAuthRoutes(t *testing.T) {
	e := testEdge(t)
	_, cloud := e.routes()
	valid := "Bearer " + workerTestToken(testWorkerClaims())
	for _, headers := range []http.Header{
		nil, {"Authorization": {"Bearer token"}}, {"Authorization": {valid, valid}},
		{"Cf-Cert-Presented": {"true"}, "Cf-Cert-Verified": {"true"}, "Cf-Cert-Revoked": {"false"}},
		{"Cf-Access-Jwt-Assertion": {strings.TrimPrefix(valid, "Bearer ")}},
	} {
		for _, route := range []struct{ method, path, body string }{
			{"PUT", "/api/goal", `{"version":1,"fobs":[1]}`}, {"GET", "/api/swipes", ""},
		} {
			r := httptest.NewRequest(route.method, route.path, strings.NewReader(route.body))
			r.Header = headers.Clone()
			w := httptest.NewRecorder()
			cloud.ServeHTTP(w, r)
			if w.Code != 401 || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("auth bypass", w.Code)
			}
		}
	}
	var count int
	if err := e.db.QueryRow("SELECT count(*) FROM goal").Scan(&count); err != nil || count != 0 {
		t.Fatal("unauthorized mutation")
	}
	if request(cloud, "GET", "/api/swipes", "", "Authorization", valid).Code != 200 {
		t.Fatal("valid token rejected")
	}
	e.workerAuth = nil
	if request(cloud, "GET", "/api/swipes", "", "Authorization", valid).Code != 401 {
		t.Fatal("unconfigured API accepted request")
	}
}

func TestWorkerKeyRefreshAndRotation(t *testing.T) {
	kid, calls, status := "first", 0, 200
	key := base64.RawURLEncoding.EncodeToString(testWorkerKey.Public().(ed25519.PublicKey))
	body := func() string {
		b, _ := json.Marshal(map[string]any{"keys": []any{map[string]string{"kid": kid, "kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig", "x": key}}})
		return string(b)
	}
	var override *string
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/.well-known/edge-jwks.json" {
			t.Error("wrong JWKS URL")
		}
		w.WriteHeader(status)
		if override != nil {
			_, _ = w.Write([]byte(*override))
		} else {
			_, _ = w.Write([]byte(body()))
		}
	}))
	defer server.Close()
	a, _ := loadWorkerAuth(server.URL, "https://edge.example")
	a.client = server.Client()
	ctx := context.Background()
	if a.key(ctx, kid) == nil || calls != 1 {
		t.Fatal("initial fetch failed")
	}
	if a.key(ctx, kid) == nil || calls != 1 {
		t.Fatal("cache missed")
	}
	kid = "rotated"
	if a.key(ctx, kid) != nil || calls != 1 {
		t.Fatal("unknown kid not rate limited")
	}
	a.attempted = time.Now().Add(-time.Minute)
	if a.key(ctx, kid) == nil || calls != 2 {
		t.Fatal("rotation failed")
	}
	if a.key(ctx, "first") != nil {
		t.Fatal("removed key retained")
	}
	status = 503
	expires := a.expires
	a.refreshKeys(ctx)
	if !a.expires.Equal(expires) || a.key(ctx, kid) == nil {
		t.Fatal("outage discarded or extended cache")
	}
	a.expires = time.Now().Add(-time.Second)
	if a.key(ctx, kid) != nil {
		t.Fatal("stale key accepted")
	}
	status = 200
	for _, bad := range []string{"not json", `{"keys":null}`, strings.Repeat("x", 65537), `{"keys":[{"kid":"x","kty":"OKP","crv":"Ed25519","alg":"EdDSA","use":"sig","x":"bad"}]}`} {
		override = &bad
		if a.refresh(ctx) == nil {
			t.Fatal("bad JWKS accepted")
		}
	}
	override = nil
	a.refreshKeys(ctx)
	if a.key(ctx, kid) == nil {
		t.Fatal("did not recover")
	}
	empty := `{"keys":[]}`
	override = &empty
	a.refreshKeys(ctx)
	if a.key(ctx, kid) != nil {
		t.Fatal("empty JWKS did not revoke")
	}
}

func TestWorkerAuthConfiguration(t *testing.T) {
	if a, err := loadWorkerAuth("", ""); a != nil || err != nil {
		t.Fatal("optional config rejected")
	}
	for _, value := range []string{"", "http://thelab.example", "https://thelab.example/", "https://user@thelab.example", "https://thelab.example?x"} {
		if _, err := loadWorkerAuth(value, "https://edge.example"); err == nil {
			t.Fatal("bad issuer accepted")
		}
		if _, err := loadWorkerAuth("https://thelab.example", value); err == nil {
			t.Fatal("bad audience accepted")
		}
	}
}

func TestWorkerPeriodicRefresh(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(`{"keys":[]}`))
	}))
	defer server.Close()
	a, _ := loadWorkerAuth(server.URL, "https://edge.example")
	a.client = server.Client()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); a.runRefresh(ctx, 10*time.Millisecond) }()
	deadline := time.Now().Add(2 * time.Second)
	for calls.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("refresh did not stop")
	}
	if calls.Load() < 2 {
		t.Fatal("no periodic refresh without API traffic")
	}
}

func TestWorkerGeneratedJWT(t *testing.T) {
	// Generated by src/edge-auth.js with the RFC test key and Date.now()=1800000000000.
	const token = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6ImtQcktfcW14VldhWVZBOXd3QkY2SXVvM3ZWeno3VHhIQ1R3WEJ5Z3JTNGsifQ.eyJpc3MiOiJodHRwczovL3RoZWxhYi5leGFtcGxlIiwiYXVkIjoiaHR0cHM6Ly9lZGdlLmV4YW1wbGUiLCJzdWIiOiJlZGdlLXN5bmMiLCJzY29wZSI6ImVkZ2U6YXBpIiwiaWF0IjoxODAwMDAwMDAwLCJleHAiOjE4MDAwMDAwNjB9.c9kUt-WlqySz-RDa62Q4wgwoV9a0XMGole4SYlWp1xJEKBhSKTsERxcoIUMih0TiU2Wa1UodgU7AM8qfz5zjAw"
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"keys":[{"crv":"Ed25519","kty":"OKP","x":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo","kid":"kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k","alg":"EdDSA","use":"sig"}]}`))
	}))
	defer server.Close()
	a, _ := loadWorkerAuth(server.URL, "https://edge.example")
	a.client = server.Client()
	a.refreshKeys(context.Background())
	a.issuer = "https://thelab.example"
	r := httptest.NewRequest("GET", "/api/swipes", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	if !a.verifyAt(r, 1800000001) {
		t.Fatal("Worker JWT and JWKS are not interoperable")
	}
	if a.verifyAt(r, 1800000060) {
		t.Fatal("expired Worker token accepted")
	}
}
