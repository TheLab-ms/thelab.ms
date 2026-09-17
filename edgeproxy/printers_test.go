package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"html/template"
	"image/jpeg"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ────────────────────────────────────────────────────────────────────────
// Printer connections and images
// ────────────────────────────────────────────────────────────────────────

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
	server := httptest.NewServer(logRequests("tunnel", mux))
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

func bambuCameraPacket(frame []byte) []byte {
	header := make([]byte, 16)
	binary.LittleEndian.PutUint32(header[:4], uint32(len(frame)))
	header[8] = 1
	return append(header, frame...)
}

func bambuTestConnection(t *testing.T) (*printer, net.Conn, <-chan error) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	p := &printer{ctx: ctx, cancel: cancel, config: printerConfig{CameraType: "bambu", AccessCode: "12345678"}}
	client, server := net.Pipe()
	done := make(chan error, 1)
	go func() { done <- p.readBambuCamera(client) }()
	t.Cleanup(func() { cancel(); server.Close() })
	_ = server.SetDeadline(time.Now().Add(5 * time.Second))
	return p, server, done
}

func readBambuTestAuth(t *testing.T, server net.Conn) {
	t.Helper()
	auth := make([]byte, 80)
	if _, err := io.ReadFull(server, auth); err != nil {
		t.Fatal(err)
	}
	want := append([]byte{0x40, 0, 0, 0, 0, 0x30, 0, 0}, make([]byte, 8)...)
	want = append(want, []byte("bblp"+strings.Repeat("\x00", 28)+"12345678"+strings.Repeat("\x00", 24))...)
	if !bytes.Equal(auth, want) {
		t.Fatal("incorrect camera authentication packet")
	}
}

func waitBambuError(t *testing.T, done <-chan error) {
	t.Helper()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected connection error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Bambu camera did not stop")
	}
}

func TestBambuCameraFrames(t *testing.T) {
	p, server, done := bambuTestConnection(t)
	readBambuTestAuth(t, server)
	first := bambuCameraPacket([]byte{0xff, 0xd8, 1, 0xff, 0xd9})
	// Header and image bytes can be split anywhere in the TCP/TLS stream.
	for _, b := range first {
		if _, err := server.Write([]byte{b}); err != nil {
			t.Fatal(err)
		}
	}
	old := waitCameraFrame(t, p, 1)
	packets := append(bambuCameraPacket([]byte{0xff, 0xd8, 2, 0xff, 0xd9}),
		bambuCameraPacket([]byte{0xff, 0xd8, 3, 0xff, 0xd9})...)
	if _, err := server.Write(packets); err != nil {
		t.Fatal(err)
	}
	waitCameraFrame(t, p, 3)
	if old[2] != 1 {
		t.Fatal("previous snapshot buffer was mutated")
	}
	p.cancel()
	waitBambuError(t, done)
}

func TestBambuCameraRejectsMalformedFrames(t *testing.T) {
	oversized := make([]byte, 16)
	binary.LittleEndian.PutUint32(oversized, maxCameraFrame+1)
	large := make([]byte, 16)
	binary.LittleEndian.PutUint32(large, 0xff000005)
	cases := map[string][]byte{
		"rejected-auth":      nil,
		"partial-header":     {5, 0, 0},
		"empty-frame":        make([]byte, 16),
		"oversized":          oversized,
		"full-32-bit-length": large,
		"partial-frame":      bambuCameraPacket([]byte{0xff, 0xd8, 1, 0xff, 0xd9})[:19],
		"invalid-jpeg":       bambuCameraPacket([]byte("not a jpeg")),
		"missing-end-marker": bambuCameraPacket([]byte{0xff, 0xd8, 0, 0}),
	}
	for name, packet := range cases {
		t.Run(name, func(t *testing.T) {
			p, server, done := bambuTestConnection(t)
			readBambuTestAuth(t, server)
			if len(packet) > 0 {
				_, _ = server.Write(packet)
			}
			server.Close()
			waitBambuError(t, done)
			if p.frame != nil || !p.frameAt.IsZero() {
				t.Fatal("invalid frame was published")
			}
		})
	}
}

