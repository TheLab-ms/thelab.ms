package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestPrinterReports(t *testing.T) {
	p := &printer{}
	p.report([]byte(`{"print":{"gcode_state":"RUNNING","mc_remaining_time":42}}`))
	p.data.UpdatedAt = time.Now().Add(-time.Minute)
	p.data.Error = "connection lost"
	p.report([]byte(`{"print":{"mc_percent":0}}`))
	if p.data.State != "RUNNING" || p.data.Remaining != 42 || time.Since(p.data.UpdatedAt) > time.Second || p.data.Error != "" {
		t.Fatalf("partial report lost fields: %+v", p.data)
	}
	p.report([]byte(`{"print":{"mc_remaining_time":0,"gcode_state":null}}`))
	if p.data.Remaining != 0 || p.data.State != "RUNNING" {
		t.Fatalf("zero/null fields not merged correctly: %+v", p.data)
	}
	before, _ := json.Marshal(p.data)
	for _, payload := range []string{`{`, `{"print":{"command":"pushall"}}`, `{"print":{"mc_percent":"bad","gcode_state":"BAD"}}`, `{"print":{"mc_remaining_time":"bad","gcode_state":"BAD"}}`, `{"print":{"gcode_state":null}}`, `{"print":null}`} {
		p.report([]byte(payload))
		after, _ := json.Marshal(p.data)
		if !bytes.Equal(before, after) {
			t.Fatalf("invalid/non-status report changed state: %s", payload)
		}
	}
}

func TestPrinterSetLifecycleAndStatus(t *testing.T) {
	var s printerSet
	t.Cleanup(s.close)
	w := httptest.NewRecorder()
	s.dashboard(w, httptest.NewRequest("GET", "/machines", nil))
	if !strings.Contains(w.Body.String(), "No printers are configured") {
		t.Fatalf("zero-value status: %q", w.Body.String())
	}
	config := printerConfig{Name: "Printer", SerialNumber: "serial", Host: "127.0.0.1", AccessCode: "secret:/@password"}
	s.replace([]printerConfig{config})
	first := s.printers[config.SerialNumber]
	s.replace([]printerConfig{config})
	if s.printers[config.SerialNumber] != first || first.ctx.Err() != nil {
		t.Fatal("unchanged config restarted printer")
	}
	first.report([]byte(`{"print":{"gcode_state":"IDLE"}}`))
	w = httptest.NewRecorder()
	s.dashboard(w, httptest.NewRequest("GET", "/machines", nil))
	for _, secret := range []string{config.AccessCode, config.Host, "access_code", "host"} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatalf("status exposes %q: %s", secret, w.Body.String())
		}
	}
	if !strings.Contains(w.Body.String(), "Printer") {
		t.Fatalf("status missing print data: %s", w.Body.String())
	}
	config.Name = "Renamed"
	s.replace([]printerConfig{config})
	second := s.printers[config.SerialNumber]
	if second == first || first.ctx.Err() == nil {
		t.Fatal("changed config did not stop old printer")
	}
	s.close()
	s.close()
	if second.ctx.Err() == nil || len(s.printers) != 0 {
		t.Fatal("close did not remove and cancel printers")
	}
}

// The test executable is a controllable FFmpeg substitute, including a live process
// that must be killed and reaped rather than simply reading a finite byte buffer.
func TestPrinterCameraProcess(t *testing.T) {
	mode := os.Getenv("CONWAYEDGE_CAMERA_TEST")
	if mode == "" {
		return
	}
	if mode == "invalid" {
		fmt.Print("--frame\r\nContent-Type: image/jpeg\r\n\r\nnot a jpeg\r\n--frame--\r\n")
		os.Exit(0)
	}
	if mode == "oversized" {
		fmt.Print("--frame\r\nContent-Type: image/jpeg\r\n\r\n")
		_, _ = os.Stdout.Write(bytes.Repeat([]byte{'x'}, maxCameraFrame+1))
	} else {
		for i := byte(1); i <= 3; i++ {
			fmt.Print("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 5\r\n\r\n")
			_, _ = os.Stdout.Write([]byte{0xff, 0xd8, i, 0xff, 0xd9})
			fmt.Print("\r\n")
			time.Sleep(40 * time.Millisecond)
		}
		fmt.Print("--frame\r\n")
	}
	for {
		time.Sleep(time.Hour)
	}
}

func cameraTestPrinter(t *testing.T, mode string) (*printer, *atomic.Int32) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	var starts atomic.Int32
	p := &printer{ctx: ctx, cancel: cancel, config: printerConfig{SerialNumber: "camera", AccessCode: "secret-password"}}
	p.command = func(ctx context.Context, _ printerConfig) *exec.Cmd {
		starts.Add(1)
		if mode == "start-failure" {
			return exec.CommandContext(ctx, "/no-such-program/secret-password")
		}
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestPrinterCameraProcess$")
		cmd.Env = append(os.Environ(), "CONWAYEDGE_CAMERA_TEST="+mode)
		return cmd
	}
	t.Cleanup(func() {
		cancel()
		done := make(chan struct{})
		go func() { p.wg.Wait(); close(done) }()
		waitCameraDone(t, done)
	})
	p.wg.Add(1)
	go p.runCamera()
	return p, &starts
}

func waitCameraDone(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("camera process/worker did not stop")
	}
}

func waitCameraFrame(t *testing.T, p *printer, want byte) []byte {
	t.Helper()
	timeout := time.NewTimer(5 * time.Second)
	defer timeout.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		p.mu.Lock()
		frame := p.frame
		p.mu.Unlock()
		if bytes.Equal(frame, []byte{0xff, 0xd8, want, 0xff, 0xd9}) {
			return frame
		}
		select {
		case <-timeout.C:
			t.Fatalf("camera did not deliver frame %d; latest: %x", want, frame)
		case <-ticker.C:
		}
	}
}

