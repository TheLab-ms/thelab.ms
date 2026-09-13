package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func memberTestAuth(t *testing.T, e *edge) ed25519.PrivateKey {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(public)
	e.memberAuth, err = loadPrinterAuth("https://thelab.example", "https://edge.example", base64.StdEncoding.EncodeToString(der))
	if err != nil {
		t.Fatal(err)
	}
	return private
}

func testMemberClaims() map[string]any {
	return map[string]any{"iss": "https://thelab.example", "aud": "https://edge.example", "sub": "333333333333333333", "active_member": true, "scope": "printers:read", "state": strings.Repeat("a", 64), "iat": time.Now().Unix(), "exp": time.Now().Unix() + 300}
}

func signMemberClaims(private ed25519.PrivateKey, header any, claims map[string]any) string {
	h, _ := json.Marshal(header)
	c, _ := json.Marshal(claims)
	data := base64.RawURLEncoding.EncodeToString(h) + "." + base64.RawURLEncoding.EncodeToString(c)
	return data + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, []byte(data)))
}

func memberTestToken(private ed25519.PrivateKey, claims map[string]any) string {
	return signMemberClaims(private, map[string]string{"alg": "EdDSA", "typ": "JWT"}, claims)
}

func TestPrinterJWTValidation(t *testing.T) {
	e := testEdge(t)
	private := memberTestAuth(t, e)
	valid := memberTestToken(private, testMemberClaims())
	if e.memberAuth.verify(valid) == nil {
		t.Fatal("valid JWT rejected")
	}
	for _, test := range []struct {
		key   string
		value any
	}{
		{"iss", "https://evil.example"}, {"aud", "member"}, {"sub", ""}, {"sub", "0"},
		{"active_member", false}, {"active_member", "true"}, {"active_member", nil},
		{"scope", "admin"}, {"state", "bad"}, {"iat", time.Now().Unix() + 20},
		{"iat", 0}, {"iat", 1.5}, {"exp", time.Now().Unix()}, {"exp", time.Now().Unix() + 301}, {"exp", nil},
	} {
		claims := testMemberClaims()
		claims[test.key] = test.value
		if e.memberAuth.verify(memberTestToken(private, claims)) != nil {
			t.Fatalf("accepted %s=%v", test.key, test.value)
		}
	}
	for _, header := range []any{
		map[string]string{"alg": "HS256", "typ": "JWT"}, map[string]string{"alg": "none", "typ": "JWT"},
		map[string]any{"alg": "EdDSA", "typ": "JWT", "crit": []string{"exp"}},
	} {
		if e.memberAuth.verify(signMemberClaims(private, header, testMemberClaims())) != nil {
			t.Fatal("accepted invalid JWT header")
		}
	}
	_, wrongKey, _ := ed25519.GenerateKey(rand.Reader)
	for _, token := range []string{"", "x.y.z", valid + "x", strings.Repeat("a", 4097), memberTestToken(wrongKey, testMemberClaims())} {
		if e.memberAuth.verify(token) != nil {
			t.Fatal("accepted malformed/forged JWT")
		}
	}
}

func TestPrinterBrowserHandoff(t *testing.T) {
	e := testEdge(t)
	private := memberTestAuth(t, e)
	lan, cloud := e.routes()
	if w := request(lan, "GET", "/machines", ""); w.Code != 404 {
		t.Fatal("member page exposed on LAN")
	}
	w := request(cloud, "GET", "/machines", "")
	if w.Code != 303 || w.Header().Get("Location") != "/machines/login" {
		t.Fatal("missing session did not start login")
	}
	w = request(cloud, "GET", "/machines/login", "")
	location, _ := url.Parse(w.Header().Get("Location"))
	nonce := w.Result().Cookies()[0]
	if location.Scheme+"://"+location.Host+location.Path != "https://thelab.example/machines" || location.Query().Get("state") != nonce.Value || !noncePattern.MatchString(nonce.Value) || !nonce.HttpOnly || !nonce.Secure || nonce.Domain != "" {
		t.Fatal("invalid nonce handoff")
	}
	claims := testMemberClaims()
	claims["state"] = nonce.Value
	token := memberTestToken(private, claims)
	body, _ := json.Marshal(map[string]string{"token": token})
	for _, test := range []struct {
		origin, cookie string
		want           int
	}{
		{"https://evil.example", nonce.String(), 403}, {"", nonce.String(), 403},
		{"https://edge.example", "", 401}, {"https://edge.example", printerNonceCookie + "=wrong", 401},
		{"https://edge.example", nonce.String(), 204},
	} {
		w = request(cloud, "POST", "/machines/session", string(body), "Origin", test.origin, "Cookie", test.cookie)
		if w.Code != test.want {
			t.Fatalf("session: got %d want %d: %s", w.Code, test.want, w.Body.String())
		}
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 2 || cookies[0].Name != printerCookie || !cookies[0].Secure || !cookies[0].HttpOnly || cookies[0].Path != "/" || cookies[0].Domain != "" || cookies[0].MaxAge > 300 || cookies[1].MaxAge != -1 {
		t.Fatal("unsafe session cookies")
	}
	w = request(cloud, "GET", "/machines", "", "Cookie", printerCookie+"="+token)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "<h1>Machines</h1>") || w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Body.String(), fmt.Sprintf(`data-expires="%v"`, claims["exp"])) {
		t.Fatal("member dashboard unavailable")
	}
	for _, path := range []string{"/machines/content", "/machines/images/camera.jpg"} {
		if w := mtlsRequest(cloud, "GET", path, ""); w.Code != 401 {
			t.Fatalf("mTLS bypasses member JWT: %s %d", path, w.Code)
		}
	}
	if w := request(cloud, "GET", "/api/swipes", "", "Cookie", printerCookie+"="+token); w.Code != 401 {
		t.Fatal("member JWT bypasses machine auth")
	}
	for _, path := range []string{"/machines/callback", "/machines/app.js"} {
		w := request(cloud, "GET", path, "")
		if w.Code != 200 || w.Body.Len() == 0 || w.Header().Get("Content-Security-Policy") == "" {
			t.Fatalf("public handoff resource unavailable: %s: %d", path, w.Code)
		}
	}
	if w := request(cloud, "GET", "/machines/images/camera.png", "", "Cookie", printerCookie+"="+token); w.Code != 404 {
		t.Fatal("unsupported image suffix accepted")
	}
	for _, path := range []string{"/api/printers", "/api/printers/camera/snapshot.jpg"} {
		if w := mtlsRequest(cloud, "GET", path, ""); w.Code != 404 {
			t.Fatal("old printer API remains")
		}
	}
}

