package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

func shellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'" }

func (a *App) loadHookSettings() error {
	data, err := os.ReadFile(filepath.Join(a.dir, "hooks.json"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	enabled := true
	if err == nil {
		var settings struct {
			Enabled bool `json:"enabled"`
		}
		if err := json.Unmarshal(data, &settings); err != nil {
			return err
		}
		enabled = settings.Enabled
	}
	if !enabled {
		if err := os.Remove(filepath.Join(a.dir, "notify-stop.sh")); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		a.hooksEnabled = false
		return nil
	}
	return a.installHook()
}

func (a *App) installHook() error {
	path := filepath.Join(a.dir, "notify-stop.sh")
	binaryPath := a.binaryPath
	if binaryPath == "" {
		var err error
		binaryPath, err = os.Executable()
		if err != nil {
			return fmt.Errorf("locate crowd hook executable: %w", err)
		}
	}
	script := "#!/bin/sh\n[ -n \"$CROW_SESSION_ID\" ] || exit 0\nexec " + shellQuote(binaryPath) + " hook-notify \"$@\"\n"
	if err := os.WriteFile(path, []byte(script), 0700); err != nil {
		return err
	}
	a.mu.Lock()
	a.hookPath = path
	a.hooksEnabled = true
	a.mu.Unlock()
	return nil
}

func (a *App) handleHookSettings(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		a.mu.RLock()
		enabled := a.hooksEnabled
		a.mu.RUnlock()
		jsonResponse(w, http.StatusOK, map[string]bool{"enabled": enabled})
		return
	}
	var body struct {
		Enabled bool `json:"enabled"`
	}
	if !requestJSON(w, r, &body) {
		return
	}
	if err := a.setHooksEnabled(body.Enabled); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	jsonResponse(w, http.StatusOK, map[string]bool{"enabled": body.Enabled})
}

func (a *App) setHooksEnabled(enabled bool) error {
	a.mu.RLock()
	current := a.hooksEnabled
	a.mu.RUnlock()
	if enabled == current {
		return nil
	}
	if enabled {
		if err := a.installHook(); err != nil {
			return err
		}
	} else {
		if err := os.Remove(filepath.Join(a.dir, "notify-stop.sh")); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		a.mu.Lock()
		a.hookPath = ""
		a.hooksEnabled = false
		for _, s := range a.sessions {
			s.mu.Lock()
			s.info.HooksActive = false
			if s.info.Agent != "shell" {
				s.info.AgentState = "unknown"
				s.rootAgentState = "unknown"
			}
			clear(s.activeSubagents)
			s.info.CacheExpiresAt = nil
			s.info.PromptCache = nil
			info := s.info
			s.broadcast(Frame{Type: "state", Info: &info})
			s.mu.Unlock()
		}
		a.mu.Unlock()
		_ = a.saveSessions()
	}
	data, _ := json.Marshal(map[string]bool{"enabled": enabled})
	path := filepath.Join(a.dir, "hooks.json")
	if err := os.WriteFile(path+".tmp", data, 0600); err != nil {
		return err
	}
	return os.Rename(path+".tmp", path)
}

func (a *App) loadEvents() error {
	path := filepath.Join(a.dir, "events.jsonl")
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	scan := bufio.NewScanner(f)
	for scan.Scan() {
		var event Event
		if json.Unmarshal(scan.Bytes(), &event) == nil {
			a.events = append(a.events, event)
		}
	}
	return scan.Err()
}

const maxEventMessages = 128
const maxEventMessageRunes = 12000
const eventMessageTTL = 10 * time.Minute

type eventMessage struct {
	text      string
	truncated bool
	expiresAt time.Time
}

// Messages exist only in a bounded RAM cache, never events.jsonl.
func (a *App) pruneEventMessagesLocked(now time.Time) {
	for id, message := range a.eventMessages {
		if !now.Before(message.expiresAt) {
			delete(a.eventMessages, id)
		}
	}
}

func boundedEventMessage(message string) (string, bool) {
	runes := []rune(message)
	if len(runes) <= maxEventMessageRunes {
		return message, false
	}
	return string(runes[:maxEventMessageRunes/2]) + string(runes[len(runes)-maxEventMessageRunes/2:]), true
}

func (a *App) addEvent(sessionID, kind string, attention bool, messages ...eventMessage) {
	id, err := randomID()
	if err != nil {
		return
	}
	a.mu.Lock()
	a.addEventLocked(id, sessionID, kind, attention, messages...)
	a.mu.Unlock()
	if kind == "process-exited" && a.bridge != nil {
		_ = a.bridge.Interrupt(sessionID)
	}
}

// addEventLocked appends an event while the caller holds App.mu. The caller
// must acquire App.mu before any session mutex to preserve the event-reader
// lock order (App.mu -> session.mu).
func (a *App) addEventLocked(id, sessionID, kind string, attention bool, messages ...eventMessage) {
	seq := uint64(1)
	if len(a.events) > 0 {
		seq = a.events[len(a.events)-1].Seq + 1
	}
	event := Event{ID: id, Seq: seq, SessionID: sessionID, Kind: kind, RequiresAttention: attention, At: time.Now().UTC()}
	a.events = append(a.events, event)
	if len(messages) > 0 && messages[0].text != "" {
		a.pruneEventMessagesLocked(time.Now())
		if a.eventMessages == nil {
			a.eventMessages = make(map[string]eventMessage)
		}
		for len(a.eventMessages) >= maxEventMessages {
			oldestID := ""
			var oldest time.Time
			for id, value := range a.eventMessages {
				if oldestID == "" || value.expiresAt.Before(oldest) {
					oldestID, oldest = id, value.expiresAt
				}
			}
			delete(a.eventMessages, oldestID)
		}
		message := messages[0]
		message.expiresAt = event.At.Add(eventMessageTTL)
		a.eventMessages[id] = message
	}
	encoded, _ := json.Marshal(event)
	f, err := os.OpenFile(filepath.Join(a.dir, "events.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err == nil {
		_, _ = f.Write(append(encoded, '\n'))
		_ = f.Close()
	}
}

var errChatSessionDeleting = errors.New("chat session is being deleted")

// captureChatMessage serializes transcript append with session deletion. If
// deletion has begun, no late hook may recreate the file after it is removed.
func (a *App) captureChatMessage(s *session, role, content, sourceID string, truncated bool) (ChatMessage, error) {
	if s == nil {
		return ChatMessage{}, errors.New("chat session unavailable")
	}
	s.mu.Lock()
	if s.deleting {
		s.mu.Unlock()
		return ChatMessage{}, errChatSessionDeleting
	}
	sessionID := s.info.ID
	store := a.chatHistory()
	message, err := store.appendWithTruncation(sessionID, role, content, sourceID, truncated)
	notifyLimit := errors.Is(err, errChatStoreLimit) && store.markLimitNotified(sessionID)
	s.mu.Unlock()
	if notifyLimit {
		a.addEventIfSessionActive(s, sessionID, "chat-history-limit", true, eventMessage{text: "El historial del chat alcanzó su límite. Las terminales siguen funcionando, pero las respuestas nuevas ya no se guardan en Chat."})
	}
	return message, err
}

func (a *App) addEventIfSessionActive(s *session, sessionID, kind string, attention bool, messages ...eventMessage) {
	if s == nil {
		return
	}
	id, err := randomID()
	if err != nil {
		return
	}
	// Event listing holds App.mu while taking a session snapshot. Use the same
	// lock order here so a concurrent hook and GET /api/events cannot deadlock.
	a.mu.Lock()
	s.mu.Lock()
	if s.deleting {
		s.mu.Unlock()
		a.mu.Unlock()
		return
	}
	a.addEventLocked(id, sessionID, kind, attention, messages...)
	s.mu.Unlock()
	a.mu.Unlock()
	if kind == "process-exited" && a.bridge != nil {
		_ = a.bridge.Interrupt(sessionID)
	}
}

func (a *App) handleEvents(w http.ResponseWriter, r *http.Request) {
	if r.Context().Value(hookContextKey{}) == nil && !a.principalCurrent(requestPrincipal(r)) {
		http.Error(w, "access revoked", 401)
		return
	}
	if r.Method == http.MethodGet {
		after, _ := strconv.ParseUint(r.URL.Query().Get("after"), 10, 64)
		a.mu.RLock()
		type eventResponse struct {
			Event
			Message          string `json:"message,omitempty"`
			MessageTruncated bool   `json:"messageTruncated,omitempty"`
		}
		items := make([]eventResponse, 0)
		for _, event := range a.events {
			if event.Seq > after && a.sessions[event.SessionID] != nil && a.visible(requestPrincipal(r), a.sessions[event.SessionID].snapshot()) {
				item := eventResponse{Event: event}
				if message, ok := a.eventMessages[event.ID]; r.URL.Query().Get("includeMessage") == "true" && ok && time.Now().Before(message.expiresAt) {
					item.Message, item.MessageTruncated = message.text, message.truncated
				}
				items = append(items, item)
			}
		}
		a.mu.RUnlock()
		jsonResponse(w, http.StatusOK, items)
		return
	}
	var body struct {
		SessionID        string `json:"sessionId"`
		Kind             string `json:"kind"`
		Message          string `json:"message"`
		ChatMessage      string `json:"chatMessage"`
		UserPrompt       string `json:"userPrompt"`
		SourceID         string `json:"sourceId"`
		ProviderThreadID string `json:"providerThreadId"`
		AgentID          string `json:"agentId"`
		Agent            string `json:"agent"`
		MessageTruncated bool   `json:"messageTruncated"`
		ChatTruncated    bool   `json:"chatTruncated"`
		PromptTruncated  bool   `json:"promptTruncated"`
	}
	if !requestJSON(w, r, &body) {
		return
	}
	s := a.session(body.SessionID)
	if s == nil || (body.Kind != "turn-complete" && body.Kind != "working" && body.Kind != "user-prompt" && body.Kind != "session-start" && body.Kind != "subagent-start" && body.Kind != "subagent-stop" && body.Kind != "agent-start" && body.Kind != "agent-stop") {
		http.Error(w, "invalid event", http.StatusBadRequest)
		return
	}
	if (body.Kind == "agent-start" || body.Kind == "agent-stop") && body.Agent != "claude" {
		http.Error(w, "invalid managed shell agent", http.StatusBadRequest)
		return
	}
	if body.Kind == "user-prompt" || body.Kind == "session-start" {
		info := s.snapshot()
		if (body.Agent != "claude" && body.Agent != "codex") || body.Agent != info.Agent {
			http.Error(w, "invalid managed agent prompt", http.StatusBadRequest)
			return
		}
	}
	if (body.Kind == "subagent-start" || body.Kind == "subagent-stop") && strings.TrimSpace(body.AgentID) == "" {
		http.Error(w, "missing subagent id", http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	deleting := s.deleting
	active := s.info.HooksActive
	s.mu.Unlock()
	if deleting || !active {
		http.Error(w, "session is being deleted", http.StatusConflict)
		return
	}
	if body.Kind == "agent-start" || body.Kind == "agent-stop" {
		s.mu.Lock()
		if s.info.Agent != "shell" && s.info.Agent != "claude" {
			s.mu.Unlock()
			http.Error(w, "shell agent tracking unavailable", http.StatusConflict)
			return
		}
		if body.Kind == "agent-start" {
			s.info.Agent = "claude"
			s.rootAgentState = "waiting"
			s.info.AgentState = "waiting"
		} else {
			s.info.Agent = "shell"
			s.rootAgentState = "unknown"
			s.info.AgentState = "unknown"
			clear(s.activeSubagents)
		}
		s.info.UpdatedAt = time.Now().UTC()
		s.lastActivity = s.info.UpdatedAt
		info := s.info
		s.broadcast(Frame{Type: "state", Info: &info})
		s.mu.Unlock()
		_ = a.saveSessions()
	} else if body.Kind == "working" {
		a.markAgentState(body.SessionID, "working")
	} else if body.Kind == "session-start" {
		if body.Agent != "claude" {
			http.Error(w, "unsupported session start", http.StatusBadRequest)
			return
		}
		if body.ChatMessage != "" && body.SourceID != "" {
			if _, err := a.captureChatMessage(s, "assistant", body.ChatMessage, chatSourceID(body.SessionID, "turn-complete", body.SourceID), body.ChatTruncated); err != nil {
				log.Printf("crow resumed chat capture failed for session %s: %v", body.SessionID, err)
				http.Error(w, "chat history unavailable", http.StatusServiceUnavailable)
				return
			}
		}
		a.markAgentState(body.SessionID, "waiting")
	} else if body.Kind == "user-prompt" {
		sourceID := body.SourceID
		if sourceID == "" {
			generatedID, err := randomID()
			if err != nil {
				http.Error(w, "chat event unavailable", http.StatusServiceUnavailable)
				return
			}
			sourceID = generatedID
		}
		content := body.ChatMessage
		if content == "" {
			content = body.Message
		}
		if content != "" {
			kind := body.Kind
			if body.Agent == "codex" {
				kind = "codex-user"
			}
			if _, err := a.captureChatMessage(s, "user", content, chatSourceID(body.SessionID, kind, sourceID), body.ChatTruncated); err != nil {
				log.Printf("crow chat capture failed for session %s: %v", body.SessionID, err)
			}
		}
		a.markAgentState(body.SessionID, "working")
	} else if body.Kind == "subagent-start" {
		a.markSubagentState(body.SessionID, body.AgentID, true)
	} else if body.Kind == "subagent-stop" {
		a.markSubagentState(body.SessionID, body.AgentID, false)
	} else {
		info := s.snapshot()
		chatSourceIDForTurn := func(kind string) string {
			if info.Agent == "codex" && body.SourceID != "" {
				if kind == "codex-user" {
					return chatSourceID(body.SessionID, kind, body.SourceID)
				}
				if !validProviderThreadID(body.ProviderThreadID) {
					return ""
				}
				return chatSourceID(body.SessionID, kind, body.ProviderThreadID+"\x00"+body.SourceID)
			}
			sourceID := body.SourceID
			if sourceID == "" {
				generatedID, err := randomID()
				if err != nil {
					return ""
				}
				sourceID = generatedID
			}
			return chatSourceID(body.SessionID, kind, sourceID)
		}
		chatMessage := body.ChatMessage
		if chatMessage == "" {
			chatMessage = body.Message
		}
		if info.Agent == "claude" && chatMessage != "" {
			sourceID := chatSourceIDForTurn(body.Kind)
			if sourceID != "" {
				if _, err := a.captureChatMessage(s, "assistant", chatMessage, sourceID, body.ChatTruncated); err != nil {
					log.Printf("crow chat capture failed for session %s: %v", body.SessionID, err)
				}
			}
		} else if info.Agent == "codex" && body.Agent == "codex" && body.SourceID != "" {
			if body.UserPrompt != "" {
				if sourceID := chatSourceIDForTurn("codex-user"); sourceID != "" {
					if _, err := a.captureChatMessage(s, "user", body.UserPrompt, sourceID, body.PromptTruncated); err != nil {
						log.Printf("crow chat capture failed for session %s: %v", body.SessionID, err)
					}
				}
			}
			if chatMessage != "" {
				if _, err := a.captureChatMessage(s, "assistant", chatMessage, chatSourceIDForTurn("codex-assistant"), body.ChatTruncated); err != nil {
					log.Printf("crow chat capture failed for session %s: %v", body.SessionID, err)
				}
			}
		}
		a.markAgentState(body.SessionID, "completed")
		if a.bridge != nil {
			if err := a.bridge.Complete(body.SessionID, body.Message); err != nil {
				http.Error(w, "bridge completion persistence failed", http.StatusServiceUnavailable)
				return
			}
		}
		text, truncated := boundedEventMessage(body.Message)
		a.addEventIfSessionActive(s, body.SessionID, body.Kind, requiresAttention(body.Message), eventMessage{text: text, truncated: truncated || body.MessageTruncated})
	}
	jsonResponse(w, http.StatusAccepted, map[string]bool{"ok": true})
}

const maxHookPayload = 4 * 1024 * 1024

// RunHookNotify is invoked by managed agent hooks. Hook payloads are read from
// stdin; an optional argument form is retained for diagnostics.
func RunHookNotify(args []string) error {
	if len(args) == 0 || (args[0] != "working" && args[0] != "user-prompt" && args[0] != "turn-complete" && args[0] != "session-start" && args[0] != "subagent-start" && args[0] != "subagent-stop" && args[0] != "agent-start" && args[0] != "agent-stop") {
		return errors.New("usage: crowd hook-notify <working|user-prompt|turn-complete|session-start|subagent-start|subagent-stop|agent-start|agent-stop> [agent-payload]")
	}
	kind := args[0]
	if os.Getenv("CROW_SESSION_ID") == "" {
		return nil
	}

	var message, userPrompt, agentID, sourceID, providerThreadID string
	var messageTruncated bool
	if kind == "user-prompt" || kind == "turn-complete" || kind == "session-start" || kind == "subagent-start" || kind == "subagent-stop" {
		var payload []byte
		if kind == "turn-complete" || kind == "session-start" || kind == "user-prompt" {
			for _, arg := range args[1:] {
				if json.Valid([]byte(arg)) {
					payload = []byte(arg)
					break
				}
			}
		}
		if len(payload) == 0 {
			read, err := io.ReadAll(io.LimitReader(os.Stdin, maxHookPayload))
			if err != nil {
				return err
			}
			payload = read
		}
		if kind == "turn-complete" || kind == "session-start" {
			message = hookAssistantMessage(payload)
			sourceID = hookEventID(payload)
			if os.Getenv("CROW_AGENT") == "claude" {
				message, sourceID = claudeHookMessage(payload)
			}
			if os.Getenv("CROW_AGENT") == "codex" {
				userPrompt = hookCodexUserPrompt(payload)
				providerThreadID = hookThreadID(payload)
			}
		} else if kind == "user-prompt" {
			message = hookUserPrompt(payload)
			sourceID = hookEventID(payload)
			if os.Getenv("CROW_AGENT") == "codex" {
				providerThreadID = hookThreadID(payload)
			}
		} else {
			agentID = hookAgentID(payload)
		}
	}
	if kind == "user-prompt" || kind == "turn-complete" {
		if sourceID == "" {
			var err error
			sourceID, err = randomID()
			if err != nil {
				return err
			}
		}
	}
	chatMessage, chatTruncated := boundedChatContent(message)
	userPrompt, promptTruncated := boundedChatContent(userPrompt)
	message, messageTruncated = boundedEventMessage(message)

	baseURL := strings.TrimRight(os.Getenv("CROW_EVENT_URL"), "/")
	parsedURL, err := url.ParseRequestURI(baseURL)
	if err != nil || parsedURL.Scheme != "http" || parsedURL.Hostname() != "127.0.0.1" || parsedURL.Port() == "" || parsedURL.User != nil || parsedURL.Path != "/api/events" || parsedURL.RawQuery != "" || parsedURL.Fragment != "" {
		return errors.New("invalid local event URL")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	token, err := hookCredential(home)
	if err != nil {
		return err
	}
	body, err := json.Marshal(map[string]any{"sessionId": os.Getenv("CROW_SESSION_ID"), "kind": kind, "message": message, "chatMessage": chatMessage, "userPrompt": userPrompt, "sourceId": sourceID, "providerThreadId": providerThreadID, "agentId": agentID, "agent": os.Getenv("CROW_AGENT"), "messageTruncated": messageTruncated, "chatTruncated": chatTruncated, "promptTruncated": promptTruncated})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{
		Transport: &http.Transport{},
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	if response.StatusCode != http.StatusAccepted {
		return fmt.Errorf("local event endpoint returned %s", response.Status)
	}
	return nil
}

func boundedChatContent(content string) (string, bool) {
	if len(content) <= maxChatMessageBytes {
		return content, false
	}
	const marker = "\n\n[Mensaje recortado por el límite del historial]"
	maxContent := maxChatMessageBytes - len(marker)
	for maxContent > 0 && !utf8.ValidString(content[:maxContent]) {
		maxContent--
	}
	return content[:maxContent] + marker, true
}

func hookAgentID(payload []byte) string {
	var fields map[string]json.RawMessage
	if json.Unmarshal(payload, &fields) != nil {
		return ""
	}
	var agentID string
	if json.Unmarshal(fields["agent_id"], &agentID) != nil {
		return ""
	}
	return agentID
}

func hookAssistantMessage(payload []byte) string {
	var fields map[string]json.RawMessage
	if json.Unmarshal(payload, &fields) != nil {
		return ""
	}
	for _, key := range []string{"last_assistant_message", "last-assistant-message", "lastAssistantMessage"} {
		var message string
		if json.Unmarshal(fields[key], &message) == nil {
			return message
		}
	}
	return ""
}

func hookUserPrompt(payload []byte) string {
	var fields map[string]json.RawMessage
	if json.Unmarshal(payload, &fields) != nil {
		return ""
	}
	var prompt string
	if json.Unmarshal(fields["prompt"], &prompt) != nil {
		return ""
	}
	return prompt
}

func hookEventID(payload []byte) string {
	var fields map[string]json.RawMessage
	if json.Unmarshal(payload, &fields) != nil {
		return ""
	}
	for _, key := range []string{"uuid", "event_id", "eventId", "turn-id", "turn_id", "turnId"} {
		var id string
		if json.Unmarshal(fields[key], &id) == nil && strings.TrimSpace(id) != "" && len(id) <= 200 && !strings.ContainsAny(id, "\x00\r\n") {
			return id
		}
	}
	return ""
}

func hookCodexUserPrompt(payload []byte) string {
	var fields map[string]json.RawMessage
	if json.Unmarshal(payload, &fields) != nil {
		return ""
	}
	for _, key := range []string{"input-messages", "input_messages", "inputMessages"} {
		var messages []string
		if json.Unmarshal(fields[key], &messages) == nil && len(messages) > 0 {
			return messages[len(messages)-1]
		}
	}
	return ""
}

func hookThreadID(payload []byte) string {
	var fields map[string]json.RawMessage
	if json.Unmarshal(payload, &fields) != nil {
		return ""
	}
	for _, key := range []string{"thread-id", "thread_id", "threadId", "session-id", "session_id", "sessionId"} {
		var id string
		if json.Unmarshal(fields[key], &id) == nil && validProviderThreadID(id) {
			return id
		}
	}
	return ""
}

func validProviderThreadID(id string) bool {
	return strings.TrimSpace(id) != "" && len(id) <= 200 && !strings.ContainsAny(id, "\x00\r\n/\\")
}
