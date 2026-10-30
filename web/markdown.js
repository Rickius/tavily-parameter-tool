// A small markdown renderer for model answers. The text is untrusted, so the rules are strict:
// - no raw HTML: tags and entities are shown exactly as typed;
// - links only when the address is http or https; anything else (javascript:, data:, relative, protocol-relative) is shown as text;
// - images are never loaded: the alt text and the address are shown as text;
// - the DOM is built with createElement and textContent only, never from an HTML string.
// Supported: headings, paragraphs, **bold**, *italic*, ~~strike~~, `code`, fenced code, bullet, numbered and task lists with
// nesting, blockquotes, rules, tables, links and bare web addresses. Not supported: setext headings, indented code blocks,
// reference-style links, footnotes, raw HTML blocks and <autolinks>. Everything runs in linear time: see the budgets below.

const MAX_DEPTH = 16; // nested lists and quotes; deeper content is shown as a plain paragraph
const MAX_DELIMS = 500; // emphasis runs per paragraph; further runs are shown as typed
const SCAN_BUDGET = 100000; // characters scanned while reading link destinations in one paragraph
const MAX_URL = 2048;

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const WHITESPACE = /\s/;
const PUNCT = /[\p{P}\p{S}]/u;
const URL_IN_TEXT = /https?:\/\/[^\s<>]+/gi;
const SPECIAL = /[\\\n`*_~![\]]/g;

// ---------- addresses ----------

// Returns the normalized address when `raw` is an absolute http or https URL, otherwise null.
export function safeHttpUrl(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > MAX_URL || /[\u0000-\u0020\u007f-\u009f]/.test(s)) return null;
  if (!/^https?:\/\/[^/?#]/i.test(s)) return null;
  try {
    const url = new URL(s);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname ? url.href : null;
  } catch {
    return null;
  }
}

// ---------- blocks ----------

export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map(expandTabs);
  return parseBlocks(lines, 0);
}

function expandTabs(line) {
  let n = 0;
  while (line[n] === '\t' || line[n] === ' ') n++;
  const lead = line.slice(0, n);
  return lead.includes('\t') ? lead.replace(/\t/g, '    ') + line.slice(n) : line;
}

const isBlank = (line) => line.trim() === '';
const indentOf = (line) => {
  let n = 0;
  while (line[n] === ' ') n++;
  return n;
};

function matchFence(line) {
  const indent = indentOf(line);
  if (indent > 3) return null;
  const ch = line[indent];
  if (ch !== '`' && ch !== '~') return null;
  let n = indent;
  while (line[n] === ch) n++;
  const length = n - indent;
  if (length < 3) return null;
  const info = line.slice(n).trim();
  if (ch === '`' && info.includes('`')) return null;
  return { ch, length, indent, lang: info.split(/\s/, 1)[0].slice(0, 30) };
}

function matchHeading(line) {
  const indent = indentOf(line);
  if (indent > 3 || line[indent] !== '#') return null;
  let n = indent;
  while (line[n] === '#') n++;
  const level = n - indent;
  if (level > 6 || (n < line.length && line[n] !== ' ' && line[n] !== '\t')) return null;
  let content = line.slice(n).trim();
  let end = content.length;
  while (end > 0 && content[end - 1] === '#') end--;
  if (end < content.length && (end === 0 || content[end - 1] === ' ')) content = content.slice(0, end).trimEnd();
  return { level, content };
}

function isHr(line) {
  const t = line.trim();
  if (t.length < 3 || indentOf(line) > 3) return false;
  const ch = t[0];
  if (ch !== '-' && ch !== '*' && ch !== '_') return false;
  let count = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === ch) count++;
    else if (t[i] !== ' ' && t[i] !== '\t') return false;
  }
  return count >= 3;
}

const isQuote = (line) => indentOf(line) <= 3 && line[indentOf(line)] === '>';

