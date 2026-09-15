package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"log"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

// ────────────────────────────────────────────────────────────────────────
// Printer connections, status, and camera snapshots
// ────────────────────────────────────────────────────────────────────────

type printerConfig struct {
	Name         string `json:"name"`
	Host         string `json:"host"`
	AccessCode   string `json:"access_code"`
	SerialNumber string `json:"serial_number"`
}

type printerStatus struct {
	State     string
	Remaining int
	UpdatedAt time.Time
	Error     string
}

const statusTimeout = 15 * time.Second

type printerSet struct {
	mu       sync.RWMutex
	printers map[string]*printer
}

type printer struct {
	config  printerConfig
	ctx     context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup
	mu      sync.Mutex
	data    printerStatus
	frame   []byte
	frameAt time.Time
	// Tests substitute a child process without requiring FFmpeg or a printer.
	command func(context.Context, printerConfig) *exec.Cmd
}

func (p *printer) logf(format string, args ...any) {
	message := fmt.Sprintf(format, args...)
	if code := p.config.AccessCode; code != "" {
		message = strings.ReplaceAll(message, code, "[redacted]")
	}
	log.Printf("printer name=%q serial=%q host=%q activity=%q", p.config.Name, p.config.SerialNumber, p.config.Host, message)
}

// Caller holds edge.configMu, or has exclusive ownership during startup/tests.
func (s *printerSet) replace(configs []printerConfig) {
	wanted := make(map[string]printerConfig, len(configs))
	for _, config := range configs {
		wanted[config.SerialNumber] = config
	}
	s.mu.Lock()
	var removed []*printer
	for serial, p := range s.printers {
		if config, ok := wanted[serial]; !ok || config != p.config {
			p.logf("stopping workers: configuration changed or shutdown")
			p.cancel()
			removed = append(removed, p)
			delete(s.printers, serial)
		}
	}
	s.mu.Unlock()
	for _, p := range removed {
		p.wg.Wait()
		p.logf("workers stopped")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.printers == nil {
		s.printers = make(map[string]*printer)
	}
	for serial, config := range wanted {
		if s.printers[serial] != nil {
			continue
		}
		ctx, cancel := context.WithCancel(context.Background())
		p := &printer{config: config, ctx: ctx, cancel: cancel, data: printerStatus{
			Remaining: -1,
		}}
		s.printers[serial] = p
		p.logf("starting MQTT and camera workers")
		p.wg.Add(2)
		go p.poll()
		go p.runCamera()
	}
}

func (s *printerSet) close() { s.replace(nil) }

func (p *printer) report(payload []byte) {
	var message struct {
		Print struct {
			State     *string `json:"gcode_state"`
			Remaining *int    `json:"mc_remaining_time"`
			// Progress-only reports also confirm that the cached status is fresh.
			Percent *int `json:"mc_percent"`
		} `json:"print"`
	}
	if json.Unmarshal(payload, &message) != nil {
		p.logf("MQTT invalid report received bytes=%d", len(payload))
		return
	}
	report := message.Print
	if report.State == nil && report.Remaining == nil && report.Percent == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if report.State != nil {
		p.data.State = *report.State
	}
	if report.Remaining != nil {
		p.data.Remaining = *report.Remaining
	}
	p.data.UpdatedAt, p.data.Error = time.Now(), ""
	p.logf("MQTT status received state=%q remaining_minutes=%d bytes=%d", p.data.State, p.data.Remaining, len(payload))
}

func waitMQTT(ctx context.Context, token mqtt.Token) error {
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return fmt.Errorf("operation timed out after 5s")
	case <-token.Done():
		return token.Error()
	}
}

