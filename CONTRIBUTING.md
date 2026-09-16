# Contributing

Thanks for considering a contribution. This plugin is small on purpose, and the fastest way to get a change merged is to keep it that way.

## Scope

In scope:

- Read-side browser features: navigation, filtering, hidden-entry handling, listing metadata, and the row actions that already exist (preview, download, folder ZIP, copy, reference).
- New authenticated read routes and archive improvements: streaming, headers, failure mapping, cancellation, caps.
- Compatibility updates when a DSH release moves one of the hooks listed in `tests/contract.mjs`.
- Documentation fixes, including the Chinese README.

Out of scope:

- Any mutating action: upload, rename, delete, edit, chmod, move. Reads are the whole contract here; a write surface needs its own threat model and its own review.
- Access control beyond the Web GUI's own authentication. Do not add a second password, token scheme, or path allowlist that pretends to be a security boundary; document the read scope instead.
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
# restart dsh web, then exercise every surface
dsh plugin --profile web remove dsh-file-download
```

Walk the Sidebar **Files** tab from the project root to `/` and back: open a file in the preview, download one, ZIP a folder, copy a path, insert a reference, then tick two entries — including a folder — and use **Download selected (ZIP)**. Repeat one of those through the server-rendered browse page with no GUI open.

Non-happy paths worth one pass each: a filename with non-ASCII characters, a file larger than a few megabytes, a directory that is not readable, a path outside the workspace, an empty directory, and a Session whose file was deleted after delivery.

## Code style

- Plain ESM, two-space indentation is not used here; tabs match the surrounding DSH packages, so match the file you edit.
- JSDoc every exported symbol, and every non-obvious internal one, with a one-line summary plus `@param`/`@returns`.
- Comments explain why a thing is the way it is. A comment that restates the code is noise.
- Keep the host half free of dependencies. Node built-ins and injected services only.
- Read and list through `ctx.fs`; never reach for `node:fs`. The composed filesystem owns resolution, `FS_*` errors, and symlink behavior.
- In `lib/client.js`, stay within the module-loader contract: one `window.__ModuleLoader__.load` call, `require`ing platform seeds only.
- Keep the two copies of `basename`/`parentPath`/`breadcrumbsFor` (host and browser) in step; the host page and the tab must agree on how a path is displayed.

Before opening a pull request, read `AGENTS.md`. Its invariants are the review checklist: bytes never enter JavaScript, every route stays authenticated and read-only, reads go through `ctx.fs`, caps are enforced host-side, the browse page ships no script, DOM injection is append-only, and every upstream hook is covered by the contract test.

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
