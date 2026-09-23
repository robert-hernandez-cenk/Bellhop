package netctl

import (
	"errors"
	"strings"
	"testing"
)

type fakeRunner struct {
	calls     [][]string
	checkFail map[string]bool   // keys that should make the -C check "not found" (Run returns an error)
	stdout    map[string]string // keys with canned stdout output (e.g. "ip -o rule show")
}

func (f *fakeRunner) Run(name string, args ...string) (string, string, error) {
	call := append([]string{name}, args...)
	f.calls = append(f.calls, call)
	key := strings.Join(call, " ")
	if f.checkFail[key] {
		return "", "", errors.New("no match")
	}
	return f.stdout[key], "", nil
}

func containsCall(calls [][]string, want []string) bool {
	for _, call := range calls {
		if strings.Join(call, " ") == strings.Join(want, " ") {
			return true
		}
	}
	return false
}

func TestApplyKillSwitchSetsForwardPolicyAndAcceptRules(t *testing.T) {
	r := &fakeRunner{checkFail: map[string]bool{
		"iptables -C FORWARD -i wg0 -j ACCEPT":                true,
		"iptables -C FORWARD -o wg0 -j ACCEPT":                true,
		"iptables -t nat -C POSTROUTING -o wg0 -j MASQUERADE": true,
	}}
	m := &Manager{Runner: r}
	if err := m.ApplyKillSwitch("wg0"); err != nil {
		t.Fatalf("ApplyKillSwitch: %v", err)
	}

	want := [][]string{
		// IP forwarding must be enabled FIRST: with it off (Debian's
		// default) the kernel drops forwarded packets before the FORWARD
		// chain below is consulted at all.
		{"sysctl", "-w", "net.ipv4.ip_forward=1"},
		{"iptables", "-P", "FORWARD", "DROP"},
		{"iptables", "-C", "FORWARD", "-i", "wg0", "-j", "ACCEPT"},
		{"iptables", "-A", "FORWARD", "-i", "wg0", "-j", "ACCEPT"},
		{"iptables", "-C", "FORWARD", "-o", "wg0", "-j", "ACCEPT"},
		{"iptables", "-A", "FORWARD", "-o", "wg0", "-j", "ACCEPT"},
		{"iptables", "-t", "nat", "-C", "POSTROUTING", "-o", "wg0", "-j", "MASQUERADE"},
		{"iptables", "-t", "nat", "-A", "POSTROUTING", "-o", "wg0", "-j", "MASQUERADE"},
	}
	if len(r.calls) != len(want) {
		t.Fatalf("got %d calls, want %d: %v", len(r.calls), len(want), r.calls)
	}
	for i, call := range want {
		if strings.Join(r.calls[i], " ") != strings.Join(call, " ") {
			t.Fatalf("call %d = %v, want %v", i, r.calls[i], call)
		}
	}
}

func TestApplyKillSwitchFailsFastWhenIPForwardingCannotBeEnabled(t *testing.T) {
	// A gateway that can't forward is not a gateway -- if sysctl fails there
	// is no point installing kill-switch rules the kernel will never reach.
	r := &fakeRunner{checkFail: map[string]bool{"sysctl -w net.ipv4.ip_forward=1": true}}
	m := &Manager{Runner: r}
	err := m.ApplyKillSwitch("wg0")
	if err == nil {
		t.Fatal("ApplyKillSwitch: want an error when sysctl fails, got nil")
	}
	if !strings.Contains(err.Error(), "net.ipv4.ip_forward=1") {
		t.Fatalf("ApplyKillSwitch error = %q, want it to name the failing sysctl", err)
	}
	if len(r.calls) != 1 {
		t.Fatalf("want no iptables calls after a failed sysctl, got: %v", r.calls)
	}
}

