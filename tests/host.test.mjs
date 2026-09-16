/**
 * Unit tests for the host half: route registration, filesystem-wide listing,
 * paged streaming, attachment headers, the server-rendered browse page, ZIP
 * archives (single directory and multi-select), and every failure mapping.
 *
 * The context is a small fake, so no server, Session, or real filesystem is
 * needed — the routes are asserted at their own seam. The fake `ctx.fs` mirrors
 * the real service's contract: absolute display paths, `FS_*` error codes, and
 * child targets on every directory entry.
 *
 * Run: node --test tests/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import {
	ARCHIVE_PATH,
	BROWSE_PATH,
	DOWNLOAD_PATH,
	LIST_PATH,
	UPLOAD_PATH,
	apply,
	archiveResponse,
	archiveSelectionResponse,
	basename,
	breadcrumbsFor,
	browseResponse,
	collectArchiveEntries,
	contentDisposition,
	contentTypeOf,
	crc32,
	downloadResponse,
	fileStream,
	listResponse,
	parentPath,
	readTargetBuffered,
	uploadFailure,
	uploadResponse,
	writeUpload
} from "../lib/index.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";

/** Join one child onto an absolute directory path. */
function childOf(parent, name) {
	return parent === "/" ? `/${name}` : `${parent.replace(/[/\\]+$/u, "")}/${name}`;
}

/**
 * A fake `ctx.fs` over a directory map (`tree[dir]` = entries, `"file"` marks a
 * path that is not a directory) and a file map (`contents[path]` = Buffer).
 */
function fakeFs({ tree = {}, contents = {} } = {}) {
	const calls = { list: [], read: [], writes: [] };
	return {
		calls,
		resolve: async (path, opts) => {
			const cwd = opts?.cwd ?? "/work";
			const absolute = String(path).startsWith("/") ? String(path) : childOf(cwd, String(path));
			return { targetKey: absolute, displayPath: absolute };
		},
		processPath: (target) => target.targetKey,
		contains: (parent, child) => {
			const root = String(parent.targetKey).replace(/\/+$/u, "");
			return child.targetKey === root || String(child.targetKey).startsWith(`${root}/`);
		},
		stat: async (target, signal) => {
			if (signal?.aborted) throw Object.assign(new Error("aborted"), { code: "FS_ABORTED" });
			const path = target.targetKey;
			if (contents[path] !== undefined) return { version: "v1", type: "file", size: contents[path].byteLength };
			if (tree[path] !== undefined) return { version: "v1", type: "directory" };
			return undefined;
		},
		listDir: async (target, signal) => {
			if (signal?.aborted) throw Object.assign(new Error("aborted"), { code: "FS_ABORTED" });
			const path = target.targetKey;
			calls.list.push(path);
			const entries = tree[path];
			if (entries === undefined) throw Object.assign(new Error("not found"), { code: "FS_NOT_FOUND" });
			if (entries === "file") throw Object.assign(new Error("not a directory"), { code: "FS_NOT_DIRECTORY" });
			return entries.map((entry) => ({
				name: entry.name,
				type: entry.type,
				target: { targetKey: childOf(path, entry.name), displayPath: childOf(path, entry.name) },
				...(entry.size === undefined ? {} : { size: entry.size })
			}));
		},
		readByteRange: async (target, range, signal) => {
			if (signal?.aborted) throw Object.assign(new Error("aborted"), { code: "FS_ABORTED" });
			calls.read.push({ path: target.targetKey, range });
			const buffer = contents[target.targetKey];
			if (buffer === undefined) throw Object.assign(new Error("not found"), { code: "FS_NOT_FOUND" });
			return new Uint8Array(buffer.subarray(range.offset, range.offset + range.length));
		},
		writeText: async (target, content, intent, signal, policy) => {
			if (signal?.aborted) throw Object.assign(new Error("aborted"), { code: "FS_ABORTED" });
			calls.writes.push({ path: target.targetKey, content, intent, policy });
			if (intent?.kind === "createIfAbsent" && (contents[target.targetKey] !== undefined || tree[target.targetKey] !== undefined)) {
				throw Object.assign(new Error("exists"), { code: "FS_NOT_OBSERVED" });
			}
			contents[target.targetKey] = Buffer.from(content, "utf8");
			return { operation: "create" };
		}
	};
}

