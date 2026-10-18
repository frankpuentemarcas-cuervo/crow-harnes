package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestIdempotentCreationReplaysAndRejectsDifferentPayload(t *testing.T) {
	a, _, p, _ := claudeFixture(t)
	var err error
	a.sessionCreates, err = openSessionCreateStore(a.dir)
	if err != nil {
		t.Fatal(err)
	}
	calls := installFakeClaude(t, a, nil)
	key := strings.Repeat("a", 32)
	root := p.AllowedRoots[0]
	first, err := a.createSessionIdempotent(key, "claude", "normal", root, p)
	if err != nil {
		t.Fatal(err)
	}
	if *calls != 1 {
		t.Fatalf("expected one spawn, got %d", *calls)
	}
	// A retry with the same key and payload returns the original session.
	second, err := a.createSessionIdempotent(key, "claude", "normal", root, p)
	if err != nil {
		t.Fatal(err)
	}
	if second.ID != first.ID || *calls != 1 {
		t.Fatalf("replay spawned a duplicate: %s vs %s (%d)", second.ID, first.ID, *calls)
	}
	if _, err := a.createSessionIdempotent(key, "codex", "normal", root, p); !errors.Is(err, errCreateConflict) {
		t.Fatalf("different agent not rejected: %v", err)
	}
	if _, err := a.createSessionIdempotent(key, "claude", "normal", "/different-root", p); !errors.Is(err, errCreateConflict) {
		t.Fatalf("different root not rejected: %v", err)
	}
	if _, err := a.createSessionIdempotent(key, "shell", "normal", root, p); err == nil {
		t.Fatal("shell agent accepted")
	}
	// A key already bound to normal mode must treat bypass as a different
	// payload: conflict, never a second terminal.
	if _, err := a.createSessionIdempotent(key, "claude", "bypass", root, p); !errors.Is(err, errCreateConflict) {
		t.Fatalf("mode change on a bound key not rejected: %v", err)
	}
	// An unknown mode is rejected before any side effect.
	if _, err := a.createSessionIdempotent(strings.Repeat("7", 32), "claude", "sandbox", root, p); err == nil {
		t.Fatal("invalid mode accepted")
	}
	if _, err := a.createSessionIdempotent("not-a-valid-key", "claude", "normal", root, p); err == nil {
		t.Fatal("misformed key accepted")
	}
	// The key is bound to the principal: another identity cannot replay it.
	other := &AccessPrincipal{ID: "bob", Role: "member", AllowedRoots: []string{root}}
	otherSession, err := a.createSessionIdempotent(key, "claude", "normal", root, other)
	if err != nil {
		t.Fatalf("per-principal key collided: %v", err)
	}
	if *calls != 2 {
		t.Fatalf("cross-principal key shared a session: %d", *calls)
	}
	// Stop every synthetic session deterministically: the kill-only cleanup
	// races the async terminal.Close() against t.TempDir() removal on Windows.
	stopSyntheticClaude(t, a, first.ID)
	stopSyntheticClaude(t, a, otherSession.ID)
}

