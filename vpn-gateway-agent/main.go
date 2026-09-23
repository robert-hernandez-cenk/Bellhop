// Command vpn-gateway-agent runs on nordvpn-gateway-lxc/pia-gateway-lxc: it
// brings up the provider's WireGuard tunnel, applies the kill-switch,
// serves the LAN-only management API, and self-heals the tunnel on a
// ticker. Thin wiring only -- like src/lib/ssh-client.ts on the TypeScript
// side, this file has no automated test; the packages it wires
// (provider/nordvpn, provider/pia, wireguard, netctl, httpapi, selfheal,
// netbind) each have their own, and this file itself is verified by
// deploying it live.
package main

import (
	"context"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"vpn-gateway-agent/httpapi"
	"vpn-gateway-agent/netbind"
	"vpn-gateway-agent/netctl"
	"vpn-gateway-agent/provider"
	"vpn-gateway-agent/provider/nordvpn"
	"vpn-gateway-agent/provider/pia"
	"vpn-gateway-agent/publicip"
	"vpn-gateway-agent/runner"
	"vpn-gateway-agent/selfheal"
	"vpn-gateway-agent/state"
	"vpn-gateway-agent/wireguard"
)

const (
	statePath        = "/var/lib/vpn-gateway/state.json"
	listenAddr       = ":8080"
	healthCheckEvery = 5 * time.Minute
)

// validatedGatewayLanIP reads GATEWAY_LAN_IP and returns it only if it
// parses as a real IPv4 address (see netbind.ParseLanIP). An empty or
// malformed value is treated identically (warn, return nil) -- so a
// rollout typo degrades to "the gateway's own provider-API calls may fail
// if the current exit node has a bad path", exactly like never setting it
// at all, rather than crashing the whole agent (via netctl.Apply's ip rule
// add failing, then log.Fatalf below) over a bad env var.
func validatedGatewayLanIP() net.IP {
	raw := os.Getenv("GATEWAY_LAN_IP")
	ip, ok := netbind.ParseLanIP(raw)
	if !ok {
		if raw == "" {
			log.Print("warning: GATEWAY_LAN_IP is not set -- this gateway's own calls to the VPN provider's API will ride its own tunnel, which can fail if the current exit node has a bad path to the provider")
		} else {
			log.Printf("warning: GATEWAY_LAN_IP=%q is not a valid IPv4 address -- ignoring it, same as if it were unset", raw)
		}
		return nil
	}
	return ip
}

// validatedDNSServer reads GATEWAY_DNS_SERVER and returns it only if it's a
// well-formed host:port -- unlike GATEWAY_LAN_IP, a malformed value here
// (e.g. missing the port) would make every DNS lookup fail outright,
// turning what's meant to be a helpful override into a total provider-API
// outage. Falls back to "" (netbind.HTTPClient's own DefaultDNSServer) the
// same way an unset value does.
func validatedDNSServer() string {
	raw := os.Getenv("GATEWAY_DNS_SERVER")
	if raw == "" {
		return ""
	}
	if _, _, err := net.SplitHostPort(raw); err != nil {
		log.Printf("warning: GATEWAY_DNS_SERVER=%q is not a valid host:port -- ignoring it, using the default", raw)
		return ""
	}
	return raw
}

// selectProvider reads VPN_PROVIDER and the credential env vars it implies
// -- an explicit marker rather than inferring the provider from which
// credential vars happen to be set, so a stray leftover var (e.g. from
// testing) or a typo'd var name fails loudly instead of silently picking
// the wrong provider. GATEWAY_DNS_SERVER optionally overrides the DNS
// server netbind.HTTPClient uses (default: netbind.DefaultDNSServer) --
// fixable without a rebuild if the default ever turns out to be blocked
// from a given gateway's network.
func selectProvider(lanIP net.IP) provider.Provider {
	httpClient := netbind.HTTPClient(lanIP, validatedDNSServer())
	switch providerName := os.Getenv("VPN_PROVIDER"); providerName {
	case "nordvpn":
		accessToken := os.Getenv("NORDVPN_ACCESS_TOKEN")
		if accessToken == "" {
			log.Fatal("NORDVPN_ACCESS_TOKEN is not set")
		}
		return &nordvpn.Client{AccessToken: accessToken, HTTPClient: httpClient}
	case "pia":
		username := os.Getenv("PIA_USERNAME")
		password := os.Getenv("PIA_PASSWORD")
		if username == "" || password == "" {
			log.Fatal("PIA_USERNAME and PIA_PASSWORD must both be set")
		}
		return &pia.Client{Username: username, Password: password, HTTPClient: httpClient, LocalIP: lanIP}
	default:
		log.Fatalf("VPN_PROVIDER must be 'nordvpn' or 'pia', got %q", providerName)
		return nil // unreachable -- log.Fatalf exits the process
	}
}

