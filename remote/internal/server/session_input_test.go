package server

import (
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
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