/** A fake host context with only the services the routes read. */
function fakeContext({ fs, live = true, sessionId = "session-1", workspaceRoot = "/work", sandboxMode = "danger-full-access" }) {
	const registered = [];
	const services = new Map([
		["fs", fs],
		["sessions", { get: (id) => (live && id === sessionId ? { header: { cwd: workspaceRoot } } : undefined) }],
		["sessionPersistence", { stat: async () => undefined }],
		["sandboxPolicy", { workspaceRoot, resolve: () => ({ mode: sandboxMode, workspaceRoot }) }]
	]);
	return {
		registered,
		ctx: {
			get: (name) => services.get(name),
			effect: (callback) => callback(),
			connection: { fetch: { register: (route) => registered.push(route) } },
			fs
		}
	};
}

/** One request against any route. */
function request(path, query, method = "GET") {
	return new Request(`http://dsh.internal${path}?${query}`, { method });
}

/** Parse the archive our writer produces, including inflating every entry. */
function parseZip(buffer) {
	let eocd = -1;
	for (let index = buffer.length - 22; index >= 0; index -= 1) {
		if (buffer.readUInt32LE(index) === 0x06054b50) {
			eocd = index;
			break;
		}
	}
	assert.notEqual(eocd, -1, "end of central directory not found");
	const count = buffer.readUInt16LE(eocd + 10);
	const size = buffer.readUInt32LE(eocd + 12);
	const offset = buffer.readUInt32LE(eocd + 16);
	assert.equal(offset + size, eocd, "central directory must sit immediately before the end record");
	const entries = [];
	let cursor = offset;
	for (let index = 0; index < count; index += 1) {
		assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, "central header signature");
		const method = buffer.readUInt16LE(cursor + 10);
		const crc = buffer.readUInt32LE(cursor + 16);
		const compressedSize = buffer.readUInt32LE(cursor + 20);
		const uncompressedSize = buffer.readUInt32LE(cursor + 24);
		const nameLength = buffer.readUInt16LE(cursor + 28);
		const extraLength = buffer.readUInt16LE(cursor + 30);
		const commentLength = buffer.readUInt16LE(cursor + 32);
		const localOffset = buffer.readUInt32LE(cursor + 42);
		const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
		cursor += 46 + nameLength + extraLength + commentLength;
		assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, "local header signature");
		const localNameLength = buffer.readUInt16LE(localOffset + 26);
		const localExtraLength = buffer.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const raw = buffer.subarray(dataStart, dataStart + compressedSize);
		const data = name.endsWith("/") ? Buffer.alloc(0) : method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
		entries.push({ name, method, crc, compressedSize, uncompressedSize, data });
	}
	return entries;
}

test("apply registers the exact authenticated routes", () => {
	const { ctx, registered } = fakeContext({ fs: fakeFs({ tree: { "/work": [] } }) });
	apply(ctx);
	const byPath = new Map(registered.map((route) => [route.path, route]));
	assert.deepEqual([...byPath.keys()].sort(), [ARCHIVE_PATH, BROWSE_PATH, DOWNLOAD_PATH, LIST_PATH, UPLOAD_PATH].sort());
	assert.deepEqual(byPath.get(DOWNLOAD_PATH).methods, ["GET", "HEAD"]);
	assert.deepEqual(byPath.get(LIST_PATH).methods, ["GET"]);
	assert.deepEqual(byPath.get(BROWSE_PATH).methods, ["GET"]);
	assert.deepEqual(byPath.get(ARCHIVE_PATH).methods, ["GET", "HEAD", "POST"]);
	assert.deepEqual(byPath.get(UPLOAD_PATH).methods, ["POST"]);
	for (const route of registered) assert.equal(route.requestBody, "buffered");
});

