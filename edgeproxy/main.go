package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
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
	tunnel := flag.String("tunnel", "127.0.0.1:8081", "cloudflared origin listen address (loopback only)")
	data := flag.String("data", "data", "persistent data directory (one process only)")
	flag.Parse()
	e, err := openEdge(*data)
	if err != nil {
		return err
	}
	defer e.close()
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
	// Certificate headers are trusted assertions from local cloudflared, not
	// credentials that may be accepted directly from network clients.
	if !cloud.Addr().(*net.TCPAddr).IP.IsLoopback() {
		return fmt.Errorf("-tunnel must bind a loopback address for trusted Cloudflare mTLS headers")
	}
	errors := make(chan error, 2)
	for i, listener := range []net.Listener{local, cloud} {
		server := &http.Server{
			Handler:           []http.Handler{lanHandler, tunnelHandler}[i],
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
		go func() { errors <- server.Serve(listener) }()
		log.Printf("listening on %s", listener.Addr())
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
	tunnel.HandleFunc("GET /api/swipes", e.getSwipes)
	tunnel.HandleFunc("GET /api/printers", e.printers.status)
	tunnel.HandleFunc("GET /api/printers/{serial}/snapshot.jpg", e.printers.snapshot)
	return lan, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if !cloudflareMTLSVerified(r.Header) {
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
