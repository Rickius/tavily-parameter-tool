// The JS code must keep behaving like the original Python implementation. web/tests/fixtures/parity.json is a frozen record
// of what that code returned for a broad set of inputs, together with the spec it ran against (the "spec" key, so editing
// web/spec.json later does not break these tests). Validation messages, the request body, the Python snippet, the prompts
// and the counters must match exactly: the same text, in the same order.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeUrl, queryWords, repeatOf, toolSchema } from '../core/compare.js';
import { AGGREGATOR_ROLE, aggregatorMessage, markAgreement } from '../core/ensemble.js';
import { buildSystemPrompt, parseJson } from '../core/planner.js';
import { pythonSnippet, requestBody } from '../core/render.js';
import { validateParameters, validatePlan } from '../core/validator.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/parity.json', import.meta.url), 'utf8'));
const spec = fixtures.spec;
const json = (value) => JSON.parse(JSON.stringify(value));

describe('validate_parameters', () => {
  test(`${fixtures.validate_parameters.length} parameter sets give the same errors`, () => {
    for (const { params, planner, errors } of fixtures.validate_parameters) {
      assert.deepEqual(validateParameters(params, spec, { planner }), errors, JSON.stringify(params).slice(0, 200));
    }
  });
});

describe('validate_plan', () => {
  for (const { name, task, plan, errors } of fixtures.validate_plan) {
    test(name, () => assert.deepEqual(validatePlan(plan, task, spec), errors));
  }
});

describe('render', () => {
  for (const { name, rows, request_body, key_order, python_snippet } of fixtures.render) {
    test(name, () => {
      const body = requestBody(rows);
      assert.deepEqual(body, request_body);
      assert.deepEqual(Object.keys(body), key_order);
      assert.equal(pythonSnippet(body), python_snippet);
    });
  }
});

describe('prompts and the tool schema', () => {
  test('the planner system prompt is identical', () => assert.equal(buildSystemPrompt(spec), fixtures.prompts.system));
  test('the aggregator system prompt is identical', () => assert.equal(buildSystemPrompt(spec) + AGGREGATOR_ROLE, fixtures.prompts.aggregator_system));
  test('the aggregator message is identical', () => {
    for (const { task, plans, message } of fixtures.prompts.aggregator_messages) assert.equal(aggregatorMessage(task, plans), message);
  });
  test('the tool schema is identical', () => assert.deepEqual(json(toolSchema(spec)), fixtures.tool_schema));
});

describe('counters', () => {
  test('query_words', () => {
    for (const { query, words } of fixtures.counters.query_words) assert.deepEqual([...queryWords(query)].sort(), words, query);
  });
  test('repeat_of', () => {
    for (const { query, earlier, result } of fixtures.counters.repeat_of) {
      assert.equal(repeatOf(query, earlier.map(([step, words]) => [step, new Set(words)])), result, query);
    }
  });
  test('normalize_url', () => {
    for (const { url, result } of fixtures.counters.normalize_url) assert.equal(normalizeUrl(url), result, url);
  });
  test(`mark_agreement (${fixtures.counters.mark_agreement.length} cases)`, () => {
    for (const { rows, plan1, plan2, result } of fixtures.counters.mark_agreement) assert.deepEqual(markAgreement(rows, plan1, plan2), result);
  });
});

describe('parse_json', () => {
  for (const { text, ok, result } of fixtures.parse_json) {
    test(JSON.stringify(text).slice(0, 50), () => {
      if (ok) assert.deepEqual(parseJson(text), result);
      else assert.throws(() => parseJson(text));
    });
  }
});
