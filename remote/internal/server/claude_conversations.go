package server

// Claude owns conversation contents. This catalogue only keeps the private
// identity needed to open that exact conversation in a replaceable Crow PTY.
import (
	"bufio"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const claudeCatalogueFile = "claude-conversations.json"
const claudeConfirmationTimeout = 30 * time.Second

// Preserve every consumed intent (including failures); never evict replay guards.
// 10k explicit terminal replacements per conversation, bounded by the 4MiB catalogue.
const maxClaudeResumeRequests = 10000

var claudeUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var claudeCatalogueID = regexp.MustCompile(`^[0-9a-f]{32}$`)
var errClaudeUnavailable = errors.New("Claude conversation unavailable")
var errClaudeIdentityPending = errors.New("Claude native history not written yet")

type claudeConversation struct {
	ID         string            `json:"id"`
	NativeID   string            `json:"nativeId"`
	OwnerID    string            `json:"ownerId"`
	Root       string            `json:"root"`
	ConfigDir  string            `json:"configDir"`
	Transcript string            `json:"transcript,omitempty"`
	Name       string            `json:"name"`
	Mode       string            `json:"mode"`
	CreatedAt  time.Time         `json:"createdAt"`
	UpdatedAt  time.Time         `json:"updatedAt"`
	SessionID  string            `json:"sessionId,omitempty"`
	Confirmed  bool              `json:"confirmed"`
	Pending    bool              `json:"pending"`
	Failure    string            `json:"failure,omitempty"`
	Requests   map[string]string `json:"requests,omitempty"`
}
type claudeConversationDTO struct {
	ID        string    `json:"id"`
	Root      string    `json:"root"`
	Name      string    `json:"name"`
	Mode      string    `json:"mode"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	Status    string    `json:"status"`
	SessionID string    `json:"sessionId,omitempty"`
	Reason    string    `json:"reason,omitempty"`
}
type claudeResumeResult struct {
	Conversation claudeConversationDTO `json:"conversation"`
	Session      *SessionInfo          `json:"session,omitempty"`
	State        string                `json:"state"`
}
type claudeLaunch struct {
	ConversationID, NativeID, ConfigDir string
	Resume                              bool
}

func nativeClaudeUUID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:]), nil
}
func claudeConfigDirectory() (string, error) {
	path := os.Getenv("CLAUDE_CONFIG_DIR")
	if path == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		path = filepath.Join(home, ".claude")
	}
	path, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	// Resolve existing ancestors too, including when Claude has not created its directory yet.
	probe := path
	var tail []string
	for {
		real, e := filepath.EvalSymlinks(probe)
		if e == nil {
			for i := len(tail) - 1; i >= 0; i-- {
				real = filepath.Join(real, tail[i])
			}
			return real, nil
		}
		if !errors.Is(e, os.ErrNotExist) {
			return "", e
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			return "", e
		}
		tail = append(tail, filepath.Base(probe))
		probe = parent
	}
}

// A damaged optional history must not take down existing Crow terminals.
func (a *App) initializeClaudeConversations() {
	if err := a.loadClaudeConversations(); err != nil {
		log.Printf("crowd: Claude conversation catalogue unavailable; existing terminals remain enabled")
	}
}
func (a *App) loadClaudeConversations() error {
	a.conversationMu.Lock()
	defer a.conversationMu.Unlock()
	return a.loadClaudeConversationsLocked()
}
func (a *App) loadClaudeConversationsLocked() error {
	if a.conversationLoaded {
		return a.conversationErr
	}
	a.conversationLoaded = true
	a.conversations = make(map[string]*claudeConversation)
	path := filepath.Join(a.dir, claudeCatalogueFile)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4*1024*1024 {
		a.conversationErr = errClaudeUnavailable
		return a.conversationErr
	}
	f, err := os.Open(path)
	if err != nil {
		a.conversationErr = errClaudeUnavailable
		return a.conversationErr
	}
	defer f.Close()
	opened, err := f.Stat()
	current, e := os.Lstat(path)
	if err != nil || e != nil || !os.SameFile(info, opened) || !os.SameFile(opened, current) {
		a.conversationErr = errClaudeUnavailable
		return a.conversationErr
	}
	var file struct {
		Version       int                   `json:"version"`
		Conversations []*claudeConversation `json:"conversations"`
	}
	decoder := json.NewDecoder(io.LimitReader(f, 4*1024*1024+1))
	if decoder.Decode(&file) != nil || file.Version != 1 || len(file.Conversations) > 10000 || decoder.Decode(new(any)) != io.EOF {
		a.conversationErr = errClaudeUnavailable
		return a.conversationErr
	}
	natives := map[string]bool{}
	for _, c := range file.Conversations {
		if c == nil || !claudeCatalogueID.MatchString(c.ID) || !claudeUUID.MatchString(c.NativeID) || !filepath.IsAbs(c.Root) || !filepath.IsAbs(c.ConfigDir) || (c.Mode != "normal" && c.Mode != "bypass") || c.CreatedAt.IsZero() || c.UpdatedAt.IsZero() || a.conversations[c.ID] != nil || natives[c.NativeID] || (c.SessionID != "" && !claudeCatalogueID.MatchString(c.SessionID)) || !validClaudeName(c.Name) || len(c.Requests) > maxClaudeResumeRequests {
			a.conversationErr = errClaudeUnavailable
			return a.conversationErr
		}
		for key, id := range c.Requests {
			if !claudeUUID.MatchString(key) || !claudeCatalogueID.MatchString(id) {
				a.conversationErr = errClaudeUnavailable
				return a.conversationErr
			}
		}
		if c.Transcript != "" && (!filepath.IsAbs(c.Transcript) || filepath.Base(c.Transcript) != c.NativeID+".jsonl" || !contained(filepath.Join(c.ConfigDir, "projects"), c.Transcript)) {
			a.conversationErr = errClaudeUnavailable
			return a.conversationErr
		}
		natives[c.NativeID] = true
		a.conversations[c.ID] = c
	}
	if err := f.Chmod(0600); err != nil {
		a.conversationErr = errClaudeUnavailable
		return a.conversationErr
	}
	return nil
}
func (a *App) saveClaudeConversationsLocked() error {
	if a.conversationErr != nil {
		return a.conversationErr
	}
	if info, err := os.Lstat(filepath.Join(a.dir, claudeCatalogueFile)); err == nil && !info.Mode().IsRegular() {
		a.conversationErr = errClaudeUnavailable
		return a.conversationErr
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		a.conversationErr = errClaudeUnavailable
		return a.conversationErr
	}
	items := make([]*claudeConversation, 0, len(a.conversations))
	for _, c := range a.conversations {
		items = append(items, c)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	data, err := json.Marshal(struct {
		Version       int                   `json:"version"`
		Conversations []*claudeConversation `json:"conversations"`
	}{1, items})
	if err != nil {
		return err
	}
	if len(data) > 4*1024*1024 {
		return errClaudeUnavailable
	}
	f, err := os.CreateTemp(a.dir, ".claude-catalogue-*")
	if err != nil {
		return errClaudeUnavailable
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(tmp, filepath.Join(a.dir, claudeCatalogueFile))
	}
	if err == nil {
		err = syncRegistryDirectory(a.dir)
	}
	if err != nil {
		a.conversationErr = errClaudeUnavailable
		return a.conversationErr
	}
	return nil
}
func validClaudeName(s string) bool {
	return utf8.ValidString(s) && len([]rune(s)) <= 80 && !strings.ContainsAny(s, "\x00\r\n")
}

// Never broaden history visibility for administrators or other installations.
func (a *App) ownsClaudeConversation(p *AccessPrincipal, c *claudeConversation) bool {
	if p == nil {
		return c.OwnerID == "" && !a.accessEnabled()
	}
	return p.ID == c.OwnerID && a.principalCurrent(p)
}
func (a *App) currentClaudePrincipal(p *AccessPrincipal) (*AccessPrincipal, error) {
	if p == nil {
		if a.access.data.Enabled {
			return nil, errClaudeUnavailable
		}
		return nil, nil
	}
	if p.Role == "installation" {
		if _, ok := installationIDFromOwner(p.ID); ok {
			return p, nil
		}
		return nil, errClaudeUnavailable
	}
	for _, u := range a.access.data.Users {
		if u.ID == p.ID && !u.Revoked {
			copy := u.AccessPrincipal
			return &copy, nil
		}
	}
	return nil, errClaudeUnavailable
}
func (a *App) claudeRootPermitted(p *AccessPrincipal, root string) bool {
	a.access.mu.Lock()
	defer a.access.mu.Unlock()
	current, err := a.currentClaudePrincipal(p)
	return err == nil && a.permittedRoot(current, root)
}
func validateClaudeTranscript(c *claudeConversation, path string) error {
	if !filepath.IsAbs(path) || filepath.Base(path) != c.NativeID+".jsonl" {
		return errClaudeUnavailable
	}
	base := filepath.Join(c.ConfigDir, "projects")
	relative, err := filepath.Rel(base, path)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return errClaudeUnavailable
	}
	realBase, err := filepath.EvalSymlinks(base)
	if errors.Is(err, os.ErrNotExist) {
		return errClaudeIdentityPending
	}
	if err != nil || realBase != base {
		return errClaudeUnavailable
	}
	real, err := filepath.EvalSymlinks(path)
	if errors.Is(err, os.ErrNotExist) {
		return errClaudeIdentityPending
	}
	if err != nil || real != filepath.Join(base, relative) {
		return errClaudeUnavailable
	}
	before, err := os.Lstat(real)
	if err != nil || !before.Mode().IsRegular() {
		return errClaudeUnavailable
	}
	f, err := os.Open(real)
	if err != nil {
		return errClaudeUnavailable
	}
	defer f.Close()
	opened, err := f.Stat()
	after, e := os.Lstat(real)
	if err != nil || e != nil || !os.SameFile(before, opened) || !os.SameFile(opened, after) {
		return errClaudeUnavailable
	}
	// Read only a bounded tail, ignoring message bodies. Native JSONL identity must
	// corroborate the authenticated hook; filename alone is not proof.
	offset := opened.Size() - maxClaudeTranscriptTail
	if offset < 0 {
		offset = 0
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return errClaudeUnavailable
	}
	scan := bufio.NewScanner(io.LimitReader(f, maxClaudeTranscriptTail))
	scan.Buffer(make([]byte, 4096), maxClaudeTranscriptTail)
	if offset > 0 {
		var previous [1]byte
		if _, err := f.ReadAt(previous[:], offset-1); err != nil {
			return errClaudeUnavailable
		}
		if previous[0] != '\n' {
			scan.Scan()
		}
	}
	matched := false
	for scan.Scan() {
		var record struct {
			SessionID string `json:"sessionId"`
			Cwd       string `json:"cwd"`
		}
		if json.Unmarshal(scan.Bytes(), &record) != nil {
			continue
		}
		if record.SessionID != "" && record.SessionID != c.NativeID {
			return errClaudeUnavailable
		}
		if record.SessionID == c.NativeID && record.Cwd != "" {
			root, err := canonical(record.Cwd)
			if err != nil || root != c.Root {
				return errClaudeUnavailable
			}
			matched = true
		}
	}
	if scan.Err() != nil {
		return errClaudeUnavailable
	}
	if !matched {
		return errClaudeIdentityPending
	}
	return nil
}
func (a *App) claudeDTO(c *claudeConversation) claudeConversationDTO {
	d := claudeConversationDTO{ID: c.ID, Root: c.Root, Name: c.Name, Mode: c.Mode, CreatedAt: c.CreatedAt, UpdatedAt: c.UpdatedAt, SessionID: c.SessionID, Status: "unavailable", Reason: "La conversación todavía no tiene una identidad Claude confirmada."}
	if s := a.session(c.SessionID); s != nil {
		info := s.snapshot()
		if info.OwnerID == c.OwnerID && info.ClaudeConversationID == c.ID && (info.State == "running" || info.State == "sleeping") {
			d.SessionID = info.ID
			if c.Pending {
				d.Status = "pending"
				d.Reason = "Esperando confirmación de Claude."
				if time.Since(c.UpdatedAt) > claudeConfirmationTimeout {
					d.Status = "unavailable"
					d.Reason = "Claude no confirmó la conversación. Revisá la terminal antes de intentar otra vez."
				}
				return d
			}
			if c.Confirmed && c.Failure == "" {
				d.Status = "active"
				d.Reason = ""
				return d
			}
		}
	}
	if c.Failure != "" && !c.Confirmed {
		d.Reason = c.Failure
		return d
	}
	if c.Pending && !c.Confirmed {
		d.Reason = "El inicio de Claude se interrumpió antes de confirmar la conversación."
		return d
	}
	if !c.Confirmed {
		return d
	}
	config, err := claudeConfigDirectory()
	if err != nil || config != c.ConfigDir {
		d.Reason = "La configuración de Claude cambió en este host."
		return d
	}
	if root, err := canonical(c.Root); err != nil || root != c.Root {
		d.Reason = "La carpeta original del proyecto no está disponible."
		return d
	}
	if validateClaudeTranscript(c, c.Transcript) != nil {
		d.Reason = "El archivo original de Claude no está disponible; no se creará otra conversación."
		return d
	}
	d.Status = "available"
	d.Reason = ""
	return d
}

func (a *App) prepareClaudeLaunch(root, mode, id, owner string, resume *claudeLaunch) (*claudeLaunch, error) {
	a.conversationMu.Lock()
	defer a.conversationMu.Unlock()
	if err := a.loadClaudeConversationsLocked(); err != nil {
		return nil, err
	}
	if resume != nil {
		c := a.conversations[resume.ConversationID]
		if c == nil || c.OwnerID != owner || c.Root != root || c.Mode != mode {
			return nil, errClaudeUnavailable
		}
		c.SessionID = id
		c.Pending = true
		c.Failure = ""
		c.UpdatedAt = time.Now().UTC()
		if err := a.saveClaudeConversationsLocked(); err != nil {
			return nil, err
		}
		return resume, nil
	}
	if len(a.conversations) >= 10000 {
		return nil, errClaudeUnavailable
	}
	config, err := claudeConfigDirectory()
	if err != nil {
		return nil, errClaudeUnavailable
	}
	native, err := nativeClaudeUUID()
	if err != nil {
		return nil, err
	}
	catalogue, err := randomID()
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	c := &claudeConversation{ID: catalogue, NativeID: native, OwnerID: owner, Root: root, ConfigDir: config, Mode: mode, CreatedAt: now, UpdatedAt: now, SessionID: id, Pending: true}
	a.conversations[c.ID] = c
	if err := a.saveClaudeConversationsLocked(); err != nil {
		return nil, err
	}
	return &claudeLaunch{ConversationID: catalogue, NativeID: native, ConfigDir: config}, nil
}
func (a *App) failClaudeLaunch(id, reason string) {
	a.conversationMu.Lock()
	defer a.conversationMu.Unlock()
	if c := a.conversations[id]; c != nil {
		c.Pending = false
		c.Failure = reason
		c.UpdatedAt = time.Now().UTC()
		_ = a.saveClaudeConversationsLocked()
	}
}
func (a *App) confirmClaudeIdentity(sessionID, native, path, cwd string) error {
	s := a.session(sessionID)
	if s == nil {
		return errClaudeUnavailable
	}
	info := s.snapshot()
	if info.ClaudeConversationID == "" {
		return nil
	} // Legacy terminals are not guessed/backfilled.
	a.conversationMu.Lock()
	defer a.conversationMu.Unlock()
	if err := a.loadClaudeConversationsLocked(); err != nil {
		return err
	}
	c := a.conversations[info.ClaudeConversationID]
	root, err := canonical(cwd)
	if c == nil || c.SessionID != info.ID || c.OwnerID != info.OwnerID || c.NativeID != native || err != nil || root != c.Root {
		return errClaudeUnavailable
	}
	if err := validateClaudeTranscript(c, path); err != nil {
		return err
	}
	if !c.Pending && c.Confirmed && c.Transcript == path {
		return nil
	}
	c.Transcript = path
	c.Confirmed = true
	c.Pending = false
	c.Failure = ""
	c.UpdatedAt = time.Now().UTC()
	if err := a.saveClaudeConversationsLocked(); err != nil {
		return err
	}
	return nil
}

func (a *App) registerClaudeConversationRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/claude-conversations", a.handleClaudeConversations)
	mux.HandleFunc("POST /api/claude-conversations/{id}/resume", a.handleClaudeResume)
	mux.HandleFunc("POST /api/claude-conversations/{id}/name", a.handleClaudeName)
	mux.HandleFunc("DELETE /api/claude-conversations/{id}", a.handleClaudeForget)
}
func (a *App) handleClaudeConversations(w http.ResponseWriter, r *http.Request) {
	// Keep access and catalogue locks out of one another: copy before authorization.
	a.conversationMu.Lock()
	if a.loadClaudeConversationsLocked() != nil {
		a.conversationMu.Unlock()
		http.Error(w, "Catálogo Claude no disponible.", 503)
		return
	}
	items := make([]claudeConversation, 0, len(a.conversations))
	for _, c := range a.conversations {
		items = append(items, *c)
	}
	a.conversationMu.Unlock()
	result := make([]claudeConversationDTO, 0)
	for _, c := range items {
		if a.ownsClaudeConversation(requestPrincipal(r), &c) && a.claudeRootPermitted(requestPrincipal(r), c.Root) {
			result = append(result, a.claudeDTO(&c))
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].CreatedAt.Before(result[j].CreatedAt) })
	jsonResponse(w, 200, result)
}
func (a *App) ownedClaudeRecord(r *http.Request) (*claudeConversation, error) {
	id := r.PathValue("id")
	if !claudeCatalogueID.MatchString(id) {
		return nil, errClaudeUnavailable
	}
	a.conversationMu.Lock()
	if err := a.loadClaudeConversationsLocked(); err != nil {
		a.conversationMu.Unlock()
		return nil, err
	}
	c := a.conversations[id]
	var copy claudeConversation
	if c != nil {
		copy = *c
	}
	a.conversationMu.Unlock()
	if c == nil || !a.ownsClaudeConversation(requestPrincipal(r), &copy) || !a.claudeRootPermitted(requestPrincipal(r), copy.Root) {
		return nil, errClaudeUnavailable
	}
	return &copy, nil
}
func (a *App) handleClaudeResume(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RequestID string `json:"requestId"`
	}
	if !requestJSON(w, r, &body) {
		return
	}
	if !claudeUUID.MatchString(body.RequestID) {
		http.Error(w, "Solicitud de reanudación inválida.", 400)
		return
	}
	a.conversationStartMu.Lock()
	defer a.conversationStartMu.Unlock()
	c, err := a.ownedClaudeRecord(r)
	if err != nil {
		http.Error(w, "Conversación no disponible o no permitida.", 404)
		return
	}
	if r.Context().Err() != nil {
		return
	}
	dto := a.claudeDTO(c)
	if s := a.session(c.SessionID); s != nil {
		info := s.snapshot()
		if (info.State == "running" || info.State == "sleeping") && info.OwnerID == c.OwnerID && info.ClaudeConversationID == c.ID {
			if info.State == "sleeping" {
				info, err = a.wakeSession(info.ID)
				if err != nil {
					http.Error(w, "No se pudo activar la terminal existente.", 409)
					return
				}
			}
			if dto.Status == "unavailable" {
				http.Error(w, dto.Reason, 409)
				return
			}
			state := "existing"
			if dto.Status == "pending" {
				state = "pending"
			}
			if c.Requests[body.RequestID] == "" {
				if len(c.Requests) >= maxClaudeResumeRequests {
					http.Error(w, "Se alcanzo el limite de intentos de esta conversacion.", 409)
					return
				}
				if err := a.recordClaudeResumeRequest(c.ID, body.RequestID, info.ID); err != nil {
					http.Error(w, "No se pudo guardar la solicitud.", 503)
					return
				}
			}
			jsonResponse(w, 200, claudeResumeResult{dto, &info, state})
			return
		}
	}
	if _, used := c.Requests[body.RequestID]; used {
		http.Error(w, "Ese intento ya terminó. Actualizá la lista antes de reintentar.", 409)
		return
	}
	if dto.Status != "available" {
		http.Error(w, dto.Reason, 409)
		return
	}
	a.mu.RLock()
	hook := a.hookPath
	a.mu.RUnlock()
	if hook == "" {
		http.Error(w, "Activá los hooks de Crow para confirmar una reanudación exacta.", 409)
		return
	}
	if len(c.Requests) >= maxClaudeResumeRequests {
		http.Error(w, "Se alcanzó el límite de intentos de esta conversación.", 409)
		return
	}
	// Reserve the request and new terminal ID durably before any process is started.
	id, err := randomID()
	if err != nil {
		http.Error(w, "No se pudo preparar la reanudación.", 503)
		return
	}
	err = a.recordClaudeResumeRequest(c.ID, body.RequestID, id)
	if err != nil {
		http.Error(w, "No se pudo guardar la reanudación.", 503)
		return
	}
	launch := &claudeLaunch{ConversationID: c.ID, NativeID: c.NativeID, ConfigDir: c.ConfigDir, Resume: true}
	info, err := a.startSessionPromptIntent("claude", c.Mode, c.Root, requestPrincipal(r), "", launch, id)
	if err != nil {
		a.failClaudeLaunch(c.ID, "Claude no pudo iniciarse. Revisá su instalación y acceso en este host.")
		http.Error(w, "Claude no pudo iniciarse; la conversación no se modificó.", 503)
		return
	}
	a.conversationMu.Lock()
	copy := *a.conversations[c.ID]
	a.conversationMu.Unlock()
	dto = a.claudeDTO(&copy)
	state := "pending"
	if dto.Status == "active" {
		state = "ready"
	}
	jsonResponse(w, 202, claudeResumeResult{dto, &info, state})
}
func (a *App) recordClaudeResumeRequest(id, request, session string) error {
	a.conversationMu.Lock()
	defer a.conversationMu.Unlock()
	c := a.conversations[id]
	if c == nil {
		return errClaudeUnavailable
	}
	if c.Requests == nil {
		c.Requests = map[string]string{}
	}
	if c.Requests[request] != "" {
		return nil
	}
	c.Requests[request] = session
	return a.saveClaudeConversationsLocked()
}
func (a *App) handleClaudeName(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if !requestJSON(w, r, &body) {
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if !validClaudeName(body.Name) {
		http.Error(w, "Nombre inválido (máximo 80 caracteres).", 400)
		return
	}
	a.conversationStartMu.Lock()
	defer a.conversationStartMu.Unlock()
	c, err := a.ownedClaudeRecord(r)
	if err != nil {
		http.Error(w, "Conversación no disponible o no permitida.", 404)
		return
	}
	a.conversationMu.Lock()
	stored := a.conversations[c.ID]
	stored.Name = body.Name
	stored.UpdatedAt = time.Now().UTC()
	err = a.saveClaudeConversationsLocked()
	copy := *stored
	a.conversationMu.Unlock()
	if err != nil {
		http.Error(w, "No se pudo guardar el nombre.", 503)
		return
	}
	jsonResponse(w, 200, a.claudeDTO(&copy))
}
func (a *App) handleClaudeForget(w http.ResponseWriter, r *http.Request) {
	a.conversationStartMu.Lock()
	defer a.conversationStartMu.Unlock()
	c, err := a.ownedClaudeRecord(r)
	if err != nil {
		http.Error(w, "Conversación no disponible o no permitida.", 404)
		return
	}
	if s := a.session(c.SessionID); s != nil {
		info := s.snapshot()
		if info.State == "running" || info.State == "sleeping" {
			http.Error(w, "Cerrá la terminal antes de olvidar la conversación.", 409)
			return
		}
	}
	a.conversationMu.Lock()
	delete(a.conversations, c.ID)
	err = a.saveClaudeConversationsLocked()
	a.conversationMu.Unlock()
	if err != nil {
		http.Error(w, "No se pudo olvidar la conversación.", 503)
		return
	}
	jsonResponse(w, 200, map[string]bool{"ok": true})
}

// The conversation routes are a separate owner-only namespace. Do not let the
// generic /api/sessions admin/foreign-operation policy accidentally cover them.
func (a *App) authorizeClaudeRoute(w http.ResponseWriter, r *http.Request) bool {
	if !a.principalCurrent(requestPrincipal(r)) {
		http.Error(w, "Credencial no disponible.", 401)
		return false
	}
	// ServeMux has not assigned PathValue yet in authentication middleware.
	// Every handler performs record ownership checks after routing.
	return true
}
