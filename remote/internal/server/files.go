package server

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

type fileEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Dir  bool   `json:"dir"`
	Size int64  `json:"size"`
}

func resolveProjectPath(root, relative string) (string, error) {
	if root == "" || filepath.IsAbs(relative) || strings.ContainsRune(relative, 0) {
		return "", errors.New("invalid project path")
	}
	base, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	base, err = filepath.Abs(base)
	if err != nil {
		return "", err
	}
	path := filepath.Join(base, filepath.Clean(relative))
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(base, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("path escapes project")
	}
	return path, nil
}

func (a *App) handleTree(w http.ResponseWriter, r *http.Request) {
	root, relative := r.URL.Query().Get("root"), r.URL.Query().Get("path")
	path, err := resolveProjectPath(root, relative)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	items := make([]fileEntry, 0, len(entries))
	for _, entry := range entries {
		if len(items) == 500 {
			break
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		child := filepath.Join(relative, entry.Name())
		items = append(items, fileEntry{Name: entry.Name(), Path: filepath.ToSlash(child), Dir: entry.IsDir(), Size: info.Size()})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Dir != items[j].Dir {
			return items[i].Dir
		}
		return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name)
	})
	jsonResponse(w, http.StatusOK, items)
}

func fileHash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (a *App) handleFile(w http.ResponseWriter, r *http.Request) {
	var root, relative string
	if r.Method == http.MethodGet {
		root, relative = r.URL.Query().Get("root"), r.URL.Query().Get("path")
	} else {
		a.fileMu.Lock()
		defer a.fileMu.Unlock()
		var body struct {
			Root    string `json:"root"`
			Path    string `json:"path"`
			Content string `json:"content"`
			Hash    string `json:"hash"`
		}
		if !requestJSON(w, r, &body) {
			return
		}
		root, relative = body.Root, body.Path
		path, err := resolveProjectPath(root, relative)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		old, err := os.ReadFile(path)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if fileHash(old) != body.Hash {
			http.Error(w, "file changed on server", http.StatusConflict)
			return
		}
		stat, err := os.Stat(path)
		if err != nil || !stat.Mode().IsRegular() {
			http.Error(w, "not a regular file", http.StatusBadRequest)
			return
		}
		tmp, err := os.CreateTemp(filepath.Dir(path), ".crow-*")
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer os.Remove(tmp.Name())
		if _, err = io.WriteString(tmp, body.Content); err == nil {
			err = tmp.Chmod(stat.Mode().Perm())
		}
		if closeErr := tmp.Close(); err == nil {
			err = closeErr
		}
		if err == nil {
			err = os.Rename(tmp.Name(), path)
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"hash": fileHash([]byte(body.Content)), "savedAt": time.Now().UTC()})
		return
	}
	path, err := resolveProjectPath(root, relative)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	stat, err := os.Stat(path)
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > 2*1024*1024 {
		http.Error(w, "file is unavailable or too large", http.StatusBadRequest)
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !utf8.Valid(data) || strings.ContainsRune(string(data), 0) {
		http.Error(w, "binary file", http.StatusUnsupportedMediaType)
		return
	}
	jsonResponse(w, http.StatusOK, map[string]any{"content": string(data), "hash": fileHash(data), "size": stat.Size()})
}

func (a *App) handleRawFile(w http.ResponseWriter, r *http.Request) {
	path, err := resolveProjectPath(r.URL.Query().Get("root"), r.URL.Query().Get("path"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	stat, err := os.Stat(path)
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > 15*1024*1024 {
		http.Error(w, "file is unavailable or too large", http.StatusBadRequest)
		return
	}
	contentType := mime.TypeByExtension(filepath.Ext(path))
	if !strings.HasPrefix(contentType, "image/") && contentType != "application/pdf" {
		http.Error(w, "preview not supported", http.StatusUnsupportedMediaType)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, r, path)
}
