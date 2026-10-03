package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
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
	binaryPath := a.binaryPath
	if binaryPath == "" {
		var err error
		binaryPath, err = os.Executable()
		if err != nil {
			return fmt.Errorf("locate crowd hook executable: %w", err)
		}
	}
	script := "#!/bin/sh\n[ -n \"$CROW_SESSION_ID\" ] || exit 0\nexec " + shellQuote(binaryPath) + " hook-notify \"$@\"\n"
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
				s.rootAgentState = "unknown"
			}
			clear(s.activeSubagents)
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

func (a *App) addEvent(sessionID, kind string, attention bool) {
	id, err := randomID()
	if err != nil {
		return
	}
	a.mu.Lock()
	seq := uint64(1)
	if len(a.events) > 0 {
		seq = a.events[len(a.events)-1].Seq + 1
	}
	event := Event{ID: id, Seq: seq, SessionID: sessionID, Kind: kind, RequiresAttention: attention, At: time.Now().UTC()}
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
		Message   string `json:"message"`
		AgentID   string `json:"agentId"`
	}
	if !requestJSON(w, r, &body) {
		return
	}
	s := a.session(body.SessionID)
	if s == nil || (body.Kind != "turn-complete" && body.Kind != "working" && body.Kind != "subagent-start" && body.Kind != "subagent-stop") {
		http.Error(w, "invalid event", http.StatusBadRequest)
		return
	}
	if (body.Kind == "subagent-start" || body.Kind == "subagent-stop") && strings.TrimSpace(body.AgentID) == "" {
		http.Error(w, "missing subagent id", http.StatusBadRequest)
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
	} else if body.Kind == "subagent-start" {
		a.markSubagentState(body.SessionID, body.AgentID, true)
	} else if body.Kind == "subagent-stop" {
		a.markSubagentState(body.SessionID, body.AgentID, false)
	} else {
		a.markAgentState(body.SessionID, "completed")
		a.addEvent(body.SessionID, body.Kind, requiresAttention(body.Message))
	}
	jsonResponse(w, http.StatusAccepted, map[string]bool{"ok": true})
}

const maxHookPayload = 128 * 1024

// RunHookNotify is invoked by managed agent hooks. Claude writes the hook JSON
// to stdin; Codex notify passes its JSON payload as a command argument.
func RunHookNotify(args []string) error {
	if len(args) == 0 || (args[0] != "working" && args[0] != "turn-complete" && args[0] != "subagent-start" && args[0] != "subagent-stop") {
		return errors.New("usage: crowd hook-notify <working|turn-complete|subagent-start|subagent-stop> [agent-payload]")
	}
	kind := args[0]
	if os.Getenv("CROW_SESSION_ID") == "" {
		return nil
	}

	var message, agentID string
	if kind == "turn-complete" || kind == "subagent-start" || kind == "subagent-stop" {
		var payload []byte
		if kind == "turn-complete" {
			for _, arg := range args[1:] {
				if json.Valid([]byte(arg)) {
					payload = []byte(arg)
					break
				}
			}
		}
		if len(payload) == 0 {
			read, err := io.ReadAll(io.LimitReader(os.Stdin, maxHookPayload))
			if err != nil {
				return err
			}
			payload = read
		}
		if kind == "turn-complete" {
			message = hookAssistantMessage(payload)
			if runes := []rune(message); len(runes) > 12000 {
				message = string(runes[:12000])
			}
		} else {
			agentID = hookAgentID(payload)
		}
	}

	baseURL := strings.TrimRight(os.Getenv("CROW_EVENT_URL"), "/")
	parsedURL, err := url.ParseRequestURI(baseURL)
	if err != nil || parsedURL.Scheme != "http" || parsedURL.Hostname() != "127.0.0.1" || parsedURL.Port() == "" || parsedURL.User != nil || parsedURL.Path != "/api/events" || parsedURL.RawQuery != "" || parsedURL.Fragment != "" {
		return errors.New("invalid local event URL")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	token, err := os.ReadFile(filepath.Join(home, ".local", "share", "crow-harness", "token"))
	if err != nil {
		return err
	}
	body, err := json.Marshal(map[string]string{"sessionId": os.Getenv("CROW_SESSION_ID"), "kind": kind, "message": message, "agentId": agentID})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{
		Transport: &http.Transport{},
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	if response.StatusCode != http.StatusAccepted {
		return fmt.Errorf("local event endpoint returned %s", response.Status)
	}
	return nil
}

func hookAgentID(payload []byte) string {
	var fields map[string]json.RawMessage
	if json.Unmarshal(payload, &fields) != nil {
		return ""
	}
	var agentID string
	if json.Unmarshal(fields["agent_id"], &agentID) != nil {
		return ""
	}
	return agentID
}

func hookAssistantMessage(payload []byte) string {
	var fields map[string]json.RawMessage
	if json.Unmarshal(payload, &fields) != nil {
		return ""
	}
	for _, key := range []string{"last_assistant_message", "last-assistant-message", "lastAssistantMessage"} {
		var message string
		if json.Unmarshal(fields[key], &message) == nil {
			return message
		}
	}
	return ""
}