test("GET streams the complete file with attachment headers", async () => {
	const body = Buffer.from("# report\nbody\n", "utf8");
	const { ctx } = fakeContext({ fs: fakeFs({ contents: { "/work/out/report.md": body } }) });
	const response = await downloadResponse(ctx, request(DOWNLOAD_PATH, "sessionId=session-1&path=out/report.md"));
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
	assert.equal(response.headers.get("content-length"), String(body.byteLength));
	assert.match(response.headers.get("content-disposition"), /^attachment; filename="report\.md"/u);
	assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
});

test("GET reaches an absolute path outside the Session workspace", async () => {
	const body = Buffer.from("outside\n", "utf8");
	const { ctx } = fakeContext({ fs: fakeFs({ contents: { "/etc/hosts": body } }) });
	const response = await downloadResponse(ctx, request(DOWNLOAD_PATH, "sessionId=session-1&path=%2Fetc%2Fhosts"));
	assert.equal(response.status, 200);
	assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
});

test("GET pages a file larger than one window and still returns every byte", async () => {
	const body = Buffer.alloc(700 * 1024, 7);
	const fs = fakeFs({ contents: { "/work/big.bin": body } });
	const { ctx } = fakeContext({ fs });
	const response = await downloadResponse(ctx, request(DOWNLOAD_PATH, "sessionId=session-1&path=big.bin"));
	assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
	assert.ok(fs.calls.read.length >= 3, `expected at least three windows, saw ${fs.calls.read.length}`);
	assert.equal(fs.calls.read[0].range.offset, 0);
	assert.equal(fs.calls.read[1].range.offset, fs.calls.read[0].range.length);
});

test("HEAD answers the same headers without reading any content", async () => {
	const fs = fakeFs({ contents: { "/work/a.txt": Buffer.from("payload", "utf8") } });
	const { ctx } = fakeContext({ fs });
	const response = await downloadResponse(ctx, request(DOWNLOAD_PATH, "sessionId=session-1&path=a.txt", "HEAD"));
	assert.equal(response.status, 200);
	assert.equal(response.body, null);
	assert.equal(response.headers.get("content-length"), "7");
	assert.equal(fs.calls.read.length, 0);
});

test("missing or empty query parameters are refused", async () => {
	const { ctx } = fakeContext({ fs: fakeFs({ contents: {} }) });
	for (const query of ["path=a.txt", "sessionId=session-1", "sessionId=&path=a.txt", "sessionId=session-1&path="]) {
		assert.equal((await downloadResponse(ctx, request(DOWNLOAD_PATH, query))).status, 400, `expected 400 for ${query}`);
	}
});

test("an unknown Session is reported as not found", async () => {
	const { ctx } = fakeContext({ fs: fakeFs({ contents: {} }), live: false });
	assert.equal((await downloadResponse(ctx, request(DOWNLOAD_PATH, "sessionId=missing&path=a.txt"))).status, 404);
});

test("a directory on the download route points at the archive route", async () => {
	const { ctx } = fakeContext({ fs: fakeFs({ tree: { "/work/src": [] } }) });
	const response = await downloadResponse(ctx, request(DOWNLOAD_PATH, "sessionId=session-1&path=src"));
	assert.equal(response.status, 400);
	assert.match(await response.text(), /archive route/u);
});

