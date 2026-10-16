package server

import "net/http"

// Acknowledge only after the PTY operation, not merely after a proxy queued a
// WebSocket frame. The caller's existing mutation ledger prevents replay.
func (a *App) handleSessionMutation(w http.ResponseWriter, r *http.Request, resize bool) {
	id := r.PathValue("id")
	if !a.sessionPermission(r, id, true) {
		http.Error(w, "terminal not found or forbidden", http.StatusNotFound)
		return
	}
	s := a.session(id)
	if s == nil {
		http.Error(w, "terminal not found", http.StatusNotFound)
		return
	}
	var body struct {
		Data string `json:"data"`
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	}
	if !requestJSON(w, r, &body) {
		return
	}
	var err error
	if resize {
		if body.Cols < 2 || body.Cols > 500 || body.Rows < 2 || body.Rows > 500 {
			http.Error(w, "invalid terminal size", http.StatusBadRequest)
			return
		}
		if r.Context().Err() != nil || !a.sessionPermission(r, id, true) {
			http.Error(w, "access revoked", http.StatusForbidden)
			return
		}
		err = s.resize(body.Cols, body.Rows)
	} else {
		if len(body.Data) > 4096 {
			http.Error(w, "input too large", http.StatusBadRequest)
			return
		}
		data, decodeErr := decodeInput(body.Data)
		if decodeErr != nil || len(data) == 0 || len(data) > 2048 {
			http.Error(w, "invalid input", http.StatusBadRequest)
			return
		}
		if _, err = a.wakeSession(id); err == nil {
			if r.Context().Err() != nil || !a.sessionPermission(r, id, true) {
				http.Error(w, "access revoked", http.StatusForbidden)
				return
			}
			if a.bridge != nil {
				err = a.bridge.WithManualInput(id, func() error { return s.write(data) })
			} else {
				err = s.write(data)
			}
			if err == nil {
				a.markCodexInputWorking(id, data)
			}
		}
	}
	if err != nil {
		http.Error(w, "terminal operation not confirmed", http.StatusConflict)
		return
	}
	jsonResponse(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) handleSessionInput(w http.ResponseWriter, r *http.Request) {
	a.handleSessionMutation(w, r, false)
}
func (a *App) handleSessionResize(w http.ResponseWriter, r *http.Request) {
	a.handleSessionMutation(w, r, true)
}