func TestCreationRegistryRecoversPendingAsUncertain(t *testing.T) {
	dir := t.TempDir()
	s, err := openSessionCreateStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	// Simulate a crash after persisting the intent but before recording success.
	now := time.Now().UTC()
	key, owner := strings.Repeat("b", 32), "member:alice"
	s.records[recordOwnerKey(owner, key)] = sessionCreateRecord{Key: key, Owner: owner, Agent: "claude", Mode: "normal", Root: "/project", SessionID: strings.Repeat("c", 32), State: "pending", CreatedAt: now, UpdatedAt: now}
	if err := s.save(); err != nil {
		t.Fatal(err)
	}
	reopened, err := openSessionCreateStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if record := reopened.records[recordOwnerKey(owner, key)]; record.State != "uncertain" {
		t.Fatalf("pending not converted to uncertain: %q", record.State)
	}
	// A corrupt registry must fail closed rather than lose deduplication.
	if err := os.WriteFile(filepath.Join(dir, "bridge-session-creates.json"), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := openSessionCreateStore(dir); err == nil {
		t.Fatal("corrupt creation registry accepted")
	}
}

func TestIdempotentCreationOverHTTP(t *testing.T) {
	a, _, p, _ := claudeFixture(t)
	var err error
	a.sessionCreates, err = openSessionCreateStore(a.dir)
	if err != nil {
		t.Fatal(err)
	}
	calls := installFakeClaude(t, a, nil)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/sessions", a.handleSessions)
	h := a.auth(mux)
	key := strings.Repeat("d", 32)
	body, _ := json.Marshal(map[string]string{"agent": "claude", "mode": "normal", "root": p.AllowedRoots[0], "requestKey": key})
	w := accessRequest(h, "alice-token", "POST", "/api/sessions", string(body))
	if w.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", w.Code, w.Body)
	}
	var first SessionInfo
	if err := json.Unmarshal(w.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	w = accessRequest(h, "alice-token", "POST", "/api/sessions", string(body))
	if w.Code != http.StatusCreated {
		t.Fatalf("replay: %d %s", w.Code, w.Body)
	}
	var second SessionInfo
	if err := json.Unmarshal(w.Body.Bytes(), &second); err != nil {
		t.Fatal(err)
	}
	if second.ID != first.ID || *calls != 1 {
		t.Fatalf("replay duplicate: %s vs %s (%d)", second.ID, first.ID, *calls)
	}
	conflict, _ := json.Marshal(map[string]string{"agent": "codex", "mode": "normal", "root": p.AllowedRoots[0], "requestKey": key})
	if w := accessRequest(h, "alice-token", "POST", "/api/sessions", string(conflict)); w.Code != http.StatusConflict {
		t.Fatalf("conflict: %d %s", w.Code, w.Body)
	}
	// A foreign root is still rejected by the ambient permitted-root check.
	foreign, _ := json.Marshal(map[string]string{"agent": "claude", "mode": "normal", "root": "/etc", "requestKey": strings.Repeat("e", 32)})
	if w := accessRequest(h, "bob-token", "POST", "/api/sessions", string(foreign)); w.Code != http.StatusForbidden {
		t.Fatalf("foreign root: %d %s", w.Code, w.Body)
	}
	stopSyntheticClaude(t, a, first.ID)
}

func TestIdempotentCreationConcurrentSameKeySpawnsOnce(t *testing.T) {
	a, _, p, _ := claudeFixture(t)
	var err error
	a.sessionCreates, err = openSessionCreateStore(a.dir)
	if err != nil {
		t.Fatal(err)
	}
	calls := installFakeClaude(t, a, nil)
	key, root := strings.Repeat("f", 32), p.AllowedRoots[0]
	// Serialized admission must make concurrent duplicates share one record,
	// one server key and exactly one spawn.
	const racers = 8
	results := make([]SessionInfo, racers)
	errs := make([]error, racers)
	var wg sync.WaitGroup
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = a.createSessionIdempotent(key, "claude", "normal", root, p)
		}(i)
	}
	wg.Wait()
	for i := 0; i < racers; i++ {
		if errs[i] != nil {
			t.Fatalf("racer %d failed: %v", i, errs[i])
		}
		if results[i].ID != results[0].ID {
			t.Fatalf("racer %d got a different session: %s vs %s", i, results[i].ID, results[0].ID)
		}
	}
	if *calls != 1 {
		t.Fatalf("concurrent same-key creation spawned %d terminals", *calls)
	}
	stopSyntheticClaude(t, a, results[0].ID)
}

func TestIdempotentCreationRejectsNonCanonicalRootBeforeSideEffects(t *testing.T) {
	a, _, p, _ := claudeFixture(t)
	var err error
	a.sessionCreates, err = openSessionCreateStore(a.dir)
	if err != nil {
		t.Fatal(err)
	}
	calls := installFakeClaude(t, a, nil)
	root := p.AllowedRoots[0]
	link := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(root, link); err != nil {
		if runtime.GOOS == "windows" {
			t.Skip("symlink creation requires privileges on Windows")
		}
		t.Fatal(err)
	}
	// A symlinked view of an approved root is not the approved root: fail
	// closed before persisting any intent or spawning any process.
	if _, err := a.createSessionIdempotent(strings.Repeat("9", 32), "claude", "normal", link, p); !errors.Is(err, errCreateNonCanonical) {
		t.Fatalf("non-canonical root accepted: %v", err)
	}
	if *calls != 0 {
		t.Fatalf("non-canonical root spawned %d terminals", *calls)
	}
	if len(a.sessionCreates.records) != 0 {
		t.Fatalf("non-canonical root persisted %d records", len(a.sessionCreates.records))
	}
}

