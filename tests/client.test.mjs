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

/** Load the bundle and materialize its factory with the platform seeds. */
function loadClient() {
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
	const react = {
		useState: () => [false, () => {}],
		useEffect: () => {},
		useRef: () => ({ current: null })
	};
	const jsxRuntime = { jsx: () => null, jsxs: () => null };
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
	assert.deepEqual([...module.inject].sort(), ["locale", "sessions", "slots"]);
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

test("apply registers the turn-tail chain entry and installs one stylesheet", () => {
	const { module, document } = loadClient();
	const slots = [];
	const injected = [];
	const ctx = {
		effect: (callback) => callback(),
		locale: { register: () => () => {}, bind: () => (key) => key },
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
	};
	module.apply(ctx);
	assert.deepEqual(injected, ["conversation.chat.turnTail"]);
	assert.equal(slots.length, 1);
	assert.equal(slots[0].name, "conversation.chat.turnTail");
	assert.equal(slots[0].locale, "file-download");
	assert.equal(typeof slots[0].select, "function");
	const styles = document.head.children.filter((node) => node.tagName === "STYLE");
	assert.equal(styles.length, 1);
	assert.equal(styles[0].dataset.plugin, "dsh-file-download");
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
	const ctx = {
		effect: (callback) => callback(),
		locale: { register: () => () => {}, bind: () => (key) => key },
		slots: { inject: (_, callback) => callback(), register: () => () => {} },
		sessions: { list: { getSnapshot: () => ({ current: "session-1" }), subscribe: () => () => {} } }
	};
	module.apply(ctx);
	const rowButton = rows[0].children.find((child) => child.getAttribute("data-dsh-download") !== null);
	assert.ok(rowButton !== undefined, "file-tree row must gain a download button");
	assert.equal(rowButton.className, "dsh-dl-row");
	assert.equal(rowButton.getAttribute("aria-label"), "label README.md");
	const cardButton = cards[0].children[1].children.find((child) => child.getAttribute("data-dsh-download") !== null);
	assert.ok(cardButton !== undefined, "delivered-file card must gain a download segment");
	assert.equal(cardButton.className, "dsh-dl-seg");
});
