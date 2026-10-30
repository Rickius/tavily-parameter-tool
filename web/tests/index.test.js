import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError, createApp } from '../core/index.js';
import { call, clone, fakeFetch, groceryPlan, hit, httpError, makeSettings, msg, networkError, REF, row, spec, TASK } from './support.js';

const [P1, P2, AGG, SMALL, LARGE] = ['planner-one', 'planner-two', 'aggregator-model', 'small-model', 'large-model'];
const KEYS = { nebiusApiKey: 'test-nebius-key-1', tavilyApiKey: 'test-tavily-key-2' };
const json = (value) => JSON.stringify(value);

function settingsFor(overrides = {}) {
  const settings = makeSettings({
    models: { planner: P1, planner2: P2, aggregator: AGG, small: SMALL, large: LARGE },
    phase2Allowlist: [{ id: SMALL, size: 'small' }, { id: LARGE, size: 'large' }],
    ...overrides,
  });
  return settings;
}

function appWith(network, { settings = settingsFor(), keys = KEYS } = {}) {
  return createApp({ settings, keys, fetchImpl: network.fetch, spec });
}

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AppError, `expected an AppError, got ${error}`);
    return error;
  }
  assert.fail('expected the call to fail');
}

function planB() {
  const other = groceryPlan();
  other.parameters = [
    row('query', 'weekly grocery ads', { trigger: 'grocery deals' }),
    row('topic', 'news', { trigger: 'grocery deals' }),
    row('time_range', 'week', { tag: 'documented', trigger: 'this week', source_url: REF }),
    row('include_domains', ['walmart.com', 'kroger.com', 'heb.com'], { trigger: 'grocery deals' }),
    row('max_results', 5),
  ];
  other.alternatives = [];
  return other;
}

function merged() {
  const final = groceryPlan();
  final.parameters[0].value = "this week's grocery deals at local supermarkets";
  final.parameters[4].value = 5;
  return final;
}

// ---------- plan ----------

test('with the ensemble off the response has the HTTP API shape and one model call', async () => {
  const network = fakeFetch({ chat: { [P1]: [json(groceryPlan())] } });
  const data = await appWith(network).plan(TASK);

  assert.deepEqual(Object.keys(data), ['task', 'model', 'parameters', 'left_default', 'warnings', 'alternatives', 'request_body', 'python_snippet']);
  assert.ok(data.parameters.every((r) => !('agreement' in r)));
  assert.equal(network.chatCalls().length, 1);
  assert.equal(data.model, P1);
  assert.deepEqual(data.left_default, [{ name: 'search_depth', reason: 'Short, focused lookup; basic is the default.', tag: 'default' }]);
  assert.equal(Object.keys(data.request_body)[0], 'query'); // request_body always starts with query
  assert.equal(data.request_body.max_results, 10);
  assert.match(data.python_snippet, /^from tavily import TavilyClient/);
  assert.ok(data.python_snippet.includes("    topic='general',\n"));
  const [alt] = data.alternatives;
  assert.deepEqual(Object.keys(alt), ['label', 'tradeoff', 'parameters', 'request_body', 'python_snippet']);
  assert.equal(alt.request_body.topic, 'news');
});

test('the ensemble adds agreement and the ensemble object', async () => {
  const network = fakeFetch({ chat: { [P1]: [json(groceryPlan())], [P2]: [json(planB())], [AGG]: [json(merged())] } });
  const data = await appWith(network).plan(TASK, { ensemble: true });

  assert.equal(data.model, P1);
  assert.equal(Object.fromEntries(data.parameters.map((r) => [r.name, r.agreement])).max_results, 'planner_2');
  assert.equal(data.request_body.max_results, 5);
  assert.equal(data.ensemble.used, true);
  assert.equal(data.ensemble.aggregator.model, AGG);
  assert.deepEqual(data.ensemble.planners.map((p) => p.model), [P1, P2]);
  assert.ok(!('agreement' in data.alternatives[0].parameters[0]));
});

