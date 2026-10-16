package server

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const maxClaudeTranscriptTail = 2 * 1024 * 1024

// Read only the provider session named by a local Claude hook, never a path
// supplied by the mobile API. Bound I/O even when the provider log is huge.
func claudeTranscriptMessage(payload []byte, configDir string) (string, string) {
	var hook struct {
		SessionID string `json:"session_id"`
		Path      string `json:"transcript_path"`
	}
	if json.Unmarshal(payload, &hook) != nil || hook.SessionID == "" || len(hook.SessionID) > 160 || strings.ContainsAny(hook.SessionID, "/\\.\x00\r\n") || !filepath.IsAbs(hook.Path) || filepath.Base(hook.Path) != hook.SessionID+".jsonl" {
		return "", ""
	}
	root, err := filepath.Abs(filepath.Join(configDir, "projects"))
	if err != nil {
		return "", ""
	}
	rel, err := filepath.Rel(root, hook.Path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", ""
	}
	canonicalRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", ""
	}
	path, err := filepath.EvalSymlinks(hook.Path)
	if err != nil || path != filepath.Join(canonicalRoot, rel) {
		return "", ""
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", ""
	}
	file, err := os.Open(path)
	if err != nil {
		return "", ""
	}
	defer file.Close()
	opened, err := file.Stat()
	current, pathErr := os.Lstat(path)
	if err != nil || pathErr != nil || !os.SameFile(info, opened) || !os.SameFile(opened, current) {
		return "", ""
	}
	offset := opened.Size() - maxClaudeTranscriptTail
	if offset < 0 {
		offset = 0
	}
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return "", ""
	}
	scan := bufio.NewScanner(io.LimitReader(file, maxClaudeTranscriptTail))
	scan.Buffer(make([]byte, 4096), maxClaudeTranscriptTail)
	if offset > 0 {
		var previous [1]byte
		if _, err := file.ReadAt(previous[:], offset-1); err != nil {
			return "", ""
		}
		if previous[0] != '\n' {
			scan.Scan()
		}
	} // Discard the possibly partial first JSONL record.
	var text, source string
	for scan.Scan() {
		var record struct {
			Type      string `json:"type"`
			UUID      string `json:"uuid"`
			Sidechain bool   `json:"isSidechain"`
			Message   struct {
				ID      string `json:"id"`
				Role    string `json:"role"`
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(scan.Bytes(), &record) != nil || record.Type != "assistant" || record.Sidechain || record.Message.Role != "assistant" {
			continue
		}
		var parts []string
		for _, block := range record.Message.Content {
			if block.Type == "text" && strings.TrimSpace(block.Text) != "" {
				parts = append(parts, block.Text)
			}
		}
		if len(parts) == 0 {
			continue
		}
		id := record.UUID
		if id == "" {
			id = record.Message.ID
		}
		if id == "" || len(id) > 200 || strings.ContainsAny(id, "\x00\r\n") {
			continue
		}
		text, source = strings.Join(parts, "\n"), id
	}
	if scan.Err() != nil {
		return "", ""
	}
	return text, source
}

// Preserve direct Stop payloads, but recover text and a stable deduplication
// identity from the transcript when resuming or on older Claude hook schemas.
func claudeHookMessage(payload []byte) (string, string) {
	message, source := hookAssistantMessage(payload), hookEventID(payload)
	if message != "" && source != "" {
		return message, source
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return message, source
	}
	config := os.Getenv("CLAUDE_CONFIG_DIR")
	if config == "" {
		config = filepath.Join(home, ".claude")
	}
	text, id := claudeTranscriptMessage(payload, config)
	if message == "" {
		return text, id
	}
	if source == "" && message == text {
		source = id
	}
	return message, source
}
