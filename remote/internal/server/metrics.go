package server

import (
	"bufio"
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

type HostMetrics struct {
	CPUPercent  *float64  `json:"cpuPercent"`
	MemoryUsed  uint64    `json:"memoryUsed"`
	MemoryTotal uint64    `json:"memoryTotal"`
	DiskUsed    uint64    `json:"diskUsed"`
	DiskTotal   uint64    `json:"diskTotal"`
	At          time.Time `json:"at"`
}

type cpuSample struct {
	total uint64
	idle  uint64
}

func parseCPUStat(data []byte) (cpuSample, error) {
	line, _, _ := strings.Cut(string(data), "\n")
	fields := strings.Fields(line)
	if len(fields) < 5 || fields[0] != "cpu" {
		return cpuSample{}, errors.New("invalid /proc/stat")
	}
	var result cpuSample
	for i, field := range fields[1:] {
		if i >= 8 { // guest fields are already included in user/nice
			break
		}
		value, err := strconv.ParseUint(field, 10, 64)
		if err != nil {
			return cpuSample{}, err
		}
		result.total += value
		if i == 3 || i == 4 { // idle and iowait
			result.idle += value
		}
	}
	return result, nil
}

func parseMemInfo(data []byte) (total, available uint64, err error) {
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	var seenTotal, seenAvailable bool
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		if fields[0] != "MemTotal:" && fields[0] != "MemAvailable:" {
			continue
		}
		value, parseErr := strconv.ParseUint(fields[1], 10, 64)
		if parseErr != nil {
			return 0, 0, parseErr
		}
		if fields[0] == "MemTotal:" {
			total, seenTotal = value*1024, true
		} else {
			available, seenAvailable = value*1024, true
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, 0, err
	}
	if !seenTotal || !seenAvailable || available > total {
		return 0, 0, errors.New("invalid /proc/meminfo")
	}
	return total, available, nil
}

func (a *App) handleMetrics(w http.ResponseWriter, _ *http.Request) {
	stat, err := os.ReadFile("/proc/stat")
	if err != nil {
		http.Error(w, "CPU metrics unavailable", http.StatusServiceUnavailable)
		return
	}
	current, err := parseCPUStat(stat)
	if err != nil {
		http.Error(w, "CPU metrics unavailable", http.StatusServiceUnavailable)
		return
	}
	mem, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		http.Error(w, "memory metrics unavailable", http.StatusServiceUnavailable)
		return
	}
	total, available, err := parseMemInfo(mem)
	if err != nil {
		http.Error(w, "memory metrics unavailable", http.StatusServiceUnavailable)
		return
	}
	diskUsed, diskTotal, err := rootDiskUsage()
	if err != nil {
		http.Error(w, "disk metrics unavailable", http.StatusServiceUnavailable)
		return
	}
	a.metricsMu.Lock()
	previous := a.lastCPU
	a.lastCPU = current
	a.metricsMu.Unlock()
	var cpuPercent *float64
	if current.total > previous.total && current.idle >= previous.idle && previous.total > 0 {
		busy := (current.total - previous.total) - (current.idle - previous.idle)
		value := float64(busy) * 100 / float64(current.total-previous.total)
		cpuPercent = &value
	}
	jsonResponse(w, http.StatusOK, HostMetrics{CPUPercent: cpuPercent, MemoryUsed: total - available, MemoryTotal: total, DiskUsed: diskUsed, DiskTotal: diskTotal, At: time.Now().UTC()})
}
