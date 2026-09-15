package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

// ────────────────────────────────────────────────────────────────────────
// Controller and goal-state APIs
// ────────────────────────────────────────────────────────────────────────

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

func TestGoalDiffValidation(t *testing.T) {
	e := testEdge(t)
	_, cloud := e.routes()
	valid := `{"base_version":0,"version":1,"add":[],"remove":[]}`
	if w := jwtRequest(cloud, "PATCH", "/api/goal", valid); w.Code != 503 {
		t.Fatalf("uninitialized PATCH: %d %s", w.Code, w.Body.String())
	}
	pushVersion(t, e, 0, "[7]", 204)
	before := jwtRequest(cloud, "GET", "/api/goal", "").Body.String()
	check := func(t *testing.T, body string) {
		t.Helper()
		if w := jwtRequest(cloud, "PATCH", "/api/goal", body); w.Code != 400 {
			t.Fatalf("invalid PATCH accepted: %d %s", w.Code, w.Body.String())
		}
		if got := jwtRequest(cloud, "GET", "/api/goal", "").Body.String(); got != before {
			t.Fatalf("invalid PATCH changed goal: %s", got)
		}
		var count int
		if err := e.db.QueryRow("SELECT count(*) FROM goal_patch").Scan(&count); err != nil || count != 0 {
			t.Fatalf("invalid PATCH recorded: %d %v", count, err)
		}
	}
	for _, body := range []string{"{", "null", "[]", "{}", valid + " {}", valid + strings.Repeat(" ", 16<<10)} {
		check(t, body)
	}
	for _, tc := range []struct {
		field  string
		values []string
	}{
		{"base_version", []string{"", "null", "-1", "1", "2", "1.5", `"0"`, "9007199254740992"}},
		{"version", []string{"", "null", "-1", "0", "1.5", `"1"`, "9007199254740992"}},
		{"add", []string{"", "null", "{}", "[0]", "[-1]", "[4294967296]", "[1.5]", `["7"]`, "[" + strings.Repeat("1,", 512) + "1]"}},
		{"remove", []string{"", "null", "{}", "[0]", "[-1]", "[4294967296]", "[1.5]", `["7"]`, "[" + strings.Repeat("1,", 512) + "1]"}},
		{"extra", []string{"true"}},
	} {
		for i, value := range tc.values {
			t.Run(fmt.Sprintf("%s/%d", tc.field, i), func(t *testing.T) {
				var input map[string]json.RawMessage
				if err := json.Unmarshal([]byte(valid), &input); err != nil {
					t.Fatal(err)
				}
				if value == "" {
					delete(input, tc.field)
				} else {
					input[tc.field] = json.RawMessage(value)
				}
				body, err := json.Marshal(input)
				if err != nil {
					t.Fatal(err)
				}
				check(t, string(body))
			})
		}
	}
	// Both ends of the safe-integer range are usable, including an empty diff.
	for _, body := range []string{valid, `{"base_version":1,"version":9007199254740991,"add":[4294967295],"remove":[7]}`} {
		if w := jwtRequest(cloud, "PATCH", "/api/goal", body); w.Code != 204 {
			t.Fatalf("valid boundary rejected: %d %s", w.Code, w.Body.String())
		}
	}
	assertGoal(t, restartEdge(t, e), 9007199254740991, "[4294967295]\n")
}

func TestGoalDiffCapacity(t *testing.T) {
	e := testEdge(t)
	_, cloud := e.routes()
	pushVersion(t, e, 0, "[]", 204)
	ids := make([]uint32, 512)
	for i := range ids {
		ids[i] = uint32(i + 1)
	}
	encoded, err := json.Marshal(ids)
	if err != nil {
		t.Fatal(err)
	}
	initial := fmt.Sprintf(`{"base_version":0,"version":1,"add":%s,"remove":[]}`, encoded)
	if w := jwtRequest(cloud, "PATCH", "/api/goal", initial); w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
	overflow := `{"base_version":1,"version":2,"add":[513],"remove":[]}`
	if w := jwtRequest(cloud, "PATCH", "/api/goal", overflow); w.Code != 400 || !strings.Contains(w.Body.String(), "512") {
		t.Fatalf("overflow accepted: %d %s", w.Code, w.Body.String())
	}
	e = restartEdge(t, e)
	assertGoal(t, e, 1, string(encoded)+"\n")
	_, cloud = e.routes()
	if w := jwtRequest(cloud, "PATCH", "/api/goal", initial); w.Code != 204 {
		t.Fatal("overflow replaced the prior replay record", w.Code)
	}
	// Capacity is checked after removals and deduplication, not before.
	patch := `{"base_version":1,"version":2,"add":[513,512,513],"remove":[1,1]}`
	canonical := `{"base_version":1,"version":2,"add":[512,513],"remove":[1]}`
	for _, body := range []string{patch, canonical} {
		if w := jwtRequest(cloud, "PATCH", "/api/goal", body); w.Code != 204 {
			t.Fatalf("capacity-preserving diff/replay rejected: %d %s", w.Code, w.Body.String())
		}
	}
	for i := range ids {
		ids[i]++
	}
	encoded, _ = json.Marshal(ids)
	assertGoal(t, e, 2, string(encoded)+"\n")
	// A single diff can replace all 512 entries.
	remove := string(encoded)
	for i := range ids {
		ids[i] += 512
	}
	encoded, _ = json.Marshal(ids)
	patch = fmt.Sprintf(`{"base_version":2,"version":3,"add":%s,"remove":%s}`, encoded, remove)
	if w := jwtRequest(cloud, "PATCH", "/api/goal", patch); w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
	assertGoal(t, restartEdge(t, e), 3, string(encoded)+"\n")
}

