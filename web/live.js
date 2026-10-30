// The "Live output" window shown while the planner runs: one pane per model call, filled from the progress events of
// app.plan(). The rules (what to say when, how much text to keep) are plain functions so they can be tested without a page.
// All model text goes in with textContent, never as HTML.

export const MAX_CHARS = 30_000; // most recent text kept per field
export const SILENCE_HINT_AFTER = 30; // seconds without new output while receiving
export const FIRST_OUTPUT_HINT_AFTER = 60; // seconds without any output from a new attempt

export const STATUS_LABEL = {
  waiting: 'Waiting for first output',
  receiving: 'Receiving',
  retry: 'Asking again',
  done: 'Done',
  failed: 'Failed',
};

export const STAGE_TITLE = { planner: 'Planner', planner1: 'Planner 1', planner2: 'Planner 2', aggregator: 'Aggregator' };

export const RETRY_MESSAGE = "The first answer broke Tavily's rules, so the model is being asked again. What was wrong:";

// Keeps the most recent `max` characters. `hidden` is how many were dropped.
export function capText(text, max = MAX_CHARS) {
  if (text.length <= max) return { text, hidden: 0 };
  let start = text.length - max;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1; // do not start in the middle of an emoji
  return { text: text.slice(start), hidden: start };
}

export function agoText(seconds) {
  return seconds < 2 ? 'last output just now' : `last output ${Math.floor(seconds)}s ago`;
}

// The line that tells the reader a quiet pane is probably fine, or '' when there is nothing to say.
// state: { status, attemptStartedAt, lastOutputAt } in milliseconds; now in milliseconds.
export function hintFor(state, now) {
  if (state.status === 'receiving' && state.lastOutputAt != null) {
    const quiet = Math.floor((now - state.lastOutputAt) / 1000);
    if (quiet >= SILENCE_HINT_AFTER) return `No new output for ${quiet} s. Reasoning models can pause; still waiting.`;
  }
  if ((state.status === 'waiting' || state.status === 'retry') && Math.floor((now - state.attemptStartedAt) / 1000) >= FIRST_OUTPUT_HINT_AFTER) {
    return 'Still waiting for the first output.';
  }
  return '';
}

const formatCount = (n) => `${n.toLocaleString('en-US')} ${n === 1 ? 'character' : 'characters'}`;

