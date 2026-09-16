/**
 * dsh-file-download — host half.
 *
 * Registers one authenticated exact Fetch route on Connection:
 *
 *   GET|HEAD /api/workspace.download?sessionId=<id>&path=<path>
 *
 * The route streams one regular file that the Session's own filesystem can read
 * (absolute, or relative to the Session workspace root), the same authority the
 * official Sidebar preview uses, and answers it with
 * `Content-Disposition: attachment` so a remote browser saves it locally.
 * This is the missing half of a headless host: DSH's native "open" actions need
 * a desktop on the serving machine, while a browser download never does.
 *
 * Why a Connection Fetch route instead of a raw webserver route: the Connection
 * fence owns the Host/Origin and browser-session checks, so the endpoint carries
 * the exact same authentication as every other `/api` call and never becomes an
 * unauthenticated side door. This mirrors `@deepseek-ai/dsh-session-log-export`.
 *
 * Reads go through the composed `workspaceFiles` service, so file identity,
 * regular-file checks, and workspace-relative resolution are the official ones.
 * The body is a paged `ReadableStream`: one bounded window per pull, so a large
 * file costs one window of memory and the browser gets progress plus a correct
 * `Content-Length`.
 *
 * @module dsh-file-download
 */

/** Stable Cordis plugin name. */
export const name = "file-download";

/** Connection owns the authenticated Fetch table; workspaceFiles resolves reads. */
export const inject = ["connection", "workspaceFiles"];

/** Exact authenticated download route. */
export const DOWNLOAD_PATH = "/api/workspace.download";

/** One byte window per pull; comfortably below the service's default page cap. */
const DEFAULT_WINDOW_BYTES = 256 * 1024;

/** Smallest window a `too-large` refusal is allowed to shrink to. */
const MIN_WINDOW_BYTES = 64 * 1024;

/** Media types worth naming explicitly; everything else streams as opaque bytes. */
const CONTENT_TYPES = {
	".md": "text/markdown; charset=utf-8",
	".markdown": "text/markdown; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".log": "text/plain; charset=utf-8",
	".csv": "text/csv; charset=utf-8",
	".tsv": "text/tab-separated-values; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".jsonl": "application/x-ndjson; charset=utf-8",
	".yaml": "application/yaml; charset=utf-8",
	".yml": "application/yaml; charset=utf-8",
	".toml": "application/toml; charset=utf-8",
	".xml": "application/xml; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".cjs": "text/javascript; charset=utf-8",
	".ts": "text/plain; charset=utf-8",
	".py": "text/x-python; charset=utf-8",
	".sh": "text/x-shellscript; charset=utf-8",
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".bmp": "image/bmp",
	".avif": "image/avif",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".zip": "application/zip",
	".gz": "application/gzip",
	".tar": "application/x-tar",
	".7z": "application/x-7z-compressed",
	".rar": "application/vnd.rar",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".xls": "application/vnd.ms-excel",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".doc": "application/msword",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".ppt": "application/vnd.ms-powerpoint",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf"
};

/**
 * Trailing path segment, accepting both separators so a Windows-host path still
 * yields a usable download filename.
 * @param value - slash- or backslash-separated path.
 * @returns The final segment, or the whole string when separator-free.
 */
