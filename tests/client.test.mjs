/**
 * Unit tests for the browser half, loaded exactly as the shell loads it: the
 * bundle is evaluated in a stub `window`, its module-loader registration is
 * captured, and the factory is materialized with the platform seeds.
 *
 * This covers the two things a boot cannot prove — that the bundle registers
 * under the row id with a service set the client plane actually provides, and
 * that turn-file selection mirrors the official deliverables row — plus the
 * decoration pass over the published DOM hooks.
 *
 * Run: node --test tests/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = readFileSync(join(root, "lib/client.js"), "utf8");

/** A minimal element that records children and attributes. */
function fakeElement(tag) {
	return {
		tagName: String(tag).toUpperCase(),
		className: "",
		title: "",
		type: "",
		style: {},
		innerHTML: "",
		children: [],
		attributes: new Map(),
		dataset: {},
		setAttribute(name, value) {
			this.attributes.set(name, String(value));
		},
		getAttribute(name) {
			return this.attributes.has(name) ? this.attributes.get(name) : null;
		},
		appendChild(child) {
			this.children.push(child);
			child.parentElement = this;
			return child;
		},
		remove() {},
		addEventListener() {},
		querySelector() {
			return null;
		},
		querySelectorAll() {
			return [];
		}
	};
}

/**
 * Load the bundle and materialize its factory with the platform seeds.
 *
 * `statePlan` feeds React's `useState` in call order, so one mount can be
 * rendered with a chosen state (a loaded listing, an editing path box) instead
 * of only its first render. The effects run exactly as React would run them,
 * which is what catches a reference that is read before it is declared.
 * @param options - optional `useState` plan.
 * @returns The registration, the materialized module, and the fake document.
 */
function loadClient({ statePlan = [] } = {}) {
	let registration;
	const window = { __ModuleLoader__: { load: (definition) => (registration = definition) } };
	const document = {
		head: fakeElement("head"),
		body: fakeElement("body"),
		documentElement: fakeElement("html"),
		createElement: (tag) => fakeElement(tag),
		querySelectorAll: () => [],
		addEventListener() {},
		removeEventListener() {}
	};
	const sandbox = {
		window,
		document,
		URL,
		AbortController,
		setTimeout,
		clearTimeout,
		fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
		MutationObserver: class {
			observe() {}
			disconnect() {}
		},
		console
	};
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(SOURCE, sandbox);
	assert.ok(registration !== undefined, "bundle must call __ModuleLoader__.load");
	let stateIndex = 0;
	const react = {
		useState: (initial) => {
			const planned = stateIndex < statePlan.length;
			const value = planned ? statePlan[stateIndex] : typeof initial === "function" ? initial() : initial;
			stateIndex += 1;
			return [value, () => {}];
		},
		useEffect: (callback) => {
			const cleanup = callback();
			void cleanup;
		},
		useRef: (initial) => ({ current: initial }),
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
		Fragment: Symbol.for("react.fragment")
	};
	const jsxRuntime = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
	const module_ = registration.factory((specifier) => {
		if (specifier === "react") return react;
		if (specifier === "react/jsx-runtime") return jsxRuntime;
		throw new Error(`browser half required an unexpected module: ${specifier}`);
	});
	return { registration, module: module_, document };
}

/** A turn-tail owner carrying the official deliverables data. */
function owner({ presented = [], produced = [], seq = 10 } = {}) {
	const data = { produced, presented };
	return { seq, turn: { data: { get: (key) => (key === "deliverables" ? data : undefined) } } };
}

test("the bundle registers under the row id it is served as", () => {
	const { registration } = loadClient();
	assert.equal(registration.id, "dsh-file-download");
	assert.equal(typeof registration.factory, "function");
});

test("the browser half injects only services the client plane provides", () => {
	const { module } = loadClient();
	assert.deepEqual([...module.inject].sort(), ["locale", "sessions", "sidebarRightTabs", "slots"]);
	assert.equal(typeof module.apply, "function");
});