func (p *printer) poll() {
	defer p.wg.Done()
	for p.ctx.Err() == nil {
		err := p.pollConnection()
		p.mu.Lock()
		p.data.Error = err
		p.mu.Unlock()
		if p.ctx.Err() == nil {
			p.logf("%s; retrying MQTT in 5s", err)
		}
		select {
		case <-p.ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
}

func (p *printer) pollConnection() string {
	ctx, cancel := context.WithCancel(p.ctx)
	defer cancel()
	options := mqtt.NewClientOptions().
		AddBroker("ssl://" + net.JoinHostPort(p.config.Host, "8883")).
		SetClientID(fmt.Sprintf("conwayedge-%d", time.Now().UnixNano())).
		SetUsername("bblp").SetPassword(p.config.AccessCode).
		SetAutoReconnect(false).SetConnectRetry(false).SetProtocolVersion(4).
		SetConnectTimeout(5 * time.Second).SetWriteTimeout(5 * time.Second)
	options.SetCustomOpenConnectionFn(func(broker *url.URL, _ mqtt.ClientOptions) (net.Conn, error) {
		// Bambu LAN certificates are self-signed. Cancellation also interrupts CONNACK waits.
		dialer := tls.Dialer{NetDialer: &net.Dialer{Timeout: 5 * time.Second}, Config: &tls.Config{InsecureSkipVerify: true}}
		conn, err := dialer.DialContext(ctx, "tcp", broker.Host)
		if err == nil {
			context.AfterFunc(ctx, func() { _ = conn.Close() })
		}
		return conn, err
	})
	client := mqtt.NewClient(options)
	defer func() {
		cancel()
		client.Disconnect(100)
		p.logf("MQTT disconnected")
	}()
	p.logf("MQTT connecting port=8883")
	if err := waitMQTT(ctx, client.Connect()); err != nil {
		p.logf("MQTT connect failed: %v", err)
		return "MQTT connection failed"
	}
	p.logf("MQTT connected; subscribing to reports")
	if err := waitMQTT(ctx, client.Subscribe("device/"+p.config.SerialNumber+"/report", 0, func(_ mqtt.Client, msg mqtt.Message) {
		p.report(msg.Payload())
	})); err != nil {
		p.logf("MQTT subscribe failed: %v", err)
		return "MQTT subscription failed"
	}
	p.logf("MQTT report subscription active")
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		p.logf("MQTT publishing status request command=pushall")
		if err := waitMQTT(ctx, client.Publish("device/"+p.config.SerialNumber+"/request", 0, false,
			`{"pushing":{"command":"pushall","sequence_id":"0"}}`)); err != nil {
			p.logf("MQTT status publish failed: %v", err)
			return "MQTT status request failed"
		}
		p.logf("MQTT status request sent")
		select {
		case <-ctx.Done():
			return "printer stopped"
		case <-ticker.C:
		}
	}
}

const (
	maxCameraFrame = 8 << 20
	cameraTimeout  = 20 * time.Second
)

func ffmpegCommand(ctx context.Context, config printerConfig) *exec.Cmd {
	address := url.URL{Scheme: "rtsps", Host: net.JoinHostPort(config.Host, "322"),
		User: url.UserPassword("bblp", config.AccessCode), Path: "/streaming/live/1"}
	return exec.CommandContext(ctx, "ffmpeg", "-nostdin", "-loglevel", "error",
		"-rtsp_transport", "tcp", "-i", address.String(), "-c:v", "mjpeg", "-q:v", "5",
		"-r", "1/5", "-an", "-f", "mpjpeg", "-boundary_tag", "frame", "pipe:1")
}

func (p *printer) runCamera() {
	defer p.wg.Done()
	for p.ctx.Err() == nil {
		p.cameraConnection()
		p.mu.Lock()
		p.frame, p.frameAt = nil, time.Time{}
		p.mu.Unlock()
		if p.ctx.Err() == nil {
			p.logf("camera disconnected; retrying in 5s")
		}
		select {
		case <-p.ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
}

func (p *printer) cameraConnection() {
	p.logf("camera connecting port=322")
	ctx, cancel := context.WithCancel(p.ctx)
	defer cancel()
	command := p.command
	if command == nil {
		command = ffmpegCommand
	}
	cmd := command(ctx, p.config)
	// Never expose stderr or exec errors: either may contain the camera password.
	cmd.Stderr = io.Discard
	cmd.WaitDelay = time.Second
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		p.logf("camera output pipe failed")
		return
	}
	defer stdout.Close()
	if cmd.Start() != nil {
		p.logf("camera process start failed; check FFmpeg installation")
		return
	}
	defer func() {
		cancel()
		_ = cmd.Wait()
		p.logf("camera process stopped")
	}()
	p.logf("camera process started")
	reader := multipart.NewReader(stdout, "frame")
	// Restart a wedged upstream even when nobody is requesting images.
	watchdog := time.AfterFunc(cameraTimeout, func() {
		if ctx.Err() == nil {
			p.logf("camera timed out waiting for frame after %s", cameraTimeout)
		}
		cancel()
	})
	defer watchdog.Stop()
	for ctx.Err() == nil {
		part, err := reader.NextPart()
		if err != nil {
			if ctx.Err() == nil {
				p.logf("camera stream ended or multipart read failed")
			}
			return
		}
		frame, err := io.ReadAll(io.LimitReader(part, maxCameraFrame+1))
		if err != nil || len(frame) > maxCameraFrame || len(frame) < 4 ||
			frame[0] != 0xff || frame[1] != 0xd8 || frame[len(frame)-2] != 0xff || frame[len(frame)-1] != 0xd9 {
			p.logf("camera frame rejected: read failure, invalid JPEG, or size limit bytes=%d", len(frame))
			return
		}
		watchdog.Reset(cameraTimeout)
		p.mu.Lock()
		// Frames are immutable so HTTP requests can write without holding the lock.
		p.frame, p.frameAt = frame, time.Now()
		p.mu.Unlock()
		p.logf("camera frame received bytes=%d", len(frame))
	}
}

func (s *printerSet) snapshot(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	image := r.PathValue("image")
	if !strings.HasSuffix(image, ".jpg") {
		http.NotFound(w, r)
		return
	}
	s.mu.RLock()
	p := s.printers[strings.TrimSuffix(image, ".jpg")]
	s.mu.RUnlock()
	if p == nil {
		http.Error(w, "printer not found", http.StatusNotFound)
		return
	}
	p.mu.Lock()
	frame, frameAt := p.frame, p.frameAt
	p.mu.Unlock()
	if p.ctx.Err() != nil || frame == nil || time.Since(frameAt) >= cameraTimeout {
		http.Error(w, "camera unavailable", http.StatusBadGateway)
		return
	}
	controller := http.NewResponseController(w)
	if controller.SetWriteDeadline(time.Now().Add(5*time.Second)) != nil {
		http.Error(w, "camera write deadline unavailable", http.StatusBadGateway)
		return
	}
	defer controller.SetWriteDeadline(time.Time{})
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Content-Length", strconv.Itoa(len(frame)))
	_, _ = w.Write(frame)
}

// ────────────────────────────────────────────────────────────────────────
// Printer configuration and dashboard
// ────────────────────────────────────────────────────────────────────────

const maxPrinters = 32

func parsePrinters(data []byte) ([]printerConfig, error) {
	var printers []printerConfig
	if err := decodeJSON(data, &printers); err != nil {
		return nil, fmt.Errorf("invalid printer JSON: %w", err)
	}
	if printers == nil {
		return nil, fmt.Errorf("expected a printer array")
	}
	if err := validatePrinters(printers); err != nil {
		return nil, err
	}
	return printers, nil
}

func validatePrinters(printers []printerConfig) error {
	if len(printers) > maxPrinters {
		return fmt.Errorf("at most %d printers are supported", maxPrinters)
	}
	seen := make(map[string]bool)
	for i, p := range printers {
		// Literal addresses keep local configuration unambiguous; ports are fixed.
		if p.Name == "" || net.ParseIP(p.Host) == nil || p.AccessCode == "" || p.SerialNumber == "" ||
			strings.ContainsAny(p.SerialNumber, "/+# \t\r\n") || seen[p.SerialNumber] {
			return fmt.Errorf("printer %d needs a name, IP address, access code, and unique serial number without spaces or / + #", i+1)
		}
		seen[p.SerialNumber] = true
	}
	return nil
}

var configPage = template.Must(template.New("config").Parse(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>conwayedge configuration</title>
  <style>
    body { font: 16px system-ui; margin: 2rem auto; padding: 0 1rem; max-width: 55rem; color: #17212b; background: #f7f8fa; }
    fieldset { margin: 1.5rem 0; padding: 1.25rem; border: 1px solid #b8c2cc; border-radius: .5rem; background: white; min-width: 0; }
    legend { font-weight: 600; padding: 0 .5rem; }
    .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr)); gap: 1rem; }
    label { display: block; }
    input { display: block; box-sizing: border-box; width: 100%; margin-top: .4rem; padding: .6rem; font: inherit; border: 1px solid #788797; border-radius: .25rem; }
    button { padding: .6rem 1.2rem; font: inherit; cursor: pointer; border: 1px solid #788797; border-radius: .25rem; background: white; }
    button:disabled { cursor: default; opacity: .5; }
    .remove { margin-top: 1rem; color: #a11b1b; }
    .actions { display: flex; gap: .75rem; flex-wrap: wrap; }
    .save { background: #174ea6; color: white; border-color: #174ea6; }
    .error { padding: 1rem; border: 1px solid #a11b1b; border-radius: .25rem; background: #fff0f0; color: #871717; }
    small { display: block; margin-top: .35rem; color: #485767; }
  </style>
</head>
<body>
  <main>
    <h1>conwayedge</h1>
    <h2>Printers</h2>
    <p>Configure up to {{.MaxPrinters}} Bambu printers with LAN access enabled. Status is polled every five seconds.</p>
    <p>Add, edit, or remove printers below, then select <strong>Save changes</strong> to apply. Removing all printers and saving clears the configuration.</p>
    {{if .Error}}<p class="error" role="alert">{{.Error}}</p>{{end}}
    <form method="post" action="/" autocomplete="off">
      <input type="hidden" name="csrf" value="{{.CSRF}}">
      <input type="hidden" name="count" value="{{len .Printers}}">
      <button type="submit" name="action" value="save" hidden>Save changes</button>
      {{range $i, $p := .Printers}}
        <fieldset>
          <legend>{{if .Name}}{{.Name}}{{else}}New printer{{end}}</legend>
          <div class="fields">
            <label>Name
              <input name="name_{{$i}}" value="{{.Name}}" placeholder="Workshop X1C" required>
            </label>
            <label>IP address
              <input name="host_{{$i}}" value="{{.Host}}" placeholder="192.168.1.50" spellcheck="false" autocapitalize="none" required>
              <small>Use a literal IPv4 or IPv6 address, without a port.</small>
            </label>
            <label>Access code
              <input type="password" name="access_code_{{$i}}" value="{{.AccessCode}}" autocomplete="off" required>
              <small>The printer's LAN access code.</small>
            </label>
            <label>Serial number
              <input name="serial_number_{{$i}}" value="{{.SerialNumber}}" spellcheck="false" autocapitalize="none" required>
              <small>Must be unique, without spaces or / + #.</small>
            </label>
          </div>
          <button class="remove" type="submit" name="action" value="remove_{{$i}}" formnovalidate>Remove printer</button>
        </fieldset>
      {{else}}
        <p>No printers configured. Select <strong>Add printer</strong> to get started.</p>
      {{end}}
      <div class="actions">
        <button type="submit" name="action" value="add" formnovalidate {{if ge (len .Printers) .MaxPrinters}}disabled{{end}}>Add printer</button>
        <button class="save" type="submit" name="action" value="save">Save changes</button>
      </div>
    </form>
  </main>
</body>
</html>`))

func (e *edge) renderConfig(w http.ResponseWriter, status int, printers []printerConfig, message string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_ = configPage.Execute(w, struct {
		CSRF        string
		Printers    []printerConfig
		Error       string
		MaxPrinters int
	}{e.csrf, printers, message, maxPrinters})
}

func printersFromForm(form url.Values) ([]printerConfig, error) {
	count, err := strconv.Atoi(form.Get("count"))
	if err != nil || count < 0 || count > maxPrinters {
		return nil, fmt.Errorf("expected a printer count between 0 and %d", maxPrinters)
	}
	printers := make([]printerConfig, count)
	for i := range printers {
		suffix := "_" + strconv.Itoa(i)
		printers[i] = printerConfig{
			Name: form.Get("name" + suffix), Host: form.Get("host" + suffix),
			AccessCode: form.Get("access_code" + suffix), SerialNumber: form.Get("serial_number" + suffix),
		}
	}
	return printers, nil
}

func (e *edge) configure(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
	switch r.Method {
	case http.MethodGet:
		e.configMu.Lock()
		printers := append([]printerConfig(nil), e.config...)
		e.configMu.Unlock()
		e.renderConfig(w, http.StatusOK, printers, "")
	case http.MethodPost:
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
		if err := r.ParseForm(); err != nil {
			http.Error(w, "invalid form (limit 64 KiB)", http.StatusBadRequest)
			return
		}
		if !secretEqual(r.PostForm.Get("csrf"), e.csrf) {
			http.Error(w, "invalid form token", http.StatusForbidden)
			return
		}
		printers, err := printersFromForm(r.PostForm)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		action := r.PostForm.Get("action")
		switch {
		case action == "add":
			if len(printers) == maxPrinters {
				e.renderConfig(w, http.StatusBadRequest, printers, fmt.Sprintf("At most %d printers are supported.", maxPrinters))
				return
			}
			e.renderConfig(w, http.StatusOK, append(printers, printerConfig{}), "")
			return
		case strings.HasPrefix(action, "remove_"):
			i, err := strconv.Atoi(strings.TrimPrefix(action, "remove_"))
			if err != nil || i < 0 || i >= len(printers) {
				http.Error(w, "invalid printer to remove", http.StatusBadRequest)
				return
			}
			printers = append(printers[:i], printers[i+1:]...)
			e.renderConfig(w, http.StatusOK, printers, "")
			return
		case action != "save":
			http.Error(w, "invalid form action", http.StatusBadRequest)
			return
		}
		if err := validatePrinters(printers); err != nil {
			e.renderConfig(w, http.StatusBadRequest, printers, err.Error())
			return
		}
		if err := e.storePrinters(r.Context(), printers); err != nil {
			log.Printf("persist printers: %v", err)
			e.renderConfig(w, http.StatusInternalServerError, printers, "Cannot save printers. Please try again.")
			return
		}
		log.Printf("printer configuration saved printers=%d", len(printers))
		http.Redirect(w, r, "/", http.StatusSeeOther)
	default:
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

const dashboardHTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow, noarchive">
  <title>Machines | TheLab</title>
  <script src="/machines/app.js" defer></script>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #11151b; color: #edf2f7; font: 16px system-ui, sans-serif; }
    main { max-width: 1200px; margin: auto; padding: 2rem 1rem; }
    .brand { color: #65e5b4; font-weight: 700; letter-spacing: .12em; }
    h1 { font-size: clamp(2rem, 5vw, 3rem); margin: .5rem 0; }
    header p, .muted { color: #adb9c9; }
    a { color: #65e5b4; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: 1.25rem; margin: 2rem 0; }
    .card { background: #1b222d; border: 1px solid #364254; border-radius: 12px; overflow: hidden; }
    .details { padding: 1.25rem; }
    h2 { margin: 0 0 1rem; font-size: 1.3rem; }
    .status { color: #65e5b4; font-weight: 600; }
    .unavailable { color: #ffd28a; }
    dl { display: grid; grid-template-columns: 1fr 1fr; gap: .8rem; }
    dt { color: #adb9c9; }
    dd { margin: 0; text-align: right; }
    .camera { aspect-ratio: 4/3; background: #090d12; display: grid; place-items: center; position: relative; }
    .camera img { position: absolute; width: 100%; height: 100%; object-fit: contain; }
    .camera p { padding: 1rem; color: #adb9c9; }
    .camera img[hidden] { display: none; }
    small { color: #adb9c9; }
    #refresh-status { min-height: 1.5em; }
  </style>
</head>
<body>
  <main id="dashboard">
    <header>
      <span class="brand">THELAB</span>
      <h1>Machines</h1>
      <p>Check machine status and follow your 3D prints from wherever you are.</p>
      <p id="refresh-status" role="status">Status and still images refresh every 5 seconds.</p>
    </header>
    <noscript>Enable JavaScript for automatic updates. Reload this page to see the latest status.</noscript>
    <section id="printers" class="grid" aria-label="Printers">{{template "cards" .}}</section>
    <footer class="muted">Remaining times are printer estimates.</footer>
  </main>
</body>
</html>

{{define "cards"}}
  {{range .Cards}}
    <article class="card">
      <div class="details">
        <h2>{{.Name}}</h2>
        <p class="status {{if .Unavailable}}unavailable{{end}}">{{.Status}}</p>
        <dl><dt>Remaining print time</dt><dd>{{.Remaining}}</dd></dl>
        <small>{{.Updated}}</small>
      </div>
      <div class="camera">
        <p>Camera unavailable — retrying automatically.</p>
        <img src="{{.Image}}" alt="Current camera image of {{.Name}}" data-camera>
      </div>
    </article>
  {{else}}
    <p>No printers are configured yet.</p>
  {{end}}
{{end}}`

var dashboardTemplate = template.Must(template.New("dashboard").Parse(dashboardHTML))

type printerCard struct {
	Name, Status, Remaining, Image, Updated string
	Unavailable                             bool
}

func (s *printerSet) cards() []printerCard {
	// Copy only the identity and status needed for rendering, then release locks.
	type row struct {
		name, serial string
		printerStatus
	}
	rows := []row{}
	s.mu.RLock()
	for _, p := range s.printers {
		p.mu.Lock()
		rows = append(rows, row{p.config.Name, p.config.SerialNumber, p.data})
		p.mu.Unlock()
	}
	s.mu.RUnlock()
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].name == rows[j].name {
			return rows[i].serial < rows[j].serial
		}
		return rows[i].name < rows[j].name
	})
	cards := make([]printerCard, 0, len(rows))
	now := time.Now()
	for _, p := range rows {
		// A distinct URL also bypasses the browser's per-document image reuse.
		card := printerCard{
			Name: p.name, Remaining: "—", Updated: "Waiting for first report",
			Image:       fmt.Sprintf("/machines/images/%s.jpg?v=%d", url.PathEscape(p.serial), now.UnixNano()),
			Unavailable: p.Error != "" || p.UpdatedAt.IsZero() || now.Sub(p.UpdatedAt) > statusTimeout,
		}
		if !p.UpdatedAt.IsZero() {
			card.Updated = "Last report: " + p.UpdatedAt.UTC().Format("15:04:05 UTC")
		}
		if card.Unavailable {
			card.Status = "Offline / status unavailable"
			if p.UpdatedAt.IsZero() {
				card.Status = "Waiting for printer"
			}
		} else {
			state := strings.ToUpper(p.State)
			card.Status = map[string]string{"IDLE": "Idle", "READY": "Ready", "RUNNING": "Printing", "PAUSE": "Paused", "FINISH": "Finished", "FAILED": "Failed", "PREPARE": "Preparing", "SLICING": "Slicing"}[state]
			if card.Status == "" {
				card.Status = "Unknown"
			}
			switch state {
			case "RUNNING", "PAUSE", "PREPARE":
				if p.Remaining >= 60 {
					card.Remaining = fmt.Sprintf("%dh %dm", p.Remaining/60, p.Remaining%60)
				} else if p.Remaining >= 0 {
					card.Remaining = fmt.Sprintf("%d min", p.Remaining)
				}
			case "IDLE", "READY", "FINISH":
				card.Remaining = "No print in progress"
			}
		}
		cards = append(cards, card)
	}
	return cards
}

func (s *printerSet) dashboard(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	name := "dashboard"
	if r.URL.Path == "/machines/content" {
		name = "cards"
	}
	_ = dashboardTemplate.ExecuteTemplate(w, name, struct {
		Cards []printerCard
	}{s.cards()})
}

func printerScript(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	_, _ = w.Write([]byte(appJS))
}
