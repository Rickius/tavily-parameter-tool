import test from 'node:test';
import assert from 'node:assert/strict';
import { createTavily, createTokenFactory, describeUpstream, UpstreamError, UpstreamTimeout } from '../core/clients.js';
import { badBody, fakeFetch, hang, httpError, networkError } from './support.js';

test('chat posts JSON with a bearer key to the Token Factory chat endpoint', async () => {
  const network = fakeFetch({ chat: [{ content: 'hi' }] });
  const reply = await createTokenFactory({ apiKey: 'k1', fetchImpl: network.fetch }).chat({ model: 'm', messages: [] }, { timeoutMs: 1000 });
  assert.equal(reply.choices[0].message.content, 'hi');
  const [call] = network.calls;
  assert.equal(call.url, 'https://api.tokenfactory.nebius.com/v1/chat/completions');
  assert.equal(call.method, 'POST');
  assert.deepEqual(call.headers, { Authorization: 'Bearer k1', 'Content-Type': 'application/json' });
});

test('listModels is a GET with no body and returns the IDs', async () => {
  const network = fakeFetch({ models: ['a/b', 'c/d'] });
  assert.deepEqual(await createTokenFactory({ apiKey: 'k1', fetchImpl: network.fetch }).listModels({ timeoutMs: 1000 }), ['a/b', 'c/d']);
  assert.equal(network.calls[0].method, 'GET');
  assert.equal(network.calls[0].body, undefined);
  assert.deepEqual(network.calls[0].headers, { Authorization: 'Bearer k1' });
});

test('tavily posts the search body to the search endpoint with a bearer key', async () => {
  const network = fakeFetch({ tavily: [{ results: [] }] });
  await createTavily({ apiKey: 'k2', fetchImpl: network.fetch }).search({ query: 'q', include_usage: true }, { timeoutMs: 1000 });
  const [call] = network.calls;
  assert.equal(call.url, 'https://api.tavily.com/search');
  assert.deepEqual(call.body, { query: 'q', include_usage: true });
  assert.equal(call.headers.Authorization, 'Bearer k2');
});

test('a failed call reports a status or "no response", never the provider text', async () => {
  const client = createTokenFactory({ apiKey: 'k', fetchImpl: fakeFetch({ chat: [httpError(429), networkError(), badBody()] }).fetch });
  const errors = [];
  for (let i = 0; i < 3; i++) errors.push(await client.chat({}, { timeoutMs: 1000 }).catch((error) => error));
  assert.ok(errors.every((e) => e instanceof UpstreamError));
  assert.deepEqual(errors.map(describeUpstream), ['HTTP 429', 'no response', 'no response']);
  assert.ok(errors.every((e) => !/secret|k\b/.test(e.message)));
});

test('a call that never answers ends as a timeout', async () => {
  const client = createTokenFactory({ apiKey: 'k', fetchImpl: fakeFetch({ chat: [hang()] }).fetch });
  await assert.rejects(client.chat({}, { timeoutMs: 30 }), UpstreamTimeout);
});

test('the caller can cancel a call, and that is not reported as a failure', async () => {
  const controller = new AbortController();
  const client = createTokenFactory({ apiKey: 'k', fetchImpl: fakeFetch({ chat: [hang(), hang()] }).fetch });
  const pending = client.chat({}, { timeoutMs: 5000, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(client.chat({}, { timeoutMs: 5000, signal: controller.signal }), { name: 'AbortError' }); // already aborted
});
