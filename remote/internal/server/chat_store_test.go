package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testChatSessionID = "0123456789abcdef0123456789abcdef"

func TestChatStorePersistsDeduplicatesAndPagesMessages(t *testing.T) {
	dir := t.TempDir()
	store := newChatStore(dir)
	first, err := store.append(testChatSessionID, "user", "hola", "source-user-1")
	if err != nil {
		t.Fatal(err)
	}
	again, err := store.append(testChatSessionID, "user", "hola", "source-user-1")
	if err != nil || again.ID != first.ID || again.Seq != first.Seq {
		t.Fatalf("duplicate append = %#v, %v; want original %#v", again, err, first)
	}
	if _, err := store.append(testChatSessionID, "user", "contenido distinto", "source-user-1"); !errors.Is(err, errChatSourceConflict) {
		t.Fatalf("conflicting source id error = %v", err)
	}
	second, err := store.append(testChatSessionID, "assistant", "respuesta", "source-agent-1")
	if err != nil || second.Seq != first.Seq+1 {
		t.Fatalf("second append = %#v, %v", second, err)
	}

	restarted := newChatStore(dir)
	page, hasMore, err := restarted.page(testChatSessionID, 0, 0, 1)
	if err != nil || !hasMore || len(page) != 1 || page[0].ID != second.ID {
		t.Fatalf("latest page = %#v, hasMore=%v, err=%v", page, hasMore, err)
	}
	older, hasMore, err := restarted.page(testChatSessionID, 0, second.Seq, 10)
	if err != nil || hasMore || len(older) != 1 || older[0].ID != first.ID {
		t.Fatalf("older page = %#v, hasMore=%v, err=%v", older, hasMore, err)
	}
	newer, _, err := restarted.page(testChatSessionID, first.Seq, 0, 10)
	if err != nil || len(newer) != 1 || newer[0].ID != second.ID {
		t.Fatalf("newer page = %#v, err=%v", newer, err)
	}
}

func TestChatStorePreservesExplicitTruncationMetadata(t *testing.T) {
	store := newChatStore(t.TempDir())
	message, err := store.appendWithTruncation(testChatSessionID, "assistant", "partial answer", "source-truncated", true)
	if err != nil || !message.Truncated {
		t.Fatalf("truncated append = %#v, %v", message, err)
	}
	reloaded, _, err := newChatStore(filepath.Dir(store.dir)).page(testChatSessionID, 0, 0, 10)
	if err != nil || len(reloaded) != 1 || !reloaded[0].Truncated || reloaded[0].Content != "partial answer" {
		t.Fatalf("truncated history = %#v, %v", reloaded, err)
	}
	if _, err := store.appendWithTruncation(testChatSessionID, "assistant", "partial answer", "source-truncated", false); !errors.Is(err, errChatSourceConflict) {
		t.Fatalf("changing truncation state for a duplicate was accepted: %v", err)
	}
}

func TestChatStoreRejectsInvalidAndOversizedEntries(t *testing.T) {
	store := newChatStore(t.TempDir())
	for _, entry := range []struct{ session, role, text string }{
		{"../../outside", "user", "hola"},
		{testChatSessionID, "system", "not supported"},
		{testChatSessionID, "user", ""},
		{testChatSessionID, "assistant", string(make([]byte, maxChatMessageBytes+1))},
	} {
		if _, err := store.append(entry.session, entry.role, entry.text, "unique"); err == nil {
			t.Fatalf("accepted invalid entry %#v", entry)
		}
	}
}

func TestChatStoreReloadsMaximumControlCharacterMessage(t *testing.T) {
	dir := t.TempDir()
	store := newChatStore(dir)
	content := strings.Repeat("\x01", maxChatMessageBytes)
	message, err := store.append(testChatSessionID, "assistant", content, strings.Repeat("s", 200))
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(store.path(testChatSessionID))
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() <= maxChatMessageBytes+4096 {
		t.Fatalf("encoded record size %d did not exceed the old scanner limit", info.Size())
	}
	reloaded, _, err := newChatStore(dir).page(testChatSessionID, 0, 0, 10)
	if err != nil || len(reloaded) != 1 || reloaded[0].ID != message.ID || reloaded[0].Content != content {
		t.Fatalf("reloaded max-size control message = count %d, err %v", len(reloaded), err)
	}
}

func TestChatStoreRejectsCorruptAndOversizedFiles(t *testing.T) {
	for _, tc := range []struct {
		name string
		data []byte
	}{
		{name: "corrupt", data: []byte("{invalid json}\n")},
		{name: "oversized", data: make([]byte, maxChatStoreBytes+1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "chat", testChatSessionID+".jsonl")
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, tc.data, 0600); err != nil {
				t.Fatal(err)
			}
			if _, _, err := newChatStore(dir).page(testChatSessionID, 0, 0, 10); err == nil {
				t.Fatal("accepted corrupt or oversized chat data")
			}
		})
	}
}

func TestChatHistoryEndpointEnforcesSessionOwnershipAndReturnsPublicMessagesOnly(t *testing.T) {
	a, _, root := accessFixture(t)
	const sessionID = testChatSessionID
	a.sessions[sessionID] = &session{info: SessionInfo{ID: sessionID, OwnerID: "alice", Root: root, Agent: "claude", State: "interrupted", HooksActive: true}, subs: make(map[chan Frame]struct{})}
	if _, err := a.chatHistory().append(sessionID, "assistant", "private response marker", "hook-stop-id"); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/sessions/{id}/chat", a.handleChatHistory)
	handler := a.auth(mux)
	get := func(token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, "/api/sessions/"+sessionID+"/chat?limit=10", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	alice := get("alice-token")
	if alice.Code != http.StatusOK || !strings.Contains(alice.Body.String(), "private response marker") || strings.Contains(alice.Body.String(), "sourceId") || strings.Contains(alice.Body.String(), root) {
		t.Fatalf("owner response = %d %s", alice.Code, alice.Body.String())
	}
	bob := get("bob-token")
	if bob.Code != http.StatusNotFound || strings.Contains(bob.Body.String(), "private response marker") {
		t.Fatalf("foreign response = %d %s", bob.Code, bob.Body.String())
	}
	var result struct {
		Messages []ChatMessage `json:"messages"`
		HasMore  bool          `json:"hasMore"`
	}
	if err := json.Unmarshal(alice.Body.Bytes(), &result); err != nil || len(result.Messages) != 1 || result.Messages[0].Role != "assistant" {
		t.Fatalf("invalid public chat page: %#v, err=%v", result, err)
	}
}