// A list marker: "-", "*", "+", "1." or "1)" followed by a space or the end of the line.
function matchMarker(line) {
  const indent = indentOf(line);
  const ch = line[indent];
  let n = indent;
  let ordered = false;
  let number = 0;
  if (ch === '-' || ch === '*' || ch === '+') {
    n++;
  } else if (ch >= '0' && ch <= '9') {
    while (line[n] >= '0' && line[n] <= '9') n++;
    if (n - indent > 9 || (line[n] !== '.' && line[n] !== ')')) return null;
    ordered = true;
    number = Number(line.slice(indent, n));
    n++;
  } else {
    return null;
  }
  if (n < line.length && line[n] !== ' ') return null;
  if (isHr(line)) return null;
  let spaces = 0;
  while (line[n + spaces] === ' ') spaces++;
  const rest = line.slice(n + spaces);
  const offset = rest === '' || spaces > 4 ? n + 1 : n + spaces;
  return { indent, ordered, number, content: rest === '' ? '' : line.slice(offset), offset };
}

function splitRow(line) {
  let s = line.trim();
  if (s[0] === '|') s = s.slice(1);
  const cells = [];
  let cell = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (c === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += c;
    }
  }
  if (cell.trim() !== '' || s.length === 0 || s[s.length - 1] !== '|') cells.push(cell.trim());
  return cells;
}

function tableStart(lines, i) {
  if (i + 1 >= lines.length || !lines[i].includes('|') || !lines[i + 1].includes('|') || !lines[i + 1].includes('-')) return null;
  const delim = splitRow(lines[i + 1]);
  if (!delim.length || !delim.every((cell) => /^:?-+:?$/.test(cell))) return null;
  const header = splitRow(lines[i]);
  if (header.length !== delim.length) return null;
  return { header, delim };
}

function startsBlock(lines, i) {
  const line = lines[i];
  if (matchFence(line) || matchHeading(line) || isHr(line) || isQuote(line) || tableStart(lines, i)) return true;
  const marker = matchMarker(line);
  return marker !== null && (!marker.ordered || marker.number === 1);
}

function plainParagraph(text) {
  return text.trim() ? [{ type: 'paragraph', children: parseInline(text.trim()) }] : [];
}

function parseBlocks(lines, depth) {
  if (depth >= MAX_DEPTH) return plainParagraph(lines.join('\n'));
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = matchFence(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length) {
        const close = matchFence(lines[i]);
        if (close && close.ch === fence.ch && close.length >= fence.length && lines[i].trim() === fence.ch.repeat(close.length)) break;
        body.push(lines[i].slice(Math.min(indentOf(lines[i]), fence.indent)));
        i++;
      }
      i++;
      blocks.push({ type: 'code', lang: fence.lang, text: body.join('\n') });
      continue;
    }

    const heading = matchHeading(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading.level, children: parseInline(heading.content) });
      i++;
      continue;
    }

    if (isHr(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    if (isQuote(line)) {
      const inner = [];
      while (i < lines.length && !isBlank(lines[i])) {
        if (isQuote(lines[i])) {
          const at = indentOf(lines[i]) + 1;
          inner.push(lines[i].slice(lines[i][at] === ' ' ? at + 1 : at));
        } else if (startsBlock(lines, i)) {
          break;
        } else {
          inner.push(lines[i]);
        }
        i++;
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(inner, depth + 1) });
      continue;
    }

    if (matchMarker(line)) {
      const result = parseList(lines, i, depth);
      blocks.push(result.block);
      i = result.next;
      continue;
    }

    const table = tableStart(lines, i);
    if (table) {
      const align = table.delim.map((cell) => (cell[0] === ':' && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell[0] === ':' ? 'left' : null));
      const rows = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) {
        const cells = splitRow(lines[i]);
        rows.push(table.header.map((_, k) => parseInline(cells[k] ?? '')));
        i++;
      }
      blocks.push({ type: 'table', align, header: table.header.map((cell) => parseInline(cell)), rows });
      continue;
    }

    const para = [line.trim()];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i)) {
      para.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: 'paragraph', children: parseInline(para.map((l) => (l.endsWith('\\') && !l.endsWith('\\\\') ? l.slice(0, -1) : l)).join('\n')) });
  }
  return blocks;
}

