# Deploying on AWS Amplify

The app is a static page, so Amplify Hosting can run all of it. There is no server to deploy. (An agent-oriented version of these steps, with pass/fail gates and CLI commands, is in [AMPLIFY_AGENT_RUNBOOK.md](AMPLIFY_AGENT_RUNBOOK.md).)

**Read this before you start:** the build writes your API keys into the page (`config.js`), so **anyone who can load the page can read them** in their browser's developer tools. Where the keys are stored in Amplify does not change that. The protection is Amplify's branch password, plus keys you can revoke and spending limits at the providers. See [SECURITY.md](../SECURITY.md).

If you do not want visitors to be able to see the keys, leave them out of the build: with no keys set, the page asks each person to paste their own.

## Before you push to GitHub

- Run `git status` and confirm no `.env` file is listed. `.gitignore` excludes `.env`; only `.env.example` (empty key names) is tracked. The `.env` file is for running locally with `serve-local.mjs`, and Amplify never reads it.
- Confirm `web/config.js` has empty keys (`nebiusApiKey: ""`). The Amplify build writes the real values on the build machine only. A test (`cd web && node --test`) fails if a key is in a committed file.
- If a real key was ever pasted into a tracked file or commit, rotate it. Deleting it from the latest commit does not remove it from history.
- Pick a license. None is included.

## Steps

1. **Create dedicated keys.** Make a Token Factory key and a Tavily key just for this deployment, and set a spend limit or alert at both providers if they offer one. You will rotate these if the password leaks.
2. **Push the repo to GitHub.**
3. **In the Amplify console, create an app from the GitHub repo** and pick the branch to deploy. Amplify reads `amplify.yml` from the repo root.
4. **Set environment variables** for the branch (App settings, Environment variables):

   | Variable | Required | Value |
   | --- | --- | --- |
   | `NEBIUS_API_KEY` | yes | the Token Factory key |
   | `TAVILY_API_KEY` | no | the Tavily key. Without it, Compare asks each visitor for their own. |

   The build fails with a clear message if `NEBIUS_API_KEY` is missing or a key contains characters other than letters, digits, `.`, `_` and `-`. It never prints the values.
5. **Turn on Amplify's password protection** (Hosting, then Access control, then Manage access in the Amplify console, per AWS's docs). A password can apply to one branch or to all connected branches, and a branch password overrides an app-wide one. AWS says Amplify throttles failed attempts. Do this before the first deploy goes public, and keep pull request previews off, since each preview is another public address built with the same keys.
6. **Deploy**, then check the result:
   - Opening the site asks for the username and password.
   - `curl -I https://YOUR-DOMAIN/config.js` **without** credentials returns `401`. This proves the keys sit behind the password. I could not test it on a real Amplify app, so do not skip this check.
   - `curl -I https://YOUR-DOMAIN/` shows the `Content-Security-Policy` header from `customHttp.yml`.
   - The grocery example runs and shows a parameter list.

## What the build does

`amplify.yml` validates the keys, writes `web/config.js` from the environment variables, removes `web/tests` and `web/package.json` so they are not served, and publishes the `web` folder. `customHttp.yml` adds the security headers, including a policy that lets the page talk only to itself, `api.tokenfactory.nebius.com` and `api.tavily.com`.

## Day-to-day

- **Change models, timeouts or caps:** edit `web/settings.js` and push. It holds no secrets.
- **Change a key:** update the environment variable in Amplify and redeploy, since the key is written at build time.
- **If the password or a key leaks:** revoke the key at the provider first, then set the new one and redeploy.
- **Change the example tasks:** edit `web/examples.json`.

## What I could not test

- A real Amplify build and the custom headers on a real Amplify app (the YAML parses, and the build commands were dry-run locally with fake keys).
- Whether Amplify's branch password also covers `config.js` and the other static files. Check with the `curl` step above.
