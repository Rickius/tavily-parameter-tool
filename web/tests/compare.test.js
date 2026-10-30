import test from 'node:test';
import assert from 'node:assert/strict';
import { createTavily, createTokenFactory } from '../core/clients.js';
import { queryWords, repeatOf, runAll, runModel, toolSchema, TOOL_NAME } from '../core/compare.js';
import { call, fakeFetch, hang, hit, httpError, msg, networkError, spec } from './support.js';

const QUERY = "find this week's grocery deals";
const NEBIUS_KEY = 'test-nebius-key-1';
const TAVILY_KEY = 'test-tavily-key-2';

// One run on model "m"; `chat` is the model's replies, `tavily` the search responses.
async function go(chat, { tavily = [], maxTurns = 6, maxSearches = 4, timeoutSeconds = 5 } = {}) {
  const network = fakeFetch({ chat: Array.isArray(chat) || typeof chat === 'function' ? { m: chat } : chat, tavily });
  const ctx = { tokenFactory: createTokenFactory({ apiKey: NEBIUS_KEY, fetchImpl: network.fetch }), tavily: createTavily({ apiKey: TAVILY_KEY, fetchImpl: network.fetch }), timeoutSeconds };
  const events = [];
  await runModel(QUERY, 'm', ctx, (event) => events.push(event), maxTurns, maxSearches, spec);
  return { events, network };
}
const ofType = (events, type) => events.filter((e) => e.type === type);
const end = (events) => ofType(events, 'run_end')[0];

// ---------- the tool and the counters ----------

test('the tool schema follows the spec', () => {
  const { function: fn } = toolSchema(spec);
  assert.equal(fn.name, TOOL_NAME);
  assert.deepEqual(fn.parameters.required, ['query']);
  assert.ok(!('include_usage' in fn.parameters.properties)); // the code sets it
  assert.deepEqual(new Set(Object.keys(fn.parameters.properties)), new Set(Object.entries(spec.parameters).filter(([, e]) => e.planner_choosable !== false).map(([n]) => n)));
  assert.equal(fn.parameters.properties.max_results.maximum, 20);
  assert.ok(!JSON.stringify(fn.parameters.properties).toLowerCase().includes('planner')); // no planner-only notes leak into the tool
});

test('repeat detection ignores case, order and punctuation', () => {
  const earlier = [[1, queryWords('Grocery deals this week')]];
  assert.equal(repeatOf('this WEEK: grocery deals!', earlier), 1);
  assert.equal(repeatOf('grocery deals this week near me', earlier), null); // 4 of 6 words shared, below 0.8
  assert.equal(repeatOf('walmart weekly ad', earlier), null);
});

// ---------- one run ----------

test('a valid tool call flow', async () => {
  const args = { query: 'weekly grocery ad', time_range: 'week', max_results: 5 };
  const { events, network } = await go([msg(null, [call(args)]), msg('Here are the deals.')]);

  assert.deepEqual(events.map((e) => e.type), ['run_start', 'waiting', 'model_turn', 'tool_call', 'tool_result', 'waiting', 'model_turn', 'answer', 'run_end']);
  assert.deepEqual(network.searchCalls().map((c) => c.body), [{ ...args, include_usage: true }]);
  const summary = end(events);
  assert.deepEqual([summary.end_reason, summary.turns, summary.searches, summary.distinct_urls, summary.credits], ['answered', 2, 1, 1, 1]);

  const [first, second] = network.chatCalls();
  assert.deepEqual(first.body.messages, [{ role: 'user', content: QUERY }]); // the query unchanged, no system prompt, no hints
  assert.equal(first.body.tools[0].function.name, TOOL_NAME);
  const returned = second.body.messages.at(-1);
  assert.equal(returned.role, 'tool');
  assert.equal(returned.tool_call_id, 'c1');
  assert.equal(JSON.parse(returned.content).results[0].url, 'https://example.com/1');
  assert.equal(second.body.messages.at(-2).tool_calls[0].function.arguments, JSON.stringify(args));
});

test('max_results is optional for the model and null means unset', async () => {
  const { events, network } = await go([msg(null, [call({ query: 'q', topic: null, include_domains: null })]), msg('done')]);
  assert.deepEqual(network.searchCalls().map((c) => c.body), [{ query: 'q', include_usage: true }]);
  assert.equal(ofType(events, 'tool_error').length, 0);
});

