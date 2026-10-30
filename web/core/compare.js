// Phase 2: runs one query on a model with Tavily Search as a tool and reports every step as an event.
//
// The query goes to the model unchanged, with no system prompt and no hints. The only guidance a model
// gets is the tool schema, which is generated from the spec and is the same for every model.
// Every event carries `run` ('small' or 'large') and goes to an onEvent callback. Types, in the order they happen:
//   run_start   model, max_turns, max_searches
//   waiting     turn                       a model call has started
//   model_turn  turn, content, reasoning (null if none; reasoning_content and reasoning are both read), tool_calls (count)
//   tool_call   step, name, arguments
//   tool_result step, count, results [{title, url, new}], repeat_of (earlier step or null), credits
//   tool_error  step, kind (invalid_arguments | unknown_tool | tavily_error | search_cap | turn_cap), message, counted, repeat_of
//   answer      content                    the model's final reply
//   run_error   kind (timeout | upstream | internal), message
//   run_end     end_reason (answered | turn_cap | timeout | error), turns, searches, failed_searches, invalid_calls,
//               blocked_calls, distinct_urls, repeated_queries, credits, credits_complete, elapsed_seconds
//   done        sent once, after every run has ended

import { describeUpstream, UpstreamError, UpstreamTimeout } from './clients.js';
import { hasOwn, isPlainObject, isPlannerChoosable, pyRepr, truncate } from './pyish.js';
import { validateParameters } from './validator.js';

export const TOOL_NAME = 'tavily_search';
export const DEFAULT_MAX_TURNS = 6;
export const DEFAULT_MAX_SEARCHES = 4;
// Hard ceilings: whatever is asked for, a run can never go past these.
export const HARD_MAX_TURNS = 12;
export const HARD_MAX_SEARCHES = 8;
const RESULT_CONTENT_CHARS = 1500; // per-result snippet length sent back to the model
const NEAR_DUPLICATE_THRESHOLD = 0.8; // word-set overlap at which two queries count as repeats

// The spec notes for these are written for the Phase 1 planner, so the tool gets neutral text instead.
const TOOL_DESCRIPTIONS = {
  query: 'The search query.',
  max_results: 'Maximum number of results to return.',
};

// ---------- the tool the models see ----------

function paramSchema(entry) {
  switch (entry.type) {
    case 'integer':
      return { type: 'integer', minimum: entry.min, maximum: entry.max };
    case 'boolean':
      return { type: 'boolean' };
    case 'enum':
      return { type: 'string', enum: entry.enum };
    case 'boolean_or_enum':
      return { anyOf: [{ type: 'boolean' }, { type: 'string', enum: entry.enum }] };
    case 'string_list':
      return { type: 'array', items: { type: 'string' }, maxItems: entry.max_items };
    default:
      return { type: 'string' }; // string and date (YYYY-MM-DD, described in the notes)
  }
}

export function toolSchema(spec) {
  const properties = {};
  for (const [name, entry] of Object.entries(spec.parameters)) {
    if (!isPlannerChoosable(entry)) continue; // include_usage: the code sets it
    properties[name] = { ...paramSchema(entry), description: hasOwn(TOOL_DESCRIPTIONS, name) ? TOOL_DESCRIPTIONS[name] : entry.notes ?? '' };
  }
  return {
    type: 'function',
    function: {
      name: TOOL_NAME,
      description: 'Search the web. Returns results with title, url and content.',
      parameters: { type: 'object', properties, required: ['query'] },
    },
  };
}

// ---------- counters ----------

export const queryWords = (query) => new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? []);

// The step number of an earlier query this one repeats, or null.
// Two queries repeat when their sets of lowercase words overlap by at least NEAR_DUPLICATE_THRESHOLD
// (shared words divided by all words in either), so word order, case and punctuation do not matter.
export function repeatOf(query, earlier) {
  const words = queryWords(query);
  for (const [step, other] of earlier) {
    const union = new Set([...words, ...other]);
    const shared = [...words].filter((word) => other.has(word)).length;
    if (union.size > 0 && shared / union.size >= NEAR_DUPLICATE_THRESHOLD) return step;
  }
  return null;
}

