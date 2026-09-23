package selfheal

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"vpn-gateway-agent/provider"
	"vpn-gateway-agent/state"
)

type fakeProvider struct {
	peer         provider.PeerConfig
	err          error
	gotSelection provider.ServerSelection
}

func (f *fakeProvider) Authenticate(ctx context.Context) (string, error) { return "priv", nil }
func (f *fakeProvider) ListCountries(ctx context.Context) ([]provider.Country, error) {
	return nil, nil
}
func (f *fakeProvider) Connect(ctx context.Context, privateKey string, selection provider.ServerSelection) (provider.PeerConfig, error) {
	f.gotSelection = selection
	return f.peer, f.err
}

type fakeWG struct {
	healthy   bool
	upCalls   int
	downCalls int
	upErr     error
}

func (f *fakeWG) Up(peer provider.PeerConfig) error { f.upCalls++; return f.upErr }
func (f *fakeWG) Down() error                       { f.downCalls++; return nil }
func (f *fakeWG) HealthCheck() (bool, error)        { return f.healthy, nil }

func TestRunOnceHealthyJustUpdatesTimestamp(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "state.json")
	if err := state.Save(statePath, state.State{Connected: true, Country: "Netherlands"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	wg := &fakeWG{healthy: true}
	fixedNow := time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
	d := Deps{Provider: &fakeProvider{}, WG: wg, StatePath: statePath, Now: func() time.Time { return fixedNow }}

	if err := RunOnce(context.Background(), d); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if wg.upCalls != 0 || wg.downCalls != 0 {
		t.Fatalf("expected no reconnect on a healthy check, got up=%d down=%d", wg.upCalls, wg.downCalls)
	}
	s, err := state.Load(statePath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !s.LastHealthCheckOK || !s.LastHealthCheck.Equal(fixedNow) {
		t.Fatalf("unexpected state after healthy check: %+v", s)
	}
	if s.Country != "Netherlands" {
		t.Fatalf("healthy check should not touch Country, got %q", s.Country)
	}
}

func TestRunOnceUnhealthyReconnects(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "state.json")
	if err := state.Save(statePath, state.State{Connected: true, Country: "Netherlands"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	wg := &fakeWG{healthy: false}
	fp := &fakeProvider{peer: provider.PeerConfig{Country: "Netherlands", Server: "nl2"}}
	fixedNow := time.Date(2026, 8, 3, 12, 5, 0, 0, time.UTC)
	d := Deps{Provider: fp, WG: wg, StatePath: statePath, Now: func() time.Time { return fixedNow }}

	if err := RunOnce(context.Background(), d); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if wg.downCalls != 1 || wg.upCalls != 1 {
		t.Fatalf("expected exactly one reconnect cycle, got up=%d down=%d", wg.upCalls, wg.downCalls)
	}
	s, err := state.Load(statePath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !s.Connected || s.Server != "nl2" || !s.Since.Equal(fixedNow) || s.LastHealthCheckOK {
		t.Fatalf("unexpected state after reconnect: %+v", s)
	}
}

func TestRunOnceUnhealthyReconnectUsesPersistedCityAndGroup(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "state.json")
	if err := state.Save(statePath, state.State{Connected: true, Country: "Netherlands", City: "Amsterdam", Group: "legacy_double_vpn"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	wg := &fakeWG{healthy: false}
	fp := &fakeProvider{peer: provider.PeerConfig{Country: "Netherlands", City: "Rotterdam", Server: "nl2"}}
	fixedNow := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	d := Deps{Provider: fp, WG: wg, StatePath: statePath, Now: func() time.Time { return fixedNow }}

	if err := RunOnce(context.Background(), d); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if fp.gotSelection.Country != "Netherlands" || fp.gotSelection.City != "Amsterdam" || fp.gotSelection.Group != "legacy_double_vpn" {
		t.Fatalf("unexpected selection passed to Connect: %+v", fp.gotSelection)
	}
	s, err := state.Load(statePath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if s.Country != "Netherlands" || s.City != "Amsterdam" || s.Group != "legacy_double_vpn" {
		t.Fatalf("expected Country/City/Group preserved after reconnect, got %+v", s)
	}
}

func TestRunOnceReconnectUpdatesResolvedCityButNotCity(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "state.json")
	if err := state.Save(statePath, state.State{Connected: true, Country: "Netherlands", City: "Amsterdam", ResolvedCity: "Rotterdam"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	wg := &fakeWG{healthy: false}
	fp := &fakeProvider{peer: provider.PeerConfig{Country: "Netherlands", City: "Amsterdam", Server: "nl2"}}
	d := Deps{Provider: fp, WG: wg, StatePath: statePath}

	if err := RunOnce(context.Background(), d); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	s, err := state.Load(statePath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if s.City != "Amsterdam" {
		t.Fatalf("expected requested City to stay Amsterdam (unchanged), got %q", s.City)
	}
	if s.ResolvedCity != "Amsterdam" {
		t.Fatalf("expected ResolvedCity to update to this reconnect's peer.City Amsterdam (was stale Rotterdam), got %q", s.ResolvedCity)
	}
}

func TestRunOnceReconnectOverwritesResolvedCityToEmptyWhenPeerOmitsIt(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "state.json")
	if err := state.Save(statePath, state.State{Connected: true, Country: "Netherlands", ResolvedCity: "Amsterdam"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	wg := &fakeWG{healthy: false}
	fp := &fakeProvider{peer: provider.PeerConfig{Country: "Netherlands", Server: "nl3"}}
	d := Deps{Provider: fp, WG: wg, StatePath: statePath}

	if err := RunOnce(context.Background(), d); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	s, err := state.Load(statePath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if s.ResolvedCity != "" {
		t.Fatalf("expected ResolvedCity overwritten to empty when this reconnect's peer.City is empty, got %q (stale from a prior reconnect)", s.ResolvedCity)
	}
}

func TestRunOnceReturnsErrorWhenProviderFails(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "state.json")
	if err := state.Save(statePath, state.State{Connected: true}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	wg := &fakeWG{healthy: false}
	fp := &fakeProvider{err: errors.New("nordvpn unreachable")}
	d := Deps{Provider: fp, WG: wg, StatePath: statePath}

	err := RunOnce(context.Background(), d)
	if err == nil {
		t.Fatal("expected an error when the provider's reconnect attempt fails")
	}
	s, loadErr := state.Load(statePath)
	if loadErr != nil {
		t.Fatalf("Load: %v", loadErr)
	}
	if s.Connected {
		t.Fatalf("expected Connected=false after a failed reconnect, got %+v", s)
	}
}

func TestRunOnceUnhealthyReconnectResolvesPublicIP(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "state.json")
	if err := state.Save(statePath, state.State{Connected: true, Country: "Netherlands"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	wg := &fakeWG{healthy: false}
	fp := &fakeProvider{peer: provider.PeerConfig{Country: "Netherlands", Server: "nl2", Address: "10.5.0.2/32"}}
	fixedNow := time.Date(2026, 8, 5, 13, 0, 0, 0, time.UTC)
	d := Deps{
		Provider:  fp,
		WG:        wg,
		StatePath: statePath,
		Now:       func() time.Time { return fixedNow },
		ResolvePublicIP: func(ctx context.Context, tunnelIP string) (string, error) {
			if tunnelIP != "10.5.0.2" {
				t.Fatalf("ResolvePublicIP called with tunnelIP %q, want 10.5.0.2", tunnelIP)
			}
			return "203.0.113.42", nil
		},
	}

	if err := RunOnce(context.Background(), d); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	s, err := state.Load(statePath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if s.PublicIP != "203.0.113.42" {
		t.Fatalf("s.PublicIP = %q, want 203.0.113.42", s.PublicIP)
	}
}

func TestRunOnceReconnectUpdatesResolvedCountryButNotCountry(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "state.json")
	if err := state.Save(statePath, state.State{Connected: true, ResolvedCountry: "Canada"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	wg := &fakeWG{healthy: false}
	fp := &fakeProvider{peer: provider.PeerConfig{Country: "Netherlands", Server: "nl2"}}
	d := Deps{Provider: fp, WG: wg, StatePath: statePath}

	if err := RunOnce(context.Background(), d); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	s, err := state.Load(statePath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if s.Country != "" {
		t.Fatalf("expected requested Country to stay empty (auto, unchanged), got %q", s.Country)
	}
	if s.ResolvedCountry != "Netherlands" {
		t.Fatalf("expected ResolvedCountry to update to this reconnect's peer.Country Netherlands (was stale Canada), got %q", s.ResolvedCountry)
	}
}

func TestRunOnceReconnectOverwritesResolvedCountryToEmptyWhenPeerOmitsIt(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "state.json")
	if err := state.Save(statePath, state.State{Connected: true, ResolvedCountry: "Netherlands"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	wg := &fakeWG{healthy: false}
	fp := &fakeProvider{peer: provider.PeerConfig{Server: "any1"}}
	d := Deps{Provider: fp, WG: wg, StatePath: statePath}

	if err := RunOnce(context.Background(), d); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	s, err := state.Load(statePath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if s.ResolvedCountry != "" {
		t.Fatalf("expected ResolvedCountry overwritten to empty when this reconnect's peer.Country is empty, got %q (stale from a prior reconnect)", s.ResolvedCountry)
	}
}
