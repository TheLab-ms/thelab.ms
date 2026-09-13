package main

import (
	"fmt"
	"html/template"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

func parsePrinters(data []byte) ([]printerConfig, error) {
	var printers []printerConfig
	if err := decodeJSON(data, &printers); err != nil {
		return nil, fmt.Errorf("invalid printer JSON: %w", err)
	}
	if printers == nil || len(printers) > 32 {
		return nil, fmt.Errorf("expected one array of at most 32 printers")
	}
	if err := validatePrinters(printers); err != nil {
		return nil, err
	}
	return printers, nil
}

func validatePrinters(printers []printerConfig) error {
	if len(printers) > 32 {
		return fmt.Errorf("at most 32 printers are supported")
	}
	seen := make(map[string]bool)
	for i, p := range printers {
		// Literal addresses keep local configuration unambiguous; ports are fixed.
		if p.Name == "" || net.ParseIP(p.Host) == nil || p.AccessCode == "" || p.SerialNumber == "" ||
			strings.ContainsAny(p.SerialNumber, "/+# \t\r\n") || seen[p.SerialNumber] {
			return fmt.Errorf("printer %d needs a name, IP address, access code, and unique serial number without spaces or / + #", i+1)
		}
		seen[p.SerialNumber] = true
	}
	return nil
}

var configPage = template.Must(template.New("config").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>conwayedge configuration</title>
<style>
body{font:16px system-ui;margin:2rem auto;padding:0 1rem;max-width:55rem;color:#17212b;background:#f7f8fa}
fieldset{margin:1.5rem 0;padding:1.25rem;border:1px solid #b8c2cc;border-radius:.5rem;background:white;min-width:0}
legend{font-weight:600;padding:0 .5rem}.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr));gap:1rem}
label{display:block}input{display:block;box-sizing:border-box;width:100%;margin-top:.4rem;padding:.6rem;font:inherit;border:1px solid #788797;border-radius:.25rem}
button{padding:.6rem 1.2rem;font:inherit;cursor:pointer;border:1px solid #788797;border-radius:.25rem;background:white}
button:disabled{cursor:default;opacity:.5}.remove{margin-top:1rem;color:#a11b1b}.actions{display:flex;gap:.75rem;flex-wrap:wrap}.save{background:#174ea6;color:white;border-color:#174ea6}
.error{padding:1rem;border:1px solid #a11b1b;border-radius:.25rem;background:#fff0f0;color:#871717}small{display:block;margin-top:.35rem;color:#485767}
</style></head><body><main>
<h1>conwayedge</h1><h2>Printers</h2>
<p>Configure up to 32 Bambu printers with LAN access enabled. Status is polled every five seconds.</p>
<p>Add, edit, or remove printers below, then select <strong>Save changes</strong> to apply. Removing all printers and saving clears the configuration.</p>
{{if .Error}}<p class="error" role="alert">{{.Error}}</p>{{end}}
<form method="post" action="/" autocomplete="off"><input type="hidden" name="csrf" value="{{.CSRF}}">
<input type="hidden" name="count" value="{{len .Printers}}">
<button type="submit" name="action" value="save" hidden>Save changes</button>
{{range $i, $p := .Printers}}
<fieldset><legend>{{if .Name}}{{.Name}}{{else}}New printer{{end}}</legend><div class="fields">
<label>Name<input name="name_{{$i}}" value="{{.Name}}" placeholder="Workshop X1C" required></label>
<label>IP address<input name="host_{{$i}}" value="{{.Host}}" placeholder="192.168.1.50" spellcheck="false" autocapitalize="none" required><small>Use a literal IPv4 or IPv6 address, without a port.</small></label>
<label>Access code<input type="password" name="access_code_{{$i}}" value="{{.AccessCode}}" autocomplete="off" required><small>The printer's LAN access code.</small></label>
<label>Serial number<input name="serial_number_{{$i}}" value="{{.SerialNumber}}" spellcheck="false" autocapitalize="none" required><small>Must be unique, without spaces or / + #.</small></label>
</div><button class="remove" type="submit" name="action" value="remove_{{$i}}" formnovalidate>Remove printer</button></fieldset>
{{else}}<p>No printers configured. Select <strong>Add printer</strong> to get started.</p>{{end}}
<div class="actions"><button type="submit" name="action" value="add" formnovalidate {{if ge (len .Printers) 32}}disabled{{end}}>Add printer</button>
<button class="save" type="submit" name="action" value="save">Save changes</button></div>
</form></main></body></html>`))

func (e *edge) renderConfig(w http.ResponseWriter, status int, printers []printerConfig, message string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_ = configPage.Execute(w, struct {
		CSRF     string
		Printers []printerConfig
		Error    string
	}{e.csrf, printers, message})
}

func printersFromForm(form url.Values) ([]printerConfig, error) {
	count, err := strconv.Atoi(form.Get("count"))
	if err != nil || count < 0 || count > 32 {
		return nil, fmt.Errorf("expected a printer count between 0 and 32")
	}
	printers := make([]printerConfig, count)
	for i := range printers {
		suffix := "_" + strconv.Itoa(i)
		printers[i] = printerConfig{
			Name: form.Get("name" + suffix), Host: form.Get("host" + suffix),
			AccessCode: form.Get("access_code" + suffix), SerialNumber: form.Get("serial_number" + suffix),
		}
	}
	return printers, nil
}

func (e *edge) configure(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
	switch r.Method {
	case http.MethodGet:
		e.configMu.Lock()
		printers := append([]printerConfig(nil), e.config...)
		e.configMu.Unlock()
		e.renderConfig(w, http.StatusOK, printers, "")
	case http.MethodPost:
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
		if err := r.ParseForm(); err != nil {
			http.Error(w, "invalid form (limit 64 KiB)", http.StatusBadRequest)
			return
		}
		if !secretEqual(r.PostForm.Get("csrf"), e.csrf) {
			http.Error(w, "invalid form token", http.StatusForbidden)
			return
		}
		printers, err := printersFromForm(r.PostForm)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		action := r.PostForm.Get("action")
		switch {
		case action == "add":
			if len(printers) == 32 {
				e.renderConfig(w, http.StatusBadRequest, printers, "At most 32 printers are supported.")
				return
			}
			e.renderConfig(w, http.StatusOK, append(printers, printerConfig{}), "")
			return
		case strings.HasPrefix(action, "remove_"):
			i, err := strconv.Atoi(strings.TrimPrefix(action, "remove_"))
			if err != nil || i < 0 || i >= len(printers) {
				http.Error(w, "invalid printer to remove", http.StatusBadRequest)
				return
			}
			printers = append(printers[:i], printers[i+1:]...)
			e.renderConfig(w, http.StatusOK, printers, "")
			return
		case action != "save":
			http.Error(w, "invalid form action", http.StatusBadRequest)
			return
		}
		if err := validatePrinters(printers); err != nil {
			e.renderConfig(w, http.StatusBadRequest, printers, err.Error())
			return
		}
		e.configMu.Lock()
		defer e.configMu.Unlock()
		if err := e.storePrinters(r.Context(), printers); err != nil {
			log.Printf("persist printers: %v", err)
			e.renderConfig(w, http.StatusInternalServerError, printers, "Cannot save printers. Please try again.")
			return
		}
		e.config = printers
		e.printers.replace(printers)
		http.Redirect(w, r, "/", http.StatusSeeOther)
	default:
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