test('invalid arguments are rejected and returned to the model', async () => {
  const bad = { query: 'q', freshness: 'week', max_results: 99 };
  const { events, network } = await go([msg(null, [call(bad)]), msg(null, [call({ query: 'q' }, 'c2')]), msg('done')]);

  assert.equal(network.searchCalls().length, 1); // only the corrected call reached Tavily
  const [error] = ofType(events, 'tool_error');
  assert.equal(error.kind, 'invalid_arguments');
  assert.equal(error.counted, false);
  assert.ok(error.message.includes('freshness') && error.message.includes('max_results'));
  assert.ok(JSON.parse(network.chatCalls()[1].body.messages.at(-1).content).error.includes('freshness'));
  assert.deepEqual([end(events).invalid_calls, end(events).searches], [1, 1]);
});

test('bad JSON arguments and an unknown tool are tool errors', async () => {
  const { events, network } = await go([msg(null, [call('{not json', 'a'), call({ query: 'q' }, 'b', 'browse')]), msg('done')]);
  assert.deepEqual(ofType(events, 'tool_error').map((e) => e.kind), ['invalid_arguments', 'unknown_tool']);
  assert.equal(network.searchCalls().length, 0);
  assert.equal(end(events).invalid_calls, 2);
  assert.equal(ofType(events, 'tool_call')[0].arguments, '{not json'); // unparsable arguments are reported as the raw text
});

test('the search cap holds', async () => {
  const three = [0, 1, 2].map((i) => call({ query: `query number ${i}` }, `c${i}`));
  const { events, network } = await go([msg(null, three), msg(null, [call({ query: 'another one' }, 'c9')]), msg('done')], { maxSearches: 2 });

  assert.equal(network.searchCalls().length, 2); // the cap is never exceeded
  assert.equal(ofType(events, 'tool_error').filter((e) => e.kind === 'search_cap').length, 2);
  const summary = end(events);
  assert.deepEqual([summary.searches, summary.blocked_calls, summary.end_reason], [2, 2, 'answered']);
  assert.ok(network.chatCalls()[1].body.messages.at(-1).content.includes('Search limit reached'));
});

test('the turn cap holds and the last turn\'s calls are not run', async () => {
  const keepSearching = (messages) => msg(null, [call({ query: `different query ${messages.length}` }, `c${messages.length}`)]);
  const { events, network } = await go(keepSearching, { maxTurns: 3, maxSearches: 8 });

  assert.equal(network.chatCalls().length, 3);
  assert.equal(network.searchCalls().length, 2); // turns 1 and 2 searched; turn 3's request had no turn left to use it
  assert.equal(ofType(events, 'tool_error').at(-1).kind, 'turn_cap');
  const summary = end(events);
  assert.deepEqual([summary.end_reason, summary.turns, summary.searches], ['turn_cap', 3, 2]);
});

test('a Tavily error becomes a tool error and counts against the cap', async () => {
  const { events, network } = await go([msg(null, [call({ query: 'q one' })]), msg(null, [call({ query: 'q two' }, 'c2')]), msg('done')], { tavily: [httpError(429)], maxSearches: 1 });

  const [first, second] = ofType(events, 'tool_error');
  assert.equal(first.kind, 'tavily_error');
  assert.equal(first.counted, true);
  assert.ok(first.message.includes('429'));
  assert.ok(!first.message.includes('secret')); // the provider's text is not passed on
  assert.ok(JSON.parse(network.chatCalls()[1].body.messages.at(-1).content).error.includes('429'));
  assert.equal(second.kind, 'search_cap');
  assert.equal(network.searchCalls().length, 1); // the failed search used the only slot
  assert.deepEqual([end(events).searches, end(events).failed_searches], [1, 1]);
});

test('a Tavily network failure is a tool error too', async () => {
  const { events } = await go([msg(null, [call({ query: 'q' })]), msg('done')], { tavily: [networkError()] });
  const [error] = ofType(events, 'tool_error');
  assert.equal(error.message, 'Tavily error (no response)');
  assert.equal(end(events).end_reason, 'answered');
});

test('the summary counts URLs, repeats and credits', async () => {
  const tavily = [
    { results: [hit(1), hit(2)], usage: { credits: 1 } },
    { results: [hit(2, 'https://example.com/2/'), hit(3)], usage: { credits: 2 } }, // a trailing slash is the same URL
  ];
  const { events } = await go([msg(null, [call({ query: 'grocery deals this week' })]), msg(null, [call({ query: 'This week: grocery deals' }, 'c2')]), msg('done')], { tavily });

  const results = ofType(events, 'tool_result');
  assert.deepEqual([results[0].repeat_of, results[1].repeat_of], [null, 1]);
  assert.deepEqual(results[1].results.map((r) => r.new), [false, true]);
  const summary = end(events);
  assert.deepEqual([summary.distinct_urls, summary.repeated_queries, summary.credits, summary.credits_complete], [3, 1, 3, true]);
});