func TestGoalDiffRollback(t *testing.T) {
	for _, failure := range []string{"goal update", "patch insert", "patch update"} {
		t.Run(failure, func(t *testing.T) {
			e := testEdge(t)
			pushVersion(t, e, 0, "[7]", 204)
			_, cloud := e.routes()
			previous := `{"base_version":0,"version":1,"add":[8],"remove":[7]}`
			if w := jwtRequest(cloud, "PATCH", "/api/goal", previous); w.Code != 204 {
				t.Fatal(w.Code)
			}
			before := jwtRequest(cloud, "GET", "/api/goal", "").Body.String()
			var priorPatch string
			if err := e.db.QueryRow("SELECT patch FROM goal_patch").Scan(&priorPatch); err != nil {
				t.Fatal(err)
			}
			operation := map[string]string{"goal update": "UPDATE ON goal", "patch insert": "INSERT ON goal_patch", "patch update": "UPDATE ON goal_patch"}[failure]
			execSQL(t, e, "CREATE TRIGGER reject_diff BEFORE "+operation+" BEGIN SELECT RAISE(ABORT, 'injected diff failure'); END")
			patch := `{"base_version":1,"version":2,"add":[9],"remove":[8]}`
			if w := jwtRequest(cloud, "PATCH", "/api/goal", patch); w.Code != 500 {
				t.Fatalf("failed write acknowledged: %d %s", w.Code, w.Body.String())
			}
			e = restartEdge(t, e)
			_, cloud = e.routes()
			if got := jwtRequest(cloud, "GET", "/api/goal", "").Body.String(); got != before {
				t.Fatalf("failed diff changed persisted goal/key: %s", got)
			}
			var storedPatch string
			if err := e.db.QueryRow("SELECT patch FROM goal_patch").Scan(&storedPatch); err != nil || storedPatch != priorPatch {
				t.Fatalf("failed diff changed replay record: %q %v", storedPatch, err)
			}
			if w := jwtRequest(cloud, "PATCH", "/api/goal", previous); w.Code != 204 {
				t.Fatal("previous diff no longer replayable", w.Code)
			}
			execSQL(t, e, "DROP TRIGGER reject_diff")
			for range 2 {
				if w := jwtRequest(cloud, "PATCH", "/api/goal", patch); w.Code != 204 {
					t.Fatal("retry failed", w.Code, w.Body.String())
				}
			}
			assertGoal(t, e, 2, "[9]\n")
		})
	}
}

