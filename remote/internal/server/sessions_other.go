//go:build !linux

package server

import "errors"

func terminateSessionProcess(pid int, _ string, _ <-chan struct{}) error {
	if pid == 0 {
		return nil
	}
	return errors.New("session deletion requires Linux")
}

func suspendSessionProcess(_ int, _ string) error {
	return errors.New("session suspension requires Linux")
}
func resumeSessionProcess(_ int, _ string) error         { return errors.New("session resume requires Linux") }
func cleanupOrphanedSession(_ string)                    {}
func shellHasNoWork(_ int, _ string) bool                { return false }
func sleepingProcessMemory(_ map[string]struct{}) uint64 { return 0 }

// Production crowd runs on Linux, which fsyncs the containing directory too.
func syncRegistryDirectory(_ string) error { return nil }
