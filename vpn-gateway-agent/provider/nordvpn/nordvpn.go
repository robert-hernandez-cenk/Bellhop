// Package nordvpn implements provider.Provider against NordVPN's
// undocumented-but-widely-used-by-open-source-clients HTTP API (the same
// endpoints qdm12/gluetun's own nordvpn provider and the official
// nordvpn-linux CLI use for WireGuard/NordLynx) -- there is no official
// public API doc to link to. Exact JSON field names here are this design
// pass's best-effort match to that established community pattern; ssh-
// client.ts elsewhere in this repo carries the same kind of "no automated
// test against the real remote service, verify live" caveat for the same
// reason (a real dependency this codebase can't safely simulate in CI) --
// see this package's own doc comment on Client.Authenticate for the
// specific verify-live step deploy-vpn-gateway's first real run should
// confirm.
package nordvpn

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"

	"vpn-gateway-agent/provider"
)

const apiBase = "https://api.nordvpn.com"

// NordLynx (NordVPN's WireGuard service) always assigns this address to the
// client side of the tunnel, regardless of which server/country is chosen --
// observed/documented behavior of the official client and every open-source
// reimplementation of it (gluetun included), not something the API returns
// per-connect.
const nordlynxClientAddress = "10.5.0.2/32"

// NordVPN's own published DNS resolvers (used by its official apps'
// "Threat Protection"/DNS setting) -- used here as the tunnel's DNS instead
// of leaking lookups to the host's normal resolver.
var nordvpnDNS = []string{"103.86.96.100", "103.86.99.100"}

type Client struct {
	AccessToken string
	HTTPClient  *http.Client
	// BaseURL overrides apiBase -- unset in production, pointed at an
	// httptest.Server in tests so no real network call is ever made.
	BaseURL string
}

func (c *Client) httpClient() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return http.DefaultClient
}

func (c *Client) baseURL() string {
	if c.BaseURL != "" {
		return c.BaseURL
	}
	return apiBase
}