func TestApplyKillSwitchSkipsAddWhenCheckAlreadySucceeds(t *testing.T) {
	// checkFail is empty -- every -C check "succeeds" (rule already
	// present), so no -A/-t nat -A calls should ever run.
	r := &fakeRunner{}
	m := &Manager{Runner: r}
	if err := m.ApplyKillSwitch("wg0"); err != nil {
		t.Fatalf("ApplyKillSwitch: %v", err)
	}
	for _, call := range r.calls {
		joined := strings.Join(call, " ")
		if strings.Contains(joined, "-A ") {
			t.Fatalf("expected no -A calls when every -C check already succeeds, got: %v", r.calls)
		}
	}
}

func TestApplyLanBypassAddsRuleWhenLanIPProvided(t *testing.T) {
	r := &fakeRunner{}
	m := &Manager{Runner: r}
	if err := m.ApplyLanBypass("192.168.1.15"); err != nil {
		t.Fatalf("ApplyLanBypass: %v", err)
	}

	if !containsCall(r.calls, []string{"ip", "-o", "rule", "show"}) {
		t.Fatalf("expected an 'ip -o rule show' check call, got: %v", r.calls)
	}
	if !containsCall(r.calls, []string{"ip", "rule", "add", "from", "192.168.1.15", "lookup", "main", "priority", "100"}) {
		t.Fatalf("expected an 'ip rule add' call for the gateway's LAN IP, got: %v", r.calls)
	}
}

func TestApplyLanBypassSkipsAddWhenAlreadyPresent(t *testing.T) {
	r := &fakeRunner{stdout: map[string]string{
		"ip -o rule show": "100:\tfrom 192.168.1.15 lookup main\n32766:\tfrom all lookup main\n",
	}}
	m := &Manager{Runner: r}
	if err := m.ApplyLanBypass("192.168.1.15"); err != nil {
		t.Fatalf("ApplyLanBypass: %v", err)
	}

	if containsCall(r.calls, []string{"ip", "rule", "add", "from", "192.168.1.15", "lookup", "main", "priority", "100"}) {
		t.Fatalf("expected no 'ip rule add' call when the rule is already present, got: %v", r.calls)
	}
}

func TestApplyLanBypassNoOpWhenLanIPEmpty(t *testing.T) {
	r := &fakeRunner{}
	m := &Manager{Runner: r}
	if err := m.ApplyLanBypass(""); err != nil {
		t.Fatalf("ApplyLanBypass: %v", err)
	}

	for _, call := range r.calls {
		if len(call) > 0 && call[0] == "ip" {
			t.Fatalf("expected no 'ip' calls when lanIP is empty, got: %v", r.calls)
		}
	}
}

func TestApplyLanBypassAddsRuleWhenSameSourceRuleExistsAtDifferentPriority(t *testing.T) {
	// A rule with the right "from <lanIP> lookup main" selector but at some
	// other priority (e.g. a stale rule from a since-changed
	// lanBypassRulePriority, or a hand-added one) must not be treated as
	// "already handled" -- it could be shadowed by wg-quick's own
	// higher-priority rules and be completely ineffective.
	r := &fakeRunner{stdout: map[string]string{
		"ip -o rule show": "40000:\tfrom 192.168.1.15 lookup main\n32766:\tfrom all lookup main\n",
	}}
	m := &Manager{Runner: r}
	if err := m.ApplyLanBypass("192.168.1.15"); err != nil {
		t.Fatalf("ApplyLanBypass: %v", err)
	}

	if !containsCall(r.calls, []string{"ip", "rule", "add", "from", "192.168.1.15", "lookup", "main", "priority", "100"}) {
		t.Fatalf("expected an 'ip rule add' call when the existing rule is at a different priority, got: %v", r.calls)
	}
}

func TestApplyLanBypassReturnsErrorWhenIpRuleShowFails(t *testing.T) {
	// New: this is what main.go now treats as a warning, not a fatal
	// error -- ApplyLanBypass must actually surface the failure so main.go
	// has something to log, rather than swallowing it silently.
	r := &fakeRunner{checkFail: map[string]bool{"ip -o rule show": true}}
	m := &Manager{Runner: r}
	err := m.ApplyLanBypass("192.168.1.15")
	if err == nil {
		t.Fatal("ApplyLanBypass: want an error when 'ip -o rule show' fails, got nil")
	}
}

