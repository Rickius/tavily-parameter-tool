// Streaming: the Token Factory client's streaming mode and the progress events the planner and ensemble report.
// The fake network sends Server-Sent Events split at awkward places, like a real connection does.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTokenFactory, UpstreamError, UpstreamTimeout } from '../core/clients.js';
import { planTask } from '../core/planner.js';
import { ensemblePlan } from '../core/ensemble.js';
import { createApp } from '../core/index.js';
import { groceryPlan, httpError, makeSettings, spec, TASK } from './support.js';

const encoder = new TextEncoder();
const json = (value) => JSON.stringify(value);

// ---------- building a stream ----------

const dataLine = (delta, finish = null) => `data: ${json({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

// The SSE text for a reply: reasoning pieces first, then the answer in pieces of `size` characters.
function sseText({ reasoning = '', content = '' }, size = 7) {
  let text = dataLine({ role: 'assistant' });
  for (let i = 0; i < reasoning.length; i += size) text += dataLine({ reasoning_content: reasoning.slice(i, i + size) });
  for (let i = 0; i < content.length; i += size) text += dataLine({ content: content.slice(i, i + size) });
  return `${text}${dataLine({}, 'stop')}data: [DONE]\n\n`;
}

// Cuts text into network chunks of `size` characters, which lands inside lines, inside "data:" and between \r and \n.
const cut = (text, size) => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));

// A streaming Response that hands over one piece per read, like a real connection. After the pieces, the stream ends
// ('close'), stays open until aborted ('hang'), or fails ('fail'). A failure arrives after the earlier pieces were read.
function streamResponse(pieces, { end = 'close', init } = {}) {
  const queue = [...pieces];
  const body = new ReadableStream(
    {
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
      },
      pull(controller) {
        if (queue.length) {
          const piece = queue.shift();
          controller.enqueue(typeof piece === 'string' ? encoder.encode(piece) : piece);
        } else if (end === 'close') controller.close();
        else if (end === 'fail') controller.error(new TypeError('secret network detail'));
        else return new Promise(() => {}); // 'hang': nothing more arrives until the call is aborted
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function chatClient(handler, extra = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError'); // like a real fetch
    calls.push({ url, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    return handler(url, init);
  };
  return { calls, client: createTokenFactory({ apiKey: 'test-key-123', fetchImpl, ...extra }) };
}

const ask = (client, options = {}) => client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { timeoutMs: 2000, ...options });

// ---------- the client ----------

describe('chat streaming', () => {
  test('reports reasoning then content as it arrives and returns the usual shape', async () => {
    const text = sseText({ reasoning: 'Let me think about it.', content: '{"ok": true}' }, 5);
    const { client, calls } = chatClient((url, init) => streamResponse(cut(text, 11), { init }));
    const deltas = [];
    const response = await ask(client, { onDelta: (d) => deltas.push(d) });

    assert.deepEqual(deltas.map((d) => d.kind).filter((kind, i, all) => kind !== all[i - 1]), ['reasoning', 'content']);
    assert.equal(deltas.filter((d) => d.kind === 'reasoning').map((d) => d.text).join(''), 'Let me think about it.');
    assert.equal(deltas.filter((d) => d.kind === 'content').map((d) => d.text).join(''), '{"ok": true}');
    const choice = response.choices[0];
    assert.equal(choice.message.role, 'assistant');
    assert.equal(choice.message.content, '{"ok": true}');
    assert.equal(choice.message.reasoning_content, 'Let me think about it.');
    assert.equal(choice.finish_reason, 'stop');
    assert.equal(calls[0].body.stream, true);
    assert.equal(calls[0].headers.Authorization, 'Bearer test-key-123');
  });

  test('a model that sends no reasoning returns no reasoning field', async () => {
    const { client } = chatClient((url, init) => streamResponse(cut(sseText({ content: 'plain' }), 9), { init }));
    const response = await ask(client, { onDelta: () => {} });
    assert.equal(response.choices[0].message.content, 'plain');
    assert.equal('reasoning_content' in response.choices[0].message, false);
  });

  test('reads the "reasoning" field too', async () => {
    const text = dataLine({ reasoning: 'hmm' }) + dataLine({ content: 'done' }) + 'data: [DONE]\n\n';
    const { client } = chatClient((url, init) => streamResponse([text], { init }));
    const deltas = [];
    const response = await ask(client, { onDelta: (d) => deltas.push(d) });
    assert.deepEqual(deltas, [{ kind: 'reasoning', text: 'hmm' }, { kind: 'content', text: 'done' }]);
    assert.equal(response.choices[0].message.reasoning_content, 'hmm');
  });

  test('copes with every way a connection can cut the stream', async () => {
    const text = sseText({ reasoning: 'think', content: '{"a": 1}' }, 3);
    for (const size of [1, 2, 3, 5, 8, 13, 64, 10_000]) {
      const { client } = chatClient((url, init) => streamResponse(cut(text, size), { init }));
      const response = await ask(client, { onDelta: () => {} });
      assert.equal(response.choices[0].message.content, '{"a": 1}', `chunk size ${size}`);
      assert.equal(response.choices[0].message.reasoning_content, 'think', `chunk size ${size}`);
    }
  });

  test('handles CRLF line endings, comments, other SSE fields and an empty-prefixed data line', async () => {
    const lines = [
      ': keepalive',
      '',
      'event: message',
      'id: 7',
      'retry: 3000',
      `data: ${json({ choices: [{ delta: { content: 'A' } }] })}`,
      '',
      ': another comment',
      `data:${json({ choices: [{ delta: { content: 'B' } }] })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\r\n');
    const { client } = chatClient((url, init) => streamResponse(cut(lines, 4), { init }));
    const response = await ask(client, { onDelta: () => {} });
    assert.equal(response.choices[0].message.content, 'AB');
  });

  test('keeps multi-byte characters that are split between network chunks', async () => {
    const text = sseText({ content: 'grocery 🛒 deals café' }, 4);
    const bytes = encoder.encode(text);
    const pieces = Array.from({ length: Math.ceil(bytes.length / 3) }, (_, i) => bytes.slice(i * 3, (i + 1) * 3));
    const { client } = chatClient((url, init) => streamResponse(pieces, { init }));
    const response = await ask(client, { onDelta: () => {} });
    assert.equal(response.choices[0].message.content, 'grocery 🛒 deals café');
  });

  test('skips a malformed data line and a chunk with no choices, and keeps the usage chunk', async () => {
    const text =
      dataLine({ content: 'one ' }) +
      'data: {this is not json\n\n' +
      `data: ${json({ choices: [] })}\n\n` +
      dataLine({ content: 'two' }) +
      `data: ${json({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n` +
      'data: [DONE]\n\n';
    const { client } = chatClient((url, init) => streamResponse([text], { init }));
    const response = await ask(client, { onDelta: () => {} });
    assert.equal(response.choices[0].message.content, 'one two');
    assert.deepEqual(response.usage, { prompt_tokens: 3, completion_tokens: 2 });
  });

  test('reads a final line that has no newline after it', async () => {
    const text = dataLine({ content: 'tail' }) + `data: ${json({ choices: [{ delta: { content: '!' } }] })}`;
    const { client } = chatClient((url, init) => streamResponse([text], { init }));
    assert.equal((await ask(client, { onDelta: () => {} })).choices[0].message.content, 'tail!');
  });

  test('a callback that throws does not break the call', async () => {
    const { client } = chatClient((url, init) => streamResponse(cut(sseText({ content: 'fine' }), 6), { init }));
    const response = await ask(client, { onDelta: () => { throw new Error('display broke'); } });
    assert.equal(response.choices[0].message.content, 'fine');
  });

  test('without onDelta nothing is streamed and the call is unchanged', async () => {
    const { client, calls } = chatClient(() => new Response(json({ choices: [{ message: { content: 'whole' } }] }), { status: 200 }));
    const response = await ask(client);
    assert.equal(response.choices[0].message.content, 'whole');
    assert.equal('stream' in calls[0].body, false);
  });
});

