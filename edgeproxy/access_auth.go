package main

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Access authenticates the service token at Cloudflare. Verify its signed
// assertion at the origin as well; raw forwarded identity headers aren't proof.
type accessAuth struct {
	issuer, audience   string
	mu                 sync.Mutex
	keys               map[string]*rsa.PublicKey
	expires, refreshed time.Time
	client             *http.Client
}

func loadAccessAuth(issuer, audience string) (*accessAuth, error) {
	if issuer == "" && audience == "" {
		return nil, nil
	}
	u, err := url.Parse(issuer)
	if err != nil || u.Scheme != "https" || u.User != nil || issuer != "https://"+u.Host ||
		!strings.HasSuffix(u.Hostname(), ".cloudflareaccess.com") || u.Port() != "" || audience == "" {
		return nil, fmt.Errorf("Access requires a https://<team>.cloudflareaccess.com issuer and application audience")
	}
	return &accessAuth{issuer: issuer, audience: audience, client: &http.Client{
		Timeout:       5 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}, nil
}

func (a *accessAuth) key(ctx context.Context, kid string) *rsa.PublicKey {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := time.Now()
	if now.Before(a.expires) && a.keys[kid] != nil {
		return a.keys[kid]
	}
	// Unknown key IDs can trigger rotation refresh, at most once per minute.
	if now.Sub(a.refreshed) < time.Minute {
		return nil
	}
	a.refreshed = now
	req, err := http.NewRequestWithContext(ctx, "GET", a.issuer+"/cdn-cgi/access/certs", nil)
	if err != nil {
		return nil
	}
	response, err := a.client.Do(req)
	if err != nil {
		return nil
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(body) > 65536 {
		return nil
	}
	var jwks struct {
		Keys []struct{ Kid, Kty, Alg, Use, N, E string } `json:"keys"`
	}
	if json.Unmarshal(body, &jwks) != nil {
		return nil
	}
	keys := make(map[string]*rsa.PublicKey)
	for _, key := range jwks.Keys {
		if key.Kty != "RSA" || key.Alg != "RS256" || key.Use != "sig" || key.Kid == "" {
			continue
		}
		n, errN := base64.RawURLEncoding.DecodeString(key.N)
		e, errE := base64.RawURLEncoding.DecodeString(key.E)
		if errN != nil || errE != nil || len(n) < 256 || len(n) > 1024 || len(e) == 0 || len(e) > 4 {
			continue
		}
		exponent := new(big.Int).SetBytes(e).Int64()
		if exponent < 3 || exponent > 2147483647 || exponent%2 == 0 {
			continue
		}
		keys[key.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(exponent)}
	}
	if len(keys) == 0 {
		return nil
	}
	a.keys, a.expires = keys, now.Add(time.Hour)
	return keys[kid]
}

func (a *accessAuth) verify(r *http.Request) bool {
	if a == nil {
		return false
	}
	values := r.Header.Values("Cf-Access-Jwt-Assertion")
	if len(values) != 1 || len(values[0]) > 16384 {
		return false
	}
	parts := strings.Split(values[0], ".")
	if len(parts) != 3 {
		return false
	}
	decode := base64.RawURLEncoding.Strict().DecodeString
	header, err := decode(parts[0])
	if err != nil {
		return false
	}
	var metadata struct{ Alg, Kid string }
	if json.Unmarshal(header, &metadata) != nil || metadata.Alg != "RS256" || metadata.Kid == "" {
		return false
	}
	key := a.key(r.Context(), metadata.Kid)
	if key == nil {
		return false
	}
	signature, err := decode(parts[2])
	if err != nil {
		return false
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], signature) != nil {
		return false
	}
	payload, err := decode(parts[1])
	if err != nil {
		return false
	}
	var claims struct {
		Issuer    string   `json:"iss"`
		Audience  []string `json:"aud"`
		Expires   int64    `json:"exp"`
		Issued    int64    `json:"iat"`
		NotBefore int64    `json:"nbf"`
	}
	if json.Unmarshal(payload, &claims) != nil {
		return false
	}
	now := time.Now().Unix()
	if claims.Issuer != a.issuer || claims.Expires <= now || claims.Issued <= 0 || claims.Issued > now || claims.NotBefore > now || claims.Expires <= claims.Issued {
		return false
	}
	for _, audience := range claims.Audience {
		if audience == a.audience {
			return true
		}
	}
	return false
}
