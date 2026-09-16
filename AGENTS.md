# AGENTS.md

Guidance for agents (and humans) working in this repository. `README.md` explains what the plugin does; this file explains how to change it without breaking the properties that make it safe to install.

## What this is

A single DSH plugin, shipped as a plain ESM package with two halves:

- `lib/index.js` — the host half. Authenticated Fetch routes on Connection, reading and listing through the composed `ctx.fs` service, plus a hand-written streaming ZIP writer.
- `lib/client.js` — the browser half. A Sidebar tab type registered through the official registry, one official slot occupant, and DOM decorations over published `data-*` hooks.

There is no build step, no bundler, no dependency, and no `prepare` script. Keep it that way: the package is installed by `dsh plugin add` from a checkout or from GitHub, and a build step turns a one-command install into a toolchain problem.

## Invariants

These are not style preferences. Each one is load-bearing for security or for surviving a DSH upgrade.

1. **Bytes never enter JavaScript.** A single download, a folder archive, and a multi-selection all hand a URL or a form to the browser, which streams the response to disk. Do not fetch content into a Blob, do not buffer an archive in page memory, do not base64 a file into the client.
2. **Every route stays behind Connection's fence.** Register on `connection.fetch.register`. Never add a raw unauthenticated `webServer` route, and never add a query-token scheme of your own.
3. **Writes are mode-gated and narrow.** The only write is one uploaded file into an existing directory: no rename, delete, move, in-place edit, permission change, or shell. The access mode is `read-only` (refuse), `workspace-write` (confine to the Session workspace), or `danger-full-access` (anywhere writable), and the host re-resolves it from the Session's sandbox policy on every request. A client-supplied mode is a user preference, never the guard: containment is re-checked server-side on every write.
4. **Reads go through `ctx.fs`, and so does a text write.** Never touch `node:fs` directly for either. The composed filesystem owns path resolution, regular-file checks, `FS_*` error vocabulary, and symlink behavior, and it is what a sandboxing backend wraps. The one exception is a binary upload, which has no byte-write seam in that contract; it uses the documented local temp-and-rename path, and its README limitation must stay truthful.
5. **Reads are unconfined; only writes are gated.** Directory listing deliberately leaves the Session workspace, because a headless host must be able to hand over files that live beside it. Do not add read confinement to a mode: the mode is an upload policy. Any new route that reaches further must say so in `README.md` under Security, in the module doc, and in the route table.
6. **An upload validates before it writes.** Reject an empty name, `.`, `..`, a separator, or a NUL before resolving anything; require the target directory to exist and be a directory; refuse an existing file unless `overwrite=1`; cap the body both from `Content-Length` and after reading. Never let a name escape its directory.
7. **Errors leak nothing.** Short fixed strings only; no resolved paths, no messages from thrown errors, no stack traces.
8. **Bounds are enforced host-side.** A listing, an archive, and a selection each carry a hard cap and refuse over-cap work instead of truncating silently. Do not let the client be the guard.
9. **The browse page ships no script.** No inline script, no external resource, no event attribute. It carries `default-src 'none'`, escapes every interpolated value, and never reflects a path into a URL that did not come from a listing entry.
10. **The browser half requires only platform seeds.** `react` and `react/jsx-runtime` are seeded by the shell's module table; anything else must not be `require`d. A missing module throws during boot and the whole GUI fails to load.
11. **The client `inject` list names real services.** Every name in `exports.inject` must be provided by the shipped client plane. A name that never appears leaves the plugin fiber pending, and the shell's boot assertion turns that into a failed page. Check `tests/contract.mjs` when adding one.
12. **DOM injection is append-only.** Append injected nodes at the end of their container. Never insert between React-managed siblings, never mutate React-owned attributes, and never remove or reorder official nodes. Every injected node carries `data-dsh-download`, and every effect removes what it added.
13. **Official-first.** Prefer an official slot, the tab registry, or an official service to a DOM decoration. A decoration must depend only on published `data-*` hooks, and the contract test must cover the hook it uses.
14. **No forks of official components.** If a surface needs a change that only a fork would allow, that is a signal to open an upstream issue or to add a smaller entry point, not to vendor a component.