func (c *Client) do(ctx context.Context, method, rawURL string, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, rawURL, nil)
	if err != nil {
		return err
	}
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return fmt.Errorf("nordvpn: %s %s: %w", method, rawURL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("nordvpn: %s %s: unexpected status %d", method, rawURL, resp.StatusCode)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// Authenticate fetches this account's NordLynx WireGuard private key via
// Basic auth (username "token", password the long-lived access token
// generated at my.nordaccount.com -> NordVPN -> "Set up NordVPN manually").
// VERIFY LIVE: confirm the response body actually contains a top-level
// "nordlynx_private_key" string field against a real account during
// deploy-vpn-gateway's first live --apply; adjust the field name here if
// NordVPN's response shape has since changed.
func (c *Client) Authenticate(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL()+"/v1/users/services/credentials", nil)
	if err != nil {
		return "", err
	}
	req.SetBasicAuth("token", c.AccessToken)
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return "", fmt.Errorf("nordvpn: authenticate: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("nordvpn: authenticate: unexpected status %d (check NORDVPN_ACCESS_TOKEN)", resp.StatusCode)
	}
	var body struct {
		NordlynxPrivateKey string `json:"nordlynx_private_key"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", fmt.Errorf("nordvpn: authenticate: decode: %w", err)
	}
	if body.NordlynxPrivateKey == "" {
		return "", fmt.Errorf("nordvpn: authenticate: response had no nordlynx_private_key")
	}
	return body.NordlynxPrivateKey, nil
}

// ListCountries feeds the Networking page's country dropdown.
// VERIFY LIVE: confirm the "id"/"name"/"code" field names against a real
// response during first deploy.
func (c *Client) ListCountries(ctx context.Context) ([]provider.Country, error) {
	var raw []struct {
		Name string `json:"name"`
		Code string `json:"code"`
	}
	if err := c.do(ctx, http.MethodGet, c.baseURL()+"/v1/servers/countries", &raw); err != nil {
		return nil, err
	}
	countries := make([]provider.Country, 0, len(raw))
	for _, r := range raw {
		countries = append(countries, provider.Country{Name: r.Name, Code: r.Code})
	}
	return countries, nil
}

type recommendation struct {
	Hostname  string `json:"hostname"`
	Station   string `json:"station"`
	Locations []struct {
		Country struct {
			Name string `json:"name"`
			Code string `json:"code"`
			ID   int    `json:"id"`
			City struct {
				Name string `json:"name"`
			} `json:"city"`
		} `json:"country"`
	} `json:"locations"`
	Technologies []struct {
		Identifier string `json:"identifier"`
		Metadata   []struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		} `json:"metadata"`
	} `json:"technologies"`
}

func (r recommendation) wireguardPublicKey() (string, bool) {
	for _, tech := range r.Technologies {
		if tech.Identifier != "wireguard_udp" {
			continue
		}
		for _, meta := range tech.Metadata {
			if meta.Name == "public_key" {
				return meta.Value, true
			}
		}
	}
	return "", false
}

func (r recommendation) countryName() string {
	if len(r.Locations) > 0 {
		return r.Locations[0].Country.Name
	}
	return ""
}

func (r recommendation) cityName() string {
	if len(r.Locations) > 0 {
		return r.Locations[0].Country.City.Name
	}
	return ""
}

// Connect resolves the best (or, when selection.Country is non-empty, the
// best within that country) WireGuard-capable server and returns everything
// wireguard.Config needs. selection.Country is a country name as returned by
// ListCountries (matched server-side via the country_id filter -- NordVPN's
// recommendations endpoint filters by numeric ID, not name/code, so this
// looks the ID up via ListCountries first when a country is given).
// VERIFY LIVE: confirm "hostname"/"station"/"locations[].country"/
// "locations[].country.city.name"/"technologies[].metadata[].name==public_key"
// against a real response during first deploy.
func (c *Client) Connect(ctx context.Context, privateKey string, selection provider.ServerSelection) (provider.PeerConfig, error) {
	q := url.Values{}
	q.Set("filters[servers_technologies][identifier]", "wireguard_udp")
	q.Set("limit", "1")
	if selection.Country != "" {
		id, err := c.countryID(ctx, selection.Country)
		if err != nil {
			return provider.PeerConfig{}, err
		}
		q.Set("filters[country_id]", fmt.Sprintf("%d", id))
	}
	if selection.City != "" {
		id, err := c.cityID(ctx, selection.Country, selection.City)
		if err != nil {
			return provider.PeerConfig{}, err
		}
		q.Set("filters[country_city_id]", fmt.Sprintf("%d", id))
	}
	if selection.Group != "" {
		q.Set("filters[servers_groups][identifier]", selection.Group)
	}

	var recs []recommendation
	if err := c.do(ctx, http.MethodGet, c.baseURL()+"/v1/servers/recommendations?"+q.Encode(), &recs); err != nil {
		return provider.PeerConfig{}, err
	}
	if len(recs) == 0 {
		return provider.PeerConfig{}, fmt.Errorf("nordvpn: connect: no WireGuard-capable server returned for selection %+v", selection)
	}
	rec := recs[0]
	pubKey, ok := rec.wireguardPublicKey()
	if !ok {
		return provider.PeerConfig{}, fmt.Errorf("nordvpn: connect: server %q had no wireguard_udp public_key", rec.Hostname)
	}
	if rec.Station == "" {
		return provider.PeerConfig{}, fmt.Errorf("nordvpn: connect: server %q had no station (endpoint IP)", rec.Hostname)
	}

	return provider.PeerConfig{
		PrivateKey:    privateKey,
		Address:       nordlynxClientAddress,
		DNS:           nordvpnDNS,
		PeerPublicKey: pubKey,
		Endpoint:      fmt.Sprintf("%s:51820", rec.Station),
		Country:       rec.countryName(),
		City:          rec.cityName(),
		Server:        rec.Hostname,
	}, nil
}

type countryWithCities struct {
	ID     int    `json:"id"`
	Name   string `json:"name"`
	Code   string `json:"code"`
	Cities []struct {
		ID   int    `json:"id"`
		Name string `json:"name"`
	} `json:"cities"`
}

// fetchCountriesWithCities is shared by countryID, cityID, and ListCities --
// all three need the same nested country->cities shape, unlike
// ListCountries's own separate top-level id/name/code-only decode (which
// doesn't need cities and is left as-is to limit this change's blast
// radius).
func (c *Client) fetchCountriesWithCities(ctx context.Context) ([]countryWithCities, error) {
	var raw []countryWithCities
	if err := c.do(ctx, http.MethodGet, c.baseURL()+"/v1/servers/countries", &raw); err != nil {
		return nil, err
	}
	return raw, nil
}

func (c *Client) countryID(ctx context.Context, country string) (int, error) {
	countries, err := c.fetchCountriesWithCities(ctx)
	if err != nil {
		return 0, err
	}
	for _, r := range countries {
		if r.Name == country || r.Code == country {
			return r.ID, nil
		}
	}
	return 0, fmt.Errorf("nordvpn: unknown country %q", country)
}

// cityID resolves city's numeric ID within country, used by Connect to
// build the country_city_id filter. Requires country to already be known
// (a city name isn't guaranteed unique across countries), matching how the
// Networking page's City dropdown is only enabled once a country is
// selected.
func (c *Client) cityID(ctx context.Context, country, city string) (int, error) {
	countries, err := c.fetchCountriesWithCities(ctx)
	if err != nil {
		return 0, err
	}
	for _, r := range countries {
		if r.Name != country && r.Code != country {
			continue
		}
		for _, rc := range r.Cities {
			if rc.Name == city {
				return rc.ID, nil
			}
		}
		return 0, fmt.Errorf("nordvpn: unknown city %q in country %q", city, country)
	}
	return 0, fmt.Errorf("nordvpn: unknown country %q", country)
}

// ListCities feeds the Networking page's City dropdown once a country is
// selected.
// VERIFY LIVE: confirm /v1/servers/countries actually nests a "cities"
// array per country with "id"/"name" fields against a real response during
// this feature's first live exercise -- same "no official API doc, verify
// live" caveat ListCountries/countryID already carry.
func (c *Client) ListCities(ctx context.Context, country string) ([]provider.City, error) {
	countries, err := c.fetchCountriesWithCities(ctx)
	if err != nil {
		return nil, err
	}
	for _, r := range countries {
		if r.Name != country && r.Code != country {
			continue
		}
		cities := make([]provider.City, 0, len(r.Cities))
		for _, rc := range r.Cities {
			cities = append(cities, provider.City{Name: rc.Name, ID: fmt.Sprintf("%d", rc.ID)})
		}
		return cities, nil
	}
	return nil, fmt.Errorf("nordvpn: unknown country %q", country)
}

// ListGroups feeds the Networking page's Server Group dropdown -- covers
// Double VPN, P2P, Onion Over VPN, Dedicated IP, etc. by whatever
// NordVPN's own /v1/servers/groups currently returns, so a group NordVPN
// adds later shows up automatically without a code change here.
// VERIFY LIVE: confirm "name"/"identifier" field names against a real
// response during this feature's first live exercise.
func (c *Client) ListGroups(ctx context.Context) ([]provider.Group, error) {
	var raw []struct {
		Name       string `json:"name"`
		Identifier string `json:"identifier"`
	}
	if err := c.do(ctx, http.MethodGet, c.baseURL()+"/v1/servers/groups", &raw); err != nil {
		return nil, err
	}
	groups := make([]provider.Group, 0, len(raw))
	for _, r := range raw {
		groups = append(groups, provider.Group{Name: r.Name, Identifier: r.Identifier})
	}
	return groups, nil
}

var (
	_ provider.CityLister  = (*Client)(nil)
	_ provider.GroupLister = (*Client)(nil)
)