test("turn-file selection lists deliveries first and produced files after", () => {
	const { module } = loadClient();
	const matched = module.selectTurnFiles(owner({
		presented: [
			{ seq: 3, path: "/out/report.md", index: 0 },
			{ seq: 9, path: "/out/chart.png", index: 1 }
		],
		produced: [
			{ seq: 4, path: "src/app.js" },
			{ seq: 8, path: "/out/report.md" }
		]
	}));
	assert.deepEqual(Array.from(matched), ["/out/report.md", "/out/chart.png", "src/app.js"]);
});

test("turn-file selection ignores files settled after the closing reply", () => {
	const { module } = loadClient();
	// The official row is asymmetric on purpose: a delivery declared at the
	// closing sequence is still part of the turn, while a produced path must
	// have settled before it. Mirror both halves exactly.
	const matched = module.selectTurnFiles(owner({
		seq: 7,
		presented: [{ seq: 7, path: "/out/late.md", index: 0 }, { seq: 6, path: "/out/kept.md", index: 1 }],
		produced: [{ seq: 8, path: "later.js" }, { seq: 7, path: "at.js" }, { seq: 1, path: "early.js" }]
	}));
	assert.deepEqual(Array.from(matched), ["/out/kept.md", "at.js", "early.js"]);
});

test("a turn with no files declines the chain slot instead of rendering an empty row", () => {
	const { module } = loadClient();
	assert.equal(module.selectTurnFiles(owner()), null);
	assert.equal(module.selectTurnFiles({ seq: 1, turn: { data: { get: () => undefined } } }), null);
});

test("download URLs are same-origin, absolute, and fully encoded", () => {
	const { module } = loadClient();
	const url = new URL(module.downloadUrl("session-1", "out/实验 报告.md"));
	assert.equal(url.pathname, "/api/workspace.download");
	assert.equal(url.searchParams.get("sessionId"), "session-1");
	assert.equal(url.searchParams.get("path"), "out/实验 报告.md");
});

/** A fake client context that records every registration. */
function fakeClientContext() {
	const slots = [];
	const injected = [];
	const types = [];
	return {
		slots,
		injected,
		types,
		ctx: {
			effect: (callback) => callback(),
			locale: { register: () => () => {}, bind: () => (key) => key },
			sidebarRightTabs: {
				register: (definition) => {
					types.push(definition);
					return () => {};
				}
			},
			slots: {
				inject: (name, callback) => {
					injected.push(name);
					return callback();
				},
				register: (options) => {
					slots.push(options);
					return () => {};
				}
			},
			sessions: {
				list: {
					getSnapshot: () => ({ current: "session-1" }),
					subscribe: () => () => {}
				}
			}
		}
	};
}

test("apply registers the Sidebar browser type, its body, the turn tail, and one stylesheet", () => {
	const { module, document } = loadClient();
	const { ctx, slots, injected, types } = fakeClientContext();
	module.apply(ctx);
	assert.deepEqual(injected, ["sidebar.right.pane.tab", "sidebar.right.pane.tab.title", "conversation.chat.turnTail"]);
	assert.equal(types.length, 1);
	assert.equal(types[0].id, "dsh-file-download");
	assert.equal(types[0].kind, "workspace-browser");
	assert.equal(types[0].patterns, undefined, "a page type recognizes no resource address");
	const tabs = slots.filter((entry) => entry.name === "sidebar.right.pane.tab");
	const titles = slots.filter((entry) => entry.name === "sidebar.right.pane.tab.title");
	const tails = slots.filter((entry) => entry.name === "conversation.chat.turnTail");
	assert.equal(tabs.length, 1);
	assert.equal(tabs[0].key, "dsh-file-download");
	assert.equal(tabs[0].locale, "file-download");
	assert.equal(titles.length, 1);
	assert.equal(tails.length, 1);
	assert.equal(typeof tails[0].select, "function");
	const styles = document.head.children.filter((node) => node.tagName === "STYLE");
	assert.equal(styles.length, 1);
	assert.equal(styles[0].dataset.plugin, "dsh-file-download");
});

test("URL builders stay on this origin and name the host routes", () => {
	const { module } = loadClient();
	assert.equal(new URL(module.listUrl("s1", "/etc")).pathname, "/api/workspace.download/list");
	assert.equal(new URL(module.listUrl("s1", "/etc")).searchParams.get("path"), "/etc");
	assert.equal(new URL(module.archiveUrl("s1", "/etc")).pathname, "/api/workspace.download/archive");
	assert.equal(new URL(module.browseUrl("s1")).pathname, "/api/workspace.download/browse");
	assert.equal(new URL(module.downloadUrl("s1", "a.txt")).pathname, "/api/workspace.download");
});