export function createLivePanel(container, { now = () => Date.now(), schedule = (fn) => requestAnimationFrame(fn) } = {}) {
  const doc = container.ownerDocument;
  const make = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const panes = new Map();
  let frameQueued = false;
  const dirty = new Set();

  // ----- building the DOM -----

  function buildPane(stage, model) {
    const head = make('header', 'live-head');
    const title = make('span', 'live-title', STAGE_TITLE[stage] ?? stage);
    const modelEl = make('code', 'live-model', model ?? '');
    const chip = make('span', 'live-chip');
    chip.setAttribute('role', 'status');
    const meta = make('span', 'live-meta');
    const count = make('span', 'live-count');
    const ago = make('span', 'live-ago');
    meta.append(count, ago);
    head.append(title, modelEl, chip, meta);

    const body = make('div', 'live-body');
    body.setAttribute('aria-live', 'off');
    body.tabIndex = 0;
    body.hidden = true; // shown once there is something to read
    body.setAttribute('aria-label', `${STAGE_TITLE[stage] ?? stage} output`);

    const hint = make('p', 'live-hint');
    hint.hidden = true;
    const reason = make('p', 'live-reason');
    reason.hidden = true;

    const root = make('section', 'live-pane');
    root.append(head, body, hint, reason);
    container.append(root);

    const pane = {
      stage, title: STAGE_TITLE[stage] ?? stage, model: model ?? '',
      status: 'waiting', startedAt: now(), attemptStartedAt: now(), lastOutputAt: null, endedAt: null,
      chars: 0, stick: true, attempts: [], reason: '',
      el: { root, chip, count, ago, body, hint, reason },
    };
    body.addEventListener('scroll', () => {
      pane.stick = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    });
    setStatus(pane, 'waiting');
    return pane;
  }

  function newAttempt(pane, n) {
    const wrap = make('div', 'live-attempt');
    if (n > 1) wrap.append(make('span', 'live-attempt-label', `Attempt ${n}`));
    pane.el.body.append(wrap);
    const attempt = { n, wrap, think: null, answer: null, retryErrors: null, got: false };
    pane.attempts.push(attempt);
    return attempt;
  }

  function segment(attempt, kind) {
    const existing = attempt[kind];
    if (existing) return existing;
    const wrap = make('div', `live-seg live-${kind}`);
    wrap.append(make('span', 'live-label', kind === 'think' ? 'Thinking' : 'Answer'));
    const hiddenNote = make('span', 'live-hidden');
    hiddenNote.hidden = true;
    const pre = make('pre');
    wrap.append(hiddenNote, pre);
    // keep the order the model produced them in: thinking, then the answer
    attempt.wrap.append(wrap);
    attempt.wrap.parentElement.hidden = false;
    attempt[kind] = { wrap, pre, hiddenNote, text: '', hidden: 0 };
    return attempt[kind];
  }

  function setStatus(pane, status) {
    pane.status = status;
    pane.el.chip.textContent = STATUS_LABEL[status];
    pane.el.chip.dataset.state = status;
    updateHint(pane);
  }

  function updateHint(pane) {
    const text = hintFor(pane, now());
    if (pane.el.hint.textContent !== text) pane.el.hint.textContent = text;
    pane.el.hint.hidden = !text;
  }

  // ----- keeping the display current -----

  function flush() {
    frameQueued = false;
    for (const pane of dirty) {
      for (const attempt of pane.attempts) {
        for (const kind of ['think', 'answer']) {
          const seg = attempt[kind];
          if (!seg || !seg.dirty) continue;
          seg.dirty = false;
          const kept = capText(seg.text);
          seg.text = kept.text;
          seg.hidden += kept.hidden;
          seg.pre.textContent = seg.text;
          seg.hiddenNote.hidden = seg.hidden === 0;
          if (seg.hidden) seg.hiddenNote.textContent = `… earlier output hidden (${formatCount(seg.hidden)})`;
        }
      }
      pane.el.count.textContent = formatCount(pane.chars);
      if (pane.stick) pane.el.body.scrollTop = pane.el.body.scrollHeight;
    }
    dirty.clear();
  }

  function queueFlush(pane) {
    dirty.add(pane);
    if (frameQueued) return;
    frameQueued = true;
    schedule(flush);
  }

  // ----- the events from app.plan() -----

  function paneFor(event) {
    return panes.get(event.stage) ?? (panes.set(event.stage, buildPane(event.stage, event.model)), panes.get(event.stage));
  }

  function handle(event) {
    const pane = paneFor(event);
    const current = pane.attempts.at(-1);
    switch (event.type) {
      case 'stage_start': {
        pane.attemptStartedAt = now();
        newAttempt(pane, event.attempt ?? pane.attempts.length + 1);
        setStatus(pane, event.attempt > 1 ? 'retry' : 'waiting');
        break;
      }
      case 'delta': {
        const attempt = current ?? newAttempt(pane, 1);
        const seg = segment(attempt, event.kind === 'reasoning' ? 'think' : 'answer');
        seg.text += event.text;
        seg.dirty = true;
        if (seg.text.length > MAX_CHARS * 1.25) {
          const kept = capText(seg.text);
          seg.text = kept.text;
          seg.hidden += kept.hidden;
        }
        pane.chars += event.text.length;
        pane.lastOutputAt = now();
        if (pane.status !== 'receiving') setStatus(pane, 'receiving');
        queueFlush(pane);
        break;
      }
      case 'retry': {
        if (current) {
          current.retryErrors = event.errors;
          const box = make('div', 'live-retry');
          box.append(make('p', '', RETRY_MESSAGE));
          const list = make('ul');
          for (const message of event.errors) list.append(make('li', '', message));
          box.append(list);
          current.wrap.append(box);
          current.wrap.parentElement.hidden = false;
        }
        setStatus(pane, 'retry');
        queueFlush(pane);
        break;
      }
      case 'stage_end': {
        pane.endedAt = now();
        pane.el.ago.textContent = typeof event.elapsed_seconds === 'number' ? `${event.elapsed_seconds} s` : '';
        if (!event.ok && event.reason) {
          pane.reason = event.reason;
          pane.el.reason.textContent = event.reason;
          pane.el.reason.hidden = false;
        }
        setStatus(pane, event.ok ? 'done' : 'failed');
        break;
      }
      default:
        break;
    }
    if (pane.stick) queueFlush(pane);
  }

  // Called once a second: "last output Ns ago" and the hints for panes that are still waiting.
  function tick() {
    const t = now();
    for (const pane of panes.values()) {
      if (pane.status === 'done' || pane.status === 'failed') continue;
      pane.el.ago.textContent = pane.status === 'receiving' && pane.lastOutputAt != null ? agoText((t - pane.lastOutputAt) / 1000) : '';
      updateHint(pane);
    }
  }

  function reset() {
    panes.clear();
    dirty.clear();
    container.replaceChildren();
  }

  // What was received, for the "Model output" disclosure after the run. Text is already capped.
  function snapshot() {
    return [...panes.values()].map((pane) => ({
      title: pane.title,
      model: pane.model,
      status: pane.status,
      reason: pane.reason,
      attempts: pane.attempts.map((attempt) => ({
        n: attempt.n,
        reasoning: attempt.think?.text ?? '',
        reasoningHidden: attempt.think?.hidden ?? 0,
        answer: attempt.answer?.text ?? '',
        answerHidden: attempt.answer?.hidden ?? 0,
        retryErrors: attempt.retryErrors,
      })),
    }));
  }

  return { handle, tick, reset, snapshot, flush };
}