func TestIdempotentCreationCapacityFailsClosed(t *testing.T) {
	a, _, p, _ := claudeFixture(t)
	store, err := openSessionCreateStore(a.dir)
	if err != nil {
		t.Fatal(err)
	}
	a.sessionCreates = store
	calls := installFakeClaude(t, a, nil)
	owner, now := principalOwnerKey(p), time.Now().UTC()
	for i := 0; i < maxCreationRecords; i++ {
		key := fmt.Sprintf("%032x", i)
		store.records[recordOwnerKey(owner, key)] = sessionCreateRecord{Key: key, Owner: owner, Agent: "claude", Mode: "normal", Root: p.AllowedRoots[0], SessionID: fmt.Sprintf("%032x", i+1), State: "uncertain", CreatedAt: now, UpdatedAt: now}
	}
	// At capacity a new key is rejected instead of pruning an old one, because
	// dropping a key would re-enable a duplicate terminal for that request.
	if _, err := a.createSessionIdempotent(strings.Repeat("e", 32), "claude", "normal", p.AllowedRoots[0], p); !errors.Is(err, errCreateCapacity) {
		t.Fatalf("capacity not enforced: %v", err)
	}
	if *calls != 0 {
		t.Fatalf("capacity overflow spawned %d terminals", *calls)
	}
	if len(store.records) != maxCreationRecords {
		t.Fatalf("records pruned or added at capacity: %d", len(store.records))
	}
}

func TestIdempotentCreationKeepsUncertainTombstoneWhenPersistFails(t *testing.T) {
	a, _, p, _ := claudeFixture(t)
	store, err := openSessionCreateStore(a.dir)
	if err != nil {
		t.Fatal(err)
	}
	a.sessionCreates = store
	calls := installFakeClaude(t, a, nil)
	// Break persistence: the registry path now points into a missing directory.
	store.path = filepath.Join(a.dir, "missing", "bridge-session-creates.json")
	key, root := strings.Repeat("1", 32), p.AllowedRoots[0]
	if _, err := a.createSessionIdempotent(key, "claude", "normal", root, p); err == nil {
		t.Fatal("persist failure ignored")
	}
	// Disk may still hold the pending intent, so the in-memory record must
	// become a fail-closed tombstone instead of freeing the key.
	composite := recordOwnerKey(principalOwnerKey(p), key)
	record, ok := store.records[composite]
	if !ok || record.State != "uncertain" {
		t.Fatalf("missing fail-closed tombstone: %+v", record)
	}
	if *calls != 0 {
		t.Fatalf("spawn happened despite failed persist: %d", *calls)
	}
	// A same-process retry must fail closed instead of spawning a duplicate.
	if _, err := a.createSessionIdempotent(key, "claude", "normal", root, p); !errors.Is(err, errCreateUncertain) {
		t.Fatalf("retry after persist failure: %v", err)
	}
	if *calls != 0 {
		t.Fatalf("retry spawned a duplicate: %d", *calls)
	}
}

