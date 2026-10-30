// Shared test helpers: the spec, sample plans, and a fake fetch that stands in for Token Factory and Tavily.

import { readFileSync } from 'node:fs';
import { createTokenFactory } from '../core/clients.js';
import { settings as defaultSettings } from '../settings.js';

export const spec = JSON.parse(readFileSync(new URL('../spec.json', import.meta.url), 'utf8'));
export const REF = spec.sources.api_reference;
export const TASK = "Find this week's grocery deals near me in Austin, Texas";
export const clone = (value) => structuredClone(value);

export const row = (name, value, { tag = 'judgment', trigger = null, source_url = null, reason = 'A plain one-sentence reason.' } = {}) => ({
  name, value, reason, trigger_phrase: trigger, tag, source_url,
});

export const GROCERY_PLAN = {
  parameters: [
    row('query', 'grocery deals weekly ad Austin Texas', { trigger: 'grocery deals' }),
    row('topic', 'general', { trigger: 'grocery deals' }),
    row('time_range', 'week', { tag: 'documented', trigger: 'this week', source_url: REF }),
    row('include_domains', ['kroger.com', 'heb.com', 'walmart.com'], { trigger: 'grocery deals' }),
    row('max_results', 10),
  ],
  left_default: [{ name: 'search_depth', reason: 'Short, focused lookup; basic is the default.' }],
  warnings: ['Tavily has country-level boosting only; the city is in the query text.'],
  alternatives: [
    {
      label: 'topic news',
      tradeoff: 'News covers current events, not store flyers, so results are likely weaker.',
      parameters: [row('query', 'grocery deals Austin Texas'), row('topic', 'news'), row('time_range', 'week'), row('max_results', 10)],
    },
  ],
};
export const groceryPlan = () => clone(GROCERY_PLAN);

// Test settings: the real defaults with short timeouts, and three distinct models per role.
export function makeSettings(overrides = {}) {
  const settings = clone(defaultSettings);
  settings.plannerTimeoutSeconds = 5;
  settings.runTimeoutSeconds = 5;
  return Object.assign(settings, overrides);
}

// ---------- the fake network ----------

export const httpError = (status) => ({ __fail: 'http', status });
export const networkError = () => ({ __fail: 'network' });
export const hang = () => ({ __fail: 'hang' }); // never answers; only an abort ends it
export const badBody = () => ({ __fail: 'body' });

// An OpenAI-style assistant message. calls: [{ id, name, arguments }]
export const msg = (content = null, calls = [], extra = {}) => ({
  content,
  ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name ?? 'tavily_search', arguments: c.arguments } })) } : {}),
  ...extra,
});
export const call = (args, id = 'c1', name = 'tavily_search') => ({ id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
export const hit = (n, url = `https://example.com/${n}`, title = `Result ${n}`) => ({ title, url, content: `content ${n}` });

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });

// chat: { [model]: [reply, ...] }, a list used for every model, or a function (messages, body) => reply.
//   A reply is a message object (see msg), a string (the content), or one of the failures above.
// tavily: [response or failure, ...]; once it is empty a one-result response with 1 credit is returned.
// models: the IDs GET /models returns, or a failure; by default the list cannot be read, so the app does not filter by it.
// delay: milliseconds each chat call takes.
export function fakeFetch({ chat = {}, tavily = [], models = httpError(500), delay = 0 } = {}) {
  const queues = Array.isArray(chat) || typeof chat === 'function' ? chat : Object.fromEntries(Object.entries(chat).map(([model, replies]) => [model, typeof replies === 'function' ? replies : [...replies]]));
  const searches = [...tavily];
  const calls = [];

  async function respond(reply, init) {
    if (reply?.__fail === 'http') return new Response('{"error":"secret provider text"}', { status: reply.status });
    if (reply?.__fail === 'network') throw new TypeError('fetch failed: secret network detail');
    if (reply?.__fail === 'hang') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    if (reply?.__fail === 'body') return new Response('not json at all', { status: 200 });
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  async function fetchImpl(url, init = {}) {
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError'); // like a real fetch
    const record = { url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined, startedAt: performance.now() };
    calls.push(record);
    if (url.endsWith('/models')) return respond(Array.isArray(models) ? { data: models.map((id) => ({ id })) } : models, init);
    if (url.endsWith('/chat/completions')) {
      if (delay) await sleep(delay, init.signal);
      const { model, messages } = record.body;
      const queue = typeof queues === 'function' ? queues : Array.isArray(queues) ? queues : queues[model];
      const reply = typeof queue === 'function' ? queue(messages, record.body) : queue.shift();
      record.endedAt = performance.now();
      if (reply?.__fail) return respond(reply, init);
      return respond({ choices: [{ message: typeof reply === 'string' ? { content: reply } : reply }] }, init);
    }
    // Tavily search
    const reply = searches.length ? searches.shift() : { results: [hit(calls.filter((c) => c.url.includes('tavily')).length)], usage: { credits: 1 } };
    record.endedAt = performance.now();
    return respond(reply, init);
  }

  return {
    fetch: fetchImpl,
    calls,
    chatCalls: (model) => calls.filter((c) => c.url.endsWith('/chat/completions') && (!model || c.body.model === model)),
    searchCalls: () => calls.filter((c) => c.url.includes('tavily')),
  };
}

export const planCtx = (network, settings = makeSettings()) => ({
  tokenFactory: createTokenFactory({ apiKey: 'test-nebius-key', fetchImpl: network.fetch }),
  settings,
});
