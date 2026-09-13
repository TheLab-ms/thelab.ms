package main

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func testEdge(t *testing.T) *edge {
	t.Helper()
	e, err := openEdge(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.close)
	return e
}

func restartEdge(t *testing.T, e *edge) *edge {
	t.Helper()
	var path string
	if err := e.db.QueryRow("SELECT file FROM pragma_database_list WHERE name = 'main'").Scan(&path); err != nil {
		t.Fatal(err)
	}
	e.close()
	restarted, err := openEdge(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(restarted.close)
	return restarted
}

func request(handler http.Handler, method, path, body string, headers ...string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	for i := 0; i < len(headers); i += 2 {
		r.Header.Set(headers[i], headers[i+1])
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func mtlsRequest(handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	return request(handler, method, path, body,
		"Cf-Cert-Presented", "true", "Cf-Cert-Verified", "true", "Cf-Cert-Revoked", "false")
}

func execSQL(t *testing.T, e *edge, query string, args ...any) {
	t.Helper()
	if _, err := e.db.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}

func countSwipes(t *testing.T, e *edge) int {
	t.Helper()
	var count int
	if err := e.db.QueryRow("SELECT count(*) FROM swipes").Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestSQLiteSetupAndCorruptStartup(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "private ? directory")
	e, err := openEdge(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer e.close()
	for pragma, want := range map[string]string{"journal_mode": "wal", "synchronous": "2", "busy_timeout": "5000"} {
		var got string
		if err := e.db.QueryRow("PRAGMA " + pragma).Scan(&got); err != nil || got != want {
			t.Fatalf("%s = %q, want %q: %v", pragma, got, want, err)
		}
	}
	for path, mode := range map[string]os.FileMode{dir: 0700, filepath.Join(dir, "edge.db"): 0600} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != mode {
			t.Fatalf("permissions for %s: %v %v", path, info, err)
		}
	}
	for _, corrupt := range []string{"database", "goal", "printers"} {
		t.Run(corrupt, func(t *testing.T) {
			dir := t.TempDir()
			if corrupt == "database" {
				if err := os.WriteFile(filepath.Join(dir, "edge.db"), []byte("not a database"), 0600); err != nil {
					t.Fatal(err)
				}
			} else {
				e, err := openEdge(dir)
				if err != nil {
					t.Fatal(err)
				}
				if corrupt == "goal" {
					execSQL(t, e, "INSERT INTO goal VALUES (1, 1, '[0]')")
				} else {
					execSQL(t, e, "UPDATE printer_config SET config = 'null'")
				}
				e.close()
			}
			if e, err := openEdge(dir); err == nil {
				e.close()
				t.Fatal("corrupt state accepted")
			}
		})
	}
}

func TestTransactionFailures(t *testing.T) {
	e := testEdge(t)
	pushVersion(t, e, 1, "[1]", 204)
	lan, _ := e.routes()
	// Fail on the second insert, after the first row has already been written.
	execSQL(t, e, `CREATE TRIGGER reject_swipe BEFORE INSERT ON swipes WHEN NEW.fob = 2
BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END`)
	_, etag, _ := parseGoal([]byte("[1]"))
	w := request(lan, "POST", "/api/fobs", `[{"fob":1},{"fob":2}]`, "If-None-Match", etag)
	if w.Code != 500 || countSwipes(t, e) != 0 {
		t.Fatalf("partial batch acknowledged or committed: %d", w.Code)
	}
	execSQL(t, e, "DROP TRIGGER reject_swipe")
	if w := request(lan, "POST", "/api/fobs", `[{"fob":1},{"fob":2}]`); w.Code != 200 {
		t.Fatal(w.Code)
	}
	before := readSwipes(t, e)
	execSQL(t, e, `CREATE TRIGGER reject_goal BEFORE UPDATE ON goal
BEGIN SELECT RAISE(ABORT, 'injected goal failure'); END`)
	pushVersion(t, e, 2, "[2]", 500)
	e = restartEdge(t, e)
	assertGoal(t, e, 1, "[1]\n")
	execSQL(t, e, "DROP TRIGGER reject_goal")
	pushVersion(t, e, 2, "[2]", 204)
	if !reflect.DeepEqual(before, readSwipes(t, e)) || countSwipes(t, e) != 2 {
		t.Fatal("failed transaction prevented retries or lost history")
	}
	// Read-only SQLite exercises actual storage errors across all write paths.
	execSQL(t, e, "PRAGMA query_only = ON")
	pushVersion(t, e, 3, "[]", 500)
	lan, _ = e.routes()
	if w := request(lan, "POST", "/api/fobs", `[{"fob":1}]`); w.Code != 500 {
		t.Fatal("acknowledged a read-only write")
	}
	if w := request(lan, "POST", "/api/fobs", "[]"); w.Code != 200 {
		t.Fatal("read-only storage blocked empty poll")
	}
}

func TestSwipeRetention(t *testing.T) {
	for _, cleanup := range []string{"startup", "insert", "fetch"} {
		t.Run(cleanup, func(t *testing.T) {
			e := testEdge(t)
			pushVersion(t, e, 0, "[]", 204)
			old, recent := time.Now().Add(-8*24*time.Hour).UnixNano(), time.Now().Add(-6*24*time.Hour).UnixNano()
			for _, item := range []struct {
				id        string
				timestamp int64
			}{
				{"old", old}, {"recent", recent},
			} {
				execSQL(t, e, "INSERT INTO swipes(id,time,controller,fob,allowed) VALUES (?,?,'test',1,1)", item.id, item.timestamp)
			}
			wantCount := 1
			switch cleanup {
			case "startup":
				e = restartEdge(t, e)
			case "insert":
				if _, err := e.controllerPoll(context.Background(), "test", []controllerSwipe{{1, true}}); err != nil {
					t.Fatal(err)
				}
				wantCount++
			case "fetch":
				if events := readSwipes(t, e); len(events) != 1 || events[0].ID != "recent" {
					t.Fatal("fetch returned expired events")
				}
			}
			if countSwipes(t, e) != wantCount || readSwipes(t, e)[0].ID != "recent" {
				t.Fatal("cleanup lost retained events or kept expired history")
			}
			execSQL(t, e, "UPDATE swipes SET time = ?", old)
			if len(readSwipes(t, e)) != 0 || countSwipes(t, e) != 0 {
				t.Fatal("expired events were not collected")
			}
		})
	}
}

func TestSwipeStoreUpgrade(t *testing.T) {
	e := testEdge(t)
	// Recreate the previous schema, including its acknowledgment-dependent indexes.
	execSQL(t, e, `ALTER TABLE swipes ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1));
CREATE INDEX pending_swipes ON swipes(sequence) WHERE acknowledged = 0;
CREATE INDEX swipe_history ON swipes(time) WHERE acknowledged = 1;`)
	now := time.Now()
	for _, delivered := range []int{0, 1} {
		for _, age := range []int{6, 8} {
			execSQL(t, e, "INSERT INTO swipes(id,time,controller,fob,allowed,acknowledged) VALUES (?,?,'door',7,1,?)",
				fmt.Sprintf("event-%d-%d", delivered, age), now.Add(-time.Duration(age)*24*time.Hour).UnixNano(), delivered)
		}
	}
	e = restartEdge(t, e)
	events := readSwipes(t, e)
	if len(events) != 2 || events[0].ID != "event-0-6" || events[1].ID != "event-1-6" {
		t.Fatalf("upgrade lost retained history: %+v", events)
	}
	var columns int
	if err := e.db.QueryRow("SELECT count(*) FROM pragma_table_info('swipes') WHERE name = 'acknowledged'").Scan(&columns); err != nil || columns != 0 {
		t.Fatalf("acknowledgment column remains: %d %v", columns, err)
	}
	pushVersion(t, e, 0, "[]", 204)
	if _, err := e.controllerPoll(context.Background(), "door", []controllerSwipe{{8, false}}); err != nil {
		t.Fatal(err)
	}
	e = restartEdge(t, e)
	if events := readSwipes(t, e); len(events) != 3 || events[2].Fob != 8 {
		t.Fatal("upgraded store cannot append or restart")
	}
}

func TestSwipeRetentionHasNoCountLimit(t *testing.T) {
	e := testEdge(t)
	pushVersion(t, e, 0, "[]", 204)
	execSQL(t, e, `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < ?)
INSERT INTO swipes(id,time,controller,fob,allowed) SELECT 'event-' || x, ?, 'test', 1, 1 FROM n`, 10000, time.Now().UnixNano())
	lan, _ := e.routes()
	if w := request(lan, "POST", "/api/fobs", `[{"fob":1},{"fob":2}]`); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if len(readSwipes(t, e)) != 10002 || countSwipes(t, e) != 10002 {
		t.Fatal("retained events were capped")
	}
}

func TestConcurrentGoalSwipesAndFetch(t *testing.T) {
	e := testEdge(t)
	pushVersion(t, e, 0, "[]", 204)
	lan, cloud := e.routes()
	var wg sync.WaitGroup
	for i := 1; i <= 40; i++ {
		wg.Go(func() {
			w := mtlsRequest(cloud, "PUT", "/api/goal", fmt.Sprintf(`{"version":%d,"fobs":[%d]}`, i, i))
			if w.Code != 204 && w.Code != 409 {
				t.Errorf("concurrent version: %d", w.Code)
			}
			if w := request(lan, "POST", "/api/fobs", fmt.Sprintf(`[{"fob":%d,"allowed":true}]`, i)); w.Code != 200 {
				t.Errorf("concurrent swipe: %d", w.Code)
			}
			readSwipes(t, e)
		})
	}
	wg.Wait()
	e = restartEdge(t, e)
	assertGoal(t, e, 40, "[40]\n")
	remaining := readSwipes(t, e)
	seen := make(map[uint32]bool)
	for _, event := range remaining {
		if seen[event.Fob] {
			t.Fatal("concurrent append duplicated an event")
		}
		seen[event.Fob] = true
	}
	if len(remaining) != 40 || countSwipes(t, e) != 40 {
		t.Fatal("concurrent append/fetch lost or duplicated events")
	}
}

func assertGoal(t *testing.T, e *edge, wantVersion int64, wantBody string) {
	t.Helper()
	var version int64
	var body string
	if err := e.db.QueryRow("SELECT version, fobs FROM goal").Scan(&version, &body); err != nil || version != wantVersion || body != wantBody {
		t.Fatalf("goal = %d %q: %v", version, body, err)
	}
}

func TestCancelledTransaction(t *testing.T) {
	e := testEdge(t)
	ctx, cancel := context.WithCancel(context.Background())
	err := e.transaction(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec("INSERT INTO goal VALUES (1, 0, '[]')")
		cancel()
		return err
	})
	if err == nil {
		t.Fatal("cancelled transaction committed")
	}
	var count int
	if err := e.db.QueryRow("SELECT count(*) FROM goal").Scan(&count); err != nil || count != 0 {
		t.Fatalf("cancelled transaction persisted goal: %d %v", count, err)
	}
}

func TestCrashRecovery(t *testing.T) {
	if dir := os.Getenv("CONWAYEDGE_CRASH_TEST_DIR"); dir != "" {
		e, err := openEdge(dir)
		if err != nil {
			t.Fatal(err)
		}
		pushVersion(t, e, 1, "[7]", 204)
		if _, err := e.controllerPoll(context.Background(), "test", []controllerSwipe{{7, true}, {8, false}}); err != nil {
			t.Fatal(err)
		}
		// Leave a transaction open and exit without closing SQLite. Recovery must
		// keep committed WAL records and discard these uncommitted changes.
		tx, err := e.db.Begin()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec("UPDATE goal SET version = 2, fobs = '[]'; DELETE FROM swipes"); err != nil {
			t.Fatal(err)
		}
		os.Exit(0)
	}
	dir := t.TempDir()
	cmd := exec.Command(os.Args[0], "-test.run=^TestCrashRecovery$")
	cmd.Env = append(os.Environ(), "CONWAYEDGE_CRASH_TEST_DIR="+dir)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("crash subprocess: %v\n%s", err, output)
	}
	e, err := openEdge(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer e.close()
	assertGoal(t, e, 1, "[7]\n")
	events := readSwipes(t, e)
	if len(events) != 2 || events[0].Fob != 7 || events[1].Fob != 8 || countSwipes(t, e) != 2 {
		t.Fatal("crash recovery lost committed events or committed an open transaction")
	}
}