func TestIdempotentCreationSupportsBypassMode(t *testing.T) {
	a, _, p, _ := claudeFixture(t)
	var err error
	a.sessionCreates, err = openSessionCreateStore(a.dir)
	if err != nil {
		t.Fatal(err)
	}
	var spawnedArgs string
	calls := installFakeClaude(t, a, func(cmd *exec.Cmd) { spawnedArgs = strings.Join(cmd.Args, " ") })
	key, root := strings.Repeat("3", 32), p.AllowedRoots[0]
	first, err := a.createSessionIdempotent(key, "claude", "bypass", root, p)
	if err != nil {
		t.Fatal(err)
	}
	if first.Mode != "bypass" {
		t.Fatalf("created terminal not in bypass mode: %q", first.Mode)
	}
	if !strings.Contains(spawnedArgs, "dangerously") {
		t.Fatalf("bypass spawn missing explicit flag: %s", spawnedArgs)
	}
	if *calls != 1 {
		t.Fatalf("expected one spawn, got %d", *calls)
	}
	// A retry with the same key and payload replays the same bypass terminal.
	second, err := a.createSessionIdempotent(key, "claude", "bypass", root, p)
	if err != nil || second.ID != first.ID || *calls != 1 {
		t.Fatalf("bypass replay duplicated: %v %s vs %s (%d)", err, second.ID, first.ID, *calls)
	}
	// The bypass mode must survive a registry reload so a restart cannot
	// silently downgrade the destination to normal. The store only accepts
	// POSIX-absolute roots (crowd runs on Linux), so skip the reload on
	// Windows where a real canonical root is drive-lettered.
	if runtime.GOOS != "windows" {
		reopened, err := openSessionCreateStore(a.dir)
		if err != nil {
			t.Fatal(err)
		}
		if record := reopened.records[recordOwnerKey(principalOwnerKey(p), key)]; record.Mode != "bypass" || record.State != "created" {
			t.Fatalf("bypass mode not persisted: %+v", record)
		}
	}
	stopSyntheticClaude(t, a, first.ID)
}

func TestBypassCreationOverHTTPIsModeBound(t *testing.T) {
	a, _, p, _ := claudeFixture(t)
	var err error
	a.sessionCreates, err = openSessionCreateStore(a.dir)
	if err != nil {
		t.Fatal(err)
	}
	calls := installFakeClaude(t, a, nil)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/sessions", a.handleSessions)
	h := a.auth(mux)
	key := strings.Repeat("8", 32)
	body, _ := json.Marshal(map[string]string{"agent": "claude", "mode": "bypass", "root": p.AllowedRoots[0], "requestKey": key})
	w := accessRequest(h, "alice-token", "POST", "/api/sessions", string(body))
	if w.Code != http.StatusCreated {
		t.Fatalf("bypass create: %d %s", w.Code, w.Body)
	}
	var first SessionInfo
	if err := json.Unmarshal(w.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	if first.Mode != "bypass" {
		t.Fatalf("HTTP create not bypass: %q", first.Mode)
	}
	// The same key bound to normal mode is a payload conflict over HTTP too.
	normal, _ := json.Marshal(map[string]string{"agent": "claude", "mode": "normal", "root": p.AllowedRoots[0], "requestKey": key})
	if w := accessRequest(h, "alice-token", "POST", "/api/sessions", string(normal)); w.Code != http.StatusConflict {
		t.Fatalf("mode change over HTTP not rejected: %d %s", w.Code, w.Body)
	}
	if *calls != 1 {
		t.Fatalf("bypass HTTP path spawned %d terminals", *calls)
	}
	stopSyntheticClaude(t, a, first.ID)
}

func TestHealthAdvertisesCreationCapabilities(t *testing.T) {
	// A legacy runtime without the idempotent store advertises zero for both
	// creation capabilities, so a client never POSTs creation (normal or
	// bypass) to an older crowd that would ignore the request key.
	legacy := &App{}
	w := httptest.NewRecorder()
	legacy.health(w, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	var legacyBody map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &legacyBody); err != nil {
		t.Fatal(err)
	}
	if legacyBody["bridgeCreateVersion"] != float64(0) || legacyBody["bridgeCreateBypassVersion"] != float64(0) {
		t.Fatalf("legacy runtime advertised creation: %v", legacyBody)
	}
	// A capable runtime advertises bypass alongside normal creation so the
	// bridge can distinguish "can create" from "can create bypass".
	a, _, _, _ := claudeFixture(t)
	var err error
	a.sessionCreates, err = openSessionCreateStore(a.dir)
	if err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	a.health(w, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	var capableBody map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &capableBody); err != nil {
		t.Fatal(err)
	}
	if capableBody["bridgeCreateVersion"] != float64(1) || capableBody["bridgeCreateBypassVersion"] != float64(1) {
		t.Fatalf("capable runtime did not advertise bypass: %v", capableBody)
	}
}
