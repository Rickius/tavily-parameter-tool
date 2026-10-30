# Security

## The one thing to understand

This app has no server. Your browser calls Nebius Token Factory and Tavily directly, so the API keys have to be in the browser. When the keys are built into the page (the Amplify setup), **anyone who can load the page can read them** with the browser's developer tools and use them anywhere, not just in this app.

Everything below follows from that. The deployment is safe to the extent that only people you trust can load the page, and that a leaked key costs you little.

## What it exposes if you deploy it

| Asset | What a reader of the page can do |
| --- | --- |
| Token Factory key | Make any Token Factory request, on your account, until you revoke it. |
| Tavily key | Run any Tavily search and spend your credits, until you revoke it. |

## Controls

| Risk | Control |
| --- | --- |
| Strangers loading the page and reading the keys | Deploy only behind Amplify's branch password. The deployment guide has a `curl` check that `config.js` returns 401 without credentials. |
| A leaked key | Use dedicated keys for this deployment, set spend limits or alerts at both providers, and rotate after a demo or if the password leaks. |
| Keys in the repository | `web/config.js` is committed with empty keys and is overwritten only on the build machine. `.env` and `config.local.js` are git-ignored, and a test fails if a key appears in a committed or served file. |
| Keys sent somewhere else | The Content Security Policy lets the page connect only to itself, `api.tokenfactory.nebius.com` and `api.tavily.com`. |
| Script injection (XSS), which would expose the keys | The policy allows scripts only from the page's own origin and no inline scripts. Model and web text is inserted as text, never as HTML. Links are shown only for http and https URLs, and documented-row links must come from the spec's list of Tavily doc URLs. The page loads no third-party scripts. |
| Hostile text in a Compare answer | Answers are rendered by a small renderer that builds page elements one at a time and never inserts HTML. Raw HTML is shown as text, images are never loaded (so nothing can be tracked through them), and a link is clickable only if it is an `http` or `https` address; it opens in a new tab with `noopener noreferrer nofollow`. A test fails if the renderer ever uses `innerHTML` or similar. |
| Clickjacking and sniffing | `frame-ancestors 'none'`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, and HSTS. |
| Search engines indexing the page | `X-Robots-Tag: noindex, nofollow`. |
| A stale cached `config.js` | `Cache-Control: no-store` on `config.js`. |
| A model inventing parameters | Every plan and every Compare tool call is checked against `web/spec.json` before it is shown or sent. |
| Runaway Compare runs | The page caps model turns (12) and Tavily searches (8) per run and asks for confirmation. |

## Limits you should know about

- **The password is the only gate.** Amplify's branch password is usually one shared login. I did not confirm in this session whether it can issue per-person logins or whether it covers `config.js`, so check that when you deploy. Anyone with the password can read the keys.
- **The caps and confirmation are not security controls.** They run in the browser, so anyone with the keys can bypass them. Spending limits at the providers are the real ceiling.
- **There are no rate limits.** There is no server to enforce them.
- **Amplify's own docs advise against putting secrets in environment variables.** For a static page there is no alternative, because the page must receive the key either way. This is the accepted cost of the no-server design.
- **A compromised browser** (a malicious extension, malware) can read the keys.
- **Prompt injection.** The task text goes to a model, and Compare feeds web search results to a model. A hostile task or web page can change what a model says. The models can only call Tavily Search with validated arguments under a cap, and their output is shown as plain text, but they can still produce misleading answers.
- **Privacy.** Task text is sent to Nebius Token Factory, and in Compare to Tavily as well. The app keeps nothing.
- **Dependencies.** The page has no third-party runtime code and no build step, so there is no package supply chain to attack.

## Running it locally

`serve-local.mjs` puts your keys in `config.js` in memory, so the same exposure applies on your own machine, narrowed:

- It listens only on `127.0.0.1`, so other computers cannot reach it.
- It refuses any request whose `Host` header is not `localhost`, `127.0.0.1` or `[::1]` on its own port, which blocks DNS-rebinding attacks from web pages.
- A web page on another site can load `http://localhost:8000/config.js` in a `<script>` tag and read the keys. Browsers mark that request as cross-site, and the launcher refuses it with a 403. Requests with no such label, such as `curl`, are allowed; a web page cannot send those.
- Keys are never written to disk, and `.env` is git-ignored.
- It is meant for you alone. Do not expose its port through a tunnel, a shared network or a port forward.

## If a key leaks

1. Revoke it at the provider.
2. Create a new one and set it in Amplify's environment variables.
3. Redeploy, because the key is written into the page at build time.
4. Change the branch password if you think it leaked too.

## Reporting a problem

Enable GitHub's private vulnerability reporting on the repository and report there, or contact the maintainer directly. Please do not open a public issue for a vulnerability.