func TestConcurrentGoalDiffsAndFullUpdates(t *testing.T) {
	for _, mode := range []string{"competing diffs", "same-version full", "newer full"} {
		t.Run(mode, func(t *testing.T) {
			e := testEdge(t)
			pushVersion(t, e, 1, "[7]", 204)
			_, cloud := e.routes()
			patch := `{"base_version":1,"version":2,"add":[8],"remove":[7]}`
			method, other := "PATCH", `{"base_version":1,"version":2,"add":[9],"remove":[7]}`
			version := 2
			rotated := strings.Repeat("ab", 32)
			if mode != "competing diffs" {
				if mode == "newer full" {
					version = 3
				}
				method, other = "PUT", fmt.Sprintf(`{"version":%d,"fobs":[9],"event_signing_key":%q}`, version, rotated)
			}
			start := make(chan struct{})
			var wg sync.WaitGroup
			var results [2]*httptest.ResponseRecorder
			wg.Go(func() { <-start; results[0] = jwtRequest(cloud, "PATCH", "/api/goal", patch) })
			wg.Go(func() { <-start; results[1] = jwtRequest(cloud, method, "/api/goal", other) })
			close(start)
			wg.Wait()
			wantFobs, wantKey := "[9]\n", testEventKey
			if mode == "newer full" {
				if results[1].Code != 204 || (results[0].Code != 204 && results[0].Code != 409) {
					t.Fatalf("unexpected statuses: %d, %d", results[0].Code, results[1].Code)
				}
				wantKey = rotated
			} else {
				if !((results[0].Code == 204 && results[1].Code == 409) || (results[0].Code == 409 && results[1].Code == 204)) {
					t.Fatalf("expected exactly one winner: %d, %d", results[0].Code, results[1].Code)
				}
				if results[0].Code == 204 {
					wantFobs = "[8]\n"
				} else if mode == "same-version full" {
					wantKey = rotated
				}
			}
			e = restartEdge(t, e)
			assertGoal(t, e, int64(version), wantFobs)
			_, cloud = e.routes()
			var key string
			if err := e.db.QueryRow("SELECT event_signing_key FROM goal").Scan(&key); err != nil || key != wantKey {
				t.Fatalf("concurrent update changed signing key: %q %v", key, err)
			}
			for i, req := range []struct{ method, body string }{{"PATCH", patch}, {method, other}} {
				want := results[i].Code
				if mode == "newer full" && i == 0 {
					want = 409
				}
				if w := jwtRequest(cloud, req.method, "/api/goal", req.body); w.Code != want {
					t.Fatalf("replay %d: got %d, want %d", i, w.Code, want)
				}
			}
		})
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
		"[" + strings.Repeat(`{"fob":1},`, 512) + `{"fob":1}]`, strings.Repeat(" ", (32<<10)+1)} {
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

func TestControllerBatchLimits(t *testing.T) {
	events := make([]controllerSwipe, 512)
	for i := range events {
		events[i] = controllerSwipe{Fob: 4294967295 - uint32(i), Allowed: false}
	}
	encoded, err := json.Marshal(events)
	if err != nil {
		t.Fatal(err)
	}
	body := string(encoded)
	for _, tc := range []struct {
		name, body    string
		conditional   bool
		status, count int
	}{
		{"maximum IDs", body, false, 200, 512},
		{"conditional poll", body, true, 304, 512},
		{"at byte limit", body + strings.Repeat(" ", (32<<10)-len(body)), false, 200, 512},
		{"over byte limit", body + strings.Repeat(" ", (32<<10)+1-len(body)), false, 400, 0},
		{"over event limit", strings.TrimSuffix(body, "]") + `,{"fob":1,"allowed":true}]`, false, 400, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := testEdge(t)
			pushVersion(t, e, 1, "[7]", 204)
			lan, _ := e.routes()
			var headers []string
			if tc.conditional {
				etag := request(lan, "POST", "/api/fobs", "[]").Header().Get("ETag")
				headers = []string{"If-None-Match", etag}
			}
			w := request(lan, "POST", "/api/fobs", tc.body, headers...)
			if w.Code != tc.status {
				t.Fatalf("got %d, want %d: %s", w.Code, tc.status, w.Body.String())
			}
			e = restartEdge(t, e)
			stored := readSwipes(t, e)
			if len(stored) != tc.count || pendingCount(t, e) != tc.count {
				t.Fatalf("persisted %d swipes, want %d", len(stored), tc.count)
			}
			for i, event := range stored {
				if event.Fob != events[i].Fob || event.Allowed != events[i].Allowed {
					t.Fatalf("swipe %d changed: %+v", i, event)
				}
			}
		})
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

// ────────────────────────────────────────────────────────────────────────
// SQLite state
// ────────────────────────────────────────────────────────────────────────

func testEdge(t *testing.T) *edge {
	t.Helper()
	e, err := openEdge(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.close)
	e.workerAuth = testWorkerAuth()
	return e
}

func restartEdge(t *testing.T, e *edge) *edge {
	t.Helper()
	var path string
	if err := e.db.QueryRow("SELECT file FROM pragma_database_list WHERE name = 'main'").Scan(&path); err != nil {
		t.Fatal(err)
	}
	e.close()
	restarted, err := openEdge(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(restarted.close)
	restarted.workerAuth = testWorkerAuth()
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

func jwtRequest(handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	return request(handler, method, path, body,
		"Authorization", "Bearer "+workerTestToken(testWorkerClaims()))
}

func execSQL(t *testing.T, e *edge, query string, args ...any) {
	t.Helper()
	if _, err := e.db.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}

func countSwipes(t *testing.T, e *edge) int {
	t.Helper()
	var count int
	if err := e.db.QueryRow("SELECT count(*) FROM swipes").Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestSQLiteSetupAndCorruptStartup(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "private ? directory")
	e, err := openEdge(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer e.close()
	for pragma, want := range map[string]string{"journal_mode": "wal", "synchronous": "2", "busy_timeout": "5000"} {
		var got string
		if err := e.db.QueryRow("PRAGMA " + pragma).Scan(&got); err != nil || got != want {
			t.Fatalf("%s = %q, want %q: %v", pragma, got, want, err)
		}
	}
	for path, mode := range map[string]os.FileMode{dir: 0700, filepath.Join(dir, "edge.db"): 0600} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != mode {
			t.Fatalf("permissions for %s: %v %v", path, info, err)
		}
	}
	for _, corrupt := range []string{"database", "goal", "noncanonical goal", "printers"} {
		t.Run(corrupt, func(t *testing.T) {
			dir := t.TempDir()
			if corrupt == "database" {
				if err := os.WriteFile(filepath.Join(dir, "edge.db"), []byte("not a database"), 0600); err != nil {
					t.Fatal(err)
				}
			} else {
				e, err := openEdge(dir)
				if err != nil {
					t.Fatal(err)
				}
				if corrupt == "goal" {
					execSQL(t, e, "INSERT INTO goal(singleton,version,fobs) VALUES (1, 1, '[0]')")
				} else if corrupt == "noncanonical goal" {
					execSQL(t, e, "INSERT INTO goal(singleton,version,fobs) VALUES (1, 1, '[2,1,2]')")
				} else {
					execSQL(t, e, "UPDATE printer_config SET config = 'null'")
				}
				e.close()
			}
			if e, err := openEdge(dir); err == nil {
				e.close()
				t.Fatal("corrupt state accepted")
			}
		})
	}
}

func TestTransactionFailures(t *testing.T) {
	e := testEdge(t)
	pushVersion(t, e, 1, "[1]", 204)
	lan, _ := e.routes()
	// Fail on the second insert, after the first row has already been written.
	execSQL(t, e, `CREATE TRIGGER reject_swipe BEFORE INSERT ON swipes WHEN NEW.fob = 2
BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END`)
	etag, _ := controllerETag([]byte("[1]\n"))
	w := request(lan, "POST", "/api/fobs", `[{"fob":1,"allowed":false},{"fob":2,"allowed":false}]`, "If-None-Match", etag)
	if w.Code != 500 || countSwipes(t, e) != 0 {
		t.Fatalf("partial batch acknowledged or committed: %d", w.Code)
	}
	execSQL(t, e, "DROP TRIGGER reject_swipe")
	if w := request(lan, "POST", "/api/fobs", `[{"fob":1,"allowed":false},{"fob":2,"allowed":false}]`); w.Code != 200 {
		t.Fatal(w.Code)
	}
	before := readSwipes(t, e)
	execSQL(t, e, `CREATE TRIGGER reject_goal BEFORE UPDATE ON goal
BEGIN SELECT RAISE(ABORT, 'injected goal failure'); END`)
	pushVersion(t, e, 2, "[2]", 500)
	e = restartEdge(t, e)
	assertGoal(t, e, 1, "[1]\n")
	execSQL(t, e, "DROP TRIGGER reject_goal")
	pushVersion(t, e, 2, "[2]", 204)
	if !reflect.DeepEqual(before, readSwipes(t, e)) || countSwipes(t, e) != 2 {
		t.Fatal("failed transaction prevented retries or lost history")
	}
	// Read-only SQLite exercises actual storage errors across all write paths.
	execSQL(t, e, "PRAGMA query_only = ON")
	pushVersion(t, e, 3, "[]", 500)
	lan, _ = e.routes()
	if w := request(lan, "POST", "/api/fobs", `[{"fob":1,"allowed":false}]`); w.Code != 500 {
		t.Fatal("acknowledged a read-only write")
	}
	if w := request(lan, "POST", "/api/fobs", "[]"); w.Code != 200 {
		t.Fatal("read-only storage blocked empty poll")
	}
}

func TestSwipeRetention(t *testing.T) {
	for _, cleanup := range []string{"startup", "insert", "fetch"} {
		t.Run(cleanup, func(t *testing.T) {
			e := testEdge(t)
			pushVersion(t, e, 0, "[]", 204)
			old, recent := time.Now().Add(-8*24*time.Hour).UnixNano(), time.Now().Add(-6*24*time.Hour).UnixNano()
			for _, item := range []struct {
				id        string
				timestamp int64
			}{
				{"old", old}, {"recent", recent},
			} {
				execSQL(t, e, "INSERT INTO swipes(id,time,controller,fob,allowed,delivered) VALUES (?,?,'test',1,1,1)", item.id, item.timestamp)
			}
			wantCount := 1
			switch cleanup {
			case "startup":
				e = restartEdge(t, e)
			case "insert":
				if _, err := e.controllerPoll(context.Background(), "test", []controllerSwipe{{1, true}}); err != nil {
					t.Fatal(err)
				}
				wantCount++
			case "fetch":
				if events := readSwipes(t, e); len(events) != 1 || events[0].ID != "recent" {
					t.Fatal("fetch returned expired events")
				}
			}
			if countSwipes(t, e) != wantCount || readSwipes(t, e)[0].ID != "recent" {
				t.Fatal("cleanup lost retained events or kept expired history")
			}
			execSQL(t, e, "UPDATE swipes SET time = ?, delivered = 1", old)
			if len(readSwipes(t, e)) != 0 || countSwipes(t, e) != 0 {
				t.Fatal("expired events were not collected")
			}
		})
	}
}

func TestSwipeStoreUpgrade(t *testing.T) {
	e := testEdge(t)
	// Recreate the previous schema, including its acknowledgment-dependent indexes.
	execSQL(t, e, `DROP INDEX swipe_outbox;
ALTER TABLE swipes DROP COLUMN delivered;
ALTER TABLE goal DROP COLUMN event_signing_key;
ALTER TABLE swipes ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1));
CREATE INDEX pending_swipes ON swipes(sequence) WHERE acknowledged = 0;
CREATE INDEX swipe_history ON swipes(time) WHERE acknowledged = 1;`)
	now := time.Now()
	for _, delivered := range []int{0, 1} {
		for _, age := range []int{6, 8} {
			execSQL(t, e, "INSERT INTO swipes(id,time,controller,fob,allowed,acknowledged) VALUES (?,?,'door',7,1,?)",
				fmt.Sprintf("event-%d-%d", delivered, age), now.Add(-time.Duration(age)*24*time.Hour).UnixNano(), delivered)
		}
	}
	e = restartEdge(t, e)
	events := readSwipes(t, e)
	if len(events) != 4 || events[0].ID != "event-0-6" || events[3].ID != "event-1-8" {
		t.Fatalf("upgrade lost retained history: %+v", events)
	}
	var columns int
	if err := e.db.QueryRow("SELECT count(*) FROM pragma_table_info('swipes') WHERE name = 'acknowledged'").Scan(&columns); err != nil || columns != 0 {
		t.Fatalf("acknowledgment column remains: %d %v", columns, err)
	}
	pushVersion(t, e, 0, "[]", 204)
	if _, err := e.controllerPoll(context.Background(), "door", []controllerSwipe{{8, false}}); err != nil {
		t.Fatal(err)
	}
	e = restartEdge(t, e)
	if events := readSwipes(t, e); len(events) != 5 || events[4].Fob != 8 {
		t.Fatal("upgraded store cannot append or restart")
	}
}

func TestSwipeRetentionHasNoCountLimit(t *testing.T) {
	e := testEdge(t)
	pushVersion(t, e, 0, "[]", 204)
	execSQL(t, e, `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < ?)
INSERT INTO swipes(id,time,controller,fob,allowed) SELECT 'event-' || x, ?, 'test', 1, 1 FROM n`, 10000, time.Now().UnixNano())
	lan, _ := e.routes()
	if w := request(lan, "POST", "/api/fobs", `[{"fob":1,"allowed":false},{"fob":2,"allowed":false}]`); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if len(readSwipes(t, e)) != 10002 || countSwipes(t, e) != 10002 {
		t.Fatal("retained events were capped")
	}
}

func TestConcurrentGoalSwipesAndFetch(t *testing.T) {
	e := testEdge(t)
	pushVersion(t, e, 0, "[]", 204)
	lan, cloud := e.routes()
	var wg sync.WaitGroup
	for i := 1; i <= 40; i++ {
		wg.Go(func() {
			w := jwtRequest(cloud, "PUT", "/api/goal", fmt.Sprintf(`{"version":%d,"fobs":[%d],"event_signing_key":%q}`, i, i, testEventKey))
			if w.Code != 204 && w.Code != 409 {
				t.Errorf("concurrent version: %d", w.Code)
			}
			if w := request(lan, "POST", "/api/fobs", fmt.Sprintf(`[{"fob":%d,"allowed":true}]`, i)); w.Code != 200 {
				t.Errorf("concurrent swipe: %d", w.Code)
			}
			readSwipes(t, e)
		})
	}
	wg.Wait()
	e = restartEdge(t, e)
	assertGoal(t, e, 40, "[40]\n")
	remaining := readSwipes(t, e)
	seen := make(map[uint32]bool)
	for _, event := range remaining {
		if seen[event.Fob] {
			t.Fatal("concurrent append duplicated an event")
		}
		seen[event.Fob] = true
	}
	if len(remaining) != 40 || countSwipes(t, e) != 40 {
		t.Fatal("concurrent append/fetch lost or duplicated events")
	}
}

func assertGoal(t *testing.T, e *edge, wantVersion int64, wantBody string) {
	t.Helper()
	var version int64
	var body string
	if err := e.db.QueryRow("SELECT version, fobs FROM goal").Scan(&version, &body); err != nil || version != wantVersion || body != wantBody {
		t.Fatalf("goal = %d %q: %v", version, body, err)
	}
}

func TestCancelledTransaction(t *testing.T) {
	e := testEdge(t)
	ctx, cancel := context.WithCancel(context.Background())
	err := e.transaction(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec("INSERT INTO goal(singleton,version,fobs) VALUES (1, 0, '[]')")
		cancel()
		return err
	})
	if err == nil {
		t.Fatal("cancelled transaction committed")
	}
	var count int
	if err := e.db.QueryRow("SELECT count(*) FROM goal").Scan(&count); err != nil || count != 0 {
		t.Fatalf("cancelled transaction persisted goal: %d %v", count, err)
	}
}

func TestCrashRecovery(t *testing.T) {
	if dir := os.Getenv("CONWAYEDGE_CRASH_TEST_DIR"); dir != "" {
		e, err := openEdge(dir)
		if err != nil {
			t.Fatal(err)
		}
		e.workerAuth = testWorkerAuth()
		pushVersion(t, e, 1, "[7]", 204)
		if _, err := e.controllerPoll(context.Background(), "test", []controllerSwipe{{7, true}, {8, false}}); err != nil {
			t.Fatal(err)
		}
		// Leave a transaction open and exit without closing SQLite. Recovery must
		// keep committed WAL records and discard these uncommitted changes.
		tx, err := e.db.Begin()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec("UPDATE goal SET version = 2, fobs = '[]'; DELETE FROM swipes"); err != nil {
			t.Fatal(err)
		}
		os.Exit(0)
	}
	dir := t.TempDir()
	cmd := exec.Command(os.Args[0], "-test.run=^TestCrashRecovery$")
	cmd.Env = append(os.Environ(), "CONWAYEDGE_CRASH_TEST_DIR="+dir)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("crash subprocess: %v\n%s", err, output)
	}
	e, err := openEdge(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer e.close()
	assertGoal(t, e, 1, "[7]\n")
	e.workerAuth = testWorkerAuth()
	events := readSwipes(t, e)
	if len(events) != 2 || events[0].Fob != 7 || events[1].Fob != 8 || countSwipes(t, e) != 2 {
		t.Fatal("crash recovery lost committed events or committed an open transaction")
	}
}

// ────────────────────────────────────────────────────────────────────────
// Worker authentication
// ────────────────────────────────────────────────────────────────────────

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
	// Generated by site/src/services.js with the RFC test key and Date.now()=1800000000000.
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

// ────────────────────────────────────────────────────────────────────────
// Swipe delivery
// ────────────────────────────────────────────────────────────────────────

func TestSwipeSignatureVector(t *testing.T) {
	key, _ := hex.DecodeString(testEventKey)
	if got := swipeSignature(key, "1800000000", []byte("[]")); got != "a0f5b2711c0fa2ef9d3b0f61e05be1205bba0eaf03e10e7d98cdbc0840355842" {
		t.Fatal(got)
	}
}

func TestGoalEventKey(t *testing.T) {
	e := testEdge(t)
	pushVersion(t, e, 1, "[7]", 204)
	_, cloud := e.routes()
	for _, key := range []string{"", "null", `"short"`, fmt.Sprintf("%q", strings.ToUpper(testEventKey))} {
		field := ""
		if key != "" {
			field = `,"event_signing_key":` + key
		}
		if got := jwtRequest(cloud, "PUT", "/api/goal", `{"version":2,"fobs":[]`+field+`}`).Code; got != 400 {
			t.Fatal(got)
		}
	}
	rotated := strings.Repeat("ab", 32)
	for _, tc := range []struct{ version, status int }{{1, 409}, {2, 204}, {2, 204}, {1, 409}} {
		if got := jwtRequest(cloud, "PUT", "/api/goal", fmt.Sprintf(`{"version":%d,"fobs":[7],"event_signing_key":%q}`, tc.version, rotated)).Code; got != tc.status {
			t.Fatal(got)
		}
	}
	e = restartEdge(t, e)
	_, cloud = e.routes()
	if got := jwtRequest(cloud, "PATCH", "/api/goal", `{"base_version":2,"version":3,"add":[8],"remove":[]}`).Code; got != 204 {
		t.Fatal(got)
	}
	var goal struct {
		EventKey string `json:"event_signing_key"`
	}
	if err := json.Unmarshal(jwtRequest(cloud, "GET", "/api/goal", "").Body.Bytes(), &goal); err != nil || goal.EventKey != rotated {
		t.Fatal(goal, err)
	}
	lan, _ := e.routes()
	if strings.Contains(request(lan, "POST", "/api/fobs", "[]").Body.String(), rotated) {
		t.Fatal("controller received event secret")
	}
}

func addSwipes(t *testing.T, e *edge, count int) {
	t.Helper()
	events := make([]controllerSwipe, count)
	for i := range events {
		events[i] = controllerSwipe{7, true}
	}
	if _, err := e.controllerPoll(context.Background(), "192.0.2.1", events); err != nil {
		t.Fatal(err)
	}
}

func pendingCount(t *testing.T, e *edge) int {
	t.Helper()
	var count int
	if err := e.db.QueryRow("SELECT count(*) FROM swipes WHERE delivered = 0").Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestSwipePushRetryRestartAndConcurrentArrival(t *testing.T) {
	e := testEdge(t)
	pushVersion(t, e, 1, "[]", 204)
	addSwipes(t, e, 600)
	// Pending history must survive beyond the delivered-history retention window.
	execSQL(t, e, "UPDATE swipes SET time = ?", time.Now().Add(-8*24*time.Hour).UnixNano())
	first := readSwipes(t, e)
	key, _ := hex.DecodeString(testEventKey)
	calls := 0
	var batches [][]swipe
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Method != "POST" || r.URL.Path != swipePath || r.Header.Get("X-Edge-Signature") != swipeSignature(key, r.Header.Get("X-Edge-Timestamp"), body) {
			t.Error("bad signed request")
		}
		var batch []swipe
		if err := json.Unmarshal(body, &batch); err != nil {
			t.Error(err)
		}
		batches = append(batches, batch)
		calls++
		if calls == 1 {
			w.WriteHeader(500)
			return
		}
		if calls == 2 {
			// This event belongs to the next flush, and must not be acknowledged here.
			addSwipes(t, e, 1)
		}
		w.WriteHeader(204)
	}))
	defer server.Close()
	if _, err := e.flushSwipes(context.Background(), server.URL, server.Client()); err == nil {
		t.Fatal("failed delivery accepted")
	}
	if pendingCount(t, e) != 600 {
		t.Fatal("failure consumed events")
	}
	e = restartEdge(t, e)
	if _, err := e.flushSwipes(context.Background(), server.URL, server.Client()); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first[:512], batches[0]) || !reflect.DeepEqual(batches[0], batches[1]) || len(batches[2]) != 88 {
		t.Fatal("retry changed or truncated batches")
	}
	if pendingCount(t, e) != 1 || countSwipes(t, e) != 1 {
		t.Fatal("concurrent event acknowledged or old delivered history retained")
	}
	e = restartEdge(t, e)
	if _, err := e.flushSwipes(context.Background(), server.URL, server.Client()); err != nil {
		t.Fatal(err)
	}
	if pendingCount(t, e) != 0 || len(batches[3]) != 1 {
		t.Fatal("restart lost pending event")
	}
}

func TestSwipeSenderLeadingAndFixedWindows(t *testing.T) {
	e := testEdge(t)
	pushVersion(t, e, 1, "[]", 204)
	batches := make(chan int, 10)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var events []swipe
		if err := json.NewDecoder(r.Body).Decode(&events); err != nil {
			t.Error(err)
		}
		batches <- len(events)
		w.WriteHeader(204)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	defer func() { cancel(); <-done }()
	const interval = 200 * time.Millisecond
	go func() { defer close(done); e.sendSwipes(ctx, server.URL, server.Client(), interval) }()
	receive := func(want int) {
		t.Helper()
		select {
		case got := <-batches:
			if got != want {
				t.Fatalf("got %d, want %d", got, want)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("sender stalled")
		}
	}
	addSwipes(t, e, 2)
	receive(2)
	addSwipes(t, e, 3)
	select {
	case <-batches:
		t.Fatal("did not batch during window")
	case <-time.After(interval / 2):
	}
	// Keep adding events through the deadline; a resetting debounce would never fire.
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	deadline := time.NewTimer(2 * interval)
	defer deadline.Stop()
	for {
		select {
		case got := <-batches:
			if got < 3 {
				t.Fatal("lost batched events")
			}
			return
		case <-ticker.C:
			addSwipes(t, e, 1)
		case <-deadline.C:
			t.Fatal("arrivals reset the flush deadline")
		}
	}
}

func TestSwipeSenderRetriesWithoutNotifications(t *testing.T) {
	e := testEdge(t)
	pushVersion(t, e, 1, "[]", 204)
	addSwipes(t, e, 1)
	requests := make(chan struct{}, 10)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- struct{}{}
		w.WriteHeader(503)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); e.sendSwipes(ctx, server.URL, server.Client(), 20*time.Millisecond) }()
	defer func() { cancel(); <-done }()
	for range 2 {
		select {
		case <-requests:
		case <-time.After(2 * time.Second):
			t.Fatal("retry requires a notification")
		}
	}
	if pendingCount(t, e) != 1 {
		t.Fatal("failed event lost")
	}
}