test("filesystem failures map onto HTTP statuses", async () => {
	const cases = [
		["FS_NOT_FOUND", 404],
		["FS_NOT_DIRECTORY", 400],
		["FS_NOT_REGULAR_FILE", 400],
		["FS_PERMISSION_DENIED", 403],
		["FS_SANDBOX_DENIED", 403],
		["FS_TOO_LARGE", 413]
	];
	for (const [code, status] of cases) {
		const fs = fakeFs({ contents: {} });
		fs.stat = async () => {
			throw Object.assign(new Error(code), { code });
		};
		const { ctx } = fakeContext({ fs });
		assert.equal((await downloadResponse(ctx, request(DOWNLOAD_PATH, "sessionId=session-1&path=a.txt"))).status, status, `expected ${status} for ${code}`);
	}
	const fs = fakeFs({ contents: {} });
	fs.stat = async () => {
		throw new Error("boom");
	};
	const { ctx } = fakeContext({ fs });
	assert.equal((await downloadResponse(ctx, request(DOWNLOAD_PATH, "sessionId=session-1&path=a.txt"))).status, 500);
});

test("the stream closes on an empty read instead of looping", async () => {
	const fs = { readByteRange: async () => new Uint8Array(0) };
	const stream = fileStream({ fs }, { targetKey: "/x", displayPath: "/x" }, 10, undefined);
	assert.equal(await new Response(stream).text(), "");
});

test("the list route answers the JSON the browser consumes", async () => {
	const fs = fakeFs({ tree: { "/work": [{ name: "b.txt", type: "file", size: 5 }, { name: "src", type: "directory" }, { name: "link", type: "other" }] } });
	const { ctx } = fakeContext({ fs });
	const response = await listResponse(ctx, request(LIST_PATH, "sessionId=session-1"));
	assert.equal(response.status, 200);
	const payload = await response.json();
	assert.equal(payload.path, "/work");
	assert.equal(payload.parent, "/");
	assert.equal(payload.workspaceRoot, "/work");
	assert.deepEqual(payload.entries.map((entry) => entry.name), ["src", "b.txt", "link"]);
	assert.equal(payload.truncated, false);
	assert.equal(response.headers.get("cache-control"), "no-store");
});

test("the list route reaches outside the workspace and reports the parent", async () => {
	const fs = fakeFs({ tree: { "/etc": [{ name: "hosts", type: "file", size: 12 }] } });
	const { ctx } = fakeContext({ fs });
	const response = await listResponse(ctx, request(LIST_PATH, "sessionId=session-1&path=%2Fetc"));
	const payload = await response.json();
	assert.equal(payload.path, "/etc");
	assert.equal(payload.parent, "/");
	assert.deepEqual(payload.entries, [{ name: "hosts", type: "file", size: 12 }]);
});

test("the list route reports a missing directory as 404 JSON", async () => {
	const { ctx } = fakeContext({ fs: fakeFs({ tree: {} }) });
	const response = await listResponse(ctx, request(LIST_PATH, "sessionId=session-1&path=gone"));
	assert.equal(response.status, 404);
	assert.equal((await response.json()).error, "not found");
});

test("the browse page lists one level, escapes names, and links both actions", async () => {
	const fs = fakeFs({
		tree: {
			"/work": [
				{ name: "src", type: "directory" },
				{ name: "<img src=x onerror=alert(1)>.md", type: "file", size: 12 },
				{ name: "a.txt", type: "file", size: 3 }
			]
		}
	});
	const { ctx } = fakeContext({ fs });
	const response = await browseResponse(ctx, request(BROWSE_PATH, "sessionId=session-1"));
	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-type"), /^text\/html/u);
	assert.match(response.headers.get("content-security-policy"), /default-src 'none'/u);
	assert.equal(response.headers.get("referrer-policy"), "no-referrer");
	const html = await response.text();
	assert.ok(!html.includes("<img src=x"), "raw markup must never survive into the page");
	assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;.md"));
	assert.ok(html.includes(`${BROWSE_PATH}?sessionId=session-1&amp;path=%2Fwork%2Fsrc`), "directory links to the browse page");
	assert.ok(html.includes(`${ARCHIVE_PATH}?sessionId=session-1&amp;path=%2Fwork%2Fsrc`), "directory links to the archive route");
	assert.ok(html.includes(`${DOWNLOAD_PATH}?sessionId=session-1&amp;path=%2Fwork%2Fa.txt`), "file links to the download route");
	assert.ok(!/<script/iu.test(html), "the page ships no script");
});

