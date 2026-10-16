package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

func TestEventReaderAndSessionScopedEventKeepConsistentLockOrder(t *testing.T) {
	const sessionID = "0123456789abcdef0123456789abcdef"
	s := &session{info: SessionInfo{ID: sessionID}, subs: make(map[chan Frame]struct{})}
	a := &App{dir: t.TempDir(), sessions: map[string]*session{sessionID: s}}
	start := make(chan struct{})
	var workers sync.WaitGroup
	for i := 0; i < 3; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			for j := 0; j < 80; j++ {
				a.addEventIfSessionActive(s, sessionID, "turn-complete", false)
			}
		}()
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			for j := 0; j < 80; j++ {
				response := httptest.NewRecorder()
				a.handleEvents(response, httptest.NewRequest(http.MethodGet, "/api/events", nil))
				if response.Code != http.StatusOK {
					t.Errorf("GET /api/events status = %d, want %d", response.Code, http.StatusOK)
					return
				}
			}
		}()
	}
	close(start)
	done := make(chan struct{})
	go func() { workers.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("event listing and hook insertion deadlocked under contention")
	}
}

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

func TestClaudeHooksPersistExactStructuredMessagesSeparatelyFromAlerts(t *testing.T) {
	dir := t.TempDir()
	const sessionID = "0123456789abcdef0123456789abcdef"
	s := &session{info: SessionInfo{ID: sessionID, State: "running", Agent: "claude", HooksActive: true}, subs: make(map[chan Frame]struct{})}
	a := &App{dir: dir, sessions: map[string]*session{sessionID: s}}
	post := func(kind, message, sourceID string) {
		t.Helper()
		body, err := json.Marshal(map[string]string{"sessionId": sessionID, "kind": kind, "message": message, "sourceId": sourceID, "agent": "claude"})
		if err != nil {
			t.Fatal(err)
		}
		response := httptest.NewRecorder()
		a.handleEvents(response, httptest.NewRequest(http.MethodPost, "/api/events", strings.NewReader(string(body))))
		if response.Code != http.StatusAccepted {
			t.Fatalf("%s status = %d, want %d: %s", kind, response.Code, http.StatusAccepted, response.Body.String())
		}
	}
	userText := "prompt-private-marker"
	assistantText := strings.Repeat("assistant-output-", 900)
	post("user-prompt", userText, "hook-prompt-1")
	post("turn-complete", assistantText, "hook-stop-1")

	messages, hasMore, err := a.chatHistory().page(sessionID, 0, 0, 10)
	if err != nil || hasMore || len(messages) != 2 || messages[0].Role != "user" || messages[0].Content != userText || messages[1].Role != "assistant" || messages[1].Content != assistantText {
		t.Fatalf("structured transcript = %#v, hasMore=%v, err=%v", messages, hasMore, err)
	}
	alerts, err := os.ReadFile(filepath.Join(dir, "events.jsonl"))
	if err != nil || strings.Contains(string(alerts), userText) || strings.Contains(string(alerts), assistantText[:40]) {
		t.Fatalf("alert log unexpectedly contains conversation text: %s (err=%v)", alerts, err)
	}
	transcript, err := os.ReadFile(filepath.Join(dir, "chat", sessionID+".jsonl"))
	if err != nil || !strings.Contains(string(transcript), assistantText) {
		t.Fatalf("private transcript persistence invalid: err=%v", err)
	}
	public, err := json.Marshal(messages)
	if err != nil || strings.Contains(string(public), "sourceId") || strings.Contains(string(public), dir) {
		t.Fatalf("private transcript internals leaked in API model: %s (err=%v)", public, err)
	}
}

