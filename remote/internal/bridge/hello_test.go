package bridge

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const taskID = "0123456789abcdef0123456789abcdef"
const sessionID = "abcdef0123456789abcdef0123456789"

func TestHelloCorrelationAndDurableReplay(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	dispatch := func(prompt string) error {
		calls++
		if !strings.Contains(prompt, "Hola [crow-task:"+taskID+"]") {
			t.Fatal("missing correlation")
		}
		return nil
	}
	task, err := s.Send(taskID, sessionID, "/test", dispatch)
	if err != nil || task.State != "pending" {
		t.Fatalf("%+v %v", task, err)
	}
	if _, err = s.Send(taskID, sessionID, "/test", dispatch); err != nil || calls != 1 {
		t.Fatal("duplicate dispatch")
	}
	if _, err = s.Send(taskID, sessionID, "/another", dispatch); err == nil {
		t.Fatal("destination conflict allowed")
	}
	if err = s.Complete(sessionID, "private-secret-marker"); err != nil {
		t.Fatal(err)
	}
	task, _ = s.Get(taskID)
	if task.State != "pending" {
		t.Fatal("unrelated reply correlated")
	}
	if err = s.Complete("00000000000000000000000000000000", "Hola [crow-task:"+taskID+"]"); err != nil {
		t.Fatal(err)
	}
	task, _ = s.Get(taskID)
	if task.State != "pending" {
		t.Fatal("cross-session reply accepted")
	}
	if err = s.Complete(sessionID, "Hola [crow-task:"+taskID+"]"); err != nil {
		t.Fatal(err)
	}
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	task, _ = s.Get(taskID)
	if task.State != "completed" || task.Result != "Hola" {
		t.Fatalf("%+v", task)
	}
	if _, err = s.Send(taskID, sessionID, "/test", dispatch); err != nil || calls != 1 {
		t.Fatal("replay after restart")
	}
	data, err := os.ReadFile(filepath.Join(dir, "bridge-tasks.json"))
	if err != nil || strings.Contains(string(data), "private-secret-marker") {
		t.Fatal("stored untrusted text")
	}
}

func TestHelloInterruptedDispatchIsNeverRetried(t *testing.T) {
	for _, dispatchError := range []error{nil, errors.New("sensitive transport detail")} {
		t.Run("dispatch", func(t *testing.T) {
			dir := t.TempDir()
			s, _ := Open(dir)
			calls := 0
			dispatch := func(string) error { calls++; return dispatchError }
			if _, err := s.Send(taskID, sessionID, "/test", dispatch); err != nil {
				t.Fatal(err)
			}
			s, err := Open(dir)
			if err != nil {
				t.Fatal(err)
			}
			task, _ := s.Get(taskID)
			if task.State != "uncertain" {
				t.Fatalf("%+v", task)
			}
			if _, err = s.Send(taskID, sessionID, "/test", dispatch); err != nil || calls != 1 {
				t.Fatal("unsafe retry")
			}
			if _, err = s.Send("00000000000000000000000000000000", sessionID, "/test", dispatch); err == nil {
				t.Fatal("overlap allowed")
			}
			if err = s.Interrupt(sessionID); err != nil {
				t.Fatal(err)
			}
			task, _ = s.Get(taskID)
			if task.State != "interrupted" {
				t.Fatalf("%+v", task)
			}
			if err = s.Complete(sessionID, "Hola [crow-task:"+taskID+"]"); err != nil {
				t.Fatal(err)
			}
			task, _ = s.Get(taskID)
			if task.State != "interrupted" {
				t.Fatal("late completion changed cancelled task")
			}
		})
	}
}

func TestHelloFailsClosedOnPersistenceAndInvalidInput(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "bridge-tasks.json"), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir); err == nil {
		t.Fatal("corrupt storage silently reset")
	}
	s, _ := Open(t.TempDir())
	for _, root := range []string{"relative", "/test\ncommand", ""} {
		if _, err := s.Send(taskID, sessionID, root, func(string) error { t.Fatal("invalid dispatch"); return nil }); err == nil {
			t.Fatal("invalid root")
		}
	}
	if _, err := s.Send("invalid", sessionID, "/test", func(string) error { t.Fatal("invalid id dispatched"); return nil }); err == nil {
		t.Fatal("invalid id")
	}
	blockedDir := t.TempDir()
	s, _ = Open(blockedDir)
	if err := os.Mkdir(filepath.Join(blockedDir, "bridge-tasks.json.tmp"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Send(taskID, sessionID, "/test", func(string) error { t.Fatal("dispatch before persistence"); return nil }); err == nil {
		t.Fatal("persistence failure ignored")
	}
}
