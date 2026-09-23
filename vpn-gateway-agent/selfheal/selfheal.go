// Package selfheal implements the background ticker that health-checks
// wg0 every interval, and on failure, transparently reconnects using the
// same pick-server/rewrite-config/wg-quick-down-up flow POST /connect
// triggers manually.
package selfheal

import (
	"context"
	"net"
	"time"

	"vpn-gateway-agent/provider"
	"vpn-gateway-agent/publicip"
	"vpn-gateway-agent/state"
)

// runOnceTimeout bounds a single self-heal cycle -- without it, a stalled
// provider-API call (e.g. a peer that completes TCP/TLS and then never
// sends response headers) would wedge RunOnce forever, since it's normally
// called with main's signal-handling context, which has no deadline of its
// own. That would silently stop the self-heal ticker from ever firing
// again for the rest of the process's life.
const runOnceTimeout = 2 * time.Minute

type WireguardManager interface {
	Up(peer provider.PeerConfig) error
	Down() error
	HealthCheck() (bool, error)
}

type Deps struct {
	Provider   provider.Provider
	WG         WireguardManager
	StatePath  string
	PrivateKey string
	Now        func() time.Time
	// ResolvePublicIP -- see httpapi.Deps's field of the same name for the
	// full rationale; same nil-in-production, override-in-tests pattern.
	ResolvePublicIP func(ctx context.Context, tunnelIP string) (string, error)
}

func (d Deps) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

func (d Deps) resolvePublicIP(ctx context.Context, tunnelIP string) string {
	resolve := d.ResolvePublicIP
	if resolve == nil {
		resolve = func(ctx context.Context, tunnelIP string) (string, error) {
			client := publicip.NewTunnelClient(tunnelIP)
			// See publicip.NewTunnelClient's doc comment: this agent is
			// long-running and reconnects periodically via self-heal, so
			// without this the pooled connection and its read/write-loop
			// goroutines would leak on every call.
			defer client.CloseIdleConnections()
			return publicip.ResolvePublicIP(ctx, client, "")
		}
	}
	ip, err := resolve(ctx, tunnelIP)
	if err != nil {
		return ""
	}
	return ip
}

// RunOnce performs a single health-check/self-heal cycle. Exported
// separately from Loop so tests can drive exactly one tick deterministically
// instead of racing a real timer.
func RunOnce(ctx context.Context, d Deps) error {
	s, err := state.Load(d.StatePath)
	if err != nil {
		return err
	}

	healthy, hcErr := d.WG.HealthCheck()
	now := d.now()
	s.LastHealthCheck = now

	if healthy && hcErr == nil {
		s.LastHealthCheckOK = true
		return state.Save(d.StatePath, s)
	}

	s.LastHealthCheckOK = false
	peer, err := d.Provider.Connect(ctx, d.PrivateKey, provider.ServerSelection{Country: s.Country, City: s.City, Group: s.Group})
	if err != nil {
		s.Connected = false
		_ = state.Save(d.StatePath, s)
		return err
	}
	d.WG.Down() // best-effort, same as httpapi's handleConnect
	if err := d.WG.Up(peer); err != nil {
		s.Connected = false
		_ = state.Save(d.StatePath, s)
		return err
	}
	publicIP := ""
	if tunnelIP, _, err := net.ParseCIDR(peer.Address); err == nil {
		publicIP = d.resolvePublicIP(ctx, tunnelIP.String())
	}
	s.Connected = true
	// s.Country is deliberately left untouched here, exactly like s.City
	// and s.Group: s already carries the operator's requested selection
	// (see httpapi.handleConnect's comment on newState.Country), and
	// peer.Country must never overwrite what's persisted for the next
	// reconnect. s.ResolvedCountry, by contrast, *is* reassigned below on
	// every successful reconnect -- like s.ResolvedCity, it's not a sticky
	// preference but a live observation of what this reconnect actually
	// landed on.
	s.ResolvedCountry = peer.Country
	// s.City is deliberately left untouched here, exactly like s.Group
	// (never reassigned in this function either): s already carries the
	// operator's requested selection (see httpapi.handleConnect's comment
	// on newState.City), and peer.City (the resolved value) is
	// unreliable/VERIFY-LIVE-flagged, so it must never overwrite what's
	// persisted for the next reconnect. s.ResolvedCity, by contrast, *is*
	// reassigned below on every successful reconnect -- unlike s.City it's
	// not a sticky preference but a live observation of what this
	// reconnect actually landed on, and a self-heal reconnect can land on a
	// different actual server than the last one.
	s.ResolvedCity = peer.City
	s.PublicIP = publicIP
	s.Server = peer.Server
	s.Since = now
	return state.Save(d.StatePath, s)
}

// Loop calls RunOnce every interval until ctx is cancelled. Errors are
// swallowed here (RunOnce already persists failure state to state.json for
// /status to report) -- the caller passes an onError hook only for logging,
// never to stop the loop, since a transient NordVPN API outage shouldn't
// kill the whole agent.
func Loop(ctx context.Context, d Deps, interval time.Duration, onError func(error)) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			runCtx, cancel := context.WithTimeout(ctx, runOnceTimeout)
			err := RunOnce(runCtx, d)
			cancel()
			if err != nil && onError != nil {
				onError(err)
			}
		}
	}
}
