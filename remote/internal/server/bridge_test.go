package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/crow-harness/remote/internal/bridge"
)

func helloFixture(t *testing.T) (*App, *http.ServeMux, string, *os.File) {
	t.Helper()
	mailbox, err := bridge.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Close(); w.Close() })
	id := strings.Repeat("a", 32)
	a := &App{dir: t.TempDir(), token: "test-only", bridge: mailbox, sessions: map[string]*session{
		id: {pty: w, info: SessionInfo{ID: id, Root: "/empty-probe", Agent: "claude", Mode: "normal", State: "running", AgentState: "waiting", HooksActive: true}, subs: make(map[chan Frame]struct{})},
	}}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/bridge/hello", a.handleBridgeHello)
	mux.HandleFunc("GET /api/bridge/tasks/{id}", a.handleBridgeTask)
	mux.HandleFunc("POST /api/events", a.handleEvents)
	return a, mux, id, r
}

func bridgeRequest(a *App, mux *http.ServeMux, method, path, body, token string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	a.auth(mux).ServeHTTP(w, r)
	return w
}

func TestBridgeRuntimeHelloHookCorrelation(t *testing.T) {
	a, mux, sessionID, reader := helloFixture(t)
	id := strings.Repeat("b", 32)
	body := `{"taskId":"` + id + `","sessionId":"` + sessionID + `","root":"/empty-probe","message":"Hola"}`
	if w := bridgeRequest(a, mux, "POST", "/api/bridge/hello", body, "wrong"); w.Code != http.StatusUnauthorized {
		t.Fatal(w.Code)
	}
	w := bridgeRequest(a, mux, "POST", "/api/bridge/hello", body, a.token)
	if w.Code != http.StatusAccepted {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	buf := make([]byte, 4096)
	n, err := reader.Read(buf)
	if err != nil || !strings.Contains(string(buf[:n]), "Hola [crow-task:"+id+"]") {
		t.Fatalf("prompt: %s %v", buf[:n], err)
	}
	// A retry returns the record even though the terminal is now working.
	if w = bridgeRequest(a, mux, "POST", "/api/bridge/hello", body, a.token); w.Code != http.StatusOK {
		t.Fatalf("retry %d", w.Code)
	}
	for _, message := range []string{"unrelated private response", "Hola [crow-task:" + id + "]"} {
		payload, _ := json.Marshal(map[string]string{"sessionId": sessionID, "kind": "turn-complete", "message": message})
		if w = bridgeRequest(a, mux, "POST", "/api/events", string(payload), a.token); w.Code != http.StatusAccepted {
			t.Fatalf("hook %d %s", w.Code, w.Body)
		}
	}
	w = bridgeRequest(a, mux, "GET", "/api/bridge/tasks/"+id, "", a.token)
	var task bridge.Task
	if err = json.Unmarshal(w.Body.Bytes(), &task); err != nil || task.State != "completed" || task.Result != "Hola" {
		t.Fatalf("%s %v", w.Body, err)
	}
	// Deleted/exited sessions do not destroy the correlated result.
	delete(a.sessions, sessionID)
	if w = bridgeRequest(a, mux, "POST", "/api/bridge/hello", body, a.token); w.Code != http.StatusOK {
		t.Fatalf("final replay %d", w.Code)
	}
}

func TestBridgeRuntimeRejectsUnapprovedTerminalStatesAndFreeText(t *testing.T) {
	for _, kind := range []string{"bypass", "busy", "draft", "subagent", "hooks-off", "wrong-root", "shell", "sleeping", "deleting", "free-text", "extra-field"} {
		t.Run(kind, func(t *testing.T) {
			a, mux, sessionID, reader := helloFixture(t)
			go io.Copy(io.Discard, reader)
			s := a.sessions[sessionID]
			root, message, extra := "/empty-probe", "Hola", ""
			switch kind {
			case "bypass":
				s.info.Mode = "bypass"
			case "busy":
				s.info.AgentState = "working"
			case "draft":
				if err := s.write([]byte("unsubmitted user draft")); err != nil {
					t.Fatal(err)
				}
			case "subagent":
				s.activeSubagents = map[string]struct{}{"child": {}}
			case "hooks-off":
				s.info.HooksActive = false
			case "wrong-root":
				root = "/other"
			case "shell":
				s.info.Agent = "shell"
			case "sleeping":
				s.info.State = "sleeping"
			case "deleting":
				s.deleting = true
			case "free-text":
				message = "execute deployment"
			case "extra-field":
				extra = `,"command":"anything"`
			}
			body := `{"taskId":"` + strings.Repeat("b", 32) + `","sessionId":"` + sessionID + `","root":"` + root + `","message":"` + message + `"` + extra + `}`
			w := bridgeRequest(a, mux, "POST", "/api/bridge/hello", body, a.token)
			if w.Code != http.StatusBadRequest && w.Code != http.StatusConflict {
				t.Fatalf("%d %s", w.Code, w.Body)
			}
		})
	}
}
