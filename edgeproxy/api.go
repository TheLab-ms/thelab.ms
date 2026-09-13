package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"slices"
	"strconv"
)

func decodeJSON(data []byte, value any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(value); err != nil {
		return err
	}
	if d.Decode(new(any)) != io.EOF {
		return fmt.Errorf("expected one JSON value")
	}
	return nil
}

func readJSON(w http.ResponseWriter, r *http.Request, value any) bool {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16<<10))
	if err != nil || decodeJSON(data, value) != nil {
		http.Error(w, "invalid JSON (limit 16 KiB)", http.StatusBadRequest)
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func storageError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errGoalConflict):
		http.Error(w, err.Error(), http.StatusConflict)
	case errors.Is(err, errNoGoal):
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
	default:
		log.Printf("storage: %v", err)
		http.Error(w, "storage unavailable; retry later", http.StatusInternalServerError)
	}
}

func parseGoal(data []byte) ([]byte, string, error) {
	var ids []uint32
	if err := json.Unmarshal(data, &ids); err != nil || ids == nil || len(ids) > 512 || slices.Contains(ids, 0) {
		return nil, "", fmt.Errorf("goal must be an array of at most 512 nonzero uint32 fob IDs")
	}
	slices.Sort(ids)
	ids = slices.Compact(ids)
	body, _ := json.Marshal(ids)
	body = append(body, '\n')
	hash := sha256.New()
	for _, id := range ids {
		fmt.Fprintf(hash, "%d,", id)
	}
	return body, fmt.Sprintf("%x", hash.Sum(nil)), nil
}

func (e *edge) goal(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Version *int64          `json:"version"`
		Fobs    json.RawMessage `json:"fobs"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	if input.Version == nil || *input.Version < 0 || *input.Version > 9007199254740991 {
		http.Error(w, "version must be a nonnegative safe integer", http.StatusBadRequest)
		return
	}
	body, _, err := parseGoal(input.Fobs)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := e.storeGoal(r.Context(), *input.Version, body); err != nil {
		storageError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (e *edge) fobs(w http.ResponseWriter, r *http.Request) {
	var events []controllerSwipe
	if !readJSON(w, r, &events) {
		return
	}
	if events == nil || len(events) > 512 {
		http.Error(w, "expected an array of at most 512 swipes", http.StatusBadRequest)
		return
	}
	for _, event := range events {
		if event.Fob == 0 {
			http.Error(w, "invalid fob ID", http.StatusBadRequest)
			return
		}
	}
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	data, err := e.controllerPoll(r.Context(), ip, events)
	if err != nil {
		storageError(w, err)
		return
	}
	body, etag, err := parseGoal(data)
	if err != nil {
		storageError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("ETag", etag)
	if e.signingKey != nil {
		w.Header().Set("X-Fob-Signature", base64.StdEncoding.EncodeToString(ed25519.Sign(e.signingKey, body)))
	}
	// Firmware does not decode chunked transfer encoding.
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	_, _ = w.Write(body)
}

func (e *edge) getSwipes(w http.ResponseWriter, r *http.Request) {
	events, err := e.retainedSwipes(r.Context())
	if err != nil {
		storageError(w, err)
		return
	}
	writeJSON(w, events)
}

func loadSigningSeed(path string) (ed25519.PrivateKey, error) {
	if path == "" {
		return nil, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open signing seed: %w", err)
	}
	defer f.Close()
	seed, err := io.ReadAll(io.LimitReader(f, ed25519.SeedSize+1))
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("signing seed must be exactly 32 raw bytes")
	}
	return ed25519.NewKeyFromSeed(seed), nil
}