func TestCodexHooksPersistPromptAndCompletionOnce(t *testing.T) {
	const sessionID = "0123456789abcdef0123456789abcdef"
	s := &session{info: SessionInfo{ID: sessionID, State: "running", Agent: "codex", HooksActive: true}, subs: make(map[chan Frame]struct{})}
	a := &App{dir: t.TempDir(), sessions: map[string]*session{sessionID: s}}
	post := func(kind, message string) {
		t.Helper()
		body, err := json.Marshal(map[string]string{
			"sessionId":        sessionID,
			"kind":             kind,
			"agent":            "codex",
			"providerThreadId": "thread-123",
			"sourceId":         "turn-456",
			"message":          message,
			"userPrompt":       "current user request",
		})
		if err != nil {
			t.Fatal(err)
		}
		response := httptest.NewRecorder()
		a.handleEvents(response, httptest.NewRequest(http.MethodPost, "/api/events", strings.NewReader(string(body))))
		if response.Code != http.StatusAccepted {
			t.Fatalf("%s status = %d, want %d: %s", kind, response.Code, http.StatusAccepted, response.Body.String())
		}
	}
	post("user-prompt", "current user request")
	if got := s.snapshot().AgentState; got != "working" {
		t.Fatalf("Codex prompt state = %q, want working", got)
	}
	if !supportsChatHistory(s.snapshot()) {
		t.Fatal("Codex session with hooks should expose structured chat")
	}
	post("turn-complete", "assistant answer")
	if got := s.snapshot().AgentState; got != "completed" {
		t.Fatalf("Codex completion state = %q, want completed", got)
	}
	post("user-prompt", "current user request")
	post("turn-complete", "assistant answer")
	messages, _, err := a.chatHistory().page(sessionID, 0, 0, 10)
	if err != nil || len(messages) != 2 || messages[0].Role != "user" || messages[0].Content != "current user request" || messages[1].Role != "assistant" || messages[1].Content != "assistant answer" {
		t.Fatalf("Codex transcript duplicated or incomplete: %#v, err=%v", messages, err)
	}
}

func TestCodexInputSubmissionMarksSessionWorking(t *testing.T) {
	const sessionID = "0123456789abcdef0123456789abcdef"
	s := &session{info: SessionInfo{ID: sessionID, State: "running", Agent: "codex", HooksActive: true, AgentState: "waiting"}, rootAgentState: "waiting", subs: make(map[chan Frame]struct{})}
	a := &App{sessions: map[string]*session{sessionID: s}}
	a.markCodexInputWorking(sessionID, []byte("partial"))
	if got := s.snapshot().AgentState; got != "waiting" {
		t.Fatalf("partial input changed state to %q", got)
	}
	a.markCodexInputWorking(sessionID, []byte("complete\r"))
	if got := s.snapshot().AgentState; got != "working" {
		t.Fatalf("submitted input state = %q, want working", got)
	}
}

func TestChatCaptureCannotRecreateHistoryAfterSessionDeletionStarts(t *testing.T) {
	const sessionID = "0123456789abcdef0123456789abcdef"
	s := &session{info: SessionInfo{ID: sessionID, State: "running", Agent: "claude", HooksActive: true}, subs: make(map[chan Frame]struct{})}
	a := &App{dir: t.TempDir(), sessions: map[string]*session{sessionID: s}}
	store := a.chatHistory()
	s.mu.Lock()
	s.deleting = true
	s.mu.Unlock()
	if err := store.remove(sessionID); err != nil {
		t.Fatal(err)
	}
	if _, err := a.captureChatMessage(s, "assistant", "late response", "late-hook", false); err != errChatSessionDeleting {
		t.Fatalf("capture error = %v, want %v", err, errChatSessionDeleting)
	}
	if _, err := os.Stat(store.path(sessionID)); !os.IsNotExist(err) {
		t.Fatalf("late hook recreated deleted history, stat error = %v", err)
	}
}

func TestChatStoreLimitCreatesSingleVisibleNotice(t *testing.T) {
	const sessionID = "0123456789abcdef0123456789abcdef"
	s := &session{info: SessionInfo{ID: sessionID, State: "running", Agent: "claude", HooksActive: true}, subs: make(map[chan Frame]struct{})}
	a := &App{dir: t.TempDir(), sessions: map[string]*session{sessionID: s}}
	store := a.chatHistory()
	store.mu.Lock()
	index, err := store.sessionLocked(sessionID)
	if err != nil {
		store.mu.Unlock()
		t.Fatal(err)
	}
	index.bytes = maxChatStoreBytes
	store.mu.Unlock()
	for _, sourceID := range []string{"hook-0", "hook-1"} {
		if _, err := a.captureChatMessage(s, "assistant", "response", sourceID, false); err != errChatStoreLimit {
			t.Fatalf("capture error = %v, want store limit", err)
		}
	}
	if len(a.events) != 1 || a.events[0].Kind != "chat-history-limit" || !a.events[0].RequiresAttention {
		t.Fatalf("expected one actionable limit notice, got %#v", a.events)
	}
}