// A collapsed "Model output" disclosure built from snapshot(), or null when nothing was received.
export function renderOutputDisclosure(doc, outputs) {
  const hasText = outputs?.some((pane) => pane.attempts.some((a) => a.reasoning || a.answer));
  if (!hasText) return null;
  const make = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const details = make('details', 'raw-out');
  details.append(make('summary', '', 'Model output'));
  for (const pane of outputs) {
    const stage = make('div', 'raw-stage');
    const head = make('p', 'raw-head');
    head.append(make('strong', '', pane.title), ' ', make('code', '', pane.model), ` (${STATUS_LABEL[pane.status] ?? pane.status})`);
    stage.append(head);
    for (const attempt of pane.attempts) {
      if (!attempt.reasoning && !attempt.answer) continue;
      if (pane.attempts.length > 1) stage.append(make('p', 'raw-attempt', `Attempt ${attempt.n}`));
      for (const [label, text, hidden] of [['Thinking', attempt.reasoning, attempt.reasoningHidden], ['Answer', attempt.answer, attempt.answerHidden]]) {
        if (!text) continue;
        stage.append(make('span', 'raw-label', label));
        if (hidden) stage.append(make('span', 'raw-hidden', `… earlier output hidden (${formatCount(hidden)})`));
        stage.append(make('pre', `raw-pre ${label === 'Thinking' ? 'raw-think' : ''}`.trim(), text));
      }
      if (attempt.retryErrors?.length) {
        const list = make('ul', 'raw-errors');
        for (const message of attempt.retryErrors) list.append(make('li', '', message));
        stage.append(make('span', 'raw-label', 'Why it was asked again'), list);
      }
    }
    if (pane.reason) stage.append(make('p', 'raw-reason', pane.reason));
    details.append(stage);
  }
  return details;
}
