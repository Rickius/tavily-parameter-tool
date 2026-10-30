# Runbook: host this app on AWS Amplify (for an automated agent)

You are deploying a static web app (`web/`) to AWS Amplify Hosting. There is no server and no build tool: the Amplify build only writes one config file. Follow the steps in order. **Gates** are pass/fail checks; if a gate fails, stop and follow its failure instruction. Do not improvise around a gate.

## What you are deploying, and the one risk

- The page calls Nebius Token Factory and Tavily directly from the visitor's browser.
- The build writes the two API keys into `config.js`. **Anyone who can load the deployed page can read the keys** in their browser. They are NOT secret from page visitors, only from people who cannot load the page.
- Therefore the deployment is acceptable only if the page is behind Amplify's password protection **from the first deploy**, and the keys are dedicated ones that can be revoked.
- Never print, log, echo, commit or paste key values or the password anywhere (shell output, build logs, commit messages, tickets). Do not pass them as command-line arguments (they appear in process lists and shell history); use files with mode 600 as shown, then delete the files.

## Inputs you must have (ask the human for anything missing; do not invent values)

| Input | Notes |
| --- | --- |
| AWS credentials, region, profile | Needs these Amplify actions: `amplify:CreateApp`, `CreateBranch`, `UpdateBranch`, `GetApp`, `GetBranch`, `StartJob`, `GetJob`, `ListJobs`, `DeleteApp`, `DeleteBranch`. |
| GitHub repository URL and branch | For example `https://github.com/OWNER/REPO` and `main`. The code must already be pushed. |
| GitHub access | Either a GitHub personal access token with repo access (CLI path below), or a human installs the Amplify GitHub App in the console (console path). |
| `NEBIUS_API_KEY` | A Token Factory key created **just for this deployment**. Allowed characters: letters, digits, `.`, `_`, `-`. |
| `TAVILY_API_KEY` | Optional. A dedicated Tavily key. Without it, the Compare tab asks each visitor for their own. Same allowed characters. |
| Branch username and password | Long random values, chosen by the human. They protect the whole site. |

Human-only prerequisites (confirm they are done; you cannot do them): the keys are dedicated, and spend limits or alerts are set at both providers.

## Step 0. Pre-flight on the repository

Run from the repo root.

1. `git status --short` shows no `.env` files and no `web/config.local.js`.
2. `cat web/config.js` shows `window.APP_CONFIG = { nebiusApiKey: "", tavilyApiKey: "" };` with **empty** keys.
3. `cd web && node --test` passes (needs Node 18 or newer).
4. `amplify.yml` and `customHttp.yml` exist at the repo root.

**Gate 0:** all four hold. If `web/config.js` contains a key, stop: a real key is in the repository. Tell the human to revoke that key and rewrite history before anything else.

## Step 1. Create the app (CLI path)

Skip to the console path below if you cannot use a GitHub token.

```bash
umask 077
WORK=$(mktemp -d)
cat > "$WORK/create-app.json" <<EOF
{
  "name": "parameter-selector",
  "repository": "https://github.com/OWNER/REPO",
  "platform": "WEB",
  "accessToken": "GITHUB_TOKEN_HERE",
  "enableBranchAutoBuild": false,
  "enableAutoBranchCreation": false
}
EOF
APP_ID=$(aws amplify create-app --cli-input-json "file://$WORK/create-app.json" --query 'app.appId' --output text)
rm -f "$WORK/create-app.json"
```

Replace the placeholders by editing the file contents with your tooling, not by echoing secrets to the terminal. `enableAutoBranchCreation: false` matters: it stops other Git branches from being deployed automatically.

**Console path (if the CLI path is not possible):** a human opens the Amplify console, chooses Create new app, GitHub, authorizes the Amplify GitHub App, and selects the repository and branch. Leave "auto branch creation" and "pull request previews" off. Then you continue from Step 2 using the app's ID.

## Step 2. Create the branch with the password and the keys, in one call

The keys must be set on the **branch**, not the app, so no other branch can ever receive them. Password protection must be enabled in the same call, so the first build is never public.

```bash
BASIC=$(printf '%s' 'USERNAME:PASSWORD' | base64)   # fill in from your secret input, do not echo
cat > "$WORK/create-branch.json" <<EOF
{
  "appId": "$APP_ID",
  "branchName": "main",
  "stage": "PRODUCTION",
  "enableAutoBuild": true,
  "enableBasicAuth": true,
  "basicAuthCredentials": "$BASIC",
  "enablePullRequestPreview": false,
  "environmentVariables": {
    "NEBIUS_API_KEY": "NEBIUS_KEY_HERE",
    "TAVILY_API_KEY": "TAVILY_KEY_HERE"
  }
}
EOF
aws amplify create-branch --cli-input-json "file://$WORK/create-branch.json"
rm -f "$WORK/create-branch.json"; unset BASIC
```

Omit the `TAVILY_API_KEY` line if there is no Tavily key. The branch password and the keys are the only secrets; keep them out of every log.

**Gate 1:** run `aws amplify get-branch --app-id "$APP_ID" --branch-name main --query 'branch.{basicAuth:enableBasicAuth,previews:enablePullRequestPreview}'`. It must show `basicAuth: true` and `previews: false`. If not, run `update-branch` with the right flags and re-check before any deploy. (Console equivalent: Hosting, Access control, Manage access.)

## Step 3. Build and wait

