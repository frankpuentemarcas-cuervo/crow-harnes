package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	"image/jpeg"
	_ "image/png"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/chromedp/cdproto/input"
	"github.com/chromedp/chromedp"
)

type browser struct {
	mu     sync.Mutex
	ctx    context.Context
	cancel context.CancelFunc
	url    string
}

func browserURL(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return "", errors.New("only http and https URLs are allowed")
	}
	return parsed.String(), nil
}

func (a *App) getBrowser(root string) (*browser, error) { return a.getBrowserOwned(root, "") }
func (a *App) getBrowserOwned(root, owner string) (*browser, error) {
	canonical, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	stat, err := os.Stat(canonical)
	if err != nil || !stat.IsDir() {
		return nil, errors.New("project folder does not exist")
	}
	keyBytes := sha256.Sum256([]byte(owner + "\x00" + canonical))
	key := hex.EncodeToString(keyBytes[:12])
	a.mu.Lock()
	defer a.mu.Unlock()
	if b := a.browsers[key]; b != nil {
		return b, nil
	}
	profile := filepath.Join(a.dir, "browser-"+key)
	if err := os.MkdirAll(profile, 0700); err != nil {
		return nil, err
	}
	opts := append(chromedp.DefaultExecAllocatorOptions[:], chromedp.UserDataDir(profile), chromedp.WindowSize(1280, 800))
	allocator, cancelAllocator := chromedp.NewExecAllocator(context.Background(), opts...)
	ctx, cancelContext := chromedp.NewContext(allocator)
	b := &browser{ctx: ctx, cancel: func() { cancelContext(); cancelAllocator() }}
	a.browsers[key] = b
	return b, nil
}

func (a *App) handleBrowserOpen(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Root string `json:"root"`
		URL  string `json:"url"`
	}
	if !requestJSON(w, r, &body) {
		return
	}
	target, err := browserURL(body.URL)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	b, err := a.getBrowserOwned(body.Root, browserOwner(r))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	ctx, cancel := context.WithTimeout(b.ctx, 30*time.Second)
	defer cancel()
	if err := chromedp.Run(ctx, chromedp.Navigate(target)); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	b.url = target
	jsonResponse(w, http.StatusOK, map[string]string{"url": target})
}

func (a *App) handleBrowserFrame(w http.ResponseWriter, r *http.Request) {
	b, err := a.getBrowserOwned(r.URL.Query().Get("root"), browserOwner(r))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	ctx, cancel := context.WithTimeout(b.ctx, 15*time.Second)
	defer cancel()
	var png []byte
	if err := chromedp.Run(ctx, chromedp.CaptureScreenshot(&png)); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	img, _, err := image.Decode(bytes.NewReader(png))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, img, &jpeg.Options{Quality: 72}); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	var current string
	_ = chromedp.Run(ctx, chromedp.Location(&current))
	if current != "" {
		b.url = current
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Browser-URL", b.url)
	_, _ = w.Write(encoded.Bytes())
}

func (a *App) handleBrowserInput(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Root  string  `json:"root"`
		Kind  string  `json:"kind"`
		Text  string  `json:"text"`
		X     float64 `json:"x"`
		Y     float64 `json:"y"`
		Delta float64 `json:"delta"`
	}
	if !requestJSON(w, r, &body) {
		return
	}
	b, err := a.getBrowserOwned(body.Root, browserOwner(r))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	ctx, cancel := context.WithTimeout(b.ctx, 10*time.Second)
	defer cancel()
	switch body.Kind {
	case "click":
		err = chromedp.Run(ctx, chromedp.MouseClickXY(body.X, body.Y))
	case "text":
		err = chromedp.Run(ctx, chromedp.ActionFunc(func(ctx context.Context) error {
			return input.InsertText(body.Text).Do(ctx)
		}))
	case "enter":
		err = chromedp.Run(ctx, chromedp.KeyEvent("\r"))
	case "backspace":
		err = chromedp.Run(ctx, chromedp.KeyEvent("\b"))
	case "tab":
		err = chromedp.Run(ctx, chromedp.KeyEvent("\t"))
	case "scroll":
		err = chromedp.Run(ctx, chromedp.ActionFunc(func(ctx context.Context) error {
			return input.DispatchMouseEvent(input.MouseWheel, body.X, body.Y).WithDeltaY(body.Delta).Do(ctx)
		}))
	case "back", "forward", "reload":
		command := map[string]string{"back": "history.back()", "forward": "history.forward()", "reload": "location.reload()"}[body.Kind]
		err = chromedp.Run(ctx, chromedp.Evaluate(command, nil))
	default:
		http.Error(w, "unsupported browser input", http.StatusBadRequest)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	jsonResponse(w, http.StatusOK, map[string]bool{"ok": true})
}
