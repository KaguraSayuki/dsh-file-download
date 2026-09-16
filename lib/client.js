/**
 * dsh-file-download — browser half.
 *
 * Three surfaces, no official source changes:
 *
 *   1. `conversation.chat.turnTail` (official chain slot) — a compact
 *      "下载本轮文件 ▾" control under every closing turn that delivered or
 *      changed files. It reads the same Turn data the official deliverables row
 *      reads, so the two lists can never disagree.
 *   2. Delivered-file cards (`[data-presented-file]`) — one download segment
 *      appended to the card's own split control. "Open" stays the default.
 *   3. Sidebar file-tree rows (`li[data-files-entry="file"][data-files-path]`) —
 *      a per-file download button that appears on hover.
 *
 * Surfaces 2 and 3 are DOM decorations over stable `data-*` hooks the official
 * packages already publish; a MutationObserver re-applies them after any
 * re-render, and every injected node is appended at the end of its container
 * (never interleaved between React-managed siblings).
 *
 * Bytes never enter JavaScript: every action hands a same-origin URL to the
 * browser's download manager, and the host route carries the file.
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

		/** Must match the host route in lib/index.js. */
		const DOWNLOAD_PATH = "/api/workspace.download";
		/** Locale namespace owned by this plugin. */
		const NS = "file-download";
		/** Marks every node this plugin injects into official DOM. */
		const MARK = "data-dsh-download";

		/** Simplified Chinese dictionary (key-set source of truth). */
		const zh = {
			label: "下载",
			turn: "下载本轮文件",
			all: "全部下载",
			empty: "本轮没有可下载的文件",
			failed: "下载失败"
		};
		/** English dictionary (same key set). */
		const en = {
			label: "Download",
			turn: "Download this turn's files",
			all: "Download all",
			empty: "No downloadable files in this turn",
			failed: "Download failed"
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
li[data-files-entry="file"]{display:flex;align-items:center;gap:2px}
li[data-files-entry="file"]>button:not([${MARK}]){flex:1 1 auto;min-width:0}
li[data-files-entry="file"]>.dsh-dl-row{flex:none;width:26px;height:26px;padding:0;border:0;border-radius:8px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;align-items:center;justify-content:center;display:none}
li[data-files-entry="file"]:hover>.dsh-dl-row,li[data-files-entry="file"]:focus-within>.dsh-dl-row{display:inline-flex}
li[data-files-entry="file"]>.dsh-dl-row:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
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

		/** Same-origin authenticated download URL for one file of one Session. */
		function downloadUrl(sessionId, path) {
			const url = new URL(DOWNLOAD_PATH, hostBase());
			url.searchParams.set("sessionId", String(sessionId));
			url.searchParams.set("path", String(path));
			return url.toString();
		}

		/** Hand one file to the browser's download manager. */
		function saveFile(sessionId, path) {
			if (sessionId === undefined || sessionId === null || sessionId === "") return;
			const anchor = document.createElement("a");
			anchor.href = downloadUrl(sessionId, path);
			anchor.download = basename(path) || "download";
			anchor.rel = "noopener";
			anchor.style.display = "none";
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
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
									}, path))
								]
							})
						: null
				]
			});
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
		 * card, one download button on every sidebar file-tree row. Both surfaces
		 * are re-applied whenever React re-renders over them.
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
				for (const row of document.querySelectorAll('li[data-files-entry="file"][data-files-path]')) {
					if (row.querySelector(":scope > [" + MARK + "]")) continue;
					const path = row.getAttribute("data-files-path");
					if (path === null || path === "") continue;
					row.appendChild(buildButton("dsh-dl-row", t("label") + " " + path, () => saveFile(currentSession(), path)));
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
		const inject = ["slots", "locale", "sessions"];

		/**
		 * Client plugin body: dictionaries, the turn-tail download row, and the
		 * DOM decorations over the official deliverables and file-tree surfaces.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-file-download: dictionaries");
			ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
				name: "conversation.chat.turnTail",
				select: selectTurnFiles,
				locale: NS
			}, TurnDownload));
			if (typeof document !== "undefined") {
				ctx.effect(() => {
					const removeStyles = installStyles();
					const removeDecorators = installDecorators(ctx, ctx.locale.bind(NS));
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
		return module.exports;
	}
});
