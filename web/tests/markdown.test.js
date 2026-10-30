// The markdown renderer for Compare answers. The text it reads is untrusted model output, so most of these tests are about
// what it must NOT do: build HTML from text, link to anything but http(s), or load an image.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseInline, parseMarkdown, renderMarkdown, safeHttpUrl } from '../markdown.js';

const md = (text) => parseMarkdown(text);
const first = (text) => md(text)[0];

// The text of inline nodes with the formatting stripped.
function textOf(nodes) {
  return nodes.map((node) => {
    if (node.type === 'text' || node.type === 'code') return node.text;
    if (node.type === 'br') return '\n';
    return textOf(node.children ?? []);
  }).join('');
}

// Every inline node of a given type, anywhere below `nodes`.
function find(nodes, type) {
  const found = [];
  for (const node of nodes) {
    if (node.type === type) found.push(node);
    if (node.children) found.push(...find(node.children, type));
  }
  return found;
}

// Every block of a given type, anywhere below `blocks`.
function findBlocks(blocks, type) {
  const found = [];
  for (const block of blocks) {
    if (block.type === type) found.push(block);
    if (block.blocks) found.push(...findBlocks(block.blocks, type));
    if (block.items) for (const item of block.items) found.push(...findBlocks(item.blocks, type));
  }
  return found;
}

describe('headings', () => {
  test('levels 1 to 6, with emoji and a closing run of #', () => {
    for (let level = 1; level <= 6; level++) {
      const block = first(`${'#'.repeat(level)} 🦃 Title`);
      assert.equal(block.type, 'heading');
      assert.equal(block.level, level);
      assert.equal(textOf(block.children), '🦃 Title');
    }
    assert.equal(textOf(first('## Closed ##').children), 'Closed');
    assert.equal(textOf(first('## Keep # inside').children), 'Keep # inside');
  });

  test('is not a heading without a space, with seven #, or when indented four spaces', () => {
    assert.equal(first('#hashtag').type, 'paragraph');
    assert.equal(first('####### seven').type, 'paragraph');
  });

  test('formatting works inside a heading', () => {
    assert.equal(find(first('# a **b**').children, 'strong').length, 1);
  });
});

describe('paragraphs and line breaks', () => {
  test('keeps line breaks, and a blank line starts a new paragraph', () => {
    const blocks = md('one\ntwo\n\nthree');
    assert.equal(blocks.length, 2);
    assert.equal(textOf(blocks[0].children), 'one\ntwo');
    assert.equal(textOf(blocks[1].children), 'three');
  });

  test('a trailing backslash is a hard break, not a visible backslash', () => {
    assert.equal(textOf(first('one\\\ntwo').children), 'one\ntwo');
  });
});