func TestSwipeSenderIdleAfterDelivery(t *testing.T) {
	e := testEdge(t)
	pushVersion(t, e, 1, "[]", 204)
	requests := make(chan struct{}, 10)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- struct{}{}
		w.WriteHeader(204)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	const interval = 20 * time.Millisecond
	go func() { defer close(done); e.sendSwipes(ctx, server.URL, server.Client(), interval) }()
	defer func() { cancel(); <-done }()
	// Neither startup nor the idle window after delivery should upload anything.
	idle := func() {
		t.Helper()
		select {
		case <-requests:
			t.Fatal("idle sender uploaded swipes")
		case <-time.After(5 * interval):
		}
	}
	idle()
	for range 2 {
		addSwipes(t, e, 1)
		select {
		case <-requests:
		case <-time.After(2 * time.Second):
			t.Fatal("new swipe did not wake sender")
		}
		idle()
		if pendingCount(t, e) != 0 {
			t.Fatal("successful delivery still pending")
		}
	}
}

func TestSwipeAcknowledgmentFailureAndHTTPStatus(t *testing.T) {
	e := testEdge(t)
	pushVersion(t, e, 1, "[]", 204)
	addSwipes(t, e, 1)
	status := 200
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(status) }))
	defer server.Close()
	for _, code := range []int{200, 302, 401, 413, 500} {
		status = code
		if _, err := e.flushSwipes(context.Background(), server.URL, server.Client()); err == nil || pendingCount(t, e) != 1 {
			t.Fatalf("status %d consumed pending event", code)
		}
	}
	status = 204
	execSQL(t, e, `CREATE TRIGGER reject_delivery BEFORE UPDATE ON swipes BEGIN SELECT RAISE(ABORT, 'injected acknowledgment failure'); END`)
	if _, err := e.flushSwipes(context.Background(), server.URL, server.Client()); err == nil || pendingCount(t, e) != 1 {
		t.Fatal("failed local acknowledgment lost event")
	}
	execSQL(t, e, "DROP TRIGGER reject_delivery")
	if _, err := e.flushSwipes(context.Background(), server.URL, server.Client()); err != nil || pendingCount(t, e) != 0 {
		t.Fatal("acknowledgment retry failed", err)
	}
}

