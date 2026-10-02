import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from '../src/util/clamp.js';

test('returns the value when within range', () => {
  assert.equal(clamp(5, 0, 10), 5);
});

test('clamps to min when below range', () => {
  assert.equal(clamp(-1, 0, 10), 0);
});

test('clamps to max when above range', () => {
  assert.equal(clamp(99, 0, 10), 10);
});

test('returns the boundary values as-is', () => {
  assert.equal(clamp(0, 0, 10), 0);
  assert.equal(clamp(10, 0, 10), 10);
});

test('throws when min is greater than max', () => {
  assert.throws(() => clamp(5, 10, 0), RangeError);
});
