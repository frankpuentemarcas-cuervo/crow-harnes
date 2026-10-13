package server

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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

func TestManagedShellWrapsClaudeWithoutEditingUserSettings(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("remote runtime is Linux")
	}
	root := t.TempDir()
	cliDir := filepath.Join(root, "cli")
	if err := os.MkdirAll(cliDir, 0700); err != nil {
		t.Fatal(err)
	}
	claude := filepath.Join(cliDir, "claude")
	if err := os.WriteFile(claude, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", cliDir)
	a := &App{dir: filepath.Join(root, "crow"), binaryPath: "/opt/crow/crowd"}
	if err := os.MkdirAll(a.dir, 0700); err != nil {
		t.Fatal(err)
	}
	dir, err := a.installShellClaudeWrapper("session-123", "/opt/crow/notify-stop.sh")
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "claude"))
	if err != nil {
		t.Fatal(err)
	}
	script := string(data)
	if output, err := exec.Command("sh", "-n", filepath.Join(dir, "claude")).CombinedOutput(); err != nil {
		t.Fatalf("generated wrapper is invalid shell syntax: %v: %s\n%s", err, output, script)
	}
	for _, expected := range []string{
		"/opt/crow/crowd' hook-notify agent-start",
		"hook-notify agent-stop",
		"crow_entry/claude",
		"\"$crow_claude\" --settings",
		"UserPromptSubmit",
		"SubagentStart",
		"turn-complete",
		"\"$@\"",
	} {
		if !strings.Contains(script, expected) {
			t.Fatalf("wrapper missing %q:\n%s", expected, script)
		}
	}
	if _, err := os.Stat(filepath.Join(root, ".claude", "settings.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("wrapper unexpectedly edited user Claude settings: %v", err)
	}
}

func TestSetEnvironmentVariableReplacesPriorValues(t *testing.T) {
	got := setEnvironmentVariable([]string{"HOME=/home/developer", "PATH=/usr/bin", "PATH=/bin", "TERM=xterm"}, "PATH", "/crow/bin:/usr/bin")
	paths := 0
	for _, entry := range got {
		if strings.HasPrefix(entry, "PATH=") {
			paths++
			if entry != "PATH=/crow/bin:/usr/bin" {
				t.Fatalf("PATH = %q", entry)
			}
		}
	}
	if paths != 1 {
		t.Fatalf("PATH entries = %d, want one: %#v", paths, got)
	}
}
