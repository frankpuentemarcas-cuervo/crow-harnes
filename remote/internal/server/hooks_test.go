package server

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHookToggleRemovesManagedScriptAndPersists(t *testing.T) {
	dir := t.TempDir()
	a := &App{dir: dir, sessions: make(map[string]*session)}
	if err := a.installHook(); err != nil {
		t.Fatal(err)
	}
	if err := a.setHooksEnabled(false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "notify-stop.sh")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("hook remained: %v", err)
	}
	restarted := &App{dir: dir, sessions: make(map[string]*session)}
	if err := restarted.loadHookSettings(); err != nil {
		t.Fatal(err)
	}
	if restarted.hooksEnabled || restarted.hookPath != "" {
		t.Fatal("hook was reinstalled after restart")
	}
	if err := restarted.setHooksEnabled(true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "notify-stop.sh")); err != nil {
		t.Fatal(err)
	}
}

func TestAgentCommandWithoutManagedHooks(t *testing.T) {
	for _, agent := range []string{"claude", "codex"} {
		_, args, err := agentCommand(agent, "normal", "")
		if err != nil {
			t.Fatal(err)
		}
		joined := strings.Join(args, " ")
		if strings.Contains(joined, "--settings") || strings.Contains(joined, "notify=") {
			t.Fatalf("%s still has managed hooks: %s", agent, joined)
		}
	}
}