test("the browse page offers a parent link and an empty notice", async () => {
	const fs = fakeFs({ tree: { "/work": [{ name: "empty", type: "directory" }], "/work/empty": [] } });
	const { ctx } = fakeContext({ fs });
	const response = await browseResponse(ctx, request(BROWSE_PATH, "sessionId=session-1&path=%2Fwork%2Fempty"));
	const html = await response.text();
	assert.ok(html.includes("Parent directory"));
	assert.ok(html.includes("This directory is empty"));
	assert.ok(html.includes(">empty<"), "breadcrumb carries the current segment");
});

test("the browse page answers Chinese when the request asks for it", async () => {
	const fs = fakeFs({ tree: { "/work": [] } });
	const { ctx } = fakeContext({ fs });
	const response = await browseResponse(ctx, new Request(`http://dsh.internal${BROWSE_PATH}?sessionId=session-1`, { headers: { "accept-language": "zh-CN,zh;q=0.9" } }));
	const html = await response.text();
	assert.ok(html.includes("此目录为空"));
});

test("the archive route streams a valid ZIP of the whole subtree", async () => {
	const fs = fakeFs({
		tree: {
			"/work": [{ name: "src", type: "directory" }],
			"/work/src": [{ name: "nested", type: "directory" }, { name: "a.txt", type: "file", size: 6 }],
			"/work/src/nested": [{ name: "b.txt", type: "file", size: 5 }]
		},
		contents: { "/work/src/a.txt": Buffer.from("alpha\n"), "/work/src/nested/b.txt": Buffer.from("beta\n") }
	});
	const { ctx } = fakeContext({ fs });
	const response = await archiveResponse(ctx, request(ARCHIVE_PATH, "sessionId=session-1&path=src"));
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("content-type"), "application/zip");
	assert.match(response.headers.get("content-disposition"), /filename="src\.zip"/u);
	const entries = parseZip(Buffer.from(await response.arrayBuffer()));
	assert.deepEqual(entries.map((entry) => entry.name), ["src/", "src/nested/", "src/a.txt", "src/nested/b.txt"]);
	for (const entry of entries) {
		assert.equal(entry.crc, crc32(entry.data), `crc for ${entry.name}`);
		assert.equal(entry.uncompressedSize, entry.data.byteLength, `size for ${entry.name}`);
	}
	assert.equal(entries.find((entry) => entry.name === "src/a.txt").data.toString(), "alpha\n");
	assert.equal(entries.find((entry) => entry.name === "src/").method, 0, "directories are stored, not deflated");
});

test("compressible files are deflated and incompressible ones are stored", async () => {
	const payload = Buffer.from("a".repeat(8192));
	const noise = Buffer.from(Array.from({ length: 64 }, (_, index) => (index * 37) % 251));
	const fs = fakeFs({
		tree: { "/work": [{ name: "pack", type: "directory" }], "/work/pack": [{ name: "big.txt", type: "file" }, { name: "tiny.bin", type: "file" }] },
		contents: { "/work/pack/big.txt": payload, "/work/pack/tiny.bin": noise }
	});
	const { ctx } = fakeContext({ fs });
	const entries = parseZip(Buffer.from(await (await archiveResponse(ctx, request(ARCHIVE_PATH, "sessionId=session-1&path=pack"))).arrayBuffer()));
	assert.equal(entries.find((entry) => entry.name === "pack/big.txt").method, 8);
	assert.deepEqual(entries.find((entry) => entry.name === "pack/big.txt").data, payload);
	assert.deepEqual(entries.find((entry) => entry.name === "pack/tiny.bin").data, noise);
});

