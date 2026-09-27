package server

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestDeleteExitedSessionRemovesMetadataAndLog(t *testing.T) {
	dir := t.TempDir()
	id := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	logPath := filepath.Join(dir, "terminal-"+id+".jsonl")
	if err := os.WriteFile(logPath, []byte("test\n"), 0600); err != nil {
		t.Fatal(err)
	}
	a := &App{dir: dir, sessions: map[string]*session{id: {info: SessionInfo{ID: id, State: "exited"}, subs: make(map[chan Frame]struct{})}}}
	if err := a.deleteSession(id); err != nil {
		t.Fatal(err)
	}
	if a.session(id) != nil {
		t.Fatal("session remained in memory")
	}
	if _, err := os.Stat(logPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("terminal log remains: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "sessions.json"))
	if err != nil || string(data) != "[]" {
		t.Fatalf("metadata not emptied: %q, %v", data, err)
	}
}

func TestDeleteMissingSession(t *testing.T) {
	a := &App{dir: t.TempDir(), sessions: map[string]*session{}}
	if err := a.deleteSession("missing"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("want not-exist, got %v", err)
	}
}
