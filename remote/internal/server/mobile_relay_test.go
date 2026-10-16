package server

import (
	"context"
	"encoding/base64"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestLinuxMobileRelayRoutesOnlyToFixedLocalListener(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				buffer := make([]byte, 32)
				n, err := conn.Read(buffer)
				if err == nil {
					_, _ = conn.Write(buffer[:n])
				}
			}()
		}
	}()
	route := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	streamID := "123e4567-e89b-42d3-a456-426614174000"
	done := make(chan error, 1)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/tunnel" || r.Header.Get("X-Crow-Route") != route || r.Header.Get("X-Crow-Role") != "gateway" {
			done <- context.DeadlineExceeded
			return
		}
		upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			done <- err
			return
		}
		defer ws.Close()
		if err := ws.WriteJSON(mobileRelayControl{Type: "open", StreamID: streamID}); err != nil {
			done <- err
			return
		}
		var control mobileRelayControl
		if err := ws.ReadJSON(&control); err != nil {
			done <- err
			return
		}
		if control.Type != "accept" || control.StreamID != streamID {
			done <- context.DeadlineExceeded
			return
		}
		if err := ws.WriteMessage(websocket.BinaryMessage, append([]byte("CHT1"+streamID), []byte("hello")...)); err != nil {
			done <- err
			return
		}
		kind, response, err := ws.ReadMessage()
		if err != nil {
			done <- err
			return
		}
		if kind != websocket.BinaryMessage || string(response) != "CHT1"+streamID+"hello" {
			done <- context.DeadlineExceeded
			return
		}
		if err := ws.WriteJSON(mobileRelayControl{Type: "close", StreamID: streamID}); err != nil {
			done <- err
			return
		}
		if err := ws.WriteMessage(websocket.BinaryMessage, append([]byte("CHT1"+streamID), []byte("late")...)); err != nil {
			done <- err
			return
		}
		secondID := "223e4567-e89b-42d3-a456-426614174001"
		if err := ws.WriteJSON(mobileRelayControl{Type: "open", StreamID: secondID}); err != nil {
			done <- err
			return
		}
		for {
			if err := ws.ReadJSON(&control); err != nil {
				done <- err
				return
			}
			if control.Type == "accept" && control.StreamID == secondID {
				break
			}
		}
		done <- nil
	}))
	defer server.Close()
	transport := server.Client().Transport.(*http.Transport)
	dialer := &websocket.Dialer{TLSClientConfig: transport.TLSClientConfig}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go runMobileRelay(ctx, "wss"+strings.TrimPrefix(server.URL, "https")+"/v1/tunnel", route, listener.Addr().String(), dialer)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("relay timed out")
	}
	cancel()
}

func TestMobileRelayRejectsUnsafeEndpointAndRoute(t *testing.T) {
	route := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	for _, endpoint := range []string{"ws://crow.example/v1/tunnel", "wss://crow.example/other", "wss://user@crow.example/v1/tunnel", "wss://crow.example/v1/tunnel?token=x"} {
		if validMobileRelay(endpoint, route) {
			t.Fatalf("accepted %s", endpoint)
		}
	}
	if validMobileRelay("wss://crow.example/v1/tunnel", "short") {
		t.Fatal("short route accepted")
	}
}
