// Package netctl applies the gateway's kill-switch: forwarded traffic may
// only leave via the WireGuard interface, dropped otherwise (fail closed).
// Applied idempotently on every agent startup (main.go calls ApplyKillSwitch
// before bringing wg0 up) rather than once at deploy time by a separate
// remote script -- raw iptables state doesn't survive a container reboot on
// its own, and the systemd unit (Restart=on-failure, started at boot) means
// "every agent startup" already covers both the initial deploy and any
// later reboot with no separate persistence mechanism (iptables-persistent,
// a cron job, ...) needed.
//
// ApplyLanBypass installs one additional, non-safety-critical
// policy-routing rule (when given the gateway's own LAN IP): traffic
// sourced from the gateway itself is looked up in the main routing table
// directly, instead of falling through to wg-quick's own auto-inserted
// default-route rule. Without it, the agent's own outbound calls to the VPN
// provider's API (used by GET /servers, POST /connect, and selfheal's
// automatic reconnect) ride the gateway's own tunnel -- which fails
// whenever the currently-connected exit node has a bad path to the
// provider. Forwarded guest traffic is unaffected: it's sourced from the
// guests' own IPs, never the gateway's.
package netctl

import (
	"fmt"
	"strings"

	"vpn-gateway-agent/runner"
)

type Manager struct {
	Runner runner.Runner
}

// rule is one iptables invocation, split into its -C (check) and -A/-P
// (apply) argument forms -- checking first makes Apply safe to call on
// every restart without accumulating duplicate ACCEPT/MASQUERADE rules.
// FORWARD's default policy has no -C equivalent (a policy isn't a rule to
// check for), so it's simply set unconditionally every time; -P is itself
// idempotent (setting DROP when it's already DROP is a harmless no-op).
type rule struct {
	check []string // nil for the FORWARD policy line, which has no check form
	apply []string
}

func rules(wgIface string) []rule {
	return []rule{
		{apply: []string{"-P", "FORWARD", "DROP"}},
		{
			check: []string{"-C", "FORWARD", "-i", wgIface, "-j", "ACCEPT"},
			apply: []string{"-A", "FORWARD", "-i", wgIface, "-j", "ACCEPT"},
		},
		{
			check: []string{"-C", "FORWARD", "-o", wgIface, "-j", "ACCEPT"},
			apply: []string{"-A", "FORWARD", "-o", wgIface, "-j", "ACCEPT"},
		},
	}
}

// natRule is applied against the "nat" table (iptables -t nat ...), kept
// separate from rules() above since it needs the -t nat flag on both its
// check and apply forms.
func natRule(wgIface string) rule {
	return rule{
		check: []string{"-t", "nat", "-C", "POSTROUTING", "-o", wgIface, "-j", "MASQUERADE"},
		apply: []string{"-t", "nat", "-A", "POSTROUTING", "-o", wgIface, "-j", "MASQUERADE"},
	}
}

func (m *Manager) run(args []string) error {
	if _, stderr, err := m.Runner.Run("iptables", args...); err != nil {
		return fmt.Errorf("netctl: iptables %v: %w (%s)", args, err, stderr)
	}
	return nil
}

func (m *Manager) applyRule(r rule) error {
	if r.check != nil {
		if _, _, err := m.Runner.Run("iptables", r.check...); err == nil {
			return nil // already present
		}
	}
	return m.run(r.apply)
}

// lanBypassRulePriority only needs to be lower than wg-quick's own inserted
// rules, which sit just below the kernel's built-in "main" rule at priority
// 32766 -- the exact gap doesn't matter, it just needs to be evaluated
// before wg-quick's catch-all rule.
const lanBypassRulePriority = "100"

