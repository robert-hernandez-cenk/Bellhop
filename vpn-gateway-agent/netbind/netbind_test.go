package netbind

import (
	"context"
	"net"
	"net/http"
	"testing"
)

func TestParseLanIPAcceptsValidIPv4(t *testing.T) {
	ip, ok := ParseLanIP("192.168.1.15")
	if !ok {
		t.Fatal("ParseLanIP: want ok=true for a valid IPv4 literal")
	}
	if ip.String() != "192.168.1.15" {
		t.Fatalf("ParseLanIP: got %s, want 192.168.1.15", ip)
	}
}

func TestParseLanIPRejectsEmpty(t *testing.T) {
	if _, ok := ParseLanIP(""); ok {
		t.Fatal("ParseLanIP: want ok=false for an empty string")
	}
}

func TestParseLanIPRejectsMalformed(t *testing.T) {
	if _, ok := ParseLanIP("192.168.1.999"); ok {
		t.Fatal("ParseLanIP: want ok=false for a malformed IP")
	}
}

func TestParseLanIPRejectsIPv6(t *testing.T) {
	// netctl's ip rule/iptables commands and this whole mechanism are
	// IPv4-only -- an IPv6 literal would parse fine as a net.IP but isn't
	// usable here, and should degrade the same way an invalid value does.
	if _, ok := ParseLanIP("::1"); ok {
		t.Fatal("ParseLanIP: want ok=false for an IPv6 literal")
	}
}

func TestHTTPClientReturnsNilForNilIP(t *testing.T) {
	if c := HTTPClient(nil, ""); c != nil {
		t.Fatalf("HTTPClient(nil, \"\"): want nil, got %v", c)
	}
}

func TestHTTPClientBindsToProvidedIP(t *testing.T) {
	ip := net.ParseIP("192.168.1.15")
	c := HTTPClient(ip, "")
	if c == nil {
		t.Fatal("HTTPClient: want a non-nil client for a valid IP")
	}
	transport, ok := c.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("HTTPClient: Transport is %T, want *http.Transport", c.Transport)
	}
	if transport.DialContext == nil {
		t.Fatal("HTTPClient: Transport.DialContext is nil")
	}
	if transport.TLSHandshakeTimeout == 0 {
		t.Fatal("HTTPClient: Transport.TLSHandshakeTimeout is unset -- want a bounded timeout")
	}
}

func TestHTTPClientDialContextUsesBoundLocalAddr(t *testing.T) {
	// Proves the composition end-to-end, not just each piece in isolation:
	// dial to a real loopback listener with the client's local address
	// forced to an IP from RFC 5737's TEST-NET-3 range (203.0.113.0/24,
	// reserved for documentation -- never a real configured interface
	// address), so the OS refuses to bind. That failure only happens if
	// HTTPClient's Transport.DialContext genuinely carries the bound
	// LocalAddr through to the real dial -- if binding were silently
	// dropped somewhere in the chain, this dial would just succeed against
	// loopback instead.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	defer ln.Close()

	c := HTTPClient(net.ParseIP("203.0.113.1"), "")
	transport, ok := c.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("Transport is %T, want *http.Transport", c.Transport)
	}
	_, err = transport.DialContext(context.Background(), "tcp", ln.Addr().String())
	if err == nil {
		t.Fatal("DialContext: want an error binding from an address not present on any local interface, got nil")
	}
}

func TestLocalAddrForNetworkPicksTypeMatchingDialFamily(t *testing.T) {
	// Regression test for a real bug caught in review: net.Dialer.DialContext
	// requires LocalAddr's concrete type to match the dial's network family
	// (*net.TCPAddr for "tcp*", *net.UDPAddr for "udp*") or the dial fails
	// outright with "mismatched local address type". Go's DNS resolver uses
	// "udp" normally and "tcp" as its truncated-response fallback, so both
	// must be handled.
	ip := net.ParseIP("192.168.1.15")
	cases := []struct {
		network string
		wantTCP bool
	}{
		{"tcp", true}, {"tcp4", true}, {"tcp6", true},
		{"udp", false}, {"udp4", false}, {"udp6", false},
	}
	for _, c := range cases {
		addr := localAddrForNetwork(ip, c.network)
		_, isTCP := addr.(*net.TCPAddr)
		_, isUDP := addr.(*net.UDPAddr)
		if c.wantTCP && !isTCP {
			t.Errorf("localAddrForNetwork(_, %q) = %T, want *net.TCPAddr", c.network, addr)
		}
		if !c.wantTCP && !isUDP {
			t.Errorf("localAddrForNetwork(_, %q) = %T, want *net.UDPAddr", c.network, addr)
		}
	}
}

func TestDialerSetsLocalAddrAndTimeout(t *testing.T) {
	ip := net.ParseIP("192.168.1.15")
	d := Dialer(ip)
	tcpAddr, ok := d.LocalAddr.(*net.TCPAddr)
	if !ok {
		t.Fatalf("Dialer: LocalAddr is %T, want *net.TCPAddr", d.LocalAddr)
	}
	if !tcpAddr.IP.Equal(ip) {
		t.Fatalf("Dialer: LocalAddr.IP = %s, want %s", tcpAddr.IP, ip)
	}
	if d.Timeout == 0 {
		t.Fatal("Dialer: Timeout is unset -- want a bounded timeout")
	}
}
