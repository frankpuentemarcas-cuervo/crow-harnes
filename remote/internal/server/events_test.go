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

func TestSubagentLifecycleKeepsSessionWorkingUntilAllSubagentsStop(t *testing.T) {
	dir := t.TempDir()
	const sessionID = "0123456789abcdef0123456789abcdef"
	s := &session{
		info:            SessionInfo{ID: sessionID, State: "running", Agent: "claude", AgentState: "working", HooksActive: true},
		rootAgentState:  "working",
		activeSubagents: make(map[string]struct{}),
		subs:            make(map[chan Frame]struct{}),
	}
	a := &App{dir: dir, sessions: map[string]*session{sessionID: s}}
	post := func(kind, agentID string) {
		t.Helper()
		body, err := json.Marshal(map[string]string{"sessionId": sessionID, "kind": kind, "agentId": agentID})
		if err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(http.MethodPost, "/api/events", strings.NewReader(string(body)))
		response := httptest.NewRecorder()
		a.handleEvents(response, request)
		if response.Code != http.StatusAccepted {
			t.Fatalf("%s status = %d, want %d: %s", kind, response.Code, http.StatusAccepted, response.Body.String())
		}
	}

	post("subagent-start", "agent-a")
	post("subagent-start", "agent-b")
	if got := s.snapshot().AgentState; got != "working" {
		t.Fatalf("state after starts = %q, want working", got)
	}
	a.markAgentState(sessionID, "completed")
	if got := s.snapshot().AgentState; got != "working" {
		t.Fatalf("parent completion hid active subagents: %q", got)
	}
	post("subagent-stop", "agent-a")
	if got := s.snapshot().AgentState; got != "working" {
		t.Fatalf("state after first stop = %q, want working", got)
	}
	post("subagent-stop", "agent-b")
	if got := s.snapshot().AgentState; got != "completed" {
		t.Fatalf("state after all stops = %q, want completed", got)
	}
}

func TestSubagentLifecycleIgnoresDuplicateStartAndUnknownStop(t *testing.T) {
	const sessionID = "0123456789abcdef0123456789abcdef"
	s := &session{info: SessionInfo{ID: sessionID, State: "running", HooksActive: true, AgentState: "waiting"}, rootAgentState: "waiting", subs: make(map[chan Frame]struct{})}
	a := &App{dir: t.TempDir(), sessions: map[string]*session{sessionID: s}}
	post := func(kind, agentID string) int {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"sessionId": sessionID, "kind": kind, "agentId": agentID})
		response := httptest.NewRecorder()
		a.handleEvents(response, httptest.NewRequest(http.MethodPost, "/api/events", strings.NewReader(string(body))))
		return response.Code
	}
	if got := post("subagent-start", "agent-a"); got != http.StatusAccepted {
		t.Fatalf("start status = %d", got)
	}
	if got := post("subagent-start", "agent-a"); got != http.StatusAccepted {
		t.Fatalf("duplicate start status = %d", got)
	}
	if got := post("subagent-stop", "unknown"); got != http.StatusAccepted {
		t.Fatalf("unknown stop status = %d", got)
	}
	if got := s.snapshot().AgentState; got != "working" {
		t.Fatalf("duplicate or unknown events changed state: %q", got)
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

func TestHookAgentIDReadsClaudeHookInput(t *testing.T) {
	if got := hookAgentID([]byte(`{"hook_event_name":"SubagentStop","agent_id":"agent-123","agent_type":"Explore"}`)); got != "agent-123" {
		t.Fatalf("agent id = %q, want agent-123", got)
	}
	if got := hookAgentID([]byte(`{"hook_event_name":"SubagentStop"}`)); got != "" {
		t.Fatalf("missing agent id = %q, want empty", got)
	}
}
