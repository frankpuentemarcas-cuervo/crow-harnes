package server

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
)

type session struct {
	hookHash        string
	mu              sync.Mutex
	info            SessionInfo
	rootAgentState  string
	activeSubagents map[string]struct{}
	pty             *os.File
	log             *os.File
	cmd             *exec.Cmd
	done            chan struct{}
	deleting        bool
	userDraft       bool
	lastActivity    time.Time
	subs            map[chan Frame]struct{}
}

func (s *session) snapshot() SessionInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.snapshotLocked()
}

func (s *session) snapshotLocked() SessionInfo {
	info := s.info
	if info.PromptCache != nil {
		cache := *info.PromptCache
		cache.ServerTime = time.Now().UTC()
		info.PromptCache = &cache
	}
	return info
}

func (s *session) subscribe() (chan Frame, uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := make(chan Frame, 256)
	s.subs[ch] = struct{}{}
	return ch, s.info.Seq
}

func (s *session) subscribeSnapshot() (chan Frame, SessionInfo) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ch := make(chan Frame, 256)
	s.subs[ch] = struct{}{}
	return ch, s.snapshotLocked()
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
	if through <= from {
		return nil
	}
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
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	var infos []SessionInfo
	if err == nil {
		if err := json.Unmarshal(data, &infos); err != nil {
			return err
		}
	}
	for _, info := range infos {
		info.PromptCache = nil // Native reports describe a live CLI, not a persisted conversation.
		info.CacheExpiresAt, info.CacheTTLSeconds = nil, 0
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
		hookHash := ""
		if token, err := os.ReadFile(filepath.Join(a.dir, "hook-"+info.ID)); err == nil {
			hookHash = tokenHash(strings.TrimSpace(string(token)))
		}
		a.sessions[info.ID] = &session{hookHash: hookHash, info: info, rootAgentState: info.AgentState, activeSubagents: make(map[string]struct{}), subs: make(map[chan Frame]struct{})}
	}
	return a.reconcilePendingSessionDeletes()
}

const sessionDeleteMarkerDirName = ".session-delete-pending"

type sessionDeleteMarker struct {
	Version int    `json:"version"`
	OwnerID string `json:"ownerId"`
}

func (a *App) sessionDeleteMarkerDir() string {
	return filepath.Join(a.dir, sessionDeleteMarkerDirName)
}

func (a *App) ensureSessionDeleteMarkerDir(create bool) error {
	dir := a.sessionDeleteMarkerDir()
	if create {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
	}
	info, err := os.Lstat(dir)
	if errors.Is(err, os.ErrNotExist) && !create {
		return os.ErrNotExist
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("session delete marker path is not a directory")
	}
	return os.Chmod(dir, 0700)
}

func (a *App) readSessionDeleteMarker(id string) (sessionDeleteMarker, bool, error) {
	if !safeID(id) {
		return sessionDeleteMarker{}, false, errors.New("invalid session id")
	}
	if err := a.ensureSessionDeleteMarkerDir(false); errors.Is(err, os.ErrNotExist) {
		return sessionDeleteMarker{}, false, nil
	} else if err != nil {
		return sessionDeleteMarker{}, false, err
	}
	path := filepath.Join(a.sessionDeleteMarkerDir(), id)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return sessionDeleteMarker{}, false, nil
	}
	if err != nil {
		return sessionDeleteMarker{}, false, err
	}
	if !info.Mode().IsRegular() || info.Size() > 4096 {
		return sessionDeleteMarker{}, false, errors.New("invalid session delete marker file")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return sessionDeleteMarker{}, false, err
	}
	var marker sessionDeleteMarker
	if err := json.Unmarshal(data, &marker); err != nil || marker.Version != 1 {
		return sessionDeleteMarker{}, false, errors.New("invalid session delete marker contents")
	}
	return marker, true, nil
}

