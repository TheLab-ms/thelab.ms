package main

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestAccessKeyFetchAndRotation(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	kid, calls := "first", 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/cdn-cgi/access/certs" {
			t.Errorf("wrong JWKS path: %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]string{
			"kid": kid, "kty": "RSA", "alg": "RS256", "use": "sig",
			"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
		}}})
	}))
	defer server.Close()
	a := &accessAuth{issuer: server.URL, client: server.Client()}
	if got := a.key(context.Background(), "first"); got == nil || got.N.Cmp(key.N) != 0 {
		t.Fatal("JWKS key not loaded")
	}
	if a.key(context.Background(), "first") == nil || calls != 1 {
		t.Fatal("key cache missed")
	}
	kid = "rotated"
	if a.key(context.Background(), kid) != nil || calls != 1 {
		t.Fatal("unknown key refresh not rate limited")
	}
	a.refreshed = time.Now().Add(-2 * time.Minute)
	if a.key(context.Background(), kid) == nil || calls != 2 {
		t.Fatal("rotation refresh failed")
	}
}

func TestAccessAssertions(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	a, err := loadAccessAuth("https://thelab.cloudflareaccess.com", "machine-api")
	if err != nil {
		t.Fatal(err)
	}
	a.keys = map[string]*rsa.PublicKey{"test": &key.PublicKey}
	a.expires = time.Now().Add(time.Hour)
	a.refreshed = time.Now()
	token := func(issuer, audience string, expires int64) string {
		header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","kid":"test"}`))
		payload, _ := json.Marshal(map[string]any{"iss": issuer, "aud": []string{audience}, "iat": time.Now().Unix() - 10, "exp": expires})
		body := header + "." + base64.RawURLEncoding.EncodeToString(payload)
		digest := sha256.Sum256([]byte(body))
		sig, _ := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
		return body + "." + base64.RawURLEncoding.EncodeToString(sig)
	}
	valid := token(a.issuer, a.audience, time.Now().Unix()+60)
	for _, tc := range []struct {
		token string
		valid bool
	}{
		{valid, true}, {"", false}, {valid + "bad", false},
		{token("https://other.cloudflareaccess.com", a.audience, time.Now().Unix()+60), false},
		{token(a.issuer, "printer-app", time.Now().Unix()+60), false},
		{token(a.issuer, a.audience, time.Now().Unix()-1), false},
	} {
		r := httptest.NewRequest("GET", "/api/swipes", nil)
		r.Header.Set("Cf-Access-Jwt-Assertion", tc.token)
		if a.verify(r) != tc.valid {
			t.Fatalf("unexpected assertion acceptance: %v", tc.valid)
		}
	}
	e := testEdge(t)
	e.accessAuth = a
	_, cloud := e.routes()
	if got := mtlsRequest(cloud, "GET", "/api/swipes", "").Code; got != 401 {
		t.Fatalf("mTLS bypassed Access: %d", got)
	}
	if got := request(cloud, "GET", "/api/swipes", "", "Cf-Access-Jwt-Assertion", valid).Code; got != 200 {
		t.Fatalf("Access rejected: %d", got)
	}
	r := httptest.NewRequest("GET", "/api/swipes", nil)
	r.Header.Add("Cf-Access-Jwt-Assertion", valid)
	r.Header.Add("Cf-Access-Jwt-Assertion", valid)
	if a.verify(r) {
		t.Fatal("duplicate assertions accepted")
	}
	for _, issuer := range []string{"http://thelab.cloudflareaccess.com", "https://evil.example", "https://thelab.cloudflareaccess.com/path"} {
		if _, err := loadAccessAuth(issuer, "aud"); err == nil {
			t.Fatal("invalid issuer accepted")
		}
	}
}
