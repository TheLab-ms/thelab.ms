package main

import (
	"fmt"
	"html/template"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
)

func printerForm(e *edge, action string, printers ...printerConfig) url.Values {
	form := url.Values{"csrf": {e.csrf}, "action": {action}, "count": {fmt.Sprint(len(printers))}}
	for i, p := range printers {
		form.Set(fmt.Sprintf("name_%d", i), p.Name)
		form.Set(fmt.Sprintf("host_%d", i), p.Host)
		form.Set(fmt.Sprintf("access_code_%d", i), p.AccessCode)
		form.Set(fmt.Sprintf("serial_number_%d", i), p.SerialNumber)
	}
	return form
}

func TestPrinterFormWorkflow(t *testing.T) {
	e := testEdge(t)
	lan, _ := e.routes()
	submit := func(action string, printers ...printerConfig) *httptest.ResponseRecorder {
		return request(lan, "POST", "/", printerForm(e, action, printers...).Encode(), "Content-Type", "application/x-www-form-urlencoded")
	}
	p := printerConfig{Name: `Workshop <X1> "test"`, Host: "127.0.0.1", AccessCode: `secret"<&`, SerialNumber: "serial"}
	w := submit("add")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `name="name_0"`) || len(e.config) != 0 {
		t.Fatalf("add first printer: %d %s", w.Code, w.Body.String())
	}
	w = submit("add", p)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `name="name_1"`) || !strings.Contains(w.Body.String(), template.HTMLEscapeString(p.AccessCode)) {
		t.Fatalf("add did not preserve draft: %d %s", w.Code, w.Body.String())
	}
	if disk := storedPrinters(t, e); disk != "[]" {
		t.Fatalf("draft persisted: %s", disk)
	}
	second := printerConfig{Name: "Second", Host: "::1", AccessCode: "other", SerialNumber: "second"}
	w = submit("save", p, second)
	if w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/" || !reflect.DeepEqual(e.config, []printerConfig{p, second}) {
		t.Fatalf("save: %d %s", w.Code, w.Body.String())
	}
	w = request(lan, "GET", "/", "")
	for _, field := range []string{`action="/"`, `type="password"`, `name="serial_number_1"`, template.HTMLEscapeString(p.Name), template.HTMLEscapeString(p.AccessCode)} {
		if !strings.Contains(w.Body.String(), field) {
			t.Fatalf("missing field %q: %s", field, w.Body.String())
		}
	}
	if strings.Contains(w.Body.String(), "<textarea") || strings.Contains(w.Body.String(), p.Name) {
		t.Fatal("raw JSON editor or unescaped printer name in form")
	}
	w = submit("remove_0", p, second)
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), template.HTMLEscapeString(p.Name)) || !strings.Contains(w.Body.String(), `name="name_0" value="Second"`) || len(e.config) != 2 {
		t.Fatalf("remove did not preserve draft and live state: %d %s", w.Code, w.Body.String())
	}
	w = submit("save", second)
	if w.Code != http.StatusSeeOther || !reflect.DeepEqual(e.config, []printerConfig{second}) {
		t.Fatalf("save removal: %d %s", w.Code, w.Body.String())
	}
	w = submit("remove_0", second)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "No printers configured") || len(e.config) != 1 {
		t.Fatalf("remove last draft printer: %d %s", w.Code, w.Body.String())
	}
	w = submit("save")
	disk := storedPrinters(t, e)
	if w.Code != http.StatusSeeOther || len(e.config) != 0 || len(e.printers.printers) != 0 || disk != "[]" {
		t.Fatalf("clear printers: %d disk=%q", w.Code, disk)
	}
}

func TestPrinterFormRejectsInvalidSaves(t *testing.T) {
	e := testEdge(t)
	lan, _ := e.routes()
	p := printerConfig{Name: "Printer", Host: "127.0.0.1", AccessCode: "secret", SerialNumber: "serial"}
	post := func(form url.Values) *httptest.ResponseRecorder {
		return request(lan, "POST", "/", form.Encode(), "Content-Type", "application/x-www-form-urlencoded")
	}
	if w := post(printerForm(e, "save", p)); w.Code != http.StatusSeeOther {
		t.Fatalf("initial save: %d", w.Code)
	}
	before := storedPrinters(t, e)
	cases := []struct{ key, value string }{
		{"name_0", ""}, {"host_0", "printer.local"}, {"access_code_0", ""},
		{"serial_number_0", "bad/serial"}, {"count", ""}, {"count", "-1"}, {"count", "33"},
		{"action", "remove_9"}, {"action", "unknown"},
	}
	for _, tc := range cases {
		t.Run(tc.key+"="+tc.value, func(t *testing.T) {
			form := printerForm(e, "save", p)
			form.Set(tc.key, tc.value)
			if w := post(form); w.Code != http.StatusBadRequest {
				t.Fatalf("invalid form accepted: %d", w.Code)
			}
		})
	}
	w := post(printerForm(e, "save", p, p))
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), `role="alert"`) || !strings.Contains(w.Body.String(), `name="access_code_1" value="secret"`) {
		t.Fatalf("duplicate serial error lost draft: %d %s", w.Code, w.Body.String())
	}
	for _, action := range []string{"add", "remove_0", "save"} {
		form := printerForm(e, action, p)
		form.Set("csrf", "wrong")
		if w := post(form); w.Code != http.StatusForbidden {
			t.Fatalf("%s bypassed CSRF: %d", action, w.Code)
		}
	}
	if w := request(lan, "POST", "/", strings.Repeat("x", 64<<10+1), "Content-Type", "application/x-www-form-urlencoded"); w.Code != http.StatusBadRequest {
		t.Fatalf("oversized form accepted: %d", w.Code)
	}
	after := storedPrinters(t, e)
	if before != after || !reflect.DeepEqual(e.config, []printerConfig{p}) {
		t.Fatal("invalid submissions changed persisted or live configuration")
	}
}

func storedPrinters(t *testing.T, e *edge) string {
	t.Helper()
	var data string
	if err := e.db.QueryRow("SELECT config FROM printer_config").Scan(&data); err != nil {
		t.Fatal(err)
	}
	return data
}

func TestPrinterConfigPersistence(t *testing.T) {
	e := testEdge(t)
	lan, _ := e.routes()
	p := printerConfig{Name: "Printer", Host: "127.0.0.1", AccessCode: "secret", SerialNumber: "serial"}
	if w := request(lan, "POST", "/", printerForm(e, "save", p).Encode(), "Content-Type", "application/x-www-form-urlencoded"); w.Code != 303 {
		t.Fatal(w.Code)
	}
	e = restartEdge(t, e)
	if !reflect.DeepEqual(e.config, []printerConfig{p}) {
		t.Fatal("printer configuration not restored")
	}
	before := storedPrinters(t, e)
	execSQL(t, e, "PRAGMA query_only = ON")
	lan, _ = e.routes()
	w := request(lan, "POST", "/", printerForm(e, "save").Encode(), "Content-Type", "application/x-www-form-urlencoded")
	if w.Code != 500 || storedPrinters(t, e) != before || !reflect.DeepEqual(e.config, []printerConfig{p}) {
		t.Fatal("failed save changed printer configuration")
	}
	e.printers.mu.RLock()
	defer e.printers.mu.RUnlock()
	if e.printers.printers[p.SerialNumber] == nil {
		t.Fatal("failed save removed running printer")
	}
}
