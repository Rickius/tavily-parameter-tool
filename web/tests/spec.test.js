// web/spec.json is the single source of truth for what the tool knows about Tavily Search.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spec } from './support.js';

test('web/spec.json has the sections the page relies on', () => {
  for (const key of ['parameters', 'rules', 'sources', 'last_verified', 'not_used_in_v1']) assert.ok(spec[key], `missing "${key}"`);
  assert.match(spec.last_verified, /^\d{4}-\d{2}-\d{2}$/);
});

test('every parameter has a source_url that is one of the listed sources', () => {
  const allowed = new Set(Object.values(spec.sources));
  for (const [name, entry] of Object.entries(spec.parameters)) {
    assert.ok(allowed.has(entry.source_url), `${name}: source_url ${entry.source_url} is not in "sources"`);
  }
});
