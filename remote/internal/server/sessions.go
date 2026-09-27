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
	mu   sync.Mutex
	info SessionInfo
	pty  *os.File
	log  *os.File
	subs map[chan Frame]struct{}
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
		if info.State == "running" {
			info.State = "interrupted"
		}
		a.sessions[info.ID] = &session{info: info, subs: make(map[chan Frame]struct{})}
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
		settings, _ := json.Marshal(map[string]any{"hooks": map[string]any{"Stop": []any{map[string]any{"hooks": []any{map[string]any{"type": "command", "command": hook}}}}}})
		args := []string{"--settings", string(settings)}
		if mode == "bypass" {
			args = append(args, "--dangerously-skip-permissions")
		}
		return "claude", args, nil
	case "codex":
		args := []string{"-c", fmt.Sprintf("notify=[%q]", hook)}
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
	bin, args, err := agentCommand(agent, mode, a.hookPath)
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
	s := &session{info: SessionInfo{ID: id, Agent: agent, Mode: mode, Root: root, State: "running", StartedAt: now, UpdatedAt: now}, pty: terminal, log: logFile, subs: make(map[chan Frame]struct{})}
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
		s.broadcast(Frame{Type: "state", Info: &info})
		s.mu.Unlock()
		_ = terminal.Close()
		_ = logFile.Close()
		_ = a.saveSessions()
		if agent != "shell" {
			a.addEvent(id, "process-exited")
		}
	}()
	return s.snapshot(), nil
}

func (s *session) write(data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pty == nil || s.info.State != "running" {
		return errors.New("session is not running")
	}
	_, err := s.pty.Write(data)
	return err
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
