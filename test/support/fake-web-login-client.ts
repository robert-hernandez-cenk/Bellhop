import type {
  LoginIdentity,
  PendingLogin,
  RecheckResult,
  StartedLogin,
  WebLoginClient,
  WebLoginSettings,
} from '../../src/web/login/oidc-client.ts';

// A scriptable WebLoginClient for session-service and route tests (#69,
// research R14) -- the WebLoginClient counterpart of FakeSSHClient. Every
// call is recorded in `calls`; each method answers from its own queue, one
// scripted entry per call, in order. An entry is either the value itself or
// a function computing it (sync or async, and free to throw), so a test can
// hold a call open on a gate or make it fail. A call with nothing scripted
// throws, so an unexpected provider round trip fails the test loudly rather
// than returning a plausible default.

type Script<A extends unknown[], R> = R | ((...args: A) => R | Promise<R>);

export type FakeWebLoginCall =
  | { method: 'startLogin'; cfg: WebLoginSettings }
  | { method: 'completeLogin'; cfg: WebLoginSettings; callbackUrl: string; pending: PendingLogin }
  | { method: 'recheck'; cfg: WebLoginSettings; refreshToken: string; expectedSub: string }
  | { method: 'endSessionUrl'; cfg: WebLoginSettings; idToken: string; postLogoutRedirectUri: string };

export class FakeWebLoginClient implements WebLoginClient {
  readonly calls: FakeWebLoginCall[] = [];
  readonly startLoginResults: Script<[WebLoginSettings], StartedLogin>[] = [];
  readonly completeLoginResults: Script<[WebLoginSettings, string, PendingLogin], LoginIdentity>[] = [];
  readonly recheckResults: Script<[WebLoginSettings, string, string], RecheckResult>[] = [];
  // `undefined` is a legitimate answer here (no end_session_endpoint), so
  // an empty queue cannot be told apart by value; see endSessionUrl below.
  readonly endSessionUrlResults: Script<[WebLoginSettings, string, string], string | undefined>[] = [];

  callsTo<M extends FakeWebLoginCall['method']>(method: M): Extract<FakeWebLoginCall, { method: M }>[] {
    return this.calls.filter((c): c is Extract<FakeWebLoginCall, { method: M }> => c.method === method);
  }

  async startLogin(cfg: WebLoginSettings): Promise<StartedLogin> {
    this.calls.push({ method: 'startLogin', cfg });
    return run('startLogin', this.startLoginResults, [cfg]);
  }

  async completeLogin(cfg: WebLoginSettings, callbackUrl: string | URL, pending: PendingLogin): Promise<LoginIdentity> {
    const url = String(callbackUrl);
    this.calls.push({ method: 'completeLogin', cfg, callbackUrl: url, pending });
    return run('completeLogin', this.completeLoginResults, [cfg, url, pending]);
  }

  async recheck(cfg: WebLoginSettings, refreshToken: string, expectedSub: string): Promise<RecheckResult> {
    this.calls.push({ method: 'recheck', cfg, refreshToken, expectedSub });
    return run('recheck', this.recheckResults, [cfg, refreshToken, expectedSub]);
  }

  async endSessionUrl(cfg: WebLoginSettings, idToken: string, postLogoutRedirectUri: string): Promise<string | undefined> {
    this.calls.push({ method: 'endSessionUrl', cfg, idToken, postLogoutRedirectUri });
    return run('endSessionUrl', this.endSessionUrlResults, [cfg, idToken, postLogoutRedirectUri]);
  }
}

async function run<A extends unknown[], R>(method: string, queue: Script<A, R>[], args: A): Promise<R> {
  if (queue.length === 0) throw new Error(`FakeWebLoginClient: no scripted result for ${method}`);
  const next = queue.shift()!;
  return typeof next === 'function' ? await (next as (...a: A) => R | Promise<R>)(...args) : next;
}
