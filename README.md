# Tavily Query-to-Parameters Explainer

Tavily Search has a lot of parameters (`topic`, `time_range`, `search_depth`, domain filters and more). This tool shows you **which ones to set for a task, and why**.

You type a plain-language task, like "find this week's grocery deals". The tool shows each parameter it would set, with a one-sentence reason and a label saying where the choice comes from. A second tab runs the same task on a small and a large model with Tavily as a search tool, so you can watch how each one chooses parameters on its own.

It is a static web page: no server, no database, no accounts. Your browser talks directly to Nebius Token Factory and Tavily.

## Run it on your machine

You need [Node.js](https://nodejs.org) 18 or newer, a [Token Factory](https://tokenfactory.nebius.com) API key and a [Tavily](https://app.tavily.com) API key. Nothing to install.

1. Clone this repo.
2. Copy `.env.example` to `.env` and put your two keys in it.
3. Run `node serve-local.mjs`, then open http://localhost:8000.

The launcher reads the keys from `.env` (which git ignores) and hands them to the page, so you paste nothing. It keeps them in memory and never writes them to a file. Press Ctrl+C to stop. Set `PORT` to use a port other than 8000. To change which models it uses, see [Swapping models](#swapping-models). You can also pass the keys as environment variables instead of using `.env`:

```
NEBIUS_API_KEY=... TAVILY_API_KEY=... node serve-local.mjs
```

The launcher only listens on your own machine (`127.0.0.1`). It also refuses requests with an unexpected `Host` header, and it will not hand your keys to a page from another website.

**No Node, or you would rather paste the keys?** Serve the `web` folder with any static server, for example `python3 -m http.server 8000 --directory web`, then open http://localhost:8000 and paste your keys into the **API keys** box. Those keys stay in that browser tab (session storage), are sent only to Token Factory and Tavily, and are forgotten when you close the tab.

The Tavily key is only needed for the Compare tab. A hosted copy can have the keys built in so visitors paste nothing; see [Deploying it for others](#deploying-it-for-others).

## The Parameters tab

Pick an example from the dropdown (or type your own task) and press **Explain parameters**. Picking an example only fills the text box; nothing runs until you press the button.

You get:

- **Parameter rows.** Each row has a tag, the parameter and its value, one sentence of reasoning, and the words in your task that caused it. Hover a row and its phrase lights up in your task, and the reverse.
- **A request preview** on the right: the JSON body and a Python snippet using the Tavily SDK, each with a copy button. Hover a line to find its row.
- **Left at default.** Parameters the tool chose *not* to set, each with a reason. What was left out teaches as much as what was chosen.
- **Alternatives.** When two reasonable setups exist, a toggle switches between them and states the trade-off in one sentence.
- **Warnings.** Documented limits of Tavily for your task, such as "no city-level location targeting".

### What the three tags mean

| Tag | Meaning |
| --- | --- |
| **Documented** | A Tavily page states this rule or behavior. The tag links to that page. |
| **Judgment call** `[Inference]` | The planner's recommendation. The docs do not dictate it, so treat it as a suggestion. |
| **Default** | Left unset on purpose, with a reason. |

### How it decides

1. Your task and the full parameter spec (`web/spec.json`) go to a planner model on Token Factory.
2. The planner answers with JSON: parameters, reasons, tags, warnings.
3. The page checks that answer against the same spec: names, types, allowed values, and Tavily's rules (for example, `country` only works with `topic: general`). A bad answer is sent back once with the errors. If it fails again, you see the error instead of a result.
4. Only checked output is shown, so you will never see a parameter Tavily does not have.

While it runs, a **Live output** panel shows what each model is producing, so you can tell it is working and not stuck: the model's thinking text in a muted style, then its JSON answer as it forms, with a status, a character count and how long ago the last output arrived. With the ensemble on there is one box per stage (planner 1, planner 2, then the merging model). If a first answer breaks Tavily's rules, the panel says so and shows why before the model is asked again. **Stop** ends the run. Afterwards, the raw output stays in a collapsed **Model output** section in Run details (or in the error card if the run failed).

This tab runs **no Tavily search** and spends **no Tavily credits**.

### Planner ensemble (optional)

The **Use planner ensemble** checkbox runs two planner models in parallel, then a third model merges their plans. Each row then shows whether both planners agreed, which one the merge sided with, or whether the merging model chose a value neither proposed. Where the planners differed, the merging model is told to tag the row Judgment call unless a documented rule settles the choice.

It is slower (the slower planner plus one more call) and uses three model calls instead of one. It is off unless you turn it on. The checkbox is greyed out, with the reason, if the extra models are not set up.

## The Compare models tab

This tab runs your task, **unchanged and with no hints**, on a small and a large model side by side. Each model gets Tavily Search as a tool and decides for itself what to search and how.

Each column is a step-by-step trace: what the model said, the search it ran with its exact parameters, and what came back. Models that expose their reasoning show it; others say none was returned. Under each trace:

- **Searches** made and **distinct URLs** seen.
- **Repeated queries**: searches whose words overlap an earlier one by at least 80%.
- **Credits** Tavily reports for the run.

Each model's final answer is shown as formatted text (headings, bold, lists, tables, code, links) rather than raw markdown. A **Formatted / Raw** toggle on the answer switches to the original markdown, and **Copy** copies it. Rendering is deliberately conservative because the text comes from a model and from web pages: links are clickable only for `http` and `https` addresses, images are never loaded (you see the alt text and the address instead), and raw HTML is shown as plain text. A table wider than its box scrolls sideways inside the box.

The tool reports what happened and does not pick a winner. A single run varies, so use **Run again** to see the spread. **Stop** ends a run early.

This tab **spends Tavily credits**, so it asks you to confirm first. The confirmation shows two caps, which you can change:

- Model turns per run (default 6, never more than 12).
- Tavily searches per run (default 4, never more than 8). A `basic` search costs 1 credit and an `advanced` search costs 2. The model chooses which.

## Cost and time

| | Token Factory | Tavily credits | Typical wait |
| --- | --- | --- | --- |
| Parameters tab | 1 model call (2 if the first answer fails the check) | none | seconds to a couple of minutes, depending on the planner |
| Parameters tab with ensemble | 3 model calls | none | the slower planner, then one more call |
| Compare models tab | up to the turn cap, per model | up to the search cap, per model | seconds to a few minutes |

Reasoning models can be slow, and their speed varies from run to run. The page shows a timer while you wait.

## Settings

Edit `web/settings.js`. No keys go in that file.

| Setting | Default | What it does |
| --- | --- | --- |
| `models.planner` | `moonshotai/Kimi-K3` | The planner. Any model that follows the JSON instructions works. |
| `models.planner2` | `deepseek-ai/DeepSeek-V4-Pro-0813` | Second planner for the ensemble. Set to `''` to turn the ensemble off. |
| `models.aggregator` | `zai-org/GLM-5.2` | Merges the two plans. A different model family from the planners works best. |
| `models.small` / `models.large` | `Qwen/Qwen3-30B-A3B-Instruct-2507` / `moonshotai/Kimi-K3` | Default Compare models. Each must be in `phase2Allowlist`. |
| `phase2Allowlist` | those two | The models the Compare tab offers. Add `{ id, size }` entries (`small` or `large`); each should support function calling. |
| `ensembleDefault` | `false` | Whether the ensemble checkbox starts checked. |
| `compareEnabled` | `true` | `false` hides Compare, the part that spends Tavily credits. |
| `plannerTimeoutSeconds` / `runTimeoutSeconds` | `240` / `240` | How long each planner call, or each Compare model call, may take. |
| `defaultTurns` / `defaultSearches` | `6` / `4` | Starting caps for a Compare run. |
| `maxTurns` / `maxSearches` | `12` / `8` | Ceilings the page will not exceed. |
| `maxTaskChars` | `500` | Longest task accepted. |

### Swapping models

Models are set in `web/settings.js`, not in `.env`.

1. **Find the exact model ID.** The [model catalog](https://tokenfactory.nebius.com/models/catalog) shows display names, but the app needs the ID, which looks like `provider/name`. This lists every ID your key can use (set `NEBIUS_API_KEY` first, or paste the key in place of the variable):

   ```
   curl -s https://api.tokenfactory.nebius.com/v1/models -H "Authorization: Bearer $NEBIUS_API_KEY" | grep -o '"id": *"[^"]*"'
   ```

2. **Edit `web/settings.js`.**
   - **Planner and ensemble:** change `models.planner`, `models.planner2` and `models.aggregator`. Any chat model that follows the JSON instructions works.
   - **Compare tab:** add the model to `phase2Allowlist` with a `size` of `'small'` or `'large'`. Each Compare column shows a dropdown of the allowlisted models of its size, and `models.small` and `models.large` pick which one starts selected. A Compare model must support function calling (tool calls). Token Factory does not flag this, so try it.

   For example, to offer a second small model:

   ```js
   phase2Allowlist: [
     { id: 'moonshotai/Kimi-K3', size: 'large' },
     { id: 'Qwen/Qwen3-30B-A3B-Instruct-2507', size: 'small' },
     { id: 'zai-org/GLM-5.3-Flash', size: 'small' }, // added
   ],
   ```

3. **Reload.** With `serve-local.mjs`, refresh the page. On Amplify, push the change and let it rebuild.

The page checks every configured ID against the live model list when it loads. If one is retired or misspelled, a banner names it, and the ensemble checkbox greys out if its models are missing.

## If something goes wrong

| What you see | What it means and what to do |
| --- | --- |
| An **API keys** box instead of the tool | No key reached the page. With the launcher, check that `.env` exists next to `serve-local.mjs` and holds `NEBIUS_API_KEY`; the launcher prints `found` or `not found` for each key when it starts. Otherwise paste your keys into the box. |
| `NEBIUS_API_KEY contains characters other than ...` | The launcher found an unusual character in the key, often a stray quote or space from copying. Re-copy the key. |
| `Port 8000 is already in use` | Another program is using the port. Set `PORT`, for example `PORT=8001 node serve-local.mjs`. |
| "Token Factory rejected the API key (HTTP 401)" | The key is wrong or revoked. Check it. |
| A banner saying a model "is not in the Token Factory model list" | A model ID in `web/settings.js` was retired or misspelled. See [Swapping models](#swapping-models) for how to list the valid IDs. |
| "The planner model ... did not answer within N seconds" | The planner was too slow. Raise `plannerTimeoutSeconds`, or pick a faster `models.planner`. |
| "The planner's answer failed validation" | The planner broke Tavily's rules twice. Try rewording the task, or try again. |
| Compare says it needs a Tavily key | Paste your Tavily key in the **API keys** box. |
| The ensemble checkbox is greyed out | The second planner or merging model is unset or not on Token Factory. The note under the checkbox says which. |
| The page is blank, or errors mention modules | Open it through a web server (the launcher, or the static-server option), not by double-clicking `index.html`. |

## What this tool is not

- It is a teaching and demo tool, not a production search wrapper.
- The planner is a model. Rows tagged **Judgment call** are its recommendations; only **Documented** rows come straight from Tavily's docs. Check anything that matters against the docs.
- The spec was built from Tavily's [Search API reference](https://docs.tavily.com/api-reference/endpoint/search) and [Search best practices](https://docs.tavily.com/documentation/best-practices/best-practices-search). Its `last_verified` date is in `web/spec.json`. Tavily can change its API, so recheck the spec if something looks wrong. Where Tavily's pages disagree on a detail (for example the default for `max_results`), the planner always sets the value explicitly, so you never depend on an unclear default.
- The planner and Compare models run on Nebius Token Factory.
- Your task text is sent to Nebius Token Factory, and in Compare to Tavily as well. Do not type anything you would not want those services to receive. The tool itself keeps nothing.

## Deploying it for others

The page is static, so it can be hosted entirely on AWS Amplify. The build writes shared API keys into the page, which means **anyone who can load the page can read the keys**. Only deploy it behind Amplify's branch password, with dedicated keys you can revoke. See [docs/DEPLOY.md](docs/DEPLOY.md) for the steps (or [docs/AMPLIFY_AGENT_RUNBOOK.md](docs/AMPLIFY_AGENT_RUNBOOK.md) if an automated agent is doing it) and [SECURITY.md](SECURITY.md) for exactly what that does and does not protect.

## For developers

```
serve-local.mjs           Runs the app locally with your keys from .env (no install)
.env.example              Names of the two keys the launcher reads
web/                      The whole app: index.html, app.js, live.js (live output panel), markdown.js (answer renderer),
                          styles.css, examples.json, settings.js, config.js, spec.json
web/core/                 The logic: validator, planner, ensemble, Compare loop, API clients (plain ES modules)
web/tests/                Offline tests (Node's built-in test runner)
amplify.yml               Amplify build: writes the keys into config.js and publishes web/
customHttp.yml            Security headers for Amplify
docs/DEPLOY.md            Hosting on Amplify, for people
docs/AMPLIFY_AGENT_RUNBOOK.md   The same, written for an automated agent
```

Run the tests with `cd web && node --test` (offline, no keys, needs Node 18 or newer). `web/tests/parity.test.js` checks the code against a frozen record of what the original Python version returned, so behavior changes show up as failures.

To change the example tasks, edit `web/examples.json`. To change what the tool knows about Tavily, edit `web/spec.json`: the planner prompt, the validator and the Compare tool schema all read from it.

## License and contributing

[MIT](LICENSE). Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