// ────────────────────────────────────────────────────────────────────────
// Kiosk enrollment
// ────────────────────────────────────────────────────────────────────────

func kioskScan(handler http.Handler, body, origin string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", "https://edge.thelab.ms/kiosk/claims", strings.NewReader(body))
	r.Header.Set("Origin", origin)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func TestKioskLANIsolationAndClaims(t *testing.T) {
	e := testEdge(t)
	lan, cloud := e.routes()
	for _, path := range []string{"/kiosk", "/kiosk/app.js", "/kiosk/style.css", "/kiosk/favicon.svg"} {
		w := request(lan, "GET", path, "")
		if w.Code != 200 || w.Body.Len() == 0 || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Content-Security-Policy") == "" {
			t.Fatalf("LAN asset %s: %d %v", path, w.Code, w.Header())
		}
		if request(cloud, "GET", path, "").Code != 401 || jwtRequest(cloud, "GET", path, "").Code != 404 {
			t.Fatal("kiosk exposed on tunnel", path)
		}
	}
	w := kioskScan(lan, `{"fob_id":4294967295}`, "https://edge.thelab.ms")
	var issued struct {
		Token, URL, QR string
		Expires        int64
	}
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &issued) != nil {
		t.Fatal(w.Code, w.Body.String())
	}
	qr, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(issued.QR, "data:image/png;base64,"))
	if err != nil || !strings.HasPrefix(string(qr), "\x89PNG\r\n\x1a\n") || len(issued.Token) != 64 || issued.URL != "https://thelab.example/keyfob/bind?token="+issued.Token {
		t.Fatal("invalid QR or enrollment URL")
	}
	path := "/api/kiosk/claim?token=" + issued.Token
	if request(lan, "GET", path, "").Code != 404 || request(cloud, "GET", path, "").Code != 401 {
		t.Fatal("claim details exposed without Worker authentication")
	}
	if kioskScan(cloud, `{"fob_id":123}`, "https://edge.thelab.ms").Code != 401 || jwtRequest(cloud, "POST", "/kiosk/claims", `{"fob_id":123}`).Code != 404 {
		t.Fatal("issuance exposed on tunnel")
	}
	e = restartEdge(t, e)
	_, cloud = e.routes()
	w = jwtRequest(cloud, "GET", path, "")
	var claim kioskClaim
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &claim) != nil || claim.Fob != 4294967295 || claim.ID != issued.Token || claim.Expires-claim.Created != 300 {
		t.Fatal("claim not persisted", w.Code, w.Body.String())
	}
	if _, err := e.db.Exec("UPDATE kiosk_claims SET expires = ?", time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	if jwtRequest(cloud, "GET", path, "").Code != 410 {
		t.Fatal("expired claim accepted")
	}
}