export const normalizeUrl = (url) => url.split('#')[0].replace(/\/+$/, '');

function newState() {
  return { steps: 0, searches: 0, failedSearches: 0, invalidCalls: 0, blockedCalls: 0, repeats: 0, credits: 0, creditsReported: 0, succeeded: 0, urls: new Set(), queries: [] };
}

// ---------- the run loop ----------

// Token Factory does not document one field for reasoning text; a cookbook issue reports both names.
const reasoningOf = (message) => message.reasoning_content || message.reasoning || null;

const describeTavilyError = (error) =>
  error?.status ? `Tavily error ${error.status}` : `Tavily error (${error instanceof UpstreamTimeout ? 'timeout' : 'no response'})`; // the provider's message is not passed on

function resultsForModel(response) {
  const results = (response.results ?? []).map((r) => {
    const item = { title: r.title ?? null, url: r.url ?? null, content: truncate(r.content || '', RESULT_CONTENT_CHARS) };
    if (r.published_date) item.published_date = r.published_date;
    return item;
  });
  return { results };
}

// Runs one tool call and returns the text sent back to the model. Emits tool_call and tool_result / tool_error.
async function handleCall(call, state, emit, ctx, spec, maxSearches, lastTurn) {
  state.steps += 1;
  const step = state.steps;
  const raw = call.function.arguments;
  let args;
  try {
    args = JSON.parse(raw || '{}');
  } catch {
    args = null;
  }
  emit({ type: 'tool_call', step, name: call.function.name, arguments: isPlainObject(args) ? args : raw });

  const refuse = (kind, message) => {
    emit({ type: 'tool_error', step, kind, message, counted: false });
    return JSON.stringify({ error: message });
  };

  if (lastTurn) {
    // No turn is left to use the answer, so the search is not run and no credits are spent.
    return refuse('turn_cap', 'Not run: the model-turn cap was reached.');
  }
  if (call.function.name !== TOOL_NAME) {
    state.invalidCalls += 1;
    return refuse('unknown_tool', `Unknown tool ${pyRepr(call.function.name)}. The only tool is ${TOOL_NAME}.`);
  }
  if (!isPlainObject(args)) {
    state.invalidCalls += 1;
    return refuse('invalid_arguments', 'The arguments were not a valid JSON object.');
  }

  args = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null)); // models often send null for "unset"
  const errors = validateParameters(args, spec, { planner: false });
  if (errors.length) {
    state.invalidCalls += 1;
    return refuse('invalid_arguments', `Invalid arguments:\n- ${errors.join('\n- ')}`);
  }
  if (state.searches >= maxSearches) {
    state.blockedCalls += 1;
    return refuse('search_cap', `Search limit reached (${maxSearches} searches). Answer with the information you already have.`);
  }

  state.searches += 1;
  const repeated = repeatOf(args.query, state.queries);
  state.queries.push([step, queryWords(args.query)]);
  if (repeated !== null) state.repeats += 1;
  let response;
  try {
    response = await ctx.tavily.search({ ...args, include_usage: true }, { timeoutMs: ctx.timeoutSeconds * 1000, signal: ctx.signal });
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    if (!(error instanceof UpstreamError || error instanceof UpstreamTimeout)) throw error;
    // Any Tavily failure (429, 432-434, 5xx, timeout) goes back to the model as a tool error.
    state.failedSearches += 1;
    const message = describeTavilyError(error);
    emit({ type: 'tool_error', step, kind: 'tavily_error', message, counted: true, repeat_of: repeated });
    return JSON.stringify({ error: message });
  }

  state.succeeded += 1;
  const results = response.results ?? [];
  const seenBefore = new Set(state.urls);
  for (const r of results) if (r.url) state.urls.add(normalizeUrl(r.url));
  const credits = response.usage?.credits ?? null;
  if (credits !== null) {
    state.credits += credits;
    state.creditsReported += 1;
  }
  emit({
    type: 'tool_result',
    step,
    count: results.length,
    results: results.map((r) => ({ title: r.title ?? null, url: r.url ?? null, new: !seenBefore.has(normalizeUrl(r.url || '')) })),
    repeat_of: repeated,
    credits,
  });
  return JSON.stringify(resultsForModel(response));
}

