package pia

import (
	"context"
	"crypto/x509"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"vpn-gateway-agent/provider"
)

func TestGenerateKeypairProducesValidCurve25519Pair(t *testing.T) {
	priv1, pub1, err := generateKeypair()
	if err != nil {
		t.Fatalf("generateKeypair: %v", err)
	}
	privBytes, err := base64.StdEncoding.DecodeString(priv1)
	if err != nil {
		t.Fatalf("private key is not valid base64: %v", err)
	}
	if len(privBytes) != 32 {
		t.Fatalf("private key is %d bytes, want 32", len(privBytes))
	}
	// WireGuard's standard clamping (matches wg genkey's own output format).
	if privBytes[0]&0x07 != 0 {
		t.Fatalf("private key byte 0 not clamped: %08b", privBytes[0])
	}
	if privBytes[31]&0x80 != 0 {
		t.Fatalf("private key byte 31 high bit not cleared: %08b", privBytes[31])
	}
	if privBytes[31]&0x40 == 0 {
		t.Fatalf("private key byte 31 second-highest bit not set: %08b", privBytes[31])
	}

	pubBytes, err := base64.StdEncoding.DecodeString(pub1)
	if err != nil {
		t.Fatalf("public key is not valid base64: %v", err)
	}
	if len(pubBytes) != 32 {
		t.Fatalf("public key is %d bytes, want 32", len(pubBytes))
	}

	priv2, _, err := generateKeypair()
	if err != nil {
		t.Fatalf("generateKeypair (second call): %v", err)
	}
	if priv1 == priv2 {
		t.Fatal("two calls to generateKeypair produced the same private key -- randomness is broken")
	}
}

func TestPiaCAPoolParsesEmbeddedCert(t *testing.T) {
	if piaCAPool == nil {
		t.Fatal("piaCAPool is nil -- embedded ca.rsa.4096.crt failed to parse")
	}
}

func TestAuthenticateReturnsPrivateKeyAndCachesToken(t *testing.T) {
	var gotForm string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		gotForm = string(body)
		w.Write([]byte(`{"token":"session-token-123"}`))
	}))
	defer server.Close()

	c := &Client{Username: "p0123456", Password: "hunter2", TokenURL: server.URL}
	key, err := c.Authenticate(context.Background())
	if err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if key == "" {
		t.Fatal("Authenticate returned an empty private key")
	}
	if _, err := base64.StdEncoding.DecodeString(key); err != nil {
		t.Fatalf("returned private key is not valid base64: %v", err)
	}
	if gotForm != "password=hunter2&username=p0123456" {
		t.Fatalf("got form body %q", gotForm)
	}
	if c.token != "session-token-123" {
		t.Fatalf("token not cached on the client: got %q", c.token)
	}
}

func TestAuthenticateFailsOnMissingToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{}`))
	}))
	defer server.Close()

	c := &Client{Username: "p0123456", Password: "bad", TokenURL: server.URL}
	if _, err := c.Authenticate(context.Background()); err == nil {
		t.Fatal("expected an error for a response with no token, got nil")
	}
}

func TestListCountries(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"regions":[
			{"id":"us_atlanta","name":"US Atlanta","servers":{"wg":[{"ip":"1.2.3.4","cn":"atlanta123"}]}},
			{"id":"nl_amsterdam","name":"Netherlands","servers":{"wg":[{"ip":"5.6.7.8","cn":"amsterdam456"}]}}
		]}`))
	}))
	defer server.Close()

	c := &Client{ServerListURL: server.URL}
	countries, err := c.ListCountries(context.Background())
	if err != nil {
		t.Fatalf("ListCountries: %v", err)
	}
	if len(countries) != 2 || countries[0].Name != "US Atlanta" || countries[0].Code != "us_atlanta" {
		t.Fatalf("unexpected countries: %+v", countries)
	}
}

