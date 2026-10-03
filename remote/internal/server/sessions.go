package server

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
)

type session struct {
	mu              sync.Mutex
	info            SessionInfo
	rootAgentState  string
	activeSubagents map[string]struct{}
	pty             *os.File
	log             *os.File
	cmd             *exec.Cmd
	done            chan struct{}
	deleting        bool
	lastActivity    time.Time
	subs            map[chan Frame]struct{}
}

func (s *session) snapshot() SessionInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.info
}

func (s *session) subscribe() (chan Frame, uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := make(chan Frame, 256)
	s.subs[ch] = struct{}{}
	return ch, s.info.Seq
}

func (s *session) unsubscribe(ch chan Frame) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.subs[ch]; ok {
		delete(s.subs, ch)
		close(ch)
	}
}

func (s *session) broadcast(frame Frame) {
	for ch := range s.subs {
		select {
		case ch <- frame:
		default:
			delete(s.subs, ch)
			close(ch) // A slow client reconnects and replays from its last sequence.
		}
	}
}

func (s *session) output(data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.info.Seq++
	s.info.UpdatedAt = time.Now().UTC()
	s.lastActivity = s.info.UpdatedAt
	frame := Frame{Type: "output", Seq: s.info.Seq, Data: base64.StdEncoding.EncodeToString(data)}
	if s.log != nil {
		encoded, _ := json.Marshal(frame)
		_, _ = s.log.Write(append(encoded, '\n'))
	}
	s.broadcast(frame)
}