test('the request default comes from the settings', async () => {
  const on = fakeFetch({ chat: { [P1]: [json(groceryPlan())], [P2]: [json(groceryPlan())], [AGG]: [json(groceryPlan())] } });
  assert.equal((await appWith(on, { settings: settingsFor({ ensembleDefault: true }) }).plan(TASK)).ensemble.used, true);

  const off = fakeFetch({ chat: { [P1]: [json(groceryPlan())] } });
  const data = await appWith(off, { settings: settingsFor({ ensembleDefault: true }) }).plan(TASK, { ensemble: false });
  assert.ok(!('ensemble' in data));
});

test('an unconfigured ensemble falls back to the single planner and says why', async () => {
  const settings = settingsFor();
  settings.models.planner2 = '';
  settings.models.aggregator = '';
  const network = fakeFetch({ chat: { [P1]: [json(groceryPlan())] } });

  const data = await appWith(network, { settings }).plan(TASK, { ensemble: true });

  assert.equal(data.ensemble.used, false);
  assert.match(data.ensemble.note, /models\.planner2 and models\.aggregator/);
  assert.equal(network.chatCalls().length, 1);
});

test('a model missing from the live list makes the ensemble fall back', async () => {
  const network = fakeFetch({ models: [P1, P2, SMALL, LARGE], chat: { [P1]: [json(groceryPlan())] } }); // the aggregator is not live
  const data = await appWith(network).plan(TASK, { ensemble: true });
  assert.equal(data.ensemble.used, false);
  assert.ok(data.ensemble.note.includes(AGG));
});

test('plan failures use the HTTP API error codes', async () => {
  const upstream = await failure(appWith(fakeFetch({ chat: { [P1]: [httpError(500)] } })).plan(TASK));
  assert.equal(upstream.code, 'upstream_error');
  assert.match(upstream.message, /HTTP 500/);
  assert.doesNotMatch(upstream.message, /secret/);

  const bad = groceryPlan();
  bad.parameters.at(-1).value = 99;
  const invalid = await failure(appWith(fakeFetch({ chat: { [P1]: [json(bad), json(bad)] } })).plan(TASK));
  assert.equal(invalid.code, 'invalid_plan');
  assert.ok(invalid.details.some((d) => d.includes('max_results')));

  const both = await failure(appWith(fakeFetch({ chat: { [P1]: [httpError(500)], [P2]: [httpError(500)] } })).plan(TASK, { ensemble: true }));
  assert.equal(both.code, 'upstream_error');
});

test('plan validates the task and needs a Token Factory key', async () => {
  const app = appWith(fakeFetch());
  assert.equal((await failure(app.plan(''))).code, 'bad_request');
  assert.equal((await failure(app.plan(5))).code, 'bad_request');
  const tooLong = await failure(app.plan('x'.repeat(501)));
  assert.equal(tooLong.code, 'bad_request');
  assert.match(tooLong.message, /limited to 500 characters; yours has 501/);

  const noKey = await failure(createApp({ settings: settingsFor(), keys: {}, fetchImpl: fakeFetch().fetch, spec }).plan(TASK));
  assert.equal(noKey.code, 'not_configured');
});

test('the spec is loaded once, lazily, through the injectable loader', async () => {
  let loads = 0;
  const network = fakeFetch({ chat: { [P1]: [json(groceryPlan()), json(groceryPlan())] } });
  const app = createApp({ settings: settingsFor(), keys: KEYS, fetchImpl: network.fetch, loadSpec: async () => { loads += 1; return clone(spec); } });
  assert.equal(loads, 0);
  await app.plan(TASK);
  await app.plan(TASK);
  assert.equal(loads, 1);
});

// ---------- config and models ----------

test('getConfig reports ensemble availability and the limits', async () => {
  const app = appWith(fakeFetch({ models: [P1, P2, AGG, SMALL, LARGE] }), { settings: settingsFor({ ensembleDefault: true }) });
  assert.deepEqual(await app.getConfig(), {
    ensemble: { default: true, planners: [P1, P2], aggregator: AGG, available: true, reason: null },
    access_required: false,
    compare_enabled: true,
    max_task_chars: 500,
  });

  const noKey = await createApp({ settings: settingsFor(), keys: {}, fetchImpl: fakeFetch().fetch, spec }).getConfig();
  assert.equal(noKey.ensemble.available, false);
  assert.match(noKey.ensemble.reason, /No Token Factory API key/);
});

