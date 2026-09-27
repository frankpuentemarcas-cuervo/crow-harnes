package server

import (
	"bufio"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func shellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'" }

func (a *App) loadHookSettings() error {
	data, err := os.ReadFile(filepath.Join(a.dir, "hooks.json"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	enabled := true
	if err == nil {
		var settings struct {
			Enabled bool `json:"enabled"`
		}
		if err := json.Unmarshal(data, &settings); err != nil {
			return err
		}
		enabled = settings.Enabled
	}
	if !enabled {
		if err := os.Remove(filepath.Join(a.dir, "notify-stop.sh")); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		a.hooksEnabled = false
		return nil
	}
	return a.installHook()
}

func (a *App) installHook() error {
	path := filepath.Join(a.dir, "notify-stop.sh")
	script := `#!/bin/sh
[ -n "$CROW_SESSION_ID" ] || exit 0
case "$1" in working) KIND=working ;; ""|turn-complete) KIND=turn-complete ;; *) exit 0 ;; esac
TOKEN=$(cat "$HOME/.local/share/crow-harness/token") || exit 0
curl -fsS --max-time 2 -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$CROW_SESSION_ID\",\"kind\":\"$KIND\"}" \
  "$CROW_EVENT_URL" >/dev/null 2>&1 || true
`
	if err := os.WriteFile(path, []byte(script), 0700); err != nil {
		return err
	}
	a.mu.Lock()
	a.hookPath = path
	a.hooksEnabled = true
	a.mu.Unlock()
	return nil
}

func (a *App) handleHookSettings(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		a.mu.RLock()
		enabled := a.hooksEnabled
		a.mu.RUnlock()
		jsonResponse(w, http.StatusOK, map[string]bool{"enabled": enabled})
		return
	}
	var body struct {
		Enabled bool `json:"enabled"`
	}
	if !requestJSON(w, r, &body) {
		return
	}
	if err := a.setHooksEnabled(body.Enabled); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	jsonResponse(w, http.StatusOK, map[string]bool{"enabled": body.Enabled})
}

func (a *App) setHooksEnabled(enabled bool) error {
	a.mu.RLock()
	current := a.hooksEnabled
	a.mu.RUnlock()
	if enabled == current {
		return nil
	}
	if enabled {
		if err := a.installHook(); err != nil {
			return err
		}
	} else {
		if err := os.Remove(filepath.Join(a.dir, "notify-stop.sh")); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		a.mu.Lock()
		a.hookPath = ""
		a.hooksEnabled = false
		for _, s := range a.sessions {
			s.mu.Lock()
			s.info.HooksActive = false
			if s.info.Agent != "shell" {
				s.info.AgentState = "unknown"
			}
			s.info.CacheExpiresAt = nil
			info := s.info
			s.broadcast(Frame{Type: "state", Info: &info})
			s.mu.Unlock()
		}
		a.mu.Unlock()
		_ = a.saveSessions()
	}
	data, _ := json.Marshal(map[string]bool{"enabled": enabled})
	path := filepath.Join(a.dir, "hooks.json")
	if err := os.WriteFile(path+".tmp", data, 0600); err != nil {
		return err
	}
	return os.Rename(path+".tmp", path)
}

func (a *App) loadEvents() error {
	path := filepath.Join(a.dir, "events.jsonl")
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	scan := bufio.NewScanner(f)
	for scan.Scan() {
		var event Event
		if json.Unmarshal(scan.Bytes(), &event) == nil {
			a.events = append(a.events, event)
		}
	}
	return scan.Err()
}

func (a *App) addEvent(sessionID, kind string) {
	id, err := randomID()
	if err != nil {
		return
	}
	a.mu.Lock()
	seq := uint64(1)
	if len(a.events) > 0 {
		seq = a.events[len(a.events)-1].Seq + 1
	}
	event := Event{ID: id, Seq: seq, SessionID: sessionID, Kind: kind, At: time.Now().UTC()}
	a.events = append(a.events, event)
	encoded, _ := json.Marshal(event)
	f, err := os.OpenFile(filepath.Join(a.dir, "events.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err == nil {
		_, _ = f.Write(append(encoded, '\n'))
		_ = f.Close()
	}
	a.mu.Unlock()
}

func (a *App) handleEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		after, _ := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)
		a.mu.RLock()
		items := make([]Event, 0)
		for _, event := range a.events {
			if event.Seq > after && a.sessions[event.SessionID] != nil {
				items = append(items, event)
			}
		}
		a.mu.RUnlock()
		jsonResponse(w, http.StatusOK, items)
		return
	}
	var body struct {
		SessionID string `json:"sessionId"`
		Kind      string `json:"kind"`
	}
	if !requestJSON(w, r, &body) {
		return
	}
	s := a.session(body.SessionID)
	if s == nil || (body.Kind != "turn-complete" && body.Kind != "working") {
		http.Error(w, "invalid event", http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	deleting := s.deleting
	active := s.info.HooksActive
	s.mu.Unlock()
	if deleting || !active {
		http.Error(w, "session is being deleted", http.StatusConflict)
		return
	}
	if body.Kind == "working" {
		a.markAgentState(body.SessionID, "working")
	} else {
		a.markAgentState(body.SessionID, "completed")
		a.addEvent(body.SessionID, body.Kind)
	}
	jsonResponse(w, http.StatusAccepted, map[string]bool{"ok": true})
}
