package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"
)

const swipePath = "/webhooks/edge/swipes"
const swipeInterval = 30 * time.Second

func (e *edge) wakeSwipes() {
	select {
	case e.swipeWake <- struct{}{}:
	default:
	}
}

func swipeSignature(key []byte, timestamp string, body []byte) string {
	mac := hmac.New(sha256.New, key)
	fmt.Fprintf(mac, "POST\n%s\n%s\n", swipePath, timestamp)
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func (e *edge) runSwipeSender(ctx context.Context) {
	if e.workerAuth == nil {
		return
	}
	client := &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	e.sendSwipes(ctx, e.workerAuth.issuer, client, swipeInterval)
}

// A leading flush followed by fixed windows. Notifications never reset the timer.
// Restart checks the persistent outbox immediately; failed flushes retry next window.
func (e *edge) sendSwipes(ctx context.Context, origin string, client *http.Client, interval time.Duration) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	active := false
	for {
		select {
		case <-ctx.Done():
			return
		case <-e.swipeWake:
			if !active {
				timer.Reset(0)
			}
		case <-timer.C:
			started := time.Now()
			attempted, err := e.flushSwipes(ctx, origin, client)
			if ctx.Err() != nil {
				return
			}
			if err != nil {
				log.Printf("swipe push failed: %v", err)
			}
			if attempted || err != nil {
				active = true
				delay := max(0, interval-time.Since(started))
				if err != nil {
					delay = interval
				}
				timer.Reset(delay)
			} else {
				active = false
			}
		}
	}
}

// Snapshot the high-water mark so continuous arrivals cannot prolong a flush.
func (e *edge) flushSwipes(ctx context.Context, origin string, client *http.Client) (bool, error) {
	var high int64
	if err := e.db.QueryRowContext(ctx, "SELECT coalesce(max(sequence), 0) FROM swipes WHERE delivered = 0").Scan(&high); err != nil {
		return false, err
	}
	if high == 0 {
		return false, e.transaction(ctx, pruneSwipes)
	}
	for {
		var secret string
		err := e.db.QueryRowContext(ctx, "SELECT event_signing_key FROM goal WHERE singleton = 1").Scan(&secret)
		if err != nil {
			return true, err
		}
		key, err := hex.DecodeString(secret)
		if err != nil || len(key) != 32 {
			return true, fmt.Errorf("waiting for event signing key in goal")
		}
		rows, err := e.db.QueryContext(ctx, "SELECT sequence, id, time, controller, fob, allowed FROM swipes WHERE delivered = 0 AND sequence <= ? ORDER BY sequence LIMIT 512", high)
		if err != nil {
			return true, err
		}
		events := []swipe{}
		var last int64
		for rows.Next() {
			var event swipe
			var timestamp int64
			if err = rows.Scan(&last, &event.ID, &timestamp, &event.Controller, &event.Fob, &event.Allowed); err != nil {
				break
			}
			event.Time = time.Unix(0, timestamp).UTC()
			events = append(events, event)
		}
		rowErr := rows.Err()
		rows.Close()
		if err != nil {
			return true, err
		}
		if rowErr != nil {
			return true, rowErr
		}
		if len(events) == 0 {
			return true, nil
		}
		body, err := json.Marshal(events)
		if err != nil {
			return true, err
		}
		// Controller addresses and generated IDs are bounded; 512 events fit easily.
		if len(body) > 256*1024 {
			return true, fmt.Errorf("swipe batch exceeds 256 KiB")
		}
		timestamp := strconv.FormatInt(time.Now().Unix(), 10)
		req, err := http.NewRequestWithContext(ctx, "POST", origin+swipePath, bytes.NewReader(body))
		if err != nil {
			return true, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Edge-Timestamp", timestamp)
		req.Header.Set("X-Edge-Signature", swipeSignature(key, timestamp, body))
		response, err := client.Do(req)
		if err != nil {
			return true, err
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		response.Body.Close()
		if response.StatusCode != http.StatusNoContent {
			return true, fmt.Errorf("Worker swipe response: %d", response.StatusCode)
		}
		if err := e.transaction(ctx, func(tx *sql.Tx) error {
			if _, err := tx.Exec("UPDATE swipes SET delivered = 1 WHERE delivered = 0 AND sequence <= ?", last); err != nil {
				return err
			}
			return pruneSwipes(tx)
		}); err != nil {
			return true, err
		}
		log.Printf("swipe batch delivered events=%d", len(events))
		if last == high {
			return true, nil
		}
	}
}
