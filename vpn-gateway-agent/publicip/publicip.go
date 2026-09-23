// Package publicip resolves the public (internet-visible) egress IP for
// outbound requests made via a caller-supplied *http.Client. Used by the
// gateway agent to report which IP a guest routed through this gateway's
// tunnel would appear to have.
//
// NewTunnelClient's LocalAddr binding exists specifically so this lookup
// rides the WireGuard tunnel rather than the gateway's own
// control-traffic exemption (the `ip rule add from <GATEWAY_LAN_IP> lookup
// main` rule *planned* by the control-traffic-routing fix, issue #77 -- as
// of this writing, only that fix's design/plan are merged, not its
// implementation, so this binding is not yet load-bearing but is required
// once it ships): a request sourced from the tunnel's own address doesn't
// match that rule and falls through to wg-quick's catch-all default-route
// rule instead, correctly egressing via wg0. Until #77's code actually
// lands, all locally-originated gateway traffic already routes through the
// tunnel via wg-quick's own catch-all rule regardless of this binding, so a
// live check today can't validate the binding specifically.
package publicip

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// ipifyURL is a well-known, officially documented IP-echo service --
// unlike NordVPN/PIA's undocumented APIs elsewhere in this codebase, no
// VERIFY LIVE caveat is needed here.
const ipifyURL = "https://api.ipify.org?format=text"

// NewTunnelClient builds an http.Client whose outbound connections are
// sourced from tunnelIP (the WireGuard interface's own address, e.g.
// "10.5.0.2" -- callers strip any CIDR suffix before passing it in).
//
// Timeout bounds the whole request at 10s: since these requests are
// deliberately routed through the just-established tunnel, a blackholed
// tunnel would otherwise hang for a full TCP retry cycle (~130s) with no
// timeout to bound it -- and main.go's startup path calls this before the
// management API starts listening, so an unbounded hang here would stall
// agent startup entirely, not just the public-IP field.
//
// Known limitation: LocalAddr only affects the TCP connection to the
// already-resolved IP -- Go's default resolver does its own separate DNS
// lookup that isn't sourced from tunnelIP, so once #77 ships, the
// api.ipify.org DNS lookup itself could still take the exempted LAN path
// rather than riding the tunnel. Not fixed here (would need a custom
// net.Resolver); harmless today since #77 isn't implemented yet.
//
// Callers must call CloseIdleConnections on the returned client once done
// with it -- this agent is long-running and reconnects periodically via
// self-heal, so without that the pooled connection and its read/write-loop
// goroutines would leak on every call (same pattern as
// provider/pia.Client.addKey's addKeyClient).
func NewTunnelClient(tunnelIP string) *http.Client {
	dialer := &net.Dialer{LocalAddr: &net.TCPAddr{IP: net.ParseIP(tunnelIP)}}
	return &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			DialContext: dialer.DialContext,
		},
	}
}

// ResolvePublicIP queries the IP-echo service via httpClient and returns
// the trimmed response body. baseURL overrides the ipify endpoint for
// tests; empty uses the real one.
func ResolvePublicIP(ctx context.Context, httpClient *http.Client, baseURL string) (string, error) {
	url := ipifyURL
	if baseURL != "" {
		url = baseURL
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("publicip: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("publicip: unexpected status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(body)), nil
}
