package wireguard

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"vpn-gateway-agent/provider"
)

type fakeRunner struct {
	calls   [][]string
	outputs map[string]struct {
		stdout string
		stderr string
		err    error
	}
}

func (f *fakeRunner) Run(name string, args ...string) (string, string, error) {
	call := append([]string{name}, args...)
	f.calls = append(f.calls, call)
	key := strings.Join(call, " ")
	if out, ok := f.outputs[key]; ok {
		return out.stdout, out.stderr, out.err
	}
	return "", "", nil
}

func TestRenderProducesValidWgQuickSyntax(t *testing.T) {
	peer := provider.PeerConfig{
		PrivateKey:    "priv",
		Address:       "10.5.0.2/32",
		DNS:           []string{"103.86.96.100", "103.86.99.100"},
		PeerPublicKey: "pub",
		Endpoint:      "1.2.3.4:51820",
	}
	got := Render(peer)
	for _, want := range []string{
		"[Interface]", "PrivateKey = priv", "Address = 10.5.0.2/32",
		"DNS = 103.86.96.100,103.86.99.100", "[Peer]", "PublicKey = pub",
		"Endpoint = 1.2.3.4:51820", "AllowedIPs = 0.0.0.0/0, ::/0",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("Render output missing %q:\n%s", want, got)
		}
	}
}

func TestUpWritesConfigThenRunsWgQuickUp(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "wg0.conf")
	r := &fakeRunner{}
	m := &Manager{Runner: r, ConfigPath: configPath}

	err := m.Up(provider.PeerConfig{PrivateKey: "priv", PeerPublicKey: "pub", Endpoint: "1.2.3.4:51820", Address: "10.5.0.2/32"})
	if err != nil {
		t.Fatalf("Up: %v", err)
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("reading config: %v", err)
	}
	if !strings.Contains(string(data), "PrivateKey = priv") {
		t.Fatalf("config file missing private key:\n%s", data)
	}
	// NTFS has no POSIX permission bits (os.WriteFile's mode argument is a
	// no-op for the write-protection bits Windows actually enforces) -- the
	// real deploy target is always a Linux LXC, so this assertion only
	// makes sense there. Confirmed live on this repo's own dev machine.
	if runtime.GOOS != "windows" {
		info, err := os.Stat(configPath)
		if err != nil {
			t.Fatalf("stat: %v", err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("config perms = %v, want 0600", info.Mode().Perm())
		}
	}
	if len(r.calls) != 1 || r.calls[0][0] != "wg-quick" || r.calls[0][1] != "up" || r.calls[0][2] != Interface {
		t.Fatalf("unexpected calls: %v", r.calls)
	}
}

func TestUpReturnsErrorWhenWgQuickFails(t *testing.T) {
	dir := t.TempDir()
	r := &fakeRunner{outputs: map[string]struct {
		stdout string
		stderr string
		err    error
	}{
		"wg-quick up wg0": {stderr: "boom", err: errors.New("exit status 1")},
	}}
	m := &Manager{Runner: r, ConfigPath: filepath.Join(dir, "wg0.conf")}
	err := m.Up(provider.PeerConfig{})
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("expected error containing stderr, got %v", err)
	}
}

func TestHealthCheckHealthyWhenRecentHandshake(t *testing.T) {
	r := &fakeRunner{outputs: map[string]struct {
		stdout string
		stderr string
		err    error
	}{
		"wg show wg0 latest-handshakes": {stdout: "peerpubkey\t9999999999\n"},
	}}
	m := &Manager{Runner: r}
	ok, err := m.HealthCheck()
	if err != nil {
		t.Fatalf("HealthCheck: %v", err)
	}
	if !ok {
		t.Fatal("expected healthy for a future/near-now handshake timestamp")
	}
}

func TestHealthCheckUnhealthyWhenNeverHandshaked(t *testing.T) {
	r := &fakeRunner{outputs: map[string]struct {
		stdout string
		stderr string
		err    error
	}{
		"wg show wg0 latest-handshakes": {stdout: "peerpubkey\t0\n"},
	}}
	m := &Manager{Runner: r}
	ok, err := m.HealthCheck()
	if err != nil {
		t.Fatalf("HealthCheck: %v", err)
	}
	if ok {
		t.Fatal("expected unhealthy for a zero (never handshaked) timestamp")
	}
}