const elapsedSeconds = (startedAt) => Math.round(((performance.now() - startedAt) / 1000) * 10) / 10;

// One run. Reports through emit(event); always ends with a run_end event, unless ctx.signal cancelled it.
// ctx is { tokenFactory, tavily, timeoutSeconds, signal }.
export async function runModel(query, model, ctx, emit, maxTurns, maxSearches, spec) {
  const tools = [toolSchema(spec)];
  const messages = [{ role: 'user', content: query }];
  const state = newState();
  const startedAt = performance.now();
  let turns = 0;
  let endReason = 'turn_cap';
  emit({ type: 'run_start', model, max_turns: maxTurns, max_searches: maxSearches });

  try {
    for (let turn = 1; turn <= maxTurns; turn++) {
      turns = turn;
      emit({ type: 'waiting', turn });
      let response;
      try {
        response = await ctx.tokenFactory.chat({ model, messages, tools }, { timeoutMs: ctx.timeoutSeconds * 1000, signal: ctx.signal });
      } catch (error) {
        if (error instanceof UpstreamTimeout) {
          emit({ type: 'run_error', kind: 'timeout', message: `The model did not answer within ${ctx.timeoutSeconds} seconds. Raise runTimeoutSeconds in web/settings.js to wait longer.` });
          endReason = 'timeout';
          break;
        }
        if (error instanceof UpstreamError) {
          emit({ type: 'run_error', kind: 'upstream', message: `Token Factory request failed (${describeUpstream(error)}).` });
          endReason = 'error';
          break;
        }
        throw error;
      }

      const message = response.choices?.[0]?.message ?? {};
      const toolCalls = message.tool_calls ?? [];
      emit({ type: 'model_turn', turn, content: message.content || null, reasoning: reasoningOf(message), tool_calls: toolCalls.length });

      if (toolCalls.length === 0) {
        emit({ type: 'answer', content: message.content || '' });
        endReason = 'answered';
        break;
      }

      messages.push({
        role: 'assistant',
        content: message.content || '',
        tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments } })),
      });
      for (const call of toolCalls) {
        const content = await handleCall(call, state, emit, ctx, spec, maxSearches, turn === maxTurns);
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content });
      }
    }
  } catch (error) {
    if (ctx.signal?.aborted) return; // the page cancelled the run: stop spending credits and say nothing more
    // An unexpected bug must not leave the page waiting. Only the error's name is logged, never its text.
    console.error(`Compare run on ${model} failed unexpectedly (${error?.name ?? 'Error'}).`);
    emit({ type: 'run_error', kind: 'internal', message: 'The run stopped because of an unexpected error.' });
    endReason = 'error';
  }

  emit({
    type: 'run_end',
    end_reason: endReason,
    turns,
    searches: state.searches,
    failed_searches: state.failedSearches,
    invalid_calls: state.invalidCalls,
    blocked_calls: state.blockedCalls,
    distinct_urls: state.urls.size,
    repeated_queries: state.repeats,
    credits: state.credits,
    credits_complete: state.creditsReported === state.succeeded,
    elapsed_seconds: elapsedSeconds(startedAt),
  });
}

// ---------- parallel runs ----------

// Runs every { role, model } in parallel and reports their events (each tagged with its role),
// ending with a done event. If ctx.signal cancels the runs, no done event is sent.
export async function runAll(runs, query, ctx, maxTurns, maxSearches, onEvent, spec) {
  await Promise.all(runs.map((run) => runModel(query, run.model, ctx, (event) => onEvent({ ...event, run: run.role }), maxTurns, maxSearches, spec)));
  if (!ctx.signal?.aborted) onEvent({ type: 'done' });
}
