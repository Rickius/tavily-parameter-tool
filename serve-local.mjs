#!/usr/bin/env node
// Runs the app on your machine with your own API keys, no install step:
//   node serve-local.mjs
// It serves web/ on http://localhost:8000 and fills config.js with NEBIUS_API_KEY and TAVILY_API_KEY, read from the
// environment or from a .env file next to this script. The keys are added to the response in memory; nothing is written
// to disk, so web/config.js stays empty and cannot be committed by accident. Set PORT to use another port.

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const KEY_PATTERN = /^[A-Za-z0-9_.-]+$/;

// The same policy the deployed site sends (customHttp.yml), so a problem shows up here first. A test keeps them equal.
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self' https://api.tokenfactory.nebius.com https://api.tavily.com; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// Never served, to match what the Amplify build publishes.
const HIDDEN = [/^\/tests(\/|$)/, /^\/package\.json$/];

export function parseEnvFile(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) continue;
    const name = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) value = value.slice(1, value.lastIndexOf(quote));
    else value = value.replace(/\s+#.*$/, '');
    values[name] = value;
  }
  return values;
}

// Environment variables win over the .env file. Errors name the variable, never its value.
export function loadKeys(env, fileValues = {}) {
  const pick = (name) => (env[name] || fileValues[name] || '').trim();
  const keys = { nebiusApiKey: pick('NEBIUS_API_KEY'), tavilyApiKey: pick('TAVILY_API_KEY') };
  for (const [name, value] of [['NEBIUS_API_KEY', keys.nebiusApiKey], ['TAVILY_API_KEY', keys.tavilyApiKey]]) {
    if (value && !KEY_PATTERN.test(value)) {
      throw new Error(`${name} contains characters other than letters, digits, '.', '_' and '-'. Check the value you pasted.`);
    }
  }
  return keys;
}

export function configScript(keys) {
  return `window.APP_CONFIG = { nebiusApiKey: "${keys.nebiusApiKey}", tavilyApiKey: "${keys.tavilyApiKey}" };\n`;
}

export function createLocalServer({ webRoot, keys }) {
  const root = resolve(webRoot);

  const server = createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': CSP,
        ...headers,
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    };

    // Defeats DNS rebinding: a web page cannot reach this server under a name of its own choosing.
    const port = server.address()?.port;
    const host = String(req.headers.host ?? '').toLowerCase();
    if (![`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(host)) return send(403, 'Unexpected Host header.\n');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed.\n', { Allow: 'GET, HEAD' });

    let path;
    try {
      path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return send(400, 'Bad request.\n');
    }
    if (path.includes('\0')) return send(400, 'Bad request.\n');
    if (path === '/') path = '/index.html';
    if (path.split('/').some((part) => part.startsWith('.')) || HIDDEN.some((pattern) => pattern.test(path))) return send(404, 'Not found.\n');

    if (path === '/config.js') {
      // A page on another site can load this URL in a <script> tag and read window.APP_CONFIG. Browsers label that request
      // cross-site, so refuse it. Requests with no label (curl, very old browsers) cannot be driven by a web page.
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') return send(403, 'Not available to other sites.\n');
      return send(200, configScript(keys), { 'Content-Type': TYPES['.js'] });
    }

    const file = resolve(root, `.${path}`);
    if (file !== root && !file.startsWith(root + sep)) return send(403, 'Forbidden.\n');
    try {
      if (!(await stat(file)).isFile()) return send(404, 'Not found.\n');
      const body = await readFile(file);
      return send(200, body, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    } catch {
      return send(404, 'Not found.\n');
    }
  });

  return server;
}

function main() {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const envFile = resolve(here, '.env');
  let keys;
  try {
    keys = loadKeys(process.env, existsSync(envFile) ? parseEnvFile(readFileSync(envFile, 'utf8')) : {});
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const port = Number(process.env.PORT) || 8000;
  const server = createLocalServer({ webRoot: resolve(here, 'web'), keys });
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Set PORT to another number.` : error.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Open http://localhost:${port}`);
    console.log(`Token Factory key: ${keys.nebiusApiKey ? 'found' : 'not found'}   Tavily key: ${keys.tavilyApiKey ? 'found' : 'not found'}`);
    if (!keys.nebiusApiKey || !keys.tavilyApiKey) {
      console.log('Put NEBIUS_API_KEY and TAVILY_API_KEY in a .env file next to this script, or paste the missing key into the page.');
    }
    console.log('Press Ctrl+C to stop.');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
