//go:build linux

package server

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
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

func sessionProcessIDs(id string) []int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	marker := []byte("CROW_SESSION_ID=" + id + "\x00")
	ids := make([]int, 0)
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid <= 0 || pid == os.Getpid() {
			continue
		}
		env, err := os.ReadFile(fmt.Sprintf("/proc/%d/environ", pid))
		if err == nil && bytes.Contains(env, marker) {
			ids = append(ids, pid)
		}
	}
	return ids
}

func taggedLeader(pid int, id string) bool {
	for _, found := range sessionProcessIDs(id) {
		if found == pid {
			return true
		}
	}
	return false
}

func taggedGroupAlive(group int, id string) bool {
	for _, pid := range sessionProcessIDs(id) {
		data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
		if err != nil {
			continue
		}
		end := strings.LastIndexByte(string(data), ')')
		if end < 0 {
			continue
		}
		fields := strings.Fields(string(data[end+1:]))
		if len(fields) < 3 {
			continue
		}
		pgrp, err := strconv.Atoi(fields[2])
		if err == nil && pgrp == group {
			return true
		}
	}
	return false
}

func suspendSessionProcess(pid int, id string) error {
	if !taggedLeader(pid, id) {
		return errors.New("session process no longer available")
	}
	if err := syscall.Kill(-pid, syscall.SIGSTOP); err != nil {
		return err
	}
	signalSessionChildren(id, syscall.SIGSTOP)
	return nil
}

func resumeSessionProcess(pid int, id string) error {
	if !taggedLeader(pid, id) {
		return errors.New("session process no longer available")
	}
	if err := syscall.Kill(-pid, syscall.SIGCONT); err != nil {
		return err
	}
	signalSessionChildren(id, syscall.SIGCONT)
	return nil
}

func cleanupOrphanedSession(id string) {
	signalSessionChildren(id, syscall.SIGCONT)
	signalSessionChildren(id, syscall.SIGTERM)
	signalSessionChildren(id, syscall.SIGKILL)
}

func shellHasNoWork(pid int, id string) bool {
	ids := sessionProcessIDs(id)
	if len(ids) != 1 || ids[0] != pid {
		return false
	}
	state, sid, foregroundGroup, ok := processStat(pid)
	if !ok || sid != pid || foregroundGroup != pid || state != "S" {
		return false
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return false
	}
	for _, entry := range entries {
		other, err := strconv.Atoi(entry.Name())
		if err != nil || other <= 0 || other == pid {
			continue
		}
		state, otherSID, _, ok := processStat(other)
		if ok && otherSID == pid && state != "Z" {
			return false
		}
	}
	return true
}

func processStat(pid int) (state string, sid, foregroundGroup int, ok bool) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return "", 0, 0, false
	}
	end := strings.LastIndexByte(string(data), ')')
	if end < 0 {
		return "", 0, 0, false
	}
	fields := strings.Fields(string(data[end+1:]))
	if len(fields) < 6 {
		return "", 0, 0, false
	}
	// state, ppid, pgrp, session, tty_nr, tpgid follow the executable name.
	sid, err = strconv.Atoi(fields[3])
	if err != nil {
		return "", 0, 0, false
	}
	foregroundGroup, err = strconv.Atoi(fields[5])
	if err != nil {
		return "", 0, 0, false
	}
	return fields[0], sid, foregroundGroup, true
}

func sleepingProcessMemory(ids map[string]struct{}) uint64 {
	if len(ids) == 0 {
		return 0
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0
	}
	var total uint64
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid <= 0 {
			continue
		}
		env, err := os.ReadFile(fmt.Sprintf("/proc/%d/environ", pid))
		if err != nil {
			continue
		}
		matched := false
		for id := range ids {
			if bytes.Contains(env, []byte("CROW_SESSION_ID="+id+"\x00")) {
				matched = true
				break
			}
		}
		if !matched {
			continue
		}
		rollup, err := os.ReadFile(fmt.Sprintf("/proc/%d/smaps_rollup", pid))
		if err == nil {
			if kb := procMemoryKB(rollup, "Pss:"); kb > 0 {
				total += kb * 1024
				continue
			}
		}
		status, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
		if err == nil {
			total += procMemoryKB(status, "VmRSS:") * 1024
		}
	}
	return total
}

func procMemoryKB(data []byte, key string) uint64 {
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 && fields[0] == key {
			value, _ := strconv.ParseUint(fields[1], 10, 64)
			return value
		}
	}
	return 0
}

func terminateSessionProcess(pid int, id string, done <-chan struct{}) error {
	if pid > 0 && taggedGroupAlive(pid, id) {
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
	if pid > 0 && taggedGroupAlive(pid, id) {
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

func syncRegistryDirectory(dir string) error {
	file, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}
