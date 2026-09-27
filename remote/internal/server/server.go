package server

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type App struct {
	mu        sync.RWMutex
	saveMu    sync.Mutex
	fileMu    sync.Mutex
	metricsMu sync.Mutex
	lastCPU   cpuSample
	dir       string
	port      string
	token     string
	hookPath  string
	sessions  map[string]*session
	events    []Event
	browsers  map[string]*browser
}

func randomID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func Run() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	dir := filepath.Join(home, ".local", "share", "crow-harness")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	port := os.Getenv("CROW_PORT")
	if port == "" {
		port = "47321"
	}
	if _, err := strconv.ParseUint(port, 10, 16); err != nil {
		return fmt.Errorf("invalid CROW_PORT: %w", err)
	}
	tokenPath := filepath.Join(dir, "token")
	tokenBytes, err := os.ReadFile(tokenPath)
	if errors.Is(err, os.ErrNotExist) {
		id, idErr := randomID()
		if idErr != nil {
			return idErr
		}
		if err = os.WriteFile(tokenPath, []byte(id), 0600); err != nil {
			return err
		}
		tokenBytes = []byte(id)
	} else if err != nil {
		return err
	}
	a := &App{dir: dir, port: port, token: strings.TrimSpace(string(tokenBytes)), sessions: make(map[string]*session), browsers: make(map[string]*browser)}
	if a.token == "" {
		return errors.New("empty token")
	}
	if err := a.installHook(); err != nil {
		return err
	}
	if err := a.loadSessions(); err != nil {
		return err
	}
	if err := a.loadEvents(); err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", a.health)
	mux.HandleFunc("GET /api/host/metrics", a.handleMetrics)
	mux.HandleFunc("GET /api/sessions", a.handleSessions)
	mux.HandleFunc("POST /api/sessions", a.handleSessions)
	mux.HandleFunc("DELETE /api/sessions/{id}", a.handleDeleteSession)
	mux.HandleFunc("POST /api/sessions/{id}/wake", a.handleWakeSession)
	mux.HandleFunc("GET /api/sessions/{id}/stream", a.handleStream)
	mux.HandleFunc("GET /api/events", a.handleEvents)
	mux.HandleFunc("POST /api/events", a.handleEvents)
	mux.HandleFunc("GET /api/files/tree", a.handleTree)
	mux.HandleFunc("GET /api/files/content", a.handleFile)
	mux.HandleFunc("PUT /api/files/content", a.handleFile)
	mux.HandleFunc("GET /api/files/raw", a.handleRawFile)
	mux.HandleFunc("POST /api/browser/open", a.handleBrowserOpen)
	mux.HandleFunc("GET /api/browser/frame", a.handleBrowserFrame)
	mux.HandleFunc("POST /api/browser/input", a.handleBrowserInput)
	server := &http.Server{Handler: a.auth(mux), ReadHeaderTimeout: 10 * time.Second}
	listener, err := net.Listen("tcp", "127.0.0.1:"+port)
	if err != nil {
		return err
	}
	log.Printf("crowd listening on 127.0.0.1:%s", port)
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for now := range ticker.C {
			a.suspendIdleSessions(now.UTC())
		}
	}()
	return server.Serve(listener)
}

func (a *App) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if len(got) != len(a.token) || subtle.ConstantTimeCompare([]byte(got), []byte(a.token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func jsonResponse(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func requestJSON(w http.ResponseWriter, r *http.Request, value any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 2*1024*1024)
	if err := json.NewDecoder(r.Body).Decode(value); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return false
	}
	return true
}

func (a *App) health(w http.ResponseWriter, _ *http.Request) {
	jsonResponse(w, http.StatusOK, map[string]any{"status": "ok", "platform": "linux", "version": 1})
}

func (a *App) handleSessions(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		jsonResponse(w, http.StatusOK, a.listSessions())
		return
	}
	var body struct {
		Agent string `json:"agent"`
		Mode  string `json:"mode"`
		Root  string `json:"root"`
	}
	if !requestJSON(w, r, &body) {
		return
	}
	info, err := a.startSession(body.Agent, body.Mode, body.Root)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	jsonResponse(w, http.StatusCreated, info)
}

func (a *App) handleDeleteSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !safeID(id) {
		http.Error(w, "invalid session", http.StatusBadRequest)
		return
	}
	if err := a.deleteSession(id); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.Error(w, "session not found", http.StatusNotFound)
		} else {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
		return
	}
	jsonResponse(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) handleWakeSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !safeID(id) {
		http.Error(w, "invalid session", http.StatusBadRequest)
		return
	}
	info, err := a.wakeSession(id)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.Error(w, "session not found", http.StatusNotFound)
		} else {
			http.Error(w, err.Error(), http.StatusConflict)
		}
		return
	}
	jsonResponse(w, http.StatusOK, info)
}

var upgrader = websocket.Upgrader{ReadBufferSize: 16 * 1024, WriteBufferSize: 16 * 1024}

func (a *App) handleStream(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !safeID(id) {
		http.Error(w, "invalid session", http.StatusBadRequest)
		return
	}
	s := a.session(id)
	if s == nil {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	from, _ := strconv.ParseUint(r.URL.Query().Get("from"), 10, 64)
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	ch, snapshot := s.subscribe()
	defer s.unsubscribe(ch)
	send := func(frame Frame) error { return conn.WriteJSON(frame) }
	if err := s.replay(filepath.Join(a.dir, "terminal-"+id+".jsonl"), from, snapshot, send); err != nil {
		return
	}
	info := s.snapshot()
	if err := send(Frame{Type: "state", Info: &info}); err != nil {
		return
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn.SetReadLimit(1024 * 1024)
		for {
			var msg struct {
				Type string `json:"type"`
				Data string `json:"data"`
				Cols uint16 `json:"cols"`
				Rows uint16 `json:"rows"`
			}
			if err := conn.ReadJSON(&msg); err != nil {
				return
			}
			switch msg.Type {
			case "input":
				data, err := decodeInput(msg.Data)
				if err == nil {
					_, _ = a.wakeSession(id)
					_ = s.write(data)
				}
			case "resize":
				_ = s.resize(msg.Cols, msg.Rows)
			}
		}
	}()
	for {
		select {
		case frame, ok := <-ch:
			if !ok {
				return
			}
			if frame.Seq > 0 && frame.Seq <= snapshot {
				continue
			}
			if err := send(frame); err != nil {
				return
			}
		case <-done:
			return
		}
	}
}
