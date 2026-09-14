package main

import (
	"bytes"
	"context"
	"log"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
)

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
