import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateParameters, validatePlan } from '../core/validator.js';
import { groceryPlan, REF, row, spec, TASK } from './support.js';

const BASE = { query: 'grocery deals', max_results: 10 };
const errorsFor = (extra) => validateParameters({ ...BASE, ...extra }, spec);

test('accepts the grocery plan', () => assert.deepEqual(validatePlan(groceryPlan(), TASK, spec), []));

test('accepts a country, a time_range alias and topic general', () => {
  assert.deepEqual(errorsFor({ country: 'united states', time_range: 'w', topic: 'general' }), []);
});

test('rejects an invented parameter', () => {
  const errors = errorsFor({ freshness: 'week' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /freshness.*not a parameter in the spec/);
});

test('rejects parameters not used in v1', () => assert.match(errorsFor({ auto_parameters: true })[0], /not used in v1/));
test('rejects the planner choosing include_usage', () => assert.match(errorsFor({ include_usage: true })[0], /set by the backend/));

test('inherited object properties are not parameters', () => {
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const params = Object.create(null);
    Object.assign(params, BASE);
    Object.defineProperty(params, name, { value: 'x', enumerable: true });
    assert.match(validateParameters(params, spec)[0], /not a parameter in the spec/, name);
  }
});

describe('bad enum values', () => {
  for (const extra of [{ topic: 'sports' }, { search_depth: 'deep' }, { time_range: 'fortnight' }, { include_domains_mode: 'only', include_domains: ['a.com'] }, { include_answer: 'long' }, { country: 'Austin' }]) {
    test(JSON.stringify(extra), () => {
      const errors = errorsFor(extra);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /is not allowed/);
    });
  }
});

describe('out of range values', () => {
  const cases = [
    [{ max_results: 21 }, 'outside the allowed range 0 to 20'],
    [{ max_results: -1 }, 'outside the allowed range'],
    [{ chunks_per_source: 4 }, 'outside the allowed range 1 to 3'],
    [{ max_age_hours: 721 }, 'outside the allowed range -1 to 720'],
    [{ max_results: true }, 'must be an integer'],
    [{ max_results: '10' }, 'must be an integer'],
    [{ max_results: 5.5 }, 'must be an integer'],
    [{ include_domains: Array.from({ length: 301 }, (_, i) => `d${i}.com`) }, 'limit is 300'],
    [{ exclude_domains: Array.from({ length: 151 }, (_, i) => `d${i}.com`) }, 'limit is 150'],
    [{ include_domains: [] }, 'empty list'],
    [{ query: 'x'.repeat(1501) }, 'limit is 1500'],
  ];
  for (const [extra, fragment] of cases) {
    test(fragment + ' ' + JSON.stringify(extra).slice(0, 30), () => {
      assert.ok(errorsFor(extra).some((e) => e.includes(fragment)), String(errorsFor(extra)));
    });
  }
});

test('max_results is required', () => assert.deepEqual(validateParameters({ query: 'grocery deals' }, spec), ['max_results: is required and must be set explicitly.']));
test('query is required', () => assert.deepEqual(validateParameters({ max_results: 5 }, spec), ['query: is required and must be set explicitly.']));
test('a tool caller only needs a query', () => {
  assert.deepEqual(validateParameters({ query: 'q' }, spec, { planner: false }), []);
  assert.deepEqual(validateParameters({}, spec, { planner: false }), ['query: is required and must be set explicitly.']);
});

test('include_domains_mode needs include_domains', () => {
  assert.deepEqual(errorsFor({ include_domains_mode: 'prefer' }), ['include_domains_mode: requires include_domains (Tavily returns a 400 error otherwise).']);
  assert.deepEqual(errorsFor({ include_domains: ['kroger.com'], include_domains_mode: 'prefer' }), []);
});

test('filter_by_language needs language', () => {
  assert.deepEqual(errorsFor({ filter_by_language: true }), ['filter_by_language: requires language (Tavily returns a 400 error otherwise).']);
  assert.deepEqual(errorsFor({ filter_by_language: true, language: 'en' }), []);
});

