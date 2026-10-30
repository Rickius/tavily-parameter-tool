// The browser-side app, as plain async functions. Failures throw an AppError with a `code`, a `message` and `details`.
//
//   const app = createApp({ settings, keys: { nebiusApiKey, tavilyApiKey } });
//   await app.getConfig()                 -> { ensemble: {available, default, reason, planners, aggregator}, compare_enabled, max_task_chars, ... }
//   await app.plan(task, { ensemble, signal, onProgress })    -> { task, model, parameters, left_default, warnings, alternatives, request_body, python_snippet, ensemble? }
//   await app.listModels()                -> { models: [{id, size, default}], limits }
//   await app.compare({ query, confirm }, onEvent)   -> the events described in compare.js, via onEvent
//
// A failure throws an AppError with .code, .message and .details, with one of these codes: bad_request, invalid_plan, upstream_error, not_configured, confirmation_required, unknown_model, compare_disabled.

import { createTavily, createTokenFactory, describeUpstream, UpstreamTimeout } from './clients.js';
import { HARD_MAX_SEARCHES, HARD_MAX_TURNS, runAll } from './compare.js';
import { ensemblePlan } from './ensemble.js';
import { PlanError, planTask } from './planner.js';
import { codePointLength, isPlainObject } from './pyish.js';
import { pythonSnippet, requestBody } from './render.js';

export class AppError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

const ROLES = ['small', 'large'];
const MODEL_LIST_TIMEOUT_MS = 30_000;

async function defaultLoadSpec() {
  const response = await fetch(new URL('../spec.json', import.meta.url));
  if (!response.ok) throw new Error(`Could not load spec.json (HTTP ${response.status}).`);
  return response.json();
}

// Model IDs in `ids` that look like `model`, best first (a longest-common-subsequence ratio).
function closeMatches(model, ids, count = 3, cutoff = 0.6) {
  const ratio = (a, b) => {
    const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        table[i][j] = a[i - 1] === b[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1]);
      }
    }
    return (2 * table[a.length][b.length]) / (a.length + b.length);
  };
  return ids
    .map((id) => [ratio(model, id), id])
    .filter(([score]) => score >= cutoff)
    .sort((x, y) => y[0] - x[0])
    .slice(0, count)
    .map(([, id]) => id);
}

