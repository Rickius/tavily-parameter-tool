# Contributing

Thanks for your interest. This project is meant to be run and changed on your own machine, and contributions are welcome.

The hosted demo is internal and is not part of what you need to contribute. Everything runs locally with your own API keys.

## Set up

You need [Node.js](https://nodejs.org) 18 or newer. There is nothing to install: the project has no dependencies.

1. Fork the repo and clone your fork.
2. Copy `.env.example` to `.env` and add your [Token Factory](https://tokenfactory.nebius.com) and [Tavily](https://app.tavily.com) keys. `.env` is git-ignored.
3. Run `node serve-local.mjs` and open http://localhost:8000.

The [README](README.md) explains the app and every setting in `web/settings.js`.

## Run the tests

```
cd web && node --test
```

The tests run offline and need no keys. Please run them before opening a pull request, and add or update tests for any behavior you change. `web/tests/parity.test.js` compares against a frozen record of the original behavior, so an unexpected failure there means behavior changed.

## Where things live

- `web/spec.json` is the single description of Tavily's parameters. The planner prompt, the validator and the Compare tool schema all read from it. To change what the tool knows about Tavily, edit this file.
- `web/examples.json` holds the example tasks.
- `web/settings.js` holds the model IDs, timeouts and caps.
- `web/core/` holds the logic, and `web/tests/` holds the tests.

## Pull requests

- Open the pull request from a branch in your fork.
- Keep each pull request to one change, and describe what changed and why.
- Tests must pass.
- Match the surrounding code style. The project is plain ES modules with no build step and no dependencies, so please do not add any without discussing it first.

## Never commit keys

Do not commit API keys, `.env`, or a `web/config.js` that contains real keys. `web/config.js` is committed with empty keys, and a test fails if a key appears in it. If you build or serve locally, check `git status` and `git diff` before you commit.

## Security issues

Please do not open a public issue for a security problem. See [SECURITY.md](SECURITY.md) for how the app handles keys and what to report.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