func main() {
	lanIP := validatedGatewayLanIP()
	vpn := selectProvider(lanIP)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	lanIPStr := ""
	if lanIP != nil {
		lanIPStr = lanIP.String()
	}
	nc := &netctl.Manager{Runner: runner.ExecRunner{}}
	if err := nc.ApplyKillSwitch(wireguard.Interface); err != nil {
		log.Fatalf("applying kill-switch: %v", err)
	}
	if err := nc.ApplyLanBypass(lanIPStr); err != nil {
		log.Printf("warning: could not apply the LAN-bypass rule for GATEWAY_LAN_IP=%q: %v -- the gateway's own calls to the VPN provider's API may still ride its own tunnel", lanIPStr, err)
	}

	privateKey, err := vpn.Authenticate(ctx)
	if err != nil {
		log.Fatalf("authenticating: %v", err)
	}

	wg := wireguard.NewManager(runner.ExecRunner{})

	s, err := state.Load(statePath)
	if err != nil {
		log.Fatalf("loading state: %v", err)
	}
	peer, err := vpn.Connect(ctx, privateKey, provider.ServerSelection{Country: s.Country, City: s.City, Group: s.Group})
	if err != nil {
		log.Fatalf("resolving initial server: %v", err)
	}
	// best-effort -- ignored the same way httpapi/selfheal ignore it. wg0 is
	// kernel state that outlives this process: neither a log.Fatal (which
	// skips defers) nor the SIGTERM path (which only shuts the HTTP server
	// down) tears it down. Without this, every restart -- operator-initiated,
	// systemd's Restart=on-failure after a crash, or a retry after a
	// transient provider API failure at startup -- hits "interface already
	// exists" on wg-quick up, log.Fatal's, and gets retried identically
	// forever, so the gateway could never come back once restarted.
	wg.Down()
	if err := wg.Up(peer); err != nil {
		log.Fatalf("bringing up wg0: %v", err)
	}
	publicIP := ""
	if tunnelIP, _, err := net.ParseCIDR(peer.Address); err == nil {
		client := publicip.NewTunnelClient(tunnelIP.String())
		ip, ipErr := publicip.ResolvePublicIP(ctx, client, "")
		// See publicip.NewTunnelClient's doc comment: this agent is
		// long-running and reconnects periodically via self-heal, so
		// without this the pooled connection and its read/write-loop
		// goroutines would leak on every call.
		client.CloseIdleConnections()
		if ipErr == nil {
			publicIP = ip
		} else {
			log.Printf("warning: resolving public IP failed: %v", ipErr)
		}
	}
	now := time.Now()
	initial := state.State{
		// Country/City/Group all carry forward the loaded prior state (s),
		// not peer's resolved values -- see httpapi.handleConnect's comment
		// on newState.City for why peer.City (and, by the same rationale,
		// peer.Country) must never be the source of what gets persisted as
		// the requested selection. ResolvedCountry/ResolvedCity ARE set from
		// peer's resolved values below -- they're live observations, not
		// sticky preferences, same as handleConnect/RunOnce already do.
		Connected: true, Country: s.Country, ResolvedCountry: peer.Country, City: s.City, ResolvedCity: peer.City, Group: s.Group, PublicIP: publicIP, Server: peer.Server,
		DNS: peer.DNS[0], Since: now, LastHealthCheck: now, LastHealthCheckOK: true,
	}
	if err := state.Save(statePath, initial); err != nil {
		log.Fatalf("saving initial state: %v", err)
	}
	log.Printf("connected: country=%s server=%s", peer.Country, peer.Server)

	healDeps := selfheal.Deps{Provider: vpn, WG: wg, StatePath: statePath, PrivateKey: privateKey}
	go selfheal.Loop(ctx, healDeps, healthCheckEvery, func(err error) {
		log.Printf("self-heal cycle failed: %v", err)
	})

	handler := httpapi.NewHandler(httpapi.Deps{Provider: vpn, WG: wg, StatePath: statePath, PrivateKey: privateKey})
	server := &http.Server{Addr: listenAddr, Handler: handler}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.Shutdown(shutdownCtx)
	}()

	log.Printf("listening on %s", listenAddr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("http server: %v", err)
	}
}