func TestBambuCameraCancellation(t *testing.T) {
	for _, stage := range []string{"authentication", "header", "payload"} {
		t.Run(stage, func(t *testing.T) {
			p, server, done := bambuTestConnection(t)
			if stage != "authentication" {
				readBambuTestAuth(t, server)
			}
			if stage == "payload" {
				_, _ = server.Write(bambuCameraPacket([]byte{0xff, 0xd8, 1, 0xff, 0xd9})[:17])
			}
			p.cancel()
			waitBambuError(t, done)
		})
	}
}

func TestBambuCameraTimeout(t *testing.T) {
	t.Parallel()
	p, server, done := bambuTestConnection(t)
	readBambuTestAuth(t, server)
	// A complete header with an incomplete payload must not keep the worker alive.
	_, _ = server.Write(bambuCameraPacket([]byte{0xff, 0xd8, 1, 0xff, 0xd9})[:17])
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "timeout") {
			t.Fatalf("expected frame timeout, got %v", err)
		}
	case <-time.After(cameraTimeout + 5*time.Second):
		t.Fatal("stalled camera did not time out")
	}
	if p.frame != nil {
		t.Fatal("partial frame was published")
	}
}

// Opt-in hardware check; credentials stay outside source and normal test runs.
func TestBambuCameraLive(t *testing.T) {
	host := os.Getenv("CONWAYEDGE_BAMBU_TEST_HOST")
	if host == "" {
		t.Skip("set CONWAYEDGE_BAMBU_TEST_HOST and CONWAYEDGE_BAMBU_TEST_ACCESS_CODE for a LAN camera check")
	}
	code := os.Getenv("CONWAYEDGE_BAMBU_TEST_ACCESS_CODE")
	if code == "" {
		t.Fatal("CONWAYEDGE_BAMBU_TEST_ACCESS_CODE is required")
	}
	ctx, cancel := context.WithCancel(context.Background())
	p := &printer{ctx: ctx, cancel: cancel, config: printerConfig{Host: host, AccessCode: code, CameraType: "bambu"}}
	p.wg.Add(1)
	go p.runCamera()
	t.Cleanup(func() { cancel(); p.wg.Wait() })
	s := printerSet{printers: map[string]*printer{"live": p}}
	deadline := time.Now().Add(25 * time.Second)
	var first time.Time
	for time.Now().Before(deadline) {
		p.mu.Lock()
		at := p.frameAt
		p.mu.Unlock()
		if !at.IsZero() {
			if first.IsZero() {
				first = at
			} else if at.After(first) {
				r := httptest.NewRequest("GET", "/", nil)
				r.SetPathValue("image", "live.jpg")
				w := &printerDeadlineWriter{ResponseRecorder: httptest.NewRecorder(), t: t}
				s.snapshot(w, r)
				if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "image/jpeg" {
					t.Fatalf("snapshot failed: %d", w.Code)
				}
				image, err := jpeg.Decode(w.Body)
				if err != nil {
					t.Fatal(err)
				}
				t.Logf("received multiple live frames; HTTP snapshot decoded: %v", image.Bounds())
				return
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("camera did not deliver multiple frames within 25s")
}

// ────────────────────────────────────────────────────────────────────────
// Printer configuration
// ────────────────────────────────────────────────────────────────────────

func TestBambuCameraConfig(t *testing.T) {
	for _, tc := range []struct {
		camera, code string
		valid        bool
	}{
		{"", "legacy", true},
		{"rtsps", "legacy", true},
		{"bambu", "12345678", true},
		{"bambu", strings.Repeat("a", 32), true},
		{"bambu", strings.Repeat("a", 33), false},
		{"bambu", "1234\x005678", false},
		{"bambu", "", false},
		{"unknown", "12345678", false},
	} {
		config := []printerConfig{{Name: "Printer", Host: "127.0.0.1", SerialNumber: "serial", AccessCode: tc.code, CameraType: tc.camera}}
		data, err := json.Marshal(config)
		if err != nil {
			t.Fatal(err)
		}
		got, err := parsePrinters(data)
		if (err == nil) != tc.valid || (tc.valid && !reflect.DeepEqual(got, config)) {
			t.Fatalf("camera=%q code length=%d: unexpected parse result: %v", tc.camera, len(tc.code), err)
		}
	}
}

func printerForm(e *edge, action string, printers ...printerConfig) url.Values {
	form := url.Values{"csrf": {e.csrf}, "action": {action}, "count": {fmt.Sprint(len(printers))}}
	for i, p := range printers {
		form.Set(fmt.Sprintf("name_%d", i), p.Name)
		form.Set(fmt.Sprintf("host_%d", i), p.Host)
		form.Set(fmt.Sprintf("access_code_%d", i), p.AccessCode)
		form.Set(fmt.Sprintf("serial_number_%d", i), p.SerialNumber)
		form.Set(fmt.Sprintf("camera_type_%d", i), p.CameraType)
	}
	return form
}

func TestPrinterFormWorkflow(t *testing.T) {
	e := testEdge(t)
	lan, _ := e.routes()
	submit := func(action string, printers ...printerConfig) *httptest.ResponseRecorder {
		return request(lan, "POST", "/", printerForm(e, action, printers...).Encode(), "Content-Type", "application/x-www-form-urlencoded")
	}
	p := printerConfig{Name: `Workshop <X1> "test"`, Host: "127.0.0.1", AccessCode: `secret"<&`, SerialNumber: "serial"}
	w := submit("add")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `name="name_0"`) || len(e.config) != 0 {
		t.Fatalf("add first printer: %d %s", w.Code, w.Body.String())
	}
	w = submit("add", p)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `name="name_1"`) || !strings.Contains(w.Body.String(), template.HTMLEscapeString(p.AccessCode)) {
		t.Fatalf("add did not preserve draft: %d %s", w.Code, w.Body.String())
	}
	if disk := storedPrinters(t, e); disk != "[]" {
		t.Fatalf("draft persisted: %s", disk)
	}
	second := printerConfig{Name: "Second", Host: "::1", AccessCode: "other", SerialNumber: "second", CameraType: "bambu"}
	w = submit("save", p, second)
	if w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/" || !reflect.DeepEqual(e.config, []printerConfig{p, second}) {
		t.Fatalf("save: %d %s", w.Code, w.Body.String())
	}
	w = request(lan, "GET", "/", "")
	for _, field := range []string{`action="/"`, `type="password"`, `name="serial_number_1"`, `name="camera_type_1"`, `value="bambu" selected`, template.HTMLEscapeString(p.Name), template.HTMLEscapeString(p.AccessCode)} {
		if !strings.Contains(w.Body.String(), field) {
			t.Fatalf("missing field %q: %s", field, w.Body.String())
		}
	}
	if strings.Contains(w.Body.String(), "<textarea") || strings.Contains(w.Body.String(), p.Name) {
		t.Fatal("raw JSON editor or unescaped printer name in form")
	}
	w = submit("remove_0", p, second)
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), template.HTMLEscapeString(p.Name)) || !strings.Contains(w.Body.String(), `name="name_0" value="Second"`) || len(e.config) != 2 {
		t.Fatalf("remove did not preserve draft and live state: %d %s", w.Code, w.Body.String())
	}
	w = submit("save", second)
	if w.Code != http.StatusSeeOther || !reflect.DeepEqual(e.config, []printerConfig{second}) {
		t.Fatalf("save removal: %d %s", w.Code, w.Body.String())
	}
	w = submit("remove_0", second)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "No printers configured") || len(e.config) != 1 {
		t.Fatalf("remove last draft printer: %d %s", w.Code, w.Body.String())
	}
	w = submit("save")
	disk := storedPrinters(t, e)
	if w.Code != http.StatusSeeOther || len(e.config) != 0 || len(e.printers.printers) != 0 || disk != "[]" {
		t.Fatalf("clear printers: %d disk=%q", w.Code, disk)
	}
}

