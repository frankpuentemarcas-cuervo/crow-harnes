package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Numeric, main-conversation telemetry only. Never store the statusLine input,
// which may contain paths, account metadata or additional future fields.
type PromptCache struct {
	Source         string     `json:"source"`
	ConversationID string     `json:"conversationId,omitempty"`
	ReportedAt     time.Time  `json:"reportedAt"`
	ServerTime     time.Time  `json:"serverTime"`
	TTLSeconds     int        `json:"ttlSeconds,omitempty"`
	ExpiresAt      *time.Time `json:"expiresAt,omitempty"`
	Warm           *bool      `json:"warm,omitempty"`
	Observed       *bool      `json:"observed,omitempty"`
	HitRatio       *float64   `json:"hitRatio,omitempty"`
	ReadTokens     *int64     `json:"readTokens,omitempty"`
	WrittenTokens  *int64     `json:"writtenTokens,omitempty"`
	FreshTokens    *int64     `json:"freshTokens,omitempty"`
	Requests       *int64     `json:"requests,omitempty"`
	Misses         *int64     `json:"misses,omitempty"`
	LastMissCauses []string   `json:"lastMissCauses,omitempty"`
}

var cacheConversationID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)
var cacheCauses = map[string]bool{
	"model_changed": true, "effort_changed": true, "thinking_changed": true,
	"tools_changed": true, "system_prompt_changed": true, "messages_changed": true,
	"ttl_expired_5m": true, "ttl_expired_1h": true, "likely_server_side": true,
}

func (c *PromptCache) validate(now time.Time) error {
	if c.ConversationID != "" && !cacheConversationID.MatchString(c.ConversationID) {
		return errors.New("invalid conversation ID")
	}
	if c.TTLSeconds != 0 && c.TTLSeconds != 300 && c.TTLSeconds != 3600 {
		return errors.New("invalid cache TTL")
	}
	if c.HitRatio != nil && (*c.HitRatio < 0 || *c.HitRatio > 1) {
		return errors.New("invalid hit ratio")
	}
	for _, count := range []*int64{c.ReadTokens, c.WrittenTokens, c.FreshTokens, c.Requests, c.Misses} {
		if count != nil && (*count < 0 || *count > 9007199254740991) {
			return errors.New("invalid token count")
		}
	}
	if c.ReportedAt.IsZero() || c.ReportedAt.After(now.Add(time.Minute)) {
		return errors.New("invalid report time")
	}
	if c.ExpiresAt != nil && (c.TTLSeconds == 0 || c.ExpiresAt.After(now.Add(time.Duration(c.TTLSeconds)*time.Second+time.Minute))) {
		return errors.New("invalid expiry")
	}
	causes := make([]string, 0, len(c.LastMissCauses))
	for _, cause := range c.LastMissCauses {
		if cacheCauses[cause] && len(causes) < 8 {
			causes = append(causes, cause)
		}
	}
	c.LastMissCauses = causes
	c.Source = "claude-statusline"
	c.ServerTime = now.UTC()
	return nil
}

func parseClaudeCache(input []byte, now time.Time) (*PromptCache, error) {
	var data struct {
		SessionID string `json:"session_id"`
		Cache     *struct {
			TTL           string   `json:"ttl"`
			ExpiresAt     *int64   `json:"expires_at"`
			Warm          *bool    `json:"warm"`
			Observed      *bool    `json:"caching_observed"`
			HitRatio      *float64 `json:"hit_ratio"`
			Requests      *int64   `json:"requests"`
			Misses        *int64   `json:"misses"`
			LastMissCause *struct {
				Causes []string `json:"causes"`
			} `json:"last_miss_cause"`
		} `json:"prompt_cache"`
		Context struct {
			Usage *struct {
				Read  *int64 `json:"cache_read_input_tokens"`
				Write *int64 `json:"cache_creation_input_tokens"`
				Fresh *int64 `json:"input_tokens"`
			} `json:"current_usage"`
		} `json:"context_window"`
	}
	if err := json.Unmarshal(input, &data); err != nil {
		return nil, errors.New("invalid statusLine JSON")
	}
	c := &PromptCache{ConversationID: data.SessionID, ReportedAt: now.UTC()}
	if pc := data.Cache; pc != nil {
		switch pc.TTL {
		case "5m":
			c.TTLSeconds = 300
		case "1h":
			c.TTLSeconds = 3600
		case "":
		default:
			return nil, errors.New("invalid cache TTL")
		}
		if pc.ExpiresAt != nil {
			value := time.Unix(*pc.ExpiresAt, 0).UTC()
			c.ExpiresAt = &value
		}
		c.Warm, c.Observed, c.HitRatio, c.Requests, c.Misses = pc.Warm, pc.Observed, pc.HitRatio, pc.Requests, pc.Misses
		if pc.LastMissCause != nil {
			c.LastMissCauses = pc.LastMissCause.Causes
		}
	}
	if u := data.Context.Usage; u != nil {
		c.ReadTokens, c.WrittenTokens, c.FreshTokens = u.Read, u.Write, u.Fresh
	}
	return c, c.validate(now)
}