test('country needs topic general', () => {
  for (const topic of ['news', 'finance']) {
    assert.deepEqual(errorsFor({ country: 'germany', topic }), [`country: is available only when topic is general, not '${topic}'.`]);
  }
  assert.deepEqual(errorsFor({ country: 'germany' }), []);
});

test('chunks_per_source is not available for ultra-fast', () => {
  assert.match(errorsFor({ chunks_per_source: 2, search_depth: 'ultra-fast' })[0], /ultra-fast/);
  assert.deepEqual(errorsFor({ chunks_per_source: 2, search_depth: 'fast' }), []);
});

describe('dates', () => {
  for (const bad of ['2026-1-5', '10/29/2026', '2026-13-01', '2026-02-30', '20261029', 20261029, '0000-01-01', '2023-02-29']) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      for (const name of ['start_date', 'end_date']) {
        const errors = errorsFor({ [name]: bad });
        assert.equal(errors.length, 1);
        assert.ok(errors[0].startsWith(name));
      }
    });
  }
  test('accepts good dates, including a leap day', () => {
    assert.deepEqual(errorsFor({ start_date: '2026-10-01', end_date: '2026-10-29' }), []);
    assert.deepEqual(errorsFor({ start_date: '2024-02-29', end_date: '2000-02-29' }), []);
  });
});

describe('plan shape', () => {
  const plan = (mutate) => {
    const p = groceryPlan();
    mutate(p);
    return validatePlan(p, TASK, spec);
  };

  test('requires all sections', () => {
    const errors = validatePlan({ parameters: [row('query', 'x'), row('max_results', 5)] }, TASK, spec);
    for (const section of ['left_default', 'warnings', 'alternatives']) assert.ok(errors.some((e) => e.startsWith(section)), section);
  });
  test('not an object', () => assert.deepEqual(validatePlan(['nope'], TASK, spec), ['The output must be a JSON object.']));
  test('a documented row needs a doc url', () => {
    const errors = plan((p) => { p.parameters[2].source_url = 'https://example.com/blog'; });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /documented rows need a source_url/);
  });
  test('a doc url with an anchor is fine', () => assert.deepEqual(plan((p) => { p.parameters[2].source_url = `${REF}#body-time-range`; }), []));
  test('default is not a row tag', () => assert.match(plan((p) => { p.parameters[1].tag = 'default'; })[0], /tag must be one of documented, judgment/));
  test('trigger phrase must come from the task', () => {
    const errors = plan((p) => { p.parameters[2].trigger_phrase = 'next month'; });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /verbatim/);
  });
  test('trigger phrase match ignores case', () => assert.deepEqual(plan((p) => { p.parameters[2].trigger_phrase = 'THIS WEEK'; }), []));
  test('a reason is required', () => assert.match(plan((p) => { p.parameters[1].reason = ' '; })[0], /needs a one-sentence 'reason'/));
  test('left_default cannot overlap set parameters', () => assert.match(plan((p) => p.left_default.push({ name: 'topic', reason: 'Left unset.' }))[0], /cannot also be left at default/));
  test('left_default must name a spec parameter', () => assert.match(plan((p) => { p.left_default = [{ name: 'freshness', reason: 'x' }]; })[0], /must be a parameter in the spec/));
  test('an alternative is validated as a full request', () => {
    const errors = plan((p) => { p.alternatives[0].parameters[1] = row('topic', 'gossip'); });
    assert.equal(errors.length, 1);
    assert.ok(errors[0].startsWith('topic:'));
  });
  test('an invented parameter in the plan', () => {
    const errors = plan((p) => p.parameters.push(row('freshness', 'week')));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /freshness/);
  });
  test('a duplicate parameter', () => assert.ok(plan((p) => p.parameters.push(row('topic', 'general'))).some((e) => e.includes('listed twice'))));
  test('a row named like an object property cannot slip through', () => {
    for (const name of ['constructor', '__proto__']) {
      assert.ok(plan((p) => p.parameters.push(row(name, 'x'))).some((e) => e.includes('not a parameter in the spec')), name);
    }
  });
});