func TestPrinterFormRejectsInvalidSaves(t *testing.T) {
	e := testEdge(t)
	lan, _ := e.routes()
	p := printerConfig{Name: "Printer", Host: "127.0.0.1", AccessCode: "secret", SerialNumber: "serial"}
	post := func(form url.Values) *httptest.ResponseRecorder {
		return request(lan, "POST", "/", form.Encode(), "Content-Type", "application/x-www-form-urlencoded")
	}
	if w := post(printerForm(e, "save", p)); w.Code != http.StatusSeeOther {
		t.Fatalf("initial save: %d", w.Code)
	}
	before := storedPrinters(t, e)
	cases := []struct{ key, value string }{
		{"name_0", ""}, {"host_0", "printer.local"}, {"access_code_0", ""},
		{"serial_number_0", "bad/serial"}, {"count", ""}, {"count", "-1"}, {"count", "33"},
		{"action", "remove_9"}, {"action", "unknown"},
		{"camera_type_0", "unknown"},
	}
	for _, tc := range cases {
		t.Run(tc.key+"="+tc.value, func(t *testing.T) {
			form := printerForm(e, "save", p)
			form.Set(tc.key, tc.value)
			if w := post(form); w.Code != http.StatusBadRequest {
				t.Fatalf("invalid form accepted: %d", w.Code)
			}
		})
	}
	w := post(printerForm(e, "save", p, p))
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), `role="alert"`) || !strings.Contains(w.Body.String(), `name="access_code_1" value="secret"`) {
		t.Fatalf("duplicate serial error lost draft: %d %s", w.Code, w.Body.String())
	}
	for _, action := range []string{"add", "remove_0", "save"} {
		form := printerForm(e, action, p)
		form.Set("csrf", "wrong")
		if w := post(form); w.Code != http.StatusForbidden {
			t.Fatalf("%s bypassed CSRF: %d", action, w.Code)
		}
	}
	if w := request(lan, "POST", "/", strings.Repeat("x", 64<<10+1), "Content-Type", "application/x-www-form-urlencoded"); w.Code != http.StatusBadRequest {
		t.Fatalf("oversized form accepted: %d", w.Code)
	}
	after := storedPrinters(t, e)
	if before != after || !reflect.DeepEqual(e.config, []printerConfig{p}) {
		t.Fatal("invalid submissions changed persisted or live configuration")
	}
}

