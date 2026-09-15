package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

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