func TestConnectRegistersKeyWithFirstServerInMatchedRegion(t *testing.T) {
	var gotQuery string
	addKeyServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		w.Write([]byte(`{"status":"OK","peer_ip":"10.0.0.5","server_key":"serverpubkey","server_port":1337,"dns_servers":["10.0.0.242"]}`))
	}))
	defer addKeyServer.Close()

	cert := addKeyServer.Certificate()
	if len(cert.DNSNames) == 0 {
		t.Fatalf("test TLS server's certificate has no DNS SANs to pin against: %+v", cert)
	}
	cn := cert.DNSNames[0]
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	addKeyPort := addKeyServer.Listener.Addr().(*net.TCPAddr).Port

	listServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(fmt.Sprintf(`{"regions":[{"id":"us_atlanta","name":"US Atlanta","servers":{"wg":[{"ip":"127.0.0.1","cn":%q}]}}]}`, cn)))
	}))
	defer listServer.Close()

	c := &Client{
		ServerListURL: listServer.URL,
		AddKeyRootCAs: pool,
		AddKeyPort:    strconv.Itoa(addKeyPort),
		token:         "session-token",
	}
	privateKey, _, err := generateKeypair()
	if err != nil {
		t.Fatalf("generateKeypair: %v", err)
	}
	peer, err := c.Connect(context.Background(), privateKey, provider.ServerSelection{Country: "US Atlanta"})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if peer.PrivateKey != privateKey {
		t.Fatalf("PrivateKey = %q", peer.PrivateKey)
	}
	if peer.Address != "10.0.0.5/32" {
		t.Fatalf("Address = %q", peer.Address)
	}
	if peer.PeerPublicKey != "serverpubkey" {
		t.Fatalf("PeerPublicKey = %q", peer.PeerPublicKey)
	}
	if peer.Endpoint != "127.0.0.1:1337" {
		t.Fatalf("Endpoint = %q", peer.Endpoint)
	}
	if peer.Country != "US Atlanta" || peer.Server != cn {
		t.Fatalf("Country/Server = %q/%q", peer.Country, peer.Server)
	}
	if len(peer.DNS) != 1 || peer.DNS[0] != "10.0.0.242" {
		t.Fatalf("DNS = %v", peer.DNS)
	}
	if !strings.Contains(gotQuery, "pt=session-token") {
		t.Fatalf("addKey query %q did not include the cached token", gotQuery)
	}
}