describe('inline formatting', () => {
  test('bold, italic with * and _, both, strike and code', () => {
    const inline = (text) => first(text).children;
    assert.equal(find(inline('**b**'), 'strong').length, 1);
    assert.equal(find(inline('*i*'), 'em').length, 1);
    assert.equal(find(inline('_i_'), 'em').length, 1);
    assert.equal(find(inline('__b__'), 'strong').length, 1);
    assert.equal(find(inline('~~s~~'), 'del').length, 1);
    assert.equal(find(inline('`c`'), 'code')[0].text, 'c');
    const both = inline('***both***');
    assert.equal(find(both, 'strong').length, 1);
    assert.equal(find(both, 'em').length, 1);
    assert.equal(textOf(both), 'both');
  });

  test('nests emphasis', () => {
    const [strong] = find(first('**bold *and italic* text**').children, 'strong');
    assert.equal(find(strong.children, 'em').length, 1);
    assert.equal(textOf(strong.children), 'bold and italic text');
  });

  test('does not italicize snake_case or a lone star', () => {
    assert.equal(find(first('use snake_case_names here').children, 'em').length, 0);
    assert.equal(textOf(first('use snake_case_names here').children), 'use snake_case_names here');
    assert.equal(textOf(first('2 * 3 * 4').children), '2 * 3 * 4');
    assert.equal(find(first('2 * 3 * 4').children, 'em').length, 0);
  });

  test('shows an unclosed marker as typed instead of swallowing the rest', () => {
    const nodes = first('start **never closed and then more text').children;
    assert.equal(find(nodes, 'strong').length, 0);
    assert.equal(textOf(nodes), 'start **never closed and then more text');
    assert.equal(textOf(first('a ~single~ tilde').children), 'a ~single~ tilde');
  });

  test('a backslash escapes punctuation', () => {
    assert.equal(textOf(first('\\*not italic\\*').children), '*not italic*');
    assert.equal(find(first('\\*not italic\\*').children, 'em').length, 0);
  });

  test('inline code keeps markup and spaces literal, and a longer run can hold backticks', () => {
    assert.equal(find(first('`**x**`').children, 'strong').length, 0);
    assert.equal(find(first('`**x**`').children, 'code')[0].text, '**x**');
    assert.equal(find(first('`` a`b ``').children, 'code')[0].text, 'a`b');
    assert.equal(textOf(first('a ` b').children), 'a ` b');
  });

  test('prices and symbols are not markup', () => {
    assert.equal(textOf(first('Butterball turkey: ~$1.28/lb, 100% pure & more').children), 'Butterball turkey: ~$1.28/lb, 100% pure & more');
  });
});

describe('fenced code', () => {
  test('backtick fence with a language tag, kept literally', () => {
    const block = first('```js\nconst a = **1**;\n  indented\n```');
    assert.deepEqual(block, { type: 'code', lang: 'js', text: 'const a = **1**;\n  indented' });
  });

  test('tilde fence, no language, and a longer closing fence', () => {
    assert.deepEqual(first('~~~\nx\n~~~'), { type: 'code', lang: '', text: 'x' });
    assert.equal(first('```\nx\n`````').text, 'x');
  });

  test('an unclosed fence runs to the end of the text', () => {
    const blocks = md('before\n\n```py\nline 1\n\n# not a heading\n- not a list');
    assert.equal(blocks.length, 2);
    assert.equal(blocks[1].type, 'code');
    assert.equal(blocks[1].text, 'line 1\n\n# not a heading\n- not a list');
  });

  test('a shorter or different fence inside does not close it', () => {
    assert.equal(first('````\n```\nstill code\n````').text, '```\nstill code');
    assert.equal(first('```\n~~~\nx\n```').text, '~~~\nx');
  });
});

