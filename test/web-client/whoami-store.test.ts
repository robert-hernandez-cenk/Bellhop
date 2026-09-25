import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWhoAmIStore } from '../../web-client/src/lib/whoami-store.ts';
import type { WhoAmI } from '../../web-client/src/api/types.ts';

function makeWhoAmI(overrides: Partial<WhoAmI> = {}): WhoAmI {
  return {
    username: 'example-admin',
    groups: ['example-group'],
    localOperator: false,
    isAdmin: true,
    adminGroups: { app: 'example-admins', authentikBuiltin: 'authentik Admins' },
    capabilities: { userDirectory: true },
    ...overrides,
  };
}

test('initial state is whoami:null, loading:true, error:null, generation:0', () => {
  const store = createWhoAmIStore(() => Promise.resolve(makeWhoAmI()));
  assert.deepEqual(store.getState(), { whoami: null, loading: true, error: null, generation: 0 });
});

test('load() called concurrently fetches once', async () => {
  let calls = 0;
  const store = createWhoAmIStore(() => {
    calls++;
    return Promise.resolve(makeWhoAmI());
  });
  await Promise.all([store.load(), store.load(), store.load()]);
  assert.equal(calls, 1);
});

test('load() called again after settling still fetches only once', async () => {
  let calls = 0;
  const store = createWhoAmIStore(() => {
    calls++;
    return Promise.resolve(makeWhoAmI());
  });
  await store.load();
  await store.load();
  assert.equal(calls, 1);
});

test('load() success populates whoami and clears loading, generation stays 0', async () => {
  const who = makeWhoAmI();
  const store = createWhoAmIStore(() => Promise.resolve(who));
  await store.load();
  assert.deepEqual(store.getState(), { whoami: who, loading: false, error: null, generation: 0 });
});

test('load() failure sets whoami:null and error, generation stays 0', async () => {
  const store = createWhoAmIStore(() => Promise.reject(new Error('example-load-failure')));
  await store.load();
  assert.deepEqual(store.getState(), {
    whoami: null,
    loading: false,
    error: 'example-load-failure',
    generation: 0,
  });
});

test('refresh() always calls fetchWhoAmI, even repeatedly', async () => {
  let calls = 0;
  const store = createWhoAmIStore(() => {
    calls++;
    return Promise.resolve(makeWhoAmI());
  });
  await store.load();
  await store.refresh();
  await store.refresh();
  assert.equal(calls, 3);
});

test('refresh() increments generation by 1 once settled, on success', async () => {
  const store = createWhoAmIStore(() => Promise.resolve(makeWhoAmI()));
  await store.load();
  assert.equal(store.getState().generation, 0);
  await store.refresh();
  assert.equal(store.getState().generation, 1);
  await store.refresh();
  assert.equal(store.getState().generation, 2);
});

test('refresh() increments generation by 1 once settled, on failure', async () => {
  const store = createWhoAmIStore(() => Promise.reject(new Error('example-refresh-failure')));
  await store.load();
  await store.refresh();
  const state = store.getState();
  assert.equal(state.generation, 1);
  assert.equal(state.whoami, null);
  assert.equal(state.error, 'example-refresh-failure');
});

test('a later success clears an earlier error', async () => {
  let fail = true;
  const who = makeWhoAmI();
  const store = createWhoAmIStore(() => (fail ? Promise.reject(new Error('example-error')) : Promise.resolve(who)));
  await store.load();
  assert.equal(store.getState().error, 'example-error');
  fail = false;
  await store.refresh();
  assert.equal(store.getState().error, null);
  assert.deepEqual(store.getState().whoami, who);
});

test('a thrown non-Error value is stringified into error', async () => {
  const store = createWhoAmIStore(() => Promise.reject('example-plain-string-failure'));
  await store.load();
  assert.equal(store.getState().error, 'example-plain-string-failure');
});

test('refresh() keeps the current whoami while its own fetch is pending', async () => {
  const first = makeWhoAmI({ username: 'example-first' });
  let call = 0;
  let resolveSecond: (w: WhoAmI) => void = () => {};
  const store = createWhoAmIStore(() => {
    call++;
    if (call === 1) return Promise.resolve(first);
    return new Promise((resolve) => {
      resolveSecond = resolve;
    });
  });
  await store.load();
  assert.deepEqual(store.getState().whoami, first);

  const pending = store.refresh();
  assert.equal(store.getState().loading, true);
  assert.deepEqual(store.getState().whoami, first);

  resolveSecond(makeWhoAmI({ username: 'example-second' }));
  await pending;
  assert.equal(store.getState().whoami?.username, 'example-second');
});

test('a response from an older request settling after a newer one started is ignored', async () => {
  let call = 0;
  let resolveFirst: (w: WhoAmI) => void = () => {};
  let resolveSecond: (w: WhoAmI) => void = () => {};
  const store = createWhoAmIStore(() => {
    call++;
    if (call === 1) {
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    }
    return new Promise((resolve) => {
      resolveSecond = resolve;
    });
  });

  const firstRefresh = store.refresh();
  const secondRefresh = store.refresh();

  const second = makeWhoAmI({ username: 'example-newer' });
  resolveSecond(second);
  await secondRefresh;
  assert.deepEqual(store.getState().whoami, second);
  assert.equal(store.getState().generation, 1);

  const first = makeWhoAmI({ username: 'example-older' });
  resolveFirst(first);
  await firstRefresh;
  // The stale first response must not overwrite the newer one, and must not
  // bump generation a second time.
  assert.deepEqual(store.getState().whoami, second);
  assert.equal(store.getState().generation, 1);
});

test('listeners are notified on state changes and not after unsubscribing', async () => {
  const store = createWhoAmIStore(() => Promise.resolve(makeWhoAmI()));
  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications++;
  });

  await store.load();
  assert.ok(notifications >= 1);
  const afterLoad = notifications;

  unsubscribe();
  await store.refresh();
  assert.equal(notifications, afterLoad);
});

test('load() never rejects even when fetchWhoAmI rejects', async () => {
  const store = createWhoAmIStore(() => Promise.reject(new Error('example-failure')));
  await assert.doesNotReject(() => store.load());
});

test('refresh() never rejects even when fetchWhoAmI rejects', async () => {
  const store = createWhoAmIStore(() => Promise.reject(new Error('example-failure')));
  await store.load();
  await assert.doesNotReject(() => store.refresh());
});

test('getState() returns the same object reference until the state actually changes', async () => {
  const store = createWhoAmIStore(() => Promise.resolve(makeWhoAmI()));
  const before1 = store.getState();
  const before2 = store.getState();
  assert.equal(before1, before2);

  await store.load();
  const after1 = store.getState();
  assert.notEqual(before1, after1);
  const after2 = store.getState();
  assert.equal(after1, after2);
});
