export const FIREWALL_RULE_NAME = 'BellhopWebUI';

// The netsh command that opens the web UI's port. Deliberately has no
// remoteip= scope (#69): browsers now reach this service directly and
// authenticate with Bellhop's own sign-in, so the rule no longer needs to
// confine callers to one reverse-proxy host. Kept apart from
// windows-service.ts, which runs its install/uninstall on import, so a test can
// import it.
export function firewallRuleCommand(port: number): string {
  return `netsh advfirewall firewall add rule name="${FIREWALL_RULE_NAME}" dir=in action=allow protocol=TCP localport=${port} profile=any`;
}
