package main

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPublicMachinesRoutes(t *testing.T) {
	e := testEdge(t)
	e.workerAuth = nil
	lan, cloud := e.routes()
	for _, path := range []string{"/machines", "/machines/content", "/machines/app.js"} {
		w := request(cloud, "GET", path, "")
		if w.Code != 200 || w.Body.Len() == 0 || w.Header().Get("X-Robots-Tag") != "noindex, nofollow, noarchive" || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Content-Security-Policy") == "" || len(w.Result().Cookies()) != 0 {
			t.Fatalf("public resource failed: %s: %d %v", path, w.Code, w.Header())
		}
		if request(lan, "GET", path, "").Code != 404 {
			t.Fatal("dashboard exposed on LAN listener")
		}
	}
	w := request(cloud, "GET", "/machines", "")
	if !strings.Contains(w.Body.String(), `name="robots" content="noindex, nofollow, noarchive"`) || strings.Contains(w.Body.String(), "data-expires") {
		t.Fatal("wrong public dashboard markup")
	}
	for _, path := range []string{"/machines/login", "/machines/callback", "/machines/session", "/machines/images/missing.jpg"} {
		w := request(cloud, "GET", path, "")
		if w.Code != 404 || w.Header().Get("X-Robots-Tag") == "" {
			t.Fatal("unexpected route", path, w.Code)
		}
	}
	if request(cloud, "POST", "/machines/session", `{}`).Code != 404 {
		t.Fatal("session endpoint remains")
	}
	if request(cloud, "GET", "/api/swipes", "").Code != 401 {
		t.Fatal("public dashboard exposed machine API")
	}
}

func TestPublicPrinterPageAndSnapshot(t *testing.T) {
	e := testEdge(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	e.printers.printers = map[string]*printer{"camera": {
		ctx: ctx, cancel: cancel, config: printerConfig{SerialNumber: "camera", Name: "<script>Maker</script>", Host: "192.168.5.6", AccessCode: "private-password"},
		data:  printerStatus{State: "RUNNING", Remaining: 125, UpdatedAt: time.Now()},
		frame: []byte{0xff, 0xd8, 0xff, 0xd9}, frameAt: time.Now(),
	}}
	_, cloud := e.routes()
	w := request(cloud, "GET", "/machines/content", "")
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
	image := &printerDeadlineWriter{ResponseRecorder: httptest.NewRecorder(), t: t}
	cloud.ServeHTTP(image, r)
	if image.Code != 200 || image.Header().Get("Content-Type") != "image/jpeg" || image.Body.Len() != 4 || image.Header().Get("X-Robots-Tag") != "noindex, nofollow, noarchive" {
		t.Fatal("public snapshot unavailable")
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