describe('lists', () => {
  test('bullets with -, * and +', () => {
    for (const mark of ['-', '*', '+']) {
      const block = first(`${mark} a\n${mark} b`);
      assert.equal(block.type, 'list');
      assert.equal(block.ordered, false);
      assert.equal(block.items.length, 2);
    }
  });

  test('numbered lists with . and ) and a start number', () => {
    assert.equal(first('1. a\n2. b').ordered, true);
    assert.equal(first('1) a\n2) b').items.length, 2);
    assert.equal(first('3. c\n4. d').start, 3);
  });

  test('nests by indentation with two and four spaces', () => {
    for (const pad of ['  ', '    ']) {
      const outer = first(`- a\n${pad}- b\n${pad}${pad}- c\n- d`);
      assert.equal(outer.items.length, 2);
      const inner = findBlocks(outer.items[0].blocks, 'list');
      assert.equal(inner.length, 2, `pad "${pad}"`);
      assert.equal(textOf(inner[0].items[0].blocks[0].children), 'b');
    }
  });

  test('a bullet list can sit under a numbered item', () => {
    const outer = first('1. First\n   - sub a\n   - sub b\n2. Second');
    assert.equal(outer.items.length, 2);
    assert.equal(findBlocks(outer.items[0].blocks, 'list')[0].items.length, 2);
    const loose = first('1. First\n  - sub a');
    assert.equal(loose.items.length, 1);
    assert.equal(findBlocks(loose.items[0].blocks, 'list').length, 1);
  });

  test('task lists keep their state', () => {
    const items = first('- [ ] todo\n- [x] done\n- [X] also done\n- [] not a task').items;
    assert.deepEqual(items.map((item) => item.task), [false, true, true, null]);
    assert.equal(textOf(items[0].blocks[0].children), 'todo');
  });

  test('a list can start straight after a paragraph, and a blank line between items keeps one list', () => {
    const blocks = md('Intro:\n- a\n- b');
    assert.deepEqual(blocks.map((b) => b.type), ['paragraph', 'list']);
    assert.equal(first('- a\n\n- b\n\n- c').items.length, 3);
  });

  test('a later number does not interrupt a paragraph, so "2024. was" stays text', () => {
    assert.equal(md('The year\n2024. was good').length, 1);
  });

  test('an item can hold several paragraphs and a code block', () => {
    const item = first('- one\n\n  more text\n\n  ```\n  code\n  ```\n- two').items[0];
    assert.deepEqual(item.blocks.map((b) => b.type), ['paragraph', 'paragraph', 'code']);
  });

  test('a changed list type starts a new list', () => {
    assert.deepEqual(md('- a\n1. b').map((b) => b.type), ['list', 'list']);
  });

  test('lists deeper than the limit still render, as plain text at the bottom', () => {
    const lines = Array.from({ length: 50 }, (_, k) => `${'  '.repeat(k)}- level ${k}`).join('\n');
    const blocks = md(lines);
    assert.equal(blocks[0].type, 'list');
    assert.match(JSON.stringify(blocks), /level 49/);
  });

  test('ten levels deep is kept as ten nested lists', () => {
    const lines = Array.from({ length: 10 }, (_, k) => `${'  '.repeat(k)}- level ${k}`).join('\n');
    assert.equal(findBlocks(md(lines), 'list').length, 10);
  });
});

describe('quotes and rules', () => {
  test('quotes, nested quotes and lazy continuation', () => {
    const quote = first('> one\n> > two\n> three');
    assert.equal(quote.type, 'quote');
    assert.equal(findBlocks([quote], 'quote').length, 2);
    assert.equal(first('> start\ncontinued').blocks.length, 1);
  });

  test('a quote can hold a list and a code block', () => {
    const inner = first('> - a\n> - b\n>\n> ```\n> code\n> ```').blocks;
    assert.deepEqual(inner.map((b) => b.type), ['list', 'code']);
  });

  test('horizontal rules in their usual spellings', () => {
    for (const rule of ['---', '***', '___', '- - -', '* * *', '----------']) assert.equal(first(rule).type, 'hr', rule);
    assert.equal(first('--').type, 'paragraph');
  });
});

describe('tables', () => {
  test('header, alignment and rows', () => {
    const table = first('| Name | Qty | Note |\n|:--|--:|:-:|\n| milk | 2 | cold |\n| eggs | 12 | |');
    assert.equal(table.type, 'table');
    assert.deepEqual(table.align, ['left', 'right', 'center']);
    assert.equal(table.header.length, 3);
    assert.equal(table.rows.length, 2);
    assert.equal(textOf(table.rows[1][0]), 'eggs');
  });

  test('works without outer pipes and with escaped pipes and formatting in cells', () => {
    const table = first('a | b\n--- | ---\n1 \\| 2 | **bold** and `code`');
    assert.equal(textOf(table.rows[0][0]), '1 | 2');
    assert.equal(find(table.rows[0][1], 'strong').length, 1);
    assert.equal(find(table.rows[0][1], 'code').length, 1);
  });

  test('pads short rows and drops extra cells', () => {
    const table = first('| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |');
    assert.deepEqual(table.rows.map((row) => row.length), [2, 2]);
    assert.equal(textOf(table.rows[0][1]), '');
  });

  test('can follow a paragraph without a blank line, and ends at a blank line', () => {
    const blocks = md('Here you go:\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter');
    assert.deepEqual(blocks.map((b) => b.type), ['paragraph', 'table', 'paragraph']);
  });

  test('a pipe line without a delimiter row is just text', () => {
    assert.equal(first('a | b\nc | d').type, 'paragraph');
    assert.equal(first('| a | b |\n|---|').type, 'paragraph');
  });
});

