import { createApp } from './core/index.js';
import { settings } from './settings.js';
import { createLivePanel, renderOutputDisclosure } from './live.js';
import { renderMarkdown } from './markdown.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

// Model-produced text only ever goes in through textContent / text nodes, never innerHTML.
// ICON values are constants written here, not model output.
const ICON = {
  doc: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 2.5H2.5v7h7v-2M7 2.5h2.5V5M9.5 2.5 5.5 6.5"/></svg>',
  judgment: '<svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M6 1 11 6 6 11 1 6z"/></svg>',
  default: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="6" cy="6" r="3.6"/></svg>',
  chevron: '<svg class="chev" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 2.5 9.5 7 5 11.5"/></svg>',
  copy: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7.5" rx="1.4"/><path d="M9.5 4.5V3a1.2 1.2 0 0 0-1.2-1.2H3.2A1.2 1.2 0 0 0 2 3v6.3a1.2 1.2 0 0 0 1.2 1.2h1.3"/></svg>',
  theme: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11a5.5 5.5 0 0 0 0-11z" fill="currentColor"/></svg>',
};

const ERROR_TITLES = {
  bad_request: 'The request was rejected',
  invalid_plan: "The planner's answer failed validation",
  upstream_error: 'A model provider could not be reached',
  not_configured: 'An API key is missing',
  compare_disabled: 'Compare models is switched off',
  confirmation_required: 'Confirmation is required',
  unknown_model: 'That model is not available',
  client_error: 'Something went wrong in the page',
};

// result: the last /api/plan response. configs: the recommended plan, then each alternative.
// rawOutput: what the models wrote during the last run, for the "Model output" disclosure.
const state = { result: null, configs: [], active: 0, mode: 'json', phrases: null, rawOutput: null };

const taskBox = $('#taskbox');
const taskInput = $('#taskInput');
const taskView = $('#taskView');
const copyButton = $('#copy');
const ensembleBox = $('#ensemble');

