import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, parseJson, planTask } from '../core/planner.js';
import { badBody, clone, fakeFetch, groceryPlan, hang, httpError, makeSettings, networkError, planCtx, spec, TASK } from './support.js';

const MODEL = 'moonshotai/Kimi-K3';
const json = (value) => JSON.stringify(value);

async function planError(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected a PlanError');
}

test('returns a valid plan on the first try', async () => {
  const network = fakeFetch({ chat: { [MODEL]: [json(groceryPlan())] } });
  assert.deepEqual(await planTask(TASK, planCtx(network), MODEL, spec), groceryPlan());
  assert.equal(network.chatCalls().length, 1);
  assert.equal(network.chatCalls()[0].body.model, MODEL);
});

test('sends the spec prompt and the task, and nothing else in the body', async () => {
  const network = fakeFetch({ chat: { [MODEL]: [json(groceryPlan())] } });
  await planTask(TASK, planCtx(network), MODEL, spec);
  const body = network.chatCalls()[0].body;
  assert.deepEqual(Object.keys(body).sort(), ['messages', 'model']);
  assert.deepEqual(body.messages, [{ role: 'system', content: buildSystemPrompt(spec) }, { role: 'user', content: `TASK:\n${TASK}` }]);
});

test('retries once with the errors, then succeeds', async () => {
  const bad = groceryPlan();
  bad.parameters.push({ name: 'freshness', value: 'week', reason: 'x', trigger_phrase: null, tag: 'judgment', source_url: null });
  const network = fakeFetch({ chat: { [MODEL]: [json(bad), json(groceryPlan())] } });

  assert.deepEqual(await planTask(TASK, planCtx(network), MODEL, spec), groceryPlan());

  assert.equal(network.chatCalls().length, 2);
  const feedback = network.chatCalls()[1].body.messages.at(-1).content;
  assert.ok(feedback.includes('freshness') && feedback.includes('rejected'));
});

test('gives up after one retry', async () => {
  const bad = groceryPlan();
  bad.parameters.at(-1).value = 99;
  const network = fakeFetch({ chat: { [MODEL]: [json(bad), json(bad), json(bad)] } });

  const error = await planError(planTask(TASK, planCtx(network), MODEL, spec));

  assert.equal(error.kind, 'invalid_output');
  assert.equal(network.chatCalls().length, 2);
  assert.ok(error.details.some((d) => d.includes('max_results')));
});

test('a non-JSON reply is retried', async () => {
  const network = fakeFetch({ chat: { [MODEL]: ['Sure! Here you go.', json(groceryPlan())] } });
  assert.deepEqual(await planTask(TASK, planCtx(network), MODEL, spec), groceryPlan());
  assert.match(network.chatCalls()[1].body.messages.at(-1).content, /not a JSON object/);
});

test('an empty reply is retried', async () => {
  const network = fakeFetch({ chat: { [MODEL]: [{ content: null }, json(groceryPlan())] } });
  assert.deepEqual(await planTask(TASK, planCtx(network), MODEL, spec), groceryPlan());
});

test('an upstream failure is not retried and names only the status', async () => {
  for (const [failure, expected] of [[httpError(500), /HTTP 500/], [networkError(), /no response/], [badBody(), /no response/]]) {
    const network = fakeFetch({ chat: { [MODEL]: [failure] } });
    const error = await planError(planTask(TASK, planCtx(network), MODEL, spec));
    assert.equal(error.kind, 'upstream');
    assert.match(error.message, expected);
    assert.doesNotMatch(error.message, /secret/); // neither the provider's text nor a network detail is passed on
    assert.equal(network.chatCalls().length, 1);
  }
});

test('a timeout has a clear message and uses the configured limit', async () => {
  const network = fakeFetch({ chat: { [MODEL]: [hang()] } });
  const error = await planError(planTask(TASK, planCtx(network, makeSettings({ plannerTimeoutSeconds: 0.05 })), MODEL, spec));
  assert.equal(error.kind, 'upstream');
  assert.match(error.message, /did not answer within 0\.05 seconds/);
  assert.match(error.message, /plannerTimeoutSeconds/);
});

test('the API key goes only in the Authorization header', async () => {
  const network = fakeFetch({ chat: { [MODEL]: [json(groceryPlan())] } });
  await planTask(TASK, planCtx(network), MODEL, spec);
  const [request] = network.chatCalls();
  assert.equal(request.headers.Authorization, 'Bearer test-nebius-key');
  assert.ok(!JSON.stringify(request.body).includes('test-nebius-key'));
  assert.equal(request.url, 'https://api.tokenfactory.nebius.com/v1/chat/completions');
});

test('parseJson handles fences and chatter', () => {
  assert.deepEqual(parseJson('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('Here is the plan: {"a": 1} Hope that helps.'), { a: 1 });
  assert.throws(() => parseJson('no json here'));
});

test('the prompt carries the spec and the instructions', () => {
  const prompt = buildSystemPrompt(spec);
  assert.ok(prompt.includes('max_results') && prompt.includes('always set explicitly'));
  assert.ok(prompt.includes('Never invent a parameter'));
  assert.ok(prompt.includes('"chunks_per_source"'));
  assert.ok(!prompt.split('SPEC')[1].split('not_used_in_v1')[0].includes('"include_usage"')); // the backend-only parameter is hidden
  assert.ok(prompt.includes(spec.sources.api_reference));
});

test('the spec object is not changed by building the prompt', () => {
  const before = clone(spec);
  buildSystemPrompt(spec);
  assert.deepEqual(spec, before);
});
