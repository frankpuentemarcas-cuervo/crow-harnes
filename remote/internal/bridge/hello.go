// Package bridge owns the durable, deliberately limited Hola mailbox.
// It cannot execute commands or choose a terminal: the runtime adapter does that.
package bridge

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

type Task struct {
	ID        string    `json:"id"`
	SessionID string    `json:"sessionId"`
	Root      string    `json:"root"`
	State     string    `json:"state"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	Result    string    `json:"result,omitempty"`
	Issue     string    `json:"issue,omitempty"`
}

type Store struct {
	mu    sync.Mutex
	path  string
	tasks map[string]Task
}

var identifier = regexp.MustCompile(`^[0-9a-f]{32}$`)

func Open(dir string) (*Store, error) {
	s := &Store{path: filepath.Join(dir, "bridge-tasks.json"), tasks: make(map[string]Task)}
	data, err := os.ReadFile(s.path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err == nil {
		if err = json.Unmarshal(data, &s.tasks); err != nil || s.tasks == nil {
			return nil, errors.New("invalid bridge mailbox")
		}
		for id, task := range s.tasks {
			if id != task.ID || !identifier.MatchString(id) || !identifier.MatchString(task.SessionID) || !strings.HasPrefix(task.Root, "/") || strings.ContainsAny(task.Root, "\x00\r\n") || task.CreatedAt.IsZero() || task.UpdatedAt.IsZero() || (task.State == "completed") != (task.Result == "Hola") || (task.State != "completed" && task.Result != "") {
				return nil, errors.New("invalid bridge task")
			}
			switch task.State {
			case "dispatching", "pending", "uncertain":
				task.State, task.Issue, task.UpdatedAt = "uncertain", "runtime-restarted", time.Now().UTC()
				s.tasks[id] = task
			case "completed", "interrupted":
			default:
				return nil, errors.New("invalid bridge task state")
			}
		}
		if err = s.save(); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// Send persists intent BEFORE the PTY side effect. Retries never resend a task,
// even if the daemon dies between the durable intent and the write. Exactly-once
// delivery to a PTY is impossible; uncertain is preferable to duplicate work.
func (s *Store) Send(id, sessionID, root string, dispatch func(string) error) (Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !identifier.MatchString(id) || !identifier.MatchString(sessionID) || !strings.HasPrefix(root, "/") || strings.ContainsAny(root, "\x00\r\n") {
		return Task{}, errors.New("invalid bridge destination")
	}
	if old, ok := s.tasks[id]; ok {
		if old.SessionID != sessionID || old.Root != root {
			return Task{}, errors.New("bridge idempotency conflict")
		}
		return old, nil
	}
	for _, task := range s.tasks {
		if task.SessionID == sessionID && reserved(task) {
			return Task{}, errors.New("terminal has an unresolved bridge task")
		}
	}
	if len(s.tasks) >= 1000 {
		return Task{}, errors.New("bridge mailbox capacity reached")
	}
	now := time.Now().UTC()
	task := Task{ID: id, SessionID: sessionID, Root: root, State: "dispatching", CreatedAt: now, UpdatedAt: now}
	s.tasks[id] = task
	if err := s.save(); err != nil {
		delete(s.tasks, id)
		return Task{}, err
	}
	// No user-supplied instruction is interpolated into this probe.
	prompt := `Respondé exactamente "Hola [crow-task:` + id + `]". Sólo saludá; no uses herramientas, no leas archivos y no ejecutes comandos.` + "\r"
	if err := dispatch(prompt); err != nil {
		task.State, task.Issue = "uncertain", "dispatch-outcome-unknown"
	} else {
		task.State = "pending"
	}
	task.UpdatedAt = time.Now().UTC()
	s.tasks[id] = task
	return task, s.save()
}

func reserved(task Task) bool {
	return task.State == "dispatching" || task.State == "pending" || task.State == "uncertain"
}

func (s *Store) Get(id string) (Task, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	task, ok := s.tasks[id]
	return task, ok
}

// Complete accepts only the fixed greeting with the exact session/task marker.
// Unrelated assistant text (including secrets/questions/instructions) is not stored.
func (s *Store) Complete(sessionID, message string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, task := range s.tasks {
		if task.SessionID == sessionID && reserved(task) && strings.TrimSpace(message) == "Hola [crow-task:"+id+"]" {
			old := task
			task.State, task.Result, task.Issue, task.UpdatedAt = "completed", "Hola", "", time.Now().UTC()
			s.tasks[id] = task
			if err := s.save(); err != nil {
				s.tasks[id] = old
				return err
			}
			return nil
		}
	}
	return nil
}

// Interrupt yields ownership back to the human on manual input, process exit,
// or deletion. A later hook may not resurrect the interrupted task.
func (s *Store) Interrupt(sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.interruptLocked(sessionID)
}

// WithManualInput serializes takeover and input with Send. A client cannot
// reserve a task in the gap between cancelling it and the human's PTY write.
func (s *Store) WithManualInput(sessionID string, write func() error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.interruptLocked(sessionID); err != nil {
		return err
	}
	return write()
}

func (s *Store) interruptLocked(sessionID string) error {
	changed := false
	for id, task := range s.tasks {
		if task.SessionID == sessionID && reserved(task) {
			task.State, task.Issue, task.UpdatedAt = "interrupted", "terminal-ownership-changed", time.Now().UTC()
			s.tasks[id] = task
			changed = true
		}
	}
	if changed {
		return s.save()
	}
	return nil
}

func (s *Store) save() error {
	data, err := json.Marshal(s.tasks)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(s.path+".tmp", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err := os.Rename(s.path+".tmp", s.path); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		return nil
	} // Tests may run on Windows; crowd runs on Linux.
	directory, err := os.Open(filepath.Dir(s.path))
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