// ---------- small DOM helpers ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Reasons and warnings may contain `code` spans and [Inference]; build them as nodes.
function richText(parent, text) {
  for (const part of text.split(/(`[^`]+`|\[Inference\])/)) {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) parent.append(el('code', '', part.slice(1, -1)));
    else if (part === '[Inference]') parent.append(el('span', 'inf', part));
    else parent.append(part);
  }
  return parent;
}

// ---------- API keys and the core ----------

// config.js is written at build time. A key in it is shared by everyone who can load this page.
const builtIn = {
  nebiusApiKey: String(window.APP_CONFIG?.nebiusApiKey ?? ''),
  tavilyApiKey: String(window.APP_CONFIG?.tavilyApiKey ?? ''),
};
const KEYS_STORE = 'apiKeys'; // sessionStorage only: gone when the tab closes
const serverConfig = { compare_enabled: settings.compareEnabled, max_task_chars: settings.maxTaskChars };

function pastedKeys() {
  try {
    return JSON.parse(sessionStorage.getItem(KEYS_STORE)) ?? {};
  } catch {
    return {};
  }
}

function savePastedKey(name, value) {
  const keys = pastedKeys();
  if (value) keys[name] = value;
  else delete keys[name];
  sessionStorage.setItem(KEYS_STORE, JSON.stringify(keys));
}

const currentKeys = () => ({
  nebiusApiKey: builtIn.nebiusApiKey || pastedKeys().nebiusApiKey || '',
  tavilyApiKey: builtIn.tavilyApiKey || pastedKeys().tavilyApiKey || '',
});

let app = null;

function buildApp() {
  try {
    app = createApp({ settings, keys: currentKeys() });
  } catch (error) {
    app = null;
    showError(asError(error));
  }
}

// Turns anything thrown into the { code, message, details } the error cards show. Core errors never contain keys.
function asError(error) {
  return { code: error?.code ?? 'client_error', message: error?.message ?? String(error), details: error?.details ?? [] };
}

const livePanel = createLivePanel($('#livePanes'));
let planAbort = null; // lets the Stop button end the run in progress
let runToken = 0; // events from a stopped run are ignored

function showStopped() {
  $('#stopNote').textContent = 'Stopped. Nothing was kept from that run.';
  $('#stopNote').hidden = false;
  showView(state.result ? 'results' : 'empty');
  setTimeout(() => $('#explain').focus(), 0); // the button is re-enabled just after this returns
}

async function run() {
  const task = taskInput.value.trim();
  if (!task) return showTaskError('Enter a task before running.');
  if (!currentKeys().nebiusApiKey) return showTaskError('Add your Token Factory key in the API keys box first.');
  showTaskError('');
  $('#stopNote').hidden = true;
  const ensemble = ensembleBox.checked;
  livePanel.reset();
  describeLoading(ensemble);
  setBusy(true);
  const token = ++runToken;
  const controller = (planAbort = new AbortController());
  let result;
  try {
    result = await app.plan(task, {
      ensemble,
      signal: controller.signal,
      onProgress: (event) => token === runToken && livePanel.handle(event),
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      runToken += 1;
      return showStopped();
    }
    clearResult();
    showError(asError(error), livePanel.snapshot());
    return;
  } finally {
    setBusy(false);
    planAbort = null;
  }
  taskInput.value = result.task;
  state.result = result;
  state.rawOutput = livePanel.snapshot();
  state.configs = [
    { label: 'Recommended', ...result, tradeoff: null },
    ...result.alternatives.map((alt) => ({ ...alt, left_default: null })),
  ];
  state.active = 0;
  showView('results');
  renderAll();
}

// ---------- views and states ----------

function showView(name) {
  for (const id of ['empty', 'loading', 'error', 'results']) $(`#${id}`).hidden = id !== name;
}

const LOADING = {
  single: ['Asking the planner', 'The planner is a reasoning model and can take a couple of minutes. A second call happens only if the first answer fails validation.'],
  ensemble: ['Asking two planners, then an aggregator', 'Stage 1: both planners run in parallel. Stage 2: the aggregator merges their plans. Expect the slower planner plus the aggregator call, which can take several minutes. Each call may retry once if its answer fails validation.'],
};

function describeLoading(ensemble) {
  const [title, text] = LOADING[ensemble ? 'ensemble' : 'single'];
  $('#loadingTitle').textContent = title;
  $('#loadingText').textContent = text;
  $('#loadingAnnounce').textContent = title;
}

function showModelBanner(lines) {
  const banner = $('#modelBanner');
  banner.replaceChildren(el('strong', '', 'Model check'), ...lines.map((text) => el('p', '', text)));
  banner.hidden = lines.length === 0;
}

function setEnsembleUnavailable(reason) {
  ensembleBox.disabled = true;
  ensembleBox.checked = false;
  $('#ensRow').classList.add('is-off');
  $('#ensNote').textContent = `Unavailable. ${reason}`;
}

// Checks the configured models against the live Token Factory list, then sets up the ensemble checkbox and the Compare switch.
async function initConfig() {
  showModelBanner([]);
  taskInput.maxLength = serverConfig.max_task_chars;
  if (!serverConfig.compare_enabled) {
    const tab = $('.tab[data-tab="p2"]');
    tab.disabled = true;
    tab.title = 'Compare models is switched off.';
    $('#compareOff').hidden = false;
  }
  if (!currentKeys().nebiusApiKey) return setEnsembleUnavailable('Add your Token Factory key first.');
  try {
    const { problems } = await app.checkModels();
    showModelBanner(problems);
  } catch (error) {
    showModelBanner([asError(error).message]);
    return setEnsembleUnavailable(asError(error).message);
  }
  try {
    const { ensemble } = await app.getConfig();
    ensembleBox.disabled = !ensemble.available;
    ensembleBox.checked = ensemble.available && ensemble.default;
    $('#ensRow').classList.toggle('is-off', !ensemble.available);
    $('#ensNote').textContent = ensemble.available
      ? 'Two planners run in parallel, then an aggregator merges their plans. Slower, and uses three model calls.'
      : `Unavailable. ${ensemble.reason}`;
  } catch (error) {
    setEnsembleUnavailable(asError(error).message);
  }
}

let elapsedTimer = null;

function formatSeconds(seconds) {
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

function setBusy(busy) {
  document.body.classList.toggle('busy', busy);
  $('#explain').disabled = busy;
  clearInterval(elapsedTimer);
  if (!busy) return;
  const started = Date.now();
  const tick = () => {
    $('#elapsed').textContent = formatSeconds(Math.floor((Date.now() - started) / 1000));
    livePanel.tick();
  };
  tick();
  elapsedTimer = setInterval(tick, 1000);
  showView('loading');
  bringIntoView($('#loading'));
}

// On narrower screens the results sit below the left-hand cards, so scroll the live output into view when a run starts.
function bringIntoView(node) {
  const top = node.getBoundingClientRect().top;
  if (top > 80 && top < window.innerHeight * 0.45) return; // already comfortably in view
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: window.scrollY + top - 80, behavior: reduced ? 'auto' : 'smooth' });
}

function showTaskError(message) {
  $('#taskErr').textContent = message;
  $('#taskErr').hidden = !message;
}

function showError(error, outputs = null) {
  const box = $('#error');
  box.replaceChildren(el('span', 'errcode', error.code), el('h2', '', ERROR_TITLES[error.code] ?? 'Something went wrong'), el('p', '', error.message));
  if (error.code === 'invalid_plan') {
    box.append(el('p', 'muted', 'The planner was asked twice and both answers broke the Tavily spec, so nothing is shown. Edit the task and try again.'));
  }
  if (error.details?.length) {
    const list = el('ul');
    for (const detail of error.details) list.append(el('li', '', detail));
    box.append(list);
  }
  const disclosure = renderOutputDisclosure(document, outputs);
  if (disclosure) box.append(disclosure);
  showView('error');
}

function clearResult() {
  state.result = null;
  state.rawOutput = null;
  state.configs = [];
  state.phrases = null;
  renderAlternatives();
  renderCode();
  renderRunDetails();
  renderTask();
}

// ---------- rendering a result ----------

function renderAll() {
  const config = state.configs[state.active];
  state.phrases = findPhrases(state.result.task, config.parameters);
  renderTask();
  renderWarnings();
  renderRows(config);
  renderLeftDefault(config);
  renderAlternatives();
  renderCode();
  renderRunDetails();
  clearLink();
}

function renderWarnings() {
  const warnings = state.result.warnings;
  $('#warnsBox').hidden = warnings.length === 0;
  $('#wcount').textContent = `${warnings.length} documented ${warnings.length === 1 ? 'limit' : 'limits'} to know about`;
  $('#warns').replaceChildren(...warnings.map((text) => {
    const item = el('li');
    item.append(el('span', 'wkind', 'Limit'), richText(el('span', 'wtxt'), text));
    return item;
  }));
}

// A link is only made for http(s) URLs; anything else (javascript:, data:, junk) is shown as plain text.
function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function tagEl(row) {
  if (row.tag === 'documented') {
    const href = safeHttpUrl(row.source_url);
    const link = el(href ? 'a' : 'span', 'tag tag-doc');
    if (href) {
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.title = `Opens ${href}`;
    }
    link.innerHTML = ICON.doc;
    link.append('Documented');
    return link;
  }
  const tag = el('span', row.tag === 'judgment' ? 'tag tag-judg' : 'tag tag-def');
  tag.innerHTML = row.tag === 'judgment' ? ICON.judgment : ICON.default;
  tag.append(row.tag === 'judgment' ? 'Judgment call ' : 'Default');
  if (row.tag === 'judgment') tag.append(el('i', '', '[Inference]'));
  return tag;
}

function valueEl(value) {
  if (!Array.isArray(value)) return el('code', 'pval', JSON.stringify(value));
  const list = el('span', 'pval-list');
  for (const item of value) list.append(el('code', 'pval', JSON.stringify(item)));
  return list;
}

function triggerEl(row) {
  if (!row.trigger_phrase) return el('span', 'trig trig-none', 'no trigger phrase');
  const phrase = state.phrases.get(phraseKey(row.trigger_phrase));
  if (!phrase) return el('span', 'trig trig-missing', `“${row.trigger_phrase}” (not in task)`);
  const chip = el('span', `trig ph-${phrase.color}`, `“${row.trigger_phrase}”`);
  chip.dataset.ph = phraseKey(row.trigger_phrase);
  return chip;
}

const AGREEMENT = {
  agreed: 'both planners',
  planner_1: 'planner 1',
  planner_2: 'planner 2',
  aggregator: 'aggregator',
};

function agreementEl(agreement) {
  const ensemble = state.result.ensemble;
  const [one, two] = (ensemble?.planners ?? []).map((p) => p.model);
  const tips = {
    agreed: `${one} and ${two} proposed this value.`,
    planner_1: `Only ${one} proposed this value; the aggregator chose it.`,
    planner_2: `Only ${two} proposed this value; the aggregator chose it.`,
    aggregator: `Neither planner proposed this value; ${ensemble?.aggregator?.model} chose it.`,
  };
  const marker = el('span', `agr agr-${agreement}`, AGREEMENT[agreement] ?? agreement);
  marker.title = tips[agreement] ?? '';
  return marker;
}

function rowEl(row) {
  const card = el('article', 'row');
  card.dataset.row = '';
  card.dataset.p = row.name;
  card.tabIndex = 0;
  const tagCell = el('div', 'tagcell');
  tagCell.append(tagEl(row));
  const head = el('div', 'head');
  head.append(el('code', 'pname', row.name), el('span', 'eq', '='), valueEl(row.value));
  const triggers = el('div', 'tl');
  triggers.append(el('span', '', 'Triggered by'), triggerEl(row));
  if (row.agreement) triggers.append(agreementEl(row.agreement));
  card.append(tagCell, head, richText(el('p', 'reason'), row.reason), triggers);
  return card;
}

function renderRows(config) {
  $('#rows').replaceChildren(...config.parameters.map(rowEl));
  $('#pcount').textContent = `${config.parameters.length} set`;
}

// The API gives left_default only for the recommended plan, so the group is hidden for alternatives.
function renderLeftDefault(config) {
  const items = config.left_default ?? [];
  $('#defGroup').hidden = items.length === 0;
  $('#defs').replaceChildren(...items.map((item) => {
    const entry = el('div', 'defrow');
    const tagCell = el('div');
    tagCell.append(tagEl(item));
    const body = el('div');
    const name = el('div', 'pn2');
    name.append(el('code', 'pname', item.name), el('span', 'pdef', 'left unset'));
    body.append(name, richText(el('p', 'reason'), item.reason));
    entry.append(tagCell, body);
    return entry;
  }));
  $('#defbtn').innerHTML = ICON.chevron;
  $('#defbtn').append('Left at default', el('span', 'sub', `${items.length} ${items.length === 1 ? 'parameter' : 'parameters'}, each with a reason`));
  $('#defbtn').setAttribute('aria-expanded', 'true');
  $('#defwrap').classList.add('open');
}

function renderAlternatives() {
  const buttons = state.configs.length > 1 ? state.configs.map((config, i) => {
    const button = el('button');
    button.type = 'button';
    button.dataset.alt = i;
    button.setAttribute('aria-pressed', i === state.active);
    button.append(el('span', '', config.label), el('span', i === 0 ? 'bdg bdg-rec' : 'bdg bdg-alt', i === 0 ? 'Recommended' : 'Alternative'));
    return button;
  }) : [];
  $('#alts').replaceChildren(...buttons);

  const tradeoff = $('#tradeoff');
  tradeoff.replaceChildren();
  if (!state.result) tradeoff.textContent = 'Run the planner to see alternatives.';
  else if (state.configs.length === 1) tradeoff.textContent = 'The planner found no genuinely ambiguous choice for this task.';
  else if (state.active === 0) tradeoff.textContent = 'Pick an alternative to see how it differs from the recommended plan.';
  else richText(tradeoff, state.configs[state.active].tradeoff);
}

function renderRunDetails() {
  const box = $('#runDetails');
  box.replaceChildren(el('span', 'lbl', 'Run details'));
  if (!state.result) return box.append(el('span', '', 'Nothing run yet.'));
  const ok = el('span');
  ok.append(el('span', 'dotok'), 'Validated against the spec, 0 errors');
  const planner = el('span', '', 'Planner ');
  planner.append(el('code', '', state.result.model));
  const spec = el('span', '', 'Spec ');
  spec.append(el('code', '', 'tavily_search.json'));
  const ensemble = state.result.ensemble;
  box.append(ok, ...(ensemble?.used ? [] : [planner]), spec);
  if (ensemble?.used) {
    ensemble.planners.forEach((p, i) => box.append(modelLine(`Planner ${i + 1}`, p.model, p.elapsed_seconds, p.status === 'ok' ? '' : `${p.status}, `)));
    box.append(modelLine('Aggregator', ensemble.aggregator.model, ensemble.aggregator.elapsed_seconds));
  }
  if (ensemble?.note) box.append(el('span', 'ens-result-note', ensemble.note));
  const disclosure = renderOutputDisclosure(document, state.rawOutput);
  if (disclosure) box.append(disclosure);
}

function modelLine(label, model, seconds, status = '') {
  const line = el('span', '', `${label} `);
  line.append(el('code', '', model), ` ${status}${formatSeconds(Math.round(seconds))}`);
  return line;
}

// ---------- trigger phrases ----------

const phraseKey = (phrase) => phrase.toLowerCase();

// Locate each row's trigger phrase in the task (ignoring case). Returns Map key -> {start, end, color}.
// Phrases that are not in the task, or that overlap an earlier one, are left out.
function findPhrases(task, rows) {
  const lower = task.toLowerCase();
  const found = [];
  for (const row of rows) {
    const key = row.trigger_phrase && phraseKey(row.trigger_phrase);
    const start = key ? lower.indexOf(key) : -1;
    if (start > -1 && !found.some((f) => f.key === key)) found.push({ key, start, end: start + key.length });
  }
  found.sort((a, b) => a.start - b.start);
  const phrases = new Map();
  let lastEnd = 0;
  for (const f of found) {
    if (f.start < lastEnd) continue;
    phrases.set(f.key, { start: f.start, end: f.end, color: phrases.size % 2 ? 'b' : 'a' });
    lastEnd = f.end;
  }
  return phrases;
}

function renderTask() {
  const text = taskInput.value;
  taskView.replaceChildren();
  if (!text) return taskView.append(el('span', 'ph-empty', 'Describe what you want to search for'));
  const analyzed = state.result && state.result.task === text;
  let pos = 0;
  for (const [key, phrase] of analyzed ? state.phrases : []) {
    taskView.append(text.slice(pos, phrase.start));
    const mark = el('mark', `ph ph-${phrase.color}`, text.slice(phrase.start, phrase.end));
    mark.dataset.ph = key;
    mark.tabIndex = 0;
    taskView.append(mark);
    pos = phrase.end;
  }
  taskView.append(text.slice(pos));
}

// ---------- request preview ----------

const TOKEN = /(#.*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\b(from|import)\b|\b(TavilyClient|search)\b|\b(True|False|None|true|false|null)\b|(-?\d+(?:\.\d+)?)|(\w+)(?==)/g;
const TOKEN_CLASS = [null, 'cm', 's', 'kw', 'fn', 'n', 'n', 'k'];

function highlight(line) {
  const out = el('span', 'lc');
  let pos = 0;
  for (const match of line.matchAll(TOKEN)) {
    out.append(line.slice(pos, match.index));
    let cls = TOKEN_CLASS[match.findIndex((group, i) => i > 0 && group !== undefined)];
    if (cls === 's' && line[match.index + match[0].length] === ':') cls = 'k';
    out.append(el('span', cls, match[0]));
    pos = match.index + match[0].length;
  }
  out.append(line.slice(pos));
  return out;
}

function previewText(config) {
  return state.mode === 'json' ? JSON.stringify(config.request_body, null, 2) : config.python_snippet;
}

// A line belongs to the parameter whose `"name":` or `    name=` line it follows. Unindented lines belong to none.
function renderCode() {
  const code = $('#code');
  copyButton.replaceChildren();
  copyButton.innerHTML = ICON.copy;
  copyButton.append(state.mode === 'json' ? 'Copy JSON' : 'Copy Python');
  if (!state.result) {
    code.replaceChildren(el('p', 'code-empty', 'The request appears here after you run the planner.'));
    return;
  }
  const lines = previewText(state.configs[state.active]).replace(/\n$/, '').split('\n');
  let param = null;
  code.replaceChildren(...lines.map((text, i) => {
    if (!/^\s/.test(text)) param = null;
    else param = text.match(/^ {2}"([^"]+)":/)?.[1] ?? text.match(/^ {4}(\w+)=/)?.[1] ?? param;
    const line = el('div', 'cl');
    if (param) line.dataset.p = param;
    line.append(el('span', 'ln', i + 1), highlight(text));
    return line;
  }));
}

copyButton.addEventListener('click', async () => {
  if (!state.result) return;
  const label = copyButton.innerHTML;
  try {
    await navigator.clipboard.writeText(previewText(state.configs[state.active]));
    copyButton.classList.add('ok');
    copyButton.textContent = 'Copied';
  } catch {
    copyButton.textContent = 'Copy failed, select the text instead';
  }
  setTimeout(() => {
    copyButton.classList.remove('ok');
    copyButton.innerHTML = label;
  }, 1400);
});

// ---------- hover linking: phrases <-> rows <-> code lines ----------

function clearLink() {
  document.body.classList.remove('linking');
  for (const node of $$('.is-active')) node.classList.remove('is-active');
}

function link(event) {
  clearLink();
  if (!state.result || !event.target.closest) return;
  const rows = state.configs[state.active].parameters;
  const keyOf = (row) => row.trigger_phrase && phraseKey(row.trigger_phrase);
  const names = new Set();
  const phrases = new Set();

  const part = event.target.closest('[data-p]');
  const phrase = event.target.closest('[data-ph]');
  if (part) {
    names.add(part.dataset.p);
    phrases.add(keyOf(rows.find((row) => row.name === part.dataset.p)));
  } else if (phrase) {
    phrases.add(phrase.dataset.ph);
    for (const row of rows) if (keyOf(row) === phrase.dataset.ph) names.add(row.name);
  } else {
    return;
  }
  for (const node of $$('[data-p], [data-ph]')) {
    if (names.has(node.dataset.p) || phrases.has(node.dataset.ph)) node.classList.add('is-active');
  }
  document.body.classList.add('linking');
}

document.addEventListener('mouseover', link);
document.addEventListener('focusin', link);
document.addEventListener('mouseleave', clearLink);
document.addEventListener('focusout', (event) => { if (!event.relatedTarget) clearLink(); });
document.addEventListener('click', (event) => { if (matchMedia('(hover: none)').matches) link(event); });

// ---------- controls ----------

function fitTextarea() {
  taskInput.style.height = 'auto';
  taskInput.style.height = `${taskInput.scrollHeight}px`;
}

function editTask() {
  taskBox.classList.add('editing');
  fitTextarea();
  taskInput.focus();
  taskInput.setSelectionRange(taskInput.value.length, taskInput.value.length);
}

taskView.addEventListener('click', editTask);
taskView.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  editTask();
});
taskInput.addEventListener('input', () => { fitTextarea(); showTaskError(''); clearExample(); });
taskInput.addEventListener('blur', () => { taskBox.classList.remove('editing'); renderTask(); });
taskInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  taskInput.blur();
  run();
});
$('#explain').addEventListener('click', run);
$('#stopPlan').addEventListener('click', () => planAbort?.abort());

