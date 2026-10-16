package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestDeleteExitedSessionRemovesMetadataAndLog(t *testing.T) {
	dir := t.TempDir()
	id := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	logPath := filepath.Join(dir, "terminal-"+id+".jsonl")
	if err := os.WriteFile(logPath, []byte("test\n"), 0600); err != nil {
		t.Fatal(err)
	}
	chatStore := newChatStore(dir)
	if _, err := chatStore.append(id, "assistant", "saved chat", "chat-event"); err != nil {
		t.Fatal(err)
	}
	a := &App{dir: dir, sessions: map[string]*session{id: {info: SessionInfo{ID: id, State: "exited"}, subs: make(map[chan Frame]struct{})}}}
	if err := a.deleteSession(id); err != nil {
		t.Fatal(err)
	}
	if a.session(id) != nil {
		t.Fatal("session remained in memory")
	}
	if _, err := os.Stat(logPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("terminal log remains: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "chat", id+".jsonl")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("chat transcript remains: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "sessions.json"))
	if err != nil || string(data) != "[]" {
		t.Fatalf("metadata not emptied: %q, %v", data, err)
	}
}

func TestDeleteMissingSession(t *testing.T) {
	a := &App{dir: t.TempDir(), sessions: map[string]*session{}}
	if err := a.deleteSession("missing"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("want not-exist, got %v", err)
	}
}

func TestDeleteSessionPreservesHistoryWhenMetadataPersistenceFails(t *testing.T) {
	dir := t.TempDir()
	id := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	logPath := filepath.Join(dir, "terminal-"+id+".jsonl")
	if err := os.WriteFile(logPath, []byte("terminal history\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := newChatStore(dir).append(id, "assistant", "saved chat", "chat-event"); err != nil {
		t.Fatal(err)
	}
	// saveSessions can write the temporary file but cannot atomically replace
	// a directory at sessions.json, giving a deterministic persistence failure.
	if err := os.Mkdir(filepath.Join(dir, "sessions.json"), 0700); err != nil {
		t.Fatal(err)
	}
	s := &session{info: SessionInfo{ID: id, State: "exited"}, subs: make(map[chan Frame]struct{})}
	a := &App{dir: dir, sessions: map[string]*session{id: s}}
	if err := a.deleteSession(id); err == nil {
		t.Fatal("delete succeeded despite sessions metadata persistence failure")
	}
	if a.session(id) != s {
		t.Fatal("session was not restored in memory")
	}
	if _, found, err := a.readSessionDeleteMarker(id); err != nil || found {
		t.Fatalf("marker must be removed after persistence rollback: found=%v err=%v", found, err)
	}
	s.mu.Lock()
	deleting := s.deleting
	s.mu.Unlock()
	if deleting {
		t.Fatal("restored session remains marked as deleting")
	}
	if data, err := os.ReadFile(logPath); err != nil || string(data) != "terminal history\n" {
		t.Fatalf("terminal log was lost: %q, %v", data, err)
	}
	page, _, err := newChatStore(dir).page(id, 0, 0, 10)
	if err != nil || len(page) != 1 || page[0].Content != "saved chat" {
		t.Fatalf("chat transcript was lost: %#v, %v", page, err)
	}
}

func TestDeleteSessionCleanupFailureCanBeRetriedOverAPI(t *testing.T) {
	a, _, root := accessFixture(t)
	id := "cccccccccccccccccccccccccccccccc"
	chatPath := filepath.Join(a.dir, "chat", id+".jsonl")
	if err := os.MkdirAll(chatPath, 0700); err != nil {
		t.Fatal(err)
	}
	blocker := filepath.Join(chatPath, "keep-cleanup-pending")
	if err := os.WriteFile(blocker, []byte("blocks removal"), 0600); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(a.dir, "terminal-"+id+".jsonl")
	if err := os.WriteFile(logPath, []byte("terminal output\n"), 0600); err != nil {
		t.Fatal(err)
	}
	a.sessions[id] = &session{info: SessionInfo{ID: id, OwnerID: "alice", Root: root, State: "exited"}, subs: make(map[chan Frame]struct{})}
	mux := http.NewServeMux()
	mux.HandleFunc("DELETE /api/sessions/{id}", a.handleDeleteSession)
	handler := a.auth(mux)
	deleteRequest := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodDelete, "/api/sessions/"+id, nil)
		r.Header.Set("Authorization", "Bearer alice-token")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	if first := deleteRequest(); first.Code != http.StatusInternalServerError {
		t.Fatalf("first delete status = %d, want 500 (cleanup pending): %s", first.Code, first.Body.String())
	}
	if a.session(id) != nil {
		t.Fatal("durably deleted session remains in memory after cleanup error")
	}
	if _, found, err := a.readSessionDeleteMarker(id); err != nil || !found {
		t.Fatalf("cleanup marker not retained: found=%v err=%v", found, err)
	}
	bobRequest := httptest.NewRequest(http.MethodDelete, "/api/sessions/"+id, nil)
	bobRequest.Header.Set("Authorization", "Bearer bob-token")
	bobResponse := httptest.NewRecorder()
	handler.ServeHTTP(bobResponse, bobRequest)
	if bobResponse.Code != http.StatusNotFound {
		t.Fatalf("foreign user accessed pending delete: status=%d body=%s", bobResponse.Code, bobResponse.Body.String())
	}
	if retry := deleteRequest(); retry.Code != http.StatusInternalServerError {
		t.Fatalf("retry while cleanup is blocked returned %d, want 500 rather than 404: %s", retry.Code, retry.Body.String())
	}
	if err := os.Remove(blocker); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(chatPath); err != nil {
		t.Fatal(err)
	}
	if retry := deleteRequest(); retry.Code != http.StatusOK {
		t.Fatalf("retry after fixing cleanup returned %d: %s", retry.Code, retry.Body.String())
	}
	if _, found, err := a.readSessionDeleteMarker(id); err != nil || found {
		t.Fatalf("marker remains after cleanup retry: found=%v err=%v", found, err)
	}
	if _, err := os.Stat(logPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("terminal log remains after retry: %v", err)
	}
}

