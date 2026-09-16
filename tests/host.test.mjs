/**
 * Unit tests for the host half: route registration, paged streaming, attachment
 * headers, HEAD handling, and each typed failure mapping.
 *
 * The context is a small fake, so no server, Session, or filesystem is needed —
 * the route is asserted at its own seam.
 *
 * Run: node --test tests/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DOWNLOAD_PATH,
	basename,
	contentDisposition,
	contentTypeOf,
	downloadResponse,
	fileStream,
	apply
} from "../lib/index.js";

/** A fake workspaceFiles service over one in-memory Buffer. */
function fakeFiles(buffer, options = {}) {
	const calls = { stat: 0, reads: [] };
	return {
		calls,
		stat: async () => {
			calls.stat += 1;
			if (options.statError !== undefined) throw options.statError;
			return {
				absolutePath: options.absolutePath ?? "/work/out/report.md",
				version: "v1",
				...(options.sizeUnknown === true ? {} : { bytes: buffer.byteLength })
			};
		},
		readBytes: async (_scope, _path, range) => {
			calls.reads.push(range);
			if (options.tooLargeAbove !== undefined && range.length > options.tooLargeAbove) {
				throw Object.assign(new Error("window too large"), { code: "workspace-file/too-large" });
			}
			const slice = buffer.subarray(range.offset, range.offset + range.length);
			return {
				offset: range.offset,
				data: Buffer.from(slice).toString("base64"),
				eof: range.offset + slice.byteLength >= buffer.byteLength
			};
		}
	};
}

/** A fake host context with only the services the route reads. */
function fakeContext({ files, live = true, sessionId = "session-1", workspaceRoot = "/work" }) {
	const registered = [];
	const services = new Map([
		["workspaceFiles", files],
		["sessions", { get: (id) => (live && id === sessionId ? { header: { cwd: workspaceRoot } } : undefined) }],
		["sessionPersistence", { stat: async () => undefined }],
		["sandboxPolicy", { workspaceRoot }]
	]);
	return {
		registered,
		ctx: {
			get: (name) => services.get(name),
			effect: (callback) => callback(),
			connection: { fetch: { register: (route) => registered.push(route) } }
		}
	};
}

/** One authenticated GET against the route under test. */
function getRequest(query, method = "GET") {
	return new Request(`http://dsh.internal${DOWNLOAD_PATH}?${query}`, { method });
}

test("apply registers the exact authenticated GET/HEAD route", () => {
	const { ctx, registered } = fakeContext({ files: fakeFiles(Buffer.from("x")) });
	apply(ctx);
	assert.equal(registered.length, 1);
	assert.equal(registered[0].path, "/api/workspace.download");
	assert.deepEqual(registered[0].methods, ["GET", "HEAD"]);
	assert.equal(registered[0].requestBody, "buffered");
	assert.equal(typeof registered[0].fetch, "function");
});

test("GET streams the complete file with attachment headers", async () => {
	const body = Buffer.from("# report\nbody\n", "utf8");
	const files = fakeFiles(body);
	const { ctx } = fakeContext({ files });
	const response = await downloadResponse(ctx, getRequest("sessionId=session-1&path=out/report.md"));
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
	assert.equal(response.headers.get("content-length"), String(body.byteLength));
	assert.match(response.headers.get("content-disposition"), /^attachment; filename="report\.md"/u);
	assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
});

test("GET pages a file larger than one window and still returns every byte", async () => {
	const body = Buffer.alloc(700 * 1024, 7);
	const files = fakeFiles(body);
	const { ctx } = fakeContext({ files });
	const response = await downloadResponse(ctx, getRequest("sessionId=session-1&path=big.bin"));
	assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
	assert.ok(files.calls.reads.length >= 3, `expected at least three windows, saw ${files.calls.reads.length}`);
	assert.equal(files.calls.reads[0].offset, 0);
	assert.equal(files.calls.reads[1].offset, files.calls.reads[0].length);
});

test("GET shrinks its window when the service refuses one as too large", async () => {
	const body = Buffer.alloc(400 * 1024, 3);
	const files = fakeFiles(body, { tooLargeAbove: 128 * 1024 });
	const { ctx } = fakeContext({ files });
	const response = await downloadResponse(ctx, getRequest("sessionId=session-1&path=big.bin"));
	assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
	assert.ok(files.calls.reads.some((range) => range.length <= 128 * 1024), "expected a shrunken window");
});

test("GET omits content-length when the backend reports no size", async () => {
	const body = Buffer.from("no size reported", "utf8");
	const { ctx } = fakeContext({ files: fakeFiles(body, { sizeUnknown: true }) });
	const response = await downloadResponse(ctx, getRequest("sessionId=session-1&path=out.txt"));
	assert.equal(response.headers.get("content-length"), null);
	assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
});

test("HEAD answers the same headers without reading any content", async () => {
	const files = fakeFiles(Buffer.from("payload", "utf8"));
	const { ctx } = fakeContext({ files });
	const response = await downloadResponse(ctx, getRequest("sessionId=session-1&path=out/a.txt", "HEAD"));
	assert.equal(response.status, 200);
	assert.equal(response.body, null);
	assert.equal(response.headers.get("content-length"), "7");
	assert.equal(files.calls.stat, 1);
	assert.equal(files.calls.reads.length, 0);
});

test("missing or empty query parameters are refused", async () => {
	const { ctx } = fakeContext({ files: fakeFiles(Buffer.from("x")) });
	for (const query of ["path=out.txt", "sessionId=session-1", "sessionId=&path=out.txt", "sessionId=session-1&path="]) {
		const response = await downloadResponse(ctx, getRequest(query));
		assert.equal(response.status, 400, `expected 400 for ${query}`);
	}
});

test("an unknown Session is reported as not found", async () => {
	const { ctx } = fakeContext({ files: fakeFiles(Buffer.from("x")), live: false });
	const response = await downloadResponse(ctx, getRequest("sessionId=missing&path=out.txt"));
	assert.equal(response.status, 404);
});

test("typed service failures map onto HTTP statuses", async () => {
	const cases = [
		["workspace-file/not-found", 404],
		["workspace-file/not-regular-file", 400],
		["workspace-file/outside-workspace", 403],
		["workspace-file/too-large", 413],
		["gateway/bad-request", 400]
	];
	for (const [code, status] of cases) {
		const { ctx } = fakeContext({ files: fakeFiles(Buffer.from("x"), { statError: Object.assign(new Error(code), { code }) }) });
		const response = await downloadResponse(ctx, getRequest("sessionId=session-1&path=out.txt"));
		assert.equal(response.status, status, `expected ${status} for ${code}`);
	}
	const { ctx } = fakeContext({ files: fakeFiles(Buffer.from("x"), { statError: new Error("boom") }) });
	assert.equal((await downloadResponse(ctx, getRequest("sessionId=session-1&path=out.txt"))).status, 500);
});

test("the stream closes on an empty window instead of looping", async () => {
	const files = {
		readBytes: async () => ({ offset: 0, data: "", eof: false })
	};
	const stream = fileStream(files, { sessionId: "s", workspaceRoot: "/work" }, "empty", 10, undefined);
	assert.equal(await new Response(stream).text(), "");
});

test("basename accepts both path separators", () => {
	assert.equal(basename("/work/out/report.md"), "report.md");
	assert.equal(basename("C:\\work\\out\\report.md"), "report.md");
	assert.equal(basename("report.md"), "report.md");
	assert.equal(basename("out/"), "out");
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