$('#alts').addEventListener('click', (event) => {
  const button = event.target.closest('[data-alt]');
  if (!button) return;
  state.active = Number(button.dataset.alt);
  renderAll();
});

for (const tab of $$('.code-tab')) {
  tab.addEventListener('click', () => {
    state.mode = tab.dataset.mode;
    for (const other of $$('.code-tab')) other.setAttribute('aria-selected', other === tab);
    renderCode();
  });
}

$('#defbtn').addEventListener('click', () => {
  const open = $('#defbtn').getAttribute('aria-expanded') !== 'true';
  $('#defbtn').setAttribute('aria-expanded', open);
  $('#defwrap').classList.toggle('open', open);
});

for (const tab of $$('.tab')) {
  tab.addEventListener('click', () => {
    for (const other of $$('.tab')) other.setAttribute('aria-selected', other === tab);
    for (const view of $$('[data-view]')) view.hidden = view.dataset.view !== tab.dataset.tab;
  });
}

$('#theme').innerHTML = ICON.theme;
$('#theme').addEventListener('click', () => {
  const root = document.documentElement;
  const current = root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  root.dataset.theme = current === 'dark' ? 'light' : 'dark';
});

// ---------- Compare models (Phase 2) ----------
// Every trace string comes from a model or a web page, so it only ever goes in through textContent.