test("the upload URL carries the directory, name, mode, and overwrite flag", () => {
	const { module } = loadClient();
	const url = new URL(module.uploadUrl("s1", "/work/sub", "note.md", "workspace-write", true));
	assert.equal(url.pathname, "/api/workspace.download/upload");
	assert.equal(url.searchParams.get("path"), "/work/sub");
	assert.equal(url.searchParams.get("name"), "note.md");
	assert.equal(url.searchParams.get("mode"), "workspace-write");
	assert.equal(url.searchParams.get("overwrite"), "1");
	assert.equal(new URL(module.uploadUrl("s1", "/work", "a.txt", "read-only", false)).searchParams.get("overwrite"), null);
});

test("read URLs carry no mode, because reads are never confined", () => {
	const { module } = loadClient();
	for (const url of [module.listUrl("s1", "/etc"), module.downloadUrl("s1", "/etc/hosts"), module.archiveUrl("s1", "/etc"), module.browseUrl("s1")]) {
		assert.equal(new URL(url).searchParams.get("mode"), null, url);
	}
});

test("a typed path resolves against the folder on screen, or stays absolute", () => {
	const { module } = loadClient();
	assert.equal(module.resolveDraft("src/app.js", "/work"), "/work/src/app.js");
	assert.equal(module.resolveDraft("/etc/hosts", "/work"), "/etc/hosts");
	assert.equal(module.resolveDraft("~/notes", "/work"), "~/notes");
	assert.equal(module.resolveDraft("  ../x  ", "/work/sub"), "/work/sub/../x");
	assert.equal(module.resolveDraft("", "/work"), null);
	assert.equal(module.resolveDraft("c", "/"), "/c");
	assert.equal(module.isAbsolutePath("C:\\x"), true);
	assert.equal(module.isAbsolutePath("src"), false);
});

test("the completion split keeps the directory and the prefix apart", () => {
	const { module } = loadClient();
	assert.deepEqual({ ...module.splitDraft("/etc/hos") }, { dir: "/etc/", prefix: "hos" });
	assert.deepEqual({ ...module.splitDraft("src") }, { dir: "", prefix: "src" });
	assert.deepEqual({ ...module.splitDraft("~/Doc") }, { dir: "~/", prefix: "Doc" });
});

test("preview addresses encode one segment at a time and keep the drive colon", () => {
	const { module } = loadClient();
	assert.equal(module.sessionFileAddress("session-1", "out/report file.md"), "dsh-resource://file/session/session-1/out/report%20file.md");
	assert.equal(module.sessionFileAddress("C:", "C:/x.md"), "dsh-resource://file/session/C:/C:/x.md");
});

test("a reference is relative inside the workspace and absolute outside", () => {
	const { module } = loadClient();
	assert.equal(module.referenceText("/work/src/a.ts", "/work"), "@src/a.ts");
	assert.equal(module.referenceText("/etc/hosts", "/work"), "/etc/hosts");
	assert.equal(module.referenceText("/work", "/work"), "@work");
});

test("breadcrumbs and parents keep the root intact on the client too", () => {
	const { module } = loadClient();
	assert.deepEqual(Array.from(module.breadcrumbsFor("/a/b"), (crumb) => crumb.path), ["/", "/a", "/a/b"]);
	assert.equal(module.parentPath("/a/b"), "/a");
	assert.equal(module.parentPath("/"), "/");
});

