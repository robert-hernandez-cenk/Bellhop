package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vpn-gateway-agent/provider"
	"vpn-gateway-agent/state"
)

type fakeProvider struct {
	countries    []provider.Country
	connectPeer  provider.PeerConfig
	connectErr   error
	gotSelection provider.ServerSelection
}

func (f *fakeProvider) Authenticate(ctx context.Context) (string, error) { return "priv", nil }
func (f *fakeProvider) ListCountries(ctx context.Context) ([]provider.Country, error) {
	return f.countries, nil
}
func (f *fakeProvider) Connect(ctx context.Context, privateKey string, selection provider.ServerSelection) (provider.PeerConfig, error) {
	f.gotSelection = selection
	if f.connectErr != nil {
		return provider.PeerConfig{}, f.connectErr
	}
	return f.connectPeer, nil
}

type fakeCityGroupProvider struct {
	fakeProvider
	cities    []provider.City
	groups    []provider.Group
	citiesErr error
	groupsErr error
}

func (f *fakeCityGroupProvider) ListCities(ctx context.Context, country string) ([]provider.City, error) {
	return f.cities, f.citiesErr
}
func (f *fakeCityGroupProvider) ListGroups(ctx context.Context) ([]provider.Group, error) {
	return f.groups, f.groupsErr
}

type fakeWG struct {
	upCalls   []provider.PeerConfig
	downCalls int
	upErr     error
}

func (f *fakeWG) Up(peer provider.PeerConfig) error {
	f.upCalls = append(f.upCalls, peer)
	return f.upErr
}
func (f *fakeWG) Down() error {
	f.downCalls++
	return nil
}

