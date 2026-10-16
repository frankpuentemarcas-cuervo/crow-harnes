package server

import (
	"context"
	"encoding/json"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func accessFixture(t *testing.T) (*App, http.Handler, string) {
	t.Helper()
	root := t.TempDir()
	a := &App{dir: t.TempDir(), token: "bootstrap", sessions: map[string]*session{}}
	a.access.data = accessFile{Enabled: true, Users: []accessUser{
		{AccessPrincipal: AccessPrincipal{ID: "alice", Label: "Alice", Role: "member", AllowedRoots: []string{root}}, Hash: tokenHash("alice-token")},
		{AccessPrincipal: AccessPrincipal{ID: "bob", Label: "Bob", Role: "member", AllowedRoots: []string{root}}, Hash: tokenHash("bob-token")},
		{AccessPrincipal: AccessPrincipal{ID: "admin", Label: "Admin", Role: "admin", AllowedRoots: []string{}}, Hash: tokenHash("admin-token")}}}
	for id, owner := range map[string]string{"one": "alice", "two": "bob", "legacy": ""} {
		a.sessions[id] = &session{info: SessionInfo{ID: id, OwnerID: owner, Root: root, State: "exited", HooksActive: true}, subs: map[chan Frame]struct{}{}, activeSubagents: map[string]struct{}{}}
	}
	a.events = []Event{{ID: "e1", SessionID: "one", Seq: 1}, {ID: "e2", SessionID: "two", Seq: 2}, {ID: "e3", SessionID: "legacy", Seq: 3}}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/sessions", a.handleSessions)
	mux.HandleFunc("POST /api/sessions", a.handleSessions)
	mux.HandleFunc("GET /api/events", a.handleEvents)
	mux.HandleFunc("POST /api/events", a.handleEvents)
	mux.HandleFunc("GET /api/sessions/{id}/stream", a.handleStream)
	mux.HandleFunc("POST /api/access/enable", a.handleAccessEnable)
	mux.HandleFunc("GET /api/access/me", a.handleAccessMe)
	mux.HandleFunc("GET /api/access/users", a.handleAccessUsers)
	mux.HandleFunc("POST /api/access/users", a.handleAccessUsers)
	mux.HandleFunc("DELETE /api/access/users/{id}", a.handleAccessRevoke)
	mux.HandleFunc("POST /api/access/sessions/{id}/owner", a.handleAccessOwner)
	mux.HandleFunc("POST /api/task-dispatch", a.handleTaskDispatch)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { jsonResponse(w, 200, map[string]bool{"ok": true}) })
	return a, a.auth(mux), root
}
func accessRequest(handler http.Handler, token, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func installationRequest(handler http.Handler, token, installationID, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("X-Crow-Installation-ID", installationID)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func TestInstallationIdentityScopesSessionsEvenWithSharedBootstrapOrAdminCredential(t *testing.T) {
	a, h, root := accessFixture(t)
	a.sessions["install-a"] = &session{info: SessionInfo{ID: "install-a", OwnerID: "installation:" + strings.Repeat("a", 32), Root: root, State: "running"}, subs: map[chan Frame]struct{}{}, activeSubagents: map[string]struct{}{}}
	a.sessions["install-b"] = &session{info: SessionInfo{ID: "install-b", OwnerID: "installation:" + strings.Repeat("b", 32), Root: root, State: "running"}, subs: map[chan Frame]struct{}{}, activeSubagents: map[string]struct{}{}}

	for _, tc := range []struct{ token, installationID, expected string }{
		{"bootstrap", strings.Repeat("a", 32), "install-a"},
		{"admin-token", strings.Repeat("a", 32), "install-a"},
		{"bootstrap", strings.Repeat("b", 32), "install-b"},
	} {
		w := installationRequest(h, tc.token, tc.installationID, "GET", "/api/sessions", "")
		var sessions []SessionInfo
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &sessions) != nil || len(sessions) != 1 || sessions[0].ID != tc.expected {
			t.Fatalf("installation %s saw wrong sessions: %d %s", tc.installationID, w.Code, w.Body)
		}
	}
	if w := installationRequest(h, "admin-token", strings.Repeat("a", 32), "DELETE", "/api/sessions/install-b", ""); w.Code != 404 {
		t.Fatalf("installation could operate another Crow's terminal: %d %s", w.Code, w.Body)
	}
	identity := installationRequest(h, "bootstrap", strings.Repeat("a", 32), "GET", "/api/access/me", "")
	if identity.Code != 200 || !strings.Contains(identity.Body.String(), `"role":"installation"`) {
		t.Fatalf("installation identity missing: %d %s", identity.Code, identity.Body)
	}
}

func TestInstallationIdentityWorksBeforeIndividualAccessIsEnabled(t *testing.T) {
	a, h, root := accessFixture(t)
	a.access.data = accessFile{}
	id := strings.Repeat("c", 32)
	a.sessions["owned"] = &session{info: SessionInfo{ID: "owned", OwnerID: "installation:" + id, Root: root, State: "running"}, subs: map[chan Frame]struct{}{}, activeSubagents: map[string]struct{}{}}
	if w := installationRequest(h, "bootstrap", id, "GET", "/api/access/me", ""); w.Code != 200 || !strings.Contains(w.Body.String(), `"role":"installation"`) {
		t.Fatalf("installation identity without access registry missing: %d %s", w.Code, w.Body)
	}
	w := installationRequest(h, "bootstrap", id, "GET", "/api/sessions", "")
	var sessions []SessionInfo
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &sessions) != nil || len(sessions) != 1 || sessions[0].ID != "owned" {
		t.Fatalf("installation did not scope legacy-mode sessions: %d %s", w.Code, w.Body)
	}
}

