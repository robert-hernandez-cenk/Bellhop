// Package netbind builds HTTP clients and dialers whose outbound
// connections -- and DNS lookups -- are explicitly sourced from a given
// local IP, so they're matched by netctl's LAN-bypass ip rule instead of
// riding the gateway's own WireGuard tunnel. A fresh, unbound outbound
// connection has no source address yet at the point the kernel's
// routing-rule lookup runs, so an ip rule keyed on "from <lanIP>" never
// matches it -- confirmed live against two real deployed gateways (a real
// socket connect still bound from the tunnel's internal address even with
// the rule present). Everything here exists to close that gap for the
// agent's own provider-API calls.
package netbind

import (
	"context"
	"net"
	"net/http"
	"strings"
	"time"
)

// DefaultDNSServer is used for DNS lookups when no override is given -- the
// tunnel's own DNS server (set via wireguard.Render's DNS = line) generally
// only answers clients actually inside the tunnel, defeating the purpose of
// binding DNS lookups to lanIP in the first place.
const DefaultDNSServer = "1.1.1.1:53"

const dialTimeout = 30 * time.Second

// ParseLanIP validates raw as a genuine IPv4 address. Returns nil, false
// for anything else -- empty, malformed, or an IPv6 literal, since netctl's
// ip rule/iptables commands (and this package) are IPv4-only.
func ParseLanIP(raw string) (net.IP, bool) {
	if raw == "" {
		return nil, false
	}
	ip := net.ParseIP(raw)
	if ip == nil {
		return nil, false
	}
	v4 := ip.To4()
	if v4 == nil {
		return nil, false
	}
	return v4, true
}

// Dialer returns a *net.Dialer whose outbound TCP connections are sourced
// from lanIP, with a bounded connect timeout matching Go's own
// http.DefaultTransport. Returns nil for a nil lanIP -- mirrors
// HTTPClient's nil-on-nil contract, so a caller must handle "no LAN IP
// configured" explicitly rather than silently getting a wildcard-bound
// dialer. Binds connections only, not DNS lookups -- fine for a caller
// (e.g. pia's addKeyClient) that dials a literal IP, not a substitute for
// HTTPClient when the caller needs hostname resolution too.
func Dialer(lanIP net.IP) *net.Dialer {
	if lanIP == nil {
		return nil
	}
	return &net.Dialer{
		Timeout:   dialTimeout,
		LocalAddr: &net.TCPAddr{IP: lanIP},
	}
}

// localAddrForNetwork returns the net.Addr type Go's DNS resolver's custom
// Dial hook must use for the given network: net.Dialer.DialContext requires
// LocalAddr's concrete type to match the dial's network family
// (*net.TCPAddr for "tcp"/"tcp4"/"tcp6", *net.UDPAddr for
// "udp"/"udp4"/"udp6") or the dial fails outright with "mismatched local
// address type", breaking the fallback. Go's resolver dials "udp" normally
// and "tcp" as its fallback when a UDP response comes back truncated.
func localAddrForNetwork(lanIP net.IP, network string) net.Addr {
	if strings.HasPrefix(network, "tcp") {
		return &net.TCPAddr{IP: lanIP}
	}
	return &net.UDPAddr{IP: lanIP}
}

// HTTPClient returns an *http.Client whose connections and DNS lookups are
// both bound to lanIP -- see the package doc comment for why binding is
// necessary at all. dnsServer (host:port) is queried for every DNS lookup,
// ignoring whatever the OS resolver would otherwise have used, so lookups
// don't depend on being inside the gateway's own tunnel; pass "" to use
// DefaultDNSServer. Returns nil (meaning: caller falls back to
// http.DefaultClient) when lanIP is nil.
//
// The returned Transport is intentionally minimal -- dial, TLS handshake,
// and idle-connection timeouts only, not a full replica of
// http.DefaultTransport (no HTTP/2 upgrade, no proxy support, no
// keep-alive tuning). Neither matters for the gateway's own direct
// provider-API calls.
func HTTPClient(lanIP net.IP, dnsServer string) *http.Client {
	if lanIP == nil {
		return nil
	}
	if dnsServer == "" {
		dnsServer = DefaultDNSServer
	}
	dialer := Dialer(lanIP)
	dialer.Resolver = &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			resolverDialer := &net.Dialer{Timeout: dialTimeout, LocalAddr: localAddrForNetwork(lanIP, network)}
			return resolverDialer.DialContext(ctx, network, dnsServer)
		},
	}
	return &http.Client{Transport: &http.Transport{
		DialContext:           dialer.DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		IdleConnTimeout:       90 * time.Second,
	}}
}
