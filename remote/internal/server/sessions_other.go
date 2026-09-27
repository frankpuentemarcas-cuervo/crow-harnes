//go:build !linux

package server

import "errors"

func terminateSessionProcess(pid int, _ string, _ <-chan struct{}) error {
	if pid == 0 {
		return nil
	}
	return errors.New("session deletion requires Linux")
}