describe('chat streaming: failures', () => {
  test('an error status before the stream is an UpstreamError with the status only', async () => {
    const { client } = chatClient(() => new Response('{"error":"secret provider text"}', { status: 503 }));
    await assert.rejects(ask(client, { onDelta: () => {} }), (error) => error instanceof UpstreamError && error.status === 503 && !/secret/.test(error.message));
  });

  test('a stream that fails midway is an UpstreamError that hides the detail', async () => {
    const { client } = chatClient((url, init) => streamResponse([dataLine({ content: 'par' })], { end: 'fail', init }));
    const seen = [];
    await assert.rejects(ask(client, { onDelta: (d) => seen.push(d.text) }), (error) => error instanceof UpstreamError && error.status === null && !/secret/.test(error.message));
    assert.deepEqual(seen, ['par']);
  });

  test('an error object inside the stream is an UpstreamError that hides the text', async () => {
    const text = dataLine({ content: 'x' }) + `data: ${json({ error: { message: 'secret provider text' } })}\n\n`;
    const { client } = chatClient((url, init) => streamResponse([text], { init }));
    await assert.rejects(ask(client, { onDelta: () => {} }), (error) => error instanceof UpstreamError && !/secret/.test(error.message));
  });

  test('a response with no body is an UpstreamError', async () => {
    const { client } = chatClient(() => new Response(null, { status: 200 }));
    await assert.rejects(ask(client, { onDelta: () => {} }), UpstreamError);
  });

  test('stopping midway rejects with an AbortError and reports nothing more', async () => {
    const controller = new AbortController();
    const { client } = chatClient((url, init) => streamResponse([dataLine({ content: 'one' }), dataLine({ content: 'two' })], { end: 'hang', init }));
    const seen = [];
    await assert.rejects(
      ask(client, { signal: controller.signal, onDelta: (d) => { seen.push(d.text); controller.abort(); } }),
      (error) => error.name === 'AbortError',
    );
    assert.equal(seen.length >= 1 && seen.length <= 2, true);
    const after = seen.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(seen.length, after);
  });

  test('a stream that is already aborted never starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const { client } = chatClient((url, init) => streamResponse([], { end: 'hang', init }));
    await assert.rejects(ask(client, { signal: controller.signal, onDelta: () => {} }), (error) => error.name === 'AbortError');
  });

  test('a stream that stalls past the timeout is an UpstreamTimeout', async () => {
    const { client } = chatClient((url, init) => streamResponse([dataLine({ content: 'partial' })], { end: 'hang', init }));
    await assert.rejects(ask(client, { timeoutMs: 40, onDelta: () => {} }), UpstreamTimeout);
  });
});