function parseList(lines, start, depth) {
  const first = matchMarker(lines[start]);
  const base = first.indent;
  const items = [];
  let i = start;
  while (i < lines.length) {
    const marker = matchMarker(lines[i]);
    if (!marker || marker.ordered !== first.ordered || marker.indent > base + 1 || marker.indent < base - 1) break;
    const itemLines = [marker.content];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (isBlank(l)) {
        let k = j + 1;
        while (k < lines.length && isBlank(lines[k])) k++;
        if (k >= lines.length || indentOf(lines[k]) < base + 2) break;
        for (let b = j; b < k; b++) itemLines.push('');
        j = k;
        continue;
      }
      const ind = indentOf(l);
      if (ind >= base + 2) {
        itemLines.push(l.slice(Math.min(ind, base + 2)));
      } else if (isBlank(lines[j - 1]) || matchMarker(l) || startsBlock(lines, j)) {
        break;
      } else {
        itemLines.push(l.trim());
      }
      j++;
    }
    let task = null;
    const box = /^\[( |x|X)\](?: |$)/.exec(itemLines[0]);
    if (box) {
      task = box[1] !== ' ';
      itemLines[0] = itemLines[0].slice(box[0].length);
    }
    items.push({ task, blocks: parseBlocks(itemLines, depth + 1) });
    i = j;
    let k = i;
    while (k < lines.length && isBlank(lines[k])) k++;
    const next = k < lines.length ? matchMarker(lines[k]) : null;
    if (next && next.ordered === first.ordered && next.indent <= base + 1 && next.indent >= base - 1) i = k;
    else break;
  }
  return { block: { type: 'list', ordered: first.ordered, start: first.ordered ? first.number : 1, items }, next: i };
}

// ---------- inline text ----------

export function parseInline(text) {
  const budget = { left: SCAN_BUDGET };
  const tokens = tokenize(text, budget);
  resolveEmphasis(tokens);
  return linkify(assemble(tokens));
}

// For each backtick run, the index of the next run of the same length (or -1), computed once so code spans cost O(n).
function backtickRuns(text) {
  const runs = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '`') continue;
    let j = i;
    while (text[j] === '`') j++;
    runs.push({ pos: i, length: j - i, next: -1 });
    i = j - 1;
  }
  const seen = new Map();
  for (let r = runs.length - 1; r >= 0; r--) {
    runs[r].next = seen.has(runs[r].length) ? seen.get(runs[r].length) : -1;
    seen.set(runs[r].length, r);
  }
  return runs;
}