func TestKioskValidationAndRateLimit(t *testing.T) {
	e := testEdge(t)
	lan, cloud := e.routes()
	for _, body := range []string{`{}`, `null`, `{"fob_id":0}`, `{"fob_id":4294967296}`, `{"fob_id":1.5}`, `{"fob_id":"123"}`, `{"fob_id":123,"extra":true}`, strings.Repeat("x", 1025)} {
		if w := kioskScan(lan, body, "https://edge.thelab.ms"); w.Code != 400 {
			t.Fatal(body, w.Code)
		}
	}
	for _, origin := range []string{"", "null", "https://evil.example", "https://edge.thelab.ms.evil.example", "https://edge.thelab.ms/"} {
		if w := kioskScan(lan, `{"fob_id":123}`, origin); w.Code != 403 {
			t.Fatal(origin, w.Code)
		}
	}
	for _, query := range []string{"", "?token=bad", "?token=" + strings.Repeat("a", 64), "?token=" + strings.Repeat("a", 64) + "&token=" + strings.Repeat("b", 64)} {
		if jwtRequest(cloud, "GET", "/api/kiosk/claim"+query, "").Code != 410 {
			t.Fatal("invalid token accepted", query)
		}
	}
	var wg sync.WaitGroup
	codes := make(chan int, 35)
	for range 35 {
		wg.Go(func() { codes <- kioskScan(lan, `{"fob_id":123}`, "https://edge.thelab.ms").Code })
	}
	wg.Wait()
	close(codes)
	counts := map[int]int{}
	for code := range codes {
		counts[code]++
	}
	if counts[201] != 30 || counts[429] != 5 {
		t.Fatal(counts)
	}
	if _, err := e.db.Exec("UPDATE kiosk_claims SET expires = ?", time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
	if kioskScan(lan, `{"fob_id":123}`, "https://edge.thelab.ms").Code != 201 {
		t.Fatal("expired claims not pruned")
	}
	e.workerAuth = nil
	if kioskScan(lan, `{"fob_id":123}`, "https://edge.thelab.ms").Code != 503 {
		t.Fatal("unconfigured kiosk issued claim")
	}
}

// ────────────────────────────────────────────────────────────────────────
// Request logging
// ────────────────────────────────────────────────────────────────────────

func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var output bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&output)
	t.Cleanup(func() { log.SetOutput(previous) })
	return &output
}

