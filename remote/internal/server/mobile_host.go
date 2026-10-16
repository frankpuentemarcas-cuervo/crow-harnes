package server

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const mobileHostPort = "47322"
const mobileHostRelayURL = "wss://crow.frabubu.com/v1/tunnel"

var mobileHostID = regexp.MustCompile(`^[A-Za-z0-9._~-]{1,200}$`)
var mobileSessionNameID = regexp.MustCompile(`^[0-9a-f]{32}$`)

type mobileHostProject struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Root string `json:"root"`
}

type mobileHostDevice struct {
	ID        string              `json:"id"`
	Label     string              `json:"label"`
	OwnerID   string              `json:"ownerId"`
	PublicKey string              `json:"publicKey"`
	Projects  []mobileHostProject `json:"projects"`
	PairedAt  time.Time           `json:"pairedAt"`
}

type mobileHostFile struct {
	Version      int                          `json:"version"`
	GatewayID    string                       `json:"gatewayId"`
	HostID       string                       `json:"hostId"`
	HostName     string                       `json:"hostName"`
	RelayURL     string                       `json:"relayUrl"`
	RelayRoute   string                       `json:"relayRoute"`
	Certificate  string                       `json:"certificate"`
	PrivateKey   string                       `json:"privateKey"`
	Fingerprint  string                       `json:"fingerprint"`
	Projects     []mobileHostProject          `json:"projects"`
	Devices      []mobileHostDevice           `json:"devices"`
	SessionNames map[string]map[string]string `json:"sessionNames,omitempty"`
}

type mobileHostInvite struct {
	Code      string
	OwnerID   string
	Projects  []mobileHostProject
	ExpiresAt time.Time
}

type mobileHostCredential struct {
	DeviceID  string
	ExpiresAt time.Time
}

type mobileHostChallenge struct {
	DeviceID  string
	Nonce     string
	ExpiresAt time.Time
}

type mobileHostStream struct {
	DeviceID   string
	SessionID  string
	Connection *websocket.Conn
}

type mobileHostState struct {
	mu          sync.Mutex
	file        mobileHostFile
	invite      *mobileHostInvite
	credentials map[string]mobileHostCredential
	challenges  map[string]mobileHostChallenge
	streams     map[string]mobileHostStream
	mutations   map[string]time.Time
	server      *http.Server
	stopRelay   context.CancelFunc
}

func newMobileHostState() *mobileHostState {
	return &mobileHostState{credentials: make(map[string]mobileHostCredential), challenges: make(map[string]mobileHostChallenge), streams: make(map[string]mobileHostStream), mutations: make(map[string]time.Time)}
}

func newMobileSecret(bytes int) (string, error) {
	value := make([]byte, bytes)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func newMobileUUID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	encoded := hex.EncodeToString(value)
	return encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:], nil
}

func mobileHostCertificate() (string, string, string, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", "", "", err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return "", "", "", err
	}
	now := time.Now()
	template := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "Crow Linux mobile"}, NotBefore: now.Add(-time.Minute), NotAfter: now.AddDate(20, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return "", "", "", err
	}
	encodedKey, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return "", "", "", err
	}
	cert := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	private := string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: encodedKey}))
	sum := sha256.Sum256(der)
	parts := make([]string, len(sum))
	for i, part := range sum {
		parts[i] = strings.ToUpper(hex.EncodeToString([]byte{part}))
	}
	return cert, private, strings.Join(parts, ":"), nil
}

func (a *App) mobilePath() string { return filepath.Join(a.dir, "mobile-host.json") }

func (a *App) saveMobileLocked() error {
	data, err := json.Marshal(a.mobile.file)
	if err != nil {
		return err
	}
	return writeDurableRegistry(a.mobilePath(), data)
}

func (a *App) loadMobile() error {
	a.mobile = newMobileHostState()
	data, err := os.ReadFile(a.mobilePath())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var value mobileHostFile
	if json.Unmarshal(data, &value) != nil || value.Version != 1 || value.GatewayID == "" || value.HostID == "" || !validMobileRelay(value.RelayURL, value.RelayRoute) || value.Fingerprint == "" {
		return errors.New("invalid mobile host configuration")
	}
	if _, err := tls.X509KeyPair([]byte(value.Certificate), []byte(value.PrivateKey)); err != nil {
		return errors.New("invalid mobile host certificate")
	}
	a.mobile.file = value
	return nil
}

func (a *App) startMobileHost() error {
	a.mobile.mu.Lock()
	defer a.mobile.mu.Unlock()
	if a.mobile.file.GatewayID == "" || a.mobile.server != nil {
		return nil
	}
	identity, err := tls.X509KeyPair([]byte(a.mobile.file.Certificate), []byte(a.mobile.file.PrivateKey))
	if err != nil {
		return err
	}
	listener, err := tls.Listen("tcp", "127.0.0.1:"+mobileHostPort, &tls.Config{Certificates: []tls.Certificate{identity}, MinVersion: tls.VersionTLS12})
	if err != nil {
		return err
	}
	server := &http.Server{Handler: a.mobileHandler(), ReadHeaderTimeout: 10 * time.Second}
	a.mobile.server = server
	ctx, cancel := context.WithCancel(context.Background())
	a.mobile.stopRelay = cancel
	go func() { _ = server.Serve(listener) }()
	go runMobileRelay(ctx, a.mobile.file.RelayURL, a.mobile.file.RelayRoute, "127.0.0.1:"+mobileHostPort, nil)
	return nil
}

