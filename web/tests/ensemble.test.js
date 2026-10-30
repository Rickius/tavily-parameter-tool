import test from 'node:test';
import assert from 'node:assert/strict';
import { ensemblePlan, markAgreement } from '../core/ensemble.js';
import { PlanError } from '../core/planner.js';
import { clone, fakeFetch, groceryPlan, httpError, planCtx, REF, row, spec, TASK } from './support.js';

const [P1, P2, AGG] = ['planner-one', 'planner-two', 'aggregator-model'];
const json = (value) => JSON.stringify(value);
const run = (network) => ensemblePlan(TASK, planCtx(network), P1, P2, AGG, spec);

// A second planner's plan that differs from groceryPlan on topic, domain order, max_results and the query.
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

// What the aggregator returns: topic from planner one, max_results from planner two, a query neither wrote.
function merged() {
  const final = groceryPlan();
  final.parameters[0].value = "this week's grocery deals at local supermarkets";
  final.parameters[4].value = 5;
  return final;
}

const byName = (plan) => Object.fromEntries(plan.parameters.map((r) => [r.name, r]));
const sent = (network, model) => network.chatCalls(model)[0].body.messages.at(-1).content;

test('both planners agree', async () => {
  const network = fakeFetch({ chat: { [P1]: [json(groceryPlan())], [P2]: [json(groceryPlan())], [AGG]: [json(groceryPlan())] } });
  const { plan, report } = await run(network);

  assert.deepEqual(new Set(plan.parameters.map((r) => r.agreement)), new Set(['agreed']));
  assert.deepEqual(report.planners.map((p) => p.status), ['ok', 'ok']);
  assert.equal(report.used, true);
  assert.equal(report.note, null);
  assert.equal(report.aggregator.model, AGG);
  assert.ok(report.aggregator.elapsed_seconds >= 0 && report.planners.every((p) => p.elapsed_seconds >= 0));
  const input = sent(network, AGG);
  assert.ok(input.includes('PLAN 1') && input.includes('PLAN 2') && input.includes(TASK));
});

test('disagreement is marked in code, not by the model', async () => {
  const network = fakeFetch({ chat: { [P1]: [json(groceryPlan())], [P2]: [json(planB())], [AGG]: [json(merged())] } });
  const { plan } = await run(network);

  assert.deepEqual(Object.fromEntries(Object.entries(byName(plan)).map(([name, r]) => [name, r.agreement])), {
    query: 'aggregator', // neither planner wrote it
    topic: 'planner_1', // the aggregator sided with planner one
    time_range: 'agreed',
    include_domains: 'agreed', // the same domains in a different order
    max_results: 'planner_2',
  });
  assert.equal(byName(plan).time_range.tag, 'documented'); // tags the model gave are kept
});

test('the planners run concurrently and the aggregator waits for both', async () => {
  const network = fakeFetch({ delay: 80, chat: { [P1]: [json(groceryPlan())], [P2]: [json(groceryPlan())], [AGG]: [json(groceryPlan())] } });
  await run(network);

  const [first] = network.chatCalls(P1);
  const [second] = network.chatCalls(P2);
  assert.ok(first.startedAt < second.endedAt && second.startedAt < first.endedAt, 'the two planner calls overlap');
  assert.ok(network.chatCalls(AGG)[0].startedAt >= Math.max(first.endedAt, second.endedAt));
});

for (const failing of [P1, P2]) {
  test(`one planner fails and the aggregator uses the other (${failing})`, async () => {
    const chat = { [P1]: [json(groceryPlan())], [P2]: [json(groceryPlan())], [AGG]: [json(groceryPlan())] };
    chat[failing] = [httpError(503)];
    const network = fakeFetch({ chat });

    const { plan, report } = await run(network);

    const survivor = failing === P1 ? 'planner_2' : 'planner_1';
    assert.deepEqual(new Set(plan.parameters.map((r) => r.agreement)), new Set([survivor]));
    assert.deepEqual(report.planners.map((p) => p.status), failing === P1 ? ['failed', 'ok'] : ['ok', 'failed']);
    assert.ok(report.note.includes('one plan only') && report.note.includes(failing));
    const input = sent(network, AGG);
    assert.equal(input.includes('PLAN 2'), failing === P1);
    assert.equal(input.includes('PLAN 1'), failing === P2);
  });
}