## Layout

| Path | Role |
|---|---|
| `lib/index.js` | host half: constants, `resolveScope`, `resolveTarget`, `parseSandboxMode`/`sessionSandboxMode`/`modeGate`, `fsStatus`/`fsFailure`, `fileStream`, `listResponse`, `downloadResponse`, `browseResponse`/`renderBrowsePage`, the ZIP writer (`crc32`, headers, `archiveStream`), `archiveResponse`, `archiveSelectionResponse`, `uploadResponse`/`writeUpload`/`uploadFailure`, `apply` |
| `lib/client.js` | browser half: module-loader bundle, locale dictionaries, URL/address builders, `TurnDownload`, `BrowserBody`/`BrowserTitle`/`browserDefinition`, `installStyles`, `installDecorators` |
| `cordis.patch.yml` | the one dual-face row this bundle mounts |
| `tests/resolve-dsh.mjs` | locate the DSH install a profile actually runs |
| `tests/host.test.mjs` | route behavior against a fake `ctx.fs`, plus ZIP structure parsing |
| `tests/client.test.mjs` | browser half loaded through a stub module loader |
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
# restart dsh web, open the Sidebar file browser, then download a file, a folder,
# and a multi-selection; also try the server-rendered browse page
dsh plugin --profile web remove dsh-file-download
```

## Adding a surface

1. Check whether an official slot, tab type, or service exists. If it does, use it and stop.
2. Otherwise identify the most stable published hook you can anchor to. Prefer a `data-*` attribute over a class name; class names are content-hashed.
3. Append, never interleave. Re-apply from a single `MutationObserver`, and make the disposer remove every node and listener you added.
4. Add the hook to `tests/contract.mjs` so a DSH upgrade fails loudly instead of silently dropping the surface.
5. Add a static assertion to `tests/validate.mjs` so an accidental rename fails without a browser.

## Adding a route

1. Put it under `/api/workspace.download/…` and register it on the Connection Fetch table.
2. Validate the query, resolve the Session, then resolve the target through `ctx.fs`.
3. If the route writes, resolve the effective mode and gate it (`read-only` refuses, `workspace-write` confines); if it only reads, do not gate it at all.
4. Map failures with `fsStatus`/`archiveFailure`/`uploadFailure`; add a case for any new error code rather than falling through to 500.
5. Bound the response: window reads, entry caps, byte caps. State the cap in the route table.
6. Cover it in `tests/host.test.mjs`, including the failure branches, and in `tests/validate.mjs` for the wiring.

## DSH upgrades

DSH is a moving target. After every upgrade:

1. `npm test` and note the current state.
2. Upgrade DSH, then `npm test` again.
3. Green means nothing to do. Red names the exact hook that moved; update the selector, the service method, or the route contract, then re-run.
4. If an upstream release ships a native file browser or download entry point, prefer removing one of ours over keeping two.

## Commits and reviews

- Conventional Commits, English, imperative, lowercase, no trailing period, subject at most 72 characters.
- The body leads with the problem, then what changed. Prose, not a bullet dump. No emoji.
- One logical change per commit; tests belong in the same change as the behavior they cover.
- Before pushing: the full suite is green, the working tree is clean, and `git status` shows nothing sensitive. `tests/hygiene.test.mjs` guards tracked files against home paths, private addresses, mail addresses, and credential shapes — if it fails, fix the file, never the rule.
- Run `git log origin/main..HEAD` and read the exact list of commits before pushing.

## Do not

- Do not patch an installed DSH package; the fix belongs in this repository or upstream.
- Do not add a dependency to save a few lines. The whole host half is Node built-ins plus the injected services.
- Do not widen the write surface beyond one uploaded file into an existing directory. A rename, delete, or edit needs its own threat model, its own invariants, and its own review — not a quiet route addition here.
- Do not enforce the access mode on the client. The browser's selector is a preference; the host decides.
- Do not weaken the read fence to make a test pass. If a route cannot be authenticated, it does not ship.
