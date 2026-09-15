package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
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
	pushVersion(t, e, 1, "[]", 204)
	if request(cloud, "GET", "/api/goal", "", "Authorization", valid).Code != 200 {
		t.Fatal("valid token rejected")
	}
	e.workerAuth = nil
	if request(cloud, "GET", "/api/swipes", "", "Authorization", valid).Code != 401 {
		t.Fatal("unconfigured API accepted request")
	}
}

func TestWorkerJWTClockSkew(t *testing.T) {
	const issued = int64(1800000000)
	for _, tc := range []struct {
		name      string
		now, nbf  int64
		wantValid bool
	}{
		{"edge clock one second behind", issued - 1, 0, true},
		{"edge clock at skew limit", issued - 5, 0, true},
		{"edge clock beyond skew limit", issued - 6, 0, false},
		{"not before at skew limit", issued, issued + 5, true},
		{"not before beyond skew limit", issued, issued + 6, false},
		{"before expiration", issued + 59, 0, true},
		{"at expiration", issued + 60, 0, false},
		{"after expiration", issued + 61, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := testWorkerAuth()
			claims := testWorkerClaims()
			claims["iat"], claims["exp"], claims["nbf"] = issued, issued+60, tc.nbf
			r := httptest.NewRequest("GET", "/api/swipes", nil)
			r.Header.Set("Authorization", "Bearer "+workerTestToken(claims))
			if got := a.verifyAt(r, tc.now); got != tc.wantValid {
				t.Fatalf("verifyAt(%d) = %t, want %t", tc.now, got, tc.wantValid)
			}
		})
	}
}

func TestWorkerAuthRejectionLogging(t *testing.T) {
	output := captureLogs(t)
	e := testEdge(t)
	_, cloud := e.routes()
	for _, tc := range []struct {
		name, claim string
		value       any
		reason      string
	}{
		{"issuer", "iss", "https://alias.example", `issuer mismatch: got \"https://alias.example\", want CONWAYEDGE_WORKER_ISSUER=\"https://thelab.example\"`},
		{"audience", "aud", "https://other-edge.example", `audience mismatch: got \"https://other-edge.example\", want CONWAYEDGE_PUBLIC_URL=\"https://edge.example\"`},
		{"clock behind", "iat", time.Now().Unix() + 10, "JWT is not yet valid; check edge clock"},
		{"clock ahead", "exp", time.Now().Unix(), "JWT expired; check edge clock or request delay"},
		{"scope", "scope", "private-scope", "invalid JWT subject or scope"},
		{"lifetime", "exp", time.Now().Unix() + 61, "invalid JWT lifetime"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			output.Reset()
			claims := testWorkerClaims()
			// Keep the expired token's lifetime valid so expiration is diagnosed.
			claims["iat"] = time.Now().Unix() - 1
			claims["exp"] = time.Now().Unix() + 59
			claims[tc.claim] = tc.value
			token := workerTestToken(claims)
			response := request(cloud, "GET", "/api/swipes?token=query-secret", "", "Authorization", "Bearer "+token)
			text := output.String()
			if response.Code != 401 || response.Body.String() != "unauthorized\n" || !strings.Contains(text, tc.reason) {
				t.Fatalf("unexpected response or diagnostic: %d %q %s", response.Code, response.Body.String(), text)
			}
			for _, secret := range []string{token, "query-secret", "private-scope"} {
				if strings.Contains(text, secret) {
					t.Fatalf("authentication log exposed %q", secret)
				}
			}
		})
	}
	output.Reset()
	claims := testWorkerClaims()
	claims["iss"] = "unverified-issuer-secret"
	token := workerTestToken(claims)
	e.workerAuth.keys["test"] = ed25519.NewKeyFromSeed(make([]byte, 32)).Public().(ed25519.PublicKey)
	response := request(cloud, "GET", "/api/swipes", "", "Authorization", "Bearer "+token)
	if response.Code != 401 || !strings.Contains(output.String(), "invalid JWT signature") || strings.Contains(output.String(), "unverified-issuer-secret") {
		t.Fatalf("unverified claims were logged or signature failure was not diagnosed: %s", output)
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

type workerTestTransport func(*http.Request) (*http.Response, error)

func (f workerTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestWorkerKeyDownloadRetries(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		a, _ := loadWorkerAuth("https://thelab.example", "https://edge.example")
		var calls atomic.Int32
		a.client.Transport = workerTestTransport(func(r *http.Request) (*http.Response, error) {
			switch calls.Add(1) {
			case 1:
				return nil, fmt.Errorf("network unavailable")
			case 2, 4, 5, 6, 8:
				return &http.Response{StatusCode: 503, Body: io.NopCloser(strings.NewReader("unavailable")), Header: make(http.Header)}, nil
			case 3:
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("invalid JSON")), Header: make(http.Header)}, nil
			default:
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"keys":[{"kid":"test","kty":"OKP","crv":"Ed25519","alg":"EdDSA","use":"sig","x":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"}]}`)), Header: make(http.Header)}, nil
			}
		})
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		done := make(chan struct{})
		go func() { defer close(done); a.run(ctx) }()
		synctest.Wait()
		if calls.Load() != 1 {
			t.Fatalf("startup requests = %d, want 1", calls.Load())
		}
		// Repeated failures back off to one minute; success restores the normal
		// refresh interval and resets the backoff for the next outage.
		for i, delay := range []time.Duration{5 * time.Second, 10 * time.Second, 20 * time.Second, 40 * time.Second, time.Minute, time.Minute, workerKeyRefresh, 5 * time.Second} {
			time.Sleep(delay - time.Nanosecond)
			synctest.Wait()
			if calls.Load() != int32(i+1) {
				t.Fatalf("retry fired early: calls=%d want=%d", calls.Load(), i+1)
			}
			time.Sleep(time.Nanosecond)
			synctest.Wait()
			if calls.Load() != int32(i+2) {
				t.Fatalf("missing retry: calls=%d want=%d", calls.Load(), i+2)
			}
			if calls.Load() == 7 || calls.Load() == 9 {
				r := httptest.NewRequest("GET", "/api/swipes", nil)
				r.Header.Set("Authorization", "Bearer "+workerTestToken(testWorkerClaims()))
				if !a.verify(r) {
					t.Fatal("download retry did not restore authentication")
				}
			}
		}
		cancel()
		synctest.Wait()
		select {
		case <-done:
		default:
			t.Fatal("refresh did not stop on cancellation")
		}
		time.Sleep(workerKeyRefresh)
		if calls.Load() != 9 {
			t.Fatal("download continued after cancellation")
		}
	})
}

func TestWorkerKeyRetryCancellation(t *testing.T) {
	for _, inFlight := range []bool{false, true} {
		t.Run(fmt.Sprintf("in_flight=%t", inFlight), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				a, _ := loadWorkerAuth("https://thelab.example", "https://edge.example")
				var calls atomic.Int32
				a.client.Transport = workerTestTransport(func(r *http.Request) (*http.Response, error) {
					calls.Add(1)
					if inFlight {
						<-r.Context().Done()
						return nil, r.Context().Err()
					}
					return nil, fmt.Errorf("offline")
				})
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				done := make(chan struct{})
				go func() { defer close(done); a.run(ctx) }()
				synctest.Wait()
				cancel()
				synctest.Wait()
				select {
				case <-done:
				default:
					t.Fatal("cancellation did not stop refresh")
				}
				time.Sleep(workerKeyRefresh)
				if calls.Load() != 1 {
					t.Fatalf("unexpected requests: %d", calls.Load())
				}
			})
		})
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
