// Package state persists the gateway's current connection choice/health
// across restarts (Country/City/Group/Server survive a reboot -- POST /connect's
// choice is meant to stick -- and LastHealthCheck/LastHealthCheckOK give
// /status something to report even before the next tick). Country and City
// are the operator's requested selections (sticky, re-used as the filter on
// the next reconnect); ResolvedCountry and ResolvedCity are live
// observations of what the provider's most recent successful connect
// actually reported, overwritten (even to empty) on every successful
// connect rather than preserved across one that didn't report it -- see
// httpapi.handleConnect and selfheal.RunOnce for where each is set.
package state

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

type State struct {
	Connected         bool      `json:"connected"`
	Country           string    `json:"country"`
	ResolvedCountry   string    `json:"resolvedCountry"`
	City              string    `json:"city"`
	ResolvedCity      string    `json:"resolvedCity"`
	Group             string    `json:"group"`
	PublicIP          string    `json:"publicIp"`
	Server            string    `json:"server"`
	DNS               string    `json:"dns"`
	Since             time.Time `json:"since"`
	LastHealthCheck   time.Time `json:"lastHealthCheck"`
	LastHealthCheckOK bool      `json:"lastHealthCheckOk"`
}

// Load returns a zero-value State (Connected: false, zero times) with a nil
// error when path doesn't exist yet -- a fresh gateway's first startup has
// no prior state, and that's not a failure.
func Load(path string) (State, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return State{}, nil
	}
	if err != nil {
		return State{}, err
	}
	var s State
	if err := json.Unmarshal(data, &s); err != nil {
		return State{}, err
	}
	return s, nil
}

// Save writes via a temp-file-then-rename so a crash mid-write never leaves
// a half-written state.json for the next Load to choke on.
func Save(path string, s State) error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".state-*.json")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath)
		return err
	}
	return os.Rename(tmpPath, path)
}
