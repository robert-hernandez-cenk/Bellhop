// Printed by windows-service.ts on every run (issue #67). Kept apart from that
// script, which runs its install/uninstall on import, so a test can import it.
export const WINDOWS_SERVICE_DEPRECATION_NOTICE =
  'The Windows service is deprecated: run Bellhop as an LXC container instead (see docs/lxc-container.md). ' +
  'It will be removed in a future update (#68).';
