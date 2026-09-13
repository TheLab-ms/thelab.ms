package main

import (
	_ "embed"
	"fmt"
	"html/template"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

//go:embed dashboard.html
var dashboardHTML string

//go:embed dashboard.js
var dashboardJS string

var dashboardTemplate = template.Must(template.New("dashboard").Parse(dashboardHTML))

type printerCard struct {
	Name, Status, Remaining, Image, Updated string
	Unavailable                             bool
}

func (s *printerSet) cards() []printerCard {
	rows := []printerStatus{}
	s.mu.RLock()
	for _, p := range s.printers {
		p.mu.Lock()
		rows = append(rows, p.data)
		p.mu.Unlock()
	}
	s.mu.RUnlock()
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Name == rows[j].Name {
			return rows[i].SerialNumber < rows[j].SerialNumber
		}
		return rows[i].Name < rows[j].Name
	})
	cards := make([]printerCard, 0, len(rows))
	frameVersion := fmt.Sprint(time.Now().UnixNano())
	for _, p := range rows {
		// A distinct URL also bypasses the browser's per-document image reuse.
		card := printerCard{Name: p.Name, Remaining: "—", Image: "/printers/images/" + url.PathEscape(p.SerialNumber) + ".jpg?v=" + frameVersion, Updated: "Waiting for first report"}
		if p.UpdatedAt != 0 {
			card.Updated = "Last report: " + time.Unix(p.UpdatedAt, 0).UTC().Format("15:04:05 UTC")
		}
		card.Unavailable = p.Error != "" || p.UpdatedAt == 0 || time.Since(time.Unix(p.UpdatedAt, 0)) > 15*time.Second
		if card.Unavailable {
			card.Status = "Offline / status unavailable"
			if p.UpdatedAt == 0 {
				card.Status = "Waiting for printer"
			}
		} else {
			state := strings.ToUpper(p.GcodeState)
			card.Status = map[string]string{"IDLE": "Idle", "READY": "Ready", "RUNNING": "Printing", "PAUSE": "Paused", "FINISH": "Finished", "FAILED": "Failed", "PREPARE": "Preparing", "SLICING": "Slicing"}[state]
			if card.Status == "" {
				card.Status = "Unknown"
			}
			if state == "RUNNING" || state == "PAUSE" || state == "PREPARE" {
				minutes := p.RemainingPrintTime
				if minutes >= 60 {
					card.Remaining = fmt.Sprintf("%dh %dm", minutes/60, minutes%60)
				} else if minutes >= 0 {
					card.Remaining = fmt.Sprintf("%d min", minutes)
				}
			} else if state == "IDLE" || state == "READY" || state == "FINISH" {
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
	if r.URL.Path == "/printers/content" {
		name = "cards"
	}
	_ = dashboardTemplate.ExecuteTemplate(w, name, struct {
		Cards   []printerCard
		Expires string
	}{s.cards(), w.Header().Get("X-Printer-Session-Expires")})
}

func (e *edge) printerRoutes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /printers", e.requirePrinterMember(e.printers.dashboard))
	mux.HandleFunc("GET /printers/content", e.requirePrinterMember(e.printers.dashboard))
	// Go wildcards occupy an entire segment, so strip the suffix before lookup.
	mux.HandleFunc("GET /printers/images/{image}", e.requirePrinterMember(func(w http.ResponseWriter, r *http.Request) {
		image := r.PathValue("image")
		if !strings.HasSuffix(image, ".jpg") {
			http.NotFound(w, r)
			return
		}
		r.SetPathValue("serial", strings.TrimSuffix(image, ".jpg"))
		e.printers.snapshot(w, r)
	}))
	mux.HandleFunc("GET /printers/login", e.printerLogin)
	mux.HandleFunc("POST /printers/session", e.printerSession)
	mux.HandleFunc("GET /printers/callback", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Printer sign-in | TheLab</title><script src="/printers/app.js" defer></script></head><body><main><h1>Printer sign-in</h1><p id="login-status" role="status">Completing sign-in…</p><noscript>JavaScript is required to complete sign-in and refresh printer images.</noscript><a href="/printers/login">Restart sign-in</a></main></body></html>`))
	})
	mux.HandleFunc("GET /printers/app.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		_, _ = w.Write([]byte(dashboardJS))
	})
	return mux
}
