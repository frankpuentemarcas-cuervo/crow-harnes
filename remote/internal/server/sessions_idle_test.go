package server

import (
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestIdleCandidateRequiresCompletedWorkAndThirtyMinutes(t *testing.T) {
	now := time.Now().UTC()
	tests := []struct {
		name       string
		agent      string
		agentState string
		state      string
		idle       time.Duration
		want       bool
	}{
		{"Claude waiting after 30m", "claude", "waiting", "running", 31 * time.Minute, true},
		{"Codex waiting after 30m", "codex", "waiting", "running", 31 * time.Minute, true},
		{"Claude still working", "claude", "working", "running", 31 * time.Minute, false},
		{"Claude waiting but recent output", "claude", "waiting", "running", 29 * time.Minute, false},
		{"Antigravity status unknown", "agy", "waiting", "running", 31 * time.Minute, false},
		{"Already sleeping", "claude", "waiting", "sleeping", 31 * time.Minute, false},
		{"Shell awaits process check", "shell", "unknown", "running", 31 * time.Minute, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := &session{info: SessionInfo{Agent: tt.agent, AgentState: tt.agentState, State: tt.state, HooksActive: true}, lastActivity: now.Add(-tt.idle), cmd: &exec.Cmd{Process: &os.Process{Pid: 123}}}
			if got := s.idleCandidate(now); got != tt.want {
				t.Fatalf("got %v, want %v", got, tt.want)
			}
		})
	}
}

func TestTurnCompleteMarksAgentCompleted(t *testing.T) {
	id := "test"
	s := &session{info: SessionInfo{ID: id, State: "running", Agent: "claude", AgentState: "working", HooksActive: true, CacheTTLSeconds: 300}, subs: make(map[chan Frame]struct{})}
	a := &App{sessions: map[string]*session{id: s}}
	a.markAgentState(id, "completed")
	if got := s.snapshot().AgentState; got != "completed" {
		t.Fatalf("got %q", got)
	}
	if s.lastActivity.IsZero() {
		t.Fatal("completion did not reset inactivity timer")
	}
	if s.snapshot().CacheExpiresAt == nil {
		t.Fatal("completion did not start cache estimate")
	}
}