function parseDestination(text, at, budget) {
  const n = text.length;
  if (text[at] !== '(') return null;
  let i = at + 1;
  while (i < n && (text[i] === ' ' || text[i] === '\n')) i++;
  let url;
  if (text[i] === '<') {
    const begin = i + 1;
    let j = begin;
    while (j < n && text[j] !== '>' && text[j] !== '<' && text[j] !== '\n') {
      if (--budget.left < 0 || j - begin > MAX_URL) return null;
      j++;
    }
    if (text[j] !== '>') return null;
    url = text.slice(begin, j);
    i = j + 1;
  } else {
    const begin = i;
    let depth = 0;
    while (i < n) {
      if (--budget.left < 0) return null;
      const c = text[i];
      if (c === ' ' || c === '\n' || c === '\t') break;
      if (c === '\\' && i + 1 < n) {
        i += 2;
        continue;
      }
      if (c === '(') {
        if (++depth > 32) return null;
      } else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      i++;
    }
    url = text.slice(begin, i).replace(/\\([!-/:-@[-`{-~])/g, '$1');
  }
  while (i < n && (text[i] === ' ' || text[i] === '\n')) i++;
  const open = text[i];
  if (open === '"' || open === "'" || open === '(') {
    const close = open === '(' ? ')' : open;
    let j = i + 1;
    while (j < n && text[j] !== close) {
      if (--budget.left < 0 || j - i > 1000) return null;
      if (text[j] === '\\') j++;
      j++;
    }
    if (text[j] !== close) return null;
    i = j + 1;
    while (i < n && (text[i] === ' ' || text[i] === '\n')) i++;
  }
  return text[i] === ')' ? { url, end: i + 1 } : null;
}

function tokenize(text, budget) {
  const tokens = [];
  const openers = [];
  const runs = backtickRuns(text);
  const runAt = new Map(runs.map((run, index) => [run.pos, index]));
  const n = text.length;
  let buf = '';
  let delimRuns = 0;
  let i = 0;
  const flush = () => {
    if (buf) tokens.push({ t: 'text', s: buf });
    buf = '';
  };

  while (i < n) {
    SPECIAL.lastIndex = i;
    const hit = SPECIAL.exec(text);
    if (!hit) {
      buf += text.slice(i);
      break;
    }
    buf += text.slice(i, hit.index);
    i = hit.index;
    const c = text[i];

    if (c === '\\') {
      const next = text[i + 1];
      if (next === '\n') {
        flush();
        tokens.push({ t: 'br' });
        i += 2;
        while (text[i] === ' ') i++;
      } else if (next !== undefined && ASCII_PUNCT.test(next)) {
        buf += next;
        i += 2;
      } else {
        buf += '\\';
        i++;
      }
    } else if (c === '\n') {
      let end = buf.length;
      while (end > 0 && buf[end - 1] === ' ') end--;
      buf = buf.slice(0, end);
      flush();
      tokens.push({ t: 'br' });
      i++;
      while (text[i] === ' ') i++;
    } else if (c === '`') {
      const index = runAt.get(i);
      const run = index === undefined ? null : runs[index];
      const close = !run || run.next === -1 ? null : runs[run.next];
      if (!run) {
        buf += '`';
        i++;
      } else if (close) {
        let code = text.slice(i + run.length, close.pos).replace(/\n/g, ' ');
        if (code.length > 1 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim() !== '') code = code.slice(1, -1);
        flush();
        tokens.push({ t: 'code', s: code });
        i = close.pos + close.length;
      } else {
        buf += '`'.repeat(run.length);
        i += run.length;
      }
    } else if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (text[j] === c) j++;
      const count = j - i;
      if ((c === '~' && count !== 2) || delimRuns >= MAX_DELIMS) {
        buf += c.repeat(count);
      } else {
        delimRuns++;
        const before = i > 0 ? text[i - 1] : ' ';
        const after = j < n ? text[j] : ' ';
        const left = !WHITESPACE.test(after) && (!PUNCT.test(after) || WHITESPACE.test(before) || PUNCT.test(before));
        const right = !WHITESPACE.test(before) && (!PUNCT.test(before) || WHITESPACE.test(after) || PUNCT.test(after));
        flush();
        tokens.push({
          t: 'd', ch: c, count, orig: count, pairsOpen: [], pairsClose: [], alive: true, scope: 0,
          open: c === '_' ? left && (!right || PUNCT.test(before)) : left,
          close: c === '_' ? right && (!left || PUNCT.test(after)) : right,
        });
      }
      i = j;
    } else if (c === '!' && text[i + 1] === '[') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (--budget.left < 0) break;
        if (text[j] === '\\') j++;
        else if (text[j] === '[') depth++;
        else if (text[j] === ']') depth--;
        j++;
      }
      const dest = depth === 0 ? parseDestination(text, j, budget) : null;
      if (dest) {
        const alt = text.slice(i + 2, j - 1).replace(/\n/g, ' ').trim();
        flush();
        tokens.push({ t: 'text', s: (alt || 'image') + (dest.url ? ` (${dest.url})` : ''), plain: true });
        i = dest.end;
      } else {
        buf += '!';
        i++;
      }
    } else if (c === '[') {
      flush();
      openers.push({ index: tokens.length, active: true });
      tokens.push({ t: 'bo' });
      i++;
    } else if (c === ']') {
      flush();
      const opener = openers.pop();
      const dest = opener && opener.active ? parseDestination(text, i + 1, budget) : null;
      if (dest) {
        tokens[opener.index] = { t: 'ls', raw: dest.url, href: safeHttpUrl(dest.url) };
        tokens.push({ t: 'le' });
        for (const other of openers) other.active = false;
        i = dest.end;
      } else {
        buf += ']';
        i++;
      }
    } else {
      buf += c;
      i++;
    }
  }
  flush();
  return tokens;
}

