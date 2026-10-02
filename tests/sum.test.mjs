import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sum } from '../src/util/sum.js';

test('adds up the numbers in the array', () => {
  assert.equal(sum([1, 2, 3]), 6);
});

test('totals an empty array as 0', () => {
  assert.equal(sum([]), 0);
});

test('stays within 1e-9 of the exact total for fractional values', () => {
  assert.ok(Math.abs(sum([0.1, 0.2]) - 0.3) < 1e-9);
});