test('one planner invalid and the aggregator uses the other', async () => {
  const bad = groceryPlan();
  bad.parameters.at(-1).value = 99; // out of range, twice
  const network = fakeFetch({ chat: { [P1]: [json(bad), json(bad)], [P2]: [json(groceryPlan())], [AGG]: [json(groceryPlan())] } });

  const { plan, report } = await run(network);

  assert.deepEqual(report.planners.map((p) => p.status), ['invalid', 'ok']);
  assert.ok(report.note.includes('invalid plan'));
  assert.deepEqual(new Set(plan.parameters.map((r) => r.agreement)), new Set(['planner_2']));
});

test('both planners fail with an upstream error', async () => {
  const network = fakeFetch({ chat: { [P1]: [httpError(500)], [P2]: [httpError(500)], [AGG]: [] } });
  await assert.rejects(run(network), (error) => error instanceof PlanError && error.kind === 'upstream');
  assert.equal(network.chatCalls(AGG).length, 0);
});

test('both planners invalid is the invalid_output error', async () => {
  const bad = groceryPlan();
  bad.parameters.at(-1).value = 99;
  const network = fakeFetch({ chat: { [P1]: [json(bad), json(bad)], [P2]: [json(bad), json(bad)], [AGG]: [] } });
  await assert.rejects(run(network), (error) => error.kind === 'invalid_output' && error.details.some((d) => d.includes('max_results')));
});

test('an invalid aggregator answer is retried', async () => {
  const bad = groceryPlan();
  bad.parameters.push(row('freshness', 'week'));
  const network = fakeFetch({ chat: { [P1]: [json(groceryPlan())], [P2]: [json(groceryPlan())], [AGG]: [json(bad), json(groceryPlan())] } });

  const { plan } = await run(network);

  assert.equal(network.chatCalls(AGG).length, 2);
  assert.ok(network.chatCalls(AGG)[1].body.messages.at(-1).content.includes('freshness'));
  assert.deepEqual(new Set(plan.parameters.map((r) => r.agreement)), new Set(['agreed']));
});

test('an aggregator that is invalid twice fails', async () => {
  const bad = groceryPlan();
  bad.parameters.at(-1).value = 99;
  const network = fakeFetch({ chat: { [P1]: [json(groceryPlan())], [P2]: [json(groceryPlan())], [AGG]: [json(bad), json(bad)] } });

  await assert.rejects(run(network), (error) => error.kind === 'invalid_output' && error.message.includes('aggregator step failed'));
  assert.equal(network.chatCalls(AGG).length, 2);
});

test('the aggregator prompt adds its role to the planner prompt', async () => {
  const network = fakeFetch({ chat: { [P1]: [json(groceryPlan())], [P2]: [json(groceryPlan())], [AGG]: [json(groceryPlan())] } });
  await run(network);
  const system = network.chatCalls(AGG)[0].body.messages[0].content;
  assert.ok(system.includes('YOUR ROLE: You are the aggregator'));
  assert.ok(!network.chatCalls(P1)[0].body.messages[0].content.includes('YOUR ROLE'));
});

test('markAgreement without a second plan', () => {
  assert.deepEqual(new Set(markAgreement(groceryPlan().parameters, groceryPlan(), null).map((r) => r.agreement)), new Set(['planner_1']));
});

test('markAgreement ignores list order and object key order, and does not change its input', () => {
  const rows = [row('include_domains', ['b.com', 'a.com'])];
  const before = clone(rows);
  const result = markAgreement(rows, { parameters: [row('include_domains', ['a.com', 'b.com'])] }, null);
  assert.equal(result[0].agreement, 'planner_1');
  assert.deepEqual(rows, before);
});
