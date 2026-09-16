# dsh-file-download

[English](README.md) | [简体中文](README.zh-CN.md)

A file browser, download surface, and mode-gated upload for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Web GUI: browse the machine that serves the agent — including everything outside the session workspace — download a file, download a folder as a ZIP, archive a multi-selection in one stream, and upload files with an overwrite prompt. It extends the official Sidebar through the official tab registry instead of patching DSH.

[![license](https://img.shields.io/badge/license-MIT-4c6ef5?style=flat-square&labelColor=454a54)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.1.5--rc.1-4c6ef5?style=flat-square&labelColor=454a54)](#compatibility)

---

## Why this exists

DSH's native file actions are host-side: "open in default app" and "reveal in file manager" need a desktop on the machine that runs the agent. When the Web GUI is reached from another device — a phone, a tablet, a laptop over the LAN, or a headless cloud box behind a reverse proxy — that desktop either does not exist or is not the device showing the page. The file exists on the server, and the browser cannot save it.

The official Sidebar file tree is also confined to the session workspace, and it cannot hand a folder over at all. This plugin adds the missing read side: a browser that starts at the workspace but follows any absolute path the serving filesystem can read, plus downloads and folder archives.

## What it adds

| Surface | Entry point |
|---|---|
| Official right Sidebar | A **Files** tab registered through `ctx.sidebarRightTabs`: navigate from the project root to `/`, filter a directory, show hidden entries, open a file in the official preview, copy a path, insert a path into the composer, download a file, download a folder as a ZIP, tick several entries and archive them together, and upload files — asking before it overwrites an existing one. |
| Every closing turn with delivered or changed files | A `Download this turn's files` dropdown, plus a link to the host-rendered browse page. Existing `Open` behavior is untouched. |
| Every delivered-file card | One download segment beside the card's existing split Open control. The left button still opens by default. |
| Every Sidebar file-tree row | A hover download button: the file itself, or a streamed ZIP for a directory. |
| Any device, no client JS | A server-rendered browse page (`/api/workspace.download/browse`) with breadcrumbs, per-file download and per-folder ZIP. No script ships with it, so a phone that never opens the full GUI can still retrieve a file. |

Bytes never enter JavaScript for a single download: each of those hands a same-origin URL to the browser's download manager. A multi-selection uses a hidden form POST so the browser streams one ZIP to disk instead of buffering it in page memory.

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

Open the right Sidebar and pick **Files** from the tab guide.

- **Project** jumps to the session workspace root; **Root** jumps to `/`. The breadcrumb row is also the path box: the pencil at its end opens an input, and a typed path is relative to the folder on screen unless it starts with `/` (absolute) or `~` (the host's home directory). Names complete as you type — arrows move, Tab takes one, Enter goes.
- **Show hidden** reveals dotfiles, which are hidden by default. The filter box narrows the current directory without leaving it.
- Clicking a folder enters it; clicking a file opens it in the official preview tab.
- Row actions: preview, download, download ZIP (folders), copy path, and insert path into the composer. Inside the workspace the inserted text is an `@relative/path` reference; outside it is the absolute path.
- Tick rows to select them; the footer then offers **Download selected (ZIP)**, which archives everything selected — files and whole folders — into one stream.

## How it works

The plugin is a single dual-face Cordis row with no build step and no runtime dependencies.

### Host routes

Every route is registered on Connection's exact Fetch table, so all of them inherit the same Host/Origin and browser-session checks as the rest of `/api`; none is an unauthenticated side door.

| Route | Purpose |
|---|---|
| `GET /api/workspace.download/list?sessionId=&path=` | JSON listing of any readable directory: `{ path, parent, workspaceRoot, entries, truncated }` |
| `GET\|HEAD /api/workspace.download?sessionId=&path=` | One regular file, streamed in 256 KiB windows, with `Content-Disposition: attachment`, an `ETag`, and `Range` / `If-Range` support so a browser download manager can resume an interrupted transfer |
| `GET /api/workspace.download/browse?sessionId=&path=` | Script-free HTML listing with breadcrumbs and per-entry download/ZIP links |
| `GET\|HEAD /api/workspace.download/archive?sessionId=&path=` | One directory subtree as a streamed ZIP |
| `POST /api/workspace.download/archive` | A multi-selection as one ZIP; accepts JSON, or a form field named `payload` |
| `POST /api/workspace.download/upload?sessionId=&path=<dir>&name=<file>&mode=&overwrite=` | One uploaded file into one directory; the body is the file bytes |

A missing or empty `path` means the session workspace root. A relative path resolves against it; an absolute path may leave it.

### Access modes

Reading is never confined: browsing, previewing, downloading, and archiving reach every folder the serving account can read, in every mode. The mode gates **uploads** only, defaults to the Session's own sandbox policy, and can be changed from the browser's own selector.

| Mode | Browse / preview / download / ZIP | Upload |
|---|---|---|
| `read-only` | every folder | refused |
| `workspace-write` | every folder | the Session workspace only |
| `danger-full-access` | every folder | anywhere the account can write |

The browser starts from the Session's resolved mode and remembers a per-Session override in `localStorage`; when the two differ the toolbar says so. Nothing about the mode is enforced by the client alone — the host re-resolves it on every upload and re-checks containment.

Upload bodies are capped at 64 MiB. A text body is written through the composed filesystem's atomic `writeText`, so the backend applies its own sandbox policy as well; a binary body has no byte-write seam in that contract and is written next to its target through a temp file and a rename, which is correct when the backend's execution world is this host (the local provider). Without `overwrite=1`, an existing file is refused with `409` so the browser can ask.

### Browser surfaces

The Files tab is a real tab type registered through `ctx.sidebarRightTabs` and its body through the keyed `sidebar.right.pane.tab` slot — the same extension points the official Files tab uses, so nothing official is patched. It is a page type, so it never competes with the preview for a file address.

The turn dropdown is an occupant of the official `conversation.chat.turnTail` chain slot and reads the same Turn data the official deliverables row reads, so the two lists cannot disagree.

The delivered-file card and file-tree buttons are DOM decorations over hooks those packages already publish (`data-presented-file`, `data-files-entry`, `data-files-path`). Each injected node is appended at the end of its container rather than interleaved between React-managed siblings, and a `MutationObserver` re-applies decorations after a re-render. Removing the plugin removes every injected node.

### Serving, resuming, and compression

A file is read one 256 KiB window at a time. The route answers `Range` requests with `206` and the exact window asked for, carries an `ETag` derived from the file's version and size, and honours `If-Range` so a resume that would append to a changed file is refused and the whole file is sent instead. That is what makes the browser's own download manager able to resume: the client never has to implement it.

ZIP is written by hand over Node's `zlib`: one local record per entry, the entry's body streamed window by window straight into a raw deflate stream, a data descriptor closing it, then the central directory and its end record. Nothing buffers a whole file, so archive memory is one deflate window plus one read window no matter how large an entry is. Entries are deflated at zlib's ordinary default level. Formats that are already compressed (images, video, audio, archives, the Office files, PDF) are stored outright, and every other entry is probed with a level-1 deflate of its first window, so an unknown binary format that does not compress is stored instead of spending level 9 to grow. Archive responses advertise `Accept-Ranges: none`, because a generated ZIP has no stable identity to resume against.

## Security

This plugin reads **any file the serving operating system account can read**, not only the session workspace. That is the point — a headless host has to be able to hand over a file that lives next to the workspace — but it is a wider capability than the official file tree, and it should be a deliberate choice.

- **Authenticated, not anonymous.** Every route, uploads included, lives behind Connection's fence, exactly like `/api/remote.mux`. An unauthenticated visitor cannot list, fetch, or write anything.
- **Writes are mode-gated and bounded.** The only write is one uploaded file into an existing directory. There is no rename, delete, move, edit, permission change, or shell. `read-only` refuses every write; `workspace-write` confines writes to the Session workspace; `danger-full-access` allows any writable place. The host re-checks on every request; the client is never the guard.
- **No path echo.** Error bodies are short fixed strings; a resolved path or a stack trace never leaves the process.
- **No script.** The browse page ships no JavaScript and no external resource; it carries `default-src 'none'`, `frame-ancestors 'none'`, and `Referrer-Policy: no-referrer`. Every interpolated name is HTML-escaped.
- **Bounded.** A listing is capped at 5000 entries, an archive at 20000 entries / 2 GiB in total, a multi-selection at 200 paths, and an upload at 64 MiB; over-cap work is refused rather than silently truncated. A single entry has no size cap of its own — it is streamed, not buffered.
- **Sessions are still named.** A request must name a real Session; its workspace root is the default directory.

If that read scope is too wide for a deployment, do not install this plugin there, or run `dsh web` on loopback behind an authenticating reverse proxy. Removing the plugin removes the capability.

## Compatibility

DSH is a moving target, so every hook this plugin composes is re-checked by a contract test against the DSH install a profile actually runs:

```sh
DSH_MODULES=/path/to/node_modules npm run contract
```

The contract test currently passes against DSH `0.1.5-rc.1`. After a DSH upgrade, run `npm test`; a red contract check names the exact upstream hook that moved.

## Development

```sh
npm test          # static validation + unit tests + upstream contract
npm run validate  # manifest, patch, and bundle wiring only
npm run unit      # unit tests only (host routes + browser half)
npm run contract  # upstream hook contract only
```

Layout:

| Path | Role |
|---|---|
| `lib/index.js` | host half: scope resolution, `ctx.fs` reads, the JSON listing, streaming download, HTML browse page, ZIP writer, failure mapping |
| `lib/client.js` | browser half: the Sidebar tab type and body, the turn-tail dropdown, the DOM decorations |
| `cordis.patch.yml` | the one dual-face row this bundle mounts |
| `tests/host.test.mjs` | route behavior against a fake `ctx.fs`, including ZIP structure |
| `tests/client.test.mjs` | browser half: module-loader registration, tab registration, URL and address builders, decoration pass |
| `tests/validate.mjs` | static wiring checks |
| `tests/contract.mjs` | upstream hook checks |
| `tests/hygiene.test.mjs` | leak guard over tracked files |

The browser half is hand-written in the `window.__ModuleLoader__.load({ id, factory })` shape DSH serves, and requires only the platform seeds `react` and `react/jsx-runtime`. There is no bundler, no `prepare` script, and no dependency to install.

## Limitations

- **Write scope is narrow by design.** Upload adds a file into an existing directory; it cannot create directories, rename, move, delete, or edit in place. Directories are created by the agent or by `mkdir` in a shell.
- **Resume is the browser's.** The route serves `Range`, so the download manager resumes; a client that ignores it simply starts over. A generated ZIP cannot resume, because it has no stable byte identity between requests.
- **Archive caps are hard.** A tree over 20000 entries or 2 GiB in total is refused instead of streamed. The total cap keeps every offset inside the 32-bit fields this writer emits, which is why no ZIP64 record is needed; raising it means implementing ZIP64.
- **Symlinks and special files are skipped** rather than followed, in listings and archives alike.
- **Binary uploads assume a local execution world.** A text upload always goes through the composed filesystem; a binary one is written by the host process, so a backend whose execution world is not this host (a remote workspace) would text-upload correctly but binary-upload to the wrong place.
- **Download-all is a burst of downloads.** Browsers may ask for permission or block the extra downloads when a turn has many files; per-file downloads are always reliable.
- **A turn's list is bounded by the official row.** Only files the official deliverables row would show are listed: successful first-party mutations and explicit `present` declarations.

## License

[MIT](LICENSE) © 2026 KaguraSayuki
