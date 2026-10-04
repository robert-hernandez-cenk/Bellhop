import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminNavLinks } from '../../web-client/src/lib/admin-nav.ts';

test('adminNavLinks(false, false) returns []', () => {
  assert.deepEqual(adminNavLinks(false, false), []);
});

test('adminNavLinks(false, true) returns []', () => {
  assert.deepEqual(adminNavLinks(false, true), []);
});

test('adminNavLinks(true, false) returns Tasks and Settings', () => {
  assert.deepEqual(adminNavLinks(true, false), [
    { to: '/tasks', label: 'Tasks' },
    { to: '/settings', label: 'Settings' },
  ]);
});

test('adminNavLinks(true, true) returns Users, Permissions, Tasks, Settings in that order', () => {
  assert.deepEqual(adminNavLinks(true, true), [
    { to: '/users', label: 'Users' },
    { to: '/permissions', label: 'Permissions' },
    { to: '/tasks', label: 'Tasks' },
    { to: '/settings', label: 'Settings' },
  ]);
});
