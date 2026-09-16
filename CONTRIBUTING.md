# Contributing

Thanks for considering a contribution. This plugin is small on purpose, and the fastest way to get a change merged is to keep it that way.

## Scope

In scope:

- New download entry points on official DSH surfaces.
- Robustness fixes for the host route: streaming, headers, failure mapping, cancellation.
- Compatibility updates when a DSH release moves one of the hooks listed in `tests/contract.mjs`.
- Documentation fixes, including the Chinese README.

Out of scope:

- A file browser, editor, upload, or archive feature. Those belong to panel plugins; this one extends the official surfaces and composes with them.
- A second copy of `Open`/`Reveal` actions. If an official control already does something, do not duplicate it.
- Bundling or vendoring official DSH components.

## Development setup

Requirements: Node 20 or newer, and a DSH `web` profile for the end-to-end check.

```sh
git clone https://github.com/KaguraSayuki/dsh-file-download.git
cd dsh-file-download
npm test
```

There is nothing to install: the package has no dependencies and no build step. `npm test` runs the static validation, the unit tests, and the upstream contract test in that order.

The contract test skips successfully when it cannot find a DSH install. To check a specific one, point `DSH_MODULES` at its `node_modules` root:

```sh
DSH_MODULES=/path/to/dsh/node_modules npm run contract
```

## Manual testing

```sh
dsh plugin --profile web add "$PWD"
# restart dsh web, then in a session: produce a file and use each entry point
dsh plugin --profile web remove dsh-file-download
```

Check all three surfaces, plus one non-happy path: a filename with non-ASCII characters, a file larger than a few megabytes, and a Session whose file was deleted after delivery.

## Code style

- Plain ESM, two-space indentation is not used here; tabs match the surrounding DSH packages, so match the file you edit.
- JSDoc every exported symbol, and every non-obvious internal one, with a one-line summary plus `@param`/`@returns`.
- Comments explain why a thing is the way it is. A comment that restates the code is noise.
- Keep the host half free of dependencies. Node built-ins and injected services only.
- In `lib/client.js`, stay within the module-loader contract: one `window.__ModuleLoader__.load` call, `require`ing platform seeds only.

Before opening a pull request, read `AGENTS.md`. Its invariants are the review checklist: bytes never enter JavaScript, the route stays authenticated and read-only, DOM injection is append-only, and every upstream hook is covered by the contract test.

## Commits

Conventional Commits, English, imperative, lowercase, no trailing period, subject at most 72 characters. The body leads with the problem being solved, then what changed, as prose. No emoji.

```
fix(host): map a cancelled request onto a closed stream

A navigation away from a download left the paged stream to notice the abort
only on its next pull, so the response queue kept a window alive after the
browser had gone. The pull now checks the signal first and errors the stream.
```

## Pull requests

- One logical change per pull request. Split a refactor from a behavior change.
- The full suite must pass: `npm test`.
- Describe how you verified the change. For a client surface, say which entry point you exercised and on which DSH version.
- If your change depends on an upstream hook, add it to `tests/contract.mjs`; a pull request that reads a new `data-*` attribute without a contract check will be asked for one.

## Reporting bugs

Open an issue with:

- the DSH version (`dsh --version`), the profile, and the browser;
- what you did and what happened, including the exact entry point;
- whether the same file downloads through the sidebar document preview, which separates a route problem from a decoration problem.

For anything security-relevant — an authentication bypass, a way to read outside what the Session's filesystem allows, or a leaked path — use GitHub's private security advisory on this repository instead of a public issue.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