func (s *session) replay(path string, from, through uint64, send func(Frame) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		var frame Frame
		if json.Unmarshal(scanner.Bytes(), &frame) != nil || frame.Seq <= from || frame.Seq > through {
			continue
		}
		if err := send(frame); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func (a *App) loadSessions() error {
	path := filepath.Join(a.dir, "sessions.json")
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var infos []SessionInfo
	if err := json.Unmarshal(data, &infos); err != nil {
		return err
	}
	for _, info := range infos {
		last, err := lastLoggedSequence(filepath.Join(a.dir, "terminal-"+info.ID+".jsonl"))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if last > info.Seq {
			info.Seq = last
		}
		if info.State == "running" || info.State == "sleeping" {
			cleanupOrphanedSession(info.ID)
			info.State = "interrupted"
		}
		if !a.hooksEnabled {
			info.HooksActive = false
			info.AgentState = "unknown"
			info.CacheExpiresAt = nil
		}
		a.sessions[info.ID] = &session{info: info, rootAgentState: info.AgentState, activeSubagents: make(map[string]struct{}), subs: make(map[chan Frame]struct{})}
	}
	return nil
}

func lastLoggedSequence(path string) (uint64, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	var last uint64
	for scanner.Scan() {
		var frame Frame
		if json.Unmarshal(scanner.Bytes(), &frame) == nil && frame.Seq > last {
			last = frame.Seq
		}
	}
	return last, scanner.Err()
}

func (a *App) saveSessions() error {
	a.saveMu.Lock()
	defer a.saveMu.Unlock()
	a.mu.Lock()
	infos := make([]SessionInfo, 0, len(a.sessions))
	for _, s := range a.sessions {
		infos = append(infos, s.snapshot())
	}
	a.mu.Unlock()
	data, err := json.MarshalIndent(infos, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(a.dir, "sessions.json")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (a *App) listSessions() []SessionInfo {
	a.mu.RLock()
	defer a.mu.RUnlock()
	infos := make([]SessionInfo, 0, len(a.sessions))
	for _, s := range a.sessions {
		infos = append(infos, s.snapshot())
	}
	return infos
}

func (a *App) session(id string) *session {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.sessions[id]
}

func agentCommand(agent, mode, hook string) (string, []string, error) {
	if mode != "normal" && mode != "bypass" {
		return "", nil, errors.New("invalid permission mode")
	}
	switch agent {
	case "shell":
		if mode == "bypass" {
			return "", nil, errors.New("bypass does not apply to a shell")
		}
		return "bash", []string{"-l"}, nil
	case "claude":
		args := []string{}
		if hook != "" {
			settings, _ := json.Marshal(map[string]any{"hooks": map[string]any{
				"UserPromptSubmit": []any{map[string]any{"hooks": []any{map[string]any{"type": "command", "command": shellQuote(hook) + " working"}}}},
				"Stop":             []any{map[string]any{"hooks": []any{map[string]any{"type": "command", "command": shellQuote(hook) + " turn-complete"}}}},
				"SubagentStart":    []any{map[string]any{"hooks": []any{map[string]any{"type": "command", "command": shellQuote(hook) + " subagent-start"}}}},
				"SubagentStop":     []any{map[string]any{"hooks": []any{map[string]any{"type": "command", "command": shellQuote(hook) + " subagent-stop"}}}},
			}})
			args = append(args, "--settings", string(settings))
		}
		if mode == "bypass" {
			args = append(args, "--dangerously-skip-permissions")
		}
		return "claude", args, nil
	case "codex":
		args := []string{}
		if hook != "" {
			args = append(args, "-c", fmt.Sprintf("notify=[%q,%q]", hook, "turn-complete"))
			args = append(args,
				"-c", codexCommandHookConfig("SubagentStart", shellQuote(hook)+" subagent-start"),
				"-c", codexCommandHookConfig("SubagentStop", shellQuote(hook)+" subagent-stop"),
			)
		}
		if mode == "bypass" {
			args = append(args, "--dangerously-bypass-approvals-and-sandbox")
		}
		return "codex", args, nil
	case "agy":
		args := []string{}
		if mode == "bypass" {
			args = append(args, "--dangerously-skip-permissions")
		}
		return "agy", args, nil
	default:
		return "", nil, errors.New("unsupported agent")
	}
}

func codexCommandHookConfig(event, command string) string {
	return fmt.Sprintf("hooks.%s=[{hooks=[{type=\"command\",command=%q}]}]", event, command)
}

func claudeCacheTTL(agent string) int {
	if agent != "claude" || os.Getenv("DISABLE_PROMPT_CACHING") == "1" || os.Getenv("ANTHROPIC_BASE_URL") != "" {
		return 0
	}
	if os.Getenv("FORCE_PROMPT_CACHING_5M") == "1" {
		return 300
	}
	switch os.Getenv("CLAUDE_CODE_PROMPT_CACHE_TTL") {
	case "5m":
		return 300
	case "1h":
		return 3600
	}
	if os.Getenv("ENABLE_PROMPT_CACHING_1H") == "1" {
		return 3600
	}
	if os.Getenv("ANTHROPIC_API_KEY") != "" || os.Getenv("CLAUDE_CODE_USE_BEDROCK") == "1" || os.Getenv("CLAUDE_CODE_USE_VERTEX") == "1" {
		return 300
	}
	return 3600 // Claude Code subscription main conversations use 1h; shown as an estimate.
}

func (a *App) startSession(agent, mode, root string) (SessionInfo, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return SessionInfo{}, err
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return SessionInfo{}, err
	}
	stat, err := os.Stat(root)
	if err != nil || !stat.IsDir() {
		return SessionInfo{}, errors.New("project folder does not exist")
	}
	a.mu.RLock()
	hook := a.hookPath
	a.mu.RUnlock()
	bin, args, err := agentCommand(agent, mode, hook)
	if err != nil {
		return SessionInfo{}, err
	}
	if _, err := exec.LookPath(bin); err != nil {
		return SessionInfo{}, fmt.Errorf("%s is not on the server PATH: %w", bin, err)
	}
	id, err := randomID()
	if err != nil {
		return SessionInfo{}, err
	}
	logPath := filepath.Join(a.dir, "terminal-"+id+".jsonl")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return SessionInfo{}, err
	}
	cmd := exec.Command(bin, args...)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "CROW_SESSION_ID="+id,
		"CROW_EVENT_URL=http://127.0.0.1:"+a.port+"/api/events")
	terminal, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 32, Cols: 120})
	if err != nil {
		_ = logFile.Close()
		return SessionInfo{}, err
	}
	now := time.Now().UTC()
	initialAgentState := "waiting"
	if agent == "shell" {
		initialAgentState = "unknown"
	}
	if (hook == "" || agent == "agy") && agent != "shell" {
		initialAgentState = "unknown"
	}
	s := &session{info: SessionInfo{ID: id, Agent: agent, Mode: mode, Root: root, State: "running", AgentState: initialAgentState, HooksActive: hook != "" && agent != "shell" && agent != "agy", CacheTTLSeconds: claudeCacheTTL(agent), StartedAt: now, UpdatedAt: now}, rootAgentState: initialAgentState, activeSubagents: make(map[string]struct{}), pty: terminal, log: logFile, cmd: cmd, done: make(chan struct{}), lastActivity: now, subs: make(map[chan Frame]struct{})}
	a.mu.Lock()
	a.sessions[id] = s
	a.mu.Unlock()
	_ = a.saveSessions()
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		buf := make([]byte, 16*1024)
		for {
			n, err := terminal.Read(buf)
			if n > 0 {
				s.output(buf[:n])
			}
			if err != nil {
				break
			}
		}
	}()
	go func() {
		defer close(s.done)
		err := cmd.Wait()
		<-readDone
		code := 0
		if err != nil {
			var exit *exec.ExitError
			if errors.As(err, &exit) {
				code = exit.ExitCode()
			} else {
				code = -1
			}
		}
		s.mu.Lock()
		s.info.State = "exited"
		s.info.ExitCode = &code
		s.info.UpdatedAt = time.Now().UTC()
		info := s.info
		deleting := s.deleting
		if !deleting {
			s.broadcast(Frame{Type: "state", Info: &info})
		}
		s.pty = nil
		s.log = nil
		s.cmd = nil
		s.mu.Unlock()
		_ = terminal.Close()
		_ = logFile.Close()
		if !deleting {
			_ = a.saveSessions()
		}
		if !deleting && agent != "shell" {
			a.addEvent(id, "process-exited", code != 0)
		}
	}()
	return s.snapshot(), nil
}

