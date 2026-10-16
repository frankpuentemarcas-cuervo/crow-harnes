package server

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	maxChatMessageBytes = 64 * 1024
	// JSON can expand each content byte to six bytes (for example, a control
	// character encoded as `\u0001`). Add room for the bounded source ID and
	// record metadata so valid maximum-sized messages remain reloadable.
	maxChatRecordBytes = 6*(maxChatMessageBytes+200) + 4096
	maxChatStoreBytes  = 16 * 1024 * 1024
	maxChatMessages    = 20000
	maxChatPageSize    = 100
)

var (
	errChatSourceConflict = errors.New("chat source id reused with different content")
	errChatStoreLimit     = errors.New("chat history reached its storage limit")
)

type ChatMessage struct {
	ID        string    `json:"id"`
	SessionID string    `json:"sessionId"`
	Seq       uint64    `json:"seq"`
	Role      string    `json:"role"`
	Content   string    `json:"content"`
	Truncated bool      `json:"truncated,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

type chatRecord struct {
	ChatMessage
	SourceID string `json:"sourceId"`
}

type chatSessionIndex struct {
	messages []ChatMessage
	sources  map[string]chatRecord
	bytes    int64
}

type chatStore struct {
	mu            sync.Mutex
	dir           string
	sessions      map[string]*chatSessionIndex
	limitNotified map[string]bool
}

func (a *App) chatHistory() *chatStore {
	a.chatMu.Lock()
	defer a.chatMu.Unlock()
	if a.chat == nil {
		a.chat = newChatStore(a.dir)
	}
	return a.chat
}

func newChatStore(dataDir string) *chatStore {
	return &chatStore{dir: filepath.Join(dataDir, "chat"), sessions: make(map[string]*chatSessionIndex), limitNotified: make(map[string]bool)}
}

func (s *chatStore) markLimitNotified(sessionID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.limitNotified == nil {
		s.limitNotified = make(map[string]bool)
	}
	if s.limitNotified[sessionID] {
		return false
	}
	s.limitNotified[sessionID] = true
	return true
}

func validChatSessionID(id string) bool {
	if len(id) != 32 || id != strings.ToLower(id) {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil
}

func (s *chatStore) sessionLocked(id string) (*chatSessionIndex, error) {
	if !validChatSessionID(id) {
		return nil, errors.New("invalid chat session id")
	}
	if index := s.sessions[id]; index != nil {
		return index, nil
	}
	if err := s.ensureDir(); err != nil {
		return nil, err
	}
	index := &chatSessionIndex{sources: make(map[string]chatRecord)}
	path := s.path(id)
	linkInfo, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		s.sessions[id] = index
		return index, nil
	}
	if err != nil {
		return nil, err
	}
	if !linkInfo.Mode().IsRegular() {
		return nil, errors.New("chat history is not a regular file")
	}
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		s.sessions[id] = index
		return index, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		return nil, err
	}
	currentPath, err := os.Lstat(path)
	if err != nil || !os.SameFile(linkInfo, stat) || !os.SameFile(stat, currentPath) {
		return nil, errors.New("chat history changed while opening")
	}
	if !stat.Mode().IsRegular() || stat.Size() > maxChatStoreBytes {
		return nil, errChatStoreLimit
	}
	if err := file.Chmod(0600); err != nil {
		return nil, err
	}
	scan := bufio.NewScanner(file)
	scan.Buffer(make([]byte, 4096), maxChatRecordBytes)
	for scan.Scan() {
		var record chatRecord
		if err := json.Unmarshal(scan.Bytes(), &record); err != nil {
			return nil, fmt.Errorf("invalid chat history record: %w", err)
		}
		if record.SessionID != id || !validChatMessage(record.Role, record.Content) || record.ID == "" || record.SourceID == "" || record.Seq != uint64(len(index.messages)+1) || record.CreatedAt.IsZero() {
			return nil, errors.New("invalid chat history sequence or fields")
		}
		if _, exists := index.sources[record.SourceID]; exists {
			return nil, errors.New("duplicate chat history source id")
		}
		index.sources[record.SourceID] = record
		index.messages = append(index.messages, record.ChatMessage)
		index.bytes += int64(len(scan.Bytes()) + 1)
	}
	if err := scan.Err(); err != nil {
		return nil, err
	}
	if index.bytes != stat.Size() || len(index.messages) > maxChatMessages {
		return nil, errors.New("chat history file is incomplete or over its message limit")
	}
	s.sessions[id] = index
	return index, nil
}

func (s *chatStore) ensureDir() error {
	if err := os.MkdirAll(s.dir, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(s.dir)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("chat history directory is not a directory")
	}
	return os.Chmod(s.dir, 0700)
}

func validChatMessage(role, content string) bool {
	return (role == "user" || role == "assistant") && content != "" && utf8.ValidString(content) && len(content) <= maxChatMessageBytes
}

func (s *chatStore) path(id string) string {
	return filepath.Join(s.dir, id+".jsonl")
}

func (s *chatStore) append(sessionID, role, content, sourceID string) (ChatMessage, error) {
	return s.appendWithTruncation(sessionID, role, content, sourceID, false)
}

func (s *chatStore) appendWithTruncation(sessionID, role, content, sourceID string, truncated bool) (ChatMessage, error) {
	if !validChatMessage(role, content) {
		return ChatMessage{}, errors.New("invalid chat message")
	}
	if sourceID == "" || len(sourceID) > 200 || strings.ContainsAny(sourceID, "\x00\r\n") {
		return ChatMessage{}, errors.New("invalid chat source id")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	index, err := s.sessionLocked(sessionID)
	if err != nil {
		return ChatMessage{}, err
	}
	if previous, exists := index.sources[sourceID]; exists {
		if previous.Role != role || previous.Content != content || previous.Truncated != truncated {
			return ChatMessage{}, errChatSourceConflict
		}
		return previous.ChatMessage, nil
	}
	if index.bytes >= maxChatStoreBytes || len(index.messages) >= maxChatMessages {
		return ChatMessage{}, errChatStoreLimit
	}
	id, err := randomID()
	if err != nil {
		return ChatMessage{}, err
	}
	message := ChatMessage{ID: id, SessionID: sessionID, Seq: uint64(len(index.messages) + 1), Role: role, Content: content, Truncated: truncated, CreatedAt: time.Now().UTC()}
	record := chatRecord{ChatMessage: message, SourceID: sourceID}
	encoded, err := json.Marshal(record)
	if err != nil {
		return ChatMessage{}, err
	}
	encoded = append(encoded, '\n')
	if index.bytes+int64(len(encoded)) > maxChatStoreBytes {
		return ChatMessage{}, errChatStoreLimit
	}
	file, err := os.OpenFile(s.path(sessionID), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return ChatMessage{}, err
	}
	opened, statErr := file.Stat()
	currentPath, pathErr := os.Lstat(s.path(sessionID))
	if statErr != nil || pathErr != nil || !os.SameFile(opened, currentPath) {
		_ = file.Close()
		return ChatMessage{}, errors.New("chat history changed while opening")
	}
	if err := file.Chmod(0600); err != nil {
		_ = file.Close()
		return ChatMessage{}, err
	}
	previousSize := index.bytes
	written, writeErr := file.Write(encoded)
	if writeErr != nil || written != len(encoded) {
		if writeErr == nil {
			writeErr = io.ErrShortWrite
		}
		_ = file.Truncate(previousSize)
		delete(s.sessions, sessionID)
		_ = file.Close()
		return ChatMessage{}, writeErr
	}
	if err := file.Sync(); err != nil {
		delete(s.sessions, sessionID)
		_ = file.Close()
		return ChatMessage{}, err
	}
	if err := file.Close(); err != nil {
		delete(s.sessions, sessionID)
		return ChatMessage{}, err
	}
	index.sources[sourceID] = record
	index.messages = append(index.messages, message)
	index.bytes += int64(len(encoded))
	return message, nil
}

func (s *chatStore) remove(sessionID string) error {
	if !validChatSessionID(sessionID) {
		return errors.New("invalid chat session id")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	info, err := os.Lstat(s.dir)
	if errors.Is(err, os.ErrNotExist) {
		delete(s.sessions, sessionID)
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("chat history directory is not a directory")
	}
	if err := os.Remove(s.path(sessionID)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	delete(s.sessions, sessionID)
	delete(s.limitNotified, sessionID)
	return nil
}

func (s *chatStore) page(sessionID string, after, before uint64, limit int) ([]ChatMessage, bool, error) {
	if limit < 1 || limit > maxChatPageSize || (after > 0 && before > 0) {
		return nil, false, errors.New("invalid chat page")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	index, err := s.sessionLocked(sessionID)
	if err != nil {
		return nil, false, err
	}
	if after > 0 {
		page := make([]ChatMessage, 0, limit+1)
		for _, message := range index.messages {
			if message.Seq <= after {
				continue
			}
			page = append(page, message)
			if len(page) > limit {
				return page[:limit], true, nil
			}
		}
		return page, false, nil
	}
	page := make([]ChatMessage, 0, limit+1)
	for i := len(index.messages) - 1; i >= 0; i-- {
		message := index.messages[i]
		if before > 0 && message.Seq >= before {
			continue
		}
		page = append(page, message)
		if len(page) > limit {
			page = page[:limit]
			hasMore := page[len(page)-1].Seq > 1
			for left, right := 0, len(page)-1; left < right; left, right = left+1, right-1 {
				page[left], page[right] = page[right], page[left]
			}
			return page, hasMore, nil
		}
	}
	for left, right := 0, len(page)-1; left < right; left, right = left+1, right-1 {
		page[left], page[right] = page[right], page[left]
	}
	return page, false, nil
}

func chatSourceID(sessionID, kind, providerID string) string {
	digest := sha256.Sum256([]byte(sessionID + "\x00" + kind + "\x00" + providerID))
	return hex.EncodeToString(digest[:])
}

func (a *App) handleChatHistory(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	sessionID := r.PathValue("id")
	if !a.sessionPermission(r, sessionID, false) {
		http.Error(w, "terminal not found or forbidden", http.StatusNotFound)
		return
	}
	s := a.session(sessionID)
	if s == nil {
		http.Error(w, "terminal not found or forbidden", http.StatusNotFound)
		return
	}
	info := s.snapshot()
	if !supportsChatHistory(info) {
		jsonResponse(w, http.StatusNotImplemented, map[string]string{"code": "STRUCTURED_CHAT_UNAVAILABLE", "error": "Esta sesión todavía no ofrece historial estructurado."})
		return
	}
	a.chatPage(w, r, sessionID)
}

func supportsChatHistory(info SessionInfo) bool {
	// Reading a saved transcript remains useful after the PTY stops; writability
	// is enforced separately by the terminal input endpoint.
	return (info.Agent == "claude" || info.Agent == "codex") && info.HooksActive
}

func (a *App) chatPage(w http.ResponseWriter, r *http.Request, sessionID string) {
	query := r.URL.Query()
	parseCursor := func(name string) (uint64, bool) {
		value := query.Get(name)
		if value == "" {
			return 0, true
		}
		cursor, err := strconv.ParseUint(value, 10, 64)
		return cursor, err == nil
	}
	after, afterOK := parseCursor("after")
	before, beforeOK := parseCursor("before")
	if !afterOK || !beforeOK {
		jsonResponse(w, http.StatusBadRequest, map[string]string{"code": "INVALID_REQUEST", "error": "Cursor de conversación inválido."})
		return
	}
	if after > 0 && before > 0 {
		jsonResponse(w, http.StatusBadRequest, map[string]string{"code": "INVALID_REQUEST", "error": "Usá un solo cursor por consulta."})
		return
	}
	limit := 50
	if value := query.Get("limit"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 || parsed > maxChatPageSize {
			jsonResponse(w, http.StatusBadRequest, map[string]string{"code": "INVALID_REQUEST", "error": "Tamaño de página inválido."})
			return
		}
		limit = parsed
	}
	messages, hasMore, err := a.chatHistory().page(sessionID, after, before, limit)
	if err != nil {
		jsonResponse(w, http.StatusServiceUnavailable, map[string]string{"code": "CHAT_HISTORY_UNAVAILABLE", "error": "No se pudo leer el historial de esta terminal."})
		return
	}
	nextBefore := uint64(0)
	if len(messages) > 0 {
		nextBefore = messages[0].Seq
	}
	w.Header().Set("Cache-Control", "no-store")
	jsonResponse(w, http.StatusOK, map[string]any{"messages": messages, "hasMore": hasMore, "nextBefore": nextBefore})
}
