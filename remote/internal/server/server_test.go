package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveProjectPathRejectsEscape(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "inside.txt")
	if err := os.WriteFile(inside, []byte("ok"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveProjectPath(root, "inside.txt"); err != nil {
		t.Fatalf("expected valid file: %v", err)
	}
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveProjectPath(root, filepath.Join("..", filepath.Base(outside), "secret.txt")); err == nil {
		t.Fatal("parent traversal must be rejected")
	}
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(root, "link")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := resolveProjectPath(root, "link"); err == nil {
		t.Fatal("symlink escape must be rejected")
	}
}

func TestAgentCommandKeepsBypassExplicit(t *testing.T) {
	for _, name := range []string{"claude", "codex", "agy"} {
		_, normal, err := agentCommand(name, "normal", "/tmp/hook")
		if err != nil {
			t.Fatal(err)
		}
		_, bypass, err := agentCommand(name, "bypass", "/tmp/hook")
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(strings.Join(normal, " "), "dangerously") {
			t.Fatalf("%s normal mode must not bypass permissions", name)
		}
		if !strings.Contains(strings.Join(bypass, " "), "dangerously") {
			t.Fatalf("%s bypass mode is missing explicit flag", name)
		}
	}
	if _, _, err := agentCommand("shell", "bypass", "/tmp/hook"); err == nil {
		t.Fatal("shell must reject bypass mode")
	}
}

func TestBrowserURLRequiresHTTP(t *testing.T) {
	for _, raw := range []string{"file:///etc/passwd", "javascript:alert(1)", "localhost:3000"} {
		if _, err := browserURL(raw); err == nil {
			t.Fatalf("expected rejection for %q", raw)
		}
	}
	if _, err := browserURL("http://localhost:3000"); err != nil {
		t.Fatal(err)
	}
}