// applyLanBypassRule is the ip-rule equivalent of applyRule above: check via
// `ip -o rule show` (ip has no -C-style per-rule check flag), removing any
// stale priority-100 rule for a source other than lanIP (see
// staleLanBypassSources) before adding the current one if it isn't already
// present -- ip rule add does not dedupe on its own, so skipping this check
// would accumulate a duplicate rule on every agent restart. A failed delete
// is collected but does not stop the function from still trying the add --
// this whole path is non-safety-critical (see ApplyLanBypass's own doc
// comment), and the add is the half that actually matters.
func (m *Manager) applyLanBypassRule(lanIP string) error {
	stdout, stderr, err := m.Runner.Run("ip", "-o", "rule", "show")
	if err != nil {
		return fmt.Errorf("netctl: ip -o rule show: %w (%s)", err, stderr)
	}

	var delErr error
	for _, staleIP := range staleLanBypassSources(stdout, lanIP) {
		if _, stderr, err := m.Runner.Run("ip", "rule", "del", "from", staleIP, "lookup", "main", "priority", lanBypassRulePriority); err != nil && delErr == nil {
			delErr = fmt.Errorf("netctl: ip rule del from %s lookup main: %w (%s)", staleIP, err, stderr)
		}
	}

	if lanBypassRulePresent(stdout, lanIP) {
		return delErr // already present, at the rule's own priority
	}
	if _, stderr, err := m.Runner.Run("ip", "rule", "add", "from", lanIP, "lookup", "main", "priority", lanBypassRulePriority); err != nil {
		return fmt.Errorf("netctl: ip rule add from %s lookup main: %w (%s)", lanIP, err, stderr)
	}
	return delErr
}

// staleLanBypassSources returns the source IP of every priority-100
// "lookup main" rule in stdout (ip -o rule show's output) other than lanIP
// itself -- leftover rules from a previous GATEWAY_LAN_IP value (e.g. after
// a migrate-guest host move changed this gateway's own IP) that
// applyLanBypassRule removes so they don't keep accumulating across
// restarts/re-IPs. Safe to treat every priority-100 "lookup main" rule as
// ours: lanBypassRulePriority is a constant only this agent ever uses, well
// clear of wg-quick's own inserted rules just below the kernel's built-in
// "main" rule at priority 32766.
func staleLanBypassSources(stdout, lanIP string) []string {
	prefix := lanBypassRulePriority + ":"
	var stale []string
	for _, line := range strings.Split(stdout, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, prefix) || !strings.Contains(trimmed, "lookup main") {
			continue
		}
		fields := strings.Fields(trimmed)
		if len(fields) < 3 || fields[1] != "from" || fields[2] == lanIP {
			continue
		}
		stale = append(stale, fields[2])
	}
	return stale
}

// lanBypassRulePresent reports whether stdout (ip -o rule show's output)
// already contains our rule specifically at lanBypassRulePriority -- not
// just any rule with a matching "from <lanIP> lookup main" selector at some
// other priority, which could be a stale or hand-added rule shadowed by
// wg-quick's own higher-priority rules and be completely ineffective; this
// check would otherwise wrongly treat that as "already handled" and never
// install a working one.
func lanBypassRulePresent(stdout, lanIP string) bool {
	prefix := lanBypassRulePriority + ":"
	want := fmt.Sprintf("from %s lookup main", lanIP)
	for _, line := range strings.Split(stdout, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), prefix) && strings.Contains(line, want) {
			return true
		}
	}
	return false
}

// ApplyKillSwitch enables IP forwarding first, then installs the
// fail-closed forwarding rules: forwarded traffic may only leave via
// wgIface, dropped otherwise. This IS safety-critical -- a failure here
// must stop the gateway from starting (see main.go), since a gateway that
// can't apply its kill switch is not safe to route guest traffic through.
// Debian defaults net.ipv4.ip_forward to 0, and with it off the kernel
// drops forwarded packets before the FORWARD chain is ever consulted -- the
// gateway routes nothing at all no matter how correct the rules below are.
// `sysctl -w` is itself idempotent, so unlike the iptables rules it needs
// no check-first (-C) form to be safe on every startup.
func (m *Manager) ApplyKillSwitch(wgIface string) error {
	if _, stderr, err := m.Runner.Run("sysctl", "-w", "net.ipv4.ip_forward=1"); err != nil {
		return fmt.Errorf("netctl: sysctl -w net.ipv4.ip_forward=1: %w (%s)", err, stderr)
	}
	for _, r := range rules(wgIface) {
		if err := m.applyRule(r); err != nil {
			return err
		}
	}
	return m.applyRule(natRule(wgIface))
}

// ApplyLanBypass installs the policy-routing rule described on
// applyLanBypassRule below. Unlike ApplyKillSwitch, this is NOT
// safety-critical: callers should treat a returned error as a warning, not
// a reason to stop the gateway -- guest routing (ApplyKillSwitch's job)
// doesn't depend on it, only the gateway's own provider-API calls do. A
// no-op returning nil when lanIP is empty (e.g. a gateway not yet
// redeployed with GATEWAY_LAN_IP set).
func (m *Manager) ApplyLanBypass(lanIP string) error {
	if lanIP == "" {
		return nil
	}
	return m.applyLanBypassRule(lanIP)
}
