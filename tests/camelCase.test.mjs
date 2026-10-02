import { test } from 'node:test';
import assert from 'node:assert/strict';
import { camelCase } from '../src/util/camelCase.js';

test('camelCase joins space-separated words: "hello world" -> "helloWorld"', () => {
  assert.equal(camelCase('hello world'), 'helloWorld');
});

test('camelCase joins hyphen- and underscore-separated words: "user_id-value" -> "userIdValue"', () => {
  assert.equal(camelCase('user_id-value'), 'userIdValue');
});

test('camelCase returns an empty string for empty input', () => {
  assert.equal(camelCase(''), '');
});
