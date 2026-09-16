# AGENTS.md

Guidance for agents (and humans) working in this repository. `README.md` explains what the plugin does; this file explains how to change it without breaking the properties that make it safe to install.

## What this is

A single DSH plugin, shipped as a plain ESM package with two halves:

- `lib/index.js` — the host half. One authenticated Fetch route on Connection plus paged reads through the `workspaceFiles` service.
- `lib/client.js` — the browser half. One official slot occupant plus DOM decorations over published `data-*` hooks.

There is no build step, no bundler, no dependency, and no `prepare` script. Keep it that way: the package is installed by `dsh plugin add` from a checkout or from GitHub, and a build step turns a one-command install into a toolchain problem.

## Invariants

These are not style preferences. Each one is load-bearing for security or for surviving a DSH upgrade.

1. **Bytes never enter JavaScript.** Every download is a same-origin URL handed to the browser. Do not fetch content into a Blob, do not buffer a whole file, do not base64 anything into the client.
2. **The route stays behind Connection's fence.** Register on `connection.fetch.register`. Never register a raw unauthenticated `webServer` route, and never add a query-token scheme of your own.
3. **Read-only.** No upload, no write, no delete, no directory listing. The only host capability used is `workspaceFiles.stat` and `workspaceFiles.readBytes`.
4. **Same authority as the official preview.** Resolve the Session scope the way the Remote layer does (live header, else persistence `stat`), and let `workspaceFiles` perform every check. Do not resolve paths yourself against `process.cwd()`.
5. **Errors leak nothing.** Short fixed strings only; no resolved paths, no messages from thrown errors, no stack traces.
6. **The browser half requires only platform seeds.** `react` and `react/jsx-runtime` are seeded by the shell's module table; anything else must not be `require`d. A missing module throws during boot and the whole GUI fails to load.
7. **The client `inject` list names real services.** Every name in `exports.inject` must be provided by the shipped client plane. A name that never appears leaves the plugin fiber pending, and the shell's boot assertion turns that into a failed page. Check `tests/contract.mjs` when adding one.
8. **DOM injection is append-only.** Append injected nodes at the end of their container. Never insert between React-managed siblings, never mutate React-owned attributes, and never remove or reorder official nodes. Every injected node carries `data-dsh-download`, and every effect removes what it added.
9. **Official-first.** Prefer an official slot to a DOM decoration whenever a slot exists. A decoration must depend only on published `data-*` hooks, and the contract test must cover the hook it uses.
10. **No forks of official components.** If a surface needs a change that only a fork would allow, that is a signal to open an upstream issue or to add a smaller entry point, not to vendor a component.

## Layout

| Path | Role |
|---|---|
| `lib/index.js` | host half: `DOWNLOAD_PATH`, scope resolution, `fileStream`, `downloadResponse`, `failureResponse`, `apply` |
| `lib/client.js` | browser half: module-loader bundle, locale dictionaries, `TurnDownload`, DOM decorators |
| `cordis.patch.yml` | the one dual-face row this bundle mounts |
| `tests/resolve-dsh.mjs` | locate the DSH install a profile actually runs |
| `tests/host.test.mjs` | route behavior with a fake context |
| `tests/validate.mjs` | static wiring checks |
| `tests/contract.mjs` | upstream hook checks |
| `tests/hygiene.test.mjs` | leak guard over tracked files |

## Commands

```sh
npm test          # everything below, in order
npm run validate  # manifest, patch, bundle wiring
npm run unit      # node --test tests/*.test.mjs
npm run contract  # upstream hooks; skips cleanly when no DSH install exists
```

Manual end-to-end check:

```sh
dsh plugin --profile web add "$PWD"
# restart dsh web, open a session, produce a file, use each entry point
dsh plugin --profile web remove dsh-file-download
```

## Adding a surface

1. Check whether an official slot exists. If it does, register there and stop.
2. Otherwise identify the most stable published hook you can anchor to. Prefer a `data-*` attribute over a class name; class names are content-hashed.
3. Append, never interleave. Re-apply from a single `MutationObserver`, and make the disposer remove every node and listener you added.
4. Add the hook to `tests/contract.mjs` so a DSH upgrade fails loudly instead of silently dropping the surface.
5. Add a static assertion to `tests/validate.mjs` so an accidental rename fails without a browser.

## DSH upgrades

DSH is a moving target. After every upgrade:

1. `npm test` and note the current state.
2. Upgrade DSH, then `npm test` again.
3. Green means nothing to do. Red names the exact hook that moved; update the selector or the route contract, then re-run.
4. If an upstream release adds a native download entry point, prefer removing a decoration over keeping two.

## Commits and reviews

- Conventional Commits, English, imperative, lowercase, no trailing period, subject at most 72 characters.
- The body leads with the problem, then what changed. Prose, not a bullet dump. No emoji.
- One logical change per commit; tests belong in the same change as the behavior they cover.
- Before pushing: the full suite is green, the working tree is clean, and `git status` shows nothing sensitive. `tests/hygiene.test.mjs` guards tracked files against home paths, private addresses, mail addresses, and credential shapes — if it fails, fix the file, never the rule.
- Run `git log origin/main..HEAD` and read the exact list of commits before pushing.

## Do not

- Do not patch an installed DSH package; the fix belongs in this repository or upstream.
- Do not add a dependency to save a few lines. The whole host half is Node built-ins plus the injected services.
- Do not add a panel. The point of this plugin is that it extends the official surfaces and composes with whatever sidebar the user runs.
- Do not widen file access. If a file is not readable through the Session's own filesystem, it is not downloadable.
