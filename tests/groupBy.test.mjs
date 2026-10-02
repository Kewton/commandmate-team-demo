import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupBy } from '../src/util/groupBy.js';

test('groups values by the key returned by keyFn, in input order', () => {
  assert.deepEqual(
    groupBy([1, 2, 3, 4], (n) => (n % 2 ? 'odd' : 'even')),
    { odd: [1, 3], even: [2, 4] },
  );
});

test('returns an empty object for empty input', () => {
  assert.deepEqual(groupBy([], (n) => n), {});
});

test('does not mutate the input array', () => {
  const input = [1, 2, 3, 4];
  const snapshot = [...input];
  groupBy(input, (n) => (n % 2 ? 'odd' : 'even'));
  assert.deepEqual(input, snapshot);
});
