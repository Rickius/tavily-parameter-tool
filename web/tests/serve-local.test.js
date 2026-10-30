// The local launcher (serve-local.mjs) fills config.js with keys from the environment, so it must not leak them.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CSP, configScript, createLocalServer, loadKeys, parseEnvFile } from '../../serve-local.mjs';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const KEYS = { nebiusApiKey: 'fake-nebius-key.1', tavilyApiKey: 'tvly-fake-key' };

let server;
let port;

// A raw request, so tests can set the Host and Sec-Fetch-Site headers and send paths the way an attacker would.
function request(path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  server = createLocalServer({ webRoot, keys: KEYS });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(() => new Promise((resolve) => server.close(resolve)));

describe('serving the app', () => {
  test('listens on the loopback address only', () => assert.equal(server.address().address, '127.0.0.1'));

  test('serves the page and its files with the right types', async () => {
    const page = await request('/');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.body, /<script/);
    const js = await request('/core/index.js');
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /text\/javascript/);
    assert.equal((await request('/spec.json')).status, 200);
  });

  test('sends the same Content-Security-Policy as the deployed site', () => {
    const yml = readFileSync(new URL('../../customHttp.yml', import.meta.url), 'utf8');
    const deployed = yml.match(/Content-Security-Policy'\s*\n\s*(?:#.*\n\s*)*value: "([^"]+)"/)?.[1];
    assert.ok(deployed, 'could not find the policy in customHttp.yml');
    assert.equal(CSP, deployed);
  });

  test('does not serve tests, package.json or dotfiles', async () => {
    for (const path of ['/tests/support.js', '/tests/fixtures/parity.json', '/package.json', '/.env']) {
      assert.equal((await request(path)).status, 404, path);
    }
  });

  test('refuses paths that climb out of web/', async () => {
    for (const path of ['/../README.md', '/%2e%2e/README.md', '/..%2f..%2fREADME.md', '/core/../../README.md', '/%00']) {
      const response = await request(path);
      assert.ok([400, 403, 404].includes(response.status), `${path} gave ${response.status}`);
      assert.doesNotMatch(response.body, /Tavily Query-to-Parameters/);
    }
  });

  test('allows only GET and HEAD', async () => {
    assert.equal((await request('/', { method: 'POST' })).status, 405);
    assert.equal((await request('/', { method: 'HEAD' })).status, 200);
  });

  test('rejects an unexpected Host header (DNS rebinding)', async () => {
    assert.equal((await request('/config.js', { headers: { Host: 'evil.example.com' } })).status, 403);
    assert.equal((await request('/config.js', { headers: { Host: `evil.example.com:${port}` } })).status, 403);
    assert.equal((await request('/', { headers: { Host: `127.0.0.1:${port}` } })).status, 200);
  });
});

describe('config.js', () => {
  test('carries the keys for the page itself', async () => {
    for (const site of ['same-origin', 'none', undefined]) {
      const response = await request('/config.js', { headers: site ? { 'Sec-Fetch-Site': site } : {} });
      assert.equal(response.status, 200, String(site));
      assert.equal(response.body, configScript(KEYS));
      assert.equal(response.headers['cache-control'], 'no-store');
    }
  });

  test('is refused to other sites, which could load it in a <script> tag', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const response = await request('/config.js', { headers: { 'Sec-Fetch-Site': site } });
      assert.equal(response.status, 403, site);
      assert.doesNotMatch(response.body, /fake-nebius-key/);
    }
  });

  test('is never written to disk: the committed file stays empty', () => {
    assert.match(readFileSync(new URL('../config.js', import.meta.url), 'utf8'), /nebiusApiKey: "", tavilyApiKey: ""/);
  });
});

describe('reading the keys', () => {
  test('parses a .env file', () => {
    const text = '# comment\nNEBIUS_API_KEY=abc.def\nexport TAVILY_API_KEY="tvly-xyz"\nOTHER=\'quoted\'\nEMPTY=\nTRAILING=value # note\n\n';
    assert.deepEqual(parseEnvFile(text), { NEBIUS_API_KEY: 'abc.def', TAVILY_API_KEY: 'tvly-xyz', OTHER: 'quoted', EMPTY: '', TRAILING: 'value' });
  });

  test('the environment wins over the .env file, and missing keys are empty', () => {
    assert.deepEqual(loadKeys({ NEBIUS_API_KEY: 'from-env' }, { NEBIUS_API_KEY: 'from-file', TAVILY_API_KEY: 'tvly-file' }),
      { nebiusApiKey: 'from-env', tavilyApiKey: 'tvly-file' });
    assert.deepEqual(loadKeys({}, {}), { nebiusApiKey: '', tavilyApiKey: '' });
  });

  test('rejects a key with unsafe characters without printing it', () => {
    const bad = 'abc"};alert(1);//';
    assert.throws(() => loadKeys({ NEBIUS_API_KEY: bad }), (error) => /NEBIUS_API_KEY/.test(error.message) && !error.message.includes('alert'));
  });
});
