package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type AccessPrincipal struct {
	ID            string   `json:"id"`
	Label         string   `json:"label"`
	Role          string   `json:"role"`
	OperateOthers bool     `json:"operateOthers"`
	AllowedRoots  []string `json:"allowedRoots"`
	Revoked       bool     `json:"revoked,omitempty"`
}
type accessUser struct {
	AccessPrincipal
	Hash string `json:"hash"`
}
type accessFile struct {
	Enabled bool         `json:"enabled"`
	Users   []accessUser `json:"users"`
}
type accessContextKey struct{}
type hookContextKey struct{}
type accessState struct {
	mu     sync.Mutex
	data   accessFile
	active map[string]map[*context.CancelFunc]struct{}
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
func (a *App) loadAccess() error {
	data, err := os.ReadFile(filepath.Join(a.dir, "access.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var value accessFile
	if err = json.Unmarshal(data, &value); err != nil {
		return err
	}
	ids := map[string]bool{}
	admins := 0
	for _, u := range value.Users {
		if !safeID(u.ID) || ids[u.ID] || len(u.Hash) != 64 || (u.Role != "admin" && u.Role != "member") {
			return errors.New("invalid access registry")
		}
		if _, err := hex.DecodeString(u.Hash); err != nil {
			return errors.New("invalid credential hash")
		}
		if u.Role == "member" && u.OperateOthers {
			return errors.New("invalid member permissions")
		}
		for _, root := range u.AllowedRoots {
			if !filepath.IsAbs(root) {
				return errors.New("invalid allowed root")
			}
			path, err := canonical(root)
			if err != nil || path != root || !a.permittedRoot(&AccessPrincipal{Role: "admin"}, root) {
				return errors.New("invalid allowed root")
			}
		}
		ids[u.ID] = true
		if u.Role == "admin" && !u.Revoked {
			admins++
		}
	}
	if !value.Enabled || admins == 0 {
		return errors.New("invalid access registry")
	}
	a.access.data = value
	return nil
}
func (a *App) saveAccessLocked(value accessFile) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	path := filepath.Join(a.dir, "access.json")
	if err = writeDurableRegistry(path, data); err != nil {
		// A directory fsync error can follow a completed rename. Keep the in-memory
		// mode consistent with the visible registry instead of reopening bootstrap.
		if persisted, readErr := os.ReadFile(path); readErr == nil {
			var current accessFile
			if json.Unmarshal(persisted, &current) == nil && current.Enabled {
				a.access.data = current
			}
		}
		return err
	}
	a.access.data = value
	return nil
}
func (a *App) accessEnabled() bool {
	a.access.mu.Lock()
	defer a.access.mu.Unlock()
	return a.access.data.Enabled
}
func requestPrincipal(r *http.Request) *AccessPrincipal {
	p, _ := r.Context().Value(accessContextKey{}).(*AccessPrincipal)
	return p
}
func (a *App) principalCurrent(p *AccessPrincipal) bool {
	if p == nil {
		return !a.accessEnabled()
	}
	a.access.mu.Lock()
	defer a.access.mu.Unlock()
	for _, u := range a.access.data.Users {
		if u.ID == p.ID {
			return !u.Revoked
		}
	}
	return false
}
func (a *App) visible(p *AccessPrincipal, info SessionInfo) bool {
	return p == nil || p.Role == "admin" || info.OwnerID == p.ID
}
func (a *App) operable(p *AccessPrincipal, info SessionInfo) bool {
	return p == nil || info.OwnerID == p.ID || (p.Role == "admin" && p.OperateOthers)
}
func (a *App) sessionPermission(r *http.Request, id string, write bool) bool {
	p := requestPrincipal(r)
	if !a.principalCurrent(p) {
		return false
	}
	s := a.session(id)
	if s == nil {
		return false
	}
	info := s.snapshot()
	if write {
		return a.operable(p, info)
	}
	return a.visible(p, info)
}
func contained(base, path string) bool {
	rel, err := filepath.Rel(base, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
func canonical(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(abs)
}
func (a *App) permittedRoot(p *AccessPrincipal, root string) bool {
	if p == nil {
		return true
	}
	path, err := canonical(root)
	if err != nil {
		return false
	}
	state, err := canonical(a.dir)
	if err != nil {
		return false
	}
	// Reject ancestors too: a broad home/root grant must not expose Crow's secrets.
	if contained(path, state) || contained(state, path) {
		return false
	}
	if p.Role == "admin" {
		return true
	}
	for _, allowed := range p.AllowedRoots {
		base, err := canonical(allowed)
		if err == nil && contained(base, path) {
			return true
		}
	}
	return false
}
func (a *App) accessAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" && (r.URL.Path == "/api/access" || r.URL.Path == "/api/health") {
			if r.URL.Path == "/api/access" {
				jsonResponse(w, 200, map[string]any{"enabled": a.accessEnabled(), "credentialRequired": a.accessEnabled(), "version": 1})
				return
			}
			a.health(w, r)
			return
		}
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		a.access.mu.Lock()
		enabled := a.access.data.Enabled
		var principal *AccessPrincipal
		if enabled {
			hash := tokenHash(token)
			for _, u := range a.access.data.Users {
				if !u.Revoked && subtle.ConstantTimeCompare([]byte(hash), []byte(u.Hash)) == 1 {
					copy := u.AccessPrincipal
					principal = &copy
					break
				}
			}
		}
		a.access.mu.Unlock()
		if !enabled {
			if len(token) != len(a.token) || subtle.ConstantTimeCompare([]byte(token), []byte(a.token)) != 1 {
				http.Error(w, "unauthorized", 401)
				return
			}
			if strings.HasPrefix(r.URL.Path, "/api/access/") && r.URL.Path != "/api/access/enable" && r.URL.Path != "/api/access/me" {
				http.Error(w, "activate individual access first", 403)
				return
			}
			if r.URL.Path == "/api/access/enable" {
				next.ServeHTTP(w, r)
				return
			}
			tracked, cleanup, err := a.trackAccessRequest(r, "legacy", true)
			if err != nil {
				http.Error(w, "individual credential required", 401)
				return
			}
			defer cleanup()
			if strings.HasSuffix(tracked.URL.Path, "/stream") {
				next.ServeHTTP(w, tracked)
			} else {
				next.ServeHTTP(accessResponseWriter{ResponseWriter: w, ctx: tracked.Context()}, tracked)
			}
			return
		}
		if principal == nil {
			// A hook credential can only submit telemetry for its single session, never list.
			a.mu.RLock()
			hookSession := ""
			hash := tokenHash(token)
			for id, s := range a.sessions {
				s.mu.Lock()
				match := s.hookHash != "" && subtle.ConstantTimeCompare([]byte(hash), []byte(s.hookHash)) == 1
				owner := s.info.OwnerID
				s.mu.Unlock()
				if match {
					hookSession = id
					_ = owner
					break
				}
			}
			a.mu.RUnlock()
			if hookSession != "" && r.Method == "POST" && (r.URL.Path == "/api/events" || r.URL.Path == "/api/sessions/"+hookSession+"/cache") {
				s := a.session(hookSession)
				if s == nil {
					http.Error(w, "terminal unavailable", 401)
					return
				}
				owner := s.snapshot().OwnerID
				a.access.mu.Lock()
				valid := false
				for _, u := range a.access.data.Users {
					if u.ID == owner && !u.Revoked {
						valid = true
					}
				}
				a.access.mu.Unlock()
				if valid {
					data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2*1024*1024))
					if err != nil {
						http.Error(w, "invalid telemetry", 400)
						return
					}
					var body struct {
						SessionID string `json:"sessionId"`
					}
					if r.URL.Path == "/api/events" && (json.Unmarshal(data, &body) != nil || body.SessionID != hookSession) {
						http.Error(w, "forbidden", 403)
						return
					}
					r.Body = io.NopCloser(bytes.NewReader(data))
					next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), hookContextKey{}, hookSession)))
					return
				}
			}
			http.Error(w, "individual credential required", 401)
			return
		}
		tracked, cleanup, err := a.trackAccessRequest(r.WithContext(context.WithValue(r.Context(), accessContextKey{}, principal)), principal.ID, false)
		if err != nil {
			http.Error(w, "credential revoked", 401)
			return
		}
		defer cleanup()
		r = tracked
		if !a.authorizeRoute(w, r) {
			return
		}
		if strings.HasSuffix(r.URL.Path, "/stream") {
			next.ServeHTTP(w, r)
		} else {
			next.ServeHTTP(accessResponseWriter{ResponseWriter: w, ctx: r.Context()}, r)
		}
	})
}
func (a *App) authorizeRoute(w http.ResponseWriter, r *http.Request) bool {
	p := requestPrincipal(r)
	path := r.URL.Path
	if strings.HasPrefix(path, "/api/access") {
		if path != "/api/access/me" && p.Role != "admin" {
			http.Error(w, "administrator required", 403)
			return false
		}
		return true
	}
	if path == "/api/hooks" && r.Method != "GET" && p.Role != "admin" {
		http.Error(w, "administrator required", 403)
		return false
	}
	var body struct {
		Root      string `json:"root"`
		SessionID string `json:"sessionId"`
		OwnerID   string `json:"ownerId"`
		Role      string `json:"role"`
		Path      string `json:"path"`
	}
	root := r.URL.Query().Get("root")
	relative := r.URL.Query().Get("path")
	if r.Method != "GET" && r.Method != "DELETE" && path != "/api/files/upload" {
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2*1024*1024))
		if err != nil {
			http.Error(w, "invalid request", 400)
			return false
		}
		r.Body = io.NopCloser(bytes.NewReader(data))
		if len(data) > 0 && json.Unmarshal(data, &body) != nil {
			http.Error(w, "invalid request", 400)
			return false
		}
		if body.OwnerID != "" || body.Role != "" {
			http.Error(w, "server assigns identity", 400)
			return false
		}
		root = body.Root
		relative = body.Path
	}
	if strings.HasPrefix(path, "/api/sessions/") {
		parts := strings.Split(path, "/")
		if len(parts) >= 4 && !a.sessionPermission(r, parts[3], r.Method != "GET") {
			http.Error(w, "terminal not found or forbidden", 404)
			return false
		}
	}
	if path == "/api/events" && r.Method == "POST" && !a.sessionPermission(r, body.SessionID, true) {
		http.Error(w, "terminal not found or forbidden", 404)
		return false
	}
	if path == "/api/bridge/hello" && !a.sessionPermission(r, body.SessionID, true) {
		http.Error(w, "terminal not found or forbidden", 404)
		return false
	}
	if strings.HasPrefix(path, "/api/bridge/tasks/") && a.bridge != nil {
		task, ok := a.bridge.Get(strings.TrimPrefix(path, "/api/bridge/tasks/"))
		if !ok || !a.sessionPermission(r, task.SessionID, false) {
			http.Error(w, "task not found", 404)
			return false
		}
	}
	if strings.HasPrefix(path, "/api/files/") || strings.HasPrefix(path, "/api/browser/") || ((path == "/api/sessions" || path == "/api/task-dispatch") && r.Method == "POST") {
		if !a.permittedRoot(p, root) {
			http.Error(w, "project not permitted", 403)
			return false
		}
		if strings.HasPrefix(path, "/api/files/") {
			target, err := resolveProjectPath(root, relative)
			if err == nil && !a.permittedRoot(p, target) {
				http.Error(w, "path not permitted", 403)
				return false
			}
		}
	}
	if r.Method != "GET" && strings.HasPrefix(path, "/api/sessions/") {
		parts := strings.Split(path, "/")
		if len(parts) >= 4 && !a.auditForeign(r, parts[3], r.Method+" "+path) {
			http.Error(w, "audit persistence failed", 503)
			return false
		}
	}
	return true
}