func (a *App) deleteSession(id string) error {
	s := a.session(id)
	if s == nil {
		return os.ErrNotExist
	}
	s.mu.Lock()
	if s.deleting {
		s.mu.Unlock()
		return errors.New("session deletion already in progress")
	}
	s.deleting = true
	pid := 0
	if s.cmd != nil && s.cmd.Process != nil && (s.info.State == "running" || s.info.State == "sleeping") {
		pid = s.cmd.Process.Pid
	}
	if s.info.State == "sleeping" && pid != 0 {
		if err := resumeSessionProcess(pid, id); err != nil {
			s.deleting = false
			s.mu.Unlock()
			return err
		}
	}
	done := s.done
	s.mu.Unlock()
	if err := terminateSessionProcess(pid, id, done); err != nil {
		s.mu.Lock()
		s.deleting = false
		s.mu.Unlock()
		return err
	}
	logPath := filepath.Join(a.dir, "terminal-"+id+".jsonl")
	if err := os.Remove(logPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		s.mu.Lock()
		s.deleting = false
		s.mu.Unlock()
		return err
	}
	s.mu.Lock()
	for ch := range s.subs {
		delete(s.subs, ch)
		close(ch)
	}
	s.mu.Unlock()
	a.mu.Lock()
	delete(a.sessions, id)
	a.mu.Unlock()
	if err := a.saveSessions(); err != nil {
		a.mu.Lock()
		a.sessions[id] = s
		a.mu.Unlock()
		s.mu.Lock()
		s.deleting = false
		s.mu.Unlock()
		return err
	}
	return nil
}

func (s *session) write(data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pty == nil || s.info.State != "running" {
		return errors.New("session is not running")
	}
	_, err := s.pty.Write(data)
	if err == nil {
		s.lastActivity = time.Now().UTC()
		if s.info.HooksActive && (strings.ContainsRune(string(data), '\r') || strings.ContainsRune(string(data), '\n')) {
			s.rootAgentState = "working"
			s.updateAgentStateLocked()
			s.info.CacheExpiresAt = nil
			info := s.info
			s.broadcast(Frame{Type: "state", Info: &info})
		}
	}
	return err
}

func (a *App) markAgentState(id, state string) {
	s := a.session(id)
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.deleting || s.info.State != "running" || !s.info.HooksActive {
		return
	}
	s.rootAgentState = state
	s.updateAgentStateLocked()
	s.lastActivity = time.Now().UTC()
	if state == "completed" && len(s.activeSubagents) == 0 && s.info.CacheTTLSeconds > 0 {
		expires := s.lastActivity.Add(time.Duration(s.info.CacheTTLSeconds) * time.Second)
		s.info.CacheExpiresAt = &expires
	} else {
		s.info.CacheExpiresAt = nil
	}
	info := s.info
	s.broadcast(Frame{Type: "state", Info: &info})
}

