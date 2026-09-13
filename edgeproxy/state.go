package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

const swipeRetention = 7 * 24 * time.Hour

var (
	errGoalConflict = errors.New("older or conflicting goal version")
	errNoGoal       = errors.New("no goal received yet")
)

type edge struct {
	db         *sql.DB
	configMu   sync.Mutex // Orders configuration commits and printer lifecycle changes.
	config     []printerConfig
	csrf       string
	printers   printerSet
	signingKey ed25519.PrivateKey
	memberAuth *printerAuth
	accessAuth *accessAuth
}

const schema = `
CREATE TABLE IF NOT EXISTS goal (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version BETWEEN 0 AND 9007199254740991),
  fobs TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS goal_patch (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), patch TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS printer_config (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  config TEXT NOT NULL
);
INSERT OR IGNORE INTO printer_config VALUES (1, '[]');
CREATE TABLE IF NOT EXISTS swipes (
  sequence INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  time INTEGER NOT NULL,
  controller TEXT NOT NULL,
  fob INTEGER NOT NULL CHECK (fob BETWEEN 1 AND 4294967295),
  allowed INTEGER NOT NULL CHECK (allowed IN (0, 1))
);
DROP INDEX IF EXISTS pending_swipes;
DROP INDEX IF EXISTS swipe_history;
CREATE INDEX IF NOT EXISTS swipe_expiry ON swipes(time);
`

func openEdge(dir string) (*edge, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	path, err := filepath.Abs(filepath.Join(dir, "edge.db"))
	if err != nil {
		return nil, err
	}
	// Create with private permissions before SQLite creates its journal files.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	u := url.URL{Scheme: "file", Path: path}
	q := url.Values{"_pragma": {"journal_mode(WAL)", "synchronous(FULL)", "busy_timeout(5000)"}}
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	e := &edge{db: db, csrf: rand.Text()}
	if err := e.initialize(); err != nil {
		db.Close()
		return nil, fmt.Errorf("open edge database: %w", err)
	}
	e.printers.replace(e.config)
	return e, nil
}

func (e *edge) initialize() error {
	return e.transaction(context.Background(), func(tx *sql.Tx) error {
		if _, err := tx.Exec(schema); err != nil {
			return err
		}
		// Upgrade the acknowledgment-based store without changing retained events.
		var acknowledged int
		if err := tx.QueryRow("SELECT count(*) FROM pragma_table_info('swipes') WHERE name = 'acknowledged'").Scan(&acknowledged); err != nil {
			return err
		}
		if acknowledged != 0 {
			if _, err := tx.Exec("ALTER TABLE swipes DROP COLUMN acknowledged"); err != nil {
				return err
			}
		}
		var data []byte
		if err := tx.QueryRow("SELECT config FROM printer_config WHERE singleton = 1").Scan(&data); err != nil {
			return err
		}
		var err error
		e.config, err = parsePrinters(data)
		if err != nil {
			return err
		}
		err = tx.QueryRow("SELECT fobs FROM goal WHERE singleton = 1").Scan(&data)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if err == nil {
			canonical, err := normalizeGoal(data)
			if err != nil {
				return err
			}
			if !bytes.Equal(data, canonical) {
				return fmt.Errorf("stored goal is not canonical JSON")
			}
		}
		return pruneSwipes(tx)
	})
}

func (e *edge) close() {
	e.configMu.Lock()
	defer e.configMu.Unlock()
	e.printers.close()
	_ = e.db.Close()
}

func (e *edge) transaction(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := e.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func (e *edge) storeGoal(ctx context.Context, version int64, body []byte) error {
	result, err := e.db.ExecContext(ctx, `INSERT INTO goal VALUES (1, ?, ?)
ON CONFLICT(singleton) DO UPDATE SET version = excluded.version, fobs = excluded.fobs
WHERE excluded.version > goal.version OR (excluded.version = goal.version AND excluded.fobs = goal.fobs)`, version, string(body))
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err == nil && n == 0 {
		return errGoalConflict
	}
	return err
}

type controllerSwipe struct {
	Fob     uint32 `json:"fob"`
	Allowed bool   `json:"allowed"`
}

type swipe struct {
	ID         string    `json:"id"`
	Time       time.Time `json:"time"`
	Controller string    `json:"controller"`
	Fob        uint32    `json:"fob"`
	Allowed    bool      `json:"allowed"`
}

func pruneSwipes(tx *sql.Tx) error {
	_, err := tx.Exec("DELETE FROM swipes WHERE time < ?", time.Now().Add(-swipeRetention).UnixNano())
	return err
}

// The goal read and complete batch insertion share a transaction. HTTP success
// (including 304) is sent only after the batch commits.
func (e *edge) controllerPoll(ctx context.Context, ip string, events []controllerSwipe) ([]byte, error) {
	var body []byte
	err := e.transaction(ctx, func(tx *sql.Tx) error {
		if err := tx.QueryRow("SELECT fobs FROM goal WHERE singleton = 1").Scan(&body); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return errNoGoal
			}
			return err
		}
		if len(events) == 0 {
			return nil
		}
		stmt, err := tx.Prepare("INSERT INTO swipes(id, time, controller, fob, allowed) VALUES (?, ?, ?, ?, ?)")
		if err != nil {
			return err
		}
		defer stmt.Close()
		now := time.Now().UTC().UnixNano()
		for _, event := range events {
			if _, err := stmt.Exec(rand.Text(), now, ip, event.Fob, event.Allowed); err != nil {
				return err
			}
		}
		return pruneSwipes(tx)
	})
	return body, err
}

func (e *edge) retainedSwipes(ctx context.Context) ([]swipe, error) {
	events := []swipe{}
	err := e.transaction(ctx, func(tx *sql.Tx) error {
		if err := pruneSwipes(tx); err != nil {
			return err
		}
		rows, err := tx.Query("SELECT id, time, controller, fob, allowed FROM swipes ORDER BY sequence")
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var event swipe
			var timestamp int64
			if err := rows.Scan(&event.ID, &timestamp, &event.Controller, &event.Fob, &event.Allowed); err != nil {
				return err
			}
			event.Time = time.Unix(0, timestamp).UTC()
			events = append(events, event)
		}
		return rows.Err()
	})
	return events, err
}

func (e *edge) storePrinters(ctx context.Context, printers []printerConfig) error {
	e.configMu.Lock()
	defer e.configMu.Unlock()
	data, _ := json.Marshal(printers)
	if _, err := e.db.ExecContext(ctx, "UPDATE printer_config SET config = ? WHERE singleton = 1", string(data)); err != nil {
		return err
	}
	e.config = printers
	e.printers.replace(printers)
	return nil
}
