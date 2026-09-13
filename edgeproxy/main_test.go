package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCloudflareMTLSAuth(t *testing.T) {
	e := testEdge(t)
	_, cloud := e.routes()
	valid := http.Header{
		"Cf-Cert-Presented": {"true"},
		"Cf-Cert-Verified":  {"true"},
		"Cf-Cert-Revoked":   {"false"},
	}
	type authCase struct {
		name    string
		headers http.Header
	}
	cases := []authCase{
		{"missing headers", nil},
		{"legacy bearer token", http.Header{"Authorization": {"Bearer token"}}},
	}
	for name := range valid {
		headers := valid.Clone()
		headers.Del(name)
		cases = append(cases, authCase{name + " missing", headers})
		for _, value := range []string{"", "TRUE", "1", "SUCCESS", "true,false", " true", "false "} {
			headers := valid.Clone()
			headers.Set(name, value)
			cases = append(cases, authCase{name + "=" + value, headers})
		}
		for _, value := range []string{"true", "false"} {
			headers := valid.Clone()
			headers.Add(name, value)
			cases = append(cases, authCase{name + " duplicate " + value, headers})
		}
		headers = valid.Clone()
		if name == "Cf-Cert-Revoked" {
			headers.Set(name, "true")
		} else {
			headers.Set(name, "false")
		}
		cases = append(cases, authCase{name + " rejected status", headers})
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, route := range []struct{ method, path, body string }{
				{"PUT", "/api/goal", `{"version":1,"fobs":[1]}`},
				{"GET", "/api/swipes", ""},
				{"GET", "/api/printers", ""},
				{"GET", "/api/printers/test/snapshot.jpg", ""},
			} {
				r := httptest.NewRequest(route.method, route.path, strings.NewReader(route.body))
				r.Header = tc.headers.Clone()
				w := httptest.NewRecorder()
				cloud.ServeHTTP(w, r)
				if w.Code != http.StatusUnauthorized || w.Header().Get("Cache-Control") != "no-store" {
					t.Fatalf("%s: %d %v", route.path, w.Code, w.Header())
				}
			}
		})
	}
	var count int
	if err := e.db.QueryRow("SELECT count(*) FROM goal").Scan(&count); err != nil || count != 0 {
		t.Fatal("unauthenticated requests mutated goal")
	}
	// Header names are case-insensitive on the wire. Authorization is no longer
	// involved in authentication when the mTLS assertions are valid.
	w := request(cloud, "GET", "/api/swipes", "",
		"cf-cert-presented", "true", "cf-cert-verified", "true", "cf-cert-revoked", "false",
		"Authorization", "Bearer obsolete")
	if w.Code != http.StatusOK {
		t.Fatalf("verified certificate rejected: %d %s", w.Code, w.Body.String())
	}
}
