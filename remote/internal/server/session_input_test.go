package server

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestConfirmedSessionInputWritesBeforeAcknowledgingAndReportsFailure(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	s := &session{info: SessionInfo{ID: "one", State: "running"}, pty: writer, subs: make(map[chan Frame]struct{})}
	a := &App{sessions: map[string]*session{"one": s}}
	request := func(body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/api/sessions/one/input", strings.NewReader(body))
		r.SetPathValue("id", "one")
		w := httptest.NewRecorder()
		a.handleSessionInput(w, r)
		return w
	}
	if w := request(`{"data":"aGkN"}`); w.Code != http.StatusOK {
		t.Fatalf("write=%d %s", w.Code, w.Body)
	}
	data := make([]byte, 3)
	if _, err := io.ReadFull(reader, data); err != nil || string(data) != "hi\r" {
		t.Fatalf("input=%q err=%v", data, err)
	}
	for _, body := range []string{`{"data":"@@@"}`, `{"data":""}`, `{"data":"` + base64.StdEncoding.EncodeToString(make([]byte, 2049)) + `"}`} {
		if w := request(body); w.Code != http.StatusBadRequest {
			t.Fatalf("invalid input accepted: %d", w.Code)
		}
	}
	writer.Close()
	if w := request(`{"data":"aGkN"}`); w.Code != http.StatusConflict {
		t.Fatalf("failed PTY write incorrectly acknowledged: %d", w.Code)
	}
}

func TestStructuredChatPasteRejectsControlsAndFramesTextSeparatelyFromSubmit(t *testing.T) {
	got, err := structuredChatInput("hello 🙂")
	if err != nil || string(got.paste) != "\x1b[200~hello 🙂\x1b[201~" || string(got.submit) != "\r" {
		t.Fatalf("structured input = %#v, %v", got, err)
	}
	for _, value := range []string{"", "bad\x1b[31m", "nul\x00", "del\x7f"} {
		if _, err := structuredChatInput(value); err == nil {
			t.Errorf("accepted unsafe/empty text %q", value)
		}
	}
	if got, err := structuredChatInput("line one\nline two"); err != nil || !strings.Contains(string(got.paste), "line one\nline two") {
		t.Fatalf("explicit newline not preserved: %q, %v", got.paste, err)
	}
}

func TestBracketedPasteNegotiationAcrossOutputChunks(t *testing.T) {
	s := &session{info: SessionInfo{State: "running"}, subs: make(map[chan Frame]struct{})}
	s.output([]byte("\x1b[?20"))
	s.output([]byte("04h"))
	if !s.bracketedPaste {
		t.Fatal("split DECSET 2004 enable was not retained")
	}
	s.output([]byte("\x1b[?2004l"))
	if s.bracketedPaste {
		t.Fatal("DECSET 2004 disable was ignored")
	}
}

