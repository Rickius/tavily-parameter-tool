// Phase 1 planner: one Token Factory call that turns a task into a validated Tavily parameter set.

import { describeUpstream, UpstreamError, UpstreamTimeout } from './clients.js';
import { hasOwn, isPlannerChoosable } from './pyish.js';
import { validatePlan } from './validator.js';

export const SYSTEM_PROMPT = `You choose Tavily Search API parameters for a task and explain each choice.

You may only use parameters that appear in the SPEC below. Never invent a parameter, never use a value outside the allowed values, and never set a parameter the spec marks as not chosen by the planner. Follow the spec's RULES exactly.

Reply with one JSON object and nothing else, in this shape:
{
  "parameters": [
    {"name": "<spec parameter>", "value": <value>, "reason": "<one plain sentence>",
     "trigger_phrase": "<words copied verbatim from the task that caused this choice, or null>",
     "tag": "documented" | "judgment", "source_url": "<doc URL, required when tag is documented, else null>"}
  ],
  "left_default": [{"name": "<spec parameter>", "reason": "<one-line reason it is left unset>"}],
  "warnings": ["<a documented limit of Tavily for this task>"],
  "alternatives": [
    {"label": "<short name>", "tradeoff": "<one sentence>", "parameters": [<complete alternative parameter rows, same shape as above>]}
  ]
}

How to fill it in:
- "parameters" always includes "query" (a short, search-style query, not a prompt; put details Tavily cannot filter on, such as a city, in the query text) and "max_results" (always set explicitly).
- Tag a row "documented" only when a rule or behavior in the spec supports the choice, and give the matching source_url from the spec. Tag it "judgment" when it is your recommendation and the docs do not dictate it.
- Every reason is one sentence. trigger_phrase must appear word for word in the task; use null when no phrase in the task caused the choice.
- "left_default" lists parameters a reader would plausibly expect to be set but that you left unset (at most six), each with a reason.
- "warnings" must state what Tavily cannot do for the task (for example there is no city-level location targeting). Include only documented limits; never warn about unverified or unclear behavior (put that in a row's reason and its Judgment call tag instead). Use an empty list if there is nothing to warn about.
- "alternatives" is only for a genuinely ambiguous choice between two reasonable configurations. Each alternative is a complete, valid parameter set. Otherwise use an empty list.

SPEC (parameters, then rules):
`;

// The planner could not produce a valid plan. kind is 'invalid_output' or 'upstream'.
export class PlanError extends Error {
  constructor(message, kind, details = []) {
    super(message);
    this.name = 'PlanError';
    this.kind = kind;
    this.details = details;
  }
}

const KEPT_FIELDS = ['type', 'enum', 'default', 'min', 'max', 'max_items', 'max_length', 'required', 'notes', 'source_url'];

export function buildSystemPrompt(spec) {
  const parameters = {};
  for (const [name, entry] of Object.entries(spec.parameters)) {
    if (!isPlannerChoosable(entry)) continue;
    parameters[name] = Object.fromEntries(KEPT_FIELDS.filter((key) => hasOwn(entry, key)).map((key) => [key, entry[key]]));
  }
  const rules = spec.rules.map((rule) => ({ text: rule.text, documented: rule.documented }));
  const notUsed = Object.keys(spec.not_used_in_v1);
  return (
    SYSTEM_PROMPT +
    JSON.stringify({ parameters, not_used_in_v1: notUsed, rules }, null, 1) +
    `\n\nValid source_url values: ${Object.values(spec.sources).join(', ')}`
  );
}

// The model's reply was not JSON. The message is fed back to the model on the retry.
class ReplyError extends Error {}

// Parses the model's reply, tolerating a code fence or a sentence around the JSON object.
export function parseJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) throw new ReplyError('The reply was not a JSON object.');
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch (error) {
      throw new ReplyError(`The reply was not valid JSON: ${error.message}`);
    }
  }
}

// Reports progress to ctx.onProgress, if the caller wants it. A broken progress display must not break the run.
export function progress(ctx, event) {
  try {
    ctx.onProgress?.(event);
  } catch {
    // ignored on purpose
  }
}

// Calls the model, validates its plan, and retries once with the errors fed back. Throws PlanError.
// ctx is { tokenFactory, settings, signal, onProgress? }. With onProgress the answer is streamed, and `stage` names this
// call in the events: stage_start, delta (text as it arrives), retry (the answer was rejected), stage_end.
export async function askForPlan(ctx, model, messages, task, spec, stage = 'planner') {
  const seconds = ctx.settings.plannerTimeoutSeconds;
  const startedAt = performance.now();
  const elapsed = () => Math.round(((performance.now() - startedAt) / 1000) * 10) / 10;
  const onDelta = ctx.onProgress ? ({ kind, text }) => progress(ctx, { type: 'delta', stage, kind, text }) : undefined;
  let errors = [];
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      progress(ctx, { type: 'stage_start', stage, model, attempt: attempt + 1 });
      let response;
      try {
        response = await ctx.tokenFactory.chat({ model, messages }, { timeoutMs: seconds * 1000, signal: ctx.signal, onDelta });
      } catch (error) {
        if (error instanceof UpstreamTimeout) {
          throw new PlanError(
            `The planner model ${model} did not answer within ${seconds} seconds. ` +
              'Reasoning models can be slow; raise plannerTimeoutSeconds in web/settings.js or pick a faster planner model.',
            'upstream',
          );
        }
        if (error instanceof UpstreamError) {
          throw new PlanError(`Token Factory request to ${model} failed (${describeUpstream(error)}).`, 'upstream');
        }
        throw error;
      }
      const reply = response.choices?.[0]?.message?.content || '';

      let plan;
      try {
        plan = parseJson(reply);
        errors = validatePlan(plan, task, spec);
      } catch (error) {
        if (!(error instanceof ReplyError)) throw error;
        errors = [error.message];
      }
      if (errors.length === 0) {
        progress(ctx, { type: 'stage_end', stage, ok: true, elapsed_seconds: elapsed() });
        return plan;
      }

      messages = [
        ...messages,
        { role: 'assistant', content: reply },
        { role: 'user', content: `That output was rejected:\n- ${errors.join('\n- ')}\nReturn the corrected JSON object only.` },
      ];
      if (attempt === 0) progress(ctx, { type: 'retry', stage, errors: [...errors] });
    }
    throw new PlanError(`The output of ${model} failed validation twice.`, 'invalid_output', errors);
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'Stopped' : error instanceof PlanError ? error.message : 'Unexpected error';
    progress(ctx, { type: 'stage_end', stage, ok: false, elapsed_seconds: elapsed(), reason });
    throw error;
  }
}

// Asks the model for a plan and validates it. Retries once, feeding the errors back, then throws PlanError.
export function planTask(task, ctx, model, spec, stage = 'planner') {
  const messages = [
    { role: 'system', content: buildSystemPrompt(spec) },
    { role: 'user', content: `TASK:\n${task}` },
  ];
  return askForPlan(ctx, model, messages, task, spec, stage);
}