test("the decoration pass appends to published hooks and re-applies after removal", () => {
	const { module, document } = loadClient();
	// A tiny DOM that answers only the selectors the decorator uses, then reports
	// what was appended and how many times the observer was armed.
	const rows = [];
	const cards = [];
	const makeRow = (path) => {
		const row = fakeElement("li");
		row.setAttribute("data-files-entry", "file");
		row.setAttribute("data-files-path", path);
		row.querySelector = (selector) => (selector.startsWith(":scope > [") ? row.children.find((child) => child.getAttribute("data-dsh-download") !== null) ?? null : null);
		return row;
	};
	const makeCard = (path) => {
		const card = fakeElement("div");
		const preview = fakeElement("button");
		preview.setAttribute("title", path);
		const split = fakeElement("div");
		const chevron = fakeElement("button");
		chevron.setAttribute("aria-haspopup", "menu");
		split.appendChild(chevron);
		card.appendChild(preview);
		card.appendChild(split);
		card.querySelector = (selector) => {
			if (selector.startsWith(":scope > [")) return null;
			if (selector === "button[title]") return preview;
			if (selector === 'button[aria-haspopup="menu"]') return chevron;
			return null;
		};
		return card;
	};
	rows.push(makeRow("README.md"));
	cards.push(makeCard("/tmp/out/report.md"));
	document.querySelectorAll = (selector) => {
		if (selector.startsWith("li[data-files-entry")) return rows;
		if (selector === "[data-presented-file]") return cards;
		if (selector === "[data-dsh-download]") return [...rows, ...cards].flatMap((node) => node.children.filter((child) => child.getAttribute("data-dsh-download") !== null));
		return [];
	};

	// Re-run only the decoration effect by re-applying the plugin.
	const { ctx } = fakeClientContext();
	module.apply(ctx);
	const rowButton = rows[0].children.find((child) => child.getAttribute("data-dsh-download") !== null);
	assert.ok(rowButton !== undefined, "file-tree row must gain a download button");
	assert.equal(rowButton.className, "dsh-dl-row");
	assert.equal(rowButton.getAttribute("aria-label"), "label README.md");
	const cardButton = cards[0].children[1].children.find((child) => child.getAttribute("data-dsh-download") !== null);
	assert.ok(cardButton !== undefined, "delivered-file card must gain a download segment");
	assert.equal(cardButton.className, "dsh-dl-seg");
});

/** Props a session-scoped tab body receives, with the standard hooks stubbed. */
function bodyProps(cwd = "/work") {
	return {
		sessionId: "session-1",
		useSessions: (selector) => selector({ byId: { "session-1": cwd === undefined ? {} : { cwd } } }),
		useTabInfo: () => ({ tab: { title: "Files", actions: { openResource: () => {} } } }),
		useInput: (selector) => selector({ draft: "" }),
		inputActions: { setDraft: () => {} },
		t: (key) => key
	};
}

test("the browser body renders on its first pass without throwing", () => {
	const { module } = loadClient();
	const tree = module.BrowserBody(bodyProps());
	assert.equal(tree.type, "div");
	assert.equal(tree.props.className, "dsh-fb");
	assert.equal(module.BrowserBody(bodyProps(undefined)).props.className, "dsh-fb");
});

test("the browser body renders a loaded listing without throwing", () => {
	const listing = {
		path: "/work",
		parent: "/",
		workspaceRoot: "/work",
		sessionMode: "workspace-write",
		truncated: false,
		entries: [
			{ name: "src", type: "directory" },
			{ name: ".hidden", type: "file" },
			{ name: "a.txt", type: "file", size: 12 },
			{ name: "socket", type: "other" }
		]
	};
	// path = null keeps the tab on its workspace root; listing drives the rows.
	const { module } = loadClient({ statePlan: [null, listing] });
	const tree = module.BrowserBody(bodyProps());
	assert.equal(tree.props.className, "dsh-fb");
});

test("the browser body renders the loaded state on an outside path too", () => {
	const listing = { path: "/etc", parent: "/", workspaceRoot: "/work", sessionMode: "read-only", truncated: true, entries: [{ name: "hosts", type: "file", size: 4 }] };
	const { module } = loadClient({ statePlan: ["/etc", listing, null, false, 0, false, "", new Set(), "", null, "read-only", false, false, [], -1] });
	const tree = module.BrowserBody(bodyProps());
	assert.equal(tree.props.className, "dsh-fb");
});

test("the tab title renders from the tab it is given", () => {
	const { module } = loadClient();
	const tree = module.BrowserTitle({ useTabInfo: () => ({ tab: { title: "Files" } }) });
	assert.equal(tree.type, "span");
	assert.equal(tree.props.className, "dsh-fb-title");
});
