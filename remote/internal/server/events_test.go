package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCompletionEventStoresClassificationButNotMessage(t *testing.T) {
	dir := t.TempDir()
	sessionID := "0123456789abcdef0123456789abcdef"
	a := &App{dir: dir, sessions: map[string]*session{
		sessionID: {info: SessionInfo{ID: sessionID, State: "running", HooksActive: true}, subs: make(map[chan Frame]struct{})},
	}}
	message := "I need you to approve the deployment before I continue. private-token-marker"
	request := httptest.NewRequest(http.MethodPost, "/api/events", strings.NewReader(`{"sessionId":"`+sessionID+`","kind":"turn-complete","message":"`+message+`"}`))
	response := httptest.NewRecorder()
	a.handleEvents(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusAccepted, response.Body.String())
	}
	if len(a.events) != 1 || !a.events[0].RequiresAttention {
		t.Fatalf("completion event was not classified as actionable: %#v", a.events)
	}
	stored, err := os.ReadFile(filepath.Join(dir, "events.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(stored), "private-token-marker") || strings.Contains(string(stored), "approve the deployment") {
		t.Fatalf("raw assistant text was persisted in events: %s", stored)
	}
}

func TestRunHookNotifyForwardsCodexMessageOnlyToLoopback(t *testing.T) {
	home := t.TempDir()
	tokenPath := filepath.Join(home, ".local", "share", "crow-harness", "token")
	if err := os.MkdirAll(filepath.Dir(tokenPath), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tokenPath, []byte("local-token"), 0600); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", home)
	} else {
		t.Setenv("HOME", home)
	}
	const sessionID = "0123456789abcdef0123456789abcdef"
	t.Setenv("CROW_SESSION_ID", sessionID)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/events" || r.Header.Get("Authorization") != "Bearer local-token" {
			t.Errorf("unexpected local hook request: path=%q authorization=%q", r.URL.Path, r.Header.Get("Authorization"))
		}
		var body struct {
			SessionID string `json:"sessionId"`
			Kind      string `json:"kind"`
			Message   string `json:"message"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body.SessionID != sessionID || body.Kind != "turn-complete" || body.Message != "Please approve the change." {
			t.Errorf("unexpected hook payload: %#v", body)
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()
	t.Setenv("CROW_EVENT_URL", server.URL+"/api/events")

	payload := `{"last-assistant-message":"Please approve the change."}`
	if err := RunHookNotify([]string{"turn-complete", payload}); err != nil {
		t.Fatalf("RunHookNotify returned an error: %v", err)
	}
}

func TestRunHookNotifyRejectsNonLoopbackEndpoint(t *testing.T) {
	t.Setenv("CROW_SESSION_ID", "0123456789abcdef0123456789abcdef")
	t.Setenv("CROW_EVENT_URL", "https://example.com/api/events")
	if err := RunHookNotify([]string{"turn-complete", `{"last-assistant-message":"approval needed"}`}); err == nil {
		t.Fatal("expected a non-loopback event URL to be rejected")
	}
}
