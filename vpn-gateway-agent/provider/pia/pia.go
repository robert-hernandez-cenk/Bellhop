// Package pia implements provider.Provider against PIA (Private Internet
// Access)'s WireGuard API -- confirmed live during this feature's design
// pass against PIA's own open-source reference scripts
// (github.com/pia-foss/manual-connections), not an official public API
// doc. Unlike NordVPN's single account-level private key (see
// provider/nordvpn), PIA has no fixed key: a fresh WireGuard keypair is
// generated locally on every Authenticate call, and the resulting public
// key is registered with whichever server Connect chooses via that
// server's own addKey endpoint.
package pia

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"

	"vpn-gateway-agent/netbind"
	"vpn-gateway-agent/provider"

	"golang.org/x/crypto/curve25519"
)

//go:embed ca.rsa.4096.crt
var caCertPEM []byte

// piaCAPool trusts PIA's own self-signed CA (confirmed live: currently
// served at
// https://raw.githubusercontent.com/pia-foss/manual-connections/master/ca.rsa.4096.crt,
// CN=Private Internet Access, valid until 2034-04-12) rather than the
// system trust store -- addKey's TLS cert is issued by PIA's own CA, not
// a public one, matching how the reference scripts use --cacert instead
// of the system CA bundle.
var piaCAPool = mustParseCAPool(caCertPEM)

func mustParseCAPool(pem []byte) *x509.CertPool {
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		panic("pia: failed to parse embedded ca.rsa.4096.crt")
	}
	return pool
}

// generateKeypair produces a fresh WireGuard keypair using the same
// Curve25519 clamping wg genkey/wg pubkey use, without shelling out --
// runner.Runner.Run has no way to pipe a private key into wg pubkey's
// stdin (its signature is fixed args only), and computing the public key
// directly is simpler and more testable than piping through two external
// processes.
func generateKeypair() (privateKeyB64, publicKeyB64 string, err error) {
	var priv [32]byte
	if _, err := rand.Read(priv[:]); err != nil {
		return "", "", err
	}
	priv[0] &= 248
	priv[31] &= 127
	priv[31] |= 64

	pub, err := curve25519.X25519(priv[:], curve25519.Basepoint)
	if err != nil {
		return "", "", err
	}
	return base64.StdEncoding.EncodeToString(priv[:]), base64.StdEncoding.EncodeToString(pub), nil
}

const tokenURL = "https://www.privateinternetaccess.com/api/client/v2/token"

// Client implements provider.Provider against PIA. HTTPClient/TokenURL/
// ServerListURL/AddKeyPort/AddKeyRootCAs are all production-unset,
// test-only overrides -- same pattern as nordvpn.Client's BaseURL/
// HTTPClient fields.
type Client struct {
	Username string
	Password string

	// HTTPClient overrides the client used for the token exchange and
	// server-list fetch -- unset in production, pointed at an
	// httptest.Server in tests.
	HTTPClient *http.Client
	// TokenURL overrides the token endpoint -- unset in production.
	TokenURL string
	// ServerListURL overrides the server-list endpoint -- unset in production.
	ServerListURL string
	// AddKeyPort overrides the addKey port (real PIA servers use 1337) --
	// unset in production, pointed at an httptest.NewTLSServer's port in
	// tests.
	AddKeyPort string
	// AddKeyRootCAs overrides the trusted CA pool for the addKey TLS
	// connection -- unset in production (uses the embedded PIA CA), set to
	// a pool containing the test server's own certificate in tests.
	AddKeyRootCAs *x509.CertPool

	// LocalIP, when set, binds addKey's TLS connection to this local
	// address -- addKey dials a server IP directly (see addKeyClient),
	// bypassing HTTPClient entirely, so it needs its own binding via
	// netbind.Dialer or it silently rides the gateway's own tunnel, the
	// exact bug netbind exists to avoid.
	LocalIP net.IP

	// token is the session token from Authenticate, cached for Connect's
	// later addKey call -- see provider.Provider's doc comment on why this
	// is safe: main.go constructs one Client and calls both methods on the
	// same instance.
	token string
}

func (c *Client) httpClient() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return http.DefaultClient
}

func (c *Client) tokenURL() string {
	if c.TokenURL != "" {
		return c.TokenURL
	}
	return tokenURL
}