func TestConnectFailsWhenLocalIPIsUnbindable(t *testing.T) {
	// Regression test for a round of review that found addKeyClient's TLS
	// dial was never actually bound to Client.LocalIP -- the wiring was
	// only caught by live testing against a real gateway, not by anything
	// in this suite. LocalIP is set here to an address from RFC 5737's
	// TEST-NET-3 range (203.0.113.0/24, reserved for documentation -- never
	// a real configured interface address), so if addKeyClient genuinely
	// carries LocalIP through to the real dial (via netbind.Dialer), the OS
	// refuses to bind and Connect fails. If this wiring were ever deleted,
	// addKeyClient would fall back to the default dialer and this test
	// would start passing (Connect would succeed against the httptest
	// server on loopback) instead of failing -- exactly the silent
	// regression this test exists to catch.
	addKeyServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"status":"OK","peer_ip":"10.0.0.5","server_key":"serverpubkey","server_port":1337,"dns_servers":["10.0.0.242"]}`))
	}))
	defer addKeyServer.Close()

	cert := addKeyServer.Certificate()
	if len(cert.DNSNames) == 0 {
		t.Fatalf("test TLS server's certificate has no DNS SANs to pin against: %+v", cert)
	}
	cn := cert.DNSNames[0]
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	addKeyPort := addKeyServer.Listener.Addr().(*net.TCPAddr).Port

	listServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(fmt.Sprintf(`{"regions":[{"id":"us_atlanta","name":"US Atlanta","servers":{"wg":[{"ip":"127.0.0.1","cn":%q}]}}]}`, cn)))
	}))
	defer listServer.Close()

	c := &Client{
		ServerListURL: listServer.URL,
		AddKeyRootCAs: pool,
		AddKeyPort:    strconv.Itoa(addKeyPort),
		token:         "session-token",
		LocalIP:       net.ParseIP("203.0.113.1"),
	}
	privateKey, _, err := generateKeypair()
	if err != nil {
		t.Fatalf("generateKeypair: %v", err)
	}
	peer, err := c.Connect(context.Background(), privateKey, provider.ServerSelection{Country: "US Atlanta"})
	if err == nil {
		t.Fatalf("expected Connect to fail when LocalIP cannot be bound, got peer: %+v", peer)
	}
}

func TestConnectFailsWhenAddKeyResponseMissingDNSServers(t *testing.T) {
	addKeyServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// status/peer_ip/server_key/server_port all present, but no
		// dns_servers -- a plausible real-world API drift (field renamed or
		// omitted) that addKey should catch rather than let through to
		// Connect, which would otherwise hand back a PeerConfig with an
		// empty DNS slice that main.go indexes unconditionally (peer.DNS[0]).
		w.Write([]byte(`{"status":"OK","peer_ip":"10.0.0.5","server_key":"serverpubkey","server_port":1337}`))
	}))
	defer addKeyServer.Close()

	cert := addKeyServer.Certificate()
	if len(cert.DNSNames) == 0 {
		t.Fatalf("test TLS server's certificate has no DNS SANs to pin against: %+v", cert)
	}
	cn := cert.DNSNames[0]
	pool := x509.NewCertPool()
	pool.AddCert(cert)
	addKeyPort := addKeyServer.Listener.Addr().(*net.TCPAddr).Port

	listServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(fmt.Sprintf(`{"regions":[{"id":"us_atlanta","name":"US Atlanta","servers":{"wg":[{"ip":"127.0.0.1","cn":%q}]}}]}`, cn)))
	}))
	defer listServer.Close()

	c := &Client{
		ServerListURL: listServer.URL,
		AddKeyRootCAs: pool,
		AddKeyPort:    strconv.Itoa(addKeyPort),
		token:         "session-token",
	}
	privateKey, _, err := generateKeypair()
	if err != nil {
		t.Fatalf("generateKeypair: %v", err)
	}
	peer, err := c.Connect(context.Background(), privateKey, provider.ServerSelection{Country: "US Atlanta"})
	if err == nil {
		t.Fatalf("expected Connect to fail on a response missing dns_servers, got peer: %+v", peer)
	}
	if !strings.Contains(err.Error(), "incomplete response") {
		t.Fatalf("expected an incomplete-response error, got: %v", err)
	}
}

func TestConnectFailsWhenServerCertDoesNotMatchCN(t *testing.T) {
	addKeyServer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"status":"OK","peer_ip":"10.0.0.5","server_key":"k","server_port":1337,"dns_servers":["10.0.0.242"]}`))
	}))
	defer addKeyServer.Close()

	pool := x509.NewCertPool()
	pool.AddCert(addKeyServer.Certificate())
	addKeyPort := addKeyServer.Listener.Addr().(*net.TCPAddr).Port

	listServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"regions":[{"id":"us_atlanta","name":"US Atlanta","servers":{"wg":[{"ip":"127.0.0.1","cn":"wrong-hostname.example"}]}}]}`))
	}))
	defer listServer.Close()

	c := &Client{
		ServerListURL: listServer.URL,
		AddKeyRootCAs: pool,
		AddKeyPort:    strconv.Itoa(addKeyPort),
		token:         "session-token",
	}
	privateKey, _, err := generateKeypair()
	if err != nil {
		t.Fatalf("generateKeypair: %v", err)
	}
	_, err = c.Connect(context.Background(), privateKey, provider.ServerSelection{})
	if err == nil {
		t.Fatal("expected a TLS error when the server list's cn doesn't match the certificate, got nil")
	}
	lowerErr := strings.ToLower(err.Error())
	if !strings.Contains(lowerErr, "tls") && !strings.Contains(lowerErr, "certificate") {
		t.Fatalf("expected error to mention a TLS/certificate failure, got: %v", err)
	}
}

func TestConnectFailsForUnknownRegion(t *testing.T) {
	listServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"regions":[{"id":"us_atlanta","name":"US Atlanta","servers":{"wg":[{"ip":"1.2.3.4","cn":"a"}]}}]}`))
	}))
	defer listServer.Close()

	c := &Client{ServerListURL: listServer.URL}
	privateKey, _, err := generateKeypair()
	if err != nil {
		t.Fatalf("generateKeypair: %v", err)
	}
	if _, err := c.Connect(context.Background(), privateKey, provider.ServerSelection{Country: "Atlantis"}); err == nil {
		t.Fatal("expected an error for an unknown region, got nil")
	}
}

func TestClientDoesNotImplementCityOrGroupLister(t *testing.T) {
	var c any = &Client{}
	if _, ok := c.(provider.CityLister); ok {
		t.Fatal("pia.Client unexpectedly implements provider.CityLister -- PIA has no city concept")
	}
	if _, ok := c.(provider.GroupLister); ok {
		t.Fatal("pia.Client unexpectedly implements provider.GroupLister -- PIA has no specialty-group concept")
	}
}
