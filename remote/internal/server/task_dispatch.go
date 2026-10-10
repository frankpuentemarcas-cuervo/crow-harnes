package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type taskDispatchRecord struct {
	JobID      string    `json:"jobId"`
	OwnerID    string    `json:"ownerId"`
	Root       string    `json:"root"`
	Agent      string    `json:"agent"`
	PromptHash string    `json:"promptHash"`
	SessionID  string    `json:"sessionId,omitempty"`
	State      string    `json:"state"`
	At         time.Time `json:"at"`
}

func (a *App) saveDispatch(records map[string]taskDispatchRecord) error {
	data, err := json.Marshal(records)
	if err != nil {
		return err
	}
	path := filepath.Join(a.dir, "task-dispatch.json")
	return writeDurableRegistry(path, data)
}
func (a *App) handleTaskDispatch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		JobID         string `json:"jobId"`
		Root          string `json:"root"`
		Agent         string `json:"agent"`
		InitialPrompt string `json:"initialPrompt"`
	}
	if !requestJSON(w, r, &body) {
		return
	}
	// UUID or hexadecimal identifiers only, bounded text and normal interactive agents.
	if len(body.JobID) < 8 || len(body.JobID) > 80 || strings.ContainsAny(body.JobID, "/\\ .\r\n\x00") || (body.Agent != "claude" && body.Agent != "codex") || strings.TrimSpace(body.InitialPrompt) == "" || len(body.InitialPrompt) > 64*1024 || strings.ContainsRune(body.InitialPrompt, 0) {
		http.Error(w, "invalid dispatch", 400)
		return
	}
	root, err := canonical(body.Root)
	if err != nil {
		http.Error(w, "invalid project", 400)
		return
	}
	p := requestPrincipal(r)
	owner := ""
	if p != nil {
		owner = p.ID
	}
	a.dispatchMu.Lock()
	defer a.dispatchMu.Unlock()
	records := map[string]taskDispatchRecord{}
	path := filepath.Join(a.dir, "task-dispatch.json")
	if data, err := os.ReadFile(path); err == nil {
		if json.Unmarshal(data, &records) != nil || records == nil {
			http.Error(w, "dispatch registry requires review", 503)
			return
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		http.Error(w, "dispatch registry unavailable", 503)
		return
	}
	hash := tokenHash(body.InitialPrompt)
	if previous, ok := records[body.JobID]; ok {
		if previous.OwnerID != owner || previous.Root != root || previous.Agent != body.Agent || previous.PromptHash != hash {
			http.Error(w, "dispatch destination conflict", 409)
			return
		}
		if previous.State != "started" || previous.SessionID == "" {
			http.Error(w, "dispatch uncertain; review before creating another job", 409)
			return
		}
		if !a.sessionPermission(r, previous.SessionID, false) {
			http.Error(w, "terminal unavailable", 409)
			return
		}
		jsonResponse(w, 200, previous)
		return
	}
	record := taskDispatchRecord{JobID: body.JobID, OwnerID: owner, Root: root, Agent: body.Agent, PromptHash: hash, State: "uncertain", At: time.Now().UTC()}
	records[body.JobID] = record
	if err = a.saveDispatch(records); err != nil {
		http.Error(w, "dispatch reservation failed", 503)
		return
	}
	// End-of-options keeps the exact approved prompt out of CLI option parsing.
	prompt := body.InitialPrompt
	if r.Context().Err() != nil || !a.principalCurrent(p) {
		http.Error(w, "access revoked", 403)
		return
	}
	info, err := a.startSessionPrompt(body.Agent, "normal", root, p, prompt)
	if err != nil {
		http.Error(w, "dispatch failed or uncertain; inspect before retry", 503)
		return
	}
	record.State = "started"
	record.SessionID = info.ID
	records[body.JobID] = record
	if err = a.saveDispatch(records); err != nil {
		http.Error(w, "terminal may have started; delivery uncertain", 503)
		return
	}
	jsonResponse(w, 201, record)
}

func writeDurableRegistry(path string, data []byte) error {
	file, err := os.OpenFile(path+".tmp", os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(path+".tmp", path); err != nil {
		return err
	}
	return syncRegistryDirectory(filepath.Dir(path))
}