// Authenticate exchanges the account's username/password for a session
// token (cached on c.token for Connect's later addKey call) and generates
// a fresh local WireGuard keypair -- unlike NordVPN, PIA has no
// account-level key to fetch; see generateKeypair's doc comment.
// VERIFY LIVE: confirm the response body actually contains a top-level
// "token" string field against a real account during deploy-vpn-gateway's
// first live --apply with --vpn pia.
func (c *Client) Authenticate(ctx context.Context) (string, error) {
	form := url.Values{"username": {c.Username}, "password": {c.Password}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.tokenURL(), strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return "", fmt.Errorf("pia: authenticate: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("pia: authenticate: unexpected status %d (check PIA_USERNAME/PIA_PASSWORD)", resp.StatusCode)
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", fmt.Errorf("pia: authenticate: decode: %w", err)
	}
	if body.Token == "" {
		return "", fmt.Errorf("pia: authenticate: response had no token")
	}
	c.token = body.Token

	privateKey, _, err := generateKeypair()
	if err != nil {
		return "", fmt.Errorf("pia: authenticate: generating keypair: %w", err)
	}
	return privateKey, nil
}

const serverListURL = "https://serverlist.piaservers.net/vpninfo/servers/v6"

type serverListServer struct {
	IP string `json:"ip"`
	CN string `json:"cn"`
}

type serverListRegion struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Servers struct {
		WG []serverListServer `json:"wg"`
	} `json:"servers"`
}

type serverList struct {
	Regions []serverListRegion `json:"regions"`
}

func (c *Client) serverListURL() string {
	if c.ServerListURL != "" {
		return c.ServerListURL
	}
	return serverListURL
}

func (c *Client) fetchServerList(ctx context.Context) (serverList, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.serverListURL(), nil)
	if err != nil {
		return serverList{}, err
	}
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return serverList{}, fmt.Errorf("pia: server list: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return serverList{}, fmt.Errorf("pia: server list: unexpected status %d", resp.StatusCode)
	}
	var list serverList
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		return serverList{}, fmt.Errorf("pia: server list: decode: %w", err)
	}
	return list, nil
}

// ListCountries feeds the Networking page's country dropdown. PIA has no
// separate "countries" concept -- its regions (e.g. "US Atlanta",
// "Netherlands") are the closest equivalent, so region id/name are reused
// as Country.Code/Name.
// VERIFY LIVE: confirm "id"/"name"/"servers.wg[].ip"/"servers.wg[].cn"
// against a real response during first deploy (confirmed live via a plain
// unauthenticated fetch while writing this, but re-check the exact field
// names haven't changed).
func (c *Client) ListCountries(ctx context.Context) ([]provider.Country, error) {
	list, err := c.fetchServerList(ctx)
	if err != nil {
		return nil, err
	}
	countries := make([]provider.Country, 0, len(list.Regions))
	for _, r := range list.Regions {
		countries = append(countries, provider.Country{Name: r.Name, Code: r.ID})
	}
	return countries, nil
}

// findRegion matches country case-insensitively against a region's id or
// name, or -- when country is empty -- returns the first region in the
// list. PIA has no "recommended/best" endpoint the way NordVPN does, so
// "first in the list" is the same non-magic default this codebase uses
// elsewhere rather than inventing a ranking.
func (c *Client) findRegion(list serverList, country string) (serverListRegion, error) {
	if country == "" {
		if len(list.Regions) == 0 {
			return serverListRegion{}, fmt.Errorf("pia: connect: server list returned no regions")
		}
		return list.Regions[0], nil
	}
	for _, r := range list.Regions {
		if strings.EqualFold(r.Name, country) || strings.EqualFold(r.ID, country) {
			return r, nil
		}
	}
	return serverListRegion{}, fmt.Errorf("pia: connect: unknown region %q", country)
}

type addKeyResponse struct {
	Status     string   `json:"status"`
	PeerIP     string   `json:"peer_ip"`
	ServerKey  string   `json:"server_key"`
	ServerPort int      `json:"server_port"`
	DNSServers []string `json:"dns_servers"`
}

func publicKeyFor(privateKeyB64 string) (string, error) {
	privBytes, err := base64.StdEncoding.DecodeString(privateKeyB64)
	if err != nil {
		return "", fmt.Errorf("pia: decoding private key: %w", err)
	}
	pub, err := curve25519.X25519(privBytes, curve25519.Basepoint)
	if err != nil {
		return "", fmt.Errorf("pia: deriving public key: %w", err)
	}
	return base64.StdEncoding.EncodeToString(pub), nil
}

// addKeyClient dials serverIP:port directly (PIA's servers' cn values are
// not publicly resolvable DNS names) but validates the TLS certificate
// against cn -- mirrors curl's --connect-to + --cacert, the mechanism
// PIA's own reference scripts use.
func (c *Client) addKeyClient(serverIP, cn, port string) *http.Client {
	pool := c.AddKeyRootCAs
	if pool == nil {
		pool = piaCAPool
	}
	dialAddr := net.JoinHostPort(serverIP, port)
	tlsDialer := &tls.Dialer{Config: &tls.Config{ServerName: cn, RootCAs: pool}}
	if d := netbind.Dialer(c.LocalIP); d != nil {
		tlsDialer.NetDialer = d
	}
	return &http.Client{
		Transport: &http.Transport{
			DialTLSContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
				return tlsDialer.DialContext(ctx, network, dialAddr)
			},
		},
	}
}

