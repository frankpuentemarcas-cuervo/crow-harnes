package server

import (
	"bufio"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

func (a *App) installHook() error {
	path := filepath.Join(a.dir, "notify-stop.sh")
	script := `#!/bin/sh
[ -n "$CROW_SESSION_ID" ] || exit 0
TOKEN=$(cat "$HOME/.local/share/crow-harness/token") || exit 0
curl -fsS --max-time 2 -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"sessionId\":\"$CROW_SESSION_ID\",\"kind\":\"turn-complete\"}" \
  "$CROW_EVENT_URL" >/dev/null 2>&1 || true
`
	if err := os.WriteFile(path, []byte(script), 0700); err != nil {
		return err
	}
	a.hookPath = path
	return nil
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
	if s == nil || body.Kind != "turn-complete" {
		http.Error(w, "invalid event", http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	deleting := s.deleting
	s.mu.Unlock()
	if deleting {
		http.Error(w, "session is being deleted", http.StatusConflict)
		return
	}
	a.addEvent(body.SessionID, body.Kind)
	jsonResponse(w, http.StatusAccepted, map[string]bool{"ok": true})
}
