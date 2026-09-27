package server

import "testing"

func TestParseCPUStat(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		total   uint64
		idle    uint64
		wantErr bool
	}{
		{name: "valid", input: "cpu  100 20 30 400 50 0 0 0\n", total: 600, idle: 450},
		{name: "guest is not double counted", input: "cpu 100 20 30 400 50 0 0 0 25 5\n", total: 600, idle: 450},
		{name: "missing fields", input: "cpu 1 2\n", wantErr: true},
		{name: "other line", input: "cpu0 1 2 3 4\n", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseCPUStat([]byte(tt.input))
			if (err != nil) != tt.wantErr {
				t.Fatalf("error = %v, wantErr %v", err, tt.wantErr)
			}
			if err == nil && (got.total != tt.total || got.idle != tt.idle) {
				t.Fatalf("got %+v, want total=%d idle=%d", got, tt.total, tt.idle)
			}
		})
	}
}

func TestParseMemInfo(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		total     uint64
		available uint64
		wantErr   bool
	}{
		{name: "valid", input: "MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 600 kB\n", total: 1000 * 1024, available: 600 * 1024},
		{name: "missing available", input: "MemTotal: 1000 kB\n", wantErr: true},
		{name: "available exceeds total", input: "MemTotal: 100 kB\nMemAvailable: 200 kB\n", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			total, available, err := parseMemInfo([]byte(tt.input))
			if (err != nil) != tt.wantErr {
				t.Fatalf("error = %v, wantErr %v", err, tt.wantErr)
			}
			if err == nil && (total != tt.total || available != tt.available) {
				t.Fatalf("got total=%d available=%d", total, available)
			}
		})
	}
}
