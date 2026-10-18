package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"
)

type structuredInput struct{ paste, submit []byte }
type chatSubmitRecord struct {
	OperationID string `json:"operationId"`
	RequestID   string `json:"requestId"`
	SessionID   string `json:"sessionId"`
	Fingerprint string `json:"fingerprint"`
	Status      string `json:"status"`
	// HookConfirmed marks that a durable user hook was observed for this exact
	// submission. UserSeq is that hook's authoritative chat-history sequence,
	// which ties one assistant turn to this requestId even when the same prompt
	// text is submitted again by another surface.
	HookConfirmed bool      `json:"hookConfirmed,omitempty"`
	BaselineSeq   uint64    `json:"baselineSeq"`
	UserSeq       uint64    `json:"userSeq,omitempty"`
	CreatedAt     time.Time `json:"createdAt"`
}

var chatRequestID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// structuredChatInput returns a bracketed-paste payload and a separately
// coordinated submit key. It never normalizes or silently removes user text.
func structuredChatInput(text string) (structuredInput, error) {
	if !utf8.ValidString(text) || len(text) == 0 || len(text) > 4096 {
		return structuredInput{}, errors.New("invalid chat text")
	}
	for _, r := range text {
		if (r < 0x20 && r != '\n' && r != '\t') || r == 0x7f || r == 0x1b || r == 0x9b {
			return structuredInput{}, errors.New("chat text contains control characters")
		}
	}
	if strings.TrimSpace(text) == "" {
		return structuredInput{}, errors.New("chat text is empty")
	}
	return structuredInput{paste: []byte("\x1b[200~" + text + "\x1b[201~"), submit: []byte("\r")}, nil
}