func TestInstallationIdentityCanCreateSessionWithIndividualAccessEnabled(t *testing.T) {
	_, h, root := accessFixture(t)
	id := strings.Repeat("d", 32)
	body, err := json.Marshal(map[string]string{"agent": "unsupported", "mode": "normal", "root": root})
	if err != nil {
		t.Fatal(err)
	}
	w := installationRequest(h, "admin-token", id, "POST", "/api/sessions", string(body))
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "unsupported agent") {
		t.Fatalf("installation request failed before agent validation: %d %s", w.Code, w.Body)
	}
}

func TestAccessOwnershipMatrix(t *testing.T) {
	_, h, _ := accessFixture(t)
	for _, tc := range []struct {
		token    string
		count    int
		readonly bool
	}{{"alice-token", 1, false}, {"bob-token", 1, false}, {"admin-token", 3, true}} {
		t.Run(tc.token, func(t *testing.T) {
			w := accessRequest(h, tc.token, "GET", "/api/sessions", "")
			var infos []SessionInfo
			if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &infos) != nil || len(infos) != tc.count {
				t.Fatalf("%d %s", w.Code, w.Body)
			}
			if tc.readonly && !infos[0].ReadOnly {
				t.Fatal("administrator foreign sessions must be read only")
			}
			w = accessRequest(h, tc.token, "GET", "/api/events?includeMessage=true", "")
			var events []Event
			if json.Unmarshal(w.Body.Bytes(), &events) != nil || len(events) != tc.count {
				t.Fatalf("events %s", w.Body)
			}
		})
	}
	for _, tc := range []struct{ method, path, body string }{{"GET", "/api/sessions/two/stream", ""}, {"POST", "/api/sessions/two/wake", "{}"}, {"DELETE", "/api/sessions/two", ""}, {"POST", "/api/sessions/two/cache", "{}"}, {"POST", "/api/events", `{"sessionId":"two"}`}, {"POST", "/api/bridge/hello", `{"sessionId":"two"}`}} {
		t.Run(tc.path+tc.method, func(t *testing.T) {
			w := accessRequest(h, "alice-token", tc.method, tc.path, tc.body)
			if w.Code != 404 {
				t.Fatalf("got %d %s", w.Code, w.Body)
			}
		})
	}
	for _, method := range []string{"DELETE", "POST"} {
		path := "/api/sessions/two"
		body := ""
		if method == "POST" {
			path += "/wake"
			body = "{}"
		}
		if w := accessRequest(h, "admin-token", method, path, body); w.Code != 404 {
			t.Fatalf("foreign admin operation allowed %d", w.Code)
		}
	}
	for _, path := range []string{"/api/sessions", "/api/events", "/api/access/me", "/api/bridge/tasks/job"} {
		if w := accessRequest(h, "bootstrap", "GET", path, ""); w.Code != 401 {
			t.Fatalf("bootstrap bypass %s %d", path, w.Code)
		}
	}
}
func TestAccessRootsAndIdentitySpoofing(t *testing.T) {
	a, h, root := accessFixture(t)
	for _, outside := range []string{t.TempDir(), a.dir, filepath.Dir(a.dir)} {
		q := url.Values{"root": {outside}, "path": {"."}}
		if w := accessRequest(h, "alice-token", "GET", "/api/files/tree?"+q.Encode(), ""); w.Code != 403 {
			t.Fatalf("outside allowed %d %s", w.Code, w.Body)
		}
	}
	q := url.Values{"root": {root}, "path": {"."}}
	if w := accessRequest(h, "alice-token", "GET", "/api/files/tree?"+q.Encode(), ""); w.Code != 200 {
		t.Fatalf("allowed root %d %s", w.Code, w.Body)
	}
	for _, body := range []string{`{"root":` + quoted(root) + `,"ownerId":"bob"}`, `{"root":` + quoted(root) + `,"role":"admin"}`} {
		if w := accessRequest(h, "alice-token", "POST", "/api/sessions", body); w.Code != 400 {
			t.Fatalf("spoof accepted %d", w.Code)
		}
	}
	if browserOwner(httptest.NewRequest("GET", "/", nil).WithContext(context.WithValue(context.Background(), accessContextKey{}, &AccessPrincipal{ID: "alice"}))) == browserOwner(httptest.NewRequest("GET", "/", nil).WithContext(context.WithValue(context.Background(), accessContextKey{}, &AccessPrincipal{ID: "bob"}))) {
		t.Fatal("browser owners shared")
	}
}
func quoted(v string) string { data, _ := json.Marshal(v); return string(data) }
func TestAccessBootstrapPersistenceAndNoImplicitMigration(t *testing.T) {
	a, h, _ := accessFixture(t)
	a.access.data = accessFile{}
	w := accessRequest(h, "bootstrap", "POST", "/api/access/enable", `{"label":"Owner"}`)
	if w.Code != 201 {
		t.Fatalf("enable %d %s", w.Code, w.Body)
	}
	var issued struct {
		Principal  AccessPrincipal `json:"principal"`
		Credential string          `json:"credential"`
	}
	json.Unmarshal(w.Body.Bytes(), &issued)
	if issued.Principal.OperateOthers || a.sessions["legacy"].snapshot().OwnerID != "" {
		t.Fatal("implicit foreign operation/migration")
	}
	restored := &App{dir: a.dir}
	if err := restored.loadAccess(); err != nil {
		t.Fatal(err)
	}
	if !restored.accessEnabled() {
		t.Fatal("not persisted")
	}
	data, _ := os.ReadFile(filepath.Join(a.dir, "access.json"))
	if strings.Contains(string(data), issued.Credential) {
		t.Fatal("plaintext credential persisted")
	}
	if w = accessRequest(h, "bootstrap", "POST", "/api/access/enable", `{"label":"other"}`); w.Code != 401 {
		t.Fatal("bootstrap still accepted")
	}
	os.WriteFile(filepath.Join(a.dir, "access.json"), []byte(`{`), 0600)
	if restored.loadAccess() == nil {
		t.Fatal("corrupt access reset instead of failing closed")
	}
}
func TestAccessHookScopedAndRevoked(t *testing.T) {
	a, h, _ := accessFixture(t)
	a.sessions["one"].hookHash = tokenHash("hook-one")
	for _, tc := range []struct {
		method, path, body string
		status             int
	}{{"GET", "/api/events", "", 401}, {"POST", "/api/events", `{"sessionId":"two","kind":"working"}`, 403}, {"POST", "/api/events", `{"sessionId":"one","kind":"working"}`, 202}, {"POST", "/api/sessions/two/cache", "{}", 401}} {
		if w := accessRequest(h, "hook-one", tc.method, tc.path, tc.body); w.Code != tc.status {
			t.Fatalf("hook %s=%d %s", tc.path, w.Code, w.Body)
		}
	}
	if w := accessRequest(h, "admin-token", "DELETE", "/api/access/users/alice", ""); w.Code != 200 {
		t.Fatalf("revoke %d %s", w.Code, w.Body)
	}
	if w := accessRequest(h, "alice-token", "GET", "/api/sessions", ""); w.Code != 401 {
		t.Fatal("revoked user accepted")
	}
	if w := accessRequest(h, "hook-one", "POST", "/api/events", `{"sessionId":"one","kind":"working"}`); w.Code != 401 {
		t.Fatal("revoked hook accepted")
	}
}