export function basename(value) {
	const trimmed = String(value).replace(/[\\/]+$/u, "");
	const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

/**
 * Pick a response media type from the download filename.
 * @param filename - basename used for the download.
 * @returns A named media type, or opaque bytes when the extension is unknown.
 */
export function contentTypeOf(filename) {
	const dot = filename.lastIndexOf(".");
	if (dot === -1) return "application/octet-stream";
	return CONTENT_TYPES[filename.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Build an attachment disposition that keeps a non-ASCII filename intact.
 * The quoted `filename` is an ASCII-only fallback; `filename*` carries the real
 * name in RFC 5987 form, which every current browser prefers.
 * @param filename - download filename.
 * @returns One `Content-Disposition` header value.
 */
export function contentDisposition(filename) {
	const fallback = filename.replace(/[^\u0020-\u007e]/gu, "_").replace(/["\\]/gu, "_");
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Resolve the Session's filesystem scope, exactly as the Remote layer does: a
 * live Session header when it is mounted, otherwise the persistence service's
 * header-only stat for a cold Session.
 * @param ctx - host context.
 * @param sessionId - Session identity from the wire.
 * @returns `{ sessionId, workspaceRoot }`, or undefined when the Session is unknown.
 */
async function resolveScope(ctx, sessionId) {
	const sessions = ctx.get("sessions");
	const live = sessions?.get(sessionId)?.header;
	const stored = live === undefined ? await ctx.get("sessionPersistence")?.stat(sessionId) : undefined;
	const header = live ?? stored?.header;
	if (header === undefined) return undefined;
	const workspaceRoot = header.cwd ?? ctx.get("sandboxPolicy")?.workspaceRoot;
	if (workspaceRoot === undefined) return undefined;
	return { sessionId, workspaceRoot };
}

/**
 * Page one file as a byte stream. Each pull asks `workspaceFiles` for one
 * bounded window; a window the service refuses as too large is halved once and
 * retried, so a deployment with a lower page cap still streams.
 * @param files - the `workspaceFiles` service.
 * @param scope - resolved Session scope.
 * @param path - file path accepted by the service.
 * @param total - known file size, when the backend reports one.
 * @param signal - request cancellation.
 * @returns The response body stream.
 */
export function fileStream(files, scope, path, total, signal) {
	let offset = 0;
	let window = DEFAULT_WINDOW_BYTES;
	return new ReadableStream({
		async pull(controller) {
			if (signal?.aborted) {
				controller.error(new Error("download aborted"));
				return;
			}
			if (total !== undefined && offset >= total) {
				controller.close();
				return;
			}
			let page;
			try {
				page = await files.readBytes(scope, path, { offset, length: window }, signal);
			} catch (error) {
				if (error?.code === "workspace-file/too-large" && window > MIN_WINDOW_BYTES) {
					window = Math.max(MIN_WINDOW_BYTES, window >> 1);
					return;
				}
				controller.error(error);
				return;
			}
			const bytes = Buffer.from(page.data, "base64");
			if (bytes.byteLength === 0) {
				controller.close();
				return;
			}
			offset += bytes.byteLength;
			controller.enqueue(new Uint8Array(bytes));
			if (page.eof === true) controller.close();
		}
	});
}

/**
 * Map one typed service failure onto an HTTP status.
 * @param error - thrown value from `workspaceFiles`.
 * @returns A short, non-leaking response.
 */
export function failureResponse(error) {
	switch (error?.code) {
		case "workspace-file/not-found": return new Response("file not found", { status: 404 });
		case "workspace-file/not-regular-file": return new Response("not a regular file", { status: 400 });
		case "workspace-file/outside-workspace": return new Response("outside the workspace", { status: 403 });
		case "workspace-file/too-large": return new Response("file exceeds the configured complete-file cap", { status: 413 });
		case "gateway/bad-request": return new Response("invalid path", { status: 400 });
		default: return new Response("download failed", { status: 500 });
	}
}

/**
 * Serve one download request: validate the query, resolve the Session, stat the
 * file for its size and name, and hand back headers plus (for GET) the stream.
 * @param ctx - host context carrying the workspace file service.
 * @param request - the authenticated Fetch request.
 * @returns The response to bridge.
 */
export async function downloadResponse(ctx, request) {
	const url = new URL(request.url);
	const sessionId = url.searchParams.get("sessionId");
	const path = url.searchParams.get("path");
	if (sessionId === null || sessionId === "" || path === null || path === "") {
		return new Response("missing sessionId or path query parameter", { status: 400 });
	}
	const files = ctx.get("workspaceFiles");
	if (files === undefined) return new Response("workspace file service unavailable", { status: 500 });
	let scope;
	try {
		scope = await resolveScope(ctx, sessionId);
	} catch {
		return new Response("session lookup failed", { status: 500 });
	}
	if (scope === undefined) return new Response("session not found", { status: 404 });
	let info;
	try {
		info = await files.stat(scope, path, request.signal);
	} catch (error) {
		return failureResponse(error);
	}
	const filename = basename(info.absolutePath ?? path) || "download";
	const total = typeof info.bytes === "number" ? info.bytes : undefined;
	const headers = {
		"content-type": contentTypeOf(filename),
		"content-disposition": contentDisposition(filename),
		"cache-control": "no-store",
		...(total === undefined ? {} : { "content-length": String(total) })
	};
	if (request.method === "HEAD") return new Response(null, { status: 200, headers });
	return new Response(fileStream(files, scope, path, total, request.signal), { status: 200, headers });
}

/**
 * Register the authenticated download route and keep it for this plugin's lifetime.
 * @param ctx - host context carrying Connection.
 */
export function apply(ctx) {
	ctx.effect(() => ctx.connection.fetch.register({
		path: DOWNLOAD_PATH,
		methods: ["GET", "HEAD"],
		requestBody: "buffered",
		fetch: (request) => downloadResponse(ctx, request)
	}), "file-download: route");
}
