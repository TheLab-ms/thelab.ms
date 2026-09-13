package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const printerTokenAge = 300
const printerCookie = "__Host-thelab_printers"
const printerNonceCookie = "__Host-thelab_printer_nonce"

var noncePattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var memberSubjectPattern = regexp.MustCompile(`^[1-9][0-9]{16,19}$`)

type printerAuth struct {
	issuer, origin string
	key            ed25519.PublicKey
}

func loadPrinterAuth(issuer, origin, publicKey string) (*printerAuth, error) {
	if issuer == "" && origin == "" && publicKey == "" {
		return nil, nil
	}
	for _, value := range []string{issuer, origin} {
		u, err := url.Parse(value)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || value != "https://"+u.Host {
			return nil, fmt.Errorf("printer issuer and origin must be HTTPS origins without trailing slashes")
		}
	}
	der, err := base64.StdEncoding.DecodeString(publicKey)
	if err != nil {
		return nil, fmt.Errorf("printer public key must be base64 SPKI DER")
	}
	key, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, fmt.Errorf("invalid printer public key: %w", err)
	}
	ed, ok := key.(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("printer public key must be Ed25519")
	}
	return &printerAuth{issuer: issuer, origin: origin, key: ed}, nil
}

type printerClaims struct {
	Issuer   string `json:"iss"`
	Audience string `json:"aud"`
	Subject  string `json:"sub"`
	Active   bool   `json:"active_member"`
	Scope    string `json:"scope"`
	State    string `json:"state"`
	Issued   int64  `json:"iat"`
	Expires  int64  `json:"exp"`
}

func (a *printerAuth) verify(token string) *printerClaims {
	if a == nil || len(token) > 4096 {
		return nil
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil
	}
	decode := base64.RawURLEncoding.Strict().DecodeString
	header, err := decode(parts[0])
	if err != nil {
		return nil
	}
	var metadata struct {
		Alg string `json:"alg"`
		Typ string `json:"typ"`
	}
	if decodeJSON(header, &metadata) != nil || metadata.Alg != "EdDSA" || metadata.Typ != "JWT" {
		return nil
	}
	signature, err := decode(parts[2])
	if err != nil || !ed25519.Verify(a.key, []byte(parts[0]+"."+parts[1]), signature) {
		return nil
	}
	payload, err := decode(parts[1])
	if err != nil {
		return nil
	}
	var c printerClaims
	if json.Unmarshal(payload, &c) != nil {
		return nil
	}
	now := time.Now().Unix()
	if c.Issuer != a.issuer || c.Audience != a.origin || !memberSubjectPattern.MatchString(c.Subject) || !c.Active || c.Scope != "printers:read" || !noncePattern.MatchString(c.State) ||
		c.Issued <= 0 || c.Issued > now || c.Expires <= now || c.Expires <= c.Issued || c.Expires-c.Issued > printerTokenAge {
		return nil
	}
	return &c
}

func printerSessionCookie(w http.ResponseWriter, name, value string, age int) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: age})
}

func (e *edge) printerLogin(w http.ResponseWriter, r *http.Request) {
	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		http.Error(w, "sign-in unavailable", 503)
		return
	}
	state := hex.EncodeToString(nonce[:])
	printerSessionCookie(w, printerNonceCookie, state, 600)
	http.Redirect(w, r, e.memberAuth.issuer+"/machines?state="+state, http.StatusSeeOther)
}

func (e *edge) printerSession(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") != e.memberAuth.origin {
		http.Error(w, "invalid origin", 403)
		return
	}
	var input struct {
		Token string `json:"token"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	claims := e.memberAuth.verify(input.Token)
	nonce, err := r.Cookie(printerNonceCookie)
	if claims == nil || err != nil || !secretEqual(claims.State, nonce.Value) {
		http.Error(w, "invalid or expired machine status sign-in", 401)
		return
	}
	printerSessionCookie(w, printerCookie, input.Token, int(claims.Expires-time.Now().Unix()))
	printerSessionCookie(w, printerNonceCookie, "", -1)
	w.WriteHeader(http.StatusNoContent)
}

func (e *edge) printerResource(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if e.memberAuth == nil {
			http.Error(w, "machine status access is not configured", http.StatusServiceUnavailable)
			return
		}
		next(w, r)
	}
}

func (e *edge) requirePrinterMember(next func(http.ResponseWriter, *http.Request, *printerClaims)) http.HandlerFunc {
	return e.printerResource(func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(printerCookie)
		var claims *printerClaims
		if err == nil {
			claims = e.memberAuth.verify(cookie.Value)
		}
		if claims == nil {
			if r.URL.Path == "/machines" {
				http.Redirect(w, r, "/machines/login", http.StatusSeeOther)
			} else {
				http.Error(w, "machine status session expired", http.StatusUnauthorized)
			}
			return
		}
		next(w, r, claims)
	})
}
