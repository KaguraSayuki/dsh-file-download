/**
 * dsh-file-download — browser half.
 *
 * Four surfaces, no official source changes:
 *
 *   1. `sidebar.right.pane.tab` — a real Sidebar tab type registered through the
 *      official `ctx.sidebarRightTabs` registry: a file browser that starts at
 *      the Session workspace but follows an absolute path anywhere the serving
 *      filesystem can read. Rows download a file, download a folder as a ZIP,
 *      open a file in the official preview, copy a path, or push a reference to
 *      the composer; checkbox selection archives many entries as one ZIP.
 *   2. `conversation.chat.turnTail` (official chain slot) — a compact
 *      "download this turn's files" control plus a link to the host-rendered
 *      browse page.
 *   3. Delivered-file cards (`[data-presented-file]`) — one download segment
 *      appended to the card's own split control. "Open" stays the default.
 *   4. Sidebar file-tree rows (`li[data-files-entry][data-files-path]`) — a hover
 *      download button: the file itself, or a streamed ZIP for a directory.
 *
 * Surfaces 3 and 4 are DOM decorations over stable `data-*` hooks the official
 * packages publish; a MutationObserver re-applies them after a re-render, and
 * every injected node is appended at the end of its container rather than
 * interleaved between React-managed siblings.
 *
 * Bytes never enter JavaScript for a single download: every one of those hands a
 * same-origin URL to the download manager. Only the multi-select action submits
 * a form, which the browser streams to disk without buffering the archive.
 *
 * @module dsh-file-download/client
 */