test("a file path on the archive route is refused with a pointer to the file route", async () => {
	const fs = fakeFs({ tree: { "/work/readme.md": "file" } });
	const { ctx } = fakeContext({ fs });
	const response = await archiveResponse(ctx, request(ARCHIVE_PATH, "sessionId=session-1&path=readme.md"));
	assert.equal(response.status, 400);
	assert.match(await response.text(), /file download route/u);
});

test("HEAD on the archive route answers headers without a body", async () => {
	const fs = fakeFs({ tree: { "/work": [] } });
	const { ctx } = fakeContext({ fs });
	const response = await archiveResponse(ctx, request(ARCHIVE_PATH, "sessionId=session-1&path=", "HEAD"));
	assert.equal(response.status, 200);
	assert.equal(response.body, null);
	assert.equal(response.headers.get("content-type"), "application/zip");
});

test("archive limits refuse a runaway tree before streaming", async () => {
	const entries = Array.from({ length: 5 }, (_, index) => ({ name: `f${index}.txt`, type: "file", size: 1 }));
	const fs = fakeFs({ tree: { "/work": entries }, contents: Object.fromEntries(entries.map((entry) => [`/work/${entry.name}`, Buffer.from("x")])) });
	const { ctx } = fakeContext({ fs });
	const target = { targetKey: "/work", displayPath: "/work" };
	await assert.rejects(
		() => collectArchiveEntries(ctx, target, undefined, { maxEntries: 3 }),
		(error) => error.code === "archive/too-many-entries"
	);
	await assert.rejects(
		() => collectArchiveEntries(ctx, target, undefined, { maxBytes: 2 }),
		(error) => error.code === "archive/too-large"
	);
	await assert.rejects(
		() => readTargetBuffered(ctx, { targetKey: "/work/f0.txt", displayPath: "/work/f0.txt" }, 0, undefined),
		(error) => error.code === "archive/file-too-large"
	);
});

test("a multi-select archive bundles every requested path", async () => {
	const fs = fakeFs({
		tree: { "/work": [{ name: "src", type: "directory" }, { name: "a.txt", type: "file", size: 3 }], "/work/src": [{ name: "b.txt", type: "file", size: 3 }] },
		contents: { "/work/a.txt": Buffer.from("aaa"), "/work/src/b.txt": Buffer.from("bbb") }
	});
	const { ctx } = fakeContext({ fs });
	const response = await archiveSelectionResponse(ctx, new Request(`http://dsh.internal${ARCHIVE_PATH}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sessionId: "session-1", paths: ["/work/a.txt", "/work/src"] })
	}));
	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-disposition"), /filename="selection\.zip"/u);
	const entries = parseZip(Buffer.from(await response.arrayBuffer()));
	assert.deepEqual(entries.map((entry) => entry.name), ["a.txt", "src/", "src/b.txt"]);
	assert.equal(entries.find((entry) => entry.name === "a.txt").data.toString(), "aaa");
	assert.equal(entries.find((entry) => entry.name === "src/b.txt").data.toString(), "bbb");
});

test("a single-path selection archive is named after the path", async () => {
	const fs = fakeFs({ tree: { "/work": [] }, contents: { "/work/report.md": Buffer.from("x") } });
	const { ctx } = fakeContext({ fs });
	const response = await archiveSelectionResponse(ctx, new Request(`http://dsh.internal${ARCHIVE_PATH}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sessionId: "session-1", paths: ["/work/report.md"] })
	}));
	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-disposition"), /filename="report\.md\.zip"/u);
});

