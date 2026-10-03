package server

import "testing"

func TestRequiresAttentionUsesExplicitRequestsNotQuestionMarks(t *testing.T) {
	tests := []struct {
		name    string
		message string
		want    bool
	}{
		{name: "Spanish approval request", message: "No puedo continuar hasta que me confirmes si apruebas el cambio.", want: true},
		{name: "Spanish choice request", message: "¿Cuál opción preferís?", want: true},
		{name: "English confirmation request", message: "Could you please confirm which server I should use?", want: true},
		{name: "English waiting state", message: "I am waiting for your approval before I deploy.", want: true},
		{name: "question mark alone", message: "The command returned 0. What happened?", want: false},
		{name: "subagent launch update", message: "I launched the subagent; it is still working in the background.", want: false},
		{name: "completed informational response", message: "Implemented the changes and all tests passed.", want: false},
		{name: "negated request", message: "No necesito que confirmes nada; ya quedó configurado.", want: false},
		{name: "request quoted in markdown", message: "> Please approve the deployment\nDeployment completed successfully.", want: false},
		{name: "request inside code block", message: "Example:\n```text\nPlease approve this\n```\nThe example is documented.", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := requiresAttention(tt.message); got != tt.want {
				t.Fatalf("requiresAttention(%q) = %v, want %v", tt.message, got, tt.want)
			}
		})
	}
}

func TestHookAssistantMessageSupportsClaudeAndCodexFields(t *testing.T) {
	tests := []struct {
		payload string
		want    string
	}{
		{payload: `{"last_assistant_message":"Claude response"}`, want: "Claude response"},
		{payload: `{"last-assistant-message":"Codex response"}`, want: "Codex response"},
		{payload: `{"lastAssistantMessage":"Compatible response"}`, want: "Compatible response"},
		{payload: `{"message":"not the final assistant message"}`, want: ""},
	}
	for _, tt := range tests {
		if got := hookAssistantMessage([]byte(tt.payload)); got != tt.want {
			t.Errorf("hookAssistantMessage(%s) = %q, want %q", tt.payload, got, tt.want)
		}
	}
}