test('checkModels reports models that are not live, with similar names', async () => {
  const app = appWith(fakeFetch({ models: [LARGE, `${SMALL}-fast`] }));
  const { available, problems } = await app.checkModels();
  assert.deepEqual(available, [LARGE, `${SMALL}-fast`]);
  assert.equal(problems.length, 2); // the planner and the small model
  const small = problems.find((p) => p.includes('small model'));
  assert.ok(small.includes("'small-model'") && small.includes('retired or renamed') && small.includes(`${SMALL}-fast`));
  assert.ok(problems.some((p) => p.includes('planner model')));
});

test('checkModels reports a rejected key and a network failure as upstream_error', async () => {
  const rejected = await failure(appWith(fakeFetch({ models: httpError(401) })).checkModels());
  assert.equal(rejected.code, 'upstream_error');
  assert.match(rejected.message, /rejected the API key \(HTTP 401\)/);
  assert.doesNotMatch(rejected.message, /secret/);

  const unreachable = await failure(appWith(fakeFetch({ models: networkError() })).checkModels());
  assert.equal(unreachable.code, 'upstream_error');
  assert.match(unreachable.message, /\(no response\)/);
  assert.doesNotMatch(unreachable.message, /secret/);
});

test('an unreadable model list leaves the app working, just unfiltered', async () => {
  const network = fakeFetch({ chat: { [P1]: [json(groceryPlan())] } }); // GET /models fails
  const app = appWith(network);
  assert.equal((await app.listModels()).models.length, 2);
  assert.equal((await app.plan(TASK)).model, P1);
});

test('listModels offers only allowlisted models that are live, and marks the defaults', async () => {
  const app = appWith(fakeFetch({ models: [LARGE, 'other-large'] }));
  const data = await app.listModels();
  assert.deepEqual(data.models, [{ id: LARGE, size: 'large', default: true }]);
  assert.deepEqual(data.limits, { default_turns: 6, max_turns: 12, default_searches: 4, max_searches: 8 });
});

test('listModels is empty when Compare is switched off, and the limits cannot exceed the hard maximums', async () => {
  const off = appWith(fakeFetch(), { settings: settingsFor({ compareEnabled: false }) });
  assert.deepEqual((await off.listModels()).models, []);
  assert.equal((await off.getConfig()).compare_enabled, false);

  const greedy = appWith(fakeFetch({ models: [SMALL, LARGE] }), { settings: settingsFor({ maxTurns: 50, maxSearches: 50, defaultTurns: 30, defaultSearches: 30 }) });
  assert.deepEqual((await greedy.listModels()).limits, { default_turns: 12, max_turns: 12, default_searches: 8, max_searches: 8 });
});

test('a Compare model outside the allowlist is rejected when the app is created', () => {
  const settings = settingsFor();
  settings.models.small = 'some/other-model';
  assert.throws(() => createApp({ settings, keys: KEYS, spec }), (error) => error.code === 'not_configured' && /phase2Allowlist/.test(error.message));
});

// ---------- compare ----------

const compareNetwork = (chat, extra = {}) => fakeFetch({ models: [SMALL, LARGE, 'other-large'], chat, ...extra });

test('compare requires explicit confirmation and runs nothing without it', async () => {
  const network = compareNetwork({ [SMALL]: [msg('x')], [LARGE]: [msg('x')] });
  const error = await failure(appWith(network).compare({ query: TASK, maxSearches: 3 }));
  assert.equal(error.code, 'confirmation_required');
  assert.ok(error.message.includes('3 searches') && error.message.includes('2 for advanced'));
  assert.equal(network.chatCalls().length, 0);
  assert.equal(network.searchCalls().length, 0);
});

test('compare streams both runs to the callback', async () => {
  const network = compareNetwork({ [SMALL]: [msg('small answer')], [LARGE]: [msg(null, [call({ query: 'q' })]), msg('large answer')] });
  const events = [];

  await appWith(network).compare({ query: TASK, confirm: true }, (event) => events.push(event));

  const ends = Object.fromEntries(events.filter((e) => e.type === 'run_end').map((e) => [e.run, e]));
  assert.deepEqual([ends.small.searches, ends.large.searches], [0, 1]);
  assert.deepEqual(events.at(-1), { type: 'done' });
  assert.deepEqual(events.find((e) => e.type === 'run_start' && e.run === 'small'), { type: 'run_start', model: SMALL, max_turns: 6, max_searches: 4, run: 'small' });
  assert.deepEqual(network.chatCalls(SMALL)[0].body.messages, [{ role: 'user', content: TASK }]); // unchanged, no system prompt
});

