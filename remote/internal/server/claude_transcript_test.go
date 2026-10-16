package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClaudeTranscriptRecoversOnlyLatestConversationalText(t *testing.T) {
	config := t.TempDir()
	dir := filepath.Join(config, "projects", "project")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "provider-id.jsonl")
	content := strings.Repeat("{\"type\":\"progress\"}\n", maxClaudeTranscriptTail/18) +
		`{"type":"assistant","uuid":"old","message":{"role":"assistant","content":[{"type":"text","text":"old answer"}]}}` + "\n" +
		`{"type":"assistant","uuid":"latest","message":{"role":"assistant","content":[{"type":"thinking","thinking":"private"},{"type":"text","text":"latest answer"},{"type":"text","text":"second block"},{"type":"tool_use","input":{"secret":"not text"}}]}}` + "\n" +
		`{"type":"assistant","isSidechain":true,"uuid":"foreign","message":{"role":"assistant","content":[{"type":"text","text":"subagent answer"}]}}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]string{"session_id": "provider-id", "transcript_path": path})
	text, id := claudeTranscriptMessage(payload, config)
	if text != "latest answer\nsecond block" || id != "latest" {
		t.Fatalf("text=%q id=%q", text, id)
	}
	t.Setenv("CLAUDE_CONFIG_DIR", config)
	if got, source := claudeHookMessage(payload); got != text || source != id {
		t.Fatalf("hook fallback=%q %q", got, source)
	}
	direct, _ := json.Marshal(map[string]string{"session_id": "provider-id", "transcript_path": path, "last_assistant_message": "latest answer\nsecond block"})
	if got, source := claudeHookMessage(direct); got != text || source != id {
		t.Fatalf("direct source=%q %q", got, source)
	}
}

func TestClaudeTranscriptRejectsUnrelatedPathsAndSymlinks(t *testing.T) {
	config := t.TempDir()
	root := filepath.Join(config, "projects")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "provider-id.jsonl")
	if err := os.WriteFile(outside, []byte(`{"type":"assistant","uuid":"a","message":{"role":"assistant","content":[{"type":"text","text":"private"}]}}`), 0600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{outside, filepath.Join(root, "another-provider.jsonl")} {
		payload, _ := json.Marshal(map[string]string{"session_id": "provider-id", "transcript_path": path})
		if text, _ := claudeTranscriptMessage(payload, config); text != "" {
			t.Fatalf("read unrelated path %s", path)
		}
	}
	link := filepath.Join(root, "provider-id.jsonl")
	if err := os.Symlink(outside, link); err != nil {
		t.Logf("symlink privilege unavailable: %v", err)
		return
	}
	payload, _ := json.Marshal(map[string]string{"session_id": "provider-id", "transcript_path": link})
	if text, _ := claudeTranscriptMessage(payload, config); text != "" {
		t.Fatal("followed provider symlink")
	}
}

func TestSessionStartRestoresLatestAnswerWithoutACompletionAlert(t *testing.T) {
	const id = "0123456789abcdef0123456789abcdef"
	s := &session{info: SessionInfo{ID: id, Agent: "claude", State: "running", HooksActive: true, AgentState: "working"}, subs: make(map[chan Frame]struct{})}
	a := &App{dir: t.TempDir(), sessions: map[string]*session{id: s}}
	body := `{"sessionId":"` + id + `","agent":"claude","kind":"session-start","chatMessage":"previous answer","sourceId":"stable-uuid"}`
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		a.handleEvents(w, httptest.NewRequest(http.MethodPost, "/api/events", strings.NewReader(body)))
		if w.Code != http.StatusAccepted {
			t.Fatalf("status=%d %s", w.Code, w.Body)
		}
	}
	items, _, err := a.chatHistory().page(id, 0, 0, 100)
	if err != nil || len(items) != 1 || items[0].Content != "previous answer" {
		t.Fatalf("history=%#v err=%v", items, err)
	}
	if s.snapshot().AgentState != "waiting" || len(a.events) != 0 {
		t.Fatal("resume must be available without a false completion alert")
	}
	// A subsequent Stop for the same provider message must not append it twice.
	w := httptest.NewRecorder()
	a.handleEvents(w, httptest.NewRequest(http.MethodPost, "/api/events", strings.NewReader(strings.Replace(body, "session-start", "turn-complete", 1))))
	items, _, err = a.chatHistory().page(id, 0, 0, 100)
	if w.Code != http.StatusAccepted || err != nil || len(items) != 1 {
		t.Fatalf("duplicate Stop: status=%d history=%#v err=%v", w.Code, items, err)
	}
}

func TestRunHookSessionStartForwardsLatestTranscriptMessage(t *testing.T) {
	config := t.TempDir()
	dir := filepath.Join(config, "projects", "project")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "provider.jsonl")
	if err := os.WriteFile(path, []byte(`{"type":"assistant","uuid":"answer-uuid","message":{"role":"assistant","content":[{"type":"text","text":"last saved answer"}]}}`), 0600); err != nil {
		t.Fatal(err)
	}
	type hookMessage struct {
		Kind        string `json:"kind"`
		ChatMessage string `json:"chatMessage"`
		SourceID    string `json:"sourceId"`
	}
	receivedMessages := make(chan hookMessage, 1)
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var received hookMessage
		if r.Header.Get("Authorization") != "Bearer hook-secret" {
			t.Error("hook credential missing")
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Error(err)
		}
		receivedMessages <- received
		w.WriteHeader(http.StatusAccepted)
	}))
	defer endpoint.Close()
	t.Setenv("CLAUDE_CONFIG_DIR", config)
	t.Setenv("CROW_SESSION_ID", "0123456789abcdef0123456789abcdef")
	t.Setenv("CROW_AGENT", "claude")
	t.Setenv("CROW_HOOK_TOKEN", "hook-secret")
	t.Setenv("CROW_EVENT_URL", endpoint.URL+"/api/events")
	payload, _ := json.Marshal(map[string]string{"session_id": "provider", "transcript_path": path})
	if err := RunHookNotify([]string{"session-start", string(payload)}); err != nil {
		t.Fatal(err)
	}
	received := <-receivedMessages
	if received.Kind != "session-start" || received.ChatMessage != "last saved answer" || received.SourceID != "answer-uuid" {
		t.Fatalf("received=%#v", received)
	}
}

func TestClaudeSessionStartHookMatchesOnlyStartupAndResume(t *testing.T) {
	var settings struct {
		Hooks map[string][]struct {
			Matcher string `json:"matcher"`
			Hooks   []struct {
				Command string `json:"command"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(claudeHookSettings("/crow/notify", nil), &settings); err != nil {
		t.Fatal(err)
	}
	hooks := settings.Hooks["SessionStart"]
	if len(hooks) != 1 || hooks[0].Matcher != "startup|resume" || len(hooks[0].Hooks) != 1 || !strings.HasSuffix(hooks[0].Hooks[0].Command, " session-start") {
		t.Fatalf("unexpected SessionStart=%#v", hooks)
	}
}
