package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

const testEventKey = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"

func pushVersion(t *testing.T, e *edge, version int, fobs string, want int) {
	t.Helper()
	_, cloud := e.routes()
	w := jwtRequest(cloud, "PUT", "/api/goal", fmt.Sprintf(`{"version":%d,"fobs":%s,"event_signing_key":%q}`, version, fobs, testEventKey))
	if w.Code != want {
		t.Fatalf("version %d: got %d, want %d: %s", version, w.Code, want, w.Body.String())
	}
}

func TestGoalDiff(t *testing.T) {
	e := testEdge(t)
	_, cloud := e.routes()
	if got := jwtRequest(cloud, "GET", "/api/goal", "").Code; got != 503 {
		t.Fatal(got)
	}
	pushVersion(t, e, 1, "[7,8]", 204)
	patch := `{"base_version":1,"version":2,"add":[9],"remove":[7]}`
	for _, body := range []string{patch, patch} {
		if w := jwtRequest(cloud, "PATCH", "/api/goal", body); w.Code != 204 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	e = restartEdge(t, e)
	_, cloud = e.routes()
	if got := jwtRequest(cloud, "PATCH", "/api/goal", patch).Code; got != 204 {
		t.Fatal(got)
	}
	for _, tc := range []struct {
		body   string
		status int
	}{
		{`{"base_version":1,"version":3,"add":[],"remove":[8]}`, 409},
		{`{"base_version":1,"version":2,"add":[10],"remove":[7]}`, 409},
		{`{"base_version":2,"version":3,"add":[8],"remove":[8]}`, 400},
		{`{"base_version":2,"version":3,"add":null,"remove":[]}`, 400},
	} {
		if w := jwtRequest(cloud, "PATCH", "/api/goal", tc.body); w.Code != tc.status {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	w := jwtRequest(cloud, "GET", "/api/goal", "")
	if w.Code != 200 || w.Body.String() != fmt.Sprintf("{\"version\":2,\"fobs\":[8,9],\"event_signing_key\":%q}\n", testEventKey) {
		t.Fatal(w.Code, w.Body.String())
	}
	if got := jwtRequest(cloud, "PATCH", "/api/goal", `{"base_version":2,"version":3,"add":[],"remove":[8,9]}`).Code; got != 204 {
		t.Fatal(got)
	}
	lan, _ := e.routes()
	if w := request(lan, "POST", "/api/fobs", "[]"); w.Body.String() != "[]\n" {
		t.Fatal(w.Body.String())
	}
}

func readSwipes(t *testing.T, e *edge) []swipe {
	t.Helper()
	events, err := e.retainedSwipes(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return events
}

func TestGoalAndController(t *testing.T) {
	e := testEdge(t)
	lan, _ := e.routes()
	for _, body := range []string{"[]", `[{"fob":7,"allowed":false}]`} {
		if w := request(lan, "POST", "/api/fobs", body); w.Code != 503 || countSwipes(t, e) != 0 {
			t.Fatalf("uninitialized: %d", w.Code)
		}
	}
	pushVersion(t, e, 0, "[42,7,42]", 204)
	w := request(lan, "POST", "/api/fobs", `[{"fob":42,"allowed":true}]`)
	if w.Code != 200 || w.Body.String() != "[7,42]\n" || w.Header().Get("Content-Length") != "7" || w.Header().Get("X-Fob-Signature") != "" {
		t.Fatalf("controller response: %d %v %q", w.Code, w.Header(), w.Body.String())
	}
	etag := w.Header().Get("ETag")
	// Existing firmware hashes each decimal ID followed by a comma.
	if etag != fmt.Sprintf("%x", sha256.Sum256([]byte("7,42,"))) {
		t.Fatalf("ETag: %q", etag)
	}
	w = request(lan, "POST", "/api/fobs", `[{"fob":8,"allowed":false}]`, "If-None-Match", etag, "X-Forwarded-For", "untrusted")
	if w.Code != 304 || w.Body.Len() != 0 || len(readSwipes(t, e)) != 2 {
		t.Fatal("conditional response did not persist swipes")
	}
	pushVersion(t, e, 0, "[7,42]", 204)
	pushVersion(t, e, 0, "[7]", 409)
	pushVersion(t, e, 2, "[8]", 204)
	e = restartEdge(t, e)
	pushVersion(t, e, 1, "[9]", 409)
	pushVersion(t, e, 2, "[9]", 409)
	pushVersion(t, e, 2, "[8,8]", 204)
	pushVersion(t, e, 3, "[]", 204)
	e = restartEdge(t, e)
	assertGoal(t, e, 3, "[]\n")
	lan, _ = e.routes()
	w = request(lan, "POST", "/api/fobs", "[]", "If-None-Match", etag)
	if w.Code != 200 || w.Body.String() != "[]\n" {
		t.Fatal("revocation not served")
	}
}

func TestAPIValidationAndRoutes(t *testing.T) {
	e := testEdge(t)
	lan, cloud := e.routes()
	for _, route := range []struct {
		method, path, body string
		want               int
	}{
		{"PUT", "/api/goal", `{"version":1,"fobs":[1],"event_signing_key":"` + testEventKey + `"}`, 204},
		{"GET", "/api/swipes", "", 404},
		{"POST", "/api/swipes/ack", `{"ids":[]}`, 404},
		{"GET", "/api/printers", "", 404},
		{"GET", "/api/printers/missing/snapshot.jpg", "", 404},
	} {
		if w := request(cloud, route.method, route.path, route.body); w.Code != 401 {
			t.Fatalf("auth bypass: %s: %d", route.path, w.Code)
		}
		if w := jwtRequest(lan, route.method, route.path, route.body); w.Code != 404 {
			t.Fatalf("tunnel API on LAN: %s: %d", route.path, w.Code)
		}
		if w := jwtRequest(cloud, route.method, route.path, route.body); w.Code != route.want {
			t.Fatalf("authenticated request: %s: %d", route.path, w.Code)
		}
	}
	for _, route := range []struct {
		method, path string
		want         int
	}{
		{"POST", "/api/goal", 405}, {"POST", "/api/goal/versioned", 404},
		{"GET", "/machines/stream/test", 404}, {"GET", "/", 404},
		{"POST", "/api/fobs", 404}, {"POST", "/api/kiosk/claims", 404},
	} {
		if w := jwtRequest(cloud, route.method, route.path, "[]"); w.Code != route.want {
			t.Fatalf("obsolete/LAN route: %s: %d", route.path, w.Code)
		}
	}
	for _, body := range []string{
		`null`, `[]`, `{}`, `{"version":null,"fobs":[]}`, `{"version":1}`, `{"version":1,"fobs":null}`,
		`{"version":-1,"fobs":[]}`, `{"version":1.5,"fobs":[]}`, `{"version":"2","fobs":[]}`,
		`{"version":9007199254740992,"fobs":[]}`, `{"version":2,"fobs":[0]}`,
		`{"version":2,"fobs":[4294967296]}`, `{"version":2,"fobs":[],"extra":1}`,
		`{"version":2,"fobs":[]} {}`, strings.Repeat(" ", 16385),
		`{"version":2,"fobs":[` + strings.Repeat("1,", 512) + `1]}`,
	} {
		if strings.HasPrefix(body, "{") {
			body = strings.Replace(body, "{", `{"event_signing_key":"`+testEventKey+`",`, 1)
		}
		if w := jwtRequest(cloud, "PUT", "/api/goal", body); w.Code != 400 {
			t.Fatalf("accepted invalid goal: %q: %d", body, w.Code)
		}
	}
	assertGoal(t, e, 1, "[1]\n")
	for _, body := range []string{"null", "[null]", "[{}]", "[] []", `[{"fob":-1}]`, `[{"fob":4294967296}]`,
		`[{"fob":7}]`, `[{"fob":7,"allowed":null}]`, `[{"fob":7,"allowed":"false"}]`,
		`[{"fob":7,"allowed":true},{"fob":8}]`,
		"[" + strings.Repeat(`{"fob":1},`, 512) + `{"fob":1}]`, strings.Repeat(" ", 16385)} {
		if w := request(lan, "POST", "/api/fobs", body); w.Code != 400 {
			t.Fatalf("invalid swipes accepted: %q", body)
		}
	}
	if events := readSwipes(t, e); len(events) != 0 {
		t.Fatal("invalid batch partially inserted swipes", events)
	}
}

func TestSwipeDelivery(t *testing.T) {
	e := testEdge(t)
	pushVersion(t, e, 1, "[7]", 204)
	lan, _ := e.routes()
	if w := request(lan, "POST", "/api/fobs", "["+strings.Repeat(`{"fob":7,"allowed":true},`, 100)+`{"fob":8,"allowed":false}]`); w.Code != 200 {
		t.Fatal(w.Code)
	}
	first := readSwipes(t, e)
	if len(first) != 101 || !reflect.DeepEqual(first, readSwipes(t, e)) {
		t.Fatal("GET consumed or truncated events")
	}
	seen := map[string]bool{}
	for i, event := range first {
		wantFob, wantAllowed := uint32(7), true
		if i == 100 {
			wantFob, wantAllowed = 8, false
		}
		if event.ID == "" || seen[event.ID] || event.Controller != "192.0.2.1" || event.Fob != wantFob || event.Allowed != wantAllowed || event.Time.IsZero() || event.Time.Location() != time.UTC {
			t.Fatalf("bad event: %+v", event)
		}
		seen[event.ID] = true
	}
	e = restartEdge(t, e)
	if !reflect.DeepEqual(first, readSwipes(t, e)) {
		t.Fatal("restart changed event IDs or order")
	}
}

func TestLargeControllerResponse(t *testing.T) {
	e := testEdge(t)
	ids := make([]string, 512)
	for i := range ids {
		ids[i] = fmt.Sprint(4294967295 - int64(i))
	}
	pushVersion(t, e, 1, "["+strings.Join(ids, ",")+"]", 204)
	lan, _ := e.routes()
	server := httptest.NewServer(lan)
	defer server.Close()
	response, err := http.Post(server.URL+"/api/fobs", "application/json", strings.NewReader("[]"))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != 200 || len(response.TransferEncoding) != 0 || response.ContentLength != int64(len(body)) || len(body) > 6500 {
		t.Fatalf("firmware-incompatible response: %s length=%d encoding=%v", response.Status, response.ContentLength, response.TransferEncoding)
	}
}

func TestSigningLegacyProtocol(t *testing.T) {
	// RFC 8032 test seed/public key, stored in the engine's raw binary format.
	seed, _ := hex.DecodeString("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
	public, _ := hex.DecodeString("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
	path := filepath.Join(t.TempDir(), "fob-signing.ed25519")
	if err := os.WriteFile(path, seed, 0600); err != nil {
		t.Fatal(err)
	}
	e := testEdge(t)
	var err error
	e.signingKey, err = loadSigningSeed(path)
	if err != nil {
		t.Fatal(err)
	}
	for version, fobs := range []string{"[42,7,42]", "[]"} {
		pushVersion(t, e, version, fobs, 204)
		w := request(http.HandlerFunc(e.fobs), "POST", "/api/fobs", "[]")
		sig, err := base64.StdEncoding.DecodeString(w.Header().Get("X-Fob-Signature"))
		if w.Code != 200 || err != nil || len(sig) != ed25519.SignatureSize || !ed25519.Verify(public, w.Body.Bytes(), sig) {
			t.Fatalf("invalid legacy signature: %d %v", w.Code, err)
		}
		if ed25519.Verify(public, bytes.TrimSpace(w.Body.Bytes()), sig) {
			t.Fatal("signature omitted trailing newline")
		}
		if w.Header().Get("Content-Length") != fmt.Sprint(w.Body.Len()) {
			t.Fatal("signed response lacks content length")
		}
		w = request(http.HandlerFunc(e.fobs), "POST", "/api/fobs", "[]", "If-None-Match", w.Header().Get("ETag"))
		if w.Code != 304 || w.Body.Len() != 0 || w.Header().Get("X-Fob-Signature") != "" {
			t.Fatal("304 differs from legacy signing protocol")
		}
	}
	e = restartEdge(t, e)
	e.signingKey, err = loadSigningSeed(path)
	if err != nil {
		t.Fatal(err)
	}
	w := request(http.HandlerFunc(e.fobs), "POST", "/api/fobs", "[]")
	sig, _ := base64.StdEncoding.DecodeString(w.Header().Get("X-Fob-Signature"))
	if !ed25519.Verify(public, w.Body.Bytes(), sig) {
		t.Fatal("restart changed signing identity")
	}
	for _, data := range [][]byte{nil, seed[:31], append(bytes.Clone(seed), '\n'), []byte(base64.StdEncoding.EncodeToString(seed)), ed25519.NewKeyFromSeed(seed)} {
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := loadSigningSeed(path); err == nil {
			t.Fatalf("accepted non-legacy seed length %d", len(data))
		}
	}
	missing := filepath.Join(t.TempDir(), "missing")
	if _, err := loadSigningSeed(missing); err == nil {
		t.Fatal("missing configured seed accepted")
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatal("generated replacement identity")
	}
	if key, err := loadSigningSeed(""); err != nil || key != nil {
		t.Fatal("optional unsigned mode broken")
	}
}
