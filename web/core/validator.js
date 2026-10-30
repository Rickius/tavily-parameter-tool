// Validates Tavily Search parameter sets and planner output against the spec.

import { codePointLength, hasOwn, isPlainObject, isPlannerChoosable, pick, pyRepr, pyStr } from './pyish.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ROW_TAGS = ['documented', 'judgment'];
const MAX_REASON_CHARS = 300;

const choices = (values) => values.map(String).join(', ');
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

function isRealDate(year, month, day) {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= daysInMonth;
}

// Checks one value against its spec entry: type, allowed values, ranges.
function checkValue(name, value, entry) {
  switch (entry.type) {
    case 'string': {
      if (!isNonEmptyString(value)) return [`${name}: must be a non-empty string.`];
      const length = codePointLength(value);
      if (entry.max_length !== undefined && length > entry.max_length) {
        return [`${name}: is ${length} characters; the limit is ${entry.max_length}.`];
      }
      return [];
    }
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) return [`${name}: must be an integer, got ${pyRepr(value)}.`];
      if (!(entry.min <= value && value <= entry.max)) {
        return [`${name}: ${value} is outside the allowed range ${entry.min} to ${entry.max}.`];
      }
      return [];
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${name}: must be true or false, got ${pyRepr(value)}.`];
    case 'enum':
      return typeof value === 'string' && entry.enum.includes(value)
        ? []
        : [`${name}: ${pyRepr(value)} is not allowed. Allowed values: ${choices(entry.enum)}.`];
    case 'boolean_or_enum':
      return typeof value === 'boolean' || entry.enum.includes(value)
        ? []
        : [`${name}: ${pyRepr(value)} is not allowed. Use true, false, or one of: ${choices(entry.enum)}.`];
    case 'string_list':
      if (!Array.isArray(value) || !value.every(isNonEmptyString)) return [`${name}: must be a list of non-empty strings.`];
      if (value.length === 0) return [`${name}: is an empty list; leave the parameter out instead.`];
      if (value.length > entry.max_items) return [`${name}: has ${value.length} entries; the limit is ${entry.max_items}.`];
      return [];
    case 'date': {
      if (typeof value !== 'string' || !DATE_RE.test(value)) return [`${name}: ${pyRepr(value)} must be a date in YYYY-MM-DD format.`];
      const [year, month, day] = value.split('-').map(Number);
      return isRealDate(year, month, day) ? [] : [`${name}: ${pyRepr(value)} is not a real calendar date.`];
    }
    default:
      return [];
  }
}

// Cross-parameter rules.
function checkRules(params) {
  const errors = [];
  if (hasOwn(params, 'include_domains_mode') && !hasOwn(params, 'include_domains')) {
    errors.push('include_domains_mode: requires include_domains (Tavily returns a 400 error otherwise).');
  }
  if (params.filter_by_language === true && !hasOwn(params, 'language')) {
    errors.push('filter_by_language: requires language (Tavily returns a 400 error otherwise).');
  }
  if (hasOwn(params, 'country') && hasOwn(params, 'topic') && params.topic !== 'general') {
    errors.push(`country: is available only when topic is general, not ${pyRepr(params.topic)}.`);
  }
  if (hasOwn(params, 'chunks_per_source') && params.search_depth === 'ultra-fast') {
    errors.push('chunks_per_source: is not available for search_depth ultra-fast (it returns one summary per URL).');
  }
  return errors;
}

// Returns a list of error strings; empty means the parameter set is valid.
// planner=false is for a model calling the Phase 2 tool: only query must be set, because
// "always set max_results explicitly" is a rule for the planner, not for tool callers.
export function validateParameters(params, spec, { planner = true } = {}) {
  const entries = spec.parameters;
  const errors = [];

  for (const [name, value] of Object.entries(params)) {
    if (hasOwn(spec.not_used_in_v1, name)) errors.push(`${name}: not used in v1 (${spec.not_used_in_v1[name]})`);
    else if (!hasOwn(entries, name)) errors.push(`${name}: is not a parameter in the spec. Only choose parameters listed in the spec.`);
    else if (!isPlannerChoosable(entries[name])) errors.push(`${name}: is set by the backend, not chosen by the planner.`);
    else errors.push(...checkValue(name, value, entries[name]));
  }

  for (const [name, entry] of Object.entries(entries)) {
    if (entry.required && !hasOwn(params, name) && (planner || name === 'query')) {
      errors.push(`${name}: is required and must be set explicitly.`);
    }
  }

  errors.push(...checkRules(params));
  return errors;
}

// Checks a list of parameter rows; returns { errors, params } where params holds the rows that parse.
function validateRows(rows, task, spec, where) {
  const params = Object.create(null);
  if (!Array.isArray(rows) || rows.length === 0) return { errors: [`${where}: must be a non-empty list of rows.`], params };

  const errors = [];
  const allowedUrls = new Set(Object.values(spec.sources));
  rows.forEach((row, i) => {
    if (!isPlainObject(row)) {
      errors.push(`${where}[${i}]: must be an object.`);
      return;
    }
    const name = pick(row, 'name');
    const label = `${where}[${i}] (${pyStr(name)})`;
    if (typeof name !== 'string' || !hasOwn(row, 'value')) {
      errors.push(`${label}: needs 'name' and 'value'.`);
      return;
    }
    if (hasOwn(params, name)) errors.push(`${label}: parameter listed twice.`);
    params[name] = row.value;

    const reason = pick(row, 'reason');
    if (!isNonEmptyString(reason)) errors.push(`${label}: needs a one-sentence 'reason'.`);
    else if (codePointLength(reason) > MAX_REASON_CHARS) {
      errors.push(`${label}: reason is ${codePointLength(reason)} characters; keep it to one short sentence.`);
    }

    const phrase = pick(row, 'trigger_phrase');
    if (phrase !== null && phrase !== '' && (typeof phrase !== 'string' || !task.toLowerCase().includes(phrase.toLowerCase()))) {
      errors.push(`${label}: trigger_phrase ${pyRepr(phrase)} must be copied verbatim from the task text, or be null.`);
    }

    const tag = pick(row, 'tag');
    if (!ROW_TAGS.includes(tag)) errors.push(`${label}: tag must be one of ${choices(ROW_TAGS)}, got ${pyRepr(tag)}.`);
    else if (tag === 'documented') {
      const url = pick(row, 'source_url');
      if (typeof url !== 'string' || !allowedUrls.has(url.split('#')[0])) {
        errors.push(`${label}: documented rows need a source_url that is one of: ${choices([...allowedUrls].sort())}.`);
      }
    }
  });

  errors.push(...validateParameters(params, spec));
  return { errors, params };
}

// Validates the planner's JSON output. Returns a list of error strings; empty means valid.
export function validatePlan(plan, task, spec) {
  if (!isPlainObject(plan)) return ['The output must be a JSON object.'];

  const { errors, params } = validateRows(pick(plan, 'parameters'), task, spec, 'parameters');

  const leftDefault = pick(plan, 'left_default');
  if (!Array.isArray(leftDefault)) errors.push('left_default: must be a list (it may be empty).');
  else {
    leftDefault.forEach((item, i) => {
      const label = `left_default[${i}]`;
      if (!isPlainObject(item) || typeof item.name !== 'string' || !hasOwn(spec.parameters, item.name)) {
        errors.push(`${label}: 'name' must be a parameter in the spec.`);
        return;
      }
      if (hasOwn(params, item.name)) errors.push(`${label}: ${item.name} is set in parameters, so it cannot also be left at default.`);
      if (!isNonEmptyString(item.reason)) errors.push(`${label}: needs a one-line 'reason'.`);
    });
  }

  const warnings = pick(plan, 'warnings');
  if (!Array.isArray(warnings) || !warnings.every(isNonEmptyString)) {
    errors.push('warnings: must be a list of non-empty strings (it may be empty).');
  }

  const alternatives = pick(plan, 'alternatives');
  if (!Array.isArray(alternatives)) errors.push('alternatives: must be a list (it may be empty).');
  else {
    alternatives.forEach((alt, i) => {
      const label = `alternatives[${i}]`;
      if (!isPlainObject(alt)) {
        errors.push(`${label}: must be an object.`);
        return;
      }
      for (const key of ['label', 'tradeoff']) {
        if (!isNonEmptyString(alt[key])) errors.push(`${label}: needs a non-empty '${key}'.`);
      }
      errors.push(...validateRows(pick(alt, 'parameters'), task, spec, `${label}.parameters`).errors);
    });
  }

  return errors;
}