const ROLES = ['small', 'large'];
const ROLE_LABEL = { small: 'Small', large: 'Large' };
const ROLE_CLASS = { small: 's', large: 'l' };
const END_LABEL = { answered: 'answered', turn_cap: 'turn cap reached', timeout: 'timed out', error: 'error' };
const ERROR_LABEL = { invalid_arguments: 'Rejected', unknown_tool: 'Rejected', tavily_error: 'Tavily error', search_cap: 'Not run', turn_cap: 'Not run' };

const compare = {
  models: [],
  limits: { default_turns: 6, max_turns: 12, default_searches: 4, max_searches: 8 },
  caps: { turns: 6, searches: 4 },
  columns: {},
  pending: [],
  abort: null,
  stopped: false,
};

function line(label, value) {
  const row = el('div', 'nline');
  row.append(el('span', 'nlab', label));
  const cell = el('div', 'nval');
  cell.append(value);
  row.append(cell);
  return row;
}

// The model's final answer: formatted by default, with a switch to the raw markdown and a copy button.
// The text is untrusted, so markdown.js builds the elements itself and never parses HTML.
function answerBlock(text) {
  const wrap = el('div', 'answer');
  if (!text) {
    wrap.append(el('span', 'muted', '(empty reply)'));
    return wrap;
  }
  const formatted = el('div', 'md');
  formatted.append(renderMarkdown(text, document));
  const raw = el('pre', 'md-raw');
  raw.textContent = text;

  // A wide table scrolls inside its own box; say so, but only while there is more to see.
  for (const box of formatted.querySelectorAll('.md-table')) {
    const hint = el('div', 'md-scroll-hint', 'Scroll sideways for more columns');
    box.after(hint);
    const mark = () => { hint.hidden = box.scrollLeft + box.clientWidth >= box.scrollWidth - 1; };
    box.addEventListener('scroll', mark, { passive: true });
    new ResizeObserver(mark).observe(box);
    hint.hidden = true;
  }

  const seg = el('div', 'seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Answer view');
  const buttons = {};
  const show = (mode) => {
    formatted.hidden = mode !== 'formatted';
    raw.hidden = mode !== 'raw';
    for (const [name, button] of Object.entries(buttons)) button.setAttribute('aria-pressed', String(name === mode));
  };
  for (const [mode, label] of [['formatted', 'Formatted'], ['raw', 'Raw']]) {
    const button = el('button', '', label);
    button.type = 'button';
    button.addEventListener('click', () => show(mode));
    buttons[mode] = button;
    seg.append(button);
  }

  const copy = el('button', 'btn btn-sm', 'Copy');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = 'Copied';
      copy.classList.add('ok');
    } catch {
      copy.textContent = 'Copy failed';
    }
    setTimeout(() => {
      copy.textContent = 'Copy';
      copy.classList.remove('ok');
    }, 1400);
  });

  const bar = el('div', 'answer-bar');
  bar.append(seg, copy);
  wrap.append(bar, formatted, raw);
  show('formatted');
  return wrap;
}