func (c *Client) addKeyPort() string {
	if c.AddKeyPort != "" {
		return c.AddKeyPort
	}
	return "1337"
}

func (c *Client) addKey(ctx context.Context, serverIP, cn, pubKey string) (addKeyResponse, error) {
	port := c.addKeyPort()
	client := c.addKeyClient(serverIP, cn, port)
	// addKeyClient builds a fresh *http.Transport (with no IdleConnTimeout,
	// so it never expires on its own) on every call -- this agent is
	// long-running and reconnects periodically via self-heal, so without
	// this the pooled TLS connection and its read-loop goroutine would leak
	// on every Connect. CloseIdleConnections is safe to call unconditionally
	// once this function is done with the client, even on the error paths
	// below.
	defer client.CloseIdleConnections()

	q := url.Values{}
	q.Set("pt", c.token)
	q.Set("pubKey", pubKey)
	reqURL := fmt.Sprintf("https://%s:%s/addKey?%s", cn, port, q.Encode())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return addKeyResponse{}, err
	}
	resp, err := client.Do(req)
	if err != nil {
		// *url.Error (what client.Do wraps a dial/transport failure in)
		// stringifies its own .URL field, which here includes the `pt=`
		// session token query parameter -- unwrap to the underlying error so
		// the token never reaches a log line or (more sensitively) the
		// unauthenticated LAN-facing POST /connect endpoint's error body.
		var uerr *url.Error
		if errors.As(err, &uerr) {
			err = uerr.Err
		}
		return addKeyResponse{}, fmt.Errorf("pia: addKey %s: %w", net.JoinHostPort(serverIP, port), err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return addKeyResponse{}, fmt.Errorf("pia: addKey: unexpected status %d", resp.StatusCode)
	}
	var body addKeyResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return addKeyResponse{}, fmt.Errorf("pia: addKey: decode: %w", err)
	}
	if body.Status != "OK" {
		return addKeyResponse{}, fmt.Errorf("pia: addKey: status %q", body.Status)
	}
	// PIA's addKey field names are marked "VERIFY LIVE" (see Connect's doc
	// comment) -- confirm the fields Connect actually depends on are
	// populated here rather than letting a missing/renamed field reach
	// Connect's PeerConfig silently. main.go indexes peer.DNS[0]
	// unconditionally, so an empty DNSServers slice would otherwise panic
	// there instead of failing loudly at the source.
	if body.PeerIP == "" || body.ServerKey == "" || body.ServerPort == 0 || len(body.DNSServers) == 0 {
		return addKeyResponse{}, fmt.Errorf(
			"pia: addKey: incomplete response from %q (peer_ip=%q server_key=%q server_port=%d dns_servers=%d) -- field names may have changed",
			cn, body.PeerIP, body.ServerKey, body.ServerPort, len(body.DNSServers),
		)
	}
	return body, nil
}

// Connect resolves a server in the given region and registers privateKey's
// public key with it via addKey, returning everything wireguard.Config
// needs. The WireGuard endpoint IP is the same server-list IP addKey was
// dialed against -- addKey's response has no separate "server_ip" field,
// only "server_port".
// VERIFY LIVE: confirm the addKey response fields
// ("status"/"peer_ip"/"server_key"/"server_port"/"dns_servers") against a
// real account during first deploy (confirmed while writing this against
// PIA's own reference scripts, not a real response).
func (c *Client) Connect(ctx context.Context, privateKey string, selection provider.ServerSelection) (provider.PeerConfig, error) {
	list, err := c.fetchServerList(ctx)
	if err != nil {
		return provider.PeerConfig{}, err
	}
	region, err := c.findRegion(list, selection.Country)
	if err != nil {
		return provider.PeerConfig{}, err
	}
	if len(region.Servers.WG) == 0 {
		return provider.PeerConfig{}, fmt.Errorf("pia: connect: region %q has no WireGuard servers", region.Name)
	}
	server := region.Servers.WG[0]

	pubKey, err := publicKeyFor(privateKey)
	if err != nil {
		return provider.PeerConfig{}, err
	}

	resp, err := c.addKey(ctx, server.IP, server.CN, pubKey)
	if err != nil {
		return provider.PeerConfig{}, err
	}

	return provider.PeerConfig{
		PrivateKey:    privateKey,
		Address:       resp.PeerIP + "/32",
		DNS:           resp.DNSServers,
		PeerPublicKey: resp.ServerKey,
		Endpoint:      fmt.Sprintf("%s:%d", server.IP, resp.ServerPort),
		Country:       region.Name,
		Server:        server.CN,
	}, nil
}