func TestLoadSessionsReconcilesPendingDeleteMarkers(t *testing.T) {
	t.Run("cancel marker when metadata still includes session", func(t *testing.T) {
		dir := t.TempDir()
		id := "dddddddddddddddddddddddddddddddd"
		info := SessionInfo{ID: id, OwnerID: "alice", Root: t.TempDir(), Agent: "shell", State: "exited"}
		data, err := json.Marshal([]SessionInfo{info})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "sessions.json"), data, 0600); err != nil {
			t.Fatal(err)
		}
		logPath := filepath.Join(dir, "terminal-"+id+".jsonl")
		if err := os.WriteFile(logPath, []byte("must be kept\n"), 0600); err != nil {
			t.Fatal(err)
		}
		a := &App{dir: dir, sessions: make(map[string]*session)}
		if err := a.writeSessionDeleteMarker(id, info.OwnerID); err != nil {
			t.Fatal(err)
		}
		if err := a.loadSessions(); err != nil {
			t.Fatal(err)
		}
		if a.session(id) == nil {
			t.Fatal("session disappeared despite metadata still containing it")
		}
		if _, found, err := a.readSessionDeleteMarker(id); err != nil || found {
			t.Fatalf("uncommitted marker remains: found=%v err=%v", found, err)
		}
		if _, err := os.Stat(logPath); err != nil {
			t.Fatalf("session history was removed: %v", err)
		}
	})

	t.Run("finish committed delete after restart", func(t *testing.T) {
		dir := t.TempDir()
		id := "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
		if err := os.WriteFile(filepath.Join(dir, "sessions.json"), []byte("[]"), 0600); err != nil {
			t.Fatal(err)
		}
		logPath := filepath.Join(dir, "terminal-"+id+".jsonl")
		if err := os.WriteFile(logPath, []byte("orphaned output\n"), 0600); err != nil {
			t.Fatal(err)
		}
		chatStore := newChatStore(dir)
		if _, err := chatStore.append(id, "assistant", "orphaned transcript", "source"); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(dir, "shell-agent-"+id), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "hook-"+id), []byte("hook-token"), 0600); err != nil {
			t.Fatal(err)
		}
		a := &App{dir: dir, sessions: make(map[string]*session)}
		if err := a.writeSessionDeleteMarker(id, "alice"); err != nil {
			t.Fatal(err)
		}
		if err := a.loadSessions(); err != nil {
			t.Fatal(err)
		}
		for _, path := range []string{logPath, filepath.Join(dir, "chat", id+".jsonl"), filepath.Join(dir, "shell-agent-"+id), filepath.Join(dir, "hook-"+id)} {
			if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
				t.Errorf("pending session data remains at %s: %v", path, err)
			}
		}
		if _, found, err := a.readSessionDeleteMarker(id); err != nil || found {
			t.Fatalf("committed delete marker remains after startup cleanup: found=%v err=%v", found, err)
		}
	})
}

func TestLoadSessionsLeavesFailedCleanupMarkerForLaterRetry(t *testing.T) {
	dir := t.TempDir()
	id := "ffffffffffffffffffffffffffffffff"
	if err := os.WriteFile(filepath.Join(dir, "sessions.json"), []byte("[]"), 0600); err != nil {
		t.Fatal(err)
	}
	chatPath := filepath.Join(dir, "chat", id+".jsonl")
	if err := os.MkdirAll(chatPath, 0700); err != nil {
		t.Fatal(err)
	}
	blocker := filepath.Join(chatPath, "blocked")
	if err := os.WriteFile(blocker, []byte("blocked"), 0600); err != nil {
		t.Fatal(err)
	}
	a := &App{dir: dir, sessions: make(map[string]*session)}
	if err := a.writeSessionDeleteMarker(id, "alice"); err != nil {
		t.Fatal(err)
	}
	if err := a.loadSessions(); err != nil {
		t.Fatalf("startup should continue with cleanup pending: %v", err)
	}
	if _, found, err := a.readSessionDeleteMarker(id); err != nil || !found {
		t.Fatalf("marker must survive startup cleanup failure: found=%v err=%v", found, err)
	}
	if err := os.Remove(blocker); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(chatPath); err != nil {
		t.Fatal(err)
	}
	if err := a.deleteSession(id); err != nil {
		t.Fatal(err)
	}
	if _, found, err := a.readSessionDeleteMarker(id); err != nil || found {
		t.Fatalf("marker remains after post-restart retry: found=%v err=%v", found, err)
	}
}
