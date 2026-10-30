// Optional planner ensemble: two planners in parallel, then an aggregator that merges their plans

import { askForPlan, buildSystemPrompt, PlanError, planTask } from './planner.js';

export const AGGREGATOR_ROLE = `

YOUR ROLE: You are the aggregator. The user message holds the task and one or two candidate plans written by other planners. Return ONE plan in the shape above that makes the most sense for the task.
- Decide per parameter. Keep a value both plans agree on, pick the better-supported value where they differ, and drop a parameter only if the spec rules or the task argue against it. You may add a parameter neither plan proposed if the task clearly needs it.
- Write each row's reason yourself, in one sentence about the task and Tavily. Never mention the candidate plans or the planners in any reason, warning or label.
- Where the plans differ and no spec rule or documented behavior settles the choice, tag the row "judgment". Use "documented" with a source_url only when the spec supports your choice.
- Warnings follow the same rule as above: documented limits only. Take alternatives only for a genuinely ambiguous choice, and make each one a complete, valid parameter set.
`;

// JSON with sorted keys: a comparable form of a value.
function sortedJson(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// A comparable form of a parameter value; list order does not matter.
const canon = (value) => (Array.isArray(value) ? JSON.stringify(value.map(sortedJson).sort()) : sortedJson(value));

function valuesOf(plan) {
  return new Map(plan ? plan.parameters.map((row) => [row.name, row.value]) : []);
}

// Adds `agreement` to each row by comparing it with the planners' plans (computed here, never self-reported by a model).
// agreed: both planners proposed this value. planner_1 / planner_2: only that planner proposed it (the other
// proposed a different value or none). aggregator: neither planner proposed it.
export function markAgreement(finalRows, plan1, plan2) {
  const values1 = valuesOf(plan1);
  const values2 = valuesOf(plan2);
  return finalRows.map((row) => {
    const mine = canon(row.value);
    const in1 = values1.has(row.name) && canon(values1.get(row.name)) === mine;
    const in2 = values2.has(row.name) && canon(values2.get(row.name)) === mine;
    const agreement = in1 && in2 ? 'agreed' : in1 ? 'planner_1' : in2 ? 'planner_2' : 'aggregator';
    return { ...row, agreement };
  });
}

const seconds = (startedAt) => Math.round(((performance.now() - startedAt) / 1000) * 10) / 10;

async function runPlanner(task, ctx, model, spec, stage) {
  const startedAt = performance.now();
  let plan = null;
  let error = null;
  try {
    plan = await planTask(task, ctx, model, spec, stage);
  } catch (caught) {
    if (!(caught instanceof PlanError)) throw caught;
    error = caught;
  }
  return { model, plan, error, elapsed_seconds: seconds(startedAt) };
}

function plannerReport(result) {
  const { error } = result;
  const status = error === null ? 'ok' : error.kind === 'upstream' ? 'failed' : 'invalid';
  return { model: result.model, status, reason: error ? error.message : null, elapsed_seconds: result.elapsed_seconds };
}

export function aggregatorMessage(task, plans) {
  const parts = [`TASK:\n${task}`];
  for (const [label, plan] of plans) parts.push(`${label}:\n${JSON.stringify(plan, null, 1)}`);
  if (plans.length === 1) {
    parts.push('The other planner produced no valid plan, so there is only one candidate. Check it against the task and the spec and return the best final plan.');
  }
  return parts.join('\n\n');
}

// Returns { plan, report }: the final plan with `agreement` on each row, and the ensemble report.
// Throws PlanError when no plan can be produced. ctx is { tokenFactory, settings, signal, onProgress? };
// the stages in the progress events are 'planner1', 'planner2' and 'aggregator'.
export async function ensemblePlan(task, ctx, planner1, planner2, aggregator, spec) {
  const results = await Promise.all([planner1, planner2].map((model, i) => runPlanner(task, ctx, model, spec, `planner${i + 1}`)));
  const planners = results.map(plannerReport);
  const [plan1, plan2] = results.map((result) => result.plan);

  const valid = results.flatMap((result, i) => (result.plan ? [[`PLAN ${i + 1}`, result.plan]] : []));
  if (valid.length === 0) {
    const errors = results.map((result) => result.error);
    throw new PlanError(
      `Both planners failed. ${errors.map((error) => error.message).join(' ')}`,
      errors.some((error) => error.kind === 'invalid_output') ? 'invalid_output' : 'upstream',
      errors.flatMap((error) => error.details),
    );
  }

  const messages = [
    { role: 'system', content: buildSystemPrompt(spec) + AGGREGATOR_ROLE },
    { role: 'user', content: aggregatorMessage(task, valid) },
  ];
  const startedAt = performance.now();
  let final;
  try {
    final = await askForPlan(ctx, aggregator, messages, task, spec, 'aggregator');
  } catch (error) {
    if (!(error instanceof PlanError)) throw error;
    throw new PlanError(`The aggregator step failed. ${error.message}`, error.kind, error.details);
  }
  const aggregatorReport = { model: aggregator, elapsed_seconds: seconds(startedAt) };

  const plan = { ...final, parameters: markAgreement(final.parameters, plan1, plan2) };
  const failed = planners.flatMap((p, i) => (p.status === 'ok' ? [] : [`planner ${i + 1} (${p.model}) ${p.status === 'failed' ? 'failed' : 'returned an invalid plan'}`]));
  const note = failed.length ? `Aggregated from one plan only: ${failed.join('; ')}.` : null;
  return { plan, report: { used: true, planners, aggregator: aggregatorReport, note } };
}
