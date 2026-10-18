package server

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/creack/pty"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestClaudeStartHookForwardsNativeIdentity(t *testing.T) {
	t.Setenv("CROW_SESSION_ID", "0123456789abcdef0123456789abcdef")
	t.Setenv("CROW_AGENT", "claude")
	t.Setenv("CROW_HOOK_TOKEN", "test-local-capability")
	var got map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Error(err)
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()
	t.Setenv("CROW_EVENT_URL", server.URL+"/api/events")
	const native = "01234567-89ab-4cde-8fab-0123456789ab"
	if err := RunHookNotify([]string{"session-start", `{"session_id":"` + native + `","transcript_path":"/private/claude/projects/project/` + native + `.jsonl","cwd":"/project"}`}); err != nil {
		t.Fatal(err)
	}
	if got["claudeSessionId"] != native || got["claudeTranscriptPath"] != "/private/claude/projects/project/"+native+".jsonl" || got["claudeCwd"] != "/project" {
		t.Fatalf("native Claude resume identity was discarded: %#v", got)
	}
}

const testNativeClaudeID = "01234567-89ab-4cde-8fab-0123456789ab"

func claudeFixture(t *testing.T) (*App, *claudeConversation, *AccessPrincipal, http.Handler) {
	t.Helper()
	config := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", config)
	root := t.TempDir()
	root, _ = canonical(root)
	a := &App{dir: t.TempDir(), sessions: map[string]*session{}, token: "bootstrap", hookPath: "fake-hook", port: "12345"}
	p := &AccessPrincipal{ID: "alice", Role: "member", AllowedRoots: []string{root}}
	a.access.data = accessFile{Enabled: true, Users: []accessUser{{AccessPrincipal: *p, Hash: tokenHash("alice-token")}, {AccessPrincipal: AccessPrincipal{ID: "bob", Role: "member", AllowedRoots: []string{root}}, Hash: tokenHash("bob-token")}}}
	launch, err := a.prepareClaudeLaunch(root, "normal", strings.Repeat("b", 32), p.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	c := a.conversations[launch.ConversationID]
	c.NativeID = testNativeClaudeID
	path := filepath.Join(config, "projects", "synthetic-project", c.NativeID+".jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(map[string]string{"type": "user", "sessionId": c.NativeID, "cwd": root})
	if err := os.WriteFile(path, append(data, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	c.Transcript = path
	c.Pending = false
	c.Confirmed = true
	if err := a.saveClaudeConversationsLocked(); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	a.registerClaudeConversationRoutes(mux)
	return a, c, p, a.auth(mux)
}
func TestClaudeResumeRoutesAuthenticateThroughMux(t *testing.T) {
	a, c, _, h := claudeFixture(t)
	if w := accessRequest(h, "alice-token", "POST", "/api/claude-conversations/"+c.ID+"/name", `{"name":"Mi conversacion"}`); w.Code != 200 {
		t.Fatalf("name via authenticated mux: %d %s", w.Code, w.Body)
	}
	if w := accessRequest(h, "bob-token", "POST", "/api/claude-conversations/"+c.ID+"/name", `{"name":"foreign"}`); w.Code != 404 {
		t.Fatalf("foreign: %d", w.Code)
	}
	if a.conversations[c.ID].Name != "Mi conversacion" {
		t.Fatal("alias lost")
	}
}
func TestClaudeTranscriptRequiresNativeIdentity(t *testing.T) {
	_, c, _, _ := claudeFixture(t)
	for _, tc := range []struct{ name, body string }{{"wrong uuid", `{"sessionId":"ffffffff-ffff-4fff-8fff-ffffffffffff","cwd":` + strconvQuote(c.Root) + `}`}, {"wrong cwd", `{"sessionId":"` + c.NativeID + `","cwd":"/other-project"}`}, {"empty", `{"type":"summary"}`}} {
		t.Run(tc.name, func(t *testing.T) {
			os.WriteFile(c.Transcript, []byte(tc.body+"\n"), 0600)
			if validateClaudeTranscript(c, c.Transcript) == nil {
				t.Fatal("accepted unproven transcript identity")
			}
		})
	}
}
func strconvQuote(s string) string { b, _ := json.Marshal(s); return string(b) }
func TestClaudeConfirmedHistorySurvivesInterruptedResume(t *testing.T) {
	for _, tc := range []struct {
		name    string
		pending bool
		failure string
	}{{"crash", true, ""}, {"spawn failure", false, "Claude no pudo iniciarse."}} {
		t.Run(tc.name, func(t *testing.T) {
			a, c, _, _ := claudeFixture(t)
			c.Pending = tc.pending
			c.Failure = tc.failure
			if err := a.saveClaudeConversationsLocked(); err != nil {
				t.Fatal(err)
			}
			next := &App{dir: a.dir, sessions: map[string]*session{}}
			if err := next.loadClaudeConversations(); err != nil {
				t.Fatal(err)
			}
			if got := next.claudeDTO(next.conversations[c.ID]); got.Status != "available" {
				t.Fatalf("confirmed original history must allow explicit new retry: %+v", got)
			}
		})
	}
}

func TestClaudeFakeProcess(t *testing.T) {
	if os.Getenv("CROW_SYNTHETIC_PROCESS") != "1" {
		return
	}
	time.Sleep(time.Minute)
	os.Exit(0)
}
func installFakeClaude(t *testing.T, a *App, onSpawn func(*exec.Cmd)) *int {
	t.Helper()
	bin := t.TempDir()
	name := "claude"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if err := os.WriteFile(filepath.Join(bin, name), []byte("synthetic binary never executed"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	calls := new(int)
	a.startPTY = func(cmd *exec.Cmd, _ *pty.Winsize) (*os.File, error) {
		*calls++
		if onSpawn != nil {
			onSpawn(cmd)
		}
		originalEnv := cmd.Env
		*cmd = *exec.Command(os.Args[0], "-test.run=^TestClaudeFakeProcess$")
		cmd.Env = append(originalEnv, "CROW_SYNTHETIC_PROCESS=1")
		if err := cmd.Start(); err != nil {
			return nil, err
		}
		process := cmd.Process
		t.Cleanup(func() { _ = process.Kill() })
		f, err := os.CreateTemp(a.dir, "synthetic-pty")
		return f, err
	}
	return calls
}
func requestClaude(h http.Handler, c *claudeConversation, req string) *httptest.ResponseRecorder {
	return accessRequest(h, "alice-token", "POST", "/api/claude-conversations/"+c.ID+"/resume", `{"requestId":"`+req+`"}`)
}
func TestClaudeExactResumeLifecycleAndRetry(t *testing.T) {
	a, c, p, h := claudeFixture(t)
	c.Name = "Mi agente"
	c.Mode = "bypass"
	if err := a.saveClaudeConversationsLocked(); err != nil {
		t.Fatal(err)
	}
	latest := c.SessionID
	calls := installFakeClaude(t, a, func(cmd *exec.Cmd) {
		args := strings.Join(cmd.Args, " ")
		if !strings.Contains(args, "--resume "+testNativeClaudeID) || strings.Contains(args, "--session-id") || strings.Contains(args, "--continue") || !strings.Contains(args, "--dangerously-skip-permissions") {
			t.Errorf("not exact preserved resume: %s", args)
		}
		var id string
		for _, e := range cmd.Env {
			if strings.HasPrefix(e, "CROW_SESSION_ID=") {
				id = strings.TrimPrefix(e, "CROW_SESSION_ID=")
			}
		}
		if id == latest || a.session(id) == nil || a.session(id).snapshot().ClaudeConversationID != c.ID {
			t.Error("new terminal not registered before process spawn")
		}
		if err := a.confirmClaudeIdentity(id, c.NativeID, c.Transcript, c.Root); err != nil {
			t.Errorf("immediate hook confirmation: %v", err)
		}
	})
	const request = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	w := requestClaude(h, c, request)
	if w.Code != 202 {
		t.Fatalf("resume %d %s", w.Code, w.Body)
	}
	var result claudeResumeResult
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.State != "ready" || result.Conversation.Status != "active" || result.Session == nil || result.Session.ID == latest || result.Conversation.Name != "Mi agente" {
		t.Fatalf("result: %+v", result)
	}
	w = requestClaude(h, c, request)
	if w.Code != 200 || *calls != 1 {
		t.Fatalf("retry duplicated spawn: %d calls%d", w.Code, *calls)
	}
	const focusRequest = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	if w := requestClaude(h, c, focusRequest); w.Code != 200 {
		t.Fatal("active focus failed", w.Code)
	}
	// A terminal delete removes Crow artifacts, not the Claude native history.
	stopSyntheticClaude(t, a, result.Session.ID)
	if err := a.deleteSession(result.Session.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(c.Transcript); err != nil {
		t.Fatal("native history removed", err)
	}
	next := &App{dir: a.dir, sessions: map[string]*session{}, hookPath: a.hookPath, port: a.port, token: a.token}
	next.access.data = a.access.data
	if err := next.loadClaudeConversations(); err != nil {
		t.Fatal(err)
	}
	if next.claudeDTO(next.conversations[c.ID]).Status != "available" {
		t.Fatal("history not available after terminal delete and server reload")
	}
	mux := http.NewServeMux()
	next.registerClaudeConversationRoutes(mux)
	nextCalls := installFakeClaude(t, next, nil)
	if w := requestClaude(next.auth(mux), c, request); w.Code != 409 || *nextCalls != 0 {
		t.Fatalf("consumed request respawned after reload: %d", w.Code)
	}
	if w := requestClaude(next.auth(mux), c, focusRequest); w.Code != 409 || *nextCalls != 0 {
		t.Fatalf("accepted existing request respawned after reload: %d", w.Code)
	}
	// Current access, not stale principal, decides admission.
	next.access.data.Users[0].AllowedRoots = nil
	if _, err := next.startSessionPromptIntent("claude", c.Mode, c.Root, p, "", nil, ""); err == nil {
		t.Fatal("stale allowed roots admitted")
	}
}
func TestClaudeFreshLaunchAndDelayedNativeIdentity(t *testing.T) {
	a, c, p, _ := claudeFixture(t)
	var info SessionInfo
	installFakeClaude(t, a, func(cmd *exec.Cmd) {
		args := strings.Join(cmd.Args, " ")
		if !strings.Contains(args, "--session-id ") || strings.Contains(args, "--resume") {
			t.Error("fresh launch missing explicit native uuid")
		}
	})
	var err error
	info, err = a.startSessionOwned("claude", "normal", c.Root, p)
	if err != nil {
		t.Fatal(err)
	}
	record := a.conversations[info.ClaudeConversationID]
	if record == nil || record.NativeID == c.NativeID {
		t.Fatal("fresh conversation identity missing")
	}
	path := filepath.Join(record.ConfigDir, "projects", "synthetic-project", record.NativeID+".jsonl")
	if err := a.confirmClaudeIdentity(info.ID, record.NativeID, path, record.Root); err == nil {
		t.Fatal("confirmed nonexistent transcript")
	}
	if a.claudeDTO(record).Status != "pending" {
		t.Fatal("early hook should stay pending")
	}
	data, _ := json.Marshal(map[string]string{"sessionId": record.NativeID, "cwd": record.Root})
	os.WriteFile(path, append(data, '\n'), 0600)
	payload, _ := json.Marshal(map[string]string{"sessionId": info.ID, "agent": "claude", "kind": "turn-complete", "claudeSessionId": record.NativeID, "claudeTranscriptPath": path, "claudeCwd": record.Root})
	w := httptest.NewRecorder()
	a.handleEvents(w, httptest.NewRequest("POST", "/api/events", strings.NewReader(string(payload))).WithContext(context.WithValue(context.Background(), hookContextKey{}, info.ID)))
	if w.Code != 202 || a.claudeDTO(record).Status != "active" {
		t.Fatalf("later hook failed confirmation %d %s %+v", w.Code, w.Body, a.claudeDTO(record))
	}
	stopSyntheticClaude(t, a, info.ID)
	a.deleteSession(info.ID)
}
func TestClaudeUnavailableAndOwnerIsolation(t *testing.T) {
	a, c, _, h := claudeFixture(t)
	for _, token := range []string{"bob-token", "bootstrap"} {
		w := accessRequest(h, token, "GET", "/api/claude-conversations", "")
		if token == "bob-token" && strings.TrimSpace(w.Body.String()) != "[]" {
			t.Fatalf("foreign list exposed %s", w.Body)
		}
	}
	public := accessRequest(h, "alice-token", "GET", "/api/claude-conversations", "").Body.String()
	if strings.Contains(public, c.NativeID) || strings.Contains(public, "transcript") || strings.Contains(public, c.ConfigDir) {
		t.Fatal("private native metadata exposed")
	}
	os.Remove(c.Transcript)
	if w := requestClaude(h, c, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"); w.Code != 409 {
		t.Fatalf("missing native history must not start fresh: %d", w.Code)
	}
	a.access.data.Users[0].Revoked = true
	if w := accessRequest(h, "alice-token", "GET", "/api/claude-conversations", ""); w.Code != 401 {
		t.Fatalf("revoked credential %d", w.Code)
	}
}
func TestClaudeCatalogueFailsClosed(t *testing.T) {
	for _, body := range []string{"{}", "not json", `{"version":1,"conversations":[null]}`} {
		t.Run(body, func(t *testing.T) {
			a := &App{dir: t.TempDir()}
			os.WriteFile(filepath.Join(a.dir, claudeCatalogueFile), []byte(body), 0600)
			if a.loadClaudeConversations() == nil {
				t.Fatal("accepted corrupt catalogue")
			}
		})
	}
	a, c, _, _ := claudeFixture(t)
	target := filepath.Join(t.TempDir(), "outside.jsonl")
	os.WriteFile(target, []byte("private"), 0600)
	link := filepath.Join(filepath.Dir(c.Transcript), "link.jsonl")
	if err := os.Symlink(target, link); err != nil {
		t.Skip("symlinks unavailable: " + err.Error())
	}
	copy := *c
	copy.NativeID = "link"
	if validateClaudeTranscript(&copy, link) == nil {
		t.Fatal("accepted transcript symlink")
	}
	os.Remove(filepath.Join(a.dir, claudeCatalogueFile))
	os.Symlink(target, filepath.Join(a.dir, claudeCatalogueFile))
	if a.saveClaudeConversationsLocked() == nil {
		t.Fatal("replaced symlink catalogue")
	}
}
func TestClaudeResumeConcurrentRequestsStartOne(t *testing.T) {
	a, c, _, h := claudeFixture(t)
	calls := installFakeClaude(t, a, nil)
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := requestClaude(h, c, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
			if w.Code != 200 && w.Code != 202 {
				t.Errorf("resume %d %s", w.Code, w.Body)
			}
		}()
	}
	wg.Wait()
	if *calls != 1 {
		t.Fatalf("spawned %d processes", *calls)
	}
	stopSyntheticClaude(t, a, c.SessionID)
	a.deleteSession(c.SessionID)
}
func TestClaudeSpawnFailureCanRetryConfirmedHistory(t *testing.T) {
	a, c, _, h := claudeFixture(t)
	installFakeClaude(t, a, nil)
	a.startPTY = func(*exec.Cmd, *pty.Winsize) (*os.File, error) { return nil, errors.New("synthetic unavailable") }
	if w := requestClaude(h, c, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"); w.Code != 503 {
		t.Fatalf("failure %d %s", w.Code, w.Body)
	}
	if a.claudeDTO(c).Status != "available" {
		t.Fatal("transient process failure destroyed available native history")
	}
	if w := requestClaude(h, c, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"); w.Code != 409 {
		t.Fatal("retry consumed request should not spawn")
	}
	installFakeClaude(t, a, nil)
	if w := requestClaude(h, c, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"); w.Code != 202 {
		t.Fatalf("new explicit retry failed %d %s", w.Code, w.Body)
	}
	stopSyntheticClaude(t, a, c.SessionID)

}

func stopSyntheticClaude(t *testing.T, a *App, id string) {
	t.Helper()
	s := a.session(id)
	if s == nil {
		return
	}
	s.mu.Lock()
	cmd := s.cmd
	done := s.done
	s.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	if done != nil {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("synthetic process cleanup timed out")
		}
	}
}

func TestClaudeForgetKeepsNativeHistoryAndRejectsLive(t *testing.T) {
	a, c, _, h := claudeFixture(t)
	calls := installFakeClaude(t, a, nil)
	if w := requestClaude(h, c, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"); w.Code != 202 {
		t.Fatal(w.Code, w.Body)
	}
	if w := accessRequest(h, "alice-token", "DELETE", "/api/claude-conversations/"+c.ID, ""); w.Code != 409 {
		t.Fatalf("forgot pending live conversation: %d", w.Code)
	}
	stopSyntheticClaude(t, a, c.SessionID)
	if err := a.deleteSession(c.SessionID); err != nil {
		t.Fatal(err)
	}
	if w := accessRequest(h, "alice-token", "DELETE", "/api/claude-conversations/"+c.ID, ""); w.Code != 200 {
		t.Fatalf("forget %d %s", w.Code, w.Body)
	}
	if _, err := os.Stat(c.Transcript); err != nil {
		t.Fatal("forget deleted native history", err)
	}
	if len(a.conversations) != 0 || *calls != 1 {
		t.Fatal("forget retained catalogue or spawned")
	}
}
func TestClaudePendingTimeoutReturnsConflictNotFalseReady(t *testing.T) {
	a, c, _, h := claudeFixture(t)
	installFakeClaude(t, a, nil)
	if w := requestClaude(h, c, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"); w.Code != 202 {
		t.Fatal(w.Code)
	}
	c.UpdatedAt = time.Now().Add(-time.Minute)
	if w := requestClaude(h, c, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"); w.Code != 409 {
		t.Fatalf("unconfirmed timeout exposed false ready/pending: %d %s", w.Code, w.Body)
	}
	stopSyntheticClaude(t, a, c.SessionID)
}
func TestClaudeNativeHookDoesNotSwitchConversation(t *testing.T) {
	a, c, _, _ := claudeFixture(t)
	a.sessions[c.SessionID] = &session{info: SessionInfo{ID: c.SessionID, Root: c.Root, OwnerID: c.OwnerID, ClaudeConversationID: c.ID, State: "running"}}
	c.Pending = true
	c.Confirmed = false
	if a.confirmClaudeIdentity(c.SessionID, "ffffffff-ffff-4fff-8fff-ffffffffffff", c.Transcript, c.Root) == nil {
		t.Fatal("accepted different native conversation")
	}
	if c.Confirmed || !c.Pending {
		t.Fatal("failed hook changed catalogue")
	}
	if a.confirmClaudeIdentity(c.SessionID, c.NativeID, c.Transcript, t.TempDir()) == nil {
		t.Fatal("accepted wrong cwd")
	}
}
func TestClaudeTranscriptConfinement(t *testing.T) {
	_, c, _, _ := claudeFixture(t)
	outside := filepath.Join(t.TempDir(), c.NativeID+".jsonl")
	data, _ := os.ReadFile(c.Transcript)
	os.WriteFile(outside, data, 0600)
	if validateClaudeTranscript(c, outside) == nil {
		t.Fatal("accepted outside config")
	}
	target := filepath.Join(t.TempDir(), c.NativeID+".jsonl")
	os.WriteFile(target, data, 0600)
	os.Remove(c.Transcript)
	if err := os.Symlink(target, c.Transcript); err != nil {
		t.Skip("symlinks unavailable: " + err.Error())
	}
	if validateClaudeTranscript(c, c.Transcript) == nil {
		t.Fatal("accepted exact-name symlink")
	}
}

func TestClaudeCorruptCatalogueDoesNotDisableExistingTerminals(t *testing.T) {
	a, c, _, _ := claudeFixture(t)
	os.WriteFile(filepath.Join(a.dir, claudeCatalogueFile), []byte("corrupt synthetic catalogue"), 0600)
	next := &App{dir: a.dir, sessions: map[string]*session{c.SessionID: {info: SessionInfo{ID: c.SessionID, Root: c.Root, OwnerID: c.OwnerID, State: "exited"}}}, token: a.token}
	next.access.data = a.access.data
	next.initializeClaudeConversations()
	mux := http.NewServeMux()
	next.registerClaudeConversationRoutes(mux)
	mux.HandleFunc("GET /api/sessions", next.handleSessions)
	h := next.auth(mux)
	if w := accessRequest(h, "alice-token", "GET", "/api/sessions", ""); w.Code != 200 || !strings.Contains(w.Body.String(), c.SessionID) {
		t.Fatalf("existing sessions disabled %d %s", w.Code, w.Body)
	}
	if w := accessRequest(h, "alice-token", "GET", "/api/claude-conversations", ""); w.Code != 503 {
		t.Fatalf("corrupt catalogue was not failclosed %d", w.Code)
	}
	data, _ := os.ReadFile(filepath.Join(a.dir, claudeCatalogueFile))
	if string(data) != "corrupt synthetic catalogue" {
		t.Fatal("overwrote corrupt catalogue")
	}
}

func TestClaudeInitialPromptDoesNotSwallowNativeFlags(t *testing.T) {
	a, c, p, _ := claudeFixture(t)
	installFakeClaude(t, a, func(cmd *exec.Cmd) {
		delimiter, native := -1, -1
		for i, arg := range cmd.Args {
			if arg == "--" {
				delimiter = i
			}
			if arg == "--session-id" {
				native = i
			}
		}
		if native < 0 || delimiter <= native+1 || cmd.Args[len(cmd.Args)-1] != "synthetic ERP detail" {
			t.Errorf("native flags after prompt delimiter: %#v", cmd.Args)
		}
	})
	info, err := a.startSessionPrompt("claude", "normal", c.Root, p, "synthetic ERP detail")
	if err != nil {
		t.Fatal(err)
	}
	stopSyntheticClaude(t, a, info.ID)
}
func TestClaudeWrongHookCannotCaptureForeignAnswer(t *testing.T) {
	a, c, _, _ := claudeFixture(t)
	a.sessions[c.SessionID] = &session{info: SessionInfo{ID: c.SessionID, Root: c.Root, OwnerID: c.OwnerID, Agent: "claude", HooksActive: true, ClaudeConversationID: c.ID, State: "running"}, subs: map[chan Frame]struct{}{}}
	payload, _ := json.Marshal(map[string]string{"sessionId": c.SessionID, "agent": "claude", "kind": "session-start", "claudeSessionId": "ffffffff-ffff-4fff-8fff-ffffffffffff", "claudeTranscriptPath": c.Transcript, "claudeCwd": c.Root, "chatMessage": "must not capture foreign response", "sourceId": "foreign"})
	w := httptest.NewRecorder()
	a.handleEvents(w, httptest.NewRequest("POST", "/api/events", strings.NewReader(string(payload))).WithContext(context.WithValue(context.Background(), hookContextKey{}, c.SessionID)))
	if w.Code != 409 {
		t.Fatalf("foreign native hook %d %s", w.Code, w.Body)
	}
	if _, err := os.Stat(filepath.Join(a.dir, "chat", c.SessionID+".jsonl")); !os.IsNotExist(err) {
		t.Fatal("foreign hook captured chat")
	}
}

func TestClaudeEarlyUserPromptIsCapturedWhileResumeIdentityPending(t *testing.T) {
	a, c, _, _ := claudeFixture(t)
	os.Remove(c.Transcript)
	c.Pending = true
	c.Confirmed = false
	a.sessions[c.SessionID] = &session{info: SessionInfo{ID: c.SessionID, Root: c.Root, OwnerID: c.OwnerID, Agent: "claude", HooksActive: true, ClaudeConversationID: c.ID, State: "running", AgentState: "waiting"}, subs: map[chan Frame]struct{}{}}
	payload, _ := json.Marshal(map[string]string{"sessionId": c.SessionID, "agent": "claude", "kind": "user-prompt", "claudeSessionId": c.NativeID, "claudeTranscriptPath": c.Transcript, "claudeCwd": c.Root, "chatMessage": "first synthetic question", "sourceId": "first-prompt"})
	w := httptest.NewRecorder()
	a.handleEvents(w, httptest.NewRequest("POST", "/api/events", strings.NewReader(string(payload))).WithContext(context.WithValue(context.Background(), hookContextKey{}, c.SessionID)))
	messages, _, err := a.chatHistory().page(c.SessionID, 0, 0, 10)
	if w.Code != 202 || err != nil || len(messages) != 1 || messages[0].Content != "first synthetic question" || a.session(c.SessionID).snapshot().AgentState != "working" {
		t.Fatalf("early valid hook dropped chat/state: %d messages%+v err%v", w.Code, messages, err)
	}
	if c.Confirmed || !c.Pending {
		t.Fatal("premature native resume confirmation")
	}
}