func (a *App) markSubagentState(id, agentID string, active bool) {
	if strings.TrimSpace(agentID) == "" {
		return
	}
	s := a.session(id)
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.deleting || s.info.State != "running" || !s.info.HooksActive {
		return
	}
	if s.activeSubagents == nil {
		s.activeSubagents = make(map[string]struct{})
	}
	_, exists := s.activeSubagents[agentID]
	if active {
		if exists {
			return
		}
		s.activeSubagents[agentID] = struct{}{}
	} else {
		if !exists {
			return
		}
		delete(s.activeSubagents, agentID)
	}
	s.lastActivity = time.Now().UTC()
	if active {
		s.info.CacheExpiresAt = nil
	} else if len(s.activeSubagents) == 0 && s.rootAgentState == "completed" && s.info.CacheTTLSeconds > 0 {
		expires := s.lastActivity.Add(time.Duration(s.info.CacheTTLSeconds) * time.Second)
		s.info.CacheExpiresAt = &expires
	}
	s.updateAgentStateLocked()
	info := s.info
	s.broadcast(Frame{Type: "state", Info: &info})
}

func (s *session) updateAgentStateLocked() {
	if len(s.activeSubagents) > 0 {
		s.info.AgentState = "working"
	} else {
		s.info.AgentState = s.rootAgentState
	}
}

const idleThreshold = 30 * time.Minute

func (s *session) idleCandidate(now time.Time) bool {
	if s.deleting || s.info.State != "running" || s.cmd == nil || s.cmd.Process == nil || s.lastActivity.IsZero() || now.Sub(s.lastActivity) < idleThreshold {
		return false
	}
	if s.info.Agent == "shell" {
		return true
	}
	return s.info.HooksActive && (s.info.Agent == "claude" || s.info.Agent == "codex") && (s.info.AgentState == "waiting" || s.info.AgentState == "completed")
}

func (a *App) suspendIdleSessions(now time.Time) {
	a.mu.RLock()
	sessions := make([]*session, 0, len(a.sessions))
	for _, s := range a.sessions {
		sessions = append(sessions, s)
	}
	a.mu.RUnlock()
	changed := false
	for _, s := range sessions {
		s.mu.Lock()
		if s.idleCandidate(now) {
			pid := s.cmd.Process.Pid
			if s.info.Agent != "shell" || shellHasNoWork(pid, s.info.ID) {
				if err := suspendSessionProcess(pid, s.info.ID); err == nil {
					s.info.State = "sleeping"
					s.info.UpdatedAt = now
					info := s.info
					s.broadcast(Frame{Type: "state", Info: &info})
					changed = true
				}
			}
		}
		s.mu.Unlock()
	}
	if changed {
		_ = a.saveSessions()
	}
}

func (a *App) wakeSession(id string) (SessionInfo, error) {
	s := a.session(id)
	if s == nil {
		return SessionInfo{}, os.ErrNotExist
	}
	s.mu.Lock()
	if s.deleting {
		s.mu.Unlock()
		return SessionInfo{}, errors.New("session is being deleted")
	}
	if s.info.State == "sleeping" {
		if s.cmd == nil || s.cmd.Process == nil {
			s.mu.Unlock()
			return SessionInfo{}, errors.New("sleeping process unavailable")
		}
		if err := resumeSessionProcess(s.cmd.Process.Pid, id); err != nil {
			s.mu.Unlock()
			return SessionInfo{}, err
		}
		s.info.State = "running"
		s.info.UpdatedAt = time.Now().UTC()
		s.lastActivity = s.info.UpdatedAt
		info := s.info
		s.broadcast(Frame{Type: "state", Info: &info})
		s.mu.Unlock()
		_ = a.saveSessions()
		return info, nil
	}
	info := s.info
	s.mu.Unlock()
	return info, nil
}

func (s *session) resize(cols, rows uint16) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pty == nil || cols == 0 || rows == 0 {
		return errors.New("invalid terminal resize")
	}
	return pty.Setsize(s.pty, &pty.Winsize{Cols: cols, Rows: rows})
}

func safeID(id string) bool {
	return id != "" && !strings.ContainsAny(id, "/\\.")
}

func decodeInput(encoded string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(encoded)
}