func (a *App) handleAccessMe(w http.ResponseWriter, r *http.Request) {
	p := requestPrincipal(r)
	if p == nil {
		jsonResponse(w, 200, map[string]any{"role": "legacy", "label": "Shared service"})
		return
	}
	jsonResponse(w, 200, p)
}
func (a *App) handleAccessEnable(w http.ResponseWriter, r *http.Request) {
	a.access.mu.Lock()
	defer a.access.mu.Unlock()
	if a.access.data.Enabled {
		http.Error(w, "already enabled", 409)
		return
	}
	var body struct {
		Label string `json:"label"`
	}
	if !requestJSON(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.Label) == "" {
		http.Error(w, "label required", 400)
		return
	}
	id, err := randomID()
	if err != nil {
		http.Error(w, "credential unavailable", 500)
		return
	}
	token, err := randomID()
	if err != nil {
		http.Error(w, "credential unavailable", 500)
		return
	}
	p := AccessPrincipal{ID: id, Label: strings.TrimSpace(body.Label), Role: "admin", AllowedRoots: []string{}}
	if err = a.saveAccessLocked(accessFile{Enabled: true, Users: []accessUser{{AccessPrincipal: p, Hash: tokenHash(token)}}}); err != nil {
		http.Error(w, "registry persistence failed", 500)
		return
	}
	// Cancel every admitted bootstrap request except this one-time enable response.
	for cancel := range a.access.active["legacy"] {
		(*cancel)()
	}
	// Existing clients authenticated by the bootstrap token must reconnect.
	a.mu.RLock()
	for _, s := range a.sessions {
		s.mu.Lock()
		for ch := range s.subs {
			delete(s.subs, ch)
			close(ch)
		}
		s.mu.Unlock()
	}
	a.mu.RUnlock()
	jsonResponse(w, 201, map[string]any{"principal": p, "credential": token})
}
func (a *App) handleAccessUsers(w http.ResponseWriter, r *http.Request) {
	a.access.mu.Lock()
	defer a.access.mu.Unlock()
	if r.Method == "GET" {
		users := []AccessPrincipal{}
		for _, u := range a.access.data.Users {
			users = append(users, u.AccessPrincipal)
		}
		jsonResponse(w, 200, users)
		return
	}
	var p AccessPrincipal
	if !requestJSON(w, r, &p) {
		return
	}
	p.Label = strings.TrimSpace(p.Label)
	if p.Label == "" || len(p.Label) > 100 || (p.Role != "admin" && p.Role != "member") || (p.Role == "member" && p.OperateOthers) {
		http.Error(w, "invalid principal", 400)
		return
	}
	roots := []string{}
	for _, root := range p.AllowedRoots {
		path, err := canonical(root)
		if err != nil || !a.permittedRoot(&AccessPrincipal{Role: "admin"}, path) {
			http.Error(w, "invalid allowed root", 400)
			return
		}
		stat, err := os.Stat(path)
		if err != nil || !stat.IsDir() {
			http.Error(w, "invalid allowed root", 400)
			return
		}
		roots = append(roots, path)
	}
	p.AllowedRoots = roots
	p.Revoked = false
	id, err := randomID()
	if err != nil {
		http.Error(w, "credential unavailable", 500)
		return
	}
	token, err := randomID()
	if err != nil {
		http.Error(w, "credential unavailable", 500)
		return
	}
	p.ID = id
	value := accessFile{Enabled: true, Users: append(append([]accessUser{}, a.access.data.Users...), accessUser{AccessPrincipal: p, Hash: tokenHash(token)})}
	if err = a.saveAccessLocked(value); err != nil {
		http.Error(w, "registry persistence failed", 500)
		return
	}
	jsonResponse(w, 201, map[string]any{"principal": p, "credential": token})
}
func (a *App) handleAccessRevoke(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	p := requestPrincipal(r)
	if p != nil && p.ID == id {
		http.Error(w, "cannot revoke current administrator", 409)
		return
	}
	a.access.mu.Lock()
	defer a.access.mu.Unlock()
	value := accessFile{Enabled: true, Users: append([]accessUser{}, a.access.data.Users...)}
	found := false
	for i := range value.Users {
		if value.Users[i].ID == id {
			value.Users[i].Revoked = true
			found = true
		}
	}
	if !found {
		http.Error(w, "not found", 404)
		return
	}
	if err := a.saveAccessLocked(value); err != nil {
		http.Error(w, "registry persistence failed", 500)
		return
	}
	for cancel := range a.access.active[id] {
		(*cancel)()
	}
	jsonResponse(w, 200, map[string]bool{"ok": true})
}
func (a *App) handleAccessOwner(w http.ResponseWriter, r *http.Request) {
	var body struct {
		OwnerID string `json:"ownerId"`
	}
	if !requestJSON(w, r, &body) {
		return
	}
	a.access.mu.Lock()
	var owner *AccessPrincipal
	for _, u := range a.access.data.Users {
		if u.ID == body.OwnerID && !u.Revoked {
			copy := u.AccessPrincipal
			owner = &copy
		}
	}
	a.access.mu.Unlock()
	s := a.session(r.PathValue("id"))
	if s == nil || owner == nil {
		http.Error(w, "terminal or owner not found", 404)
		return
	}
	if !a.permittedRoot(owner, s.snapshot().Root) {
		http.Error(w, "project not permitted for owner", 403)
		return
	}
	current := s.snapshot()
	actor := requestPrincipal(r)
	if current.OwnerID != "" && current.OwnerID != body.OwnerID && (actor == nil || !actor.OperateOthers) {
		http.Error(w, "explicit foreign-operation permission required", 403)
		return
	}
	if !a.auditForeign(r, current.ID, "assign-owner") {
		http.Error(w, "audit persistence failed", 503)
		return
	}
	token, err := randomID()
	if err != nil {
		http.Error(w, "credential unavailable", 500)
		return
	}
	if err = os.WriteFile(filepath.Join(a.dir, "hook-"+s.snapshot().ID), []byte(token), 0600); err != nil {
		http.Error(w, "credential persistence failed", 500)
		return
	}
	s.mu.Lock()
	old := s.info.OwnerID
	s.info.OwnerID = owner.ID
	s.hookHash = tokenHash(token)
	for ch := range s.subs {
		delete(s.subs, ch)
		close(ch)
	}
	s.mu.Unlock()
	if err := a.saveSessions(); err != nil {
		s.mu.Lock()
		s.info.OwnerID = old
		s.mu.Unlock()
		http.Error(w, "session persistence failed", 500)
		return
	}
	jsonResponse(w, 200, s.snapshot())
}
func (a *App) visibleSessions(r *http.Request) []SessionInfo {
	items := []SessionInfo{}
	if !a.principalCurrent(requestPrincipal(r)) {
		return items
	}
	for _, info := range a.listSessions() {
		if a.visible(requestPrincipal(r), info) {
			info.ReadOnly = !a.operable(requestPrincipal(r), info)
			items = append(items, info)
		}
	}
	return items
}
func browserOwner(r *http.Request) string {
	p := requestPrincipal(r)
	if p == nil {
		return ""
	}
	return p.ID
}
func hookCredential(home string) ([]byte, error) {
	dir := filepath.Join(home, ".local", "share", "crow-harness")
	if id := os.Getenv("CROW_SESSION_ID"); safeID(id) {
		if token, err := os.ReadFile(filepath.Join(dir, "hook-"+id)); err == nil {
			return token, nil
		}
	}
	if token := os.Getenv("CROW_HOOK_TOKEN"); token != "" {
		return []byte(token), nil
	}
	return os.ReadFile(filepath.Join(dir, "token"))
}

