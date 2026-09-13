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
	lan := flag.String("lan", ":8080", "LAN controller/config listen address")
	tunnel := flag.String("tunnel", "127.0.0.1:8081", "cloudflared origin listen address (loopback or trusted subnet)")
	data := flag.String("data", "data", "persistent data directory (one process only)")
	flag.Parse()
	e, err := openEdge(*data)
	if err != nil {
		return err
	}
	defer e.close()
	e.accessAuth, err = loadAccessAuth(os.Getenv("CONWAYEDGE_ACCESS_ISSUER"), os.Getenv("CONWAYEDGE_ACCESS_AUDIENCE"))
	if err != nil {
		return err
	}
	e.memberAuth, err = loadPrinterAuth(os.Getenv("CONWAYEDGE_MEMBER_ISSUER"), os.Getenv("CONWAYEDGE_PUBLIC_URL"), os.Getenv("CONWAYEDGE_MEMBER_PUBLIC_KEY"))
	if err != nil {
		return err
	}
	e.signingKey, err = loadSigningSeed(os.Getenv("CONWAYEDGE_SIGNING_SEED"))
	if err != nil {
		return err
	}
	lanHandler, tunnelHandler := e.routes()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
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
	// host. Firewall it to that host: fallback mTLS headers are proxy assertions.
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
		return nil
	case err := <-errors:
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
	lan.HandleFunc("/{$}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		e.configure(w, r)
	})
	tunnel.HandleFunc("PUT /api/goal", e.goal)
	tunnel.HandleFunc("GET /api/goal", e.getGoal)
	tunnel.HandleFunc("PATCH /api/goal", e.patchGoal)
	tunnel.HandleFunc("GET /api/swipes", e.getSwipes)
	tunnel.HandleFunc("GET /machines", e.requirePrinterMember(e.printers.dashboard))
	tunnel.HandleFunc("GET /machines/content", e.requirePrinterMember(e.printers.dashboard))
	tunnel.HandleFunc("GET /machines/images/{image}", e.requirePrinterMember(func(w http.ResponseWriter, r *http.Request, _ *printerClaims) {
		e.printers.snapshot(w, r)
	}))
	tunnel.HandleFunc("GET /machines/login", e.printerResource(e.printerLogin))
	tunnel.HandleFunc("POST /machines/session", e.printerResource(e.printerSession))
	tunnel.HandleFunc("GET /machines/callback", e.printerResource(printerCallback))
	tunnel.HandleFunc("GET /machines/app.js", e.printerResource(printerScript))
	return lan, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.URL.Path == "/machines" || strings.HasPrefix(r.URL.Path, "/machines/") {
			w.Header().Set("Referrer-Policy", "no-referrer")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
		} else if (e.accessAuth != nil && !e.accessAuth.verify(r)) || (e.accessAuth == nil && !cloudflareMTLSVerified(r.Header)) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		tunnel.ServeHTTP(w, r)
	})
}

func cloudflareMTLSVerified(headers http.Header) bool {
	// Cloudflare's "Add TLS client auth headers" managed transform must
	// overwrite these headers on every request. Fail closed on missing,
	// malformed, or duplicate values, including a missing revocation status.
	for name, want := range map[string]string{
		"Cf-Cert-Presented": "true",
		"Cf-Cert-Verified":  "true",
		"Cf-Cert-Revoked":   "false",
	} {
		values := headers.Values(name)
		if len(values) != 1 || values[0] != want {
			return false
		}
	}
	return true
}
