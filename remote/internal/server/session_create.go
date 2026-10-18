package server

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

// sessionCreateStore persists the idempotency key of every MCP-created terminal.
// A client retry after a lost or ambiguous HTTP response therefore resolves to
// the same session instead of spawning a duplicate. It stores only opaque ids
// and the requested destination, never prompts, credentials or file contents.
type sessionCreateStore struct {
	mu      sync.Mutex
	path    string
	records map[string]sessionCreateRecord
}

type sessionCreateRecord struct {
	Key       string    `json:"key"`
	Owner     string    `json:"owner"`
	Agent     string    `json:"agent"`
	Mode      string    `json:"mode"`
	Root      string    `json:"root"`
	SessionID string    `json:"sessionId"`
	State     string    `json:"state"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// maxCreationRecords bounds the durable idempotency registry. At capacity a new
// key is rejected (HTTP 503) instead of pruning an old key, because dropping a
// key would re-enable a duplicate terminal for the same request.
const maxCreationRecords = 500

var (
	createKeyPattern      = regexp.MustCompile(`^[0-9a-f]{32}$`)
	errCreateConflict     = errors.New("request key conflict")
	errCreateUncertain    = errors.New("creation outcome uncertain")
	errCreateUnavailable  = errors.New("idempotent creation unavailable")
	errCreateNonCanonical = errors.New("project root must be a canonical path")
	errCreateCapacity     = errors.New("creation capacity reached")
)

func recordOwnerKey(owner, key string) string { return owner + "\x00" + key }

// openSessionCreateStore loads the durable registry. A crash between persisting
// the intent and finishing the spawn is never retried automatically: the record
// becomes uncertain, exactly like the Hola mailbox.
func openSessionCreateStore(dir string) (*sessionCreateStore, error) {
	s := &sessionCreateStore{path: filepath.Join(dir, "bridge-session-creates.json"), records: make(map[string]sessionCreateRecord)}
	data, err := os.ReadFile(s.path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err == nil {
		if err = json.Unmarshal(data, &s.records); err != nil || s.records == nil {
			return nil, errors.New("invalid creation registry")
		}
		// Fail closed rather than truncate: dropping records would lose dedup.
		if len(s.records) > maxCreationRecords {
			return nil, errors.New("creation registry over capacity")
		}
		for id, record := range s.records {
			if id != recordOwnerKey(record.Owner, record.Key) || !createKeyPattern.MatchString(record.Key) || !createKeyPattern.MatchString(record.SessionID) ||
				(record.Agent != "claude" && record.Agent != "codex") || (record.Mode != "normal" && record.Mode != "bypass") || !strings.HasPrefix(record.Root, "/") || strings.ContainsAny(record.Root, "\x00\r\n") ||
				record.Owner == "" || record.CreatedAt.IsZero() || record.UpdatedAt.IsZero() {
				return nil, errors.New("invalid creation record")
			}
			switch record.State {
			case "pending":
				record.State, record.UpdatedAt = "uncertain", time.Now().UTC()
				s.records[id] = record
			case "created", "uncertain":
			default:
				return nil, errors.New("invalid creation state")
			}
		}
		if err = s.save(); err != nil {
			return nil, err
		}
	}
	return s, nil
}

func (s *sessionCreateStore) save() error {
	data, err := json.Marshal(s.records)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(s.path+".tmp", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err := os.Rename(s.path+".tmp", s.path); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		return nil
	} // Tests may run on Windows; crowd runs on Linux.
	directory, err := os.Open(filepath.Dir(s.path))
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func principalOwnerKey(principal *AccessPrincipal) string {
	if principal == nil {
		return "legacy"
	}
	return principal.Role + ":" + principal.ID
}

// failClosedRecord turns a record into an uncertain in-memory tombstone. It is
// used when the durable registry cannot be trusted, so a same-process retry must
// fail closed instead of spawning a second terminal under a new identity.
func failClosedRecord(record sessionCreateRecord) sessionCreateRecord {
	record.State = "uncertain"
	record.UpdatedAt = time.Now().UTC()
	return record
}

// startSessionReserved admits a creation under the serialized admission lock so
// the identity reserved before the side effect is the one actually spawned.
func (a *App) startSessionReserved(agent, mode, root string, principal *AccessPrincipal, reservedID string) (SessionInfo, error) {
	a.conversationStartMu.Lock()
	defer a.conversationStartMu.Unlock()
	return a.startSessionPromptIntent(agent, mode, root, principal, "", nil, reservedID)
}

// createSessionIdempotent creates a Claude/Codex terminal in normal or bypass
// permission mode keyed by (principal, request key). The key is tied to the
// requested agent/mode/root so a different payload conflicts, and the ambient
// principal/permitted-root checks inside startSessionPromptIntent are never
// bypassed. The root must already be canonical and the registry has a fixed
// fail-closed capacity. Bypass is signalled by the caller only after proving the
// runtime bypass capability; it still rejects any non-Claude/Codex agent, so a
// shell can never be created here.
func (a *App) createSessionIdempotent(key, agent, mode, root string, principal *AccessPrincipal) (SessionInfo, error) {
	store := a.sessionCreates
	if store == nil {
		return SessionInfo{}, errCreateUnavailable
	}
	if !createKeyPattern.MatchString(key) {
		return SessionInfo{}, errors.New("invalid request key")
	}
	if agent != "claude" && agent != "codex" {
		return SessionInfo{}, errors.New("unsupported agent")
	}
	// Only normal or bypass are valid; bypass never applies to a shell, and the
	// agent allow-list above already excludes shell/agy from idempotent creation.
	if mode != "normal" && mode != "bypass" {
		return SessionInfo{}, errors.New("invalid permission mode")
	}
	owner := principalOwnerKey(principal)
	composite := recordOwnerKey(owner, key)
	// Serialize the whole check-and-create so concurrent duplicates share a key.
	store.mu.Lock()
	defer store.mu.Unlock()
	if record, ok := store.records[composite]; ok {
		if record.Agent != agent || record.Mode != mode || record.Root != root {
			return SessionInfo{}, errCreateConflict
		}
		// Return the original session if it is still live; never spawn a second.
		if s := a.session(record.SessionID); s != nil {
			return s.snapshot(), nil
		}
		if record.State == "created" {
			return SessionInfo{}, errors.New("created terminal no longer exists")
		}
		return SessionInfo{}, errCreateUncertain
	}
	// Bind the requested root exactly before persisting the intent or spawning.
	// startSessionPromptIntent resolves the folder with Abs+EvalSymlinks, so a
	// symlinked, `..`, or otherwise non-canonical root would otherwise spawn a
	// terminal whose reported root the caller cannot correlate, leaving a
	// process that verification rejects. Fail closed with zero side effects.
	if canonicalRoot, err := canonical(root); err != nil || canonicalRoot != root {
		return SessionInfo{}, errCreateNonCanonical
	}
	if len(store.records) >= maxCreationRecords {
		return SessionInfo{}, errCreateCapacity
	}
	id, err := randomID()
	if err != nil {
		return SessionInfo{}, err
	}
	now := time.Now().UTC()
	record := sessionCreateRecord{Key: key, Owner: owner, Agent: agent, Mode: mode, Root: root, SessionID: id, State: "pending", CreatedAt: now, UpdatedAt: now}
	store.records[composite] = record
	if err := store.save(); err != nil {
		// save() may have renamed the new file before a directory fsync failed, so
		// disk might already hold the intent. Keep a fail-closed in-memory
		// tombstone instead of freeing a key that could still be durable.
		store.records[composite] = failClosedRecord(record)
		return SessionInfo{}, err
	}
	info, err := a.startSessionReserved(agent, mode, root, principal, id)
	if err != nil {
		// Validation or spawn failure usually means no terminal exists, so try to
		// release the key. If that release cannot be durably saved, keep a
		// fail-closed tombstone so a same-process retry cannot spawn a second
		// terminal while disk may still hold the pending record.
		delete(store.records, composite)
		if saveErr := store.save(); saveErr != nil {
			store.records[composite] = failClosedRecord(record)
			return SessionInfo{}, saveErr
		}
		return SessionInfo{}, err
	}
	record.State, record.SessionID, record.UpdatedAt = "created", info.ID, time.Now().UTC()
	store.records[composite] = record
	if err := store.save(); err != nil {
		return SessionInfo{}, err
	}
	return info, nil
}