// The CommonMark delimiter-stack algorithm, recording matches on the tokens instead of rewriting the list.
function resolveEmphasis(tokens) {
  let scope = 0;
  let nextScope = 0;
  for (const token of tokens) {
    if (token.t === 'ls') scope = ++nextScope;
    if (token.t === 'd') token.scope = scope;
    if (token.t === 'le') scope = 0;
  }
  const stack = tokens.filter((token) => token.t === 'd');
  const bottoms = new Map();
  let ci = 0;
  while (ci < stack.length) {
    const closer = stack[ci];
    if (!closer.alive || !closer.close || closer.count === 0) {
      ci++;
      continue;
    }
    const key = `${closer.ch}|${closer.open ? 1 : 0}|${closer.orig % 3}`;
    const bottom = bottoms.has(key) ? bottoms.get(key) : -1;
    let found = -1;
    for (let oi = ci - 1; oi > bottom; oi--) {
      const o = stack[oi];
      if (!o.alive || !o.open || o.ch !== closer.ch || o.scope !== closer.scope || o.count === 0) continue;
      if (closer.ch === '~') {
        if (o.count >= 2 && closer.count >= 2) {
          found = oi;
          break;
        }
      } else if (!((closer.open || o.close) && (o.orig + closer.orig) % 3 === 0 && !(o.orig % 3 === 0 && closer.orig % 3 === 0))) {
        found = oi;
        break;
      }
    }
    if (found >= 0) {
      const o = stack[found];
      const use = closer.ch === '~' || (o.count >= 2 && closer.count >= 2) ? 2 : 1;
      const kind = closer.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
      o.pairsOpen.push(kind);
      closer.pairsClose.push(kind);
      o.count -= use;
      closer.count -= use;
      for (let k = found + 1; k < ci; k++) stack[k].alive = false;
      if (o.count === 0) o.alive = false;
      if (closer.count === 0) {
        closer.alive = false;
        ci++;
      }
    } else {
      bottoms.set(key, ci - 1);
      if (!closer.open) closer.alive = false;
      ci++;
    }
  }
}

