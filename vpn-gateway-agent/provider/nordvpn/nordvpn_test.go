package nordvpn

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"vpn-gateway-agent/provider"
)

func TestAuthenticateReturnsPrivateKeyUsingBasicAuth(t *testing.T) {
	var gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Write([]byte(`{"nordlynx_private_key":"privkey123"}`))
	}))
	defer server.Close()

	c := &Client{AccessToken: "my-token", BaseURL: server.URL}
	key, err := c.Authenticate(context.Background())
	if err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if key != "privkey123" {
		t.Fatalf("got key %q, want privkey123", key)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("token:my-token"))
	if gotAuth != wantAuth {
		t.Fatalf("got Authorization %q, want %q", gotAuth, wantAuth)
	}
}

func TestAuthenticateFailsOnMissingKey(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{}`))
	}))
	defer server.Close()

	c := &Client{AccessToken: "bad-token", BaseURL: server.URL}
	if _, err := c.Authenticate(context.Background()); err == nil {
		t.Fatal("expected an error for a response with no nordlynx_private_key, got nil")
	}
}

func TestListCountries(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[{"id":228,"name":"Netherlands","code":"NL"},{"id":38,"name":"Canada","code":"CA"}]`))
	}))
	defer server.Close()

	c := &Client{BaseURL: server.URL}
	countries, err := c.ListCountries(context.Background())
	if err != nil {
		t.Fatalf("ListCountries: %v", err)
	}
	if len(countries) != 2 || countries[0].Name != "Netherlands" || countries[0].Code != "NL" {
		t.Fatalf("unexpected countries: %+v", countries)
	}
}

func TestConnectResolvesServerAndBuildsPeerConfig(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/v1/servers/recommendations") {
			w.Write([]byte(`[{
				"hostname": "nl123.nordvpn.com",
				"station": "1.2.3.4",
				"locations": [{"country": {"name": "Netherlands", "code": "NL", "id": 228}}],
				"technologies": [
					{"identifier": "openvpn_udp", "metadata": []},
					{"identifier": "wireguard_udp", "metadata": [{"name": "public_key", "value": "peerpubkey"}]}
				]
			}]`))
			return
		}
		t.Fatalf("unexpected request path: %s", r.URL.Path)
	}))
	defer server.Close()

	c := &Client{BaseURL: server.URL}
	peer, err := c.Connect(context.Background(), "privkey123", provider.ServerSelection{})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if peer.PrivateKey != "privkey123" {
		t.Fatalf("PrivateKey = %q", peer.PrivateKey)
	}
	if peer.PeerPublicKey != "peerpubkey" {
		t.Fatalf("PeerPublicKey = %q", peer.PeerPublicKey)
	}
	if peer.Endpoint != "1.2.3.4:51820" {
		t.Fatalf("Endpoint = %q", peer.Endpoint)
	}
	if peer.Address != nordlynxClientAddress {
		t.Fatalf("Address = %q, want %q", peer.Address, nordlynxClientAddress)
	}
	if peer.Country != "Netherlands" || peer.Server != "nl123.nordvpn.com" {
		t.Fatalf("Country/Server = %q/%q", peer.Country, peer.Server)
	}
	if len(peer.DNS) != 2 {
		t.Fatalf("DNS = %v", peer.DNS)
	}
}

func TestConnectWithCountryLooksUpCountryIDFirst(t *testing.T) {
	var recommendationsQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/v1/servers/countries"):
			w.Write([]byte(`[{"id":228,"name":"Netherlands","code":"NL"}]`))
		case strings.Contains(r.URL.Path, "/v1/servers/recommendations"):
			recommendationsQuery = r.URL.RawQuery
			w.Write([]byte(`[{
				"hostname": "nl1.nordvpn.com",
				"station": "5.6.7.8",
				"locations": [{"country": {"name": "Netherlands", "code": "NL", "id": 228}}],
				"technologies": [{"identifier": "wireguard_udp", "metadata": [{"name": "public_key", "value": "pk"}]}]
			}]`))
		default:
			t.Fatalf("unexpected request path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	c := &Client{BaseURL: server.URL}
	if _, err := c.Connect(context.Background(), "privkey", provider.ServerSelection{Country: "Netherlands"}); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if !strings.Contains(recommendationsQuery, "filters%5Bcountry_id%5D=228") {
		t.Fatalf("recommendations query %q did not filter by resolved country_id 228", recommendationsQuery)
	}
}

func TestConnectFailsWhenNoWireguardServerReturned(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[]`))
	}))
	defer server.Close()

	c := &Client{BaseURL: server.URL}
	if _, err := c.Connect(context.Background(), "privkey", provider.ServerSelection{}); err == nil {
		t.Fatal("expected an error when recommendations returns no servers, got nil")
	}
}

func TestListCities(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[
			{"id":228,"name":"Netherlands","code":"NL","cities":[{"id":9236,"name":"Amsterdam"},{"id":9237,"name":"Rotterdam"}]},
			{"id":38,"name":"Canada","code":"CA","cities":[{"id":5001,"name":"Toronto"}]}
		]`))
	}))
	defer server.Close()

	c := &Client{BaseURL: server.URL}
	cities, err := c.ListCities(context.Background(), "Netherlands")
	if err != nil {
		t.Fatalf("ListCities: %v", err)
	}
	if len(cities) != 2 || cities[0].Name != "Amsterdam" || cities[0].ID != "9236" {
		t.Fatalf("unexpected cities: %+v", cities)
	}
}