// ---------- the planner and ensemble ----------

// A fake Token Factory that streams. chat: { [model]: [reply, ...] } where a reply is a string (the answer),
// { reasoning, content }, or httpError(status). Calls without stream:true get a plain JSON reply.
function streamingNetwork(chat, { size = 6 } = {}) {
  const queues = Object.fromEntries(Object.entries(chat).map(([model, replies]) => [model, [...replies]]));
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/models')) return new Response('{}', { status: 500 });
    const body = JSON.parse(init.body);
    calls.push(body);
    const reply = queues[body.model].shift();
    if (reply?.__fail === 'http') return new Response('secret', { status: reply.status });
    const { reasoning = '', content = '' } = typeof reply === 'string' ? { content: reply } : reply;
    if (!body.stream) return new Response(json({ choices: [{ message: { content } }] }), { status: 200 });
    return streamResponse(cut(sseText({ reasoning, content }, size), 13), { init });
  };
  return { fetch: fetchImpl, calls };
}

const ctxFor = (network, onProgress, signal) => ({
  tokenFactory: createTokenFactory({ apiKey: 'k', fetchImpl: network.fetch }),
  settings: makeSettings(),
  signal,
  onProgress,
});

// "stage_start:planner delta:planner stage_end:planner": consecutive deltas of one stage collapse into one.
function outline(events) {
  const out = [];
  for (const e of events) {
    const label = `${e.type}:${e.stage}`;
    if (e.type === 'delta' && out.at(-1) === label) continue;
    out.push(label);
  }
  return out;
}

const PLAN = json(groceryPlan());