func TestUserPromptRequiresSessionAgentIdentity(t *testing.T) {
	const sessionID = "0123456789abcdef0123456789abcdef"
	a := &App{dir: t.TempDir(), sessions: map[string]*session{
		sessionID: {info: SessionInfo{ID: sessionID, State: "running", Agent: "claude", HooksActive: true}, subs: make(map[chan Frame]struct{})},
	}}
	response := httptest.NewRecorder()
	a.handleEvents(response, httptest.NewRequest(http.MethodPost, "/api/events", strings.NewReader(`{"sessionId":"`+sessionID+`","kind":"user-prompt","message":"text","agent":"codex"}`)))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("agent-mismatch prompt status = %d, want %d", response.Code, http.StatusBadRequest)
	}
}

func TestCompletionEventRecognizesSpanishAuthorization(t *testing.T) {
	const sessionID = "0123456789abcdef0123456789abcdef"
	a := &App{dir: t.TempDir(), sessions: map[string]*session{
		sessionID: {info: SessionInfo{ID: sessionID, State: "running", HooksActive: true}, subs: make(map[chan Frame]struct{})},
	}}
	body, err := json.Marshal(map[string]string{
		"sessionId": sessionID,
		"kind":      "turn-complete",
		"message":   "¿Me autorizás a resetear las contraseñas de los usuarios de prueba?",
	})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	a.handleEvents(response, httptest.NewRequest(http.MethodPost, "/api/events", strings.NewReader(string(body))))
	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d: %s", response.Code, http.StatusAccepted, response.Body.String())
	}
	if len(a.events) != 1 || !a.events[0].RequiresAttention {
		t.Fatalf("Spanish authorization request was not marked for attention: %#v", a.events)
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

func TestShellClaudeLifecyclePromotesAndRestoresSessionAgent(t *testing.T) {
	const sessionID = "0123456789abcdef0123456789abcdef"
	s := &session{
		info:            SessionInfo{ID: sessionID, State: "running", Agent: "shell", AgentState: "unknown", HooksActive: true},
		rootAgentState:  "unknown",
		activeSubagents: make(map[string]struct{}),
		subs:            make(map[chan Frame]struct{}),
	}
	a := &App{dir: t.TempDir(), sessions: map[string]*session{sessionID: s}}
	post := func(kind string) {
		t.Helper()
		body, err := json.Marshal(map[string]string{"sessionId": sessionID, "kind": kind, "agent": "claude"})
		if err != nil {
			t.Fatal(err)
		}
		response := httptest.NewRecorder()
		a.handleEvents(response, httptest.NewRequest(http.MethodPost, "/api/events", strings.NewReader(string(body))))
		if response.Code != http.StatusAccepted {
			t.Fatalf("%s status = %d, want %d: %s", kind, response.Code, http.StatusAccepted, response.Body.String())
		}
	}

	post("agent-start")
	if got := s.snapshot(); got.Agent != "claude" || got.AgentState != "waiting" {
		t.Fatalf("agent-start session = agent:%q state:%q, want claude/waiting", got.Agent, got.AgentState)
	}
	post("agent-stop")
	if got := s.snapshot(); got.Agent != "shell" || got.AgentState != "unknown" {
		t.Fatalf("agent-stop session = agent:%q state:%q, want shell/unknown", got.Agent, got.AgentState)
	}
}

func TestShellClaudeLifecycleRejectsUnexpectedAgent(t *testing.T) {
	const sessionID = "0123456789abcdef0123456789abcdef"
	s := &session{info: SessionInfo{ID: sessionID, State: "running", Agent: "shell", HooksActive: true}, subs: make(map[chan Frame]struct{})}
	a := &App{dir: t.TempDir(), sessions: map[string]*session{sessionID: s}}
	response := httptest.NewRecorder()
	a.handleEvents(response, httptest.NewRequest(http.MethodPost, "/api/events", strings.NewReader(`{"sessionId":"`+sessionID+`","kind":"agent-start","agent":"codex"}`)))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unexpected agent status = %d, want %d", response.Code, http.StatusBadRequest)
	}
	if got := s.snapshot().Agent; got != "shell" {
		t.Fatalf("unexpected agent changed session to %q", got)
	}
}

