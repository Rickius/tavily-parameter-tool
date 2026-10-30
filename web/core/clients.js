// Thin fetch wrappers for Token Factory and Tavily. No retries, so a stalled call fails visibly.
// Error messages carry only an HTTP status or "no response": never the provider's text, a request body or a key.

const TOKEN_FACTORY_URL = 'https://api.tokenfactory.nebius.com/v1';
const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

export class UpstreamError extends Error {
  constructor(status = null) {
    super(status ? `HTTP ${status}` : 'no response');
    this.name = 'UpstreamError';
    this.status = status;
  }
}

export class UpstreamTimeout extends Error {
  constructor() {
    super('timed out');
    this.name = 'UpstreamTimeout';
  }
}

export const describeUpstream = (error) => (error?.status ? `HTTP ${error.status}` : 'no response');

async function request(fetchImpl, url, { apiKey, body, timeoutMs, signal, readBody = (response) => response.json() }) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await fetchImpl(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel?.();
      throw new UpstreamError(response.status);
    }
    return await readBody(response);
  } catch (error) {
    if (error instanceof UpstreamError || error instanceof UpstreamTimeout) throw error;
    if (timedOut) throw new UpstreamTimeout();
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); // the caller cancelled; not a failure to report
    throw new UpstreamError(); // a network failure or an unreadable body
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// Reads an OpenAI-style server-sent event stream and returns what a non-streaming call would have returned:
// { choices: [{ message: { role, content, reasoning_content? }, finish_reason }], usage? }.
// onDelta({ kind: 'content' | 'reasoning', text }) is called for every piece of text as it arrives.
// Lines may be split across network chunks, use CRLF, or be comments; a data line that is not valid JSON is skipped.
async function readChatStream(response, onDelta) {
  if (!response.body) throw new UpstreamError();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let content = '';
  let reasoning = '';
  let finishReason = null;
  let usage;
  let pending = '';
  let done = false;

  const emit = (kind, text) => {
    try {
      onDelta({ kind, text });
    } catch {
      // a broken progress display must not break the call
    }
  };

  const handleLine = (line) => {
    if (!line.startsWith('data:')) return; // comments (": keepalive"), event:, id: and retry: lines
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') {
      done = true;
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      return;
    }
    if (chunk?.error) throw new UpstreamError(); // the provider failed mid-stream; its text is never shown
    if (chunk?.usage) usage = chunk.usage;
    const choice = chunk?.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    const thinking = delta.reasoning_content ?? delta.reasoning;
    if (typeof thinking === 'string' && thinking) {
      reasoning += thinking;
      emit('reasoning', thinking);
    }
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      emit('content', delta.content);
    }
  };

  while (!done) {
    const { value, done: ended } = await reader.read();
    if (ended) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split(/\r\n|\n|\r/);
    pending = lines.pop(); // the last piece may be half a line
    for (const line of lines) handleLine(line);
  }
  pending += decoder.decode();
  if (!done && pending) handleLine(pending);
  if (done) await reader.cancel().catch(() => {});

  const message = { role: 'assistant', content, ...(reasoning ? { reasoning_content: reasoning } : {}) };
  return { choices: [{ message, finish_reason: finishReason }], ...(usage ? { usage } : {}) };
}

export function createTokenFactory({ apiKey, fetchImpl = fetch, baseUrl = TOKEN_FACTORY_URL }) {
  return {
    // With onDelta the answer is streamed and the text is reported as it arrives; the return value has the same shape either way.
    chat: (body, { timeoutMs, signal, onDelta } = {}) =>
      onDelta
        ? request(fetchImpl, `${baseUrl}/chat/completions`, { apiKey, body: { ...body, stream: true }, timeoutMs, signal, readBody: (response) => readChatStream(response, onDelta) })
        : request(fetchImpl, `${baseUrl}/chat/completions`, { apiKey, body, timeoutMs, signal }),
    async listModels({ timeoutMs, signal } = {}) {
      const data = await request(fetchImpl, `${baseUrl}/models`, { apiKey, timeoutMs, signal });
      return (data.data ?? []).map((model) => model.id);
    },
  };
}

export function createTavily({ apiKey, fetchImpl = fetch, url = TAVILY_SEARCH_URL }) {
  return {
    search: (body, { timeoutMs, signal } = {}) => request(fetchImpl, url, { apiKey, body, timeoutMs, signal }),
  };
}
