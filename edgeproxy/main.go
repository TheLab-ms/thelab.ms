package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	lan := flag.String("lan", ":80", "LAN controller/config listen address")
	tunnel := flag.String("tunnel", ":8080", "cloudflared origin listen address (loopback or trusted subnet)")
	data := flag.String("data", "/data", "persistent data directory (one process only)")
	flag.Parse()
	log.Printf("edge proxy starting data=%q", *data)
	e, err := openEdge(*data)
	if err != nil {
		return err
	}
	defer e.close()
	e.workerAuth, err = loadWorkerAuth(os.Getenv("CONWAYEDGE_WORKER_ISSUER"), os.Getenv("CONWAYEDGE_PUBLIC_URL"))
	if err != nil {
		return err
	}
	e.signingKey, err = loadSigningSeed(os.Getenv("CONWAYEDGE_SIGNING_SEED"))
	if err != nil {
		return err
	}
	log.Printf("edge proxy authentication configured worker=%t fob_signing=%t", e.workerAuth != nil, e.signingKey != nil)
	lanHandler, tunnelHandler := e.routes()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go e.workerAuth.run(ctx)
	local, err := net.Listen("tcp", *lan)
	if err != nil {
		return err
	}
	defer local.Close()
	cloud, err := net.Listen("tcp", *tunnel)
	if err != nil {
		return err
	}
	defer cloud.Close()
	// The tunnel listener may bind a trusted subnet for a separate cloudflared
	// host. Firewall it to that host; machine APIs also verify Worker JWTs.
	errors := make(chan error, 2)
	for _, endpoint := range []struct {
		listener net.Listener
		handler  http.Handler
	}{{local, lanHandler}, {cloud, tunnelHandler}} {
		server := &http.Server{
			Handler:           endpoint.handler,
			ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second,
			WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second,
			MaxHeaderBytes: 16 << 10,
			BaseContext:    func(net.Listener) context.Context { return ctx },
		}
		defer func() {
			shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := server.Shutdown(shutdown); err != nil {
				_ = server.Close()
			}
		}()
		go func() { errors <- server.Serve(endpoint.listener) }()
		log.Printf("listening on %s", endpoint.listener.Addr())
	}
	select {
	case <-ctx.Done():
		log.Printf("edge proxy shutting down: %v", ctx.Err())
		return nil
	case err := <-errors:
		log.Printf("edge proxy listener stopped: %v", err)
		stop()
		return err
	}
}

func secretEqual(a, b string) bool {
	x, y := sha256.Sum256([]byte(a)), sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(x[:], y[:]) == 1
}

func (e *edge) routes() (http.Handler, http.Handler) {
	lan, tunnel := http.NewServeMux(), http.NewServeMux()
	lan.HandleFunc("POST /api/fobs", e.fobs)
	for _, path := range []string{"/kiosk", "/kiosk/app.js", "/kiosk/style.css", "/kiosk/favicon.svg"} {
		lan.HandleFunc("GET "+path, kioskAsset)
	}
	lan.HandleFunc("POST /kiosk/claims", e.issueKioskClaim)
	lan.HandleFunc("GET /kiosk/claims", e.kioskClaimStatus)
	lan.HandleFunc("/{$}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		e.configure(w, r)
	})
	tunnel.HandleFunc("PUT /api/goal", e.goal)
	tunnel.HandleFunc("GET /api/goal", e.getGoal)
	tunnel.HandleFunc("PATCH /api/goal", e.patchGoal)
	tunnel.HandleFunc("GET /api/swipes", e.getSwipes)
	tunnel.HandleFunc("GET /api/kiosk/claim", e.getKioskClaim)
	tunnel.HandleFunc("GET /machines", e.printers.dashboard)
	tunnel.HandleFunc("GET /machines/content", e.printers.dashboard)
	tunnel.HandleFunc("GET /machines/images/{image}", e.printers.snapshot)
	tunnel.HandleFunc("GET /machines/app.js", printerScript)
	return logRequests("lan", lan), logRequests("tunnel", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.URL.Path == "/machines" || strings.HasPrefix(r.URL.Path, "/machines/") {
			w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")
			w.Header().Set("Referrer-Policy", "no-referrer")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
		} else if !e.workerAuth.verify(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		tunnel.ServeHTTP(w, r)
	}))
}