test('compare runs one role and refuses a model outside the allowlist', async () => {
  const refused = await failure(appWith(compareNetwork({})).compare({ query: TASK, confirm: true, roles: ['large'], models: { large: 'other-large' } }));
  assert.equal(refused.code, 'unknown_model'); // live, but not allowlisted
  const wrongSize = await failure(appWith(compareNetwork({})).compare({ query: TASK, confirm: true, roles: ['small'], models: { small: LARGE } }));
  assert.equal(wrongSize.code, 'unknown_model');

  const events = [];
  await appWith(compareNetwork({ [LARGE]: [msg('answer')] })).compare({ query: TASK, confirm: true, roles: ['large'] }, (event) => events.push(event));
  assert.deepEqual(new Set(events.filter((e) => 'run' in e).map((e) => e.run)), new Set(['large']));
});

test('compare caps are bounded', async () => {
  const app = appWith(compareNetwork({}));
  for (const bad of [{ maxSearches: 999 }, { maxTurns: 0 }, { maxTurns: 999 }, { maxTurns: 1.5 }, { roles: [] }, { roles: ['medium'] }, { roles: ['small', 'large', 'small'] }, { models: { huge: 'x' } }]) {
    const error = await failure(app.compare({ query: TASK, confirm: true, ...bad }));
    assert.equal(error.code, 'bad_request', JSON.stringify(bad));
    assert.ok(error.details.length > 0);
  }
});

test('compare passes the caps to the runs, and never lets a run exceed the search cap', async () => {
  const keepSearching = (messages) => msg(null, [call({ query: `a different query ${messages.length}` }, `c${messages.length}`)]);
  const network = compareNetwork({ [SMALL]: keepSearching, [LARGE]: keepSearching });
  const events = [];

  await appWith(network).compare({ query: TASK, confirm: true, maxTurns: 8, maxSearches: 2 }, (event) => events.push(event));

  assert.equal(network.searchCalls().length, 4); // two searches per model, never more
  assert.ok(events.filter((e) => e.type === 'run_end').every((e) => e.searches === 2 && e.blocked_calls >= 1));
});

test('compare is switched off, or missing a key', async () => {
  const off = appWith(compareNetwork({}), { settings: settingsFor({ compareEnabled: false }) });
  assert.equal((await failure(off.compare({ query: TASK, confirm: true }))).code, 'compare_disabled');

  const noTavily = appWith(compareNetwork({}), { keys: { nebiusApiKey: KEYS.nebiusApiKey } });
  const error = await failure(noTavily.compare({ query: TASK, confirm: true }));
  assert.equal(error.code, 'not_configured');
  assert.match(error.message, /Tavily API key/);
  // The Parameters side does not need the Tavily key.
  const plan = await appWith(fakeFetch({ chat: { [P1]: [json(groceryPlan())] } }), { keys: { nebiusApiKey: KEYS.nebiusApiKey } }).plan(TASK);
  assert.equal(plan.model, P1);
});

test('keys appear only in Authorization headers, never in a result or an error', async () => {
  const network = compareNetwork({ [SMALL]: [msg(null, [call({ query: 'q' })]), msg('done')], [LARGE]: [httpError(401)] }, { tavily: [{ results: [hit(1)], usage: { credits: 1 } }] });
  const events = [];
  await appWith(network).compare({ query: TASK, confirm: true }, (event) => events.push(event));

  const bodiesAndEvents = JSON.stringify([events, network.calls.map((c) => c.body)]);
  assert.ok(!bodiesAndEvents.includes(KEYS.nebiusApiKey) && !bodiesAndEvents.includes(KEYS.tavilyApiKey));
  assert.ok(network.calls.every((c) => c.headers.Authorization === `Bearer ${c.url.includes('tavily') ? KEYS.tavilyApiKey : KEYS.nebiusApiKey}`));
  const failed = events.find((e) => e.type === 'run_error');
  assert.equal(failed.message, 'Token Factory request failed (HTTP 401).');
});
