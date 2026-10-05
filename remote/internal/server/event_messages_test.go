package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestEventMessagesAreOptInEphemeralAndBounded(t *testing.T) {
	const id = "0123456789abcdef0123456789abcdef"
	a := &App{dir: t.TempDir(), sessions: map[string]*session{
		id: {info: SessionInfo{ID: id, State: "running", HooksActive: true}, subs: make(map[chan Frame]struct{})},
	}}
	post := func(message string) {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"sessionId": id, "kind": "turn-complete", "message": message})
		w := httptest.NewRecorder()
		a.handleEvents(w, httptest.NewRequest(http.MethodPost, "/api/events", strings.NewReader(string(body))))
		if w.Code != http.StatusAccepted {
			t.Fatalf("POST status = %d", w.Code)
		}
	}
	get := func(query string) []map[string]any {
		t.Helper()
		w := httptest.NewRecorder()
		a.handleEvents(w, httptest.NewRequest(http.MethodGet, "/api/events"+query, nil))
		var items []map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &items); err != nil {
			t.Fatal(err)
		}
		return items
	}
	post("private-marker: ¿Me autorizás a continuar?")
	if _, ok := get("")[0]["message"]; ok {
		t.Fatal("default GET exposed text")
	}
	if got := get("?includeMessage=true")[0]["message"]; got != "private-marker: ¿Me autorizás a continuar?" {
		t.Fatalf("text = %v", got)
	}
	stored, _ := os.ReadFile(filepath.Join(a.dir, "events.jsonl"))
	if strings.Contains(string(stored), "private-marker") {
		t.Fatal("message persisted")
	}
	// After restart, only durable metadata remains, never raw assistant text.
	restarted := &App{dir: a.dir, sessions: a.sessions}
	if err := restarted.loadEvents(); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	restarted.handleEvents(w, httptest.NewRequest(http.MethodGet, "/api/events?includeMessage=true", nil))
	if strings.Contains(w.Body.String(), "private-marker") {
		t.Fatal("text recovered from disk")
	}
	post(strings.Repeat("á", maxEventMessageRunes+1))
	items := get("?includeMessage=true")
	if len([]rune(items[1]["message"].(string))) > maxEventMessageRunes || items[1]["messageTruncated"] != true {
		t.Fatal("oversized message not bounded/marked")
	}
	for i := 0; i < maxEventMessages; i++ {
		post("small message")
	}
	if len(a.eventMessages) > maxEventMessages {
		t.Fatal("cache grew unbounded")
	}
	if _, ok := get("?includeMessage=true")[0]["message"]; ok {
		t.Fatal("old message not evicted")
	}
	for key, value := range a.eventMessages {
		value.expiresAt = time.Now().Add(-time.Second)
		a.eventMessages[key] = value
	}
	items = get("?includeMessage=true")
	if _, ok := items[len(items)-1]["message"]; ok {
		t.Fatal("expired message exposed")
	}
	a.pruneEventMessagesLocked(time.Now())
	if len(a.eventMessages) != 0 {
		t.Fatal("expired messages not removed")
	}
}
