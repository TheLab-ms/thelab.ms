package main

import (
	"log"
	"net/http"
	"time"
)

type requestLogWriter struct {
	http.ResponseWriter
	status, bytes int
}

// Preserve ResponseController support, including camera write deadlines.
func (w *requestLogWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *requestLogWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	if status >= 200 || status == http.StatusSwitchingProtocols {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *requestLogWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(body)
	w.bytes += n
	return n, err
}

func logRequests(listener string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		response := &requestLogWriter{ResponseWriter: w}
		completed := false
		defer func() {
			status := response.status
			if status == 0 && completed {
				status = http.StatusOK
			}
			// Queries, headers, and bodies can contain credentials or controller data.
			log.Printf("HTTP request listener=%s method=%q path=%q remote=%q status=%d bytes=%d duration=%s completed=%t",
				listener, r.Method, r.URL.EscapedPath(), r.RemoteAddr, status, response.bytes, time.Since(start), completed)
		}()
		next.ServeHTTP(response, r)
		completed = true
	})
}
