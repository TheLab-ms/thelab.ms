package main

import (
	"crypto/rand"
	"database/sql"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

//go:embed kiosk.html
var kioskHTML string

//go:embed kiosk.js
var kioskJS string

//go:embed kiosk.css
var kioskCSS string

//go:embed kiosk-favicon.svg
var kioskIcon string

func kioskHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow, noarchive")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
}

func kioskAsset(w http.ResponseWriter, r *http.Request) {
	kioskHeaders(w)
	asset := map[string]struct{ contentType, body string }{
		"/kiosk":             {"text/html; charset=utf-8", kioskHTML},
		"/kiosk/app.js":      {"text/javascript; charset=utf-8", kioskJS},
		"/kiosk/style.css":   {"text/css; charset=utf-8", kioskCSS},
		"/kiosk/favicon.svg": {"image/svg+xml", kioskIcon},
	}[r.URL.Path]
	w.Header().Set("Content-Type", asset.contentType)
	_, _ = io.WriteString(w, asset.body)
}

type kioskClaim struct {
	ID      string `json:"id"`
	Fob     uint32 `json:"fob_id"`
	Created int64  `json:"created"`
	Expires int64  `json:"expires"`
}

func kioskJSON(w http.ResponseWriter, status int, value any) {
	kioskHeaders(w)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func kioskError(w http.ResponseWriter, status int, message string) {
	kioskJSON(w, status, map[string]string{"error": message})
}

func (e *edge) readKioskClaim(w http.ResponseWriter, r *http.Request) *kioskClaim {
	values := r.URL.Query()["token"]
	if len(values) != 1 || len(values[0]) != 64 || strings.Trim(values[0], "0123456789abcdef") != "" {
		kioskError(w, http.StatusGone, "This code is invalid or expired. Scan your fob again.")
		return nil
	}
	var claim kioskClaim
	err := e.db.QueryRowContext(r.Context(), "SELECT id, fob, created, expires FROM kiosk_claims WHERE id = ? AND expires > ?", values[0], time.Now().Unix()).Scan(&claim.ID, &claim.Fob, &claim.Created, &claim.Expires)
	if errors.Is(err, sql.ErrNoRows) {
		kioskError(w, http.StatusGone, "This code expired. Scan your fob again.")
		return nil
	}
	if err != nil {
		kioskError(w, http.StatusServiceUnavailable, "Fob enrollment is temporarily unavailable. Please scan again.")
		return nil
	}
	return &claim
}

// Only the authenticated tunnel listener exposes the fob behind a token.
func (e *edge) getKioskClaim(w http.ResponseWriter, r *http.Request) {
	if claim := e.readKioskClaim(w, r); claim != nil {
		kioskJSON(w, http.StatusOK, claim)
	}
}

func (e *edge) issueKioskClaim(w http.ResponseWriter, r *http.Request) {
	origin, err := url.Parse(r.Header.Get("Origin"))
	if err != nil || origin.Host != r.Host || (origin.Scheme != "http" && origin.Scheme != "https") || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" {
		kioskError(w, http.StatusForbidden, "Reload the kiosk and try again.")
		return
	}
	if strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/json" {
		kioskError(w, http.StatusUnsupportedMediaType, "Fob not recognized. Scan again.")
		return
	}
	var input struct {
		Fob uint32 `json:"fob_id"`
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1024))
	if err != nil || decodeJSON(body, &input) != nil || input.Fob == 0 {
		kioskError(w, http.StatusBadRequest, "Fob not recognized. Scan again.")
		return
	}
	if e.workerAuth == nil {
		kioskError(w, http.StatusServiceUnavailable, "Fob enrollment is not configured. Please ask a member for help.")
		return
	}
	var nonce [32]byte
	_, _ = rand.Read(nonce[:])
	created := time.Now().Unix()
	claim := kioskClaim{hex.EncodeToString(nonce[:]), input.Fob, created, created + 300}
	link := e.workerAuth.issuer + "/keyfob/bind?token=" + claim.ID
	qr, err := qrcode.Encode(link, qrcode.Medium, 512)
	if err == nil {
		err = e.transaction(r.Context(), func(tx *sql.Tx) error {
			if _, err := tx.Exec("DELETE FROM kiosk_claims WHERE expires <= ?", claim.Created); err != nil {
				return err
			}
			return tx.QueryRow(`INSERT INTO kiosk_claims(id, fob, created, expires)
				SELECT ?, ?, ?, ? WHERE (SELECT count(*) FROM kiosk_claims WHERE created > ?) < 30 RETURNING id`,
				claim.ID, claim.Fob, claim.Created, claim.Expires, claim.Created-60).Scan(&claim.ID)
		})
	}
	if errors.Is(err, sql.ErrNoRows) {
		kioskError(w, http.StatusTooManyRequests, "Too many scans. Please wait a minute.")
		return
	}
	if err != nil {
		kioskError(w, http.StatusServiceUnavailable, "Fob enrollment is temporarily unavailable. Please scan again.")
		return
	}
	kioskJSON(w, http.StatusCreated, map[string]any{"token": claim.ID, "url": link, "expires": claim.Expires, "qr": "data:image/png;base64," + base64.StdEncoding.EncodeToString(qr)})
}

func (e *edge) kioskClaimStatus(w http.ResponseWriter, r *http.Request) {
	claim := e.readKioskClaim(w, r)
	if claim == nil {
		return
	}
	if e.workerAuth != nil {
		req, err := http.NewRequestWithContext(r.Context(), "GET", e.workerAuth.issuer+"/keyfob/status?token="+claim.ID, nil)
		if err == nil {
			response, err := e.workerAuth.client.Do(req)
			if err == nil {
				defer response.Body.Close()
				body, err := io.ReadAll(io.LimitReader(response.Body, 1025))
				var result struct {
					Claimed *bool `json:"claimed"`
				}
				if err == nil && len(body) <= 1024 && response.StatusCode == http.StatusOK && decodeJSON(body, &result) == nil && result.Claimed != nil {
					kioskJSON(w, http.StatusOK, map[string]any{"claimed": *result.Claimed, "expires": claim.Expires})
					return
				}
			}
		}
	}
	kioskError(w, http.StatusServiceUnavailable, "Could not check completion. Retrying…")
}
