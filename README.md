# dsh-file-download

[English](README.md) | [简体中文](README.zh-CN.md)

Browser-side file download for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Web GUI, wired into the surfaces you already use: the per-turn deliverables row, the delivered-file cards, and the sidebar file tree.

[![license](https://img.shields.io/badge/license-MIT-4c6ef5?style=flat-square&labelColor=454a54)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.1.5--rc.1-4c6ef5?style=flat-square&labelColor=454a54)](#compatibility)

---

## Why this exists

DSH's native file actions are host-side: "open in default app" and "reveal in file manager" need a desktop on the machine that runs the agent. When the Web GUI is reached from another device — a phone, a tablet, a laptop over the LAN, or a headless cloud box behind a reverse proxy — that desktop either does not exist or is not the device showing the page. The file exists on the server, and the browser cannot save it.

Session logs can already be exported as a ZIP, but ordinary produced files cannot. This plugin adds that one missing capability without patching DSH: an authenticated download route plus download entry points on the official file surfaces.

## What it adds

| Surface | Entry point |
|---|---|
| Every closing turn with delivered or changed files | A `Download this turn's files` dropdown listing that turn's files, with a download-all action. Existing `Open` behavior is untouched. |
| Every delivered-file card | One download segment beside the card's existing split Open control. The left button still opens by default. |
| Every sidebar file-tree row | A download button that appears on hover. |

Bytes never pass through JavaScript: each action hands a same-origin URL to the browser's own download manager, so progress, cancel, and "save as" behave exactly as they do for any other download.

## Install

Requirements: DSH `0.1.5-rc.1` or newer in the `0.1.5` line, Node 20+, and a `web` profile.

```sh
# from a local checkout
dsh plugin --profile web add /path/to/dsh-file-download

# or straight from GitHub
dsh plugin --profile web add github:KaguraSayuki/dsh-file-download
```

`dsh plugin add` links the package into the profile and appends it to `dsh.profile.bundles`. Restart `dsh web` afterwards: the client roster is scanned at boot.

Uninstall with:

```sh
dsh plugin --profile web remove dsh-file-download
```

## Usage

No configuration. Open a session, let the agent produce or modify a file, then use any of the three entry points. On a phone or tablet the sidebar file tree is the quickest path: tap the sidebar's file tab, browse to the file, and use the download button on its row.

## How it works

The plugin is a single dual-face Cordis row with no build step and no runtime dependencies.

### Host route

```
GET  /api/workspace.download?sessionId=<id>&path=<path>
HEAD /api/workspace.download?sessionId=<id>&path=<path>
```

The route is registered on Connection's exact Fetch table, so it inherits the same Host/Origin and browser-session checks as every other `/api` call; it is not an unauthenticated side door. Reads go through the composed `workspaceFiles` service, which keeps file identity, regular-file checks, and workspace-relative path resolution identical to the official sidebar preview.

| Aspect | Behavior |
|---|---|
| Response | `Content-Disposition: attachment` with an RFC 5987 filename, a media type guessed from the extension, and `Content-Length` when the backend reports a size |
| Body | A paged stream: one bounded window (256 KiB) per pull, so a large file costs one window of memory |
| `HEAD` | Same status and headers, no content read |
| Errors | `400` bad request, `403` outside the workspace, `404` missing file or Session, `413` over the complete-file cap, `500` otherwise |

### Browser surfaces

The turn dropdown is a real occupant of the official `conversation.chat.turnTail` chain slot. It reads the same Turn data the official deliverables row reads, so the two lists cannot disagree; it registers no new data.

The delivered-file card and file-tree buttons are DOM decorations over hooks those packages already publish (`data-presented-file`, `data-files-entry`, `data-files-path`). Each injected node is appended at the end of its container rather than interleaved between React-managed siblings, and a `MutationObserver` re-applies decorations after a re-render. Removing the plugin removes every injected node.

## Security

- **Authenticated**: the route lives behind Connection's fence, exactly like `/api/remote.mux`, so an unauthenticated visitor cannot enumerate or fetch files.
- **Read-only**: the plugin exposes no mutation, no upload, and no directory listing.
- **Same authority as preview**: a file is downloadable only if the Session's own composed filesystem can read it. Workspace containment is not widened.
- **No caching**: responses carry `cache-control: no-store`.
- **No path echo**: error bodies are short fixed strings, never a resolved path or a stack trace.

If you expose the Web GUI to a network, secure it at the network layer as you would without this plugin; this plugin does not change that posture.

## Compatibility

DSH is a moving target, so the hooks this plugin composes are re-checked by a contract test against the DSH install a profile actually runs:

```sh
DSH_MODULES=/path/to/node_modules npm run contract
```

The contract test currently passes against DSH `0.1.5-rc.1`. After a DSH upgrade, run `npm test`; a red contract check names the exact upstream hook that moved.

## Development

```sh
npm test          # static validation + unit tests + upstream contract
npm run validate  # manifest, patch, and bundle wiring only
npm run unit      # host route unit tests only
npm run contract  # upstream hook contract only
```

Layout:

| Path | Role |
|---|---|
| `lib/index.js` | host half: the authenticated route, scope resolution, paged streaming, failure mapping |
| `lib/client.js` | browser half: the turn-tail slot entry and the DOM decorations |
| `cordis.patch.yml` | the one dual-face row this bundle mounts |
| `tests/host.test.mjs` | route contract with a fake context: streaming, headers, `HEAD`, failures |
| `tests/validate.mjs` | static wiring checks over the manifest, patch, and bundles |
| `tests/contract.mjs` | upstream hook checks against the installed DSH |
| `tests/hygiene.test.mjs` | leak guard over tracked files |

The browser half is hand-written in the `window.__ModuleLoader__.load({ id, factory })` shape DSH serves, and requires only the platform seeds `react` and `react/jsx-runtime`. There is no bundler, no `prepare` script, and no dependency to install.

## Limitations

- **No range requests or resume.** A download restarts if interrupted; very large files need a stable connection. Streaming to disk is the browser's job, but `Range` is not implemented yet.
- **Download-all is a burst of downloads.** Browsers may ask for permission or block the extra downloads when a turn has many files. Per-file downloads are always reliable.
- **Regular files only.** Directories, symlinks, and special files are refused by the same service the preview uses; there is no archive bundling.
- **A turn's list is bounded by the official row.** Only files that the official deliverables row would show are listed: successful first-party mutations and explicit `present` declarations.

## Related work

Several DSH plugins offer file browsing or download through their own panels. This one deliberately does not add a panel: it extends the official surfaces, so it composes with whichever sidebar or panel plugin you already run.

## License

[MIT](LICENSE) © 2026 KaguraSayuki
