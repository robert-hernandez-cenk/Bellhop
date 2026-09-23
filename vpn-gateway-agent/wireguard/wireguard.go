// Package wireguard renders wg0.conf and drives wg-quick/wg through an
// injected runner.Runner -- os/exec calls behind an interface so tests
// don't shell out for real.
package wireguard

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"vpn-gateway-agent/provider"
	"vpn-gateway-agent/runner"
)

const (
	// Interface name wg-quick manages -- "wg-quick up wg0" resolves this to
	// ConfigPath by convention (a bare interface name, not a path, tells
	// wg-quick to look in /etc/wireguard/<name>.conf).
	Interface = "wg0"
	// ConfigPath is where wg-quick's own naming convention expects wg0's
	// config to live.
	ConfigPath = "/etc/wireguard/wg0.conf"
	// healthyWithin is how stale wg's own last-handshake timestamp can be
	// before HealthCheck reports the tunnel down -- generously above the
	// agent's own 5-minute self-heal tick interval so one slow handshake
	// doesn't false-positive a healthy tunnel as down.
	healthyWithin = 6 * time.Minute
)

func Render(peer provider.PeerConfig) string {
	return fmt.Sprintf(`[Interface]
PrivateKey = %s
Address = %s
DNS = %s

[Peer]
PublicKey = %s
Endpoint = %s
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
`, peer.PrivateKey, peer.Address, strings.Join(peer.DNS, ","), peer.PeerPublicKey, peer.Endpoint)
}

type Manager struct {
	Runner     runner.Runner
	ConfigPath string
}

func NewManager(r runner.Runner) *Manager {
	return &Manager{Runner: r, ConfigPath: ConfigPath}
}

func (m *Manager) configPath() string {
	if m.ConfigPath != "" {
		return m.ConfigPath
	}
	return ConfigPath
}

// Up writes wg0.conf (0600 -- it embeds the account's private key) and runs
// wg-quick up. Safe to call when wg0 is already up in a previous config's
// state: Down (below) should be called first by any caller that needs a
// clean reconnect (POST /connect, self-heal), matching wg-quick's own
// expectation that "up" targets a currently-down interface.
func (m *Manager) Up(peer provider.PeerConfig) error {
	if err := os.WriteFile(m.configPath(), []byte(Render(peer)), 0o600); err != nil {
		return fmt.Errorf("wireguard: write %s: %w", m.configPath(), err)
	}
	if _, stderr, err := m.Runner.Run("wg-quick", "up", Interface); err != nil {
		return fmt.Errorf("wireguard: wg-quick up %s: %w (%s)", Interface, err, stderr)
	}
	return nil
}

// Down is idempotent from the caller's perspective in practice (wg-quick
// down on an already-down interface exits non-zero) -- callers that just
// want "ensure down" should ignore its error the way selfheal's reconnect
// path does, since the immediately-following Up is what actually matters.
func (m *Manager) Down() error {
	if _, stderr, err := m.Runner.Run("wg-quick", "down", Interface); err != nil {
		return fmt.Errorf("wireguard: wg-quick down %s: %w (%s)", Interface, err, stderr)
	}
	return nil
}

// HealthCheck runs `wg show wg0 latest-handshakes`, which prints one line
// per peer: "<peer-public-key>\t<unix-seconds-of-last-handshake>" (0 if
// there has never been one). A non-zero timestamp within healthyWithin
// counts as up -- WireGuard only re-handshakes when traffic actually flows,
// so a totally idle-but-still-working tunnel can go quiet between
// handshakes; healthyWithin is picked generously above the agent's own
// self-heal tick interval so that idle case doesn't false-positive as down.
func (m *Manager) HealthCheck() (bool, error) {
	stdout, stderr, err := m.Runner.Run("wg", "show", Interface, "latest-handshakes")
	if err != nil {
		return false, fmt.Errorf("wireguard: wg show %s latest-handshakes: %w (%s)", Interface, err, stderr)
	}
	fields := strings.Fields(stdout)
	if len(fields) < 2 {
		return false, nil
	}
	epoch, err := strconv.ParseInt(fields[1], 10, 64)
	if err != nil || epoch == 0 {
		return false, nil
	}
	last := time.Unix(epoch, 0)
	return time.Since(last) < healthyWithin, nil
}