function argChip(key, value) {
  const chip = el('code', 'arg');
  let shown;
  if (Array.isArray(value)) {
    shown = `[${value.slice(0, 3).join(', ')}${value.length > 3 ? `, +${value.length - 3}` : ''}]`;
    chip.title = value.join(', ');
  } else {
    shown = typeof value === 'string' ? `"${value}"` : String(value);
  }
  chip.append(el('b', '', key), `: ${shown}`);
  return chip;
}

function resultItem(result) {
  const item = el('li');
  item.title = result.url ?? '';
  const title = el('span', 't', result.title || '(untitled)');
  if (!result.new) title.append(el('span', 'badge', 'seen'));
  item.append(title, el('span', 'u', (result.url ?? '').replace(/^https?:\/\//, '')));
  return item;
}

function selectedModel(role) {
  const col = compare.columns[role];
  if (col.select) return col.select.value;
  return compare.models.find((m) => m.size === role)?.id;
}

function buildColumn(role) {
  const col = { role, root: $(`#col-${role}`), running: false, hasRun: false, maxTurns: 0, calls: {}, timer: null, started: 0 };
  compare.columns[role] = col;

  const head = el('header', 'p2-head');
  head.append(el('span', `p2-size ${ROLE_CLASS[role]}`, ROLE_LABEL[role]));
  const options = compare.models.filter((m) => m.size === role);
  if (options.length > 1) {
    col.select = el('select', 'p2-mid');
    col.select.setAttribute('aria-label', `${ROLE_LABEL[role]} model`);
    for (const m of options) col.select.append(new Option(m.id, m.id, m.default, m.default));
    head.append(col.select);
  } else {
    head.append(el('span', 'p2-mid', options[0]?.id ?? 'No model available'));
  }
  col.clock = el('span', 'p2-clock');
  col.again = el('button', 'btn btn-sm', 'Run again');
  col.again.type = 'button';
  col.again.addEventListener('click', () => openRunDialog([role]));
  head.append(col.clock, col.again);

  col.empty = el('p', 'p2-empty', 'Not run yet.');
  col.trace = el('ol', 'trace');
  col.foot = el('div');
  col.root.replaceChildren(head, col.empty, col.trace, col.foot);
}

function resetColumn(col) {
  col.empty.hidden = true;
  col.trace.replaceChildren();
  col.foot.replaceChildren();
  col.calls = {};
  col.body = null;
  col.running = true;
  col.hasRun = true;
  col.started = Date.now();
  clearInterval(col.timer);
  const tick = () => { col.clock.textContent = formatSeconds(Math.floor((Date.now() - col.started) / 1000)); };
  tick();
  col.timer = setInterval(tick, 1000);
}

function stopColumn(col, seconds) {
  col.running = false;
  clearInterval(col.timer);
  if (seconds !== undefined) col.clock.textContent = formatSeconds(Math.round(seconds));
}

function updateCompareButtons() {
  const anyRunning = ROLES.some((role) => compare.columns[role]?.running);
  $('#p2Stop').hidden = !anyRunning;
  $('#p2Run').disabled = anyRunning || ROLES.some((role) => !compare.models.some((m) => m.size === role));
  for (const role of ROLES) {
    const col = compare.columns[role];
    if (col) col.again.disabled = col.running || !col.hasRun;
  }
}

function traceNode(col, dot, className = '') {
  const item = el('li', `node ${className}`.trim());
  item.append(el('span', 'node-dot', dot));
  col.body = el('div', 'node-body');
  item.append(col.body);
  col.trace.append(item);
  return item;
}

function setWait(col, message) {
  const wait = el('div', 'p2-wait');
  wait.setAttribute('role', 'status');
  wait.append(el('span', 'spin'), message);
  col.foot.replaceChildren(wait);
}

function renderSummary(col, e) {
  const counts = [
    [String(e.searches), e.searches === 1 ? 'search' : 'searches'],
    [String(e.distinct_urls), 'distinct URLs'],
    [String(e.repeated_queries), e.repeated_queries === 1 ? 'repeated query' : 'repeated queries'],
    [`${e.credits}${e.credits_complete ? '' : '+'}`, 'credits'],
  ];
  const summary = el('div', 'sumline');
  counts.forEach(([value, label], i) => {
    if (i) summary.append(el('span', 'sep', '/'));
    const part = el('span');
    part.append(el('b', '', value), ` ${label}`);
    summary.append(part);
  });

  const notes = [`${e.turns} model ${e.turns === 1 ? 'turn' : 'turns'}`, `ended: ${END_LABEL[e.end_reason] ?? e.end_reason}`, formatSeconds(Math.round(e.elapsed_seconds))];
  if (e.invalid_calls) notes.push(`${e.invalid_calls} rejected ${e.invalid_calls === 1 ? 'call' : 'calls'}`);
  if (e.failed_searches) notes.push(`${e.failed_searches} failed Tavily ${e.failed_searches === 1 ? 'search' : 'searches'}`);
  if (e.blocked_calls) notes.push(`${e.blocked_calls} ${e.blocked_calls === 1 ? 'call' : 'calls'} blocked by the search cap`);
  if (!e.credits_complete) notes.push('credits: not every search reported usage');
  col.foot.replaceChildren(summary, el('div', 'sumnote', notes.join(' · ')));
}

const compareHandlers = {
  run_start(col, e) {
    col.maxTurns = e.max_turns;
  },
  waiting(col, e) {
    setWait(col, `Waiting for the model, turn ${e.turn} of ${col.maxTurns}`);
  },
  model_turn(col, e) {
    traceNode(col, String(e.turn), e.tool_calls ? '' : 'node-final');
    col.body.append(line('Model', e.reasoning ? el('div', 'reasoning', e.reasoning) : el('em', '', 'No reasoning text returned by this model.')));
    if (e.content && e.tool_calls) col.body.append(line('Said', e.content)); // a final reply is shown once, as the Answer
  },
  tool_call(col, e) {
    const args = el('div', 'args');
    if (typeof e.arguments === 'object' && e.arguments !== null) {
      for (const [key, value] of Object.entries(e.arguments)) args.append(argChip(key, value));
    } else {
      args.append(el('code', 'arg', `raw arguments: ${e.arguments}`));
    }
    const block = el('div', 'call');
    block.append(line(`Search ${e.step}`, args));
    col.calls[e.step] = block;
    col.body.append(block);
    setWait(col, `Running Tavily search ${e.step}`);
  },
  tool_result(col, e) {
    const fresh = e.results.filter((r) => r.new).length;
    const summary = el('span', '', `${e.count} ${e.count === 1 ? 'result' : 'results'}, ${fresh} new ${fresh === 1 ? 'URL' : 'URLs'}`);
    if (e.credits !== null) summary.append(el('span', 'badge', `${e.credits} ${e.credits === 1 ? 'credit' : 'credits'}`));
    if (e.repeat_of !== null) summary.append(el('span', 'badge', `repeats search ${e.repeat_of}`));
    const value = el('div');
    value.append(summary);
    if (e.results.length) {
      const list = el('ul', 'res');
      e.results.slice(0, 3).forEach((r) => list.append(resultItem(r)));
      if (e.results.length > 3) {
        const more = el('details');
        more.append(el('summary', '', `+ ${e.results.length - 3} more`));
        const rest = el('ul', 'res');
        e.results.slice(3).forEach((r) => rest.append(resultItem(r)));
        more.append(rest);
        const holder = el('li');
        holder.append(more);
        list.append(holder);
      }
      value.append(list);
    }
    col.calls[e.step].append(line('Returned', value));
  },
  tool_error(col, e) {
    const message = el('span', '', e.message);
    if (e.counted) message.append(el('span', 'badge badge-err', 'counted against the search cap'));
    if (e.repeat_of) message.append(el('span', 'badge', `repeats search ${e.repeat_of}`));
    col.calls[e.step].append(line(ERROR_LABEL[e.kind] ?? 'Error', message));
  },
  answer(col, e) {
    col.body.append(line('Answer', answerBlock(e.content)));
  },
  run_error(col, e) {
    traceNode(col, '!', 'node-err');
    col.body.append(line('Run error', e.message));
  },
  run_end(col, e) {
    stopColumn(col, e.elapsed_seconds);
    renderSummary(col, e);
  },
};

function handleCompareEvent(event) {
  const col = compare.columns[event.run];
  if (col) compareHandlers[event.type]?.(col, event);
}

function showCompareError(error) {
  const box = $('#p2Error');
  box.replaceChildren(el('span', 'errcode', error.code), el('h2', '', ERROR_TITLES[error.code] ?? 'The comparison could not run'), el('p', '', error.message));
  box.hidden = false;
}

function interrupt(roles, message) {
  for (const role of roles) {
    const col = compare.columns[role];
    if (!col.running) continue;
    stopColumn(col);
    col.foot.replaceChildren(el('div', 'sumnote', message));
  }
}

async function startRuns(roles) {
  const query = taskInput.value.trim();
  $('#p2Error').hidden = true;
  for (const role of roles) resetColumn(compare.columns[role]);
  for (const role of roles) setWait(compare.columns[role], 'Starting');
  compare.abort = new AbortController();
  compare.stopped = false;
  updateCompareButtons();

  try {
    await app.compare({
      query,
      confirm: true,
      maxTurns: compare.caps.turns,
      maxSearches: compare.caps.searches,
      roles,
      models: Object.fromEntries(roles.map((role) => [role, selectedModel(role)])),
      signal: compare.abort.signal,
    }, handleCompareEvent);
    // A run the Stop button cancelled sends no summary; a run that finished normally is no longer running here.
    interrupt(roles, compare.stopped ? 'Stopped before this run finished.' : 'This run ended without a summary.');
  } catch (error) {
    const shown = asError(error);
    showCompareError(shown);
    interrupt(roles, shown.code === 'upstream_error' || shown.code === 'client_error' ? 'The run could not finish.' : 'Not started.');
  }
  compare.abort = null;
  updateCompareButtons();
}

// ---------- confirmation dialog (a Compare run spends Tavily credits, so it asks first) ----------

const dialog = $('#p2Dialog');

function explainCost() {
  const searches = Number($('#inSearches').value) || compare.limits.default_searches;
  const runs = compare.pending.length;
  $('#p2Impl').replaceChildren(
    'Up to ',
    el('b', '', String(searches)),
    ' Tavily searches per model. A basic search costs 1 credit and an advanced search costs 2, and the model picks the depth, so the worst case is ',
    el('b', '', String(searches * 2 * runs)),
    ` credits across ${runs === 1 ? 'this run' : 'both runs'}. A run can take several minutes.`,
  );
}

function openRunDialog(roles) {
  if (!taskInput.value.trim()) return showCompareError({ code: 'empty_query', message: 'Enter a task on the Parameters tab first.' });
  compare.pending = roles;
  const names = roles.map((role) => selectedModel(role)).join(' and ');
  $('#p2DialogTitle').textContent = roles.length === 2 ? 'Run the original query on both models' : 'Run this model again';
  $('#p2DialogLead').textContent = `The same query and the same Tavily tool schema go to ${names}. Each run stops at whichever cap it hits first.`;
  $('#inTurns').max = compare.limits.max_turns;
  $('#inSearches').max = compare.limits.max_searches;
  $('#inTurns').value = compare.caps.turns;
  $('#inSearches').value = compare.caps.searches;
  explainCost();
  dialog.showModal();
}

function clampCap(input, fallback, max) {
  const value = Math.round(Number(input.value));
  return Number.isFinite(value) && value >= 1 ? Math.min(value, max) : fallback;
}

function confirmRun() {
  compare.caps.turns = clampCap($('#inTurns'), compare.limits.default_turns, compare.limits.max_turns);
  compare.caps.searches = clampCap($('#inSearches'), compare.limits.default_searches, compare.limits.max_searches);
  $('#capTurns').textContent = compare.caps.turns;
  $('#capSearches').textContent = compare.caps.searches;
  dialog.close();
  startRuns(compare.pending);
}

$('#inSearches').addEventListener('input', explainCost);
$('#p2Cancel').addEventListener('click', () => dialog.close());
$('#p2Go').addEventListener('click', confirmRun);
dialog.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); confirmRun(); });
$('#p2Run').addEventListener('click', () => openRunDialog(ROLES));

