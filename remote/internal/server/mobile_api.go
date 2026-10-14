package server

import (
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

type mobileHostSession struct {
	ID         string    `json:"id"`
	ProjectID  string    `json:"projectId"`
	Agent      string    `json:"agent"`
	Mode       string    `json:"mode"`
	State      string    `json:"state"`
	AgentState string    `json:"agentState,omitempty"`
	StartedAt  time.Time `json:"startedAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
	Seq        uint64    `json:"seq"`
	ExitCode   *int      `json:"exitCode,omitempty"`
	ReadOnly   bool      `json:"readOnly"`
	CanOperate bool      `json:"canOperate"`
}

func mobileAPIError(w http.ResponseWriter, status int, code, detail string) {
	w.Header().Set("X-Crow-Mobile-API", "1")
	jsonResponse(w, status, map[string]any{"code": code, "error": detail})
}

func (a *App) mobileOwner(id string) *AccessPrincipal {
	a.access.mu.Lock()
	defer a.access.mu.Unlock()
	if !a.access.data.Enabled {
		return nil
	}
	for _, user := range a.access.data.Users {
		if user.ID == id && !user.Revoked {
			copy := user.AccessPrincipal
			return &copy
		}
	}
	return nil
}

func (a *App) mobileDevice(id string) (mobileHostDevice, bool) {
	a.mobile.mu.Lock()
	defer a.mobile.mu.Unlock()
	for _, device := range a.mobile.file.Devices {
		if device.ID == id {
			device.Projects = append([]mobileHostProject(nil), device.Projects...)
			return device, true
		}
	}
	return mobileHostDevice{}, false
}

func (a *App) mobileCurrentDevice(id string) (mobileHostDevice, *AccessPrincipal, bool) {
	device, ok := a.mobileDevice(id)
	if !ok {
		return device, nil, false
	}
	owner := a.mobileOwner(device.OwnerID)
	if owner == nil {
		return device, nil, false
	}
	a.mobile.mu.Lock()
	configured := append([]mobileHostProject(nil), a.mobile.file.Projects...)
	a.mobile.mu.Unlock()
	active := make([]mobileHostProject, 0, len(device.Projects))
	for _, grant := range device.Projects {
		for _, project := range configured {
			if grant.ID == project.ID && grant.Root == project.Root && a.permittedRoot(owner, grant.Root) {
				active = append(active, grant)
				break
			}
		}
	}
	device.Projects = active
	return device, owner, true
}

func (a *App) mobileDevicePublic(device mobileHostDevice) map[string]any {
	projects := make([]string, 0, len(device.Projects))
	for _, project := range device.Projects {
		projects = append(projects, project.ID)
	}
	return map[string]any{"id": device.ID, "label": device.Label, "pairedAt": device.PairedAt.UTC().Format(time.RFC3339), "expiresAt": nil, "projectIds": projects, "capabilities": map[string]bool{"input": true, "create": false, "close": false, "quotas": false}}
}

func (a *App) mobileIssueCredential(id string) (string, time.Time, error) {
	credential, err := newMobileSecret(32)
	if err != nil {
		return "", time.Time{}, err
	}
	expires := time.Now().Add(15 * time.Minute)
	a.mobile.mu.Lock()
	for key, item := range a.mobile.credentials {
		if time.Now().After(item.ExpiresAt) {
			delete(a.mobile.credentials, key)
		}
	}
	a.mobile.credentials[tokenHash(credential)] = mobileHostCredential{DeviceID: id, ExpiresAt: expires}
	a.mobile.mu.Unlock()
	return credential, expires, nil
}

func (a *App) mobileAuthenticate(r *http.Request) (mobileHostDevice, *AccessPrincipal, bool) {
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if len(token) != 64 || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		return mobileHostDevice{}, nil, false
	}
	a.mobile.mu.Lock()
	entry, ok := a.mobile.credentials[tokenHash(token)]
	a.mobile.mu.Unlock()
	if !ok || !time.Now().Before(entry.ExpiresAt) {
		return mobileHostDevice{}, nil, false
	}
	return a.mobileCurrentDevice(entry.DeviceID)
}

func (a *App) mobileHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v2/pair", a.mobilePair)
	mux.HandleFunc("POST /api/v2/device-challenge", a.mobileChallenge)
	mux.HandleFunc("POST /api/v2/device-renew", a.mobileRenew)
	mux.HandleFunc("POST /api/v2/device-revoke", a.mobileRevoke)
	mux.HandleFunc("GET /api/v1/bootstrap", a.mobileBootstrap)
	mux.HandleFunc("GET /api/v1/sessions", a.mobileSessions)
	mux.HandleFunc("GET /api/v1/notices", func(w http.ResponseWriter, _ *http.Request) { jsonResponse(w, 200, []any{}) })
	mux.HandleFunc("GET /api/v1/quotas", func(w http.ResponseWriter, _ *http.Request) {
		mobileAPIError(w, 403, "GRANT_REQUIRED", "Cuotas no disponibles en modo host.")
	})
	mux.HandleFunc("GET /api/v1/stream", a.mobileStream)
	mux.HandleFunc("POST /api/v1/input", a.mobileInput)
	mux.HandleFunc("POST /api/v1/resize", a.mobileResize)
	mux.HandleFunc("POST /api/v1/sessions", func(w http.ResponseWriter, _ *http.Request) {
		mobileAPIError(w, 403, "GRANT_REQUIRED", "Creá terminales desde Crow Windows.")
	})
	mux.HandleFunc("POST /api/v1/wake", func(w http.ResponseWriter, _ *http.Request) {
		mobileAPIError(w, 403, "GRANT_REQUIRED", "Acción no disponible en modo host.")
	})
	mux.HandleFunc("POST /api/v1/close", func(w http.ResponseWriter, _ *http.Request) {
		mobileAPIError(w, 403, "GRANT_REQUIRED", "Acción no disponible en modo host.")
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Crow-Mobile-API", "1")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.Header.Get("Origin") != "https://127.0.0.1:"+mobileHostPort {
			mobileAPIError(w, 403, "INVALID_ORIGIN", "Origen inválido.")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		if strings.HasPrefix(r.URL.Path, "/api/v1/") || r.URL.Path == "/api/v2/device-revoke" {
			if _, _, ok := a.mobileAuthenticate(r); !ok {
				mobileAPIError(w, 401, "DEVICE_REJECTED", "Vínculo no disponible.")
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}

func (a *App) mobilePair(w http.ResponseWriter, r *http.Request) {
	var body struct{ InvitationCode, DeviceName, PublicKey string }
	if !requestJSON(w, r, &body) {
		return
	}
	keyBytes, err := base64.StdEncoding.DecodeString(body.PublicKey)
	if err != nil || len(keyBytes) > 256 || len(keyBytes) == 0 || len(body.DeviceName) == 0 || len(body.DeviceName) > 80 {
		mobileAPIError(w, 400, "INVALID_REQUEST", "Dispositivo inválido.")
		return
	}
	public, err := x509.ParsePKIXPublicKey(keyBytes)
	if err != nil {
		mobileAPIError(w, 400, "INVALID_REQUEST", "Clave inválida.")
		return
	}
	ec, ok := public.(*ecdsa.PublicKey)
	if !ok || ec.Curve.Params().Name != "P-256" {
		mobileAPIError(w, 400, "INVALID_REQUEST", "Clave incompatible.")
		return
	}
	a.mobile.mu.Lock()
	invite := a.mobile.invite
	valid := invite != nil && time.Now().Before(invite.ExpiresAt) && subtle.ConstantTimeCompare([]byte(invite.Code), []byte(body.InvitationCode)) == 1 && len(a.mobile.file.Devices) < 16
	if valid {
		a.mobile.invite = nil
	}
	a.mobile.mu.Unlock()
	if !valid || a.mobileOwner(invite.OwnerID) == nil {
		mobileAPIError(w, 401, "DEVICE_REJECTED", "Invitación vencida o no autorizada.")
		return
	}
	id, err := newMobileSecret(16)
	if err != nil {
		mobileAPIError(w, 503, "GATEWAY_UNAVAILABLE", "Identidad no disponible.")
		return
	}
	device := mobileHostDevice{ID: id, Label: strings.TrimSpace(body.DeviceName), OwnerID: invite.OwnerID, PublicKey: body.PublicKey, Projects: invite.Projects, PairedAt: time.Now().UTC()}
	a.mobile.mu.Lock()
	a.mobile.file.Devices = append(a.mobile.file.Devices, device)
	err = a.saveMobileLocked()
	if err != nil {
		a.mobile.file.Devices = a.mobile.file.Devices[:len(a.mobile.file.Devices)-1]
	}
	a.mobile.mu.Unlock()
	if err != nil {
		mobileAPIError(w, 503, "GATEWAY_UNAVAILABLE", "No se guardó el vínculo.")
		return
	}
	credential, expires, err := a.mobileIssueCredential(id)
	if err != nil {
		mobileAPIError(w, 503, "GATEWAY_UNAVAILABLE", "Acceso temporal no disponible.")
		return
	}
	jsonResponse(w, 200, map[string]any{"version": 2, "device": a.mobileDevicePublic(device), "credential": credential, "credentialExpiresAt": expires.UTC().Format(time.RFC3339)})
}

func (a *App) mobileChallenge(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DeviceID string `json:"deviceId"`
	}
	if !requestJSON(w, r, &body) {
		return
	}
	if _, _, ok := a.mobileCurrentDevice(body.DeviceID); !ok {
		mobileAPIError(w, 401, "DEVICE_REJECTED", "Dispositivo revocado.")
		return
	}
	id, err := newMobileUUID()
	if err != nil {
		mobileAPIError(w, 503, "GATEWAY_UNAVAILABLE", "Desafío no disponible.")
		return
	}
	nonce, err := newMobileSecret(32)
	if err != nil {
		mobileAPIError(w, 503, "GATEWAY_UNAVAILABLE", "Desafío no disponible.")
		return
	}
	expires := time.Now().Add(30 * time.Second)
	a.mobile.mu.Lock()
	for key, value := range a.mobile.challenges {
		if time.Now().After(value.ExpiresAt) {
			delete(a.mobile.challenges, key)
		}
	}
	if len(a.mobile.challenges) >= 128 {
		a.mobile.mu.Unlock()
		mobileAPIError(w, 429, "RATE_LIMITED", "Esperá antes de renovar.")
		return
	}
	a.mobile.challenges[id] = mobileHostChallenge{DeviceID: body.DeviceID, Nonce: nonce, ExpiresAt: expires}
	gateway := a.mobile.file.GatewayID
	a.mobile.mu.Unlock()
	jsonResponse(w, 200, map[string]any{"version": 2, "gatewayId": gateway, "deviceId": body.DeviceID, "challengeId": id, "nonce": nonce, "expiresAt": expires.UTC().Format(time.RFC3339)})
}

func (a *App) mobileRenew(w http.ResponseWriter, r *http.Request) {
	var body struct{ DeviceID, ChallengeID, Signature string }
	if !requestJSON(w, r, &body) {
		return
	}
	a.mobile.mu.Lock()
	challenge, ok := a.mobile.challenges[body.ChallengeID]
	delete(a.mobile.challenges, body.ChallengeID)
	gateway := a.mobile.file.GatewayID
	a.mobile.mu.Unlock()
	device, _, active := a.mobileCurrentDevice(body.DeviceID)
	if !ok || !active || challenge.DeviceID != body.DeviceID || !time.Now().Before(challenge.ExpiresAt) {
		mobileAPIError(w, 401, "DEVICE_REJECTED", "Desafío vencido o revocado.")
		return
	}
	keyBytes, keyErr := base64.StdEncoding.DecodeString(device.PublicKey)
	parsed, parseErr := x509.ParsePKIXPublicKey(keyBytes)
	public, cast := parsed.(*ecdsa.PublicKey)
	signature, signatureErr := base64.StdEncoding.DecodeString(body.Signature)
	payload := []byte("crow-mobile-renew:v2\n" + gateway + "\n" + body.DeviceID + "\n" + body.ChallengeID + "\n" + challenge.Nonce)
	digest := sha256.Sum256(payload)
	if keyErr != nil || parseErr != nil || !cast || signatureErr != nil || !ecdsa.VerifyASN1(public, digest[:], signature) {
		mobileAPIError(w, 401, "DEVICE_REJECTED", "Firma inválida.")
		return
	}
	credential, expires, err := a.mobileIssueCredential(device.ID)
	if err != nil {
		mobileAPIError(w, 503, "GATEWAY_UNAVAILABLE", "Acceso temporal no disponible.")
		return
	}
	jsonResponse(w, 200, map[string]any{"version": 2, "credential": credential, "credentialExpiresAt": expires.UTC().Format(time.RFC3339)})
}

func (a *App) mobileRevoke(w http.ResponseWriter, r *http.Request) {
	device, _, ok := a.mobileAuthenticate(r)
	if !ok {
		mobileAPIError(w, 401, "DEVICE_REJECTED", "Vínculo no disponible.")
		return
	}
	a.mobile.mu.Lock()
	previous := append([]mobileHostDevice(nil), a.mobile.file.Devices...)
	for i, item := range a.mobile.file.Devices {
		if item.ID == device.ID {
			a.mobile.file.Devices = append(a.mobile.file.Devices[:i], a.mobile.file.Devices[i+1:]...)
			break
		}
	}
	if err := a.saveMobileLocked(); err != nil {
		a.mobile.file.Devices = previous
		a.mobile.mu.Unlock()
		mobileAPIError(w, 503, "GATEWAY_UNAVAILABLE", "No se guardó la revocación.")
		return
	}
	for key, value := range a.mobile.credentials {
		if value.DeviceID == device.ID {
			delete(a.mobile.credentials, key)
		}
	}
	for id, stream := range a.mobile.streams {
		if stream.DeviceID == device.ID {
			_ = stream.Connection.Close()
			delete(a.mobile.streams, id)
		}
	}
	a.mobile.mu.Unlock()
	jsonResponse(w, 200, map[string]bool{"ok": true})
}

func (a *App) mobileAllowedSession(device mobileHostDevice, owner *AccessPrincipal, info SessionInfo) (mobileHostSession, bool) {
	for _, project := range device.Projects {
		if info.Root == project.Root && a.permittedRoot(owner, info.Root) && a.visible(owner, info) {
			return mobileHostSession{ID: info.ID, ProjectID: project.ID, Agent: info.Agent, Mode: info.Mode, State: info.State, AgentState: info.AgentState, StartedAt: info.StartedAt, UpdatedAt: info.UpdatedAt, Seq: info.Seq, ExitCode: info.ExitCode, ReadOnly: info.ReadOnly || !a.operable(owner, info), CanOperate: !info.ReadOnly && a.operable(owner, info)}, true
		}
	}
	return mobileHostSession{}, false
}

func (a *App) mobileBootstrap(w http.ResponseWriter, r *http.Request) {
	device, owner, ok := a.mobileAuthenticate(r)
	if !ok {
		mobileAPIError(w, 401, "DEVICE_REJECTED", "Vínculo no disponible.")
		return
	}
	a.mobile.mu.Lock()
	hostID, hostName := a.mobile.file.HostID, a.mobile.file.HostName
	a.mobile.mu.Unlock()
	projects := make([]map[string]any, 0, len(device.Projects))
	for _, project := range device.Projects {
		projects = append(projects, map[string]any{"id": project.ID, "hostId": hostID, "name": project.Name, "availability": "available"})
	}
	jsonResponse(w, 200, map[string]any{"version": 1, "device": a.mobileDevicePublic(device), "hosts": []any{map[string]any{"id": hostID, "name": hostName, "status": "connected"}}, "projects": projects, "actor": map[string]string{"label": owner.Label}, "devices": []any{a.mobileDevicePublic(device)}, "supportedFeatures": map[string]bool{"sessionList": true, "terminalStream": true, "terminalInput": true, "sessionCreate": false, "sessionWake": false, "sessionClose": false, "notices": false, "quotas": false, "pushNotifications": false, "structuredChat": false, "approvalActions": false, "fileBrowser": false, "gitStatus": false}})
}

func (a *App) mobileSessions(w http.ResponseWriter, r *http.Request) {
	device, owner, ok := a.mobileAuthenticate(r)
	if !ok {
		mobileAPIError(w, 401, "DEVICE_REJECTED", "Vínculo no disponible.")
		return
	}
	a.mobile.mu.Lock()
	hostID := a.mobile.file.HostID
	a.mobile.mu.Unlock()
	if r.URL.Query().Get("hostId") != hostID {
		mobileAPIError(w, 403, "GRANT_REQUIRED", "Host no autorizado.")
		return
	}
	projectID := r.URL.Query().Get("projectId")
	result := make([]mobileHostSession, 0)
	for _, info := range a.listSessions() {
		if session, allowed := a.mobileAllowedSession(device, owner, info); allowed && (projectID == "" || session.ProjectID == projectID) {
			result = append(result, session)
		}
	}
	jsonResponse(w, 200, result)
}

var mobileStreamUpgrader = websocket.Upgrader{ReadBufferSize: 16 * 1024, WriteBufferSize: 16 * 1024, CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "https://127.0.0.1:"+mobileHostPort }}

func (a *App) mobileStream(w http.ResponseWriter, r *http.Request) {
	device, owner, ok := a.mobileAuthenticate(r)
	if !ok {
		mobileAPIError(w, 401, "DEVICE_REJECTED", "Vínculo no disponible.")
		return
	}
	a.mobile.mu.Lock()
	hostID := a.mobile.file.HostID
	a.mobile.mu.Unlock()
	id := r.URL.Query().Get("sessionId")
	if r.URL.Query().Get("hostId") != hostID || !safeID(id) {
		mobileAPIError(w, 403, "GRANT_REQUIRED", "Terminal no autorizada.")
		return
	}
	s := a.session(id)
	if s == nil {
		mobileAPIError(w, 404, "NOT_FOUND", "Terminal no encontrada.")
		return
	}
	info, allowed := a.mobileAllowedSession(device, owner, s.snapshot())
	if !allowed {
		mobileAPIError(w, 403, "GRANT_REQUIRED", "Terminal no autorizada.")
		return
	}
	from, err := strconv.ParseUint(r.URL.Query().Get("from"), 10, 64)
	if err != nil && r.URL.Query().Get("from") != "" {
		mobileAPIError(w, 400, "INVALID_REQUEST", "Cursor inválido.")
		return
	}
	conn, err := mobileStreamUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	streamID, err := newMobileUUID()
	if err != nil {
		return
	}
	a.mobile.mu.Lock()
	if len(a.mobile.streams) >= 32 {
		a.mobile.mu.Unlock()
		return
	}
	a.mobile.streams[streamID] = mobileHostStream{DeviceID: device.ID, SessionID: id, Connection: conn}
	a.mobile.mu.Unlock()
	defer func() { a.mobile.mu.Lock(); delete(a.mobile.streams, streamID); a.mobile.mu.Unlock() }()
	ch, snapshot := s.subscribe()
	defer s.unsubscribe(ch)
	if conn.WriteJSON(map[string]any{"type": "ready", "streamId": streamID}) != nil {
		return
	}
	send := func(frame Frame) error {
		current, currentOwner, valid := a.mobileCurrentDevice(device.ID)
		if !valid {
			return errors.New("device revoked")
		}
		if _, allowed := a.mobileAllowedSession(current, currentOwner, s.snapshot()); !allowed {
			return errors.New("session revoked")
		}
		if frame.Type == "output" {
			return conn.WriteJSON(map[string]any{"type": "output", "seq": frame.Seq, "data": frame.Data})
		}
		if frame.Type == "state" && frame.Info != nil {
			state, allowed := a.mobileAllowedSession(current, currentOwner, *frame.Info)
			if !allowed {
				return errors.New("session revoked")
			}
			return conn.WriteJSON(map[string]any{"type": "state", "info": state})
		}
		return errors.New("unknown frame")
	}
	if err := s.replay(filepath.Join(a.dir, "terminal-"+id+".jsonl"), from, snapshot, send); err != nil && !errors.Is(err, os.ErrNotExist) {
		return
	}
	if conn.WriteJSON(map[string]any{"type": "state", "info": info}) != nil {
		return
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn.SetReadLimit(1024)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()
	for {
		select {
		case frame, open := <-ch:
			if !open {
				return
			}
			if frame.Seq > 0 && frame.Seq <= snapshot {
				continue
			}
			if send(frame) != nil {
				return
			}
		case <-done:
			return
		}
	}
}

func (a *App) mobileMutation(w http.ResponseWriter, r *http.Request, resize bool) {
	device, owner, ok := a.mobileAuthenticate(r)
	if !ok {
		mobileAPIError(w, 401, "DEVICE_REJECTED", "Vínculo no disponible.")
		return
	}
	var body struct {
		StreamID  string `json:"streamId"`
		RequestID string `json:"requestId"`
		Data      string `json:"data"`
		Cols      uint16 `json:"cols"`
		Rows      uint16 `json:"rows"`
	}
	if !requestJSON(w, r, &body) {
		return
	}
	if !mobileRelayStreamID.MatchString(body.StreamID) || !mobileRelayStreamID.MatchString(body.RequestID) {
		mobileAPIError(w, 400, "INVALID_REQUEST", "Operación inválida.")
		return
	}
	var input []byte
	var err error
	if !resize {
		if len(body.Data) > 4096 {
			mobileAPIError(w, 400, "INVALID_REQUEST", "Entrada demasiado larga.")
			return
		}
		input, err = base64.StdEncoding.DecodeString(body.Data)
		if err != nil || len(input) == 0 || len(input) > 2048 {
			mobileAPIError(w, 400, "INVALID_REQUEST", "Entrada inválida.")
			return
		}
	} else if body.Cols < 2 || body.Cols > 500 || body.Rows < 2 || body.Rows > 500 {
		mobileAPIError(w, 400, "INVALID_REQUEST", "Tamaño inválido.")
		return
	}
	a.mobile.mu.Lock()
	stream, exists := a.mobile.streams[body.StreamID]
	a.mobile.mu.Unlock()
	if !exists || stream.DeviceID != device.ID {
		mobileAPIError(w, 403, "GRANT_REQUIRED", "Terminal desconectada.")
		return
	}
	s := a.session(stream.SessionID)
	if s == nil {
		mobileAPIError(w, 404, "NOT_FOUND", "Terminal no disponible.")
		return
	}
	if info, allowed := a.mobileAllowedSession(device, owner, s.snapshot()); !allowed || !info.CanOperate {
		mobileAPIError(w, 403, "GRANT_REQUIRED", "Terminal de solo lectura.")
		return
	}
	key := device.ID + ":" + body.RequestID
	a.mobile.mu.Lock()
	for id, at := range a.mobile.mutations {
		if time.Since(at) > 20*time.Minute {
			delete(a.mobile.mutations, id)
		}
	}
	if _, duplicate := a.mobile.mutations[key]; duplicate {
		a.mobile.mu.Unlock()
		mobileAPIError(w, 409, "REQUEST_CONFLICT", "Acción ya recibida; verificá la terminal.")
		return
	}
	if len(a.mobile.mutations) >= 2048 {
		a.mobile.mu.Unlock()
		mobileAPIError(w, 429, "RATE_LIMITED", "Demasiadas acciones pendientes.")
		return
	}
	a.mobile.mutations[key] = time.Now()
	a.mobile.mu.Unlock()
	if resize {
		err = s.resize(body.Cols, body.Rows)
	} else {
		_, _ = a.wakeSession(stream.SessionID)
		if a.bridge != nil {
			err = a.bridge.WithManualInput(stream.SessionID, func() error { return s.write(input) })
		} else {
			err = s.write(input)
		}
	}
	if err != nil {
		mobileAPIError(w, 409, "REQUEST_CONFLICT", "No se confirmó la acción; revisá la terminal antes de repetirla.")
		return
	}
	jsonResponse(w, 200, map[string]bool{"ok": true})
}

func (a *App) mobileInput(w http.ResponseWriter, r *http.Request)  { a.mobileMutation(w, r, false) }
func (a *App) mobileResize(w http.ResponseWriter, r *http.Request) { a.mobileMutation(w, r, true) }
