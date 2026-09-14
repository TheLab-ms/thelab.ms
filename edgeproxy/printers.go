package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

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
