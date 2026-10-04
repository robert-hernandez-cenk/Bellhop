import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveClient } from '../../src/lib/live-client.ts';

interface Counter {
  name: string;
  read(): number;
  add(n: number): Promise<number>;
}

function counter(name: string, start: number): Counter {
  return {
    name,
    read() {
      return start;
    },
    async add(n: number) {
      return start + n;
    },
  };
}

test('liveClient resolves the underlying client on every method call', async () => {
  let current = counter('first', 1);
  let builds = 0;
  const client = liveClient(() => {
    builds++;
    return current;
  });
  assert.equal(client.read(), 1);
  current = counter('second', 10);
  assert.equal(client.read(), 10);
  assert.equal(await client.add(5), 15);
  assert.equal(builds, 3);
});

test('liveClient passes non-function properties through from a fresh build', () => {
  let current = counter('first', 1);
  const client = liveClient(() => current);
  assert.equal(client.name, 'first');
  current = counter('second', 2);
  assert.equal(client.name, 'second');
});

test('liveClient calls a method with the built client as this', () => {
  class Box {
    constructor(private value: number) {}
    get(): number {
      return this.value;
    }
  }
  const client = liveClient(() => new Box(7));
  assert.equal(client.get(), 7);
});
