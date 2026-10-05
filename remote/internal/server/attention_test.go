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
		{name: "reported Claude authorization request", message: "Los tests pasan 18 de 18. La auditoría está frenada por las credenciales.\n\n¿Me autorizás a resetear las contraseñas de Administrator y de los cinco usuarios de prueba?", want: true},
		{name: "Spanish tuteo authorization request", message: "¿Me autorizas a resetear las contraseñas para esta sesión?", want: true},
		{name: "Spanish authorization without pronoun", message: "¿Autorizás que cambie las contraseñas de prueba?", want: true},
		{name: "Spanish explicit permission request", message: "¿Me das permiso para cambiar las credenciales de prueba?", want: true},
		{name: "negated Spanish authorization", message: "No me autorizás a resetear las contraseñas, así que no las tocaré.", want: false},
		{name: "past Spanish authorization", message: "Me autorizaste a resetear las contraseñas y ya terminé.", want: false},
		{name: "Spanish authorization quoted", message: "> ¿Me autorizás a resetear las contraseñas?\nEsta es una cita del diálogo anterior.", want: false},
		{name: "Spanish authorization in code block", message: "Ejemplo:\n```text\n¿Me autorizás a resetear las contraseñas?\n```", want: false},
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
