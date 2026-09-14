package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const workerKeyRefresh = 5 * time.Minute
const workerKeyMaxAge = time.Hour
const workerKeyRetry = 5 * time.Second
const workerKeyRetryMax = time.Minute
const workerClockSkew = int64(5) // Seconds; expiration and the 60-second lifetime remain strict.

type workerAuth struct {
	issuer, audience   string
	mu                 sync.Mutex
	keys               map[string]ed25519.PublicKey
	expires, attempted time.Time
	client             *http.Client
}

func loadWorkerAuth(issuer, audience string) (*workerAuth, error) {
	if issuer == "" && audience == "" {
		return nil, nil
	}
	for _, value := range []string{issuer, audience} {
		u, err := url.Parse(value)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || value != "https://"+u.Host {
			return nil, fmt.Errorf("Worker issuer and public URL must be HTTPS origins without trailing slashes")
		}
	}
	return &workerAuth{issuer: issuer, audience: audience, client: &http.Client{
		Timeout:       5 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}

// Caller holds mu. Failures never extend the last successful key set's lifetime.
func (a *workerAuth) refresh(ctx context.Context) (err error) {
	a.attempted = time.Now()
	log.Printf("Worker JWKS download started issuer=%q", a.issuer)
	defer func() {
		if err != nil {
			if ctx.Err() == nil {
				log.Printf("Worker JWKS download failed issuer=%q duration=%s error=%q", a.issuer, time.Since(a.attempted), err)
			}
		} else {
			log.Printf("Worker JWKS download succeeded issuer=%q keys=%d duration=%s", a.issuer, len(a.keys), time.Since(a.attempted))
		}
	}()
	req, err := http.NewRequestWithContext(ctx, "GET", a.issuer+"/.well-known/edge-jwks.json", nil)
	if err != nil {
		return err
	}
	response, err := a.client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("JWKS returned %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil {
		return err
	}
	if len(body) > 65536 {
		return fmt.Errorf("JWKS too large")
	}
	var jwks struct {
		Keys []struct{ Kid, Kty, Crv, Alg, Use, X string } `json:"keys"`
	}
	if json.Unmarshal(body, &jwks) != nil || jwks.Keys == nil || len(jwks.Keys) > 32 {
		return fmt.Errorf("invalid JWKS")
	}
	keys := make(map[string]ed25519.PublicKey)
	for _, key := range jwks.Keys {
		if key.Kty != "OKP" || key.Crv != "Ed25519" || key.Alg != "EdDSA" || key.Use != "sig" || key.Kid == "" {
			continue
		}
		x, err := base64.RawURLEncoding.Strict().DecodeString(key.X)
		if err != nil || len(x) != ed25519.PublicKeySize || keys[key.Kid] != nil {
			return fmt.Errorf("invalid or duplicate JWKS key")
		}
		keys[key.Kid] = ed25519.PublicKey(x)
	}
	// An empty key set deliberately revokes all keys.
	a.keys, a.expires = keys, time.Now().Add(workerKeyMaxAge)
	return nil
}

func (a *workerAuth) refreshKeys(ctx context.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.refresh(ctx)
}

func (a *workerAuth) run(ctx context.Context) {
	a.runRefresh(ctx, workerKeyRefresh)
}

func (a *workerAuth) runRefresh(ctx context.Context, interval time.Duration) {
	if a == nil {
		return
	}
	timer := time.NewTimer(0)
	defer timer.Stop()
	retry := workerKeyRetry
	for ctx.Err() == nil {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			if ctx.Err() != nil {
				return
			}
			delay := interval
			if err := a.refreshKeys(ctx); err != nil {
				delay = retry
				retry = min(retry*2, workerKeyRetryMax)
				if ctx.Err() == nil {
					log.Printf("Worker JWKS retry scheduled in=%s", delay)
				}
			} else {
				retry = workerKeyRetry
			}
			timer.Reset(delay)
		}
	}
}

func (a *workerAuth) key(ctx context.Context, kid string) ed25519.PublicKey {
	a.mu.Lock()
	defer a.mu.Unlock()
	if (a.keys[kid] == nil || !time.Now().Before(a.expires)) && time.Since(a.attempted) >= time.Minute {
		_ = a.refresh(ctx)
	}
	if !time.Now().Before(a.expires) {
		return nil
	}
	return a.keys[kid]
}

func (a *workerAuth) verify(r *http.Request) bool {
	return a.verifyAt(r, time.Now().Unix())
}

func (a *workerAuth) verifyAt(r *http.Request, now int64) bool {
	if err := a.validateAt(r, now); err != nil {
		log.Printf("Worker authentication rejected method=%q path=%q reason=%q", r.Method, r.URL.EscapedPath(), err)
		return false
	}
	return true
}

func (a *workerAuth) validateAt(r *http.Request, now int64) error {
	if a == nil {
		return fmt.Errorf("Worker authentication is not configured")
	}
	values := r.Header.Values("Authorization")
	if len(values) != 1 || len(values[0]) > 4096 || !strings.HasPrefix(values[0], "Bearer ") {
		return fmt.Errorf("missing or invalid Bearer authorization")
	}
	parts := strings.Split(strings.TrimPrefix(values[0], "Bearer "), ".")
	if len(parts) != 3 {
		return fmt.Errorf("malformed JWT")
	}
	decode := base64.RawURLEncoding.Strict().DecodeString
	header, err := decode(parts[0])
	if err != nil {
		return fmt.Errorf("malformed JWT header encoding")
	}
	var metadata struct{ Alg, Typ, Kid string }
	if decodeJSON(header, &metadata) != nil || metadata.Alg != "EdDSA" || metadata.Typ != "JWT" || metadata.Kid == "" {
		return fmt.Errorf("unsupported or malformed JWT header")
	}
	key := a.key(r.Context(), metadata.Kid)
	if key == nil {
		return fmt.Errorf("signing key unavailable (unknown key ID or expired JWKS cache)")
	}
	sig, err := decode(parts[2])
	if err != nil || !ed25519.Verify(key, []byte(parts[0]+"."+parts[1]), sig) {
		return fmt.Errorf("invalid JWT signature")
	}
	payload, err := decode(parts[1])
	if err != nil {
		return fmt.Errorf("malformed JWT payload encoding")
	}
	var claims struct {
		Issuer    string `json:"iss"`
		Audience  string `json:"aud"`
		Subject   string `json:"sub"`
		Scope     string `json:"scope"`
		Issued    int64  `json:"iat"`
		Expires   int64  `json:"exp"`
		NotBefore int64  `json:"nbf"`
	}
	if json.Unmarshal(payload, &claims) != nil {
		return fmt.Errorf("malformed JWT claims")
	}
	// Only report claim values after signature verification. Never log the token.
	if claims.Issuer != a.issuer {
		return fmt.Errorf("issuer mismatch: got %q, want CONWAYEDGE_WORKER_ISSUER=%q (Worker SITE_URL)", claims.Issuer, a.issuer)
	}
	if claims.Audience != a.audience {
		return fmt.Errorf("audience mismatch: got %q, want CONWAYEDGE_PUBLIC_URL=%q (Worker EDGE_URL)", claims.Audience, a.audience)
	}
	if claims.Subject != "edge-sync" || claims.Scope != "edge:api" {
		return fmt.Errorf("invalid JWT subject or scope")
	}
	if claims.Issued <= 0 || claims.Expires <= claims.Issued || claims.Expires-claims.Issued > 60 {
		return fmt.Errorf("invalid JWT lifetime: iat=%d exp=%d", claims.Issued, claims.Expires)
	}
	if claims.Issued > now+workerClockSkew || claims.NotBefore > now+workerClockSkew {
		return fmt.Errorf("JWT is not yet valid; check edge clock: now=%d iat=%d nbf=%d skew_allowance=%ds", now, claims.Issued, claims.NotBefore, workerClockSkew)
	}
	if claims.Expires <= now {
		return fmt.Errorf("JWT expired; check edge clock or request delay: now=%d exp=%d", now, claims.Expires)
	}
	return nil
}
