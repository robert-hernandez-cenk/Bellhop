package state

import (
	"path/filepath"
	"testing"
	"time"
)

func TestLoadMissingFileReturnsZeroState(t *testing.T) {
	s, err := Load(filepath.Join(t.TempDir(), "does-not-exist.json"))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if s.Connected {
		t.Fatalf("expected zero-value State, got %+v", s)
	}
}

func TestSaveThenLoadRoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	want := State{
		Connected:         true,
		Country:           "nl",
		ResolvedCountry:   "Netherlands",
		City:              "Amsterdam",
		ResolvedCity:      "Amsterdam",
		Group:             "legacy_double_vpn",
		PublicIP:          "203.0.113.42",
		Server:            "nl123.nordvpn.com",
		DNS:               "103.86.96.100",
		Since:             time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC),
		LastHealthCheck:   time.Date(2026, 8, 3, 12, 5, 0, 0, time.UTC),
		LastHealthCheckOK: true,
	}
	if err := Save(path, want); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got != want {
		t.Fatalf("round trip mismatch: got %+v, want %+v", got, want)
	}
}