func (a *App) handlePromptCache(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 16*1024)
	var cache PromptCache
	if json.NewDecoder(r.Body).Decode(&cache) != nil || cache.validate(time.Now()) != nil {
		http.Error(w, "invalid cache metrics", 400)
		return
	}
	s := a.session(r.PathValue("id"))
	if s == nil {
		http.Error(w, "session not found", 404)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.deleting || !s.info.HooksActive || s.info.Agent != "claude" || (s.info.State != "running" && s.info.State != "sleeping") {
		http.Error(w, "collector inactive", 409)
		return
	}
	if s.info.PromptCache == nil || cache.ReportedAt.After(s.info.PromptCache.ReportedAt) {
		s.info.PromptCache = &cache
		info := s.info
		s.broadcast(Frame{Type: "state", Info: &info})
	}
	// Do not touch lastActivity, agent state, PTY, events or session persistence.
	jsonResponse(w, http.StatusAccepted, map[string]bool{"ok": true})
}

// Read only statusLine configuration, never modifying user/project files. A
// malformed/unsupported or explicitly disabled configuration is left alone.
func claudeCacheStatusLine(root, binary string) (map[string]any, string) {
	configDir := os.Getenv("CLAUDE_CONFIG_DIR")
	if configDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, ""
		}
		configDir = filepath.Join(home, ".claude")
	}
	line := map[string]any{"type": "command"}
	for _, file := range []string{filepath.Join(configDir, "settings.json"), filepath.Join(root, ".claude", "settings.json"), filepath.Join(root, ".claude", "settings.local.json")} {
		f, err := os.Open(file)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, ""
		}
		data, err := io.ReadAll(io.LimitReader(f, 1024*1024+1))
		_ = f.Close()
		var settings map[string]json.RawMessage
		if err != nil || len(data) > 1024*1024 || json.Unmarshal(data, &settings) != nil {
			return nil, ""
		}
		if value, present := settings["statusLine"]; present {
			var configured map[string]any
			if json.Unmarshal(value, &configured) != nil {
				return nil, ""
			}
			line = configured
		}
	}
	if line == nil || line["type"] != "command" {
		return nil, ""
	}
	original, _ := line["command"].(string)
	if _, configured := line["command"]; configured && strings.TrimSpace(original) == "" {
		return nil, ""
	}
	line["command"] = shellQuote(binary) + " claude-statusline"
	return line, original
}

func postClaudeCache(cache *PromptCache) error {
	id := os.Getenv("CROW_SESSION_ID")
	if !safeID(id) {
		return errors.New("invalid session")
	}
	address, err := url.Parse(os.Getenv("CROW_EVENT_URL"))
	if err != nil || address.Scheme != "http" || address.Hostname() != "127.0.0.1" || address.Port() == "" || address.User != nil || address.Path != "/api/events" || address.RawQuery != "" || address.Fragment != "" {
		return errors.New("invalid collector URL")
	}
	address.Path = "/api/sessions/" + id + "/cache"
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	token, err := hookCredential(home)
	if err != nil {
		return err
	}
	body, err := json.Marshal(cache)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	r, err := http.NewRequestWithContext(ctx, "POST", address.String(), bytes.NewReader(body))
	if err != nil {
		return err
	}
	r.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	r.Header.Set("Content-Type", "application/json")
	transport := &http.Transport{} // No environment proxy: this endpoint must remain loopback-only.
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(r)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		return errors.New("collector unavailable")
	}
	return nil
}

// RunClaudeStatusline forwards the original input/output to the user's command.
// Telemetry failures are silent and bounded, and cannot block model execution.
func RunClaudeStatusline() error {
	return runClaudeStatusline(os.Stdin, os.Stdout, os.Stderr)
}

func runClaudeStatusline(stdin io.Reader, stdout, stderr io.Writer) error {
	input, err := io.ReadAll(io.LimitReader(stdin, 1024*1024+1))
	if err != nil {
		return err
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		if len(input) <= 1024*1024 {
			if cache, err := parseClaudeCache(input, time.Now()); err == nil {
				_ = postClaudeCache(cache)
			}
		}
	}()
	if original := os.Getenv("CROW_STATUSLINE_COMMAND"); original != "" {
		cmd := exec.Command("sh", "-c", original)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = io.MultiReader(bytes.NewReader(input), stdin), stdout, stderr
		err = cmd.Run()
	} else {
		_, _ = io.WriteString(stdout, "Crow · métricas de caché en la app")
	}
	<-done
	return err
}
