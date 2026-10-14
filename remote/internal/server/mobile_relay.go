package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const mobileRelayFrameLimit = 64 * 1024
const mobileRelayStreamLimit = 8
const mobileRelayEnvelopeBytes = 40

var mobileRelayStreamID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type mobileRelayControl struct {
	Type     string `json:"type"`
	StreamID string `json:"streamId"`
}

type mobileRelayConnection struct {
	ws      *websocket.Conn
	mu      sync.Mutex
	streams map[string]net.Conn
	closed  bool
}

func validMobileRelay(urlText, route string) bool {
	parsed, err := url.Parse(urlText)
	if err != nil || parsed.Scheme != "wss" || parsed.Hostname() == "" || parsed.User != nil || parsed.Path != "/v1/tunnel" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(route)
	return err == nil && len(decoded) == 32 && base64.RawURLEncoding.EncodeToString(decoded) == route
}

func (c *mobileRelayConnection) send(kind int, payload []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return errors.New("relay closed")
	}
	_ = c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return c.ws.WriteMessage(kind, payload)
}

func (c *mobileRelayConnection) control(kind, id string) error {
	data, _ := json.Marshal(mobileRelayControl{Type: kind, StreamID: id})
	return c.send(websocket.TextMessage, data)
}

func (c *mobileRelayConnection) close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	for id, stream := range c.streams {
		_ = stream.Close()
		delete(c.streams, id)
	}
	_ = c.ws.Close()
	c.mu.Unlock()
}

func (c *mobileRelayConnection) remove(id string, notify bool) {
	c.mu.Lock()
	stream := c.streams[id]
	delete(c.streams, id)
	c.mu.Unlock()
	if stream != nil {
		_ = stream.Close()
		if notify {
			_ = c.control("close", id)
		}
	}
}

func (c *mobileRelayConnection) open(ctx context.Context, id string, localAddress string) {
	c.mu.Lock()
	if c.closed || len(c.streams) >= mobileRelayStreamLimit || c.streams[id] != nil {
		c.mu.Unlock()
		_ = c.control("reject", id)
		return
	}
	c.mu.Unlock()
	dialer := net.Dialer{Timeout: 5 * time.Second}
	stream, err := dialer.DialContext(ctx, "tcp", localAddress)
	if err != nil {
		_ = c.control("reject", id)
		return
	}
	c.mu.Lock()
	if c.closed || len(c.streams) >= mobileRelayStreamLimit || c.streams[id] != nil {
		c.mu.Unlock()
		_ = stream.Close()
		_ = c.control("reject", id)
		return
	}
	c.streams[id] = stream
	c.mu.Unlock()
	if c.control("accept", id) != nil {
		c.remove(id, false)
		return
	}
	go func() {
		defer c.remove(id, true)
		buffer := make([]byte, mobileRelayFrameLimit-mobileRelayEnvelopeBytes)
		for {
			n, readErr := stream.Read(buffer)
			if n > 0 {
				frame := make([]byte, mobileRelayEnvelopeBytes+n)
				copy(frame, "CHT1")
				copy(frame[4:], id)
				copy(frame[mobileRelayEnvelopeBytes:], buffer[:n])
				if c.send(websocket.BinaryMessage, frame) != nil {
					return
				}
			}
			if readErr != nil {
				return
			}
		}
	}()
}

func (c *mobileRelayConnection) receive(ctx context.Context, localAddress string) error {
	c.ws.SetReadLimit(mobileRelayFrameLimit)
	for {
		kind, payload, err := c.ws.ReadMessage()
		if err != nil {
			return err
		}
		switch kind {
		case websocket.TextMessage:
			var control mobileRelayControl
			if json.Unmarshal(payload, &control) != nil || !mobileRelayStreamID.MatchString(control.StreamID) {
				return errors.New("invalid relay control")
			}
			switch control.Type {
			case "open":
				go c.open(ctx, control.StreamID, localAddress)
			case "close":
				c.remove(control.StreamID, false)
			default:
				return errors.New("invalid relay control")
			}
		case websocket.BinaryMessage:
			if len(payload) < mobileRelayEnvelopeBytes || string(payload[:4]) != "CHT1" {
				return errors.New("invalid relay frame")
			}
			id := string(payload[4:mobileRelayEnvelopeBytes])
			if !mobileRelayStreamID.MatchString(id) {
				return errors.New("invalid relay stream")
			}
			c.mu.Lock()
			stream := c.streams[id]
			c.mu.Unlock()
			if stream == nil {
				return errors.New("unknown relay stream")
			}
			_ = stream.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if _, err = stream.Write(payload[mobileRelayEnvelopeBytes:]); err != nil {
				c.remove(id, true)
			}
		default:
			return errors.New("invalid relay message")
		}
	}
}

// The Linux service owns this outbound connection. No host firewall or router port is exposed.
func runMobileRelay(ctx context.Context, endpoint, route, localAddress string, dialer *websocket.Dialer) {
	if !validMobileRelay(endpoint, route) || localAddress == "" {
		return
	}
	if dialer == nil {
		dialer = websocket.DefaultDialer
	}
	backoff := time.Second
	for ctx.Err() == nil {
		headers := http.Header{"X-Crow-Route": {route}, "X-Crow-Role": {"gateway"}}
		ws, _, err := dialer.DialContext(ctx, endpoint, headers)
		if err == nil {
			connection := &mobileRelayConnection{ws: ws, streams: make(map[string]net.Conn)}
			stop := context.AfterFunc(ctx, connection.close)
			_ = connection.receive(ctx, localAddress)
			stop()
			connection.close()
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 16*time.Second {
			backoff *= 2
		}
	}
}
