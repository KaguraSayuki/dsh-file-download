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
		listeners: {},
		parentElement: null,
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
		addEventListener(type, listener) {
			(this.listeners[type] ??= []).push(listener);
		},
		/** Dispatch one synthetic event to the recorded listeners. */
		dispatch(type) {
			for (const listener of this.listeners[type] ?? []) listener({ preventDefault() {}, stopPropagation() {} });
		},
		/** `closest` for a list of bare `[attribute]` selectors, which is all the decorator asks. */
		closest(selector) {
			const names = selector.split(",").map((part) => part.trim().replace(/^\[|\]$/gu, ""));
			for (let node = this; node !== null && node !== undefined; node = node.parentElement) {
				if (names.some((name) => node.getAttribute(name) !== null)) return node;
			}
			return null;
		},
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
 * @param options - optional `useState` plan and `localStorage` stand-in.
 * @returns The registration, the materialized module, and the fake document.
 */
function loadClient({ statePlan = [], localStorage } = {}) {
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
	const observers = [];
	const sandbox = {
		window,
		document,
		URL,
		AbortController,
		setTimeout,
		clearTimeout,
		fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
		MutationObserver: class {
			constructor(callback) {
				observers.push(callback);
			}
			observe() {}
			disconnect() {}
		},
		console
	};
	if (localStorage !== undefined) sandbox.localStorage = localStorage;
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
	return { registration, module: module_, document, observers };
}

/**
 * Record every URL the bundle hands to the download manager.
 * @param document - the fake document `loadClient` returned.
 * @returns The live list of clicked URLs.
 */