export function createApp({ settings, keys = {}, fetchImpl = globalThis.fetch, spec = null, loadSpec = defaultLoadSpec }) {
  const allowlistIds = new Set(settings.phase2Allowlist.map((m) => m.id));
  for (const role of ROLES) {
    if (!allowlistIds.has(settings.models[role])) {
      throw new AppError('not_configured', `models.${role} (${settings.models[role]}) is not in phase2Allowlist in web/settings.js. Add it there to offer it in Compare.`);
    }
  }
  const limits = {
    default_turns: Math.min(settings.defaultTurns, HARD_MAX_TURNS),
    max_turns: Math.min(settings.maxTurns, HARD_MAX_TURNS),
    default_searches: Math.min(settings.defaultSearches, HARD_MAX_SEARCHES),
    max_searches: Math.min(settings.maxSearches, HARD_MAX_SEARCHES),
  };

  const tokenFactory = keys.nebiusApiKey ? createTokenFactory({ apiKey: keys.nebiusApiKey, fetchImpl }) : null;
  const tavily = keys.tavilyApiKey ? createTavily({ apiKey: keys.tavilyApiKey, fetchImpl }) : null;

  let specPromise = spec ? Promise.resolve(spec) : null;
  const getSpec = () => {
    specPromise ??= loadSpec().catch((error) => {
      specPromise = null;
      throw error;
    });
    return specPromise;
  };

  // ---------- the live model list (checked at startup so a retired model fails clearly) ----------

  let available = null; // live model IDs; null until the check has run
  let checked = null;

  function requireTokenFactory() {
    if (!tokenFactory) throw new AppError('not_configured', 'No Token Factory API key is configured.');
  }

  // Fetches the live model list. Resolves { available, problems }: problems names each configured model that is not live.
  async function checkModels({ signal } = {}) {
    requireTokenFactory();
    let ids;
    try {
      ids = await tokenFactory.listModels({ timeoutMs: MODEL_LIST_TIMEOUT_MS, signal });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      if (error.status === 401 || error.status === 403) throw new AppError('upstream_error', `Token Factory rejected the API key (HTTP ${error.status}). Check the key.`);
      if (error instanceof UpstreamTimeout) throw new AppError('upstream_error', 'Token Factory did not answer the model list request in time.');
      throw new AppError('upstream_error', `Could not read the Token Factory model list (${describeUpstream(error)}).`);
    }
    available = ids;
    const problems = [];
    for (const role of ['planner', ...ROLES]) {
      const model = settings.models[role];
      if (ids.includes(model)) continue;
      const close = closeMatches(model, ids);
      const hint = close.length ? ` Similar models: ${close.join(', ')}.` : '';
      problems.push(`The ${role} model '${model}' is not in the Token Factory model list; it may have been retired or renamed.${hint}`);
    }
    return { available: ids, problems };
  }

  // Runs the check once, in the background of the first call that needs it. A failure leaves the list unknown.
  function ensureChecked() {
    if (!tokenFactory) return Promise.resolve();
    checked ??= checkModels().catch(() => null);
    return checked;
  }

  const offeredModels = () => settings.phase2Allowlist.filter((m) => available === null || available.includes(m.id));

  function ensembleStatus() {
    if (!tokenFactory) return { available: false, default: false, reason: 'No Token Factory API key is configured.', planners: [], aggregator: null };
    const { planner, planner2, aggregator } = settings.models;
    const base = { default: settings.ensembleDefault, planners: [planner, planner2].filter(Boolean), aggregator: aggregator || null };
    const unset = [['planner2', planner2], ['aggregator', aggregator]].filter(([, model]) => !model).map(([name]) => `models.${name}`);
    if (unset.length) return { ...base, available: false, reason: `Set ${unset.join(' and ')} in web/settings.js to enable the ensemble.` };
    if (available !== null) {
      const missing = [planner2, aggregator].filter((model) => !available.includes(model));
      if (missing.length) return { ...base, available: false, reason: `Not in the live Token Factory model list: ${missing.join(', ')}.` };
    }
    return { ...base, available: true, reason: null };
  }

  function checkText(text, what) {
    if (typeof text !== 'string' || text.length === 0) {
      throw new AppError('bad_request', 'The request was rejected; see details for the fields to fix.', [`${what}: must be a non-empty string`]);
    }
    const length = codePointLength(text);
    if (length > settings.maxTaskChars) {
      throw new AppError('bad_request', `The ${what} is limited to ${settings.maxTaskChars} characters; yours has ${length}.`);
    }
  }

  const withPreview = (rows) => {
    const body = requestBody(rows);
    return { request_body: body, python_snippet: pythonSnippet(body) };
  };

  // ---------- the operations ----------

  async function getConfig() {
    await ensureChecked();
    return {
      ensemble: ensembleStatus(),
      access_required: false,
      compare_enabled: settings.compareEnabled,
      max_task_chars: settings.maxTaskChars,
    };
  }

  async function plan(task, { ensemble, signal, onProgress } = {}) {
    checkText(task, 'task');
    requireTokenFactory();
    const theSpec = await getSpec();
    await ensureChecked();
    const status = ensembleStatus();
    const wanted = ensemble ?? settings.ensembleDefault;
    const useEnsemble = Boolean(wanted && status.available);
    const ctx = { tokenFactory, settings, signal, onProgress };
    const { planner, planner2, aggregator } = settings.models;

    let result;
    let ensembleReport = null;
    try {
      if (useEnsemble) {
        ({ plan: result, report: ensembleReport } = await ensemblePlan(task, ctx, planner, planner2, aggregator, theSpec));
      } else {
        result = await planTask(task, ctx, planner, theSpec);
        if (wanted) ensembleReport = { used: false, note: `Planner ensemble not used. ${status.reason}` }; // asked for, but not available
      }
    } catch (error) {
      if (!(error instanceof PlanError)) throw error;
      throw error.kind === 'upstream' ? new AppError('upstream_error', error.message) : new AppError('invalid_plan', error.message, error.details);
    }

    const response = {
      task,
      model: planner,
      parameters: result.parameters,
      left_default: result.left_default.map((item) => ({ ...item, tag: 'default' })),
      warnings: result.warnings,
      alternatives: result.alternatives.map((alt) => ({ ...alt, ...withPreview(alt.parameters) })),
      ...withPreview(result.parameters),
    };
    if (ensembleReport !== null) response.ensemble = ensembleReport;
    return response;
  }

  async function listModels() {
    if (!settings.compareEnabled) return { models: [], limits };
    await ensureChecked();
    const defaults = { small: settings.models.small, large: settings.models.large };
    return { models: offeredModels().map((m) => ({ ...m, default: defaults[m.size] === m.id })), limits };
  }

  async function compare(options = {}, onEvent = () => {}) {
    const { query, confirm = false, roles = ROLES, models = {}, signal } = options;
    const maxTurns = options.maxTurns ?? limits.default_turns;
    const maxSearches = options.maxSearches ?? limits.default_searches;

    if (!settings.compareEnabled) throw new AppError('compare_disabled', 'Compare models is switched off.');
    checkText(query, 'query');
    const details = [];
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > limits.max_turns) details.push(`maxTurns: must be a whole number from 1 to ${limits.max_turns}`);
    if (!Number.isInteger(maxSearches) || maxSearches < 1 || maxSearches > limits.max_searches) details.push(`maxSearches: must be a whole number from 1 to ${limits.max_searches}`);
    if (!Array.isArray(roles) || roles.length < 1 || roles.length > 2 || !roles.every((role) => ROLES.includes(role))) details.push("roles: must be 'small', 'large' or both");
    if (!isPlainObject(models) || !Object.entries(models).every(([role, id]) => ROLES.includes(role) && typeof id === 'string' && id.length <= 200)) details.push('models: must map small or large to a model ID');
    if (details.length) throw new AppError('bad_request', 'The request was rejected; see details for the fields to fix.', details);

    if (!tokenFactory || !tavily) throw new AppError('not_configured', 'Compare models needs both a Token Factory API key and a Tavily API key.');
    if (!confirm) {
      throw new AppError(
        'confirmation_required',
        `This run uses Tavily credits: up to ${maxSearches} searches per model, at 1 credit each for basic, fast and ultra-fast and 2 for advanced. Pass confirm: true to run it.`,
      );
    }

    await ensureChecked();
    const offered = new Map(offeredModels().map((m) => [m.id, m]));
    const runs = [];
    for (const role of new Set(roles)) {
      const model = models[role] || settings.models[role];
      if (!offered.has(model) || offered.get(model).size !== role) {
        throw new AppError('unknown_model', `'${model}' is not an available ${role} model. listModels() lists the choices.`);
      }
      runs.push({ role, model });
    }

    const theSpec = await getSpec();
    const ctx = { tokenFactory, tavily, timeoutSeconds: settings.runTimeoutSeconds, signal };
    await runAll(runs, query, ctx, maxTurns, maxSearches, onEvent, theSpec);
  }

  return { getConfig, plan, listModels, compare, checkModels };
}