function refreshCompareQuery() {
  $('#p2Query').textContent = taskInput.value.trim() || 'No task yet. Enter one on the Parameters tab.';
}
$('.tab[data-tab="p2"]').addEventListener('click', refreshCompareQuery);

async function initCompare() {
  if (!serverConfig.compare_enabled) return;
  if (currentKeys().nebiusApiKey) {
    try {
      const data = await app.listModels();
      compare.models = data.models;
      compare.limits = data.limits;
      compare.caps = { turns: data.limits.default_turns, searches: data.limits.default_searches };
      $('#capTurns').textContent = compare.caps.turns;
      $('#capSearches').textContent = compare.caps.searches;
    } catch (error) {
      showCompareError(asError(error));
    }
  }
  for (const role of ROLES) buildColumn(role);
  updateCompareButtons();
}

refreshCompareQuery();

// Anything unexpected ends up in the same error card as a failed request.
window.addEventListener('error', (event) => showError({ code: 'client_error', message: event.message, details: [] }));
window.addEventListener('unhandledrejection', (event) => showError({ code: 'client_error', message: String(event.reason), details: [] }));

// ---------- example tasks ----------

const exampleSelect = $('#examples');
let exampleList = [];

// Editing the text yourself drops the "intended to exercise" note, which only describes the example as written.
function clearExample() {
  exampleSelect.value = '';
  $('#exNote').hidden = true;
}

