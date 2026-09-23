// Package provider defines the seam both provider/nordvpn and provider/pia
// implement against -- main.go's selectProvider picks between them at
// startup based on VPN_PROVIDER.
package provider

import "context"

type Country struct {
	Name string `json:"name"`
	Code string `json:"code"`
}

// PeerConfig is everything wireguard.Config needs to render wg0.conf.
// Address is the client tunnel address to assign the wg0 interface -- how
// each provider derives it varies (see each provider's own Connect doc
// comment: NordVPN's NordLynx always assigns the same fixed address
// regardless of server/country, while PIA's is returned per-connection by
// its addKey response), so this field just carries whatever the provider
// decided rather than encoding either provider's specific behavior here.
type PeerConfig struct {
	PrivateKey    string
	Address       string
	DNS           []string
	PeerPublicKey string
	Endpoint      string
	Country       string
	City          string
	Server        string
}

// ServerSelection narrows which server Connect resolves. All three fields
// are optional (empty = no filter on that dimension) and combine
// simultaneously -- NordVPN's recommendations endpoint accepts country_id,
// country_city_id, and servers_groups filters together in one request, so
// there's no exclusivity logic to enforce here. City and Group are only
// honored by providers that implement CityLister/GroupLister (NordVPN);
// PIA ignores both, reading only Country.
type ServerSelection struct {
	Country string // name or code; empty = any/best (the original default)
	City    string // name; empty = any city within Country
	Group   string // NordVPN group identifier (e.g. "legacy_double_vpn"); empty = standard servers
}

type Provider interface {
	// Authenticate establishes this provider's WireGuard private key for the
	// session -- how varies per provider (see each provider's own
	// Authenticate doc comment: NordVPN exchanges its long-lived access
	// token for an account-level key already on file; PIA exchanges
	// username/password for a session token and generates a fresh local
	// keypair). Called once at startup; the result is passed into every
	// later Connect call rather than re-authenticating per connect.
	Authenticate(ctx context.Context) (privateKey string, err error)
	// ListCountries returns every country/region this provider currently
	// offers -- feeds the Networking page's country dropdown (GET /servers).
	ListCountries(ctx context.Context) ([]Country, error)
	// Connect resolves a concrete server matching selection (a zero-value
	// ServerSelection means "best/recommended, no filter") and returns
	// everything needed to bring up wg0. Called both at first startup and
	// on every POST /connect / self-heal retry.
	Connect(ctx context.Context, privateKey string, selection ServerSelection) (PeerConfig, error)
}

// CityLister is implemented by providers that support city-level
// filtering within a country. httpapi type-asserts Provider against this
// before serving GET /cities; providers that don't implement it (PIA) get
// a 404 there.
type CityLister interface {
	ListCities(ctx context.Context, country string) ([]City, error)
}

// GroupLister is implemented by providers that support specialty server
// groups (Double VPN, P2P, Onion Over VPN, Dedicated IP, ...). Same
// type-assertion pattern as CityLister, for GET /groups.
type GroupLister interface {
	ListGroups(ctx context.Context) ([]Group, error)
}

type City struct {
	Name string `json:"name"`
	ID   string `json:"id"`
}

type Group struct {
	Name       string `json:"name"`
	Identifier string `json:"identifier"`
}
