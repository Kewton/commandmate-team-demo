import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countBy } from '../src/util/countBy.js';

test('counts items by a derived key', () => {
  assert.deepEqual(countBy(['a', 'bb', 'cc'], (s) => s.length), { 1: 1, 2: 2 });
});

test('returns an empty object for an empty array', () => {
  assert.deepEqual(countBy([], (s) => s), {});
});

test('does not mutate the input array', () => {
  const items = ['a', 'bb', 'cc'];
  const snapshot = [...items];
  countBy(items, (s) => s.length);
  assert.deepEqual(items, snapshot);
});