func TestPrinterCameraRemoval(t *testing.T) {
	p, _ := cameraTestPrinter(t, "frames")
	s := printerSet{printers: map[string]*printer{"camera": p}}
	waitCameraFrame(t, p, 3)
	s.replace(nil)
	if p.ctx.Err() == nil {
		t.Fatal("removal did not cancel printer")
	}
	if p.frame != nil {
		t.Fatal("removal retained camera frame")
	}
}

func TestPrinterCameraRetries(t *testing.T) {
	for _, mode := range []string{"start-failure", "invalid", "oversized", "frames"} {
		t.Run(mode, func(t *testing.T) {
			t.Parallel()
			p, starts := cameraTestPrinter(t, mode)
			timeout := 8 * time.Second
			if mode == "frames" {
				waitCameraFrame(t, p, 3)
				timeout += cameraTimeout
			}
			deadline := time.Now().Add(timeout)
			cleared := false
			for starts.Load() < 2 {
				p.mu.Lock()
				cleared = cleared || p.frame == nil
				p.mu.Unlock()
				if time.Now().After(deadline) {
					t.Fatal("camera did not restart automatically")
				}
				time.Sleep(10 * time.Millisecond)
			}
			if !cleared {
				t.Fatal("failed camera retained its last frame during retry")
			}
		})
	}
}

func TestPrinterSnapshotFailures(t *testing.T) {
	for _, mode := range []string{"missing", "starting", "stale", "stopped"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			p := &printer{ctx: ctx}
			s := printerSet{printers: map[string]*printer{"camera": p}}
			want := http.StatusBadGateway
			if mode == "missing" {
				s.printers = nil
				want = http.StatusNotFound
			}
			if mode == "stale" || mode == "stopped" {
				p.frame = []byte{0xff, 0xd8, 1, 0xff, 0xd9}
				p.frameAt = time.Now().Add(-cameraTimeout)
			}
			if mode == "stopped" {
				p.frameAt = time.Now()
				cancel()
			}
			r := httptest.NewRequest("GET", "/", nil)
			r.SetPathValue("image", "camera.jpg")
			w := httptest.NewRecorder()
			s.snapshot(w, r)
			if w.Code != want || strings.Contains(w.Body.String(), "secret-password") {
				t.Fatalf("unsafe or incorrect failure: %d %s", w.Code, w.Body.String())
			}
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("camera failure is cacheable")
			}
		})
	}
}

func TestPrinterHTTPSnapshot(t *testing.T) {
	p, starts := cameraTestPrinter(t, "frames")
	// Capture continues locally without any HTTP requests, retaining only the latest frame.
	want := waitCameraFrame(t, p, 3)
	s := printerSet{printers: map[string]*printer{"camera": p}}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{image}", s.snapshot)
	server := httptest.NewServer(mux)
	defer server.Close()
	client := &http.Client{Timeout: 5 * time.Second}
	for i := 0; i < 3; i++ {
		response, err := client.Get(server.URL + "/camera.jpg")
		if err != nil {
			t.Fatal(err)
		}
		frame, err := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "image/jpeg" ||
			response.Header.Get("Cache-Control") != "no-store" || response.ContentLength != int64(len(want)) {
			t.Fatalf("unexpected snapshot response: %s %v", response.Status, response.Header)
		}
		if err != nil || !bytes.Equal(frame, want) {
			t.Fatalf("invalid HTTP JPEG: %x, %v", frame, err)
		}
	}
	if starts.Load() != 1 || p.ctx.Err() != nil {
		t.Fatal("HTTP requests restarted or stopped the camera")
	}
	s.close()
}

type printerDeadlineWriter struct {
	*httptest.ResponseRecorder
	t        *testing.T
	deadline time.Time
	writes   int
}

func (w *printerDeadlineWriter) SetWriteDeadline(deadline time.Time) error {
	w.deadline = deadline
	return nil
}

func (w *printerDeadlineWriter) Write(data []byte) (int, error) {
	if time.Until(w.deadline) <= 0 || time.Until(w.deadline) > 5*time.Second {
		w.t.Error("snapshot write lacks a bounded deadline")
	}
	w.deadline = time.Time{}
	w.writes++
	return w.ResponseRecorder.Write(data)
}

func TestPrinterSnapshotDeadline(t *testing.T) {
	p, _ := cameraTestPrinter(t, "frames")
	waitCameraFrame(t, p, 3)
	s := printerSet{printers: map[string]*printer{"camera": p}}
	r := httptest.NewRequest("GET", "/", nil)
	r.SetPathValue("image", "camera.jpg")
	w := &printerDeadlineWriter{ResponseRecorder: httptest.NewRecorder(), t: t}
	s.snapshot(w, r)
	if w.writes != 1 || !w.deadline.IsZero() {
		t.Fatalf("unexpected writes or uncleared deadline: %d %v", w.writes, w.deadline)
	}
}

func TestPrinterFFmpegURL(t *testing.T) {
	config := printerConfig{Host: "::1", AccessCode: "p@ss:/?#%"}
	cmd := ffmpegCommand(context.Background(), config)
	for i, arg := range cmd.Args {
		if arg != "-i" {
			continue
		}
		address, err := url.Parse(cmd.Args[i+1])
		if err != nil {
			t.Fatal(err)
		}
		password, _ := address.User.Password()
		if password != config.AccessCode || address.Host != "[::1]:322" || address.User.Username() != "bblp" || address.Scheme != "rtsps" {
			t.Fatalf("incorrect RTSP URL encoding: %s", address.Redacted())
		}
		return
	}
	t.Fatal("FFmpeg input argument missing")
}
