import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk } from '../src/util/chunk.js';

test('splits an array into chunks, the last one shorter', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('returns an empty array for empty input', () => {
  assert.deepEqual(chunk([], 3), []);
});

test('throws when size is zero', () => {
  assert.throws(() => chunk([1, 2], 0), RangeError);
});