async function initExamples() {
  try {
    exampleList = await (await fetch('examples.json')).json();
  } catch {
    return;
  }
  for (const [index, example] of exampleList.entries()) {
    const option = el('option', '', example.label);
    option.value = String(index);
    exampleSelect.append(option);
  }
  exampleSelect.hidden = exampleList.length === 0;
}

exampleSelect.addEventListener('change', () => {
  const example = exampleList[Number(exampleSelect.value)];
  if (!example) return clearExample();
  taskInput.value = example.task;
  fitTextarea();
  renderTask();
  showTaskError('');
  refreshCompareQuery();
  $('#exNote').textContent = `Intended to exercise: ${example.exercises}. The planner decides what it actually sets.`;
  $('#exNote').hidden = false;
});

// ---------- the API keys box (shown only for keys the build did not provide) ----------

const KEY_FIELDS = [
  { name: 'nebiusApiKey', input: '#nebiusKey', row: '#nebiusKeyRow', status: '#nebiusKeyStatus' },
  { name: 'tavilyApiKey', input: '#tavilyKey', row: '#tavilyKeyRow', status: '#tavilyKeyStatus' },
];

// Shows whether a pasted key is saved for this tab. The key itself is never put back on the page.
function renderKeyStatus() {
  const pasted = pastedKeys();
  for (const field of KEY_FIELDS) $(field.status).textContent = pasted[field.name] ? 'Saved for this tab.' : 'Not set.';
}

function initKeysBox() {
  const missing = KEY_FIELDS.filter((field) => !builtIn[field.name]);
  $('#keysCard').hidden = missing.length === 0;
  for (const field of KEY_FIELDS) $(field.row).hidden = Boolean(builtIn[field.name]);
  renderKeyStatus();

  for (const field of missing) {
    const input = $(field.input);
    input.addEventListener('change', () => {
      const value = input.value.trim();
      input.value = '';
      if (!value) return;
      savePastedKey(field.name, value);
      renderKeyStatus();
      init();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') input.blur();
    });
  }
  $('#clearKeys').addEventListener('click', () => {
    sessionStorage.removeItem(KEYS_STORE);
    for (const field of KEY_FIELDS) $(field.input).value = '';
    renderKeyStatus();
    init();
  });
}

async function init() {
  buildApp();
  if (!app) return;
  await initConfig();
  await initCompare();
}

$('#p2Stop').addEventListener('click', () => {
  compare.stopped = true;
  compare.abort?.abort();
});

initKeysBox();
renderTask();
renderRunDetails();
renderCode();
init();
initExamples();