func TestRequestLogging(t *testing.T) {
	output := captureLogs(t)
	e := testEdge(t)
	lan, tunnel := e.routes()
	for _, tc := range []struct {
		handler                http.Handler
		path, listener, status string
	}{
		{lan, "/missing", "lan", "404"},
		{tunnel, "/api/swipes", "tunnel", "401"},
		{tunnel, "/machines", "tunnel", "200"},
	} {
		output.Reset()
		r := httptest.NewRequest("GET", tc.path+"?token=query-secret", strings.NewReader("body-secret"))
		r.Header.Set("Authorization", "Bearer header-secret")
		r.Header.Set("Cookie", "session=cookie-secret")
		w := httptest.NewRecorder()
		tc.handler.ServeHTTP(w, r)
		text := output.String()
		for _, want := range []string{"HTTP request", "listener=" + tc.listener, `method="GET"`, `path="` + tc.path + `"`, `remote="192.0.2.1:1234"`, "status=" + tc.status, "bytes=", "duration=", "completed=true"} {
			if !strings.Contains(text, want) {
				t.Fatalf("missing %q in log: %s", want, text)
			}
		}
		for _, secret := range []string{"query-secret", "header-secret", "cookie-secret", "body-secret"} {
			if strings.Contains(text, secret) {
				t.Fatalf("request log exposed %q", secret)
			}
		}
	}
}

