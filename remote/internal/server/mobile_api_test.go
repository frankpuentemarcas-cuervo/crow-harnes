package server

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func mobileTestRequest(handler http.Handler, token, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Origin", "https://127.0.0.1:"+mobileHostPort)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func TestMobileStreamRejectsUnknownMode(t *testing.T) {
	a := &App{}
	r := httptest.NewRequest(http.MethodGet, "/api/v1/stream?mode=bogus", nil)
	w := httptest.NewRecorder()
	a.mobileStream(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("unknown mode status = %d, want 400", w.Code)
	}
}

func TestMobileStreamChatSuppressesTerminalOutput(t *testing.T) {
	a, _, root := accessFixture(t)
	a.mobile = newMobileHostState()
	project := mobileHostProject{ID: "project", Name: "Project", Root: root}
	const sessionID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	credential := strings.Repeat("c", 64)
	a.mobile.file = mobileHostFile{HostID: "host", Projects: []mobileHostProject{project}, Devices: []mobileHostDevice{{ID: "device", OwnerID: "alice", Projects: []mobileHostProject{project}}}}
	a.mobile.credentials[tokenHash(credential)] = mobileHostCredential{DeviceID: "device", ExpiresAt: time.Now().Add(time.Hour)}
	s := &session{info: SessionInfo{ID: sessionID, OwnerID: "alice", Root: root, Agent: "claude", State: "running", HooksActive: true, Seq: 2}, subs: make(map[chan Frame]struct{})}
	a.sessions[sessionID] = s
	logFile, err := os.Create(filepath.Join(a.dir, "terminal-"+sessionID+".jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	for seq := uint64(1); seq <= 2; seq++ {
		if err := json.NewEncoder(logFile).Encode(Frame{Type: "output", Seq: seq, Data: "historical"}); err != nil {
			t.Fatal(err)
		}
	}
	if err := logFile.Close(); err != nil {
		t.Fatal(err)
	}

	httpServer := httptest.NewServer(a.mobileHandler())
	defer httpServer.Close()
	streamURL, err := url.Parse("ws" + strings.TrimPrefix(httpServer.URL, "http") + "/api/v1/stream")
	if err != nil {
		t.Fatal(err)
	}
	query := streamURL.Query()
	query.Set("hostId", "host")
	query.Set("sessionId", sessionID)
	query.Set("mode", "chat")
	streamURL.RawQuery = query.Encode()
	headers := http.Header{"Authorization": []string{"Bearer " + credential}, "Origin": []string{"https://127.0.0.1:" + mobileHostPort}}
	conn, response, err := websocket.DefaultDialer.Dial(streamURL.String(), headers)
	if err != nil {
		if response != nil {
			t.Fatalf("dial chat stream: %v (HTTP %d)", err, response.StatusCode)
		}
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	readType := func(want string) map[string]json.RawMessage {
		t.Helper()
		var frame map[string]json.RawMessage
		if err := conn.ReadJSON(&frame); err != nil {
			t.Fatalf("read %s frame: %v", want, err)
		}
		var got string
		if err := json.Unmarshal(frame["type"], &got); err != nil || got != want {
			t.Fatalf("frame type = %q, want %q (frame %s)", got, want, frame["type"])
		}
		return frame
	}
	readType("ready")
	readType("state")

	// Chat mode must not leak either replayed output or new PTY output, but it
	// must continue delivering state changes on the same stream.
	s.output([]byte("live terminal secret"))
	a.markAgentState(sessionID, "working")
	readType("state")
}

func TestMobileStreamDefaultsToTerminalAndReplaysOutput(t *testing.T) {
	a, _, root := accessFixture(t)
	a.mobile = newMobileHostState()
	project := mobileHostProject{ID: "project", Name: "Project", Root: root}
	const sessionID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	credential := strings.Repeat("d", 64)
	a.mobile.file = mobileHostFile{HostID: "host", Projects: []mobileHostProject{project}, Devices: []mobileHostDevice{{ID: "device", OwnerID: "alice", Projects: []mobileHostProject{project}}}}
	a.mobile.credentials[tokenHash(credential)] = mobileHostCredential{DeviceID: "device", ExpiresAt: time.Now().Add(time.Hour)}
	a.sessions[sessionID] = &session{info: SessionInfo{ID: sessionID, OwnerID: "alice", Root: root, Agent: "shell", State: "running", Seq: 2}, subs: make(map[chan Frame]struct{})}
	logFile, err := os.Create(filepath.Join(a.dir, "terminal-"+sessionID+".jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	for seq := uint64(1); seq <= 2; seq++ {
		if err := json.NewEncoder(logFile).Encode(Frame{Type: "output", Seq: seq, Data: "historical"}); err != nil {
			t.Fatal(err)
		}
	}
	if err := logFile.Close(); err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(a.mobileHandler())
	defer httpServer.Close()
	streamURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/api/v1/stream?hostId=host&sessionId=" + sessionID
	headers := http.Header{"Authorization": []string{"Bearer " + credential}, "Origin": []string{"https://127.0.0.1:" + mobileHostPort}}
	conn, response, err := websocket.DefaultDialer.Dial(streamURL, headers)
	if err != nil {
		if response != nil {
			t.Fatalf("dial terminal stream: %v (HTTP %d)", err, response.StatusCode)
		}
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	var types []string
	for range 4 {
		var frame map[string]json.RawMessage
		if err := conn.ReadJSON(&frame); err != nil {
			t.Fatal(err)
		}
		var frameType string
		if err := json.Unmarshal(frame["type"], &frameType); err != nil {
			t.Fatal(err)
		}
		types = append(types, frameType)
	}
	want := []string{"ready", "output", "output", "state"}
	if strings.Join(types, ",") != strings.Join(want, ",") {
		t.Fatalf("default terminal stream frame types = %v, want %v", types, want)
	}
}

func TestMobileHostPairRenewAndExistingSessionsOnly(t *testing.T) {
	a, _, root := accessFixture(t)
	a.mobile = newMobileHostState()
	a.mobile.file = mobileHostFile{Version: 1, GatewayID: "gateway", HostID: "host", HostName: "Linux host", Projects: []mobileHostProject{{ID: "project", Name: "Project", Root: root}}}
	a.mobile.invite = &mobileHostInvite{Code: "secret-invite", OwnerID: "alice", Projects: a.mobile.file.Projects, ExpiresAt: time.Now().Add(time.Minute)}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	pairBody, _ := json.Marshal(map[string]string{"invitationCode": "secret-invite", "deviceName": "Android", "publicKey": base64.StdEncoding.EncodeToString(der)})
	handler := a.mobileHandler()
	pair := mobileTestRequest(handler, "", "POST", "/api/v2/pair", string(pairBody))
	if pair.Code != 200 {
		t.Fatalf("pair %d %s", pair.Code, pair.Body)
	}
	var linked struct {
		Device struct {
			ID           string `json:"id"`
			Capabilities struct {
				Create bool `json:"create"`
				Input  bool `json:"input"`
			} `json:"capabilities"`
		} `json:"device"`
		Credential string `json:"credential"`
	}
	if json.Unmarshal(pair.Body.Bytes(), &linked) != nil || linked.Device.ID == "" || linked.Device.Capabilities.Create || !linked.Device.Capabilities.Input {
		t.Fatalf("bad pair: %s", pair.Body)
	}
	if again := mobileTestRequest(handler, "", "POST", "/api/v2/pair", string(pairBody)); again.Code != 401 {
		t.Fatalf("reused invite: %d", again.Code)
	}
	list := mobileTestRequest(handler, linked.Credential, "GET", "/api/v1/sessions?hostId=host", "")
	var sessions []mobileHostSession
	if list.Code != 200 || json.Unmarshal(list.Body.Bytes(), &sessions) != nil || len(sessions) != 1 || sessions[0].ID != "one" || !sessions[0].CanOperate {
		t.Fatalf("sessions %d %s", list.Code, list.Body)
	}
	if strings.Contains(list.Body.String(), root) || strings.Contains(list.Body.String(), "promptCache") {
		t.Fatal("private host details leaked")
	}
	bootstrap := mobileTestRequest(handler, linked.Credential, "GET", "/api/v1/bootstrap", "")
	if bootstrap.Code != 200 || !strings.Contains(bootstrap.Body.String(), `"sessionCreate":false`) || !strings.Contains(bootstrap.Body.String(), `"sessionWake":false`) {
		t.Fatalf("offline host must advertise existing-session mode: %d %s", bootstrap.Code, bootstrap.Body)
	}
	for _, path := range []string{"/api/v1/sessions", "/api/v1/wake", "/api/v1/close"} {
		blocked := mobileTestRequest(handler, linked.Credential, "POST", path, `{}`)
		if blocked.Code != 403 {
			t.Fatalf("%s=%d", path, blocked.Code)
		}
	}
	challenge := mobileTestRequest(handler, "", "POST", "/api/v2/device-challenge", `{"deviceId":"`+linked.Device.ID+`"}`)
	if challenge.Code != 200 {
		t.Fatalf("challenge %d %s", challenge.Code, challenge.Body)
	}
	var proof struct {
		ChallengeID string `json:"challengeId"`
		Nonce       string `json:"nonce"`
	}
	if json.Unmarshal(challenge.Body.Bytes(), &proof) != nil {
		t.Fatal(challenge.Body)
	}
	payload := []byte("crow-mobile-renew:v2\ngateway\n" + linked.Device.ID + "\n" + proof.ChallengeID + "\n" + proof.Nonce)
	digest := sha256.Sum256(payload)
	signed, err := ecdsa.SignASN1(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	renewBody, _ := json.Marshal(map[string]string{"deviceId": linked.Device.ID, "challengeId": proof.ChallengeID, "signature": base64.StdEncoding.EncodeToString(signed)})
	if renewed := mobileTestRequest(handler, "", "POST", "/api/v2/device-renew", string(renewBody)); renewed.Code != 200 {
		t.Fatalf("renew %d %s", renewed.Code, renewed.Body)
	}
	if replay := mobileTestRequest(handler, "", "POST", "/api/v2/device-renew", string(renewBody)); replay.Code != 401 {
		t.Fatalf("replayed proof %d", replay.Code)
	}
	a.mobile.mu.Lock()
	a.mobile.file.Projects = nil
	a.mobile.mu.Unlock()
	if current, _, valid := a.mobileCurrentDevice(linked.Device.ID); !valid || len(current.Projects) != 0 {
		t.Fatal("removing a project must hide its sessions without discarding the device link")
	}
	a.mobile.mu.Lock()
	a.mobile.file.Projects = []mobileHostProject{{ID: "project", Name: "Project", Root: root}}
	a.mobile.mu.Unlock()
	if revoked := mobileTestRequest(handler, linked.Credential, "POST", "/api/v2/device-revoke", `{}`); revoked.Code != 200 {
		t.Fatalf("revoke %d %s", revoked.Code, revoked.Body)
	}
	if after := mobileTestRequest(handler, linked.Credential, "GET", "/api/v1/bootstrap", ""); after.Code != 401 {
		t.Fatalf("revoked token %d", after.Code)
	}
}

func TestMobileHostNeverOpensNativeAPIWithoutExpectedOrigin(t *testing.T) {
	a, _, _ := accessFixture(t)
	a.mobile = newMobileHostState()
	r := httptest.NewRequest("POST", "/api/v2/pair", strings.NewReader(`{}`))
	w := httptest.NewRecorder()
	a.mobileHandler().ServeHTTP(w, r)
	if w.Code != 403 || w.Header().Get("X-Crow-Mobile-API") != "1" {
		t.Fatalf("origin accepted: %d", w.Code)
	}
}

func TestMobileChatHistoryUsesSameHostSessionAuthorization(t *testing.T) {
	a, _, root := accessFixture(t)
	a.mobile = newMobileHostState()
	const sessionID = "0123456789abcdef0123456789abcdef"
	credential := strings.Repeat("a", 64)
	project := mobileHostProject{ID: "project", Name: "Project", Root: root}
	a.mobile.file = mobileHostFile{
		Version: 1, GatewayID: "gateway", HostID: "host", HostName: "Linux",
		Projects: []mobileHostProject{project},
		Devices:  []mobileHostDevice{{ID: "device", OwnerID: "alice", Projects: []mobileHostProject{project}}},
	}
	a.mobile.credentials[tokenHash(credential)] = mobileHostCredential{DeviceID: "device", ExpiresAt: time.Now().Add(time.Minute)}
	a.sessions[sessionID] = &session{info: SessionInfo{ID: sessionID, OwnerID: "alice", Root: root, Agent: "codex", State: "interrupted", HooksActive: true}, subs: make(map[chan Frame]struct{})}
	if _, err := a.chatHistory().append(sessionID, "assistant", "history while the PC is off", "source-1"); err != nil {
		t.Fatal(err)
	}
	handler := a.mobileHandler()
	sessions := mobileTestRequest(handler, credential, http.MethodGet, "/api/v1/sessions?hostId=host", "")
	if sessions.Code != http.StatusOK || !strings.Contains(sessions.Body.String(), `"chatAvailable":true`) || strings.Contains(sessions.Body.String(), root) {
		t.Fatalf("session capability response = %d %s", sessions.Code, sessions.Body.String())
	}
	chat := mobileTestRequest(handler, credential, http.MethodGet, "/api/v1/chat?hostId=host&sessionId="+sessionID, "")
	if chat.Code != http.StatusOK || !strings.Contains(chat.Body.String(), "history while the PC is off") || strings.Contains(chat.Body.String(), root) || strings.Contains(chat.Body.String(), "sourceId") {
		t.Fatalf("chat response = %d %s", chat.Code, chat.Body.String())
	}
	for _, path := range []string{"/api/v1/chat?hostId=other&sessionId=" + sessionID, "/api/v1/chat?hostId=host&sessionId=bad"} {
		if denied := mobileTestRequest(handler, credential, http.MethodGet, path, ""); denied.Code == http.StatusOK || strings.Contains(denied.Body.String(), "history while the PC is off") {
			t.Fatalf("unauthorized chat request %s: %d %s", path, denied.Code, denied.Body.String())
		}
	}
}

func TestMobileAdministratorCannotReadForeignChatHistory(t *testing.T) {
	a, _, root := accessFixture(t)
	a.mobile = newMobileHostState()
	const sessionID = "abcdef0123456789abcdef0123456789"
	credential := strings.Repeat("b", 64)
	project := mobileHostProject{ID: "project", Name: "Project", Root: root}
	a.mobile.file = mobileHostFile{
		Version: 1, GatewayID: "gateway", HostID: "host", HostName: "Linux",
		Projects: []mobileHostProject{project},
		Devices:  []mobileHostDevice{{ID: "device", OwnerID: "admin", Projects: []mobileHostProject{project}}},
	}
	a.mobile.credentials[tokenHash(credential)] = mobileHostCredential{DeviceID: "device", ExpiresAt: time.Now().Add(time.Minute)}
	a.sessions[sessionID] = &session{info: SessionInfo{ID: sessionID, OwnerID: "alice", Root: root, Agent: "codex", State: "interrupted", HooksActive: true}, subs: make(map[chan Frame]struct{})}
	if _, err := a.chatHistory().append(sessionID, "assistant", "foreign private transcript", "source-1"); err != nil {
		t.Fatal(err)
	}
	handler := a.mobileHandler()
	sessions := mobileTestRequest(handler, credential, http.MethodGet, "/api/v1/sessions?hostId=host", "")
	if sessions.Code != http.StatusOK || strings.Contains(sessions.Body.String(), `"chatAvailable":true`) {
		t.Fatalf("foreign session advertised Chat: %d %s", sessions.Code, sessions.Body.String())
	}
	chat := mobileTestRequest(handler, credential, http.MethodGet, "/api/v1/chat?hostId=host&sessionId="+sessionID, "")
	if chat.Code != http.StatusNotFound || strings.Contains(chat.Body.String(), "foreign private transcript") {
		t.Fatalf("admin received foreign transcript: %d %s", chat.Code, chat.Body.String())
	}
}