func storedPrinters(t *testing.T, e *edge) string {
	t.Helper()
	var data string
	if err := e.db.QueryRow("SELECT config FROM printer_config").Scan(&data); err != nil {
		t.Fatal(err)
	}
	return data
}

func TestPrinterConfigPersistence(t *testing.T) {
	e := testEdge(t)
	lan, _ := e.routes()
	p := printerConfig{Name: "Printer", Host: "127.0.0.1", AccessCode: "secret", SerialNumber: "serial", CameraType: "bambu"}
	if w := request(lan, "POST", "/", printerForm(e, "save", p).Encode(), "Content-Type", "application/x-www-form-urlencoded"); w.Code != 303 {
		t.Fatal(w.Code)
	}
	e = restartEdge(t, e)
	if !reflect.DeepEqual(e.config, []printerConfig{p}) {
		t.Fatal("printer configuration not restored")
	}
	before := storedPrinters(t, e)
	execSQL(t, e, "PRAGMA query_only = ON")
	lan, _ = e.routes()
	w := request(lan, "POST", "/", printerForm(e, "save").Encode(), "Content-Type", "application/x-www-form-urlencoded")
	if w.Code != 500 || storedPrinters(t, e) != before || !reflect.DeepEqual(e.config, []printerConfig{p}) {
		t.Fatal("failed save changed printer configuration")
	}
	e.printers.mu.RLock()
	defer e.printers.mu.RUnlock()
	if e.printers.printers[p.SerialNumber] == nil {
		t.Fatal("failed save removed running printer")
	}
}

func TestConcurrentPrinterConfiguration(t *testing.T) {
	e := testEdge(t)
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Go(func() {
			config := []printerConfig{{Name: fmt.Sprint(i), Host: "127.0.0.1", AccessCode: "secret", SerialNumber: "serial"}}
			if err := e.storePrinters(context.Background(), config); err != nil {
				t.Errorf("save: %v", err)
			}
			e.printers.cards()
		})
	}
	wg.Wait()
	persisted, err := parsePrinters([]byte(storedPrinters(t, e)))
	if err != nil || !reflect.DeepEqual(e.config, persisted) || e.printers.printers["serial"].config != persisted[0] {
		t.Fatal("concurrent saves left persisted configuration and running printer out of sync")
	}

	// Shutdown and saves share lifecycle ownership; no printer may outlive close.
	wg.Go(e.close)
	wg.Go(func() { _ = e.storePrinters(context.Background(), persisted) })
	wg.Wait()
	if len(e.printers.printers) != 0 {
		t.Fatal("save started a printer after shutdown")
	}
}

// ────────────────────────────────────────────────────────────────────────
// Public dashboard
// ────────────────────────────────────────────────────────────────────────

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