func TestChatSubmitWritesDurableIdempotentPasteAndOneEnter(t *testing.T) {
	a, _, _ := accessFixture(t)
	const sessionID = "11111111111141118111111111111111"
	s := a.sessions["one"]
	s.info.ID = sessionID
	a.sessions[sessionID] = s
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	s.pty = writer
	s.info.State = "running"
	s.info.Mode = "normal"
	s.info.Agent = "claude"
	s.info.AgentState = "waiting"
	s.info.HooksActive = true
	s.bracketedPaste = true
	a.chatSubmits = make(map[string]chatSubmitRecord)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/sessions/{id}/chat/submit", a.handleChatSubmit)
	mux.HandleFunc("GET /api/sessions/{id}/chat/submit", a.handleChatSubmitStatus)
	h := a.auth(mux)
	body := `{"requestId":"e6c53571-f2d0-4eeb-9841-685c02a89a90","text":"hello 🙂"}`
	w := accessRequest(h, "alice-token", http.MethodPost, "/api/sessions/"+sessionID+"/chat/submit", body)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"status":"written"`) {
		t.Fatalf("submit=%d %s", w.Code, w.Body)
	}
	data := make([]byte, len("\x1b[200~hello 🙂\x1b[201~\r"))
	if _, err := io.ReadFull(reader, data); err != nil || string(data) != "\x1b[200~hello 🙂\x1b[201~\r" {
		t.Fatalf("pty bytes=%q err=%v", data, err)
	}
	if w := accessRequest(h, "alice-token", http.MethodPost, "/api/sessions/"+sessionID+"/chat/submit", body); w.Code != http.StatusOK {
		t.Fatalf("duplicate=%d %s", w.Code, w.Body)
	}
	conflict := strings.Replace(body, "hello 🙂", "different", 1)
	if w := accessRequest(h, "alice-token", http.MethodPost, "/api/sessions/"+sessionID+"/chat/submit", conflict); w.Code != http.StatusConflict {
		t.Fatalf("ID reuse=%d %s", w.Code, w.Body)
	}
	status := accessRequest(h, "alice-token", http.MethodGet, "/api/sessions/"+sessionID+"/chat/submit?requestId=e6c53571-f2d0-4eeb-9841-685c02a89a90", "")
	if status.Code != http.StatusOK || !strings.Contains(status.Body.String(), `"status":"written"`) {
		t.Fatalf("status=%d %s", status.Code, status.Body)
	}
	baseline := a.chatSubmits["e6c53571-f2d0-4eeb-9841-685c02a89a90"].BaselineSeq
	a.markChatSubmitHook(sessionID, "hello 🙂", baseline)
	status = accessRequest(h, "alice-token", http.MethodGet, "/api/sessions/"+sessionID+"/chat/submit?requestId=e6c53571-f2d0-4eeb-9841-685c02a89a90", "")
	if !strings.Contains(status.Body.String(), `"status":"written"`) {
		t.Fatalf("pre-boundary hook must not confirm: %s", status.Body)
	}
	a.markChatSubmitHook(sessionID, "hello 🙂", baseline+1)
	status = accessRequest(h, "alice-token", http.MethodGet, "/api/sessions/"+sessionID+"/chat/submit?requestId=e6c53571-f2d0-4eeb-9841-685c02a89a90", "")
	if status.Code != http.StatusOK || !strings.Contains(status.Body.String(), `"status":"accepted"`) {
		t.Fatalf("hook-confirmed status=%d %s", status.Code, status.Body)
	}
}

func TestChatSubmitAcceptsBypassModeAndKeepsEveryOtherGuard(t *testing.T) {
	a, _, _ := accessFixture(t)
	const sessionID = "11111111111141118111111111111111"
	const requestID = "e6c53571-f2d0-4eeb-9841-685c02a89a90"
	s := a.sessions["one"]
	s.info.ID = sessionID
	a.sessions[sessionID] = s
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	s.pty = writer
	s.info.State = "running"
	s.info.Mode = "bypass"
	s.info.Agent = "claude"
	s.info.AgentState = "waiting"
	s.info.HooksActive = true
	s.bracketedPaste = true
	a.chatSubmits = make(map[string]chatSubmitRecord)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/sessions/{id}/chat/submit", a.handleChatSubmit)
	h := a.auth(mux)
	body := `{"requestId":"` + requestID + `","text":"bypass hello"}`
	if w := accessRequest(h, "alice-token", http.MethodPost, "/api/sessions/"+sessionID+"/chat/submit", body); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"status":"written"`) {
		t.Fatalf("bypass submit=%d %s", w.Code, w.Body)
	}
	data := make([]byte, len("\x1b[200~bypass hello\x1b[201~\r"))
	if _, err := io.ReadFull(reader, data); err != nil || string(data) != "\x1b[200~bypass hello\x1b[201~\r" {
		t.Fatalf("bypass pty bytes=%q err=%v", data, err)
	}
	// A bypass terminal without active hooks is still rejected.
	s.info.HooksActive = false
	a.chatSubmits = make(map[string]chatSubmitRecord)
	noHooks := accessRequest(h, "alice-token", http.MethodPost, "/api/sessions/"+sessionID+"/chat/submit", `{"requestId":"3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c","text":"no hooks"}`)
	if noHooks.Code != http.StatusOK || !strings.Contains(noHooks.Body.String(), `"status":"rejected"`) {
		t.Fatalf("bypass without hooks=%d %s", noHooks.Code, noHooks.Body)
	}
	// An unknown permission mode never reaches the PTY either.
	s.info.HooksActive = true
	s.info.Mode = "shell"
	a.chatSubmits = make(map[string]chatSubmitRecord)
	unknown := accessRequest(h, "alice-token", http.MethodPost, "/api/sessions/"+sessionID+"/chat/submit", `{"requestId":"1c867dac-22c7-4a96-a8ce-ce8970712e3f","text":"unknown mode"}`)
	if unknown.Code != http.StatusOK || !strings.Contains(unknown.Body.String(), `"status":"rejected"`) {
		t.Fatalf("unknown mode=%d %s", unknown.Code, unknown.Body)
	}
	if a.chatSubmits["1c867dac-22c7-4a96-a8ce-ce8970712e3f"].Status != "rejected" {
		t.Fatal("unknown permission mode was not rejected durably")
	}
}

