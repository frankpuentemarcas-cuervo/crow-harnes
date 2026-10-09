package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
)

// These endpoints are reachable only through the existing authenticated runtime
// (normally forwarded over Crow's SSH connection). No arbitrary terminal input.
func (a *App) handleBridgeHello(w http.ResponseWriter, r *http.Request) {
	if a.bridge == nil {
		http.Error(w, "bridge unavailable", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		TaskID    string `json:"taskId"`
		SessionID string `json:"sessionId"`
		Root      string `json:"root"`
		Message   string `json:"message"`
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	d.DisallowUnknownFields()
	if err := d.Decode(&body); err != nil || body.Message != "Hola" || !safeID(body.TaskID) || !safeID(body.SessionID) {
		http.Error(w, "invalid hello probe", http.StatusBadRequest)
		return
	}
	if err := d.Decode(new(any)); err != io.EOF {
		http.Error(w, "invalid hello probe", http.StatusBadRequest)
		return
	}
	// Replay precedes runtime state checks: a completed/interrupted terminal must
	// not cause an accepted idempotent request to be dispatched again.
	if task, ok := a.bridge.Get(body.TaskID); ok {
		if task.SessionID != body.SessionID || task.Root != body.Root {
			http.Error(w, "destination conflict", http.StatusConflict)
			return
		}
		jsonResponse(w, http.StatusOK, task)
		return
	}
	s := a.session(body.SessionID)
	if s == nil {
		http.Error(w, "terminal not found", http.StatusNotFound)
		return
	}
	s.mu.Lock()
	err := helloReadyLocked(s, body.Root)
	s.mu.Unlock()
	if err != nil {
		// The same request may have been accepted by a concurrent caller between
		// our first lookup and readiness check; replay, don't reject or resend it.
		if old, ok := a.bridge.Get(body.TaskID); ok {
			if old.SessionID != body.SessionID || old.Root != body.Root {
				http.Error(w, "destination conflict", http.StatusConflict)
				return
			}
			jsonResponse(w, http.StatusOK, old)
			return
		}
		http.Error(w, "hello requires an idle normal terminal with hooks in the approved folder", http.StatusConflict)
		return
	}
	task, err := a.bridge.Send(body.TaskID, body.SessionID, body.Root, func(prompt string) error {
		s.mu.Lock()
		defer s.mu.Unlock()
		if err := helloReadyLocked(s, body.Root); err != nil {
			return err
		}
		// Holding the session lock closes the check/write race with deletion and
		// manual input. Input is fixed by the mailbox, never provided by MCP.
		if _, err := s.pty.Write([]byte(prompt)); err != nil {
			return err
		}
		s.lastActivity = time.Now().UTC()
		s.rootAgentState = "working"
		s.updateAgentStateLocked()
		s.info.CacheExpiresAt = nil
		info := s.info
		s.broadcast(Frame{Type: "state", Info: &info})
		return nil
	})
	if err != nil {
		http.Error(w, "bridge mailbox unavailable or terminal reserved", http.StatusConflict)
		return
	}
	jsonResponse(w, http.StatusAccepted, task)
}

func helloReadyLocked(s *session, root string) error {
	if s.deleting || s.userDraft || s.pty == nil || s.info.Root != root || s.info.State != "running" || s.info.Mode != "normal" || !s.info.HooksActive || (s.info.Agent != "claude" && s.info.Agent != "codex") || (s.info.AgentState != "waiting" && s.info.AgentState != "completed") || len(s.activeSubagents) != 0 {
		return errors.New("terminal unavailable")
	}
	return nil
}

func (a *App) handleBridgeTask(w http.ResponseWriter, r *http.Request) {
	if a.bridge == nil {
		http.Error(w, "bridge unavailable", http.StatusServiceUnavailable)
		return
	}
	task, ok := a.bridge.Get(r.PathValue("id"))
	if !ok {
		http.Error(w, "task not found", http.StatusNotFound)
		return
	}
	jsonResponse(w, http.StatusOK, task)
}