func (a *App) writeSessionDeleteMarker(id, ownerID string) error {
	if !safeID(id) {
		return errors.New("invalid session id")
	}
	if marker, found, err := a.readSessionDeleteMarker(id); err != nil {
		return err
	} else if found {
		if marker.OwnerID != ownerID {
			return errors.New("session delete marker owner mismatch")
		}
		return syncSessionDeleteMarkerDir(a.sessionDeleteMarkerDir())
	}
	if err := a.ensureSessionDeleteMarkerDir(true); err != nil {
		return err
	}
	data, err := json.Marshal(sessionDeleteMarker{Version: 1, OwnerID: ownerID})
	if err != nil {
		return err
	}
	path := filepath.Join(a.sessionDeleteMarkerDir(), id)
	tmp := path + ".tmp"
	if info, err := os.Lstat(tmp); err == nil {
		if !info.Mode().IsRegular() {
			return errors.New("session delete marker temp path is not a regular file")
		}
		if err := os.Remove(tmp); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	file, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if err := file.Chmod(0600); err != nil {
		_ = file.Close()
		_ = os.Remove(tmp)
		return err
	}
	if written, err := file.Write(data); err != nil || written != len(data) {
		_ = file.Close()
		_ = os.Remove(tmp)
		if err != nil {
			return err
		}
		return errors.New("short write for session delete marker")
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return syncSessionDeleteMarkerDir(a.sessionDeleteMarkerDir())
}

func syncSessionDeleteMarkerDir(path string) error {
	if runtime.GOOS == "windows" {
		return nil // Windows does not expose directory fsync through os.File.
	}
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func (a *App) removeSessionDeleteMarker(id string) error {
	if _, found, err := a.readSessionDeleteMarker(id); err != nil {
		return err
	} else if !found {
		return nil
	}
	if err := os.Remove(filepath.Join(a.sessionDeleteMarkerDir(), id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// A stale marker is safe: startup cleanup is idempotent. If directory
	// syncing is unsupported or fails, prefer success over a false delete error.
	_ = syncSessionDeleteMarkerDir(a.sessionDeleteMarkerDir())
	return nil
}

func (a *App) reconcilePendingSessionDeletes() error {
	a.deleteMu.Lock()
	defer a.deleteMu.Unlock()
	if err := a.ensureSessionDeleteMarkerDir(false); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	entries, err := os.ReadDir(a.sessionDeleteMarkerDir())
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasSuffix(name, ".tmp") {
			id := strings.TrimSuffix(name, ".tmp")
			if !safeID(id) {
				return errors.New("invalid session delete marker temp name")
			}
			info, err := os.Lstat(filepath.Join(a.sessionDeleteMarkerDir(), name))
			if err != nil {
				return err
			}
			if !info.Mode().IsRegular() {
				return errors.New("invalid session delete marker temp file")
			}
			_ = os.Remove(filepath.Join(a.sessionDeleteMarkerDir(), name))
			continue
		}
		if !safeID(name) {
			return errors.New("invalid session delete marker name")
		}
		_, found, err := a.readSessionDeleteMarker(name)
		if err != nil || !found {
			if err != nil {
				return err
			}
			return errors.New("session delete marker disappeared during startup")
		}
		if a.session(name) != nil {
			// Metadata was not durably removed; keep the session and cancel intent.
			if err := a.removeSessionDeleteMarker(name); err != nil {
				log.Printf("crowd: could not clear uncommitted session delete marker %s: %v", name, err)
			}
			continue
		}
		if err := a.cleanupDeletedSessionFiles(name); err != nil {
			log.Printf("crowd: cleanup pending for deleted session %s: %v", name, err)
			continue
		}
		if err := a.removeSessionDeleteMarker(name); err != nil {
			log.Printf("crowd: cleanup completed but marker remains for session %s: %v", name, err)
		}
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
		info := s.snapshot()
		info.PromptCache = nil
		infos = append(infos, info)
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

func agentCommand(agent, mode, hook string, statusLine ...map[string]any) (string, []string, error) {
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
			settings := claudeHookSettings(hook, firstStatusLine(statusLine))
			args = append(args, "--settings", string(settings))
		}
		if mode == "bypass" {
			args = append(args, "--dangerously-skip-permissions")
		}
		return "claude", args, nil
	case "codex":
		args := []string{}
		if hook != "" {
			args = append(args,
				"-c", codexCommandHookConfig("UserPromptSubmit", shellQuote(hook)+" user-prompt"),
				"-c", codexCommandHookConfig("Stop", shellQuote(hook)+" turn-complete"),
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

func firstStatusLine(statusLines []map[string]any) map[string]any {
	if len(statusLines) > 0 {
		return statusLines[0]
	}
	return nil
}

func claudeHookSettings(hook string, statusLine map[string]any) []byte {
	config := map[string]any{"hooks": map[string]any{
		"SessionStart":     []any{map[string]any{"matcher": "startup|resume", "hooks": []any{map[string]any{"type": "command", "command": shellQuote(hook) + " session-start"}}}},
		"UserPromptSubmit": []any{map[string]any{"hooks": []any{map[string]any{"type": "command", "command": shellQuote(hook) + " user-prompt"}}}},
		"Stop":             []any{map[string]any{"hooks": []any{map[string]any{"type": "command", "command": shellQuote(hook) + " turn-complete"}}}},
		"SubagentStart":    []any{map[string]any{"hooks": []any{map[string]any{"type": "command", "command": shellQuote(hook) + " subagent-start"}}}},
		"SubagentStop":     []any{map[string]any{"hooks": []any{map[string]any{"type": "command", "command": shellQuote(hook) + " subagent-stop"}}}},
	}}
	if statusLine != nil {
		config["statusLine"] = statusLine
	}
	settings, _ := json.Marshal(config)
	return settings
}

func setEnvironmentVariable(env []string, key, value string) []string {
	prefix := key + "="
	result := make([]string, 0, len(env)+1)
	for _, entry := range env {
		if !strings.HasPrefix(entry, prefix) {
			result = append(result, entry)
		}
	}
	return append(result, prefix+value)
}

// installShellClaudeWrapper instruments only Claude commands started from a
// Crow-managed shell. It does not edit the user's global or project settings.
func (a *App) installShellClaudeWrapper(id, hook string) (string, error) {
	if runtime.GOOS == "windows" {
		return "", nil
	}
	binary := a.binaryPath
	var err error
	if binary == "" {
		binary, err = os.Executable()
		if err != nil {
			return "", err
		}
	}
	dir := filepath.Join(a.dir, "shell-agent-"+id)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	dir, err = filepath.Abs(dir)
	if err != nil {
		_ = os.RemoveAll(dir)
		return "", err
	}
	settings := string(claudeHookSettings(hook, nil))
	stopCommand := shellQuote(binary) + " hook-notify agent-stop >/dev/null 2>&1"
	script := "#!/bin/sh\n" +
		"crow_wrapper_dir=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\n" +
		"crow_claude=\n" +
		"crow_old_ifs=$IFS; IFS=:\n" +
		"for crow_entry in $PATH; do\n" +
		"  [ -n \"$crow_entry\" ] || crow_entry=.\n" +
		"  [ \"$crow_entry\" = \"$crow_wrapper_dir\" ] && continue\n" +
		"  if [ -x \"$crow_entry/claude\" ] && [ ! -d \"$crow_entry/claude\" ]; then crow_claude=$crow_entry/claude; break; fi\n" +
		"done\n" +
		"IFS=$crow_old_ifs\n" +
		"if [ -z \"$crow_claude\" ]; then echo 'Crow: no encuentro Claude Code en el PATH de esta shell.' >&2; exit 127; fi\n" +
		"export CROW_AGENT=claude\n" +
		"'" + strings.ReplaceAll(binary, "'", "'\\''") + "' hook-notify agent-start >/dev/null 2>&1 || true\n" +
		"trap " + shellQuote(stopCommand) + " EXIT\n" +
		"\"$crow_claude\" --settings " + shellQuote(settings) + " \"$@\"\n"
	path := filepath.Join(dir, "claude")
	if err := os.WriteFile(path, []byte(script), 0700); err != nil {
		_ = os.RemoveAll(dir)
		return "", err
	}
	return dir, nil
}

func codexCommandHookConfig(event, command string) string {
	return fmt.Sprintf("hooks.%s=[{hooks=[{type=\"command\",command=%q}]}]", event, command)
}

func (a *App) startSession(agent, mode, root string) (SessionInfo, error) {
	return a.startSessionOwned(agent, mode, root, nil)
}

func (a *App) startSessionOwned(agent, mode, root string, principal *AccessPrincipal) (SessionInfo, error) {
	return a.startSessionPrompt(agent, mode, root, principal, "")
}
func (a *App) startSessionPrompt(agent, mode, root string, principal *AccessPrincipal, initialPrompt string) (SessionInfo, error) {
	// Serialize admission with revocation: a revoked in-flight request cannot spawn.
	a.access.mu.Lock()
	defer a.access.mu.Unlock()
	if a.access.data.Enabled {
		valid := false
		if principal != nil {
			if principal.Role == "installation" {
				_, valid = installationIDFromOwner(principal.ID)
			} else {
				for _, u := range a.access.data.Users {
					if u.ID == principal.ID && !u.Revoked {
						valid = true
						break
					}
				}
			}
		}
		if !valid || !a.permittedRoot(principal, root) {
			return SessionInfo{}, errors.New("access revoked or project not permitted")
		}
	}

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
	var statusLine map[string]any
	var originalStatusLine string
	if agent == "claude" && hook != "" {
		binary := a.binaryPath
		if binary == "" {
			binary, _ = os.Executable()
		}
		statusLine, originalStatusLine = claudeCacheStatusLine(root, binary)
	}
	bin, args, err := agentCommand(agent, mode, hook, statusLine)
	if err != nil {
		return SessionInfo{}, err
	}
	if initialPrompt != "" {
		args = initialPromptArgs(args, initialPrompt)
	}
	if _, err := exec.LookPath(bin); err != nil {
		return SessionInfo{}, fmt.Errorf("%s is not on the server PATH: %w", bin, err)
	}
	id, err := randomID()
	if err != nil {
		return SessionInfo{}, err
	}
	ownerID := ""
	hookToken := ""
	if principal != nil {
		ownerID = principal.ID
		hookToken, err = randomID()
		if err != nil {
			return SessionInfo{}, err
		}
		if err = os.WriteFile(filepath.Join(a.dir, "hook-"+id), []byte(hookToken), 0600); err != nil {
			return SessionInfo{}, err
		}
	}
	shellAgentPath := ""
	if agent == "shell" && hook != "" {
		shellAgentPath, err = a.installShellClaudeWrapper(id, hook)
		if err != nil {
			_ = os.Remove(filepath.Join(a.dir, "hook-"+id))
			return SessionInfo{}, err
		}
	}
	logPath := filepath.Join(a.dir, "terminal-"+id+".jsonl")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		if shellAgentPath != "" {
			_ = os.RemoveAll(shellAgentPath)
		}
		_ = os.Remove(filepath.Join(a.dir, "hook-"+id))
		return SessionInfo{}, err
	}
	cmd := exec.Command(bin, args...)
	cmd.Dir = root
	cmd.Env = os.Environ()
	for _, variable := range [][2]string{
		{"TERM", "xterm-256color"},
		{"CROW_SESSION_ID", id},
		{"CROW_HOOK_TOKEN", hookToken},
		{"CROW_EVENT_URL", "http://127.0.0.1:" + a.port + "/api/events"},
		{"CROW_STATUSLINE_COMMAND", originalStatusLine},
		{"CROW_AGENT", agent},
	} {
		cmd.Env = setEnvironmentVariable(cmd.Env, variable[0], variable[1])
	}
	if shellAgentPath != "" {
		cmd.Env = setEnvironmentVariable(cmd.Env, "PATH", shellAgentPath+string(os.PathListSeparator)+os.Getenv("PATH"))
	}
	terminal, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: 32, Cols: 120})
	if err != nil {
		if shellAgentPath != "" {
			_ = os.RemoveAll(shellAgentPath)
		}
		_ = os.Remove(filepath.Join(a.dir, "hook-"+id))
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
	hooksActive := hook != "" && (agent == "claude" || agent == "codex" || (agent == "shell" && shellAgentPath != ""))
	s := &session{hookHash: tokenHash(hookToken), info: SessionInfo{OwnerID: ownerID, ID: id, Agent: agent, Mode: mode, Root: root, State: "running", AgentState: initialAgentState, HooksActive: hooksActive, StartedAt: now, UpdatedAt: now}, rootAgentState: initialAgentState, activeSubagents: make(map[string]struct{}), pty: terminal, log: logFile, cmd: cmd, done: make(chan struct{}), lastActivity: now, subs: make(map[chan Frame]struct{})}
	a.mu.Lock()
	if hookToken == "" {
		s.hookHash = ""
	}
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
	a.deleteMu.Lock()
	defer a.deleteMu.Unlock()
	if !safeID(id) {
		return errors.New("invalid session id")
	}
	s := a.session(id)
	if s == nil {
		if _, found, err := a.readSessionDeleteMarker(id); err != nil {
			return err
		} else if !found {
			return os.ErrNotExist
		}
		if err := a.cleanupDeletedSessionFiles(id); err != nil {
			return fmt.Errorf("session cleanup is still pending: %w", err)
		}
		if err := a.removeSessionDeleteMarker(id); err != nil {
			return fmt.Errorf("session files removed but cleanup marker remains: %w", err)
		}
		return nil
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
	if a.bridge != nil {
		_ = a.bridge.Interrupt(id)
	}
	if err := terminateSessionProcess(pid, id, done); err != nil {
		s.mu.Lock()
		s.deleting = false
		s.mu.Unlock()
		return err
	}
	if err := a.writeSessionDeleteMarker(id, s.snapshot().OwnerID); err != nil {
		s.mu.Lock()
		s.deleting = false
		s.mu.Unlock()
		return fmt.Errorf("could not record pending session deletion: %w", err)
	}
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
		if markerErr := a.removeSessionDeleteMarker(id); markerErr != nil {
			return fmt.Errorf("could not persist session deletion: %v; pending marker cleanup failed: %w", err, markerErr)
		}
		return err
	}
	// The metadata removal is now durable. Only now discard streams and
	// session-owned files, so a persistence failure can restore the visible
	// session without silently losing its transcript or terminal log.
	s.mu.Lock()
	for ch := range s.subs {
		delete(s.subs, ch)
		close(ch)
	}
	s.mu.Unlock()
	a.mu.Lock()
	for _, event := range a.events {
		if event.SessionID == id {
			delete(a.eventMessages, event.ID)
		}
	}
	a.mu.Unlock()
	if err := a.cleanupDeletedSessionFiles(id); err != nil {
		return fmt.Errorf("session removed but cleanup is pending: %w", err)
	}
	if err := a.removeSessionDeleteMarker(id); err != nil {
		return fmt.Errorf("session files removed but cleanup marker remains: %w", err)
	}
	return nil
}

func (a *App) cleanupDeletedSessionFiles(id string) error {
	if !safeID(id) {
		return errors.New("invalid session id")
	}
	if err := a.chatHistory().remove(id); err != nil {
		return fmt.Errorf("chat transcript cleanup failed: %w", err)
	}
	if err := os.Remove(filepath.Join(a.dir, "terminal-"+id+".jsonl")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("terminal log cleanup failed: %w", err)
	}
	if err := os.RemoveAll(filepath.Join(a.dir, "shell-agent-"+id)); err != nil {
		return fmt.Errorf("agent data cleanup failed: %w", err)
	}
	if err := os.Remove(filepath.Join(a.dir, "hook-"+id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("hook cleanup failed: %w", err)
	}
	return nil
}

func (s *session) write(data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.deleting || s.pty == nil || s.info.State != "running" {
		return errors.New("session is not running")
	}
	_, err := s.pty.Write(data)
	if err == nil {
		if len(data) > 0 {
			lastEnter := strings.LastIndexAny(string(data), "\r\n")
			s.userDraft = lastEnter != len(data)-1
		}
		s.lastActivity = time.Now().UTC()
		if s.info.HooksActive && s.info.Agent != "shell" && (strings.ContainsRune(string(data), '\r') || strings.ContainsRune(string(data), '\n')) {
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
	info := s.info
	s.broadcast(Frame{Type: "state", Info: &info})
}

// Codex exposes only a turn-complete notification, so a submitted line must
// transition the session to working while the agent processes that turn.
func (a *App) markCodexInputWorking(id string, input []byte) {
	if !bytes.ContainsAny(input, "\r\n") {
		return
	}
	s := a.session(id)
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.deleting || s.info.State != "running" || !s.info.HooksActive || s.info.Agent != "codex" {
		return
	}
	s.rootAgentState = "working"
	s.updateAgentStateLocked()
	s.lastActivity = time.Now().UTC()
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

func initialPromptArgs(args []string, prompt string) []string { return append(args, "--", prompt) }