func TestChatSubmitRejectsWhenPasteModeIsUnknownAndRecoversPendingAsUncertain(t *testing.T) {
	a, _, _ := accessFixture(t)
	const sessionID = "11111111111141118111111111111111"
	s := a.sessions["one"]
	s.info.ID = sessionID
	a.sessions[sessionID] = s
	_, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	s.pty = writer
	s.info.State = "running"
	s.info.Mode = "normal"
	s.info.Agent = "claude"
	s.info.AgentState = "waiting"
	s.info.HooksActive = true
	a.chatSubmits = make(map[string]chatSubmitRecord)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/sessions/{id}/chat/submit", a.handleChatSubmit)
	w := accessRequest(a.auth(mux), "alice-token", http.MethodPost, "/api/sessions/"+sessionID+"/chat/submit", `{"requestId":"e6c53571-f2d0-4eeb-9841-685c02a89a90","text":"hello"}`)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"status":"rejected"`) {
		t.Fatalf("unknown paste mode=%d %s", w.Code, w.Body)
	}
	restarted := &App{dir: a.dir, chatSubmits: make(map[string]chatSubmitRecord)}
	if err := restarted.loadChatSubmits(); err != nil {
		t.Fatalf("rejected tombstone did not survive restart: %v", err)
	}
	if restarted.chatSubmits["e6c53571-f2d0-4eeb-9841-685c02a89a90"].Status != "rejected" {
		t.Fatal("rejected operation changed during restart")
	}
	row := chatSubmitRecord{OperationID: "1c867dac-22c7-4a96-a8ce-ce8970712e3f", RequestID: "1c867dac-22c7-4a96-a8ce-ce8970712e3f", SessionID: "one", Status: "pending", CreatedAt: time.Now()}
	restarted.chatSubmits[row.RequestID] = row
	if err := restarted.saveChatSubmitsLocked(); err != nil {
		t.Fatal(err)
	}
	recovered := &App{dir: a.dir, chatSubmits: make(map[string]chatSubmitRecord)}
	if err := recovered.loadChatSubmits(); err != nil {
		t.Fatal(err)
	}
	if recovered.chatSubmits[row.RequestID].Status != "uncertain" {
		t.Fatal("pending intent became replayable after restart")
	}
}

func TestDeletedSessionChatSubmitTombstonesCanBePruned(t *testing.T) {
	a, _, _ := accessFixture(t)
	a.chatSubmits = map[string]chatSubmitRecord{
		"e6c53571-f2d0-4eeb-9841-685c02a89a90": {OperationID: "e6c53571-f2d0-4eeb-9841-685c02a89a90", RequestID: "e6c53571-f2d0-4eeb-9841-685c02a89a90", SessionID: "deleted-session", Status: "rejected"},
		"1c867dac-22c7-4a96-a8ce-ce8970712e3f": {OperationID: "1c867dac-22c7-4a96-a8ce-ce8970712e3f", RequestID: "1c867dac-22c7-4a96-a8ce-ce8970712e3f", SessionID: "live-session", Status: "written"},
	}
	if err := a.forgetDeletedChatSubmits("deleted-session"); err != nil {
		t.Fatal(err)
	}
	if len(a.chatSubmits) != 1 || a.chatSubmits["1c867dac-22c7-4a96-a8ce-ce8970712e3f"].SessionID != "live-session" {
		t.Fatalf("unexpected remaining ledger: %#v", a.chatSubmits)
	}
}

// A user hook must bind to exactly one requestId even when the same prompt text
// was submitted twice, so two requests can never share a sequence or an
// assistant turn.
func TestChatSubmitHookBindsOneRequestPerSequenceEvenWithDuplicateText(t *testing.T) {
	a, _, _ := accessFixture(t)
	const sessionID = "11111111111141118111111111111111"
	text := "mismo texto"
	hash := sha256.Sum256([]byte(text))
	fingerprint := hex.EncodeToString(hash[:])
	first := "e6c53571-f2d0-4eeb-9841-685c02a89a90"
	second := "1c867dac-22c7-4a96-a8ce-ce8970712e3f"
	base := time.Now().UTC()
	a.chatSubmits = map[string]chatSubmitRecord{
		first:  {OperationID: first, RequestID: first, SessionID: sessionID, Fingerprint: fingerprint, Status: "written", BaselineSeq: 0, CreatedAt: base},
		second: {OperationID: second, RequestID: second, SessionID: sessionID, Fingerprint: fingerprint, Status: "written", BaselineSeq: 0, CreatedAt: base.Add(time.Second)},
	}
	a.markChatSubmitHook(sessionID, text, 1)
	if row := a.chatSubmits[first]; row.Status != "accepted" || row.UserSeq != 1 || !row.HookConfirmed {
		t.Fatalf("oldest duplicate not bound to the first hook: %+v", row)
	}
	if row := a.chatSubmits[second]; row.Status != "written" || row.UserSeq != 0 {
		t.Fatalf("first hook confirmed the second duplicate: %+v", row)
	}
	a.markChatSubmitHook(sessionID, text, 2)
	if row := a.chatSubmits[second]; row.Status != "accepted" || row.UserSeq != 2 {
		t.Fatalf("second duplicate not bound to its own hook: %+v", row)
	}
	if a.chatSubmits[first].UserSeq == a.chatSubmits[second].UserSeq {
		t.Fatal("duplicate submissions shared a hook sequence")
	}
}

// The status DTO must expose the authoritative baseline and hook sequence so a
// client correlates the assistant reply by sequence, not by prompt text.
func TestChatSubmitStatusExposesAuthoritativeSequences(t *testing.T) {
	a, _, _ := accessFixture(t)
	const sessionID = "11111111111141118111111111111111"
	const requestID = "e6c53571-f2d0-4eeb-9841-685c02a89a90"
	s := a.sessions["one"]
	s.info.ID = sessionID
	a.sessions[sessionID] = s
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	s.pty = writer
	s.info.State = "running"
	s.info.Mode = "normal"
	s.info.Agent = "claude"
	s.info.AgentState = "waiting"
	s.info.HooksActive = true
	s.bracketedPaste = true
	a.chatSubmits = make(map[string]chatSubmitRecord)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/sessions/{id}/chat/submit", a.handleChatSubmit)
	mux.HandleFunc("GET /api/sessions/{id}/chat/submit", a.handleChatSubmitStatus)
	h := a.auth(mux)
	body := `{"requestId":"` + requestID + `","text":"hello"}`
	if w := accessRequest(h, "alice-token", http.MethodPost, "/api/sessions/"+sessionID+"/chat/submit", body); w.Code != http.StatusOK {
		t.Fatalf("submit=%d %s", w.Code, w.Body)
	}
	baseline := a.chatSubmits[requestID].BaselineSeq
	a.markChatSubmitHook(sessionID, "hello", baseline+1)
	status := accessRequest(h, "alice-token", http.MethodGet, "/api/sessions/"+sessionID+"/chat/submit?requestId="+requestID, "")
	if status.Code != http.StatusOK {
		t.Fatalf("status=%d %s", status.Code, status.Body)
	}
	var dto chatSubmitDTO
	if err := json.Unmarshal(status.Body.Bytes(), &dto); err != nil {
		t.Fatal(err)
	}
	if dto.Status != "accepted" || dto.BaselineSeq != baseline || dto.UserSeq != baseline+1 {
		t.Fatalf("authoritative sequences missing from status: %+v", dto)
	}
	// A request the ledger never saw reports unknown with zero boundaries.
	unknown := accessRequest(h, "alice-token", http.MethodGet, "/api/sessions/"+sessionID+"/chat/submit?requestId=1c867dac-22c7-4a96-a8ce-ce8970712e3f", "")
	var unknownDTO chatSubmitDTO
	if err := json.Unmarshal(unknown.Body.Bytes(), &unknownDTO); err != nil {
		t.Fatal(err)
	}
	if unknownDTO.Status != "unknown" || unknownDTO.UserSeq != 0 {
		t.Fatalf("unknown request did not report unknown: %+v", unknownDTO)
	}
}

// A confirmed hook sequence must stay above the baseline it was captured for;
// a corrupt ledger that breaks that invariant fails closed on reload.
func TestChatSubmitLedgerRejectsMalformedHookSequence(t *testing.T) {
	a, _, _ := accessFixture(t)
	const requestID = "e6c53571-f2d0-4eeb-9841-685c02a89a90"
	a.chatSubmits = map[string]chatSubmitRecord{
		requestID: {OperationID: requestID, RequestID: requestID, SessionID: "one", Status: "accepted", HookConfirmed: true, BaselineSeq: 5, UserSeq: 5, CreatedAt: time.Now().UTC()},
	}
	if err := a.saveChatSubmitsLocked(); err != nil {
		t.Fatal(err)
	}
	if err := (&App{dir: a.dir, chatSubmits: map[string]chatSubmitRecord{}}).loadChatSubmits(); err == nil {
		t.Fatal("hook sequence at or below the baseline was accepted")
	}
	a.chatSubmits[requestID] = chatSubmitRecord{OperationID: requestID, RequestID: requestID, SessionID: "one", Status: "accepted", HookConfirmed: true, BaselineSeq: 5, UserSeq: 6, CreatedAt: time.Now().UTC()}
	if err := a.saveChatSubmitsLocked(); err != nil {
		t.Fatal(err)
	}
	valid := &App{dir: a.dir, chatSubmits: map[string]chatSubmitRecord{}}
	if err := valid.loadChatSubmits(); err != nil {
		t.Fatalf("valid hook sequence rejected: %v", err)
	}
	if valid.chatSubmits[requestID].UserSeq != 6 {
		t.Fatalf("hook sequence lost on reload: %+v", valid.chatSubmits[requestID])
	}
}

func TestConfirmedSessionMutationsKeepIndividualAccessChecks(t *testing.T) {
	a, _, _ := accessFixture(t)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/sessions/{id}/input", a.handleSessionInput)
	mux.HandleFunc("POST /api/sessions/{id}/resize", a.handleSessionResize)
	h := a.auth(mux)
	for _, route := range []string{"input", "resize"} {
		if w := accessRequest(h, "bob-token", "POST", "/api/sessions/one/"+route, `{"data":"aGkN","cols":80,"rows":24}`); w.Code != http.StatusNotFound {
			t.Fatalf("foreign %s=%d %s", route, w.Code, w.Body)
		}
		if w := accessRequest(h, "alice-token", "POST", "/api/sessions/one/"+route, `{"data":"aGkN","cols":80,"rows":24}`); w.Code == http.StatusOK {
			t.Fatalf("missing PTY %s was acknowledged", route)
		}
	}
}