func TestPrinterPageAndProtectedSnapshot(t *testing.T) {
	e := testEdge(t)
	private := memberTestAuth(t, e)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	e.printers.printers = map[string]*printer{"camera": {
		ctx: ctx, cancel: cancel, config: printerConfig{SerialNumber: "camera", Name: "<script>Maker</script>", Host: "192.168.5.6", AccessCode: "private-password"},
		data:  printerStatus{State: "RUNNING", Remaining: 125, UpdatedAt: time.Now()},
		frame: []byte{0xff, 0xd8, 0xff, 0xd9}, frameAt: time.Now(),
	}}
	_, cloud := e.routes()
	token := memberTestToken(private, testMemberClaims())
	w := request(cloud, "GET", "/machines/content", "", "Cookie", printerCookie+"="+token)
	for _, want := range []string{"Printing", "2h 5m", "&lt;script&gt;Maker&lt;/script&gt;", "/machines/images/camera.jpg"} {
		if !strings.Contains(w.Body.String(), want) {
			t.Fatalf("missing %s: %s", want, w.Body.String())
		}
	}
	for _, secret := range []string{"private-password", "192.168.5.6", "<script>Maker"} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatal("unsafe dashboard output")
		}
	}
	r := httptest.NewRequest("GET", "/machines/images/camera.jpg", nil)
	r.AddCookie(&http.Cookie{Name: printerCookie, Value: token})
	image := &printerDeadlineWriter{ResponseRecorder: httptest.NewRecorder(), t: t}
	cloud.ServeHTTP(image, r)
	if image.Code != 200 || image.Header().Get("Content-Type") != "image/jpeg" || image.Body.Len() != 4 {
		t.Fatal("protected snapshot unavailable")
	}
	claims := testMemberClaims()
	claims["iat"] = time.Now().Unix() - 301
	claims["exp"] = time.Now().Unix() - 1
	if w := request(cloud, "GET", "/machines/images/camera.jpg", "", "Cookie", printerCookie+"="+memberTestToken(private, claims)); w.Code != 401 {
		t.Fatal("expired session accessed camera")
	}
	p := e.printers.printers["camera"]
	p.data.UpdatedAt = time.Now().Add(-30 * time.Second)
	cards := e.printers.cards()
	if !cards[0].Unavailable || cards[0].Remaining != "—" {
		t.Fatal("stale remaining time presented as current")
	}
	p.data.UpdatedAt = time.Time{}
	if e.printers.cards()[0].Status != "Waiting for printer" {
		t.Fatal("missing initial state")
	}
}

func TestPrinterAuthConfiguration(t *testing.T) {
	a, err := loadPrinterAuth("", "", "")
	if a != nil || err != nil {
		t.Fatal("optional config rejected")
	}
	for _, issuer := range []string{"", "http://thelab.example", "https://thelab.example/", "https://user@thelab.example", "https://thelab.example?x"} {
		if _, err := loadPrinterAuth(issuer, "https://edge.example", "bad"); err == nil {
			t.Fatal("invalid config accepted")
		}
	}
	e := testEdge(t)
	_, cloud := e.routes()
	if w := request(cloud, "GET", "/machines", ""); w.Code != 503 {
		t.Fatal("unconfigured page did not fail closed")
	}
}