func TestListCitiesFailsForUnknownCountry(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[{"id":228,"name":"Netherlands","code":"NL","cities":[]}]`))
	}))
	defer server.Close()

	c := &Client{BaseURL: server.URL}
	if _, err := c.ListCities(context.Background(), "Atlantis"); err == nil {
		t.Fatal("expected an error for an unknown country, got nil")
	}
}

func TestListGroups(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[{"id":1,"name":"Double VPN","identifier":"legacy_double_vpn"},{"id":2,"name":"P2P","identifier":"legacy_p2p"}]`))
	}))
	defer server.Close()

	c := &Client{BaseURL: server.URL}
	groups, err := c.ListGroups(context.Background())
	if err != nil {
		t.Fatalf("ListGroups: %v", err)
	}
	if len(groups) != 2 || groups[0].Name != "Double VPN" || groups[0].Identifier != "legacy_double_vpn" {
		t.Fatalf("unexpected groups: %+v", groups)
	}
}

func TestConnectWithCityLooksUpCityIDFirst(t *testing.T) {
	var recommendationsQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/v1/servers/countries"):
			w.Write([]byte(`[{"id":228,"name":"Netherlands","code":"NL","cities":[{"id":9236,"name":"Amsterdam"}]}]`))
		case strings.Contains(r.URL.Path, "/v1/servers/recommendations"):
			recommendationsQuery = r.URL.RawQuery
			w.Write([]byte(`[{
				"hostname": "nl1.nordvpn.com",
				"station": "5.6.7.8",
				"locations": [{"country": {"name": "Netherlands", "code": "NL", "id": 228, "city": {"name": "Amsterdam"}}}],
				"technologies": [{"identifier": "wireguard_udp", "metadata": [{"name": "public_key", "value": "pk"}]}]
			}]`))
		default:
			t.Fatalf("unexpected request path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	c := &Client{BaseURL: server.URL}
	peer, err := c.Connect(context.Background(), "privkey", provider.ServerSelection{Country: "Netherlands", City: "Amsterdam"})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if !strings.Contains(recommendationsQuery, "filters%5Bcountry_city_id%5D=9236") {
		t.Fatalf("recommendations query %q did not filter by resolved country_city_id 9236", recommendationsQuery)
	}
	if peer.City != "Amsterdam" {
		t.Fatalf("peer.City = %q, want Amsterdam", peer.City)
	}
}

func TestConnectWithGroupFiltersByIdentifier(t *testing.T) {
	var recommendationsQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/v1/servers/recommendations") {
			t.Fatalf("unexpected request path: %s", r.URL.Path)
		}
		recommendationsQuery = r.URL.RawQuery
		w.Write([]byte(`[{
			"hostname": "nl-dv1.nordvpn.com",
			"station": "9.9.9.9",
			"locations": [{"country": {"name": "Netherlands", "code": "NL", "id": 228}}],
			"technologies": [{"identifier": "wireguard_udp", "metadata": [{"name": "public_key", "value": "pk"}]}]
		}]`))
	}))
	defer server.Close()

	c := &Client{BaseURL: server.URL}
	if _, err := c.Connect(context.Background(), "privkey", provider.ServerSelection{Group: "legacy_double_vpn"}); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if !strings.Contains(recommendationsQuery, "filters%5Bservers_groups%5D%5Bidentifier%5D=legacy_double_vpn") {
		t.Fatalf("recommendations query %q did not filter by servers_groups identifier", recommendationsQuery)
	}
}

func TestConnectCombinesCountryCityAndGroupFilters(t *testing.T) {
	var recommendationsQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/v1/servers/countries"):
			w.Write([]byte(`[{"id":228,"name":"Netherlands","code":"NL","cities":[{"id":9236,"name":"Amsterdam"}]}]`))
		case strings.Contains(r.URL.Path, "/v1/servers/recommendations"):
			recommendationsQuery = r.URL.RawQuery
			w.Write([]byte(`[{
				"hostname": "nl-dv1.nordvpn.com",
				"station": "9.9.9.9",
				"locations": [{"country": {"name": "Netherlands", "code": "NL", "id": 228, "city": {"name": "Amsterdam"}}}],
				"technologies": [{"identifier": "wireguard_udp", "metadata": [{"name": "public_key", "value": "pk"}]}]
			}]`))
		default:
			t.Fatalf("unexpected request path: %s", r.URL.Path)
		}
	}))
	defer server.Close()

	c := &Client{BaseURL: server.URL}
	selection := provider.ServerSelection{Country: "Netherlands", City: "Amsterdam", Group: "legacy_double_vpn"}
	if _, err := c.Connect(context.Background(), "privkey", selection); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if !strings.Contains(recommendationsQuery, "filters%5Bcountry_id%5D=228") ||
		!strings.Contains(recommendationsQuery, "filters%5Bcountry_city_id%5D=9236") ||
		!strings.Contains(recommendationsQuery, "filters%5Bservers_groups%5D%5Bidentifier%5D=legacy_double_vpn") {
		t.Fatalf("recommendations query %q did not combine all three filters", recommendationsQuery)
	}
}
