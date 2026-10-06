package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestNativeCacheAllowlist(t *testing.T) {
	now := time.Unix(1800000000, 0).UTC()
	input := []byte(`{"session_id":"conversation-1","prompt":"PRIVATE PROMPT","api_key":"PRIVATE KEY","prompt_cache":{"warm":true,"caching_observed":true,"ttl":"5m","expires_at":1800000200,"hit_ratio":0.96,"requests":4,"misses":1,"last_miss_cause":{"causes":["tools_changed","PRIVATE TEXT"]}},"context_window":{"current_usage":{"input_tokens":100,"cache_read_input_tokens":9600,"cache_creation_input_tokens":300}}}`)
	cache, err := parseClaudeCache(input, now)
	if err != nil {
		t.Fatal(err)
	}
	if cache.TTLSeconds != 300 || cache.ExpiresAt == nil || *cache.HitRatio != .96 || *cache.ReadTokens != 9600 {
		t.Fatalf("wrong metrics: %+v", cache)
	}
	encoded, _ := json.Marshal(cache)
	if strings.Contains(string(encoded), "PRIVATE") {
		t.Fatal("private input escaped allowlist")
	}
	if len(cache.LastMissCauses) != 1 || cache.LastMissCauses[0] != "tools_changed" {
		t.Fatal("cause must be a known enum")
	}
}

func TestNativeCacheMissingAndInvalidFields(t *testing.T) {
	for _, input := range []string{`{}`, `{"prompt_cache":null}`, `{"prompt_cache":{"ttl":"1h","warm":false,"expires_at":null,"hit_ratio":null},"context_window":{"current_usage":null}}`} {
		cache, err := parseClaudeCache([]byte(input), time.Now())
		if err != nil || cache.ExpiresAt != nil || cache.ReadTokens != nil {
			t.Fatalf("unknown data became a timer: %s %v", input, err)
		}
	}
	for _, input := range []string{`{"prompt_cache":{"ttl":"forever"}}`, `{"prompt_cache":{"hit_ratio":2}}`, `{"prompt_cache":{"requests":-1}}`, `{"context_window":{"current_usage":{"input_tokens":1.5}}}`, `{"session_id":"secret\ntext"}`, `{"prompt_cache":{"expires_at":999999999999}}`, `{`} {
		if _, err := parseClaudeCache([]byte(input), time.Now()); err == nil {
			t.Fatalf("accepted invalid data: %s", input)
		}
	}
}

