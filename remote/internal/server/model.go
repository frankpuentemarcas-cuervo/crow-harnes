package server

import "time"

type SessionInfo struct {
	ReadOnly        bool         `json:"readOnly,omitempty"`
	OwnerID         string       `json:"ownerId,omitempty"`
	ID              string       `json:"id"`
	Agent           string       `json:"agent"`
	Mode            string       `json:"mode"`
	Root            string       `json:"root"`
	State           string       `json:"state"`
	AgentState      string       `json:"agentState,omitempty"`
	HooksActive     bool         `json:"hooksActive,omitempty"`
	CacheTTLSeconds int          `json:"cacheTtlSeconds,omitempty"`
	CacheExpiresAt  *time.Time   `json:"cacheExpiresAt,omitempty"`
	PromptCache     *PromptCache `json:"promptCache,omitempty"`
	StartedAt       time.Time    `json:"startedAt"`
	UpdatedAt       time.Time    `json:"updatedAt"`
	Seq             uint64       `json:"seq"`
	ExitCode        *int         `json:"exitCode,omitempty"`
}

type Frame struct {
	Type string       `json:"type"`
	Seq  uint64       `json:"seq,omitempty"`
	Data string       `json:"data,omitempty"`
	Info *SessionInfo `json:"info,omitempty"`
}

type Event struct {
	ID                string    `json:"id"`
	Seq               uint64    `json:"seq"`
	SessionID         string    `json:"sessionId"`
	Kind              string    `json:"kind"`
	RequiresAttention bool      `json:"requiresAttention,omitempty"`
	At                time.Time `json:"at"`
}