test("a selection with a bad body or nothing to archive is refused", async () => {
	const { ctx } = fakeContext({ fs: fakeFs({ tree: { "/work": [] } }) });
	const bad = await archiveSelectionResponse(ctx, new Request(`http://dsh.internal${ARCHIVE_PATH}`, { method: "POST", body: "not json" }));
	assert.equal(bad.status, 400);
	const empty = await archiveSelectionResponse(ctx, new Request(`http://dsh.internal${ARCHIVE_PATH}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sessionId: "session-1", paths: ["/work/missing"] })
	}));
	assert.equal(empty.status, 404);
});

test("basename accepts both path separators", () => {
	assert.equal(basename("/work/out/report.md"), "report.md");
	assert.equal(basename("C:\\work\\out\\report.md"), "report.md");
	assert.equal(basename("report.md"), "report.md");
	assert.equal(basename("out/"), "out");
});

test("parent and breadcrumb paths keep the root intact", () => {
	assert.equal(parentPath("/work/out"), "/work");
	assert.equal(parentPath("/work"), "/");
	assert.equal(parentPath("/"), "/");
	assert.deepEqual(breadcrumbsFor("/a/b/c").map((crumb) => crumb.path), ["/", "/a", "/a/b", "/a/b/c"]);
	assert.deepEqual(breadcrumbsFor("/").map((crumb) => crumb.path), ["/"]);
});

test("unknown extensions stream as opaque bytes", () => {
	assert.equal(contentTypeOf("archive.bin"), "application/octet-stream");
	assert.equal(contentTypeOf("noextension"), "application/octet-stream");
	assert.equal(contentTypeOf("photo.PNG"), "image/png");
});

test("a non-ASCII filename keeps both a fallback and its real name", () => {
	const value = contentDisposition("实验报告.md");
	assert.match(value, /filename="[^\u0080-\uffff]+"/u);
	assert.ok(value.includes(`filename*=UTF-8''${encodeURIComponent("实验报告.md")}`));
});

/** One upload request whose body is the given bytes. */
function uploadRequest(query, body, type = "application/octet-stream") {
	return new Request(`http://dsh.internal${UPLOAD_PATH}?${query}`, {
		method: "POST",
		headers: { "content-type": type },
		body
	});
}

test("the list route reports the session's own mode as the browser default", async () => {
	const fs = fakeFs({ tree: { "/work": [] } });
	const { ctx } = fakeContext({ fs, sandboxMode: "workspace-write" });
	const payload = await (await listResponse(ctx, new Request(`http://dsh.internal${LIST_PATH}?sessionId=session-1`, {}))).json();
	assert.equal(payload.sessionMode, "workspace-write");
});

test("reads stay unconfined in every mode, including outside the workspace", async () => {
	for (const sandboxMode of ["read-only", "workspace-write", "danger-full-access"]) {
		const fs = fakeFs({ tree: { "/etc": [] }, contents: { "/etc/hosts": Buffer.from("x") } });
		const { ctx } = fakeContext({ fs, sandboxMode });
		assert.equal((await listResponse(ctx, new Request(`http://dsh.internal${LIST_PATH}?sessionId=session-1&path=%2Fetc`, {}))).status, 200, `list ${sandboxMode}`);
		assert.equal((await browseResponse(ctx, request(BROWSE_PATH, "sessionId=session-1&path=%2Fetc"))).status, 200, `browse ${sandboxMode}`);
		assert.equal((await downloadResponse(ctx, request(DOWNLOAD_PATH, "sessionId=session-1&path=%2Fetc%2Fhosts"))).status, 200, `download ${sandboxMode}`);
		assert.equal((await archiveResponse(ctx, request(ARCHIVE_PATH, "sessionId=session-1&path=%2Fetc"))).status, 200, `archive ${sandboxMode}`);
	}
});

test("an unknown upload mode is refused instead of silently defaulting", async () => {
	const fs = fakeFs({ tree: { "/work": [] } });
	const { ctx } = fakeContext({ fs });
	const response = await uploadResponse(ctx, uploadRequest("sessionId=session-1&path=%2Fwork&name=a.txt&mode=root", "x", "text/plain"));
	assert.equal(response.status, 400);
	assert.equal(fs.calls.writes.length, 0);
});

test("a text upload writes through the filesystem with the mode policy", async () => {
	const fs = fakeFs({ tree: { "/work": [] } });
	const { ctx } = fakeContext({ fs, sandboxMode: "workspace-write" });
	const response = await uploadResponse(ctx, uploadRequest("sessionId=session-1&path=%2Fwork&name=note.md", "# hi\n", "text/markdown"));
	assert.equal(response.status, 200);
	const payload = await response.json();
	assert.equal(payload.encoding, "utf-8");
	assert.equal(payload.bytes, 5);
	assert.equal(fs.calls.writes.length, 1);
	assert.equal(fs.calls.writes[0].path, "/work/note.md");
	assert.equal(fs.calls.writes[0].content, "# hi\n");
	assert.deepEqual(fs.calls.writes[0].intent, { kind: "createIfAbsent" });
	assert.equal(fs.calls.writes[0].policy.mode, "workspace-write");
	assert.equal(fs.calls.writes[0].policy.workspaceRoot, "/work");
});

test("an upload is refused in read-only mode", async () => {
	const fs = fakeFs({ tree: { "/work": [] } });
	const { ctx } = fakeContext({ fs, sandboxMode: "read-only" });
	const response = await uploadResponse(ctx, uploadRequest("sessionId=session-1&path=%2Fwork&name=note.md", "x", "text/plain"));
	assert.equal(response.status, 403);
	assert.equal(fs.calls.writes.length, 0);
});

test("an upload outside the workspace is refused in workspace-write mode", async () => {
	const fs = fakeFs({ tree: { "/etc": [] } });
	const { ctx } = fakeContext({ fs, sandboxMode: "workspace-write" });
	const response = await uploadResponse(ctx, uploadRequest("sessionId=session-1&path=%2Fetc&name=hosts", "x", "text/plain"));
	assert.equal(response.status, 403);
	assert.equal(fs.calls.writes.length, 0);
});

test("overwriting an existing file requires the overwrite flag", async () => {
	const fs = fakeFs({ tree: { "/work": [] }, contents: { "/work/note.md": Buffer.from("old") } });
	const { ctx } = fakeContext({ fs });
	const created = await uploadResponse(ctx, uploadRequest("sessionId=session-1&path=%2Fwork&name=note.md", "new", "text/plain"));
	assert.equal(created.status, 409);
	assert.equal((await created.json()).exists, true);
	const replaced = await uploadResponse(ctx, uploadRequest("sessionId=session-1&path=%2Fwork&name=note.md&overwrite=1", "new", "text/plain"));
	assert.equal(replaced.status, 200);
	assert.equal(fs.calls.writes.at(-1).intent, undefined);
	assert.equal(fs.calls.writes.at(-1).content, "new");
});

test("an invalid file name is refused before any write", async () => {
	const fs = fakeFs({ tree: { "/work": [] } });
	const { ctx } = fakeContext({ fs });
	for (const name of ["..", ".", "a%2Fb", "a%5Cb"]) {
		const response = await uploadResponse(ctx, uploadRequest(`sessionId=session-1&path=%2Fwork&name=${name}`, "x", "text/plain"));
		assert.equal(response.status, 400, `expected 400 for ${name}`);
	}
	assert.equal(fs.calls.writes.length, 0);
});

test("a binary upload lands byte-for-byte and refuses to clobber", async () => {
	const dir = mkdtempSync(joinPath(tmpdir(), "dsh-upload-"));
	const target = { targetKey: "binary", displayPath: joinPath(dir, "blob.bin") };
	const ctx = { fs: { processPath: () => joinPath(dir, "blob.bin") } };
	const scope = { sessionId: "session-1", workspaceRoot: dir };
	const bytes = new Uint8Array([0, 1, 2, 255, 254]);
	await writeUpload(ctx, scope, "danger-full-access", target, bytes, true, undefined);
	assert.deepEqual(new Uint8Array(readFileSync(target.displayPath)), bytes);
	await assert.rejects(() => writeUpload(ctx, scope, "danger-full-access", target, bytes, false, undefined), (error) => error.code === "EEXIST");
	assert.equal(uploadFailure(Object.assign(new Error("x"), { code: "EEXIST" })).status, 409);
});