func TestApplyLanBypassRemovesStaleRuleForDifferentIPAndAddsCorrectOne(t *testing.T) {
	// Simulates a gateway that changed IP (e.g. a migrate-guest host move)
	// without ever getting its old priority-100 rule cleaned up: only the
	// stale rule for the old IP is present, none for the new one yet.
	r := &fakeRunner{stdout: map[string]string{
		"ip -o rule show": "100:\tfrom 192.168.2.251 lookup main\n32766:\tfrom all lookup main\n",
	}}
	m := &Manager{Runner: r}
	if err := m.ApplyLanBypass("192.168.1.251"); err != nil {
		t.Fatalf("ApplyLanBypass: %v", err)
	}

	if !containsCall(r.calls, []string{"ip", "rule", "del", "from", "192.168.2.251", "lookup", "main", "priority", "100"}) {
		t.Fatalf("expected an 'ip rule del' call removing the stale rule, got: %v", r.calls)
	}
	if !containsCall(r.calls, []string{"ip", "rule", "add", "from", "192.168.1.251", "lookup", "main", "priority", "100"}) {
		t.Fatalf("expected an 'ip rule add' call for the current LAN IP, got: %v", r.calls)
	}
}

func TestApplyLanBypassRemovesStaleRuleButSkipsAddWhenCorrectRuleAlreadyPresent(t *testing.T) {
	// Matches issue #146's exact repro: both the stale rule (from a
	// previous GATEWAY_LAN_IP) and the correct current-IP rule are present
	// at priority 100 at the same time.
	r := &fakeRunner{stdout: map[string]string{
		"ip -o rule show": "100:\tfrom 192.168.2.251 lookup main\n100:\tfrom 192.168.1.251 lookup main\n32766:\tfrom all lookup main\n",
	}}
	m := &Manager{Runner: r}
	if err := m.ApplyLanBypass("192.168.1.251"); err != nil {
		t.Fatalf("ApplyLanBypass: %v", err)
	}

	if !containsCall(r.calls, []string{"ip", "rule", "del", "from", "192.168.2.251", "lookup", "main", "priority", "100"}) {
		t.Fatalf("expected an 'ip rule del' call removing the stale rule, got: %v", r.calls)
	}
	if containsCall(r.calls, []string{"ip", "rule", "add", "from", "192.168.1.251", "lookup", "main", "priority", "100"}) {
		t.Fatalf("expected no 'ip rule add' call when the correct rule is already present, got: %v", r.calls)
	}
}

func TestApplyLanBypassStillAddsCorrectRuleWhenStaleDeleteFails(t *testing.T) {
	// A failed cleanup of a stale rule must not block installing the
	// correct one -- ApplyLanBypass is documented as non-safety-critical,
	// and the add is the half that actually matters (the gateway's own
	// provider-API calls).
	r := &fakeRunner{
		stdout: map[string]string{
			"ip -o rule show": "100:\tfrom 192.168.2.251 lookup main\n32766:\tfrom all lookup main\n",
		},
		checkFail: map[string]bool{
			"ip rule del from 192.168.2.251 lookup main priority 100": true,
		},
	}
	m := &Manager{Runner: r}
	err := m.ApplyLanBypass("192.168.1.251")
	if err == nil {
		t.Fatal("ApplyLanBypass: want an error naming the failed delete, got nil")
	}
	if !strings.Contains(err.Error(), "192.168.2.251") {
		t.Fatalf("ApplyLanBypass error = %q, want it to name the stale IP that failed to delete", err)
	}
	if !containsCall(r.calls, []string{"ip", "rule", "add", "from", "192.168.1.251", "lookup", "main", "priority", "100"}) {
		t.Fatalf("expected the 'ip rule add' call to still run after a failed delete, got: %v", r.calls)
	}
}
