// A client that re-resolves itself on every call (issue #64, research R5).
// The web service and the MCP server build their Authentik and Cloudflare
// clients once at startup and hand the same object to every route; with
// settings now editable at runtime, that object must follow a URL or token
// saved after it was built. Wrapping the build function in a Proxy keeps
// every caller's type and call sites unchanged: each property access
// (so each method call, including isConfigured()) builds the
// real-or-unconfigured client from current config and forwards to it, so
// nothing is cached beyond the config accessor's own short snapshot.
export function liveClient<T extends object>(build: () => T): T {
  // The target is never read or written -- every property access goes
  // through `get` below, which consults a freshly built T -- so an empty
  // object stands in for it. That is the one cast here, and why it is safe:
  // the Proxy's observable behaviour is entirely that of build()'s T.
  return new Proxy({} as T, {
    get(_target, prop) {
      const client = build();
      const value: unknown = Reflect.get(client, prop, client);
      // Bound to the client it came from, so a class method's `this` (its
      // private URL and token) is the freshly built instance.
      return typeof value === 'function' ? (...args: unknown[]) => Reflect.apply(value, client, args) : value;
    },
  });
}
