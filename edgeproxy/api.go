package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"database/sql"
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

func normalizeGoal(data []byte) ([]byte, error) {
	var ids []uint32
	if err := json.Unmarshal(data, &ids); err != nil || ids == nil || len(ids) > 512 || slices.Contains(ids, 0) {
		return nil, fmt.Errorf("goal must be an array of at most 512 nonzero uint32 fob IDs")
	}
	slices.Sort(ids)
	ids = slices.Compact(ids)
	body, _ := json.Marshal(ids)
	return append(body, '\n'), nil
}

func controllerETag(body []byte) (string, error) {
	var ids []uint32
	if err := json.Unmarshal(body, &ids); err != nil {
		return "", err
	}
	// Firmware hashes decimal IDs followed by commas, not the JSON response.
	hash := sha256.New()
	for _, id := range ids {
		fmt.Fprintf(hash, "%d,", id)
	}
	return fmt.Sprintf("%x", hash.Sum(nil)), nil
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
	body, err := normalizeGoal(input.Fobs)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := e.storeGoal(r.Context(), *input.Version, body); err != nil {
		storageError(w, err)
		return
	}
	log.Printf("goal stored version=%d bytes=%d", *input.Version, len(body))
	w.WriteHeader(http.StatusNoContent)
}

func (e *edge) getGoal(w http.ResponseWriter, r *http.Request) {
	var version int64
	var fobs []byte
	err := e.db.QueryRowContext(r.Context(), "SELECT version, fobs FROM goal WHERE singleton = 1").Scan(&version, &fobs)
	if errors.Is(err, sql.ErrNoRows) {
		err = errNoGoal
	}
	if err != nil {
		storageError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		Version int64           `json:"version"`
		Fobs    json.RawMessage `json:"fobs"`
	}{version, fobs})
}

func (e *edge) patchGoal(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Base    *int64   `json:"base_version"`
		Version *int64   `json:"version"`
		Add     []uint32 `json:"add"`
		Remove  []uint32 `json:"remove"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	if input.Base == nil || input.Version == nil || *input.Base < 0 || *input.Version <= *input.Base || *input.Version > 9007199254740991 ||
		input.Add == nil || input.Remove == nil || len(input.Add) > 512 || len(input.Remove) > 512 || slices.Contains(input.Add, 0) || slices.Contains(input.Remove, 0) {
		http.Error(w, "invalid goal diff", 400)
		return
	}
	slices.Sort(input.Add)
	input.Add = slices.Compact(input.Add)
	slices.Sort(input.Remove)
	input.Remove = slices.Compact(input.Remove)
	for _, id := range input.Add {
		if slices.Contains(input.Remove, id) {
			http.Error(w, "overlapping goal diff", 400)
			return
		}
	}
	patch, _ := json.Marshal(input)
	err := e.transaction(r.Context(), func(tx *sql.Tx) error {
		var version int64
		var body []byte
		if err := tx.QueryRow("SELECT version, fobs FROM goal WHERE singleton = 1").Scan(&version, &body); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return errNoGoal
			}
			return err
		}
		if version == *input.Version {
			var previous string
			err := tx.QueryRow("SELECT patch FROM goal_patch WHERE singleton = 1").Scan(&previous)
			if err == nil && previous == string(patch) {
				return nil
			}
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			return errGoalConflict
		}
		if version != *input.Base {
			return errGoalConflict
		}
		var ids []uint32
		if err := json.Unmarshal(body, &ids); err != nil {
			return err
		}
		ids = slices.DeleteFunc(ids, func(id uint32) bool { return slices.Contains(input.Remove, id) })
		ids = append(ids, input.Add...)
		slices.Sort(ids)
		ids = slices.Compact(ids)
		if len(ids) > 512 {
			return errGoalCapacity
		}
		body, _ = json.Marshal(ids)
		body = append(body, '\n')
		if _, err := tx.Exec("UPDATE goal SET version = ?, fobs = ? WHERE singleton = 1", *input.Version, string(body)); err != nil {
			return err
		}
		_, err := tx.Exec("INSERT INTO goal_patch VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET patch = excluded.patch", string(patch))
		return err
	})
	if errors.Is(err, errGoalCapacity) {
		http.Error(w, err.Error(), 400)
		return
	}
	if err != nil {
		storageError(w, err)
		return
	}
	log.Printf("goal diff stored base_version=%d version=%d added=%d removed=%d", *input.Base, *input.Version, len(input.Add), len(input.Remove))
	w.WriteHeader(http.StatusNoContent)
}

var errGoalCapacity = errors.New("goal exceeds 512 fobs")

func (e *edge) fobs(w http.ResponseWriter, r *http.Request) {
	var input []struct {
		Fob     uint32 `json:"fob"`
		Allowed *bool  `json:"allowed"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	if input == nil || len(input) > 512 {
		http.Error(w, "expected an array of at most 512 swipes", http.StatusBadRequest)
		return
	}
	events := make([]controllerSwipe, 0, len(input))
	for _, event := range input {
		if event.Fob == 0 || event.Allowed == nil {
			http.Error(w, "each swipe requires a nonzero fob ID and boolean allowed", http.StatusBadRequest)
			return
		}
		events = append(events, controllerSwipe{Fob: event.Fob, Allowed: *event.Allowed})
	}
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	body, err := e.controllerPoll(r.Context(), ip, events)
	if err != nil {
		storageError(w, err)
		return
	}
	if len(events) > 0 {
		log.Printf("controller swipes stored controller=%q events=%d", ip, len(events))
	}
	etag, err := controllerETag(body)
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
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(events)
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