describe('planner progress', () => {
  test('a single planner reports start, text and end, and streams only when asked', async () => {
    const network = streamingNetwork({ M: [{ reasoning: 'thinking it over', content: PLAN }, PLAN] });
    const events = [];
    const plan = await planTask(TASK, ctxFor(network, (e) => events.push(e)), 'M', spec);
    assert.deepEqual(plan, groceryPlan());
    assert.deepEqual(events[0], { type: 'stage_start', stage: 'planner', model: 'M', attempt: 1 });
    assert.deepEqual(outline(events), ['stage_start:planner', 'delta:planner', 'stage_end:planner']);
    assert.equal(events.find((e) => e.kind === 'reasoning').text.length > 0, true);
    assert.equal(events.filter((e) => e.kind === 'content').map((e) => e.text).join(''), PLAN);
    const end = events.at(-1);
    assert.equal(end.ok, true);
    assert.equal(typeof end.elapsed_seconds, 'number');
    assert.equal(network.calls[0].stream, true);

    await planTask(TASK, ctxFor(network, undefined), 'M', spec); // no onProgress: a plain call
    assert.equal('stream' in network.calls[1], false);
  });

  test('a rejected answer is reported as a retry with the validator errors, then the second attempt runs', async () => {
    const network = streamingNetwork({ M: ['Sure, here you go! Not JSON.', PLAN] });
    const events = [];
    await planTask(TASK, ctxFor(network, (e) => events.push(e)), 'M', spec);
    assert.deepEqual(outline(events), [
      'stage_start:planner', 'delta:planner', 'retry:planner', 'stage_start:planner', 'delta:planner', 'stage_end:planner',
    ]);
    assert.deepEqual(events.filter((e) => e.type === 'stage_start').map((e) => e.attempt), [1, 2]);
    const retry = events.find((e) => e.type === 'retry');
    assert.deepEqual(retry.errors, ['The reply was not a JSON object.']);
    assert.equal(events.at(-1).ok, true);
  });

  test('a plan that parses but breaks the spec is retried with its errors listed', async () => {
    const bad = groceryPlan();
    bad.parameters.push({ name: 'freshness', value: 'week', reason: 'x', trigger_phrase: null, tag: 'judgment', source_url: null });
    const network = streamingNetwork({ M: [json(bad), PLAN] });
    const events = [];
    await planTask(TASK, ctxFor(network, (e) => events.push(e)), 'M', spec);
    const retry = events.find((e) => e.type === 'retry');
    assert.ok(retry.errors.some((message) => message.includes('freshness')), retry.errors.join(' | '));
  });

  test('two rejected answers end the stage as failed and still throw', async () => {
    const network = streamingNetwork({ M: ['nope', 'still nope'] });
    const events = [];
    await assert.rejects(planTask(TASK, ctxFor(network, (e) => events.push(e)), 'M', spec), (error) => error.kind === 'invalid_output');
    assert.equal(events.filter((e) => e.type === 'retry').length, 1);
    const end = events.at(-1);
    assert.equal(end.type, 'stage_end');
    assert.equal(end.ok, false);
    assert.match(end.reason, /failed validation twice/);
  });

  test('a provider failure ends the stage as failed without leaking provider text', async () => {
    const network = streamingNetwork({ M: [httpError(500)] });
    const events = [];
    await assert.rejects(planTask(TASK, ctxFor(network, (e) => events.push(e)), 'M', spec), (error) => error.kind === 'upstream');
    const end = events.at(-1);
    assert.deepEqual([end.type, end.ok], ['stage_end', false]);
    assert.match(end.reason, /failed \(HTTP 500\)/);
    assert.doesNotMatch(JSON.stringify(events), /secret/);
  });

  test('stopping ends the stage as stopped and the call rejects with an AbortError', async () => {
    const controller = new AbortController();
    const hanging = async (url, init) => streamResponse([dataLine({ reasoning_content: 'thinking' })], { end: 'hang', init });
    const events = [];
    const ctx = {
      tokenFactory: createTokenFactory({ apiKey: 'k', fetchImpl: hanging }),
      settings: makeSettings(),
      signal: controller.signal,
      onProgress: (e) => {
        events.push(e);
        if (e.type === 'delta') controller.abort();
      },
    };
    await assert.rejects(planTask(TASK, ctx, 'M', spec), (error) => error.name === 'AbortError');
    const end = events.at(-1);
    assert.deepEqual([end.type, end.ok, end.reason], ['stage_end', false, 'Stopped']);
  });

  test('a progress callback that throws does not break the run', async () => {
    const network = streamingNetwork({ M: [PLAN] });
    const plan = await planTask(TASK, ctxFor(network, () => { throw new Error('display broke'); }), 'M', spec);
    assert.deepEqual(plan, groceryPlan());
  });
});

