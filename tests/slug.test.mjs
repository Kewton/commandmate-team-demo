import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/util/slug.js';

test('slugify basic: "Hello World" -> "hello-world"', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('slugify collapses consecutive spaces and symbols into a single hyphen', () => {
  assert.equal(slugify('Hello   World'), 'hello-world');
  assert.equal(slugify('foo & bar / baz'), 'foo-bar-baz');
  assert.equal(slugify('a__b--c!!d'), 'a-b-c-d');
});

test('slugify strips leading and trailing hyphens and lowercases', () => {
  assert.equal(slugify('  Hello World  '), 'hello-world');
  assert.equal(slugify('---Hello---'), 'hello');
  assert.equal(slugify('!!!Trim Me!!!'), 'trim-me');
  assert.equal(slugify('UPPER Case'), 'upper-case');
});

test('slugify edge cases', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify('!!!'), '');
  assert.equal(slugify('already-slug'), 'already-slug');
});
