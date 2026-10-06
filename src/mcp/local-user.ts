import os from 'node:os';

// Who the stdio MCP server records on its jobs (#65/#66): whoever started the
// process on this machine. os.userInfo() throws for a uid with no passwd
// entry (a container run with --user <uid>), which must not stop the server
// from starting, so that case keeps the generic 'mcp' every MCP job recorded
// before #65.
export function localUsername(userInfo: () => { username: string } = () => os.userInfo()): string {
  try {
    return userInfo().username || 'mcp';
  } catch {
    return 'mcp';
  }
}