describe('ensemble progress', () => {
  test('both planners start together, and the aggregator starts only after both have ended', async () => {
    const network = streamingNetwork({ P1: [{ reasoning: 'a', content: PLAN }], P2: [PLAN], AGG: [{ reasoning: 'merging', content: PLAN }] });
    const events = [];
    const { plan, report } = await ensemblePlan(TASK, ctxFor(network, (e) => events.push(e)), 'P1', 'P2', 'AGG', spec);
    assert.equal(report.used, true);
    assert.equal(plan.parameters.length > 0, true);

    const stages = events.filter((e) => e.type === 'stage_start').map((e) => e.stage);
    assert.deepEqual(stages, ['planner1', 'planner2', 'aggregator']);
    const index = (type, stage) => events.findIndex((e) => e.type === type && e.stage === stage);
    assert.ok(index('stage_start', 'planner2') < index('stage_end', 'planner1'), 'planner 2 starts before planner 1 ends');
    assert.ok(Math.max(index('stage_end', 'planner1'), index('stage_end', 'planner2')) < index('stage_start', 'aggregator'));
    assert.ok(index('stage_end', 'aggregator') === events.length - 1);
    for (const stage of ['planner1', 'planner2', 'aggregator']) assert.equal(events.find((e) => e.type === 'stage_end' && e.stage === stage).ok, true);
    assert.equal(events.find((e) => e.type === 'stage_start' && e.stage === 'planner1').model, 'P1');
  });

  test('a failed planner is reported, and the aggregator still runs from the other plan', async () => {
    const network = streamingNetwork({ P1: [httpError(500)], P2: [PLAN], AGG: [PLAN] });
    const events = [];
    const { report } = await ensemblePlan(TASK, ctxFor(network, (e) => events.push(e)), 'P1', 'P2', 'AGG', spec);
    assert.equal(events.find((e) => e.type === 'stage_end' && e.stage === 'planner1').ok, false);
    assert.equal(events.find((e) => e.type === 'stage_end' && e.stage === 'planner2').ok, true);
    assert.equal(events.some((e) => e.type === 'stage_start' && e.stage === 'aggregator'), true);
    assert.match(report.note, /one plan only/);
  });

  test('a retry inside one planner is reported against that planner', async () => {
    const network = streamingNetwork({ P1: ['garbage', PLAN], P2: [PLAN], AGG: [PLAN] });
    const events = [];
    await ensemblePlan(TASK, ctxFor(network, (e) => events.push(e)), 'P1', 'P2', 'AGG', spec);
    const retries = events.filter((e) => e.type === 'retry');
    assert.deepEqual(retries.map((e) => e.stage), ['planner1']);
  });

  test('when both planners fail the aggregator never starts', async () => {
    const network = streamingNetwork({ P1: [httpError(500)], P2: [httpError(502)], AGG: [] });
    const events = [];
    await assert.rejects(ensemblePlan(TASK, ctxFor(network, (e) => events.push(e)), 'P1', 'P2', 'AGG', spec));
    assert.equal(events.some((e) => e.stage === 'aggregator'), false);
  });
});

describe('plan() with onProgress', () => {
  const settings = () => makeSettings({
    models: { planner: 'P1', planner2: 'P2', aggregator: 'AGG', small: 'S', large: 'L' },
    phase2Allowlist: [{ id: 'S', size: 'small' }, { id: 'L', size: 'large' }],
  });
  const appFor = (network) => createApp({ settings: settings(), keys: { nebiusApiKey: 'k1' }, fetchImpl: network.fetch, spec });

  test('the result is identical with and without progress reporting', async () => {
    const plain = await appFor(streamingNetwork({ P1: [PLAN] })).plan(TASK);
    const events = [];
    const streamed = await appFor(streamingNetwork({ P1: [PLAN] })).plan(TASK, { onProgress: (e) => events.push(e) });
    assert.deepEqual(streamed, plain);
    assert.equal(events.some((e) => e.type === 'delta' && e.stage === 'planner'), true);
  });

  test('the ensemble result is identical too, and the stages are named', async () => {
    const replies = () => ({ P1: [PLAN], P2: [PLAN], AGG: [PLAN] });
    const plain = await appFor(streamingNetwork(replies())).plan(TASK, { ensemble: true });
    const events = [];
    const streamed = await appFor(streamingNetwork(replies())).plan(TASK, { ensemble: true, onProgress: (e) => events.push(e) });
    assert.deepEqual({ ...streamed, ensemble: { ...streamed.ensemble, planners: [], aggregator: {} } }, { ...plain, ensemble: { ...plain.ensemble, planners: [], aggregator: {} } });
    assert.deepEqual([...new Set(events.map((e) => e.stage))].sort(), ['aggregator', 'planner1', 'planner2']);
  });

  test('stopping through the signal rejects with an AbortError', async () => {
    const controller = new AbortController();
    const hanging = async (url, init) => (url.endsWith('/models') ? new Response('{}', { status: 500 }) : streamResponse([dataLine({ content: '{' })], { end: 'hang', init }));
    const app = createApp({ settings: settings(), keys: { nebiusApiKey: 'k1' }, fetchImpl: hanging, spec });
    const promise = app.plan(TASK, { signal: controller.signal, onProgress: (e) => e.type === 'delta' && controller.abort() });
    await assert.rejects(promise, (error) => error.name === 'AbortError');
  });
});