window.__ModuleLoader__.load({
	id: "dsh-file-download",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");
		var jsxRuntime = require("react/jsx-runtime");
		var jsx = jsxRuntime.jsx;
		var jsxs = jsxRuntime.jsxs;
		var h = React.createElement;

		/** Must match the host routes in lib/index.js. */
		const DOWNLOAD_PATH = "/api/workspace.download";
		const LIST_PATH = "/api/workspace.download/list";
		const BROWSE_PATH = "/api/workspace.download/browse";
		const ARCHIVE_PATH = "/api/workspace.download/archive";
		const UPLOAD_PATH = "/api/workspace.download/upload";

		/** Locale namespace owned by this plugin. */
		const NS = "file-download";
		/** Marks every node this plugin injects into official DOM. */
		const MARK = "data-dsh-download";
		/** Tab type identity: the sidebar type id and the key its body registers under. */
		const TAB_ID = "dsh-file-download";
		const TAB_KIND = "workspace-browser";
		/** The three access modes, weakest first; kept in step with the host. */
		const MODES = ["read-only", "workspace-write", "danger-full-access"];

		/** Where one Session's browser-mode override lives. */
		function modeStorageKey(sessionId) {
			return `dsh-file-download:mode:${String(sessionId)}`;
		}

		/** Simplified Chinese dictionary (key-set source of truth). */
		const zh = {
			label: "下载",
			turn: "下载本轮文件",
			all: "全部下载",
			folder: "下载文件夹 (ZIP)",
			browse: "浏览文件（新页面）",
			empty: "本轮没有可下载的文件",
			failed: "下载失败",
			"tab.title": "文件浏览器",
			"guide.title": "文件浏览器",
			"guide.description": "浏览整台机器上的文件，下载文件或文件夹",
			"root.project": "项目",
			"root.filesystem": "根目录",
			up: "上级",
			refresh: "刷新",
			"hidden.show": "显示隐藏项",
			"hidden.hide": "隐藏隐藏项",
			"filter.placeholder": "筛选当前目录…",
			"path.placeholder": "相对当前目录、/ 开头或 ~ 主目录，输入即补全",
			go: "跳转",
			"path.edit": "输入路径",
			loading: "正在读取…",
			"empty.dir": "空目录",
			truncated: "条目太多，只显示了一部分。",
			selected: "已选 {count} 项",
			"selected.download": "打包下载所选",
			clear: "清除",
			open: "预览",
			download: "下载",
			zip: "压缩下载",
			copy: "复制路径",
			reference: "插入路径",
			copied: "已复制",
			other: "特殊文件",
			noWorkspace: "该会话没有工作区目录。",
			error: "读取失败：{message}",
			"mode.label": "访问模式",
			"mode.read-only": "只读",
			"mode.workspace-write": "工作区写入",
			"mode.danger-full-access": "完全访问",
			"mode.following": "DSH：{mode}",
			"mode.hint.read-only": "下载不受限；不能上传",
			"mode.hint.workspace-write": "下载不受限；上传仅限工作区",
			"mode.hint.danger-full-access": "下载不受限；上传任意可写文件夹",
			upload: "上传",
			"upload.overwrite": "“{name}” 已存在，要覆盖吗？",
			"upload.failed": "上传失败：{name}",
			"upload.done": "已上传 {count} 个文件",
			"upload.readonly": "只读模式下不能上传",
			"upload.pending": "正在上传…"
		};
		/** English dictionary (same key set). */
		const en = {
			label: "Download",
			turn: "Download this turn's files",
			all: "Download all",
			folder: "Download folder (ZIP)",
			browse: "Browse files (new page)",
			empty: "No downloadable files in this turn",
			failed: "Download failed",
			"tab.title": "Files",
			"guide.title": "File browser",
			"guide.description": "Browse the whole machine and download files or folders",
			"root.project": "Project",
			"root.filesystem": "Root",
			up: "Up",
			refresh: "Refresh",
			"hidden.show": "Show hidden",
			"hidden.hide": "Hide hidden",
			"filter.placeholder": "Filter this directory…",
			"path.placeholder": "Relative to this folder, / absolute, or ~ home — completions appear as you type",
			go: "Go",
			"path.edit": "Enter a path",
			loading: "Loading…",
			"empty.dir": "Empty directory",
			truncated: "Too many entries; only some are shown.",
			selected: "{count} selected",
			"selected.download": "Download selected (ZIP)",
			clear: "Clear",
			open: "Preview",
			download: "Download",
			zip: "Download ZIP",
			copy: "Copy path",
			reference: "Insert path",
			copied: "Copied",
			other: "Special file",
			noWorkspace: "This session has no workspace directory.",
			error: "Failed: {message}",
			"mode.label": "Access",
			"mode.read-only": "Read-only",
			"mode.workspace-write": "Workspace write",
			"mode.danger-full-access": "Full access",
			"mode.following": "DSH: {mode}",
			"mode.hint.read-only": "Downloads are unconfined; uploads are off",
			"mode.hint.workspace-write": "Downloads are unconfined; uploads stay in the workspace",
			"mode.hint.danger-full-access": "Downloads are unconfined; uploads may go anywhere writable",
			upload: "Upload",
			"upload.overwrite": "{name} already exists. Overwrite it?",
			"upload.failed": "Upload failed: {name}",
			"upload.done": "Uploaded {count} file(s)",
			"upload.readonly": "Read-only mode cannot upload",
			"upload.pending": "Uploading…"
		};

		/** Inline download glyph; `currentColor` keeps it theme-correct. */
		const ICON =
			'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" ' +
			'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
			'<path d="M8 2v8"/><path d="M4.5 6.8 8 10.3l3.5-3.5"/><path d="M3 13h10"/></svg>';

		/** Stylesheet for every injected surface, scoped by our own classes. */
		const CSS = `
[${MARK}]{box-sizing:border-box}
.dsh-dl-seg{align-self:stretch;display:inline-flex;align-items:center;justify-content:center;padding:5px 6px;border:0;border-left:.5px solid var(--dsw-alias-border-l3);background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:var(--dsw-font-family)}
.dsh-dl-seg:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-dl-seg:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--dsw-alias-border-l3)}
.dsh-dl-float{position:absolute;top:6px;right:6px;z-index:3;width:22px;height:22px;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-button-floating-fill);color:var(--dsw-alias-label-secondary);cursor:pointer;align-items:center;justify-content:center;display:none}
[data-presented-file]:hover>.dsh-dl-float,[data-presented-file]:focus-within>.dsh-dl-float{display:inline-flex}
li[data-files-entry]{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:2px}
li[data-files-entry]>ul{grid-column:1/-1}
li[data-files-entry]>button:not([${MARK}]){min-width:0}
li[data-files-entry]>.dsh-dl-row{width:26px;height:26px;padding:0;border:0;border-radius:8px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;align-items:center;justify-content:center;display:none}
li[data-files-entry]:hover>.dsh-dl-row,li[data-files-entry]:focus-within>.dsh-dl-row{display:inline-flex}
li[data-files-entry]>.dsh-dl-row:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-dl-wrap{position:relative;display:inline-flex;margin-top:8px;font-size:13px;line-height:22px}
.dsh-dl-trigger{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;background:0 0;border:0;border-radius:8px;padding:1px 8px 1px 6px}
.dsh-dl-trigger:hover,.dsh-dl-trigger[aria-expanded="true"]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-dl-pop{position:absolute;top:100%;left:0;z-index:60;margin-top:4px;min-width:220px;max-width:min(460px,80vw);max-height:320px;overflow:auto;padding:4px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-static-neutral-50);box-shadow:0 8px 28px rgba(0,0,0,.28)}
body[data-ds-dark-theme] .dsh-dl-pop{background:var(--dsw-static-neutral-850)}
.dsh-dl-item{display:block;width:100%;text-align:left;font:inherit;color:var(--dsw-alias-label-primary);background:0 0;border:0;border-radius:8px;padding:5px 8px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-dl-item:hover{background:var(--dsw-static-neutral-100)}
body[data-ds-dark-theme] .dsh-dl-item:hover{background:var(--dsw-static-neutral-800)}
.dsh-dl-item[data-all="true"]{color:var(--dsw-alias-link);font-weight:500}
.dsh-dl-note{color:var(--dsw-alias-label-tertiary);padding:5px 8px}
.dsh-dl-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l3)}
.dsh-fb{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dsh-fb-bar{display:flex;align-items:center;gap:4px;padding:6px 8px;flex:none;border-bottom:.5px solid var(--dsw-alias-border-l3);flex-wrap:wrap}
.dsh-fb-btn{display:inline-flex;align-items:center;gap:4px;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);background:0 0;border:.5px solid transparent;border-radius:8px;padding:3px 8px;cursor:pointer;white-space:nowrap}
.dsh-fb-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-fb-btn[data-active="true"]{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-fb-btn:disabled{opacity:.45;cursor:default}
.dsh-fb-input{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:0 0;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;padding:3px 8px;min-width:0;flex:1 1 110px}
.dsh-fb-crumbs{position:relative;display:flex;align-items:center;flex-wrap:wrap;gap:2px;padding:4px 10px;flex:none;font-size:12px;color:var(--dsw-alias-label-tertiary);border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dsh-fb-crumb{font:inherit;font-size:12px;color:inherit;background:0 0;border:0;border-radius:6px;padding:1px 5px;cursor:pointer}
.dsh-fb-crumb:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-fb-crumb[data-current="true"]{color:var(--dsw-alias-label-primary)}
.dsh-fb-list{list-style:none;margin:0;padding:6px 6px 16px;overflow:auto;min-height:0;flex:1}
.dsh-fb-row{display:flex;align-items:center;gap:8px;padding:3px 6px;border-radius:8px}
.dsh-fb-row:hover,.dsh-fb-row[data-selected="true"]{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-fb-check{flex:none;margin:0}
.dsh-fb-name{display:flex;align-items:center;gap:6px;min-width:0;flex:1;font:inherit;color:inherit;text-align:left;background:0 0;border:0;padding:0;cursor:pointer}
.dsh-fb-name:hover .dsh-fb-text{text-decoration:underline}
.dsh-fb-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-fb-size{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-fb-actions{display:flex;align-items:center;gap:2px;flex:none}
.dsh-fb-act{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;font:inherit;font-size:11px;color:var(--dsw-alias-label-tertiary);background:0 0;border:0;border-radius:7px;cursor:pointer;padding:0 4px}
.dsh-fb-act:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-fb-note{padding:10px;color:var(--dsw-alias-label-tertiary)}
.dsh-fb-foot{flex:none;display:flex;align-items:center;gap:8px;padding:6px 10px;border-top:.5px solid var(--dsw-alias-border-l3);font-size:12px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap}
.dsh-fb-danger{color:var(--dsw-alias-state-error-primary)}
.dsh-fb-copied{color:var(--dsw-alias-label-secondary)}
.dsh-fb-select{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:0 0;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;padding:3px 6px;max-width:150px}
.dsh-fb-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-fb-edit{margin-left:auto;color:var(--dsw-alias-label-tertiary)}
.dsh-fb-suggest{position:absolute;top:100%;left:8px;right:8px;z-index:60;max-height:280px;overflow:auto;margin-top:2px;padding:4px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-static-neutral-50);box-shadow:0 8px 28px rgba(0,0,0,.28)}
body[data-ds-dark-theme] .dsh-fb-suggest{background:var(--dsw-static-neutral-850)}
.dsh-fb-suggest>button{display:flex;align-items:center;gap:8px;width:100%;text-align:left;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:0 0;border:0;border-radius:8px;padding:4px 8px;cursor:pointer}
.dsh-fb-suggest>button[data-active="true"]{background:var(--dsw-static-neutral-100)}
body[data-ds-dark-theme] .dsh-fb-suggest>button[data-active="true"]{background:var(--dsw-static-neutral-800)}
.dsh-fb-suggest>button>span:last-child{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary)}
`;

		/** Browser origin, with the connection carrier's null-origin fallback. */
		function hostBase() {
			const origin = globalThis.location?.origin;
			return origin !== undefined && origin !== "null" ? origin : "http://dsh.internal";
		}

		/** Trailing path segment for a download filename. */
		function basename(value) {
			const trimmed = String(value).replace(/[\\/]+$/u, "");
			const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
			return cut === -1 ? trimmed : trimmed.slice(cut + 1);
		}

		/** Join one child onto an absolute directory path. */
		function childOf(parent, name) {
			return parent === "/" ? `/${name}` : `${String(parent).replace(/[/\\]+$/u, "")}/${name}`;
		}

		/** Parent of one absolute path, keeping the root intact. */
		function parentPath(value) {
			const trimmed = String(value).replace(/[\\/]+$/u, "");
			if (trimmed === "") return "/";
			const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
			if (cut < 0) return trimmed;
			if (cut === 0) return trimmed.slice(0, 1);
			return trimmed.slice(0, cut);
		}

		/** Whether a typed path already names a place from the filesystem root. */
		function isAbsolutePath(value) {
			const text = String(value);
			return text.startsWith("/") || text.startsWith("\\\\") || /^[A-Za-z]:[\\/]/u.test(text);
		}

		/**
		 * Turn whatever the user typed into a path the host understands: `~` is
		 * left for the host to expand, an absolute path is passed through, and
		 * anything else is joined onto the directory being viewed.
		 * @param value - the typed text.
		 * @param currentDir - the absolute directory on screen.
		 * @returns The path to navigate to, or null when nothing was typed.
		 */
		function resolveDraft(value, currentDir) {
			const text = String(value ?? "").trim();
			if (text === "") return null;
			if (text === "~" || text.startsWith("~/") || text.startsWith("~\\\\")) return text;
			if (isAbsolutePath(text)) return text;
			const base = currentDir === undefined || currentDir === "" ? "/" : String(currentDir);
			return base === "/" ? `/${text}` : `${base.replace(/[/\\]+$/u, "")}/${text}`;
		}

		/**
		 * Split typed text into the directory to list and the prefix to complete.
		 * @param draft - the typed text.
		 * @returns `{ dir, prefix }`, where `dir` keeps its trailing separator.
		 */
		function splitDraft(draft) {
			const text = String(draft ?? "");
			const cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
			return cut === -1 ? { dir: "", prefix: text } : { dir: text.slice(0, cut + 1), prefix: text.slice(cut + 1) };
		}

		/** Breadcrumb trail for one absolute path; kept in step with the host copy. */
		function breadcrumbsFor(value) {
			const normalized = String(value).replace(/\\/gu, "/");
			const parts = normalized.split("/").filter((part) => part !== "");
			const crumbs = [{ label: "/", path: "/" }];
			let accumulated = "";
			for (const part of parts) {
				accumulated = accumulated === "" || accumulated === "/" ? `/${part}` : `${accumulated}/${part}`;
				crumbs.push({ label: part, path: accumulated });
			}
			return crumbs;
		}

		/** Human-readable size for one browser row. */
		function formatSize(bytes) {
			if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
			if (bytes < 1024) return `${Math.round(bytes)} B`;
			const units = ["KB", "MB", "GB", "TB"];
			let value = bytes / 1024;
			let unit = 0;
			while (value >= 1024 && unit < units.length - 1) {
				value /= 1024;
				unit += 1;
			}
			return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
		}

		/** Same-origin authenticated download URL for one file of one Session. */
		function downloadUrl(sessionId, path) {
			const url = new URL(DOWNLOAD_PATH, hostBase());
			url.searchParams.set("sessionId", String(sessionId));
			url.searchParams.set("path", String(path));
			return url.toString();
		}

		/** Same-origin authenticated ZIP URL for one directory of one Session. */
		function archiveUrl(sessionId, path) {
			const url = new URL(ARCHIVE_PATH, hostBase());
			url.searchParams.set("sessionId", String(sessionId));
			url.searchParams.set("path", String(path));
			return url.toString();
		}

		/** Same-origin authenticated JSON listing URL for one directory. */
		function listUrl(sessionId, path) {
			const url = new URL(LIST_PATH, hostBase());
			url.searchParams.set("sessionId", String(sessionId));
			if (path !== undefined && path !== null && path !== "") url.searchParams.set("path", String(path));
			return url.toString();
		}

		/** Same-origin authenticated upload URL for one file name in one directory. */
		function uploadUrl(sessionId, directory, name, mode, overwrite) {
			const url = new URL(UPLOAD_PATH, hostBase());
			url.searchParams.set("sessionId", String(sessionId));
			if (directory !== undefined && directory !== null && directory !== "") url.searchParams.set("path", String(directory));
			url.searchParams.set("name", String(name));
			if (mode !== undefined && mode !== null) url.searchParams.set("mode", String(mode));
			if (overwrite === true) url.searchParams.set("overwrite", "1");
			return url.toString();
		}

		/** Same-origin authenticated browse-page URL for one Session. */
		function browseUrl(sessionId) {
			const url = new URL(BROWSE_PATH, hostBase());
			url.searchParams.set("sessionId", String(sessionId));
			return url.toString();
		}

		/** Hand one same-origin URL to the browser's download manager. */
		function triggerDownload(url, filename) {
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = filename;
			anchor.rel = "noopener";
			anchor.style.display = "none";
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
		}

		/** Save one file. */
		function saveFile(sessionId, path) {
			if (sessionId === undefined || sessionId === null || sessionId === "") return;
			triggerDownload(downloadUrl(sessionId, path), basename(path) || "download");
		}

		/** Save one directory as a ZIP archive. */
		function saveArchive(sessionId, path) {
			if (sessionId === undefined || sessionId === null || sessionId === "") return;
			triggerDownload(archiveUrl(sessionId, path), `${basename(path) || "workspace"}.zip`);
		}

		/**
		 * Submit a multi-select archive through a hidden form, so the browser
		 * streams the ZIP to disk instead of buffering it in page memory.
		 * @param sessionId - owning Session.
		 * @param paths - selected absolute paths.
		 */
		function submitSelectionArchive(sessionId, paths) {
			if (paths.length === 0) return;
			const frameName = `dsh-dl-${Date.now().toString(36)}`;
			const frame = document.createElement("iframe");
			frame.name = frameName;
			frame.style.display = "none";
			const form = document.createElement("form");
			form.method = "POST";
			form.action = new URL(ARCHIVE_PATH, hostBase()).toString();
			form.target = frameName;
			form.style.display = "none";
			const payload = document.createElement("input");
			payload.type = "hidden";
			payload.name = "payload";
			payload.value = JSON.stringify({ sessionId: String(sessionId), paths });
			form.appendChild(payload);
			document.body.append(frame, form);
			form.submit();
			setTimeout(() => {
				form.remove();
				frame.remove();
			}, 120000);
		}

		/** Open the browse page in a new tab; the page itself needs no script. */
		function openBrowse(sessionId) {
			if (sessionId === undefined || sessionId === null || sessionId === "") return;
			const opened = globalThis.open?.(browseUrl(sessionId), "_blank", "noopener");
			if (opened !== undefined && opened !== null) opened.opener = null;
		}

		/** Component-encode one id or path segment, keeping `:` literal for drive letters. */
		function encodeSegment(segment) {
			return encodeURIComponent(segment).replace(/%3A/gi, ":");
		}

		/** Encode a `/`-separated path segment by segment. */
		function encodePath(path) {
			return String(path).split("/").map(encodeSegment).join("/");
		}

		/** The `dsh-resource://file/…` address the official preview opens. */
		function sessionFileAddress(sessionId, path) {
			const normalized = String(path).replace(/\\/gu, "/").replace(/^(?:\.\/)+/u, "");
			return `dsh-resource://file/session/${encodeSegment(sessionId)}/${encodePath(normalized)}`;
		}

		/**
		 * Text that names one path to the model: a workspace-relative `@reference`
		 * inside the Session root, the absolute path otherwise.
		 * @param path - absolute path.
		 * @param cwd - the Session workspace root, when known.
		 * @returns the text to insert into the composer.
		 */
		function referenceText(path, cwd) {
			if (typeof cwd === "string" && cwd !== "") {
				const root = cwd.replace(/[\\/]+$/u, "");
				if (path === root) return `@${basename(path)}`;
				if (path.startsWith(`${root}/`)) return `@${path.slice(root.length + 1)}`;
			}
			return path;
		}

		/**
		 * The Turn's delivered and changed files, in the official row's order:
		 * explicit deliveries first, then files the mutation tools produced.
		 * Mirrors `presentedForClosing` and `producedForClosing` from
		 * `@deepseek-ai/dsh-client-ui-deliverables` against the same Turn data,
		 * without depending on that package's module row.
		 * @param owner - turn-tail owner currency.
		 * @returns unique paths, or an empty array.
		 */
		function turnFiles(owner) {
			const data = owner?.turn?.data?.get?.("deliverables");
			const paths = [];
			const seen = new Set();
			for (const file of data?.presented ?? []) {
				if (file.seq >= owner.seq || seen.has(file.path)) continue;
				seen.add(file.path);
				paths.push(file.path);
			}
			for (const produced of data?.produced ?? []) {
				if (produced.seq > owner.seq || seen.has(produced.path)) continue;
				seen.add(produced.path);
				paths.push(produced.path);
			}
			return paths;
		}

		/** Claim the turn-tail chain only when the closing turn has files. */
		function selectTurnFiles(owner) {
			const paths = turnFiles(owner);
			return paths.length === 0 ? null : paths;
		}

		/**
		 * One turn's download dropdown.
		 * @param props - matched paths, the Session seat, and localized copy.
		 * @returns the dropdown control.
		 */
		function TurnDownload({ matched, sessionId, t }) {
			const [open, setOpen] = React.useState(false);
			const wrap = React.useRef(null);
			React.useEffect(() => {
				if (!open) return undefined;
				const onPointer = (event) => {
					if (wrap.current !== null && !wrap.current.contains(event.target)) setOpen(false);
				};
				const onKey = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("mousedown", onPointer, true);
				document.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("mousedown", onPointer, true);
					document.removeEventListener("keydown", onKey);
				};
			}, [open]);
			const pick = (path) => {
				setOpen(false);
				saveFile(sessionId, path);
			};
			return jsxs("div", {
				className: "dsh-dl-wrap",
				ref: wrap,
				children: [
					jsxs("button", {
						type: "button",
						className: "dsh-dl-trigger",
						"aria-haspopup": "menu",
						"aria-expanded": open,
						"aria-label": t("turn"),
						onClick: () => setOpen((value) => !value),
						children: [
							jsx("span", { style: { display: "inline-flex" }, dangerouslySetInnerHTML: { __html: ICON } }),
							jsx("span", { children: t("turn") }),
							jsx("span", { "aria-hidden": "true", children: "▾" })
						]
					}),
					open
						? jsxs("div", {
								className: "dsh-dl-pop",
								role: "menu",
								children: [
									matched.length > 1
										? jsx("button", {
												type: "button",
												className: "dsh-dl-item",
												role: "menuitem",
												"data-all": "true",
												onClick: () => {
													setOpen(false);
													for (const path of matched) saveFile(sessionId, path);
												},
												children: t("all")
											}, "__all__")
										: null,
									...matched.map((path) => jsx("button", {
										key: path,
										type: "button",
										className: "dsh-dl-item",
										role: "menuitem",
										title: path,
										onClick: () => pick(path),
										children: basename(path)
									}, path)),
									jsx("div", { className: "dsh-dl-sep" }, "__sep__"),
									jsx("button", {
										type: "button",
										className: "dsh-dl-item",
										role: "menuitem",
										onClick: () => {
											setOpen(false);
											openBrowse(sessionId);
										},
										children: t("browse")
									}, "__browse__")
								]
							})
						: null
				]
			});
		}

		/**
		 * The Sidebar file browser. It starts at the Session workspace but follows
		 * any absolute path the serving filesystem can read, and every row offers
		 * the read-only actions this plugin owns.
		 * @param props - session scope, standard hooks, and localized copy.
		 * @returns the browser body.
		 */
		function BrowserBody(props) {
			const { sessionId, useSessions, useTabInfo, useInput, inputActions, t } = props;
			const tab = typeof useTabInfo === "function" ? useTabInfo().tab : undefined;
			const cwd = typeof useSessions === "function" ? useSessions((state) => state.byId[sessionId]?.cwd) : undefined;
			const draft = typeof useInput === "function" ? useInput((state) => state.draft) : "";
			const [path, setPath] = React.useState(null);
			const [listing, setListing] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [loading, setLoading] = React.useState(false);
			const [reload, setReload] = React.useState(0);
			const [showHidden, setShowHidden] = React.useState(false);
			const [query, setQuery] = React.useState("");
			const [selected, setSelected] = React.useState(() => new Set());
			const [pathDraft, setPathDraft] = React.useState("");
			const [notice, setNotice] = React.useState(null);
			const [mode, setMode] = React.useState(null);
			const [uploading, setUploading] = React.useState(false);
			const [editingPath, setEditingPath] = React.useState(false);
			const [suggestions, setSuggestions] = React.useState([]);
			const [suggestionIndex, setSuggestionIndex] = React.useState(-1);
			const fileInput = React.useRef(null);
			const listingCache = React.useRef(new Map());

			React.useEffect(() => {
				let stored = null;
				try {
					stored = globalThis.localStorage?.getItem(modeStorageKey(sessionId)) ?? null;
				} catch {
					stored = null;
				}
				setMode(stored);
				setEditingPath(false);
				setSuggestions([]);
				listingCache.current.clear();
				setPath(null);
				setSelected(new Set());
				setQuery("");
				setListing(null);
			}, [sessionId]);

			const target = path ?? cwd ?? null;
			React.useEffect(() => {
				if (target === null || target === undefined) return undefined;
				const controller = new AbortController();
				setLoading(true);
				setError(null);
				fetch(listUrl(sessionId, target), { signal: controller.signal, credentials: "same-origin" })
					.then(async (response) => ({ ok: response.ok, status: response.status, payload: await response.json().catch(() => null) }))
					.then((result) => {
						if (controller.signal.aborted) return;
						setLoading(false);
						if (result.ok) setListing(result.payload);
						else setError(result.payload?.error ?? String(result.status));
					})
					.catch((cause) => {
						if (cause?.name === "AbortError") return;
						setLoading(false);
						setError(String(cause?.message ?? cause));
					});
				return () => controller.abort();
			}, [sessionId, target, reload]);

			React.useEffect(() => {
				if (notice === null) return undefined;
				const timer = setTimeout(() => setNotice(null), 1600);
				return () => clearTimeout(timer);
			}, [notice]);

			// Completion list for the path box: list the directory the typed text
			// names, then keep the names that start with what is being typed.
			React.useEffect(() => {
				if (!editingPath) {
					setSuggestions([]);
					setSuggestionIndex(-1);
					return undefined;
				}
				const controller = new AbortController();
				const timer = setTimeout(() => {
					const { dir, prefix } = splitDraft(pathDraft);
					const directory = resolveDraft(dir === "" ? "." : dir, displayPath);
					if (directory === null) return;
					const needle = prefix.toLowerCase();
					const apply = (entries) => {
						const matches = entries
							.filter((entry) => entry.name.toLowerCase().startsWith(needle))
							.sort((left, right) => (left.type === "directory" ? 0 : 1) - (right.type === "directory" ? 0 : 1) || String(left.name).localeCompare(String(right.name), undefined, { numeric: true, sensitivity: "base" }))
							.slice(0, 12);
						setSuggestions(matches);
						setSuggestionIndex(matches.length === 0 ? -1 : 0);
					};
					const cached = listingCache.current.get(directory);
					if (cached !== undefined) {
						apply(cached);
						return;
					}
					fetch(listUrl(sessionId, directory), { signal: controller.signal, credentials: "same-origin" })
						.then((response) => (response.ok ? response.json() : null))
						.then((payload) => {
							if (controller.signal.aborted) return;
							if (payload?.entries === undefined) {
								setSuggestions([]);
								setSuggestionIndex(-1);
								return;
							}
							listingCache.current.set(directory, payload.entries);
							apply(payload.entries);
						})
						.catch(() => {});
				}, 150);
				return () => {
					clearTimeout(timer);
					controller.abort();
				};
			}, [editingPath, pathDraft, displayPath, sessionId]);

			const displayPath = listing?.path ?? (target ?? "");
			const sessionMode = listing?.sessionMode ?? null;
			const effectiveMode = mode ?? sessionMode;
			const canUpload = effectiveMode !== null && effectiveMode !== "read-only";
			const entries = (listing?.entries ?? []).filter((entry) => (showHidden || !entry.name.startsWith(".")) && (query === "" || entry.name.toLowerCase().includes(query.toLowerCase())));
			const chooseMode = (value) => {
				setMode(value);
				try {
					globalThis.localStorage?.setItem(modeStorageKey(sessionId), value);
				} catch {
					// A browser with storage disabled simply forgets the override.
				}
				setSelected(new Set());
			};
			const uploadFiles = async (files) => {
				const list = Array.from(files ?? []);
				if (list.length === 0) return;
				if (!canUpload) {
					setNotice(t("upload.readonly"));
					return;
				}
				setUploading(true);
				let done = 0;
				for (const file of list) {
					try {
						let response = await fetch(uploadUrl(sessionId, displayPath, file.name, effectiveMode, false), { method: "POST", body: file, credentials: "same-origin" });
						if (response.status === 409) {
							const replace = globalThis.confirm?.(t("upload.overwrite", { name: file.name })) === true;
							if (!replace) continue;
							response = await fetch(uploadUrl(sessionId, displayPath, file.name, effectiveMode, true), { method: "POST", body: file, credentials: "same-origin" });
						}
						if (!response.ok) {
							setNotice(t("upload.failed", { name: file.name }));
							continue;
						}
						done += 1;
					} catch {
						setNotice(t("upload.failed", { name: file.name }));
					}
				}
				setUploading(false);
				if (done > 0) {
					setNotice(t("upload.done", { count: String(done) }));
					setReload((value) => value + 1);
				}
			};
			const navigate = (next) => {
				setSelected(new Set());
				setQuery("");
				setPath(next);
			};
			const commitPath = (value) => {
				const next = resolveDraft(value, displayPath);
				if (next === null) return;
				setEditingPath(false);
				setSuggestions([]);
				setPathDraft("");
				navigate(next);
			};
			const beginPathEdit = () => {
				setPathDraft(displayPath === "" ? "/" : displayPath);
				setEditingPath(true);
			};
			const acceptSuggestion = (entry) => {
				const { dir } = splitDraft(pathDraft);
				const next = `${dir}${entry.name}${entry.type === "directory" ? "/" : ""}`;
				setPathDraft(next);
				if (entry.type === "directory") {
					setSuggestions([]);
					setSuggestionIndex(-1);
					return;
				}
				commitPath(next);
			};
			const toggleSelected = (child) => setSelected((current) => {
				const next = new Set(current);
				if (next.has(child)) next.delete(child);
				else next.add(child);
				return next;
			});
			const copyPath = (child) => {
				const clipboard = globalThis.navigator?.clipboard;
				if (clipboard === undefined) return;
				clipboard.writeText(child).then(() => setNotice(t("copied"))).catch(() => {});
			};
			const reference = (child) => {
				if (inputActions === undefined || typeof inputActions.setDraft !== "function") return;
				const text = referenceText(child, cwd);
				const base = typeof draft === "string" ? draft : "";
				inputActions.setDraft(base === "" ? text : `${base.replace(/\s+$/u, "")} ${text}`);
				setNotice(t("reference"));
			};
			const openFile = (child) => {
				if (tab?.actions?.openResource === undefined) return;
				tab.actions.openResource(sessionFileAddress(sessionId, child));
			};

			const bar = h("div", { className: "dsh-fb-bar" },
				h("button", { type: "button", className: "dsh-fb-btn", disabled: cwd === undefined, title: cwd ?? "", onClick: () => cwd !== undefined && navigate(cwd) }, t("root.project")),
				h("button", { type: "button", className: "dsh-fb-btn", onClick: () => navigate("/") }, t("root.filesystem")),
				h("button", { type: "button", className: "dsh-fb-btn", disabled: displayPath === "" || displayPath === "/", onClick: () => navigate(parentPath(displayPath)) }, t("up")),
				h("button", { type: "button", className: "dsh-fb-btn", onClick: () => setReload((value) => value + 1) }, t("refresh")),
				h("button", { type: "button", className: "dsh-fb-btn", "data-active": showHidden ? "true" : "false", onClick: () => setShowHidden((value) => !value) }, showHidden ? t("hidden.hide") : t("hidden.show")),
				h("input", {
					className: "dsh-fb-input",
					value: query,
					placeholder: t("filter.placeholder"),
					onChange: (event) => setQuery(event.target.value)
				}),
				h("select", {
					className: "dsh-fb-select",
					value: effectiveMode ?? "",
					title: effectiveMode === null ? t("mode.label") : t(`mode.hint.${effectiveMode}`),
					"aria-label": t("mode.label"),
					onChange: (event) => chooseMode(event.target.value)
				}, ...MODES.map((value) => h("option", { key: value, value }, t(`mode.${value}`)))),
				sessionMode !== null && mode !== null && mode !== sessionMode
					? h("span", { className: "dsh-fb-hint" }, t("mode.following", { mode: t(`mode.${sessionMode}`) }))
					: null,
				h("button", {
					type: "button",
					className: "dsh-fb-btn",
					disabled: !canUpload || uploading,
					title: canUpload ? t("upload") : t("upload.readonly"),
					onClick: () => fileInput.current?.click()
				}, uploading ? t("upload.pending") : t("upload")),
				h("input", {
					ref: fileInput,
					type: "file",
					multiple: true,
					style: { display: "none" },
					onChange: (event) => {
						void uploadFiles(event.target.files);
						event.target.value = "";
					}
				})
			);

			const crumbs = breadcrumbsFor(displayPath === "" ? "/" : displayPath);
			const crumbBar = h("div", { className: "dsh-fb-crumbs" },
				editingPath
					? h(React.Fragment, null,
							h("input", {
								className: "dsh-fb-input",
								autoFocus: true,
								value: pathDraft,
								placeholder: t("path.placeholder"),
								"aria-label": t("path.edit"),
								onChange: (event) => setPathDraft(event.target.value),
								onBlur: () => setEditingPath(false),
								onKeyDown: (event) => {
									if (event.key === "Escape") {
										event.preventDefault();
										setEditingPath(false);
										return;
									}
									if (event.key === "ArrowDown" || event.key === "ArrowUp") {
										if (suggestions.length === 0) return;
										event.preventDefault();
										const step = event.key === "ArrowDown" ? 1 : -1;
										setSuggestionIndex((current) => (current + step + suggestions.length) % suggestions.length);
										return;
									}
									if (event.key === "Tab" && suggestions.length > 0) {
										event.preventDefault();
										acceptSuggestion(suggestions[Math.max(0, suggestionIndex)]);
										return;
									}
									if (event.key !== "Enter") return;
									event.preventDefault();
									if (suggestions.length > 0 && suggestionIndex >= 0) acceptSuggestion(suggestions[suggestionIndex]);
									else commitPath(pathDraft);
								}
							}),
							h("button", {
								type: "button",
								className: "dsh-fb-btn",
								disabled: pathDraft.trim() === "",
								onMouseDown: (event) => event.preventDefault(),
								onClick: () => commitPath(pathDraft)
							}, t("go")),
							suggestions.length > 0
								? h("div", { className: "dsh-fb-suggest", role: "listbox" },
										...suggestions.map((entry, index) => h("button", {
											key: entry.name,
											type: "button",
											role: "option",
											"data-active": index === suggestionIndex ? "true" : "false",
											onMouseDown: (event) => event.preventDefault(),
											onClick: () => acceptSuggestion(entry)
										},
											h("span", { className: "dsh-fb-text" }, entry.name),
											h("span", null, entry.type === "directory" ? "/" : formatSize(entry.size))
										)))
								: null
						)
					: h(React.Fragment, null,
							...crumbs.map((crumb, index) => h("button", {
								key: crumb.path,
								type: "button",
								className: "dsh-fb-crumb",
								"data-current": index === crumbs.length - 1 ? "true" : "false",
								onClick: () => navigate(crumb.path)
							}, crumb.label)),
							h("button", {
								type: "button",
								className: "dsh-fb-btn dsh-fb-edit",
								title: t("path.edit"),
								"aria-label": t("path.edit"),
								onClick: beginPathEdit
							}, "✎")
						)
			);

			const actionButton = (key, label, title, onActivate) => h("button", {
				key,
				type: "button",
				className: "dsh-fb-act",
				title,
				"aria-label": title,
				onClick: (event) => {
					event.preventDefault();
					event.stopPropagation();
					onActivate();
				}
			}, label);

			const rows = entries.map((entry) => {
				const child = childOf(displayPath === "" ? "/" : displayPath, entry.name);
				const isDirectory = entry.type === "directory";
				const isFile = entry.type === "file";
				const actions = [];
				if (isFile) actions.push(actionButton("open", "◎", t("open"), () => openFile(child)));
				if (isFile) actions.push(actionButton("download", "↓", t("download"), () => saveFile(sessionId, child)));
				if (isDirectory) actions.push(actionButton("zip", "ZIP", t("zip"), () => saveArchive(sessionId, child)));
				actions.push(actionButton("copy", "⧉", t("copy"), () => copyPath(child)));
				actions.push(actionButton("reference", "@", t("reference"), () => reference(child)));
				return h("li", { key: child, className: "dsh-fb-row", "data-selected": selected.has(child) ? "true" : "false" },
					h("input", {
						className: "dsh-fb-check",
						type: "checkbox",
						checked: selected.has(child),
						"aria-label": entry.name,
						onChange: () => toggleSelected(child)
					}),
					h("button", {
						type: "button",
						className: "dsh-fb-name",
						title: child,
						onClick: () => {
							if (isDirectory) navigate(child);
							else if (isFile) openFile(child);
						}
					},
						h("span", { className: "dsh-fb-text" }, entry.name),
						isFile || isDirectory ? null : h("span", { className: "dsh-fb-size" }, t("other"))
					),
					isFile && typeof entry.size === "number" ? h("span", { className: "dsh-fb-size" }, formatSize(entry.size)) : null,
					h("span", { className: "dsh-fb-actions" }, ...actions)
				);
			});

			const body = loading && listing === null
				? h("div", { className: "dsh-fb-note" }, t("loading"))
				: error !== null
					? h("div", { className: "dsh-fb-note dsh-fb-danger" }, t("error", { message: error }))
					: cwd === undefined && path === null
						? h("div", { className: "dsh-fb-note" }, t("noWorkspace"))
						: rows.length === 0
							? h("div", { className: "dsh-fb-note" }, t("empty.dir"))
							: h("ul", { className: "dsh-fb-list" }, ...rows);

			const footer = h("div", { className: "dsh-fb-foot" },
				h("span", null, displayPath === "" ? "/" : displayPath),
				selected.size > 0
					? h(React.Fragment, null,
							h("span", null, t("selected", { count: String(selected.size) })),
							h("button", {
								type: "button",
								className: "dsh-fb-btn",
								onClick: () => {
									submitSelectionArchive(sessionId, [...selected]);
									setSelected(new Set());
								}
							}, t("selected.download")),
							h("button", { type: "button", className: "dsh-fb-btn", onClick: () => setSelected(new Set()) }, t("clear"))
						)
					: null,
				notice !== null ? h("span", { className: "dsh-fb-copied" }, notice) : null,
				listing?.truncated === true ? h("span", null, t("truncated")) : null
			);

			return h("div", { className: "dsh-fb" }, bar, crumbBar, body, footer);
		}

		/** The tab chip: the type's own title, resolved at render time. */
		function BrowserTitle(props) {
			const tab = props.useTabInfo().tab;
			return h("span", { className: "dsh-fb-title" }, tab.title);
		}

		/**
		 * The Sidebar tab type. It is a page type — opened by kind from the guide —
		 * so it recognizes no resource address and never competes with the official
		 * preview for a file.
		 * @param t - namespace-bound translate.
		 * @returns the tab definition to register.
		 */
		function browserDefinition(t) {
			return {
				id: TAB_ID,
				kind: TAB_KIND,
				priority: "extension",
				title: () => t("tab.title"),
				guide: [{
					order: 40,
					title: () => t("guide.title"),
					description: () => t("guide.description")
				}]
			};
		}

		/**
		 * Append the stylesheet once per document.
		 * @returns A disposer removing it.
		 */
		function installStyles() {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-file-download";
			tag.textContent = CSS;
			document.head.appendChild(tag);
			return () => tag.remove();
		}

		/**
		 * Build one injected download button.
		 * @param className - our layout class for the surface.
		 * @param title - accessible label.
		 * @param onActivate - click handler.
		 * @returns the button.
		 */
		function buildButton(className, title, onActivate) {
			const button = document.createElement("button");
			button.type = "button";
			button.className = className;
			button.setAttribute(MARK, "");
			button.setAttribute("aria-label", title);
			button.title = title;
			button.innerHTML = ICON;
			button.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				onActivate();
			});
			return button;
		}

		/**
		 * Decorate the official DOM: one download segment on every delivered-file
		 * card, one download button on every sidebar file-tree row (a ZIP for a
		 * directory). Both surfaces are re-applied whenever React re-renders over
		 * them.
		 * @param ctx - client root context carrying the Session list.
		 * @param t - namespace-bound translate.
		 * @returns A disposer removing every effect and injected node.
		 */
		function installDecorators(ctx, t) {
			const currentSession = () => ctx.sessions?.list?.getSnapshot?.()?.current;
			const decorate = () => {
				for (const card of document.querySelectorAll("[data-presented-file]")) {
					if (card.querySelector(":scope > [" + MARK + "], :scope > * > [" + MARK + "]")) continue;
					const preview = card.querySelector("button[title]");
					const path = preview?.getAttribute("title");
					if (path === null || path === undefined) continue;
					const button = buildButton("dsh-dl-seg", t("label") + " " + basename(path), () => saveFile(currentSession(), path));
					const chevron = card.querySelector('button[aria-haspopup="menu"]');
					if (chevron !== null && chevron.parentElement !== null) chevron.parentElement.appendChild(button);
					else {
						button.className = "dsh-dl-float";
						card.appendChild(button);
					}
				}
				for (const row of document.querySelectorAll("li[data-files-entry][data-files-path]")) {
					if (row.querySelector(":scope > [" + MARK + "]")) continue;
					const path = row.getAttribute("data-files-path");
					if (path === null || path === "") continue;
					const kind = row.getAttribute("data-files-entry");
					if (kind === "file") row.appendChild(buildButton("dsh-dl-row", t("label") + " " + path, () => saveFile(currentSession(), path)));
					else if (kind === "directory") row.appendChild(buildButton("dsh-dl-row", t("folder") + " " + path, () => saveArchive(currentSession(), path)));
				}
			};

			const observer = new MutationObserver(decorate);
			observer.observe(document.documentElement, { childList: true, subtree: true });
			const unsubscribe = ctx.sessions?.list?.subscribe?.(() => decorate());
			decorate();
			return () => {
				observer.disconnect();
				if (typeof unsubscribe === "function") unsubscribe();
				for (const node of document.querySelectorAll("[" + MARK + "]")) node.remove();
			};
		}

		/** Services this browser half needs before it can apply. */
		const inject = ["slots", "locale", "sessions", "sidebarRightTabs"];

		/**
		 * Client plugin body: dictionaries, the Sidebar file browser tab, the
		 * turn-tail download row, and the DOM decorations over the official
		 * deliverables and file-tree surfaces.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-file-download: dictionaries");
			ctx.effect(() => ctx.sidebarRightTabs.register(browserDefinition(t)), "dsh-file-download: browser type");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: TAB_ID,
				locale: NS
			}, BrowserBody)), "dsh-file-download: browser body");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
				name: "sidebar.right.pane.tab.title",
				key: TAB_ID
			}, BrowserTitle)), "dsh-file-download: browser title");
			ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
				name: "conversation.chat.turnTail",
				select: selectTurnFiles,
				locale: NS
			}, TurnDownload));
			if (typeof document !== "undefined") {
				ctx.effect(() => {
					const removeStyles = installStyles();
					const removeDecorators = installDecorators(ctx, t);
					return () => {
						removeDecorators();
						removeStyles();
					};
				}, "dsh-file-download: decorations");
			}
		}

		exports.name = "file-download-client";
		exports.inject = inject;
		exports.apply = apply;
		exports.selectTurnFiles = selectTurnFiles;
		exports.downloadUrl = downloadUrl;
		exports.archiveUrl = archiveUrl;
		exports.browseUrl = browseUrl;
		exports.listUrl = listUrl;
		exports.sessionFileAddress = sessionFileAddress;
		exports.referenceText = referenceText;
		exports.breadcrumbsFor = breadcrumbsFor;
		exports.parentPath = parentPath;
		exports.resolveDraft = resolveDraft;
		exports.splitDraft = splitDraft;
		exports.isAbsolutePath = isAbsolutePath;
		exports.browserDefinition = browserDefinition;
		exports.uploadUrl = uploadUrl;
		return module.exports;
	}
});