func (a *App) loadChatSubmits() error {
	data, err := os.ReadFile(filepath.Join(a.dir, "chat-submit-operations.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var rows map[string]chatSubmitRecord
	if err := json.Unmarshal(data, &rows); err != nil || rows == nil {
		return errors.New("invalid chat submit operation ledger")
	}
	for key, row := range rows {
		if key != row.RequestID || !chatRequestID.MatchString(key) || row.OperationID == "" || row.SessionID == "" || (row.Status != "pending" && row.Status != "uncertain" && row.Status != "written" && row.Status != "accepted" && row.Status != "rejected") ||
			(row.UserSeq != 0 && row.UserSeq <= row.BaselineSeq) || (row.UserSeq != 0 && !row.HookConfirmed) {
			return errors.New("invalid chat submit operation ledger")
		}
		if row.Status == "pending" {
			row.Status = "uncertain"
			rows[key] = row
		}
	}
	a.chatSubmits = rows
	return a.saveChatSubmitsLocked()
}

func (a *App) saveChatSubmitsLocked() error {
	data, err := json.Marshal(a.chatSubmits)
	if err != nil {
		return err
	}
	path := filepath.Join(a.dir, "chat-submit-operations.json")
	if err := os.WriteFile(path+".tmp", data, 0600); err != nil {
		return err
	}
	f, err := os.OpenFile(path+".tmp", os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(path+".tmp", path); err != nil {
		return err
	}
	if err = os.Chmod(path, 0600); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		return nil
	}
	dir, err := os.Open(a.dir)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

// A deleted session ID is never reused, so its operation tombstones can be
// safely discarded after the durable session-delete marker is removed.
func (a *App) forgetDeletedChatSubmits(sessionID string) error {
	a.chatSubmitMu.Lock()
	defer a.chatSubmitMu.Unlock()
	for requestID, row := range a.chatSubmits {
		if row.SessionID == sessionID {
			delete(a.chatSubmits, requestID)
		}
	}
	return a.saveChatSubmitsLocked()
}

type chatSubmitDTO struct {
	OperationID string `json:"operationId"`
	RequestID   string `json:"requestId"`
	SessionID   string `json:"sessionId"`
	Status      string `json:"status"`
	// BaselineSeq and UserSeq are the authoritative transcript boundaries: the
	// newest message when the submission was reserved, and the exact user-hook
	// sequence bound to this requestId. A client correlates an assistant turn
	// only after UserSeq, never by guessing from the prompt text.
	BaselineSeq uint64 `json:"baselineSeq"`
	UserSeq     uint64 `json:"userSeq"`
}

type mobileChatSubmitContextKey struct{}
type mobileChatSubmitContext struct{ deviceID string }

func (a *App) chatSubmitCallerCurrent(r *http.Request, id string, s *session) bool {
	if mobile, ok := r.Context().Value(mobileChatSubmitContextKey{}).(mobileChatSubmitContext); ok {
		device, owner, current := a.mobileAuthenticate(r)
		if !current || device.ID != mobile.deviceID || s.info.OwnerID != owner.ID {
			return false
		}
		allowed, valid := a.mobileAllowedSession(device, owner, s.info)
		return valid && allowed.CanOperate
	}
	return a.principalCurrent(requestPrincipal(r))
}

func submitDTO(row chatSubmitRecord) chatSubmitDTO {
	return chatSubmitDTO{OperationID: row.OperationID, RequestID: row.RequestID, SessionID: row.SessionID, Status: row.Status, BaselineSeq: row.BaselineSeq, UserSeq: row.UserSeq}
}

// markChatSubmitHook binds one durable user hook sequence to exactly one
// submission. Even when the same prompt text is submitted again, only the oldest
// matching unreconciled request above its own baseline is confirmed, so two
// requestIds can never share a hook sequence or an assistant turn.
func (a *App) markChatSubmitHook(sessionID, text string, sequence uint64) {
	hash := sha256.Sum256([]byte(text))
	fingerprint := hex.EncodeToString(hash[:])
	a.chatSubmitMu.Lock()
	defer a.chatSubmitMu.Unlock()
	if a.chatSubmits == nil {
		a.chatSubmits = make(map[string]chatSubmitRecord)
	}
	chosen := ""
	var chosenAt time.Time
	for id, row := range a.chatSubmits {
		if row.SessionID != sessionID || row.Fingerprint != fingerprint || (row.Status != "pending" && row.Status != "uncertain" && row.Status != "written") || sequence <= row.BaselineSeq || row.HookConfirmed {
			continue
		}
		if chosen == "" || row.CreatedAt.Before(chosenAt) || (row.CreatedAt.Equal(chosenAt) && id < chosen) {
			chosen, chosenAt = id, row.CreatedAt
		}
	}
	if chosen == "" {
		return
	}
	row := a.chatSubmits[chosen]
	row.HookConfirmed = true
	row.Status = "accepted"
	row.UserSeq = sequence
	a.chatSubmits[chosen] = row
	_ = a.saveChatSubmitsLocked()
}

func (a *App) handleChatSubmit(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !a.sessionPermission(r, id, true) {
		http.Error(w, "terminal not found or forbidden", http.StatusNotFound)
		return
	}
	var body struct {
		RequestID string `json:"requestId"`
		Text      string `json:"text"`
	}
	if !requestJSON(w, r, &body) {
		return
	}
	input, err := structuredChatInput(body.Text)
	if err != nil || !chatRequestID.MatchString(body.RequestID) {
		http.Error(w, "invalid structured chat request", http.StatusBadRequest)
		return
	}
	s := a.session(id)
	if s == nil {
		http.Error(w, "terminal not found", http.StatusNotFound)
		return
	}
	fingerprint := sha256.Sum256([]byte(body.Text))
	fingerprintText := hex.EncodeToString(fingerprint[:])
	a.chatSubmitMu.Lock()
	defer a.chatSubmitMu.Unlock()
	if a.chatSubmits == nil {
		a.chatSubmits = make(map[string]chatSubmitRecord)
	}
	if old, ok := a.chatSubmits[body.RequestID]; ok {
		if old.SessionID != id || old.Fingerprint != fingerprintText {
			http.Error(w, "request id conflict", http.StatusConflict)
			return
		}
		jsonResponse(w, http.StatusOK, submitDTO(old))
		return
	}
	for _, old := range a.chatSubmits {
		if old.SessionID == id && (old.Status == "pending" || old.Status == "uncertain" || old.Status == "written") && !old.HookConfirmed {
			http.Error(w, "previous submission outcome must be reconciled", http.StatusConflict)
			return
		}
	}
	if len(a.chatSubmits) >= 4096 {
		http.Error(w, "operation ledger full", http.StatusTooManyRequests)
		return
	}
	// Take the transcript boundary under the same lock used by durable hooks.
	s.mu.Lock()
	baseline, err := a.chatHistory().latestSequence(id)
	if err != nil {
		s.mu.Unlock()
		http.Error(w, "chat history unavailable", http.StatusServiceUnavailable)
		return
	}
	op := chatSubmitRecord{OperationID: body.RequestID, RequestID: body.RequestID, SessionID: id, Fingerprint: fingerprintText, BaselineSeq: baseline, Status: "pending", CreatedAt: time.Now().UTC()}
	a.chatSubmits[body.RequestID] = op
	if err := a.saveChatSubmitsLocked(); err != nil {
		delete(a.chatSubmits, body.RequestID)
		s.mu.Unlock()
		http.Error(w, "operation could not be reserved", http.StatusServiceUnavailable)
		return
	}
	// The session lock serializes both writes against terminal input/deletion.
	if r.Context().Err() != nil || !a.chatSubmitCallerCurrent(r, id, s) || s.deleting || s.pty == nil || s.info.State != "running" || (s.info.Mode != "normal" && s.info.Mode != "bypass") || (s.info.Agent != "claude" && s.info.Agent != "codex") || !s.info.HooksActive || (s.info.AgentState != "waiting" && s.info.AgentState != "completed") || s.userDraft || len(s.activeSubagents) != 0 || !s.bracketedPaste {
		s.mu.Unlock()
		op.Status = "rejected"
		a.chatSubmits[body.RequestID] = op
		_ = a.saveChatSubmitsLocked()
		jsonResponse(w, http.StatusOK, submitDTO(op))
		return
	}
	n, writeErr := s.pty.Write(input.paste)
	if writeErr != nil || n != len(input.paste) {
		s.userDraft = true
		s.mu.Unlock()
		op.Status = "uncertain"
		a.chatSubmits[body.RequestID] = op
		_ = a.saveChatSubmitsLocked()
		jsonResponse(w, http.StatusOK, submitDTO(op))
		return
	}
	// Recheck live authority and cancellation before the single, separate Enter.
	if r.Context().Err() != nil || !a.chatSubmitCallerCurrent(r, id, s) || s.deleting || s.pty == nil || s.info.State != "running" || !s.bracketedPaste {
		s.userDraft = true
		s.mu.Unlock()
		op.Status = "uncertain"
		a.chatSubmits[body.RequestID] = op
		_ = a.saveChatSubmitsLocked()
		jsonResponse(w, http.StatusOK, submitDTO(op))
		return
	}
	n, writeErr = s.pty.Write(input.submit)
	if writeErr != nil || n != len(input.submit) {
		s.userDraft = true
		s.mu.Unlock()
		op.Status = "uncertain"
		a.chatSubmits[body.RequestID] = op
		_ = a.saveChatSubmitsLocked()
		jsonResponse(w, http.StatusOK, submitDTO(op))
		return
	}
	s.userDraft = false
	s.mu.Unlock()
	op.Status = "written"
	a.chatSubmits[body.RequestID] = op
	if err := a.saveChatSubmitsLocked(); err != nil {
		op.Status = "uncertain"
		a.chatSubmits[body.RequestID] = op
		_ = a.saveChatSubmitsLocked()
		jsonResponse(w, http.StatusOK, submitDTO(op))
		return
	}
	jsonResponse(w, http.StatusOK, submitDTO(op))
}

func (a *App) handleChatSubmitStatus(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !a.sessionPermission(r, id, false) {
		http.Error(w, "terminal not found or forbidden", http.StatusNotFound)
		return
	}
	requestID := r.URL.Query().Get("requestId")
	if !chatRequestID.MatchString(requestID) {
		http.Error(w, "invalid request id", http.StatusBadRequest)
		return
	}
	s := a.session(id)
	if s == nil || !a.chatSubmitCallerCurrent(r, id, s) {
		http.NotFound(w, r)
		return
	}
	a.chatSubmitMu.Lock()
	defer a.chatSubmitMu.Unlock()
	op, ok := a.chatSubmits[requestID]
	if !ok || op.SessionID != id {
		jsonResponse(w, http.StatusOK, chatSubmitDTO{RequestID: requestID, SessionID: id, Status: "unknown"})
		return
	}
	jsonResponse(w, http.StatusOK, submitDTO(op))
}

// mobileChatSubmit adapts the remote-host (Linux) direct mobile API to the
// same authenticated durable operation used by the Windows gateway proxy.
func (a *App) mobileChatSubmit(w http.ResponseWriter, r *http.Request) {
	device, owner, ok := a.mobileAuthenticate(r)
	if !ok {
		mobileAPIError(w, 401, "DEVICE_REJECTED", "Vínculo no disponible.")
		return
	}
	hostID := r.URL.Query().Get("hostId")
	var sessionID string
	if r.Method == http.MethodPost {
		var body struct {
			HostID    string `json:"hostId"`
			SessionID string `json:"sessionId"`
			RequestID string `json:"requestId"`
			Text      string `json:"text"`
		}
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&body); err != nil {
			mobileAPIError(w, 400, "INVALID_REQUEST", "Solicitud inválida.")
			return
		}
		if err := decoder.Decode(new(any)); err != io.EOF {
			mobileAPIError(w, 400, "INVALID_REQUEST", "Solicitud inválida.")
			return
		}
		hostID, sessionID = body.HostID, body.SessionID
		encoded, err := json.Marshal(body)
		if err != nil {
			mobileAPIError(w, 400, "INVALID_REQUEST", "Solicitud inválida.")
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(encoded))
	} else {
		sessionID = r.URL.Query().Get("sessionId")
	}
	a.mobile.mu.Lock()
	configuredHost := a.mobile.file.HostID
	a.mobile.mu.Unlock()
	if hostID != configuredHost || !validChatSessionID(sessionID) {
		mobileAPIError(w, 403, "GRANT_REQUIRED", "Terminal no autorizada.")
		return
	}
	s := a.session(sessionID)
	if s == nil {
		mobileAPIError(w, 404, "NOT_FOUND", "Terminal no encontrada.")
		return
	}
	info := s.snapshot()
	allowed, valid := a.mobileAllowedSession(device, owner, info)
	if !valid || !allowed.CanOperate || info.OwnerID != owner.ID {
		mobileAPIError(w, 404, "NOT_FOUND", "Terminal no encontrada.")
		return
	}
	ctx := context.WithValue(r.Context(), accessContextKey{}, owner)
	ctx = context.WithValue(ctx, mobileChatSubmitContextKey{}, mobileChatSubmitContext{deviceID: device.ID})
	r = r.WithContext(ctx)
	r.SetPathValue("id", sessionID)
	if r.Method == http.MethodPost {
		a.handleChatSubmit(w, r)
	} else {
		a.handleChatSubmitStatus(w, r)
	}
}