Amplify may start the first job itself when the branch is created. Check with `aws amplify list-jobs --app-id "$APP_ID" --branch-name main --max-results 3`. If none is running or queued, start one:

```bash
JOB_ID=$(aws amplify start-job --app-id "$APP_ID" --branch-name main --job-type RELEASE --query 'jobSummary.jobId' --output text)
```

Poll until it ends (every 15 seconds, give up after 15 minutes):

```bash
aws amplify get-job --app-id "$APP_ID" --branch-name main --job-id "$JOB_ID" --query 'job.summary.status' --output text
```

Statuses: `PENDING`, `PROVISIONING`, `RUNNING`, then `SUCCEED` or `FAILED`.

**Gate 2:** status is `SUCCEED`. If `FAILED`, read the build log and use the failure table at the end. Never paste the log anywhere if it could contain a secret (the build is written not to print them, but check).

## Step 4. Verify the deployment

```bash
DOMAIN=$(aws amplify get-app --app-id "$APP_ID" --query 'app.defaultDomain' --output text)
SITE="https://main.$DOMAIN"
```

**Gate 3 (hard gate, the keys must be behind the password).** Request each of these **without** credentials. Every one must return `401`:

```bash
for p in / /config.js /settings.js /spec.json /core/index.js /examples.json; do
  printf '%s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "$SITE$p")"
done
```

If **any** returns `200`, the password is not covering that file and the keys may be public. **Stop. Do not continue.** Immediately run `aws amplify delete-branch --app-id "$APP_ID" --branch-name main`, tell the human to revoke both API keys at the providers, and report which paths returned 200. I could not test this on a real account, which is why it is a gate.

**Gate 4 (with credentials).** Use a netrc-style file or `curl --user` read from a mode-600 file so the password is not on the command line:

1. `/` returns `200`.
2. `/config.js` returns `200` and matches `window.APP_CONFIG = { nebiusApiKey: "` followed by a non-empty value. Check this with `grep -c`, and do **not** print the line.
3. The response headers of `/` include `content-security-policy` containing `connect-src 'self' https://api.tokenfactory.nebius.com https://api.tavily.com`, plus `x-robots-tag: noindex, nofollow`, `x-frame-options: DENY` and `strict-transport-security`. Header names are case-insensitive.
4. `/config.js` has `cache-control: no-store`.
5. `/tests/` and `/package.json` return `404` (the build removes them).

**Gate 5 (functional, needs a human or a headless browser).** Open `$SITE` with the credentials. The page must load the tool (no "API keys" box, since the keys are built in), the grocery example must run to a result with parameter rows, and the browser console must show no Content Security Policy errors. If you have Playwright, load the page with HTTP credentials and check the same. If a CSP error names a host, fix `customHttp.yml` only by adding that exact host to `connect-src`, and re-run from Step 3.

## Report back to the human

Give them: the site URL, the app ID, which gates passed, the reminder that the page's visitors can read the keys, and that they should confirm spend limits at both providers. Do not include any secret.

## Day-two operations

| Task | How |
| --- | --- |
| Rotate keys | `aws amplify update-branch --app-id ID --branch-name main --cli-input-json file://...` with the **complete** `environmentVariables` map (an update replaces the whole map, so include both keys), then `start-job --job-type RELEASE`. Revoke the old keys at the providers. Re-run Gate 3. |
| Change the password | `update-branch` with a new `basicAuthCredentials` (base64 of `user:password`) and `enableBasicAuth: true`. Re-run Gate 3. |
| Change models, caps, timeouts | Edit `web/settings.js` (no secrets), push to the branch. Amplify rebuilds on push. |
| Change example tasks or the Tavily knowledge | Edit `web/examples.json` or `web/spec.json`, run `cd web && node --test`, push. |
| Take it down | `aws amplify delete-app --app-id ID`, then revoke the keys. |
| Add a custom domain | Optional. After adding it, re-run Gate 3 against the custom domain. |

## Failure table

| Symptom | Cause and fix |
| --- | --- |
| Build fails: `NEBIUS_API_KEY is not set` | The variable is missing on the **branch**. Set it with `update-branch` (full map) and rebuild. |
| Build fails: `contains characters other than letters, digits ...` | The key has a character outside `A-Za-z0-9._-`. Check the pasted value for quotes or spaces. |
| Page shows an "API keys" box | `config.js` was published empty, so the build did not write the keys. Check the build log for the `config.js` step. |
| Blank page, console mentions modules or CSP | The site is not being served from the `web` folder (check `artifacts.baseDirectory` in `amplify.yml`), or a header blocks a file. |
| Page says the API key was rejected (HTTP 401) | The key is wrong, revoked or for the wrong service. Update it as in "Rotate keys". |
| A banner says a model is not in the live model list | A model ID in `web/settings.js` was retired. Change it and push. |
| Gate 3 returns 200 for any path | Password protection is not covering it. Follow Gate 3's failure instruction. |

## What was and was not verified

- Verified from AWS's documentation: the CLI commands and flags used above, the base64 `user:password` format, that passwords can apply to a branch or to all branches (the branch overrides), the console path Hosting, Access control, Manage access, and that Amplify throttles failed password attempts.
- Verified locally: `amplify.yml` parses, and its build commands were dry-run with fake keys (success, missing key, and a key containing a quote that is rejected).
- **Not tested on a real Amplify app:** the build itself, the custom headers, and whether the password covers every static file. Gates 3 to 5 exist to check exactly that.