test('credits are marked incomplete when usage is missing', async () => {
  const { events } = await go([msg(null, [call({ query: 'q' })]), msg('done')], { tavily: [{ results: [hit(1)] }] });
  assert.equal(end(events).credits_complete, false);
});

test('reasoning is read from either field, and missing is null', async () => {
  for (const [extra, expected] of [[{}, null], [{ reasoning_content: 'thinking A' }, 'thinking A'], [{ reasoning: 'thinking B' }, 'thinking B']]) {
    const { events } = await go([msg('answer', [], extra)]);
    assert.equal(ofType(events, 'model_turn')[0].reasoning, expected);
  }
});

test('a model that does not answer ends as a timeout, not a hang', async () => {
  const { events } = await go([hang()], { timeoutSeconds: 0.05 });
  const [error] = ofType(events, 'run_error');
  assert.equal(error.kind, 'timeout');
  assert.ok(error.message.includes('0.05 seconds') && error.message.includes('runTimeoutSeconds'));
  assert.equal(end(events).end_reason, 'timeout');
});

test('an upstream failure is reported by its status only', async () => {
  const { events } = await go([httpError(503)]);
  assert.deepEqual(ofType(events, 'run_error')[0], { type: 'run_error', kind: 'upstream', message: 'Token Factory request failed (HTTP 503).' });
  assert.equal(end(events).end_reason, 'error');
});

test('an unexpected bug ends the run with an error event and logs only the error name', async () => {
  const log = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    // A malformed tool call (no function object) makes the loop throw a TypeError of its own.
    const { events } = await go([{ content: null, tool_calls: [{ id: 'c1' }] }]);
    assert.equal(ofType(events, 'run_error')[0].kind, 'internal');
    assert.equal(ofType(events, 'run_error')[0].message, 'The run stopped because of an unexpected error.');
    assert.equal(end(events).end_reason, 'error');
  } finally {
    console.error = log;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /TypeError/);
  assert.ok(!logged[0].includes('function')); // the error text itself is not logged
});

test('keys never appear in a request body or an event', async () => {
  const { events, network } = await go([msg(null, [call({ query: 'q' })]), msg('done')]);
  const everything = JSON.stringify([events, network.calls.map((c) => c.body)]);
  assert.ok(!everything.includes(NEBIUS_KEY) && !everything.includes(TAVILY_KEY));
  assert.equal(network.chatCalls()[0].headers.Authorization, `Bearer ${NEBIUS_KEY}`);
  assert.equal(network.searchCalls()[0].headers.Authorization, `Bearer ${TAVILY_KEY}`);
});

// ---------- parallel runs ----------

test('parallel runs are independent and end with one done event', async () => {
  const chat = {
    'small-model': [msg(null, [call({ query: 'grocery deals' })]), msg('small answer')],
    'large-model': [msg(null, [call({ query: 'weekly ad one' })]), msg(null, [call({ query: 'weekly ad two' }, 'c2')]), msg('large answer')],
  };
  const network = fakeFetch({ chat });
  const ctx = { tokenFactory: createTokenFactory({ apiKey: NEBIUS_KEY, fetchImpl: network.fetch }), tavily: createTavily({ apiKey: TAVILY_KEY, fetchImpl: network.fetch }), timeoutSeconds: 5 };
  const events = [];
  const runs = [{ role: 'small', model: 'small-model' }, { role: 'large', model: 'large-model' }];

  await runAll(runs, QUERY, ctx, 6, 4, (event) => events.push(event), spec);

  const ends = Object.fromEntries(ofType(events, 'run_end').map((e) => [e.run, e]));
  assert.deepEqual([ends.small.searches, ends.large.searches], [1, 2]);
  assert.deepEqual(new Set(events.filter((e) => 'run' in e).map((e) => e.run)), new Set(['small', 'large']));
  assert.deepEqual(events.at(-1), { type: 'done' });
  assert.equal(ofType(events, 'done').length, 1);
  assert.deepEqual(new Set(ofType(events, 'answer').map((e) => e.content)), new Set(['small answer', 'large answer']));
});

test('cancelling stops the runs quietly: no run_end and no done', async () => {
  const controller = new AbortController();
  const network = fakeFetch({ chat: { m: [hang()] } });
  const ctx = { tokenFactory: createTokenFactory({ apiKey: NEBIUS_KEY, fetchImpl: network.fetch }), tavily: null, timeoutSeconds: 5, signal: controller.signal };
  const events = [];

  const finished = runAll([{ role: 'small', model: 'm' }], QUERY, ctx, 6, 4, (event) => events.push(event), spec);
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await finished;

  assert.deepEqual(events.map((e) => e.type), ['run_start', 'waiting']);
});
