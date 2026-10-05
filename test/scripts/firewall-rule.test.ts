import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firewallRuleCommand } from '../../scripts/firewall-rule.ts';

// #69 US6: the service is reached directly by browsers now, so the rule is
// open to any address (no remoteip= scope tied to the reverse proxy).
test('firewallRuleCommand opens the port to any address', () => {
  const cmd = firewallRuleCommand(3000);
  assert.ok(!cmd.includes('remoteip'));
  assert.match(cmd, /name="BellhopWebUI"/);
  assert.match(cmd, /dir=in action=allow protocol=TCP localport=3000 profile=any/);
});