func TestRunHookNotifyForwardsCodexStopPayloadFromStdin(t *testing.T) {
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
	t.Setenv("CROW_AGENT", "codex")
	stdin, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	oldStdin := os.Stdin
	os.Stdin = stdin
	t.Cleanup(func() { os.Stdin = oldStdin; _ = stdin.Close() })
	payload := `{"session_id":"thread-123","turn_id":"turn-456","last_assistant_message":"Please approve the change."}`
	if _, err := writer.Write([]byte(payload)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/events" || r.Header.Get("Authorization") != "Bearer local-token" {
			t.Errorf("unexpected local hook request: path=%q authorization=%q", r.URL.Path, r.Header.Get("Authorization"))
		}
		var body struct {
			SessionID        string `json:"sessionId"`
			Kind             string `json:"kind"`
			Message          string `json:"message"`
			UserPrompt       string `json:"userPrompt"`
			ProviderThreadID string `json:"providerThreadId"`
			SourceID         string `json:"sourceId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body.SessionID != sessionID || body.Kind != "turn-complete" || body.Message != "Please approve the change." || body.UserPrompt != "" || body.ProviderThreadID != "thread-123" || body.SourceID != "turn-456" {
			t.Errorf("unexpected hook payload: %#v", body)
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()
	t.Setenv("CROW_EVENT_URL", server.URL+"/api/events")
	stdoutReader, stdoutWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	oldStdout := os.Stdout
	os.Stdout = stdoutWriter
	err = RunHookNotify([]string{"turn-complete"})
	_ = stdoutWriter.Close()
	os.Stdout = oldStdout
	stdout, readErr := io.ReadAll(stdoutReader)
	_ = stdoutReader.Close()
	if err != nil {
		t.Fatalf("RunHookNotify returned an error: %v", err)
	}
	if readErr != nil || len(stdout) != 0 {
		t.Fatalf("Codex Stop hook must succeed with empty stdout; got %q (read error: %v)", stdout, readErr)
	}
}

func TestRunHookNotifyReadsCodexPromptPayloadFromStdin(t *testing.T) {
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
	t.Setenv("CROW_AGENT", "codex")
	stdin, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	oldStdin := os.Stdin
	os.Stdin = stdin
	t.Cleanup(func() { os.Stdin = oldStdin; _ = stdin.Close() })
	payload := `{"session_id":"thread-123","turn_id":"turn-456","prompt":"Implement the requested change."}`
	if _, err := writer.Write([]byte(payload)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			SessionID        string `json:"sessionId"`
			Kind             string `json:"kind"`
			Message          string `json:"message"`
			ChatMessage      string `json:"chatMessage"`
			UserPrompt       string `json:"userPrompt"`
			ProviderThreadID string `json:"providerThreadId"`
			SourceID         string `json:"sourceId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body.SessionID != sessionID || body.Kind != "user-prompt" || body.Message != "Implement the requested change." || body.ChatMessage != "Implement the requested change." || body.UserPrompt != "" || body.ProviderThreadID != "thread-123" || body.SourceID != "turn-456" {
			t.Errorf("unexpected Codex hook payload: %#v", body)
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()
	t.Setenv("CROW_EVENT_URL", server.URL+"/api/events")
	if err := RunHookNotify([]string{"user-prompt"}); err != nil {
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

func TestClaudeHookExtractsPromptAndStableEventID(t *testing.T) {
	payload := []byte(`{"hook_event_name":"UserPromptSubmit","prompt":"hello from phone","uuid":"event-42"}`)
	if got := hookUserPrompt(payload); got != "hello from phone" {
		t.Fatalf("prompt = %q", got)
	}
	if got := hookEventID(payload); got != "event-42" {
		t.Fatalf("event ID = %q", got)
	}
	if got := hookUserPrompt([]byte(`{"prompt":7}`)); got != "" {
		t.Fatalf("invalid prompt = %q, want empty", got)
	}
}

func TestCodexHooksExtractPromptMessageSessionAndTurnIDs(t *testing.T) {
	payload := []byte(`{"session_id":"thread-123","turn_id":"turn-456","prompt":"latest request","last_assistant_message":"answer"}`)
	if got := hookUserPrompt(payload); got != "latest request" {
		t.Fatalf("Codex prompt = %q", got)
	}
	if got := hookAssistantMessage(payload); got != "answer" {
		t.Fatalf("Codex assistant message = %q", got)
	}
	if got := hookThreadID(payload); got != "thread-123" {
		t.Fatalf("Codex session id = %q", got)
	}
	if got := hookEventID(payload); got != "turn-456" {
		t.Fatalf("turn id = %q", got)
	}
}

func TestBoundedChatContentMarksTruncationWithoutBreakingUTF8(t *testing.T) {
	content := strings.Repeat("a", maxChatMessageBytes-8) + "ñ🙂tail"
	bounded, truncated := boundedChatContent(content)
	if !truncated || len(bounded) > maxChatMessageBytes || !strings.Contains(bounded, "[Mensaje recortado por el límite del historial]") || !utf8.ValidString(bounded) {
		t.Fatalf("bounded chat content invalid: len=%d truncated=%v valid=%v", len(bounded), truncated, utf8.ValidString(bounded))
	}
}