type accessResponseWriter struct {
	http.ResponseWriter
	ctx context.Context
}

func (w accessResponseWriter) Write(data []byte) (int, error) {
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	return w.ResponseWriter.Write(data)
}

func (a *App) auditForeign(r *http.Request, id, action string) bool {
	p := requestPrincipal(r)
	s := a.session(id)
	if p == nil || s == nil {
		return true
	}
	info := s.snapshot()
	if info.OwnerID == p.ID {
		return true
	}
	a.accessAuditMu.Lock()
	defer a.accessAuditMu.Unlock()
	file, err := os.OpenFile(filepath.Join(a.dir, "access-audit.jsonl"), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0600)
	if err != nil {
		return false
	}
	defer file.Close()
	if err = json.NewEncoder(file).Encode(map[string]any{"at": time.Now().UTC(), "actorId": p.ID, "ownerId": info.OwnerID, "sessionId": id, "action": action}); err != nil {
		return false
	}
	return file.Sync() == nil
}

func (a *App) trackAccessRequest(r *http.Request, id string, legacy bool) (*http.Request, func(), error) {
	a.access.mu.Lock()
	if legacy && a.access.data.Enabled {
		a.access.mu.Unlock()
		return r, func() {}, errors.New("access changed")
	}
	if !legacy {
		valid := false
		for _, u := range a.access.data.Users {
			if u.ID == id && !u.Revoked {
				valid = true
				break
			}
		}
		if !valid {
			a.access.mu.Unlock()
			return r, func() {}, errors.New("revoked")
		}
	}
	ctx, cancel := context.WithCancel(r.Context())
	if a.access.active == nil {
		a.access.active = map[string]map[*context.CancelFunc]struct{}{}
	}
	if a.access.active[id] == nil {
		a.access.active[id] = map[*context.CancelFunc]struct{}{}
	}
	a.access.active[id][&cancel] = struct{}{}
	a.access.mu.Unlock()
	body := r.Body
	stop := context.AfterFunc(ctx, func() {
		if body != nil {
			_ = body.Close()
		}
	})
	cleanup := func() {
		stop()
		cancel()
		a.access.mu.Lock()
		delete(a.access.active[id], &cancel)
		a.access.mu.Unlock()
	}
	return r.WithContext(ctx), cleanup, nil
}