func TestAccessHookScopedWhenIndividualAccessIsDisabled(t *testing.T) {
	const sessionID = "0123456789abcdef0123456789abcdef"
	ownerID := installationOwnerPrefix + strings.Repeat("a", 32)
	a := &App{dir: t.TempDir(), token: "bootstrap", sessions: map[string]*session{
		sessionID: {hookHash: tokenHash("hook-one"), info: SessionInfo{ID: sessionID, OwnerID: ownerID, Agent: "claude", State: "running", HooksActive: true}, subs: make(map[chan Frame]struct{})},
	}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/events", a.handleEvents)
	mux.HandleFunc("GET /api/events", a.handleEvents)
	h := a.auth(mux)

	body := `{"sessionId":"` + sessionID + `","kind":"user-prompt","agent":"claude","message":"prompt","sourceId":"prompt-1"}`
	if w := accessRequest(h, "hook-one", "POST", "/api/events", body); w.Code != http.StatusAccepted {
		t.Fatalf("installation-owned hook rejected while individual access is disabled: %d %s", w.Code, w.Body)
	}
	if w := accessRequest(h, "hook-one", "GET", "/api/events", ""); w.Code != http.StatusUnauthorized {
		t.Fatalf("hook credential listed events: %d %s", w.Code, w.Body)
	}
	wrongSession := strings.Replace(body, sessionID, "fedcba9876543210fedcba9876543210", 1)
	if w := accessRequest(h, "hook-one", "POST", "/api/events", wrongSession); w.Code != http.StatusForbidden {
		t.Fatalf("hook credential posted for another session: %d %s", w.Code, w.Body)
	}
	messages, _, err := a.chatHistory().page(sessionID, 0, 0, 10)
	if err != nil || len(messages) != 1 || messages[0].Content != "prompt" {
		t.Fatalf("hook event was not captured: %#v, err=%v", messages, err)
	}
}

func TestAccessHookScopedForInstallationOwnerWithIndividualAccessEnabled(t *testing.T) {
	a, h, _ := accessFixture(t)
	const sessionID = "0123456789abcdef0123456789abcdef"
	a.sessions[sessionID] = &session{hookHash: tokenHash("hook-install"), info: SessionInfo{
		ID: sessionID, OwnerID: installationOwnerPrefix + strings.Repeat("b", 32), Agent: "claude", State: "running", HooksActive: true,
	}, subs: make(map[chan Frame]struct{})}
	body := `{"sessionId":"` + sessionID + `","kind":"user-prompt","agent":"claude","message":"prompt","sourceId":"prompt-1"}`
	if w := accessRequest(h, "hook-install", "POST", "/api/events", body); w.Code != http.StatusAccepted {
		t.Fatalf("installation-owned hook rejected while individual access is enabled: %d %s", w.Code, w.Body)
	}
}

func TestAccessRevocationClosesLiveReplayStream(t *testing.T) {
	a, h, _ := accessFixture(t)
	os.WriteFile(filepath.Join(a.dir, "terminal-one.jsonl"), nil, 0600)
	server := httptest.NewServer(h)
	defer server.Close()
	headers := http.Header{"Authorization": {"Bearer alice-token"}}
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/api/sessions/one/stream", headers)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var frame Frame
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if err = conn.ReadJSON(&frame); err != nil {
		t.Fatal(err)
	}
	accessRequest(h, "admin-token", "DELETE", "/api/access/users/alice", "")
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if conn.ReadJSON(&frame) == nil {
		t.Fatal("revoked stream still readable")
	}
}
func TestTaskDispatchReservationCannotDuplicateOrChangePrincipal(t *testing.T) {
	a, h, root := accessFixture(t)
	job := "approved-job"
	records := map[string]taskDispatchRecord{job: {JobID: job, OwnerID: "alice", Root: root, Agent: "claude", PromptHash: tokenHash("approved"), State: "uncertain"}}
	if err := a.saveDispatch(records); err != nil {
		t.Fatal(err)
	}
	body := `{"jobId":"approved-job","root":` + quoted(root) + `,"agent":"claude","initialPrompt":"approved"}`
	for _, token := range []string{"alice-token", "bob-token"} {
		w := accessRequest(h, token, "POST", "/api/task-dispatch", body)
		if w.Code != 409 {
			t.Fatalf("pending restarted %d %s", w.Code, w.Body)
		}
	}
	records[job] = taskDispatchRecord{JobID: job, OwnerID: "alice", Root: root, Agent: "claude", PromptHash: tokenHash("approved"), State: "started", SessionID: "one"}
	a.saveDispatch(records)
	if w := accessRequest(h, "alice-token", "POST", "/api/task-dispatch", body); w.Code != 200 {
		t.Fatalf("matching replay %d %s", w.Code, w.Body)
	}
	if w := accessRequest(h, "alice-token", "POST", "/api/task-dispatch", strings.Replace(body, "approved\"}", "changed\"}", 1)); w.Code != 409 {
		t.Fatalf("prompt mismatch %d", w.Code)
	}
}
func TestAccessExplicitForeignOperationAudited(t *testing.T) {
	a, h, _ := accessFixture(t)
	a.access.data.Users[2].OperateOthers = true
	if w := accessRequest(h, "admin-token", "POST", "/api/sessions/two/wake", "{}"); w.Code != 200 {
		t.Fatalf("explicit admin operation %d", w.Code)
	}
	data, err := os.ReadFile(filepath.Join(a.dir, "access-audit.jsonl"))
	if err != nil || !strings.Contains(string(data), `"actorId":"admin"`) || strings.Contains(string(data), "admin-token") {
		t.Fatal("safe audit missing")
	}
}
func TestInitialPromptRemainsOneArgAndCannotEnableBypass(t *testing.T) {
	for _, agent := range []string{"claude", "codex"} {
		_, args, err := agentCommand(agent, "normal", "")
		if err != nil {
			t.Fatal(err)
		}
		prompt := "--dangerously-skip-permissions; $(touch /tmp/owned)\nquote '\""
		args = initialPromptArgs(args, prompt)
		if args[len(args)-2] != "--" || args[len(args)-1] != prompt {
			t.Fatal("prompt split/interpreted as options")
		}
		for _, arg := range args[:len(args)-2] {
			if strings.Contains(arg, "dangerously") {
				t.Fatal("bypass enabled")
			}
		}
	}
}
func TestAccessSymlinkRootEscape(t *testing.T) {
	_, h, root := accessFixture(t)
	outside := t.TempDir()
	link := filepath.Join(root, "external")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink privilege unavailable: %v", err)
	}
	q := url.Values{"root": {link}, "path": {"."}}
	if w := accessRequest(h, "alice-token", "GET", "/api/files/tree?"+q.Encode(), ""); w.Code != 403 {
		t.Fatalf("canonical escape %d", w.Code)
	}
}
func TestAccessCannotStealOwnedTerminalWithoutPermission(t *testing.T) {
	_, h, _ := accessFixture(t)
	if w := accessRequest(h, "admin-token", "POST", "/api/access/sessions/two/owner", `{"ownerId":"alice"}`); w.Code != 403 {
		t.Fatalf("foreign reassignment without permission %d %s", w.Code, w.Body)
	}
}
func TestAccessStartAdmissionRejectsRevokedPrincipal(t *testing.T) {
	a, _, root := accessFixture(t)
	a.access.data.Users[0].Revoked = true
	if _, err := a.startSessionPrompt("claude", "normal", root, &AccessPrincipal{ID: "alice", Role: "member", AllowedRoots: []string{root}}, "approved"); err == nil {
		t.Fatal("revoked request spawned")
	}
}
func TestAccessRegistryRejectsInvalidPermissionsAndRoots(t *testing.T) {
	a, _, _ := accessFixture(t)
	a.access.data.Users[0].OperateOthers = true
	data, _ := json.Marshal(a.access.data)
	os.WriteFile(filepath.Join(a.dir, "access.json"), data, 0600)
	if a.loadAccess() == nil {
		t.Fatal("corrupt member permission accepted")
	}
	a.access.data.Users[0].OperateOthers = false
	a.access.data.Users[0].AllowedRoots = []string{a.dir}
	data, _ = json.Marshal(a.access.data)
	os.WriteFile(filepath.Join(a.dir, "access.json"), data, 0600)
	if a.loadAccess() == nil {
		t.Fatal("state root accepted")
	}
}
func TestAccessEnableCancelsInflightLegacyResponses(t *testing.T) {
	a, _, _ := accessFixture(t)
	a.access.data = accessFile{}
	entered := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/access/enable", a.handleAccessEnable)
	mux.HandleFunc("GET /delayed", func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
		jsonResponse(w, 200, a.visibleSessions(r))
	})
	h := a.auth(mux)
	response := httptest.NewRecorder()
	go func() {
		defer close(done)
		request := httptest.NewRequest("GET", "/delayed", nil)
		request.Header.Set("Authorization", "Bearer bootstrap")
		h.ServeHTTP(response, request)
	}()
	<-entered
	issued := accessRequest(h, "bootstrap", "POST", "/api/access/enable", `{"label":"Owner"}`)
	if issued.Code != 201 || !strings.Contains(issued.Body.String(), "credential") {
		t.Fatalf("enable response lost %d %s", issued.Code, issued.Body)
	}
	close(release)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("legacy request not released")
	}
	if response.Body.Len() != 0 {
		t.Fatalf("legacy request leaked after enable: %s", response.Body)
	}
}
