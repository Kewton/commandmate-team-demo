import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluralize } from '../src/util/pluralize.js';

test('pluralize returns the word unchanged for a count of exactly 1', () => {
  assert.equal(pluralize('issue', 1), 'issue');
});

test('pluralize appends "s" for a count of 0', () => {
  assert.equal(pluralize('issue', 0), 'issues');
});

test('pluralize appends "s" for a count of 4', () => {
  assert.equal(pluralize('issue', 4), 'issues');
});