func TestCacheEndpointDoesNotWakeOrExtendActivity(t *testing.T) {
	old := time.Now().Add(-time.Hour)
	s := &session{info: SessionInfo{ID: "a", Agent: "claude", State: "sleeping", HooksActive: true}, lastActivity: old, subs: make(map[chan Frame]struct{})}
	a := &App{token: "test-token", sessions: map[string]*session{"a": s}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/sessions/{id}/cache", a.handlePromptCache)
	post := func(data string, token string) int {
		r := httptest.NewRequest("POST", "/api/sessions/a/cache", strings.NewReader(data))
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		a.auth(mux).ServeHTTP(w, r)
		return w.Code
	}
	payload := `{"conversationId":"one","reportedAt":"` + time.Now().UTC().Format(time.RFC3339Nano) + `","ttlSeconds":300,"warm":true,"observed":true,"hitRatio":0.5}`
	if post(payload, "wrong") != 401 || post(payload, "test-token") != 202 {
		t.Fatal("authentication/collection failed")
	}
	if s.info.PromptCache == nil || s.info.State != "sleeping" || !s.lastActivity.Equal(old) {
		t.Fatal("telemetry changed terminal lifecycle")
	}
	before := s.info.PromptCache.ReportedAt
	if post(`{"reportedAt":"2000-01-01T00:00:00Z"}`, "test-token") != 202 || !s.info.PromptCache.ReportedAt.Equal(before) {
		t.Fatal("older report replaced newer report")
	}
	s.info.HooksActive = false
	if post(payload, "test-token") != 409 {
		t.Fatal("collector survived disabled hooks")
	}
}

func TestStatusLineSettingsPreserved(t *testing.T) {
	home, root := t.TempDir(), t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", home)
	if err := os.WriteFile(filepath.Join(home, "settings.json"), []byte(`{"statusLine":{"type":"command","command":"user-command","padding":3,"refreshInterval":8},"env":{"SECRET":"not copied"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	line, command := claudeCacheStatusLine(root, "/safe/crowd")
	if command != "user-command" || line["padding"] != float64(3) || line["refreshInterval"] != float64(8) {
		t.Fatal("original status line options lost")
	}
	if strings.Contains(line["command"].(string), "user-command") {
		t.Fatal("original command should not be a CLI argument")
	}
	if err := os.Mkdir(filepath.Join(root, ".claude"), 0700); err != nil {
		t.Fatal(err)
	}
	local := filepath.Join(root, ".claude", "settings.local.json")
	if err := os.WriteFile(local, []byte(`{"statusLine":{"type":"command","command":"local-command"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	_, command = claudeCacheStatusLine(root, "/safe/crowd")
	if command != "local-command" {
		t.Fatal("wrong precedence")
	}
	if err := os.WriteFile(local, []byte(`{"statusLine":null}`), 0600); err != nil {
		t.Fatal(err)
	}
	if line, _ := claudeCacheStatusLine(root, "/safe/crowd"); line != nil {
		t.Fatal("overrode explicitly disabled status line")
	}
}

func TestNativeCacheIsEphemeral(t *testing.T) {
	a := &App{dir: t.TempDir(), sessions: map[string]*session{"a": {info: SessionInfo{ID: "a", PromptCache: &PromptCache{ConversationID: "PRIVATE-ID"}}}}}
	if err := a.saveSessions(); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(filepath.Join(a.dir, "sessions.json"))
	if strings.Contains(string(data), "promptCache") || strings.Contains(string(data), "PRIVATE-ID") {
		t.Fatal("cache telemetry persisted")
	}
}

func TestAgentLifecycleDoesNotInventOrRenewNativeCache(t *testing.T) {
	expires := time.Now().Add(45 * time.Second).UTC()
	c := &PromptCache{Source: "claude-statusline", TTLSeconds: 300, ExpiresAt: &expires}
	s := &session{info: SessionInfo{ID: "a", Agent: "claude", State: "running", HooksActive: true, PromptCache: c}, activeSubagents: make(map[string]struct{}), subs: make(map[chan Frame]struct{})}
	a := &App{sessions: map[string]*session{"a": s}}
	a.markAgentState("a", "working")
	a.markSubagentState("a", "child", true)
	a.markAgentState("a", "completed")
	if s.info.AgentState != "working" {
		t.Fatal("active subagent lost working state")
	}
	a.markSubagentState("a", "child", false)
	if s.info.AgentState != "completed" || s.info.PromptCache != c || !s.info.PromptCache.ExpiresAt.Equal(expires) {
		t.Fatal("agent hooks changed the main conversation cache")
	}
	s.info.PromptCache = nil
	a.markAgentState("a", "completed")
	if s.info.PromptCache != nil || s.info.CacheExpiresAt != nil {
		t.Fatal("completion invented cache data")
	}
}

func TestCacheCollectorLoopbackOnlyAndSanitized(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	dir := filepath.Join(home, ".local", "share", "crow-harness")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "token"), []byte("fictional-test-token"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CROW_SESSION_ID", "0123456789abcdef0123456789abcdef")
	captured := make(chan []byte, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fictional-test-token" || r.URL.Path != "/api/sessions/0123456789abcdef0123456789abcdef/cache" {
			t.Error("wrong transport")
		}
		var data json.RawMessage
		_ = json.NewDecoder(r.Body).Decode(&data)
		captured <- data
		w.WriteHeader(202)
	}))
	defer srv.Close()
	t.Setenv("CROW_EVENT_URL", srv.URL+"/api/events")
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	cache, err := parseClaudeCache([]byte(`{"session_id":"one","prompt":"PRIVATE PROMPT","account":"PRIVATE ACCOUNT","prompt_cache":{"ttl":"1h","warm":false}}`), time.Now())
	if err != nil || postClaudeCache(cache) != nil {
		t.Fatal("local collector failed")
	}
	body := <-captured
	if bytes.Contains(body, []byte("PRIVATE")) || bytes.Contains(body, []byte("fictional-test-token")) {
		t.Fatal("private data in request body")
	}
	for _, address := range []string{"http://example.com:80/api/events", "https://127.0.0.1:443/api/events", srv.URL + "/api/events?token=secret", "http://user:pass@127.0.0.1:1/api/events"} {
		t.Setenv("CROW_EVENT_URL", address)
		if postClaudeCache(cache) == nil {
			t.Fatal("accepted unsafe collector address")
		}
	}
}

func TestStatuslineForwardingDoesNotCorruptUserOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX statusline command is used on Linux")
	}
	t.Setenv("CROW_SESSION_ID", "") // No real service or credentials.
	t.Setenv("CROW_STATUSLINE_COMMAND", "cat")
	input := `{"prompt_cache":null,"additional":"private local field"}`
	var out, stderr bytes.Buffer
	if err := runClaudeStatusline(strings.NewReader(input), &out, &stderr); err != nil {
		t.Fatal(err)
	}
	if out.String() != input {
		t.Fatal("changed original command stdin/stdout")
	}
}

func TestStatusLineHigherPrecedenceCanReenableAndMalformedIsUntouched(t *testing.T) {
	home, root := t.TempDir(), t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", home)
	if err := os.WriteFile(filepath.Join(home, "settings.json"), []byte(`{"statusLine":null}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, ".claude"), 0700); err != nil {
		t.Fatal(err)
	}
	local := filepath.Join(root, ".claude", "settings.local.json")
	if err := os.WriteFile(local, []byte(`{"statusLine":{"type":"command","command":"local"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, command := claudeCacheStatusLine(root, "/safe/crowd"); command != "local" {
		t.Fatal("did not honor higher precedence")
	}
	if err := os.WriteFile(local, []byte(`{"broken":`), 0600); err != nil {
		t.Fatal(err)
	}
	if line, _ := claudeCacheStatusLine(root, "/safe/crowd"); line != nil {
		t.Fatal("overrode unknown configuration")
	}
}
