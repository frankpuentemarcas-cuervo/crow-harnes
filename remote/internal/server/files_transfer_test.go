package server

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func uploadRequest(root, directory, name string, data []byte) *http.Request {
	query := url.Values{"root": {root}, "directory": {directory}, "name": {name}}
	return httptest.NewRequest(http.MethodPost, "/api/files/upload?"+query.Encode(), bytes.NewReader(data))
}

func TestUploadFileCreatesCompleteFileWithoutOverwriting(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "docs"), 0700); err != nil {
		t.Fatal(err)
	}
	a := &App{}
	data := []byte{0, 1, 2, 255}
	first := httptest.NewRecorder()
	a.handleUploadFile(first, uploadRequest(root, "docs", "image.bin", data))
	if first.Code != http.StatusCreated {
		t.Fatalf("upload status = %d: %s", first.Code, first.Body.String())
	}
	saved, err := os.ReadFile(filepath.Join(root, "docs", "image.bin"))
	if err != nil || !bytes.Equal(saved, data) {
		t.Fatalf("saved bytes = %v, err = %v", saved, err)
	}

	second := httptest.NewRecorder()
	a.handleUploadFile(second, uploadRequest(root, "docs", "image.bin", []byte("replacement")))
	if second.Code != http.StatusConflict {
		t.Fatalf("existing file status = %d", second.Code)
	}
	saved, _ = os.ReadFile(filepath.Join(root, "docs", "image.bin"))
	if !bytes.Equal(saved, data) {
		t.Fatal("existing file was overwritten")
	}
	items, _ := os.ReadDir(filepath.Join(root, "docs"))
	if len(items) != 1 {
		t.Fatalf("temporary uploads left behind: %v", items)
	}
}

func TestConcurrentUploadsWithSameNameNeverOverwrite(t *testing.T) {
	root := t.TempDir()
	a := &App{}
	codes := make(chan int, 2)
	for _, content := range []string{"first", "second"} {
		go func(data string) {
			response := httptest.NewRecorder()
			a.handleUploadFile(response, uploadRequest(root, "", "shared.txt", []byte(data)))
			codes <- response.Code
		}(content)
	}
	first, second := <-codes, <-codes
	if !((first == http.StatusCreated && second == http.StatusConflict) || (second == http.StatusCreated && first == http.StatusConflict)) {
		t.Fatalf("concurrent upload statuses = %d and %d", first, second)
	}
}

func TestUploadFileRejectsInvalidDestinationAndOversize(t *testing.T) {
	root := t.TempDir()
	a := &App{}
	for _, tt := range []struct {
		name      string
		directory string
		fileName  string
		want      int
	}{
		{"parent traversal", "../other", "a.txt", http.StatusBadRequest},
		{"absolute destination", t.TempDir(), "a.txt", http.StatusBadRequest},
		{"slash in name", "", "../a.txt", http.StatusBadRequest},
		{"backslash in name", "", `a\b.txt`, http.StatusBadRequest},
	} {
		t.Run(tt.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			a.handleUploadFile(response, uploadRequest(root, tt.directory, tt.fileName, []byte("bad")))
			if response.Code != tt.want {
				t.Fatalf("status = %d, want %d", response.Code, tt.want)
			}
		})
	}
	request := uploadRequest(root, "", "large.bin", []byte("small"))
	request.ContentLength = maxUploadBytes + 1
	response := httptest.NewRecorder()
	a.handleUploadFile(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("large upload status = %d", response.Code)
	}
	if _, err := os.Stat(filepath.Join(root, "large.bin")); !os.IsNotExist(err) {
		t.Fatalf("oversize upload created a file: %v", err)
	}
}

func TestTransfersCannotFollowSymlinksOutsideProject(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "outside")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	a := &App{}
	response := httptest.NewRecorder()
	a.handleUploadFile(response, uploadRequest(root, "outside", "injected.txt", []byte("bad")))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("upload through symlink status = %d", response.Code)
	}
	if _, err := os.Stat(filepath.Join(outside, "injected.txt")); !os.IsNotExist(err) {
		t.Fatalf("upload escaped project: %v", err)
	}
	query := url.Values{"root": {root}, "path": {"outside/secret.txt"}}
	response = httptest.NewRecorder()
	a.handleDownloadFile(response, httptest.NewRequest(http.MethodGet, "/api/files/download?"+query.Encode(), nil))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("download through symlink status = %d", response.Code)
	}
}

func TestDownloadFileStreamsBinaryAndRejectsEscape(t *testing.T) {
	root := t.TempDir()
	data := []byte{0, 17, 255, 4}
	if err := os.WriteFile(filepath.Join(root, "archive.zip"), data, 0600); err != nil {
		t.Fatal(err)
	}
	a := &App{}
	query := url.Values{"root": {root}, "path": {"archive.zip"}}
	response := httptest.NewRecorder()
	a.handleDownloadFile(response, httptest.NewRequest(http.MethodGet, "/api/files/download?"+query.Encode(), nil))
	if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), data) {
		t.Fatalf("download status = %d, bytes = %v", response.Code, response.Body.Bytes())
	}
	if !strings.Contains(response.Header().Get("Content-Disposition"), "archive.zip") {
		t.Fatal("download lacks a filename")
	}
	query.Set("path", "../secret.txt")
	response = httptest.NewRecorder()
	a.handleDownloadFile(response, httptest.NewRequest(http.MethodGet, "/api/files/download?"+query.Encode(), nil))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("escape status = %d", response.Code)
	}
}