func TestHandleStatusReturnsPersistedState(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "state.json")
	since := time.Date(2026, 8, 3, 10, 0, 0, 0, time.UTC)
	if err := state.Save(statePath, state.State{Connected: true, Country: "Netherlands", ResolvedCity: "Amsterdam", Server: "nl1", DNS: "1.1.1.1", Since: since}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	deps := Deps{StatePath: statePath}
	h := NewHandler(deps)

	req := httptest.NewRequest(http.MethodGet, "/status", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var body statusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.Connected || body.Country != "Netherlands" || body.Server != "nl1" {
		t.Fatalf("unexpected body: %+v", body)
	}
	if body.ResolvedCity != "Amsterdam" {
		t.Fatalf("body.ResolvedCity = %q, want Amsterdam", body.ResolvedCity)
	}
}

func TestHandleServersReturnsProviderCountries(t *testing.T) {
	deps := Deps{Provider: &fakeProvider{countries: []provider.Country{{Name: "Netherlands", Code: "NL"}}}}
	h := NewHandler(deps)

	req := httptest.NewRequest(http.MethodGet, "/servers", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var countries []provider.Country
	if err := json.Unmarshal(rec.Body.Bytes(), &countries); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(countries) != 1 || countries[0].Code != "NL" {
		t.Fatalf("unexpected countries: %+v", countries)
	}
}

func TestHandleConnectBringsUpTunnelAndPersistsState(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "state.json")
	fp := &fakeProvider{connectPeer: provider.PeerConfig{Country: "Canada", Server: "ca1", DNS: []string{"1.1.1.1"}}}
	fwg := &fakeWG{}
	fixedNow := time.Date(2026, 8, 3, 11, 0, 0, 0, time.UTC)
	deps := Deps{Provider: fp, WG: fwg, StatePath: statePath, PrivateKey: "priv", Now: func() time.Time { return fixedNow }}
	h := NewHandler(deps)

	body := strings.NewReader(`{"country":"Canada"}`)
	req := httptest.NewRequest(http.MethodPost, "/connect", body)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if fp.gotSelection.Country != "Canada" {
		t.Fatalf("provider.Connect called with country %q, want Canada", fp.gotSelection.Country)
	}
	if fwg.downCalls != 1 || len(fwg.upCalls) != 1 {
		t.Fatalf("expected exactly one Down and one Up call, got down=%d up=%d", fwg.downCalls, len(fwg.upCalls))
	}

	saved, err := state.Load(statePath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !saved.Connected || saved.Country != "Canada" || saved.Server != "ca1" || !saved.Since.Equal(fixedNow) {
		t.Fatalf("unexpected saved state: %+v", saved)
	}
}

func TestHandleConnectReturnsBadGatewayOnProviderFailure(t *testing.T) {
	fp := &fakeProvider{connectErr: errors.New("nordvpn unreachable")}
	deps := Deps{Provider: fp, WG: &fakeWG{}, StatePath: filepath.Join(t.TempDir(), "state.json")}
	h := NewHandler(deps)

	req := httptest.NewRequest(http.MethodPost, "/connect", strings.NewReader(`{"country":""}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
}

func TestHandleCitiesReturnsProviderCities(t *testing.T) {
	fp := &fakeCityGroupProvider{cities: []provider.City{{Name: "Amsterdam", ID: "9236"}}}
	deps := Deps{Provider: fp}
	h := NewHandler(deps)

	req := httptest.NewRequest(http.MethodGet, "/cities?country=Netherlands", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var cities []provider.City
	if err := json.Unmarshal(rec.Body.Bytes(), &cities); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(cities) != 1 || cities[0].Name != "Amsterdam" {
		t.Fatalf("unexpected cities: %+v", cities)
	}
}

func TestHandleCitiesReturns404WhenProviderDoesNotSupportCities(t *testing.T) {
	deps := Deps{Provider: &fakeProvider{}}
	h := NewHandler(deps)

	req := httptest.NewRequest(http.MethodGet, "/cities?country=Netherlands", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestHandleGroupsReturnsProviderGroups(t *testing.T) {
	fp := &fakeCityGroupProvider{groups: []provider.Group{{Name: "Double VPN", Identifier: "legacy_double_vpn"}}}
	deps := Deps{Provider: fp}
	h := NewHandler(deps)

	req := httptest.NewRequest(http.MethodGet, "/groups", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var groups []provider.Group
	if err := json.Unmarshal(rec.Body.Bytes(), &groups); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(groups) != 1 || groups[0].Identifier != "legacy_double_vpn" {
		t.Fatalf("unexpected groups: %+v", groups)
	}
}

func TestHandleGroupsReturns404WhenProviderDoesNotSupportGroups(t *testing.T) {
	deps := Deps{Provider: &fakeProvider{}}
	h := NewHandler(deps)

	req := httptest.NewRequest(http.MethodGet, "/groups", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestHandleConnectPersistsCityAndGroup(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "state.json")
	fp := &fakeProvider{connectPeer: provider.PeerConfig{Country: "Netherlands", City: "Rotterdam", Server: "nl1"}}
	fwg := &fakeWG{}
	fixedNow := time.Date(2026, 8, 5, 11, 0, 0, 0, time.UTC)
	deps := Deps{Provider: fp, WG: fwg, StatePath: statePath, PrivateKey: "priv", Now: func() time.Time { return fixedNow }}
	h := NewHandler(deps)

	body := strings.NewReader(`{"country":"Netherlands","city":"Amsterdam","group":"legacy_double_vpn"}`)
	req := httptest.NewRequest(http.MethodPost, "/connect", body)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if fp.gotSelection.City != "Amsterdam" || fp.gotSelection.Group != "legacy_double_vpn" {
		t.Fatalf("provider.Connect called with selection %+v", fp.gotSelection)
	}

	saved, err := state.Load(statePath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if saved.City != "Amsterdam" || saved.Group != "legacy_double_vpn" {
		t.Fatalf("unexpected saved state: %+v", saved)
	}

	var respBody statusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &respBody); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if respBody.City != "Amsterdam" || respBody.Group != "legacy_double_vpn" {
		t.Fatalf("unexpected response body: %+v", respBody)
	}
}

func TestHandleConnectPersistsResolvedCityDistinctFromRequested(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "state.json")
	fp := &fakeProvider{connectPeer: provider.PeerConfig{Country: "United States", City: "Raleigh", Server: "us1"}}
	fwg := &fakeWG{}
	fixedNow := time.Date(2026, 8, 11, 9, 0, 0, 0, time.UTC)
	deps := Deps{Provider: fp, WG: fwg, StatePath: statePath, PrivateKey: "priv", Now: func() time.Time { return fixedNow }}
	h := NewHandler(deps)

	body := strings.NewReader(`{"country":"United States","city":"Charlotte"}`)
	req := httptest.NewRequest(http.MethodPost, "/connect", body)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}

	saved, err := state.Load(statePath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if saved.City != "Charlotte" {
		t.Fatalf("saved.City = %q, want the requested value Charlotte", saved.City)
	}
	if saved.ResolvedCity != "Raleigh" {
		t.Fatalf("saved.ResolvedCity = %q, want the provider-resolved value Raleigh", saved.ResolvedCity)
	}

	var respBody statusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &respBody); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if respBody.City != "Charlotte" || respBody.ResolvedCity != "Raleigh" {
		t.Fatalf("unexpected response body: %+v", respBody)
	}
}

func TestHandleConnectOverwritesResolvedCityToEmptyWhenProviderOmitsIt(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "state.json")
	if err := state.Save(statePath, state.State{ResolvedCity: "Amsterdam"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	fp := &fakeProvider{connectPeer: provider.PeerConfig{Country: "Netherlands", Server: "nl9"}}
	deps := Deps{Provider: fp, WG: &fakeWG{}, StatePath: statePath, PrivateKey: "priv"}
	h := NewHandler(deps)

	req := httptest.NewRequest(http.MethodPost, "/connect", strings.NewReader(`{"country":"Netherlands"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	saved, err := state.Load(statePath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if saved.ResolvedCity != "" {
		t.Fatalf("saved.ResolvedCity = %q, want empty (overwritten, not preserved from a stale prior connect)", saved.ResolvedCity)
	}
}

func TestHandleConnectResolvesAndPersistsPublicIP(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "state.json")
	fp := &fakeProvider{connectPeer: provider.PeerConfig{Country: "Netherlands", Server: "nl1", Address: "10.5.0.2/32"}}
	deps := Deps{
		Provider:   fp,
		WG:         &fakeWG{},
		StatePath:  statePath,
		PrivateKey: "priv",
		ResolvePublicIP: func(ctx context.Context, tunnelIP string) (string, error) {
			if tunnelIP != "10.5.0.2" {
				t.Fatalf("ResolvePublicIP called with tunnelIP %q, want 10.5.0.2", tunnelIP)
			}
			return "203.0.113.42", nil
		},
	}
	h := NewHandler(deps)

	req := httptest.NewRequest(http.MethodPost, "/connect", strings.NewReader(`{"country":"Netherlands"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	saved, err := state.Load(statePath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if saved.PublicIP != "203.0.113.42" {
		t.Fatalf("saved.PublicIP = %q, want 203.0.113.42", saved.PublicIP)
	}
}

func TestHandleConnectLeavesPublicIPEmptyOnResolveFailure(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "state.json")
	fp := &fakeProvider{connectPeer: provider.PeerConfig{Country: "Netherlands", Server: "nl1", Address: "10.5.0.2/32"}}
	deps := Deps{
		Provider:   fp,
		WG:         &fakeWG{},
		StatePath:  statePath,
		PrivateKey: "priv",
		ResolvePublicIP: func(ctx context.Context, tunnelIP string) (string, error) {
			return "", errors.New("ipify unreachable")
		},
	}
	h := NewHandler(deps)

	req := httptest.NewRequest(http.MethodPost, "/connect", strings.NewReader(`{"country":"Netherlands"}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected connect to still succeed despite public-IP resolution failing, got status %d", rec.Code)
	}
	saved, err := state.Load(statePath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if saved.PublicIP != "" {
		t.Fatalf("saved.PublicIP = %q, want empty on resolve failure", saved.PublicIP)
	}
}

func TestHandleConnectPersistsResolvedCountryDistinctFromRequested(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "state.json")
	fp := &fakeProvider{connectPeer: provider.PeerConfig{Country: "Netherlands", Server: "nl1"}}
	fwg := &fakeWG{}
	fixedNow := time.Date(2026, 8, 12, 9, 0, 0, 0, time.UTC)
	deps := Deps{Provider: fp, WG: fwg, StatePath: statePath, PrivateKey: "priv", Now: func() time.Time { return fixedNow }}
	h := NewHandler(deps)

	body := strings.NewReader(`{"country":""}`)
	req := httptest.NewRequest(http.MethodPost, "/connect", body)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}

	saved, err := state.Load(statePath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if saved.Country != "" {
		t.Fatalf("saved.Country = %q, want the requested value (empty, auto)", saved.Country)
	}
	if saved.ResolvedCountry != "Netherlands" {
		t.Fatalf("saved.ResolvedCountry = %q, want the provider-resolved value Netherlands", saved.ResolvedCountry)
	}

	var respBody statusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &respBody); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if respBody.Country != "" || respBody.ResolvedCountry != "Netherlands" {
		t.Fatalf("unexpected response body: %+v", respBody)
	}
}

func TestHandleConnectOverwritesResolvedCountryToEmptyWhenProviderOmitsIt(t *testing.T) {
	statePath := filepath.Join(t.TempDir(), "state.json")
	if err := state.Save(statePath, state.State{ResolvedCountry: "Netherlands"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	fp := &fakeProvider{connectPeer: provider.PeerConfig{Server: "any1"}}
	deps := Deps{Provider: fp, WG: &fakeWG{}, StatePath: statePath, PrivateKey: "priv"}
	h := NewHandler(deps)

	req := httptest.NewRequest(http.MethodPost, "/connect", strings.NewReader(`{"country":""}`))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	saved, err := state.Load(statePath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if saved.ResolvedCountry != "" {
		t.Fatalf("saved.ResolvedCountry = %q, want empty (overwritten, not preserved from a stale prior connect)", saved.ResolvedCountry)
	}
}
