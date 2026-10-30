// config.js is committed with empty keys and overwritten at build time. If a real key ever lands in the repo, this fails.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const webDir = fileURLToPath(new URL('..', import.meta.url));

test('web/config.js has no API keys', () => {
  const window = {};
  new Function('window', readFileSync(join(webDir, 'config.js'), 'utf8'))(window);
  assert.deepEqual(window.APP_CONFIG, { nebiusApiKey: '', tavilyApiKey: '' });
});

test('no key-shaped string appears in the files that get served', () => {
  const suspicious = [/tvly-[A-Za-z0-9_-]{10,}/, /eyJ[A-Za-z0-9_-]{20,}\./, /Bearer\s+[A-Za-z0-9_.-]{20,}/];
  const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (name === 'tests' || name === 'node_modules') return [];
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  for (const file of walk(webDir)) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of suspicious) assert.ok(!pattern.test(text), `${file} contains something shaped like a key (${pattern})`);
  }
});
