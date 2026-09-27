//go:build linux

package server

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"strconv"
	"syscall"
	"time"
)

func signalSessionChildren(id string, signal syscall.Signal) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return
	}
	marker := []byte("CROW_SESSION_ID=" + id + "\x00")
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid <= 0 || pid == os.Getpid() {
			continue
		}
		env, err := os.ReadFile(fmt.Sprintf("/proc/%d/environ", pid))
		if err == nil && bytes.Contains(env, marker) {
			_ = syscall.Kill(pid, signal)
		}
	}
}

func terminateSessionProcess(pid int, id string, done <-chan struct{}) error {
	if pid > 0 {
		if err := syscall.Kill(-pid, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
			return err
		}
	}
	signalSessionChildren(id, syscall.SIGTERM)
	if done == nil {
		signalSessionChildren(id, syscall.SIGKILL)
		return nil
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
	}
	// The leader may exit while descendants keep the original process group alive.
	if pid > 0 {
		if err := syscall.Kill(-pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
			return err
		}
	}
	signalSessionChildren(id, syscall.SIGKILL)
	select {
	case <-done:
		return nil
	case <-time.After(3 * time.Second):
		return errors.New("session process did not terminate")
	}
}