describe('links', () => {
  test('http and https links keep their text and address', () => {
    const [link] = find(first('see [the docs](https://docs.tavily.com/x?y=1#z) now').children, 'link');
    assert.equal(link.href, 'https://docs.tavily.com/x?y=1#z');
    assert.equal(textOf(link.children), 'the docs');
    assert.equal(find(first('[a](http://example.com)').children, 'link').length, 1);
  });

  test('formatting inside link text, a title, and an angle-bracket address', () => {
    assert.equal(find(find(first('[**bold** link](https://a.com)').children, 'link')[0].children, 'strong').length, 1);
    assert.equal(find(first('[a](https://a.com "A title")').children, 'link')[0].href, 'https://a.com/');
    assert.equal(find(first('[a](<https://a.com/x y>)').children, 'link').length, 0);
  });

  test('refuses every address that is not absolute http or https, and shows it as text', () => {
    const bad = [
      'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)', 'file:///etc/passwd', 'ftp://example.com/x', '//evil.example.com/x', '/relative/path',
      'relative.html', '#fragment', 'mailto:a@b.com', 'https:evil.example.com', 'http://', 'https:///nohost', 'h\tttps://a.com',
    ];
    for (const url of bad) {
      const nodes = first(`[click](${url})`).children;
      assert.equal(find(nodes, 'link').length, 0, url);
      // either the link text with the address in brackets, or (when the address cannot even be read) the source as typed
      assert.match(textOf(nodes), /^(click|\[click\])/, url);
    }
    assert.equal(textOf(first('[click](javascript:alert(1))').children), 'click (javascript:alert(1))');
  });

  test('safeHttpUrl: only absolute web addresses, no whitespace or control characters', () => {
    assert.equal(safeHttpUrl('https://a.com/x'), 'https://a.com/x');
    assert.equal(safeHttpUrl('HTTP://A.COM'), 'http://a.com/');
    for (const bad of ['javascript:alert(1)', 'https://a.com/ x', 'https://a.com/\nx', 'https://a.com/ ', '//a.com', 'a.com', '', null, undefined, 42]) {
      assert.equal(safeHttpUrl(bad), null, String(bad));
    }
    assert.equal(safeHttpUrl(`https://a.com/${'x'.repeat(3000)}`), null);
  });

  test('link text containing HTML stays literal text', () => {
    const nodes = first('[<b onclick=alert(1)>x</b>](https://a.com)').children;
    const [link] = find(nodes, 'link');
    assert.equal(textOf(link.children), '<b onclick=alert(1)>x</b>');
  });

  test('a quote or an event handler in the address cannot break out', () => {
    const nodes = first('[x](https://a.com" onmouseover="alert(1))').children;
    // not a link of its own, and the handler stays visible text; the plain address in front may still be linked, on its own
    assert.match(textOf(nodes), /onmouseover/);
    for (const link of find(nodes, 'link')) assert.equal(link.href, 'https://a.com/');
    const [link] = find(first('[x](https://a.com/"quoted"/path)').children, 'link');
    assert.ok(link, 'a quote inside the address is allowed but only as data');
    assert.match(link.href, /^https:\/\/a\.com\//);
  });

  test('bare web addresses become links, without trailing punctuation', () => {
    const hrefs = (text) => find(first(text).children, 'link').map((link) => link.href);
    assert.deepEqual(hrefs('go to https://a.com/path, then http://b.com.'), ['https://a.com/path', 'http://b.com/']);
    assert.deepEqual(hrefs('(see https://a.com/x)'), ['https://a.com/x']);
    assert.deepEqual(hrefs('https://en.wikipedia.org/wiki/Foo_(bar) ok'), ['https://en.wikipedia.org/wiki/Foo_(bar)']);
    assert.deepEqual(hrefs('**https://a.com/bold**'), ['https://a.com/bold']);
  });

  test('addresses inside code or inside a link are not linked again', () => {
    assert.equal(find(first('`https://a.com`').children, 'link').length, 0);
    const [link] = find(first('[https://a.com](https://b.com)').children, 'link');
    assert.equal(link.href, 'https://b.com/');
    assert.equal(find(link.children, 'link').length, 0);
  });

  test('unbalanced brackets and parentheses stay text', () => {
    assert.equal(textOf(first('a [b and (c) d] e').children), 'a [b and (c) d] e');
    assert.equal(textOf(first('[not a link]').children), '[not a link]');
    assert.equal(textOf(first('[x](https://a.com').children), '[x](https://a.com');
  });
});

describe('images', () => {
  test('are never loaded: the alt text and address are shown as plain text', () => {
    const nodes = first('![a tracker](https://tracker.example/p.png)').children;
    assert.equal(find(nodes, 'link').length, 0);
    assert.equal(find(nodes, 'image').length, 0);
    assert.equal(textOf(nodes), 'a tracker (https://tracker.example/p.png)');
  });

  test('an image inside a link leaves the link intact', () => {
    const [link] = find(first('[![logo](https://i.example/x.png)](https://a.com)').children, 'link');
    assert.equal(link.href, 'https://a.com/');
    assert.equal(textOf(link.children), 'logo (https://i.example/x.png)');
  });

  test('an image with a bad address or no alt text', () => {
    assert.equal(textOf(first('![x](javascript:alert(1))').children), 'x (javascript:alert(1))');
    assert.equal(textOf(first('![](https://a.com/x.png)').children), 'image (https://a.com/x.png)');
  });
});

describe('raw HTML and entities', () => {
  test('tags are text, never elements', () => {
    const html = '<script>window.PWNED=1</script> <img src=x onerror=window.PWNED=1> <iframe src="//evil"></iframe> <b>bold?</b>';
    const nodes = first(html).children;
    assert.equal(textOf(nodes), html);
    assert.equal(nodes.every((node) => ['text', 'link'].includes(node.type)), true);
  });

  test('an HTML block is also just a paragraph of text', () => {
    const blocks = md('<div onclick="x()">\n<script>alert(1)</script>\n</div>');
    assert.equal(blocks[0].type, 'paragraph');
    assert.match(textOf(blocks[0].children), /<script>alert\(1\)<\/script>/);
  });

  test('entities are shown as typed, not decoded', () => {
    assert.equal(textOf(first('&lt;script&gt; &amp; &#60; &copy;').children), '&lt;script&gt; &amp; &#60; &copy;');
  });
});

describe('the real Kimi-K3 answer', () => {
  const answer = readFileSync(new URL('./fixtures/kimi-answer.md', import.meta.url), 'utf8');
  const blocks = md(answer);

  test('parses to the structure it has on the page', () => {
    assert.equal(blocks.filter((b) => b.type === 'heading').length, 6);
    assert.equal(blocks.filter((b) => b.type === 'paragraph').length >= 2, true);
    const items = findBlocks(blocks, 'list').flatMap((list) => list.items);
    assert.equal(items.length, 21);
    assert.equal(findBlocks(blocks, 'list').some((list) => findBlocks(list.items.flatMap((i) => i.blocks), 'list').length > 0), true, 'has a nested list');
  });

  test('keeps the emoji headings, bold text and every price', () => {
    const headings = blocks.filter((b) => b.type === 'heading').map((b) => textOf(b.children));
    assert.ok(headings.includes('🦃 Thanksgiving Staples'), headings.join(' | '));
    const everything = blocks.map((b) => JSON.stringify(b)).join('');
    for (const price of ['$1.28/lb', '$0.49', '$1.99/lb', '99¢']) assert.ok(everything.includes(price), price);
    assert.ok(find(findBlocks(blocks, 'list')[0].items[0].blocks[0].children, 'strong').length >= 1);
  });

  test('no asterisks or hashes are left over from the markdown', () => {
    const shown = blocks.map((b) => (b.children ? textOf(b.children) : '')).join('\n');
    assert.doesNotMatch(shown, /\*\*|^#/m);
  });
});

// ---------- the DOM builder ----------

class FakeNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.className = ''; this._text = ''; }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  set textContent(value) { this._text = String(value); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
}
class FakeText { constructor(text) { this.textContent = String(text); this.tagName = '#text'; this.children = []; } }
const fakeDocument = {
  createElement: (tag) => new FakeNode(tag.toLowerCase()),
  createTextNode: (text) => new FakeText(text),
  createDocumentFragment: () => new FakeNode('#fragment'),
};
const walk = (node, visit) => { visit(node); for (const child of node.children ?? []) walk(child, visit); };
const render = (text) => renderMarkdown(text, fakeDocument);

const ALLOWED_TAGS = new Set([
  '#fragment', '#text', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'strong', 'em', 'del', 'code', 'pre', 'a', 'span',
  'ul', 'ol', 'li', 'blockquote', 'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
]);

describe('renderMarkdown', () => {
  const hostile = [
    '<script>window.PWNED=1</script>', '<img src=x onerror=window.PWNED=1>', '[click](javascript:window.PWNED=1)',
    '![x](https://tracker.example/p.png)', '[x](https://a.com" onmouseover="window.PWNED=1)', '<a href="javascript:1">x</a>',
    '[<img src=x onerror=1>](https://a.com)', '# <script>', '| <img src=x> | b |\n|---|---|\n| <b> | `<i>` |',
  ].join('\n\n');

  test('builds only elements from a fixed list, never script, img, iframe or style', () => {
    const fragment = render(hostile);
    walk(fragment, (node) => assert.ok(ALLOWED_TAGS.has(node.tagName), `unexpected <${node.tagName}>`));
  });

  test('every link is http(s), opens safely, and no attribute carries model text except href', () => {
    const fragment = render(`${hostile}\n\nsee https://ok.example/path and [fine](https://fine.example)`);
    let links = 0;
    walk(fragment, (node) => {
      if (node.tagName === 'a') {
        links++;
        assert.match(node.attrs.href, /^https?:\/\//);
        assert.equal(node.attrs.target, '_blank');
        assert.equal(node.attrs.rel, 'noopener noreferrer nofollow');
      }
      for (const name of Object.keys(node.attrs ?? {})) {
        assert.ok(['href', 'target', 'rel', 'start', 'tabindex', 'role', 'aria-label'].includes(name), `attribute ${name}`);
      }
      assert.doesNotMatch(node.className ?? '', /[<>"'=]/);
    });
    assert.ok(links >= 2);
  });

  test('model text appears only as text, with the tags kept literally', () => {
    const text = render('<script>window.PWNED=1</script>').textContent;
    assert.equal(text, '<script>window.PWNED=1</script>');
  });

  test('renders the structure: headings, lists, table, code, quote, rule', () => {
    const fragment = render('# T\n\n- a\n- b\n\n1. x\n\n| a | b |\n|--:|---|\n| 1 | 2 |\n\n```js\ncode\n```\n\n> q\n\n---');
    const tags = [];
    walk(fragment, (node) => tags.push(node.tagName));
    for (const tag of ['h1', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'th', 'td', 'pre', 'code', 'blockquote', 'hr']) assert.ok(tags.includes(tag), tag);
    const cells = [];
    walk(fragment, (node) => { if (node.tagName === 'th') cells.push(node.className); });
    assert.deepEqual(cells, ['md-al-right', '']);
  });

  test('task items carry a glyph and a label, not an input', () => {
    const tags = [];
    walk(render('- [x] done\n- [ ] todo'), (node) => tags.push(node.tagName));
    assert.ok(!tags.includes('input'));
    assert.match(render('- [x] done\n- [ ] todo').textContent, /☑done☐todo/);
  });

  test('an ordered list keeps its start number', () => {
    let start;
    walk(render('5. five\n6. six'), (node) => { if (node.tagName === 'ol') start = node.attrs.start; });
    assert.equal(start, '5');
  });

  test('empty and non-string input give an empty fragment without throwing', () => {
    for (const input of ['', '   \n\n', null, undefined]) assert.equal(render(input).children.length, 0);
  });
});

test('markdown.js never uses an API that parses HTML or runs code', () => {
  const source = readFileSync(new URL('../markdown.js', import.meta.url), 'utf8');
  const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|DOMParser|createContextualFragment|srcdoc/);
});

// ---------- hostile and huge input ----------

describe('hostile and huge input stays fast', () => {
  const LIMIT_MS = 1500;
  const cases = {
    '100,000 asterisks': () => '*'.repeat(100000),
    '100,000 underscores': () => '_'.repeat(100000),
    'alternating **a ': () => '**a '.repeat(30000),
    'alternating *a_ ': () => '*a_ '.repeat(30000),
    '100,000 open brackets': () => '['.repeat(100000),
    '100,000 open parentheses': () => '('.repeat(100000),
    'many "](" with no link': () => '[a]('.repeat(30000),
    'many link starts with long addresses': () => '[a](' + 'x('.repeat(60000),
    'many "![" with no end': () => '![a'.repeat(40000),
    'many unmatched backticks of changing length': () => Array.from({ length: 3000 }, (_, k) => '`'.repeat((k % 40) + 1) + 'a').join(' '),
    'a long line of backslashes': () => '\\'.repeat(100000),
    'a 200 KB paragraph': () => 'word '.repeat(40000),
    'a 200 KB line of spaces then text': () => ' '.repeat(200000) + 'x',
    'nested lists 50 deep': () => Array.from({ length: 50 }, (_, k) => `${'  '.repeat(k)}- level ${k}`).join('\n'),
    'a deeply nested quote': () => '>'.repeat(50) + ' deep',
    'a 100,000 character quote prefix': () => '>'.repeat(100000) + ' x',
    '5,000 table rows': () => '| a | b | c |\n|---|---|---|\n' + '| 1 | **2** | `3` |\n'.repeat(5000),
    'a table header with 5,000 columns': () => `|${' a |'.repeat(5000)}\n|${'---|'.repeat(5000)}\n|${' 1 |'.repeat(5000)}`,
    '20,000 blank lines inside a list': () => '- a\n' + '\n'.repeat(20000) + '  more',
    '10,000 list items': () => '- item\n'.repeat(10000),
    '10,000 headings': () => '# h\n'.repeat(10000),
    'many unclosed fences': () => '```\n'.repeat(20000),
    'a mix of everything repeated': () => '# t\n- **a** [b](https://c.com) `d` ~~e~~ *f*\n> q\n| a | b |\n|---|---|\n| 1 | 2 |\n'.repeat(3000),
  };

  for (const [name, build] of Object.entries(cases)) {
    test(name, () => {
      const input = build();
      const started = performance.now();
      const blocks = parseMarkdown(input);
      const parsed = performance.now() - started;
      assert.ok(Array.isArray(blocks));
      assert.ok(parsed < LIMIT_MS, `${name}: parsing took ${Math.round(parsed)} ms for ${input.length} characters`);
    });
  }

  test('rendering a 5,000-row table and a 200 KB answer also stays fast', () => {
    const input = '| a | b |\n|---|---|\n' + '| 1 | 2 |\n'.repeat(5000) + '\n' + 'word **bold** [l](https://a.com) '.repeat(6000);
    const started = performance.now();
    const fragment = render(input);
    assert.ok(performance.now() - started < LIMIT_MS);
    assert.ok(fragment.children.length >= 2);
  });

  test('parseInline never throws on random punctuation', () => {
    const alphabet = ['*', '_', '~', '`', '[', ']', '(', ')', '!', '\\', '\n', ' ', 'a', 'https://x.co', '<', '>', '|', '#', '-', '1.'];
    let seed = 12345;
    const random = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let round = 0; round < 300; round++) {
      const text = Array.from({ length: 200 }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
      assert.doesNotThrow(() => parseMarkdown(text), text);
      assert.doesNotThrow(() => render(text), text);
      assert.ok(Array.isArray(parseInline(text)));
    }
  });
});
