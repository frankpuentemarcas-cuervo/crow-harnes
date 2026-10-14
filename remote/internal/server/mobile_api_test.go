package server

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func mobileTestRequest(handler http.Handler, token, method, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Origin", "https://127.0.0.1:"+mobileHostPort)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func TestMobileHostPairRenewAndExistingSessionsOnly(t *testing.T) {
	a, _, root := accessFixture(t)
	a.mobile = newMobileHostState()
	a.mobile.file = mobileHostFile{Version: 1, GatewayID: "gateway", HostID: "host", HostName: "Linux host", Projects: []mobileHostProject{{ID: "project", Name: "Project", Root: root}}}
	a.mobile.invite = &mobileHostInvite{Code: "secret-invite", OwnerID: "alice", Projects: a.mobile.file.Projects, ExpiresAt: time.Now().Add(time.Minute)}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	pairBody, _ := json.Marshal(map[string]string{"invitationCode": "secret-invite", "deviceName": "Android", "publicKey": base64.StdEncoding.EncodeToString(der)})
	handler := a.mobileHandler()
	pair := mobileTestRequest(handler, "", "POST", "/api/v2/pair", string(pairBody))
	if pair.Code != 200 {
		t.Fatalf("pair %d %s", pair.Code, pair.Body)
	}
	var linked struct {
		Device struct {
			ID           string `json:"id"`
			Capabilities struct {
				Create bool `json:"create"`
				Input  bool `json:"input"`
			} `json:"capabilities"`
		} `json:"device"`
		Credential string `json:"credential"`
	}
	if json.Unmarshal(pair.Body.Bytes(), &linked) != nil || linked.Device.ID == "" || linked.Device.Capabilities.Create || !linked.Device.Capabilities.Input {
		t.Fatalf("bad pair: %s", pair.Body)
	}
	if again := mobileTestRequest(handler, "", "POST", "/api/v2/pair", string(pairBody)); again.Code != 401 {
		t.Fatalf("reused invite: %d", again.Code)
	}
	list := mobileTestRequest(handler, linked.Credential, "GET", "/api/v1/sessions?hostId=host", "")
	var sessions []mobileHostSession
	if list.Code != 200 || json.Unmarshal(list.Body.Bytes(), &sessions) != nil || len(sessions) != 1 || sessions[0].ID != "one" || !sessions[0].CanOperate {
		t.Fatalf("sessions %d %s", list.Code, list.Body)
	}
	if strings.Contains(list.Body.String(), root) || strings.Contains(list.Body.String(), "promptCache") {
		t.Fatal("private host details leaked")
	}
	bootstrap := mobileTestRequest(handler, linked.Credential, "GET", "/api/v1/bootstrap", "")
	if bootstrap.Code != 200 || !strings.Contains(bootstrap.Body.String(), `"sessionCreate":false`) || !strings.Contains(bootstrap.Body.String(), `"sessionWake":false`) {
		t.Fatalf("offline host must advertise existing-session mode: %d %s", bootstrap.Code, bootstrap.Body)
	}
	for _, path := range []string{"/api/v1/sessions", "/api/v1/wake", "/api/v1/close"} {
		blocked := mobileTestRequest(handler, linked.Credential, "POST", path, `{}`)
		if blocked.Code != 403 {
			t.Fatalf("%s=%d", path, blocked.Code)
		}
	}
	challenge := mobileTestRequest(handler, "", "POST", "/api/v2/device-challenge", `{"deviceId":"`+linked.Device.ID+`"}`)
	if challenge.Code != 200 {
		t.Fatalf("challenge %d %s", challenge.Code, challenge.Body)
	}
	var proof struct {
		ChallengeID string `json:"challengeId"`
		Nonce       string `json:"nonce"`
	}
	if json.Unmarshal(challenge.Body.Bytes(), &proof) != nil {
		t.Fatal(challenge.Body)
	}
	payload := []byte("crow-mobile-renew:v2\ngateway\n" + linked.Device.ID + "\n" + proof.ChallengeID + "\n" + proof.Nonce)
	digest := sha256.Sum256(payload)
	signed, err := ecdsa.SignASN1(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	renewBody, _ := json.Marshal(map[string]string{"deviceId": linked.Device.ID, "challengeId": proof.ChallengeID, "signature": base64.StdEncoding.EncodeToString(signed)})
	if renewed := mobileTestRequest(handler, "", "POST", "/api/v2/device-renew", string(renewBody)); renewed.Code != 200 {
		t.Fatalf("renew %d %s", renewed.Code, renewed.Body)
	}
	if replay := mobileTestRequest(handler, "", "POST", "/api/v2/device-renew", string(renewBody)); replay.Code != 401 {
		t.Fatalf("replayed proof %d", replay.Code)
	}
	a.mobile.mu.Lock()
	a.mobile.file.Projects = nil
	a.mobile.mu.Unlock()
	if current, _, valid := a.mobileCurrentDevice(linked.Device.ID); !valid || len(current.Projects) != 0 {
		t.Fatal("removing a project must hide its sessions without discarding the device link")
	}
	a.mobile.mu.Lock()
	a.mobile.file.Projects = []mobileHostProject{{ID: "project", Name: "Project", Root: root}}
	a.mobile.mu.Unlock()
	if revoked := mobileTestRequest(handler, linked.Credential, "POST", "/api/v2/device-revoke", `{}`); revoked.Code != 200 {
		t.Fatalf("revoke %d %s", revoked.Code, revoked.Body)
	}
	if after := mobileTestRequest(handler, linked.Credential, "GET", "/api/v1/bootstrap", ""); after.Code != 401 {
		t.Fatalf("revoked token %d", after.Code)
	}
}

func TestMobileHostNeverOpensNativeAPIWithoutExpectedOrigin(t *testing.T) {
	a, _, _ := accessFixture(t)
	a.mobile = newMobileHostState()
	r := httptest.NewRequest("POST", "/api/v2/pair", strings.NewReader(`{}`))
	w := httptest.NewRecorder()
	a.mobileHandler().ServeHTTP(w, r)
	if w.Code != 403 || w.Header().Get("X-Crow-Mobile-API") != "1" {
		t.Fatalf("origin accepted: %d", w.Code)
	}
}