function assemble(tokens) {
  const root = { kind: 'root', children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const add = (node) => top().children.push(node);
  const addText = (s) => {
    const last = top().children[top().children.length - 1];
    if (last && last.type === 'text' && !last.noLink) last.text += s;
    else add({ type: 'text', text: s });
  };
  const finish = (container) => {
    if (container.kind === 'link') {
      if (container.href) return { type: 'link', href: container.href, children: container.children };
      const shown = container.children.slice();
      if (container.raw) shown.push({ type: 'text', text: ` (${container.raw})`, noLink: true });
      return { type: 'group', children: shown };
    }
    return { type: container.kind, children: container.children };
  };
  const close = (kind) => {
    while (stack.length > 1) {
      const container = stack.pop();
      const node = finish(container);
      if (node.type === 'group') for (const child of node.children) mergeInto(top().children, child);
      else add(node);
      if (container.kind === kind) return;
    }
  };

  for (const token of tokens) {
    if (token.t === 'text') (token.plain ? add({ type: 'text', text: token.s, noLink: true }) : addText(token.s));
    else if (token.t === 'br') add({ type: 'br' });
    else if (token.t === 'code') add({ type: 'code', text: token.s });
    else if (token.t === 'bo') addText('[');
    else if (token.t === 'd') {
      for (const kind of token.pairsClose) close(kind);
      if (token.count > 0) addText(token.ch.repeat(token.count));
      for (let k = token.pairsOpen.length - 1; k >= 0; k--) stack.push({ kind: token.pairsOpen[k], children: [] });
    } else if (token.t === 'ls') stack.push({ kind: 'link', href: token.href, raw: token.raw, children: [] });
    else if (token.t === 'le') close('link');
  }
  while (stack.length > 1) close(top().kind);
  return root.children;
}

function mergeInto(children, node) {
  const last = children[children.length - 1];
  if (node.type === 'text' && last && last.type === 'text' && !node.noLink && !last.noLink) last.text += node.text;
  else children.push(node);
}

// Turns bare web addresses in plain text into links (never inside an existing link or code).
function linkify(nodes) {
  const out = [];
  for (const node of nodes) {
    if (node.type === 'text' && node.noLink) {
      out.push(node);
      continue;
    }
    if (node.type !== 'text') {
      out.push(node.children && node.type !== 'link' ? { ...node, children: linkify(node.children) } : node);
      continue;
    }
    let last = 0;
    for (const match of node.text.matchAll(URL_IN_TEXT)) {
      let url = match[0];
      for (;;) {
        const tail = url[url.length - 1];
        const unbalanced = tail === ')' && url.split(')').length > url.split('(').length;
        if (unbalanced || /[.,;:!?'"*_~\]]/.test(tail)) url = url.slice(0, -1);
        else break;
      }
      const href = safeHttpUrl(url);
      if (!href) continue;
      if (match.index > last) out.push({ type: 'text', text: node.text.slice(last, match.index) });
      out.push({ type: 'link', href, children: [{ type: 'text', text: url }] });
      last = match.index + url.length;
    }
    if (last < node.text.length) out.push({ type: 'text', text: node.text.slice(last) });
  }
  return out;
}

// ---------- DOM ----------

function make(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderInline(nodes, parent, doc) {
  for (const node of nodes) {
    if (node.type === 'text') {
      parent.appendChild(doc.createTextNode(node.text));
    } else if (node.type === 'br') {
      parent.appendChild(doc.createElement('br'));
    } else if (node.type === 'code') {
      parent.appendChild(make(doc, 'code', 'md-inline', node.text));
    } else if (node.type === 'link') {
      const href = safeHttpUrl(node.href);
      const target = href ? make(doc, 'a', 'md-link') : doc.createElement('span');
      if (href) {
        target.setAttribute('href', href);
        target.setAttribute('target', '_blank');
        target.setAttribute('rel', 'noopener noreferrer nofollow');
      }
      renderInline(node.children, target, doc);
      parent.appendChild(target);
    } else {
      const tag = node.type === 'strong' ? 'strong' : node.type === 'em' ? 'em' : 'del';
      const element = doc.createElement(tag);
      renderInline(node.children, element, doc);
      parent.appendChild(element);
    }
  }
}

function renderBlock(block, doc) {
  if (block.type === 'heading') {
    const heading = make(doc, `h${block.level}`, `md-h md-h${block.level}`);
    renderInline(block.children, heading, doc);
    return heading;
  }
  if (block.type === 'paragraph') {
    const p = doc.createElement('p');
    renderInline(block.children, p, doc);
    return p;
  }
  if (block.type === 'hr') return doc.createElement('hr');
  if (block.type === 'code') {
    const wrap = make(doc, 'div', 'md-code');
    if (block.lang) wrap.appendChild(make(doc, 'span', 'md-lang', block.lang));
    const pre = doc.createElement('pre');
    pre.appendChild(make(doc, 'code', '', block.text));
    wrap.appendChild(pre);
    return wrap;
  }
  if (block.type === 'quote') {
    const quote = doc.createElement('blockquote');
    for (const inner of block.blocks) quote.appendChild(renderBlock(inner, doc));
    return quote;
  }
  if (block.type === 'list') {
    const list = make(doc, block.ordered ? 'ol' : 'ul', 'md-list');
    if (block.ordered && block.start !== 1) list.setAttribute('start', String(block.start));
    for (const item of block.items) {
      const li = doc.createElement('li');
      if (item.task !== null) {
        li.className = 'md-task';
        const box = make(doc, 'span', 'md-box', item.task ? '☑' : '☐');
        box.setAttribute('aria-label', item.task ? 'done' : 'not done');
        li.appendChild(box);
      }
      for (const inner of item.blocks) li.appendChild(renderBlock(inner, doc));
      list.appendChild(li);
    }
    return list;
  }
  const wrap = make(doc, 'div', 'md-table');
  wrap.setAttribute('tabindex', '0');
  wrap.setAttribute('role', 'region');
  wrap.setAttribute('aria-label', 'Table');
  const table = doc.createElement('table');
  const cellClass = (index) => (block.align[index] ? `md-al-${block.align[index]}` : '');
  const head = doc.createElement('tr');
  block.header.forEach((cell, index) => {
    const th = make(doc, 'th', cellClass(index));
    renderInline(cell, th, doc);
    head.appendChild(th);
  });
  const thead = doc.createElement('thead');
  thead.appendChild(head);
  table.appendChild(thead);
  const tbody = doc.createElement('tbody');
  for (const row of block.rows) {
    const tr = doc.createElement('tr');
    row.forEach((cell, index) => {
      const td = make(doc, 'td', cellClass(index));
      renderInline(cell, td, doc);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

export function renderMarkdown(text, doc) {
  const fragment = doc.createDocumentFragment();
  for (const block of parseMarkdown(text)) fragment.appendChild(renderBlock(block, doc));
  return fragment;
}