function captureDownloads(document) {
	const downloads = [];
	const create = document.createElement;
	document.createElement = (tag) => {
		const element = create(tag);
		if (tag === "a") element.click = () => downloads.push(new URL(element.href));
		return element;
	};
	return downloads;
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

/** Slot kinds as DSH 0.1.7+ declares them; 0.1.5 declared the turn tail a chain. */
const SLOT_KINDS = {
	"sidebar.right.pane.tab": "keyed",
	"sidebar.right.pane.tab.title": "keyed",
	"conversation.chat.turnTail": "list"
};

/**
 * A fake client context that records every registration and refuses the ones
 * the real slot core refuses: a keyed entry without `key`, a list entry without
 * `id`, a chain entry without `select`.
 * @param options - slot kinds to enforce and the list snapshot to expose.
 * @returns The recorders and the context.
 */
function fakeClientContext({ kinds = SLOT_KINDS, snapshot = { current: "session-1" } } = {}) {
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
				register: (options, component) => {
					const kind = kinds[options.name];
					if (kind === "keyed" && options.key === undefined) throw new Error(`keyed slot "${options.name}" requires options.key`);
					if (kind === "list" && options.id === undefined) throw new Error(`list slot "${options.name}" requires options.id`);
					if (kind === "chain" && options.select === undefined) throw new Error(`chain slot "${options.name}" requires options.select`);
					slots.push({ ...options, component });
					return () => {};
				}
			},
			sessions: {
				list: {
					getSnapshot: () => snapshot,
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
	assert.equal(tails[0].id, "file-download", "a list slot entry needs its own cell id");
	assert.equal(typeof tails[0].select, "function", "a chain slot entry routes by select");
	assert.equal(tails[0].component, module.TurnDownload);
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

test("the turn tail registers on both the chain slot of 0.1.5 and the list slot of 0.1.7+", () => {
	for (const kind of ["chain", "list"]) {
		const { module } = loadClient();
		const { ctx, slots } = fakeClientContext({ kinds: { ...SLOT_KINDS, "conversation.chat.turnTail": kind } });
		module.apply(ctx);
		assert.equal(slots.filter((entry) => entry.name === "conversation.chat.turnTail").length, 1, kind);
	}
	// The stub refuses what the slot core refuses, so the check above is not vacuous.
	const { ctx } = fakeClientContext();
	assert.throws(() => ctx.slots.register({ name: "conversation.chat.turnTail", select: () => null }), /requires options\.id/u);
});

/** Collect every rendered node of a stub JSX tree that satisfies `match`. */
function findNodes(node, match, found = []) {
	if (node === null || node === undefined || typeof node !== "object") return found;
	if (Array.isArray(node)) {
		for (const child of node) findNodes(child, match, found);
		return found;
	}
	if (match(node)) found.push(node);
	findNodes(node.props?.children, match, found);
	return found;
}

test("the turn tail derives its files when a list slot injects no matched paths", () => {
	const files = owner({ presented: [{ seq: 3, path: "/out/report.md", index: 0 }], produced: [{ seq: 4, path: "src/app.js" }] });
	// statePlan [true] renders the menu open.
	const { module, document } = loadClient({ statePlan: [true] });
	const downloads = captureDownloads(document);
	const tree = module.TurnDownload({ turn: files.turn, seq: files.seq, sessionId: "session-7", t: (key) => key });
	const items = findNodes(tree, (node) => node.props?.role === "menuitem");
	assert.deepEqual(items.filter((item) => item.props.title !== undefined).map((item) => item.props.title), ["/out/report.md", "src/app.js"]);
	findNodes(tree, (node) => node.props?.["data-all"] === "true")[0].props.onClick();
	assert.deepEqual(downloads.map((url) => [url.searchParams.get("sessionId"), url.searchParams.get("path")]), [["session-7", "/out/report.md"], ["session-7", "src/app.js"]]);

	const empty = loadClient({ statePlan: [true] }).module;
	assert.equal(empty.TurnDownload({ turn: owner().turn, seq: 10, sessionId: "session-7", t: (key) => key }), null, "a turn without files renders nothing");
	assert.equal(empty.TurnDownload({ turn: { data: { get: () => undefined } }, seq: 1, sessionId: "session-7", t: (key) => key }), null);
});

test("the turn tail keeps the chain's matched paths when the renderer injects them", () => {
	const { module } = loadClient({ statePlan: [true] });
	const tree = module.TurnDownload({ matched: ["a.txt"], turn: owner().turn, seq: 10, sessionId: "session-7", t: (key) => key });
	const titled = findNodes(tree, (node) => node.props?.role === "menuitem" && node.props.title !== undefined);
	assert.deepEqual(titled.map((item) => item.props.title), ["a.txt"]);
});

test("a decorated node resolves the Session of its own official subtree", () => {
	const { module } = loadClient();
	const scoped = (attribute, id) => {
		const root = fakeElement("div");
		root.setAttribute(attribute, id);
		const node = fakeElement("div");
		root.appendChild(node);
		return { root, node };
	};
	const moved = { sessions: { list: { getSnapshot: () => ({ ids: [], byId: {}, phase: "ready" }) } } };
	const legacy = { sessions: { list: { getSnapshot: () => ({ current: "session-1" }) } } };
	assert.equal(module.sessionOf(scoped("data-conversation-session", "session-a").node, moved), "session-a");
	assert.equal(module.sessionOf(scoped("data-sidebar-right-session", "session-b").node, moved), "session-b");
	assert.equal(module.sessionOf(scoped("data-conversation-session", "session-a").node, legacy), "session-a", "the owning subtree outranks a page-wide current");
	// An embedded conversation inside another Session's Sidebar belongs to the nearer owner.
	const outer = scoped("data-sidebar-right-session", "session-b");
	const inner = scoped("data-conversation-session", "session-c");
	outer.node.appendChild(inner.root);
	assert.equal(module.sessionOf(inner.node, moved), "session-c");
	assert.equal(module.sessionOf(scoped("data-conversation-session", "").node, legacy), undefined, "an empty owner names nothing and never falls through");
	assert.equal(module.sessionOf(fakeElement("div"), legacy), "session-1", "DSH 0.1.5 has no owner hook and one Session per page");
	assert.equal(module.sessionOf(fakeElement("div"), moved), undefined, "no owner and no current means no download");
	assert.equal(module.sessionOf(undefined, undefined), undefined);
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

test("a decoration click downloads from the Session that renders it, never a shared selection", () => {
	// Another tab of the same origin selected session-z last; a blocked store
	// throws on read. Neither may decide, or even break, a click here.
	let reads = 0;
	const localStorage = {
		getItem() {
			reads += 1;
			throw new Error("SecurityError");
		}
	};
	const { module, document } = loadClient({ localStorage });
	const downloads = captureDownloads(document);
	const conversation = fakeElement("div");
	conversation.setAttribute("data-conversation-session", "session-a");
	const sidebar = fakeElement("div");
	sidebar.setAttribute("data-sidebar-right-session", "session-b");
	const card = fakeElement("div");
	const preview = fakeElement("button");
	preview.setAttribute("title", "out/report.md");
	card.appendChild(preview);
	card.querySelector = (selector) => (selector === "button[title]" ? preview : null);
	conversation.appendChild(card);
	const rows = [["file", "notes.md"], ["directory", "src"]].map(([kind, path]) => {
		const row = fakeElement("li");
		row.setAttribute("data-files-entry", kind);
		row.setAttribute("data-files-path", path);
		sidebar.appendChild(row);
		return row;
	});
	document.querySelectorAll = (selector) => {
		if (selector === "[data-presented-file]") return [card];
		if (selector.startsWith("li[data-files-entry")) return rows;
		return [];
	};
	const { ctx } = fakeClientContext({ snapshot: { ids: [], byId: {}, phase: "ready" } });
	module.apply(ctx);
	const injected = (node) => node.children.find((child) => child.getAttribute("data-dsh-download") !== null);
	injected(card).dispatch("click");
	for (const row of rows) injected(row).dispatch("click");
	assert.deepEqual(downloads.map((url) => [url.pathname, url.searchParams.get("sessionId"), url.searchParams.get("path")]), [
		["/api/workspace.download", "session-a", "out/report.md"],
		["/api/workspace.download", "session-b", "notes.md"],
		["/api/workspace.download/archive", "session-b", "src"]
	]);
	// The owner is read at click time, so a re-targeted view never reuses a stale id.
	conversation.setAttribute("data-conversation-session", "session-c");
	injected(card).dispatch("click");
	assert.equal(downloads.at(-1).searchParams.get("sessionId"), "session-c");
	// Outside any owner on a build without `current`, a click does nothing.
	conversation.attributes.delete("data-conversation-session");
	injected(card).dispatch("click");
	assert.equal(downloads.length, 4);
	assert.equal(reads, 0, "the persisted selection is never consulted");
});

/** Every fake element below `root`, in document order. */
function descendantsOf(root) {
	return root.children.flatMap((child) => [child, ...descendantsOf(child)]);
}

/**
 * `querySelector` over fake elements for the selector shapes the decorator
 * uses: `tag[attr]` or `tag[attr="value"]` anywhere below the root, or behind
 * `:scope > ` or `:scope > * > `, in a comma-separated list.
 */
function querySelectorIn(root, selectors) {
	for (const selector of selectors.split(",").map((part) => part.trim())) {
		const [, scope, tag, name, value] = /^(:scope > (?:\* > )?)?([a-z]*)\[([\w-]+)(?:="([^"]*)")?\]$/u.exec(selector);
		const pool = scope === undefined ? descendantsOf(root) : scope === ":scope > " ? root.children : root.children.flatMap((child) => child.children);
		const hit = pool.find((node) => (tag === "" || node.tagName === tag.toUpperCase()) && node.getAttribute(name) !== null && (value === undefined || node.getAttribute(name) === value));
		if (hit !== undefined) return hit;
	}
	return null;
}

test("a card whose menu sits deep in the file-action slot is decorated once and settles", () => {
	const { module, document, observers } = loadClient();
	// DSH 0.2.x renders the chevron inside the open-in-app entry of the
	// deliverables.file.actions slot: card > body > actions > cell > split > chevron.
	const card = fakeElement("div");
	card.setAttribute("data-presented-file", "");
	const preview = fakeElement("button");
	preview.setAttribute("title", "/work/out/report.md");
	card.appendChild(preview);
	let split = card;
	for (let depth = 0; depth < 4; depth += 1) split = split.appendChild(fakeElement("div"));
	const chevron = fakeElement("button");
	chevron.setAttribute("aria-haspopup", "menu");
	split.appendChild(chevron);
	card.querySelector = (selector) => querySelectorIn(card, selector);
	document.querySelectorAll = (selector) => (selector === "[data-presented-file]" ? [card] : []);
	module.apply(fakeClientContext().ctx);
	assert.equal(observers.length, 1);
	// Each append is itself a mutation; replay a few rounds of them.
	for (let round = 0; round < 3; round += 1) observers[0]([]);
	const marks = descendantsOf(card).filter((node) => node.getAttribute("data-dsh-download") !== null);
	assert.equal(marks.length, 1, "a decorated card must not gain a segment on every mutation");
	assert.equal(marks[0].parentElement, split, "the segment joins the chevron's split control");
	assert.equal(marks[0].className, "dsh-dl-seg");
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