func TestRequestLogResponseAccounting(t *testing.T) {
	output := captureLogs(t)
	handler := logRequests("lan", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated)
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("hello"))
		_, _ = w.Write([]byte(" world"))
	}))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	if w.Code != 201 || w.Body.String() != "hello world" || !strings.Contains(output.String(), "status=201 bytes=11") {
		t.Fatalf("response or log accounting changed: %d %q %s", w.Code, w.Body.String(), output)
	}
}

func TestPrinterActivityLogging(t *testing.T) {
	output := captureLogs(t)
	p := &printer{ctx: context.Background(), config: printerConfig{Name: "Workshop", Host: "127.0.0.1", SerialNumber: "serial", AccessCode: "secret-password"}}
	p.command = func(ctx context.Context, _ printerConfig) *exec.Cmd {
		return exec.CommandContext(ctx, "/no-such-program/secret-password")
	}
	p.cameraConnection()
	p.report([]byte(`{"print":{"gcode_state":"RUNNING","mc_remaining_time":42},"secret":"payload-secret"}`))
	p.logf("MQTT connect failed: %s", p.config.AccessCode)
	text := output.String()
	for _, want := range []string{`name="Workshop"`, `serial="serial"`, `host="127.0.0.1"`, "camera connecting", "camera process start failed", "MQTT status received", "remaining_minutes=42", "[redacted]"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in printer log: %s", want, text)
		}
	}
	for _, secret := range []string{"secret-password", "payload-secret"} {
		if strings.Contains(text, secret) {
			t.Fatalf("printer log exposed %q", secret)
		}
	}
}