func (a *App) handleMobileConfigure(w http.ResponseWriter, r *http.Request) {
	principal := requestPrincipal(r)
	if principal == nil || !a.principalCurrent(principal) {
		http.Error(w, "individual access required", 403)
		return
	}
	var body struct {
		HostID       string              `json:"hostId"`
		HostName     string              `json:"hostName"`
		Projects     []mobileHostProject `json:"projects"`
		SessionNames map[string]string   `json:"sessionNames"`
	}
	if !requestJSON(w, r, &body) {
		return
	}
	if !mobileHostID.MatchString(body.HostID) || len(body.HostName) == 0 || len(body.HostName) > 80 || len(body.Projects) == 0 || len(body.Projects) > 100 {
		http.Error(w, "invalid mobile configuration", 400)
		return
	}
	ids := make(map[string]bool)
	for _, project := range body.Projects {
		if !mobileHostID.MatchString(project.ID) || ids[project.ID] || len(project.Name) == 0 || len(project.Name) > 120 || !filepath.IsAbs(project.Root) || !a.permittedRoot(principal, project.Root) {
			http.Error(w, "project not permitted", 403)
			return
		}
		ids[project.ID] = true
	}
	if len(body.SessionNames) > 1000 {
		http.Error(w, "invalid mobile session names", 400)
		return
	}
	for sessionID, name := range body.SessionNames {
		if !mobileSessionNameID.MatchString(sessionID) || len(strings.TrimSpace(name)) == 0 || len(name) > 80 {
			http.Error(w, "invalid mobile session names", 400)
			return
		}
	}
	a.mobile.mu.Lock()
	if a.mobile.file.GatewayID != "" && a.mobile.file.HostID != body.HostID {
		a.mobile.mu.Unlock()
		http.Error(w, "host identity changed", 409)
		return
	}
	if a.mobile.file.GatewayID == "" {
		gateway, err := newMobileSecret(16)
		if err != nil {
			a.mobile.mu.Unlock()
			http.Error(w, "identity unavailable", 500)
			return
		}
		routeBytes := make([]byte, 32)
		if _, err = rand.Read(routeBytes); err != nil {
			a.mobile.mu.Unlock()
			http.Error(w, "route unavailable", 500)
			return
		}
		cert, key, fingerprint, err := mobileHostCertificate()
		if err != nil {
			a.mobile.mu.Unlock()
			http.Error(w, "certificate unavailable", 500)
			return
		}
		a.mobile.file = mobileHostFile{Version: 1, GatewayID: gateway, HostID: body.HostID, RelayURL: mobileHostRelayURL, RelayRoute: base64.RawURLEncoding.EncodeToString(routeBytes), Certificate: cert, PrivateKey: key, Fingerprint: fingerprint}
	}
	a.mobile.file.HostName = body.HostName
	// Multiple Crow users may share one Linux account; one user's refresh must not
	// erase another user's project grants. Device grants stay scoped to their owner.
	known := make(map[string]string)
	for _, project := range a.mobile.file.Projects {
		known[project.ID] = project.Root
	}
	for _, project := range body.Projects {
		if root, exists := known[project.ID]; exists && root != project.Root {
			a.mobile.mu.Unlock()
			http.Error(w, "project identity conflict", 409)
			return
		}
		if _, exists := known[project.ID]; !exists {
			a.mobile.file.Projects = append(a.mobile.file.Projects, project)
			known[project.ID] = project.Root
		}
	}
	if body.SessionNames != nil {
		if a.mobile.file.SessionNames == nil {
			a.mobile.file.SessionNames = make(map[string]map[string]string)
		}
		a.mobile.file.SessionNames[principal.ID] = body.SessionNames
	}
	if err := a.saveMobileLocked(); err != nil {
		a.mobile.mu.Unlock()
		http.Error(w, "mobile configuration not saved", 503)
		return
	}
	response := map[string]any{"gatewayId": a.mobile.file.GatewayID, "hostId": body.HostID, "relayUrl": a.mobile.file.RelayURL, "relayRoute": a.mobile.file.RelayRoute, "url": "https://127.0.0.1:" + mobileHostPort, "certSHA256": a.mobile.file.Fingerprint}
	a.mobile.mu.Unlock()
	if err := a.startMobileHost(); err != nil {
		http.Error(w, "mobile listener unavailable", 503)
		return
	}
	jsonResponse(w, 200, response)
}

func (a *App) handleMobileInvite(w http.ResponseWriter, r *http.Request) {
	principal := requestPrincipal(r)
	if principal == nil || !a.principalCurrent(principal) {
		http.Error(w, "individual access required", 403)
		return
	}
	a.mobile.mu.Lock()
	defer a.mobile.mu.Unlock()
	if a.mobile.server == nil || len(a.mobile.file.Projects) == 0 {
		http.Error(w, "mobile host unavailable", 503)
		return
	}
	projects := make([]mobileHostProject, 0, len(a.mobile.file.Projects))
	for _, project := range a.mobile.file.Projects {
		if a.permittedRoot(principal, project.Root) {
			projects = append(projects, project)
		}
	}
	if len(projects) == 0 {
		http.Error(w, "no authorized project", 403)
		return
	}
	code, err := newMobileSecret(16)
	if err != nil {
		http.Error(w, "invitation unavailable", 500)
		return
	}
	expires := time.Now().Add(5 * time.Minute)
	a.mobile.invite = &mobileHostInvite{Code: code, OwnerID: principal.ID, Projects: projects, ExpiresAt: expires}
	jsonResponse(w, 200, map[string]any{"version": 2, "gatewayId": a.mobile.file.GatewayID, "invitationCode": code, "expiresAt": expires.UTC().Format(time.RFC3339), "endpoints": []any{map[string]any{"kind": "relay", "url": "https://127.0.0.1:" + mobileHostPort, "certSHA256": a.mobile.file.Fingerprint, "relayUrl": a.mobile.file.RelayURL, "relayRoute": a.mobile.file.RelayRoute}}})
}
