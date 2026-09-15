package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

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

func TestKioskCompletionPolling(t *testing.T) {
	e := testEdge(t)
	lan, cloud := e.routes()
	w := kioskScan(lan, `{"fob_id":123}`, "https://edge.thelab.ms")
	var issued struct{ Token string }
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &issued) != nil {
		t.Fatal(w.Body.String())
	}
	status, body := 200, `{"claimed":false}`
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/keyfob/status" || r.URL.Query().Get("token") != issued.Token {
			t.Error("unexpected status request", r.URL)
		}
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	}))
	defer worker.Close()
	e.workerAuth.issuer = worker.URL
	path := "/kiosk/claims?token=" + issued.Token
	for _, claimed := range []bool{false, true} {
		body = fmt.Sprintf(`{"claimed":%t}`, claimed)
		w = request(lan, "GET", path, "")
		var result struct {
			Claimed bool
			Expires int64
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Claimed != claimed || result.Expires <= time.Now().Unix() {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	for _, invalid := range []string{`{}`, `{"claimed":"true"}`, strings.Repeat("x", 1025)} {
		body = invalid
		if request(lan, "GET", path, "").Code != 503 {
			t.Fatal("invalid completion accepted")
		}
	}
	status = 500
	if request(lan, "GET", path, "").Code != 503 {
		t.Fatal("upstream failure ignored")
	}
	if request(cloud, "GET", path, "").Code != 401 {
		t.Fatal("LAN polling exposed")
	}
}
