package server

import "time"

type SessionInfo struct {
	ID        string    `json:"id"`
	Agent     string    `json:"agent"`
	Mode      string    `json:"mode"`
	Root      string    `json:"root"`
	State     string    `json:"state"`
	StartedAt time.Time `json:"startedAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	Seq       uint64    `json:"seq"`
	ExitCode  *int      `json:"exitCode,omitempty"`
}

type Frame struct {
	Type string       `json:"type"`
	Seq  uint64       `json:"seq,omitempty"`
	Data string       `json:"data,omitempty"`
	Info *SessionInfo `json:"info,omitempty"`
}

type Event struct {
	ID        string    `json:"id"`
	Seq       uint64    `json:"seq"`
	SessionID string    `json:"sessionId"`
	Kind      string    `json:"kind"`
	At        time.Time `json:"at"`
}
