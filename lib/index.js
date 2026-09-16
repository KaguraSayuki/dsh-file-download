/**
 * dsh-file-download — host half.
 *
 * Registers authenticated exact Fetch routes on Connection:
 *
 *   GET      /api/workspace.download/list?sessionId=<id>&path=<path>
 *   GET|HEAD /api/workspace.download?sessionId=<id>&path=<path>
 *   GET      /api/workspace.download/browse?sessionId=<id>&path=<path>
 *   GET|HEAD|POST /api/workspace.download/archive?sessionId=<id>&path=<path>
 *   POST     /api/workspace.download/upload?sessionId=<id>&path=<dir>&name=<file>
 *
 * Together they are a browser file manager: list any directory the serving
 * filesystem can read, stream one file, render a script-free HTML listing for
 * phones, stream a directory — or a multi-select — as a ZIP, and write one
 * uploaded file.
 *
 * Reading is never confined. The access mode gates uploads only: `read-only`
 * refuses every write, `workspace-write` confines a write to the Session
 * workspace, and `danger-full-access` allows any place the account can write.
 * The mode defaults to the Session's own sandbox policy and a browser may pick
 * another one, because the human behind the authenticated GUI is the principal
 * and can change the same knob through the official permission control.
 *
 * This is deliberately wider than the official `workspaceFiles` service, which
 * confines directory listing to the Session workspace. The Session still names
 * the default root, but an absolute path may leave it: a headless host reached
 * from another device has no way to hand over a file that lives next to the
 * workspace, and the deployment-level fence is the Web GUI's own authentication,
 * not the workspace boundary. Every route sits behind Connection's Host/Origin
 * and browser-session checks, so there is no unauthenticated side door.
 *
 * Reads go through the composed `ctx.fs` service, so file identity, regular-file
 * checks, and symlink handling are the backend's own; a text upload does too,
 * while a binary body takes the documented local-write path because the
 * filesystem contract exposes no byte write. Downloads and archives are paged
 * streams: a bounded window per pull keeps memory flat for a large file, and an
 * archive buffers one file at a time rather than the tree.
 *
 * @module dsh-file-download
 */
import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deflateRawSync } from "node:zlib";

/** Stable Cordis plugin name. */
export const name = "file-download";

/** Connection owns the authenticated Fetch table; the filesystem serves every read. */
export const inject = ["connection", "fs"];

/** Exact authenticated file download route. */
export const DOWNLOAD_PATH = "/api/workspace.download";

/** Exact authenticated JSON directory listing. */
export const LIST_PATH = "/api/workspace.download/list";

/** Exact authenticated server-rendered browse page. */
export const BROWSE_PATH = "/api/workspace.download/browse";

/** Exact authenticated directory/selection archive route. */
export const ARCHIVE_PATH = "/api/workspace.download/archive";

/** Exact authenticated upload route. */
export const UPLOAD_PATH = "/api/workspace.download/upload";

/** The three access modes, weakest first; a browser picks one per Session. */
export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];

/** Largest single upload accepted, before the body is read. */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

/** One byte window per pull: one page of memory regardless of file size. */
const DEFAULT_WINDOW_BYTES = 256 * 1024;

/** Caps a listing and an archive enforce before answering. */
const MAX_LIST_ENTRIES = 5000;
const MAX_ARCHIVE_ENTRIES = 20000;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_SELECTION = 200;

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
 * Parent directory of one absolute path, keeping the filesystem root intact.
 * @param value - absolute path.
 * @returns The parent path, or the same path when it is already a root.
 */
export function parentPath(value) {
	const trimmed = String(value).replace(/[\\/]+$/u, "");
	if (trimmed === "") return "/";
	if (/^[A-Za-z]:$/u.test(trimmed)) return `${trimmed}\\`;
	const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	if (cut < 0) return trimmed;
	if (cut === 0) return trimmed.slice(0, 1);
	const parent = trimmed.slice(0, cut);
	return /^[A-Za-z]:$/u.test(parent) ? `${parent}/` : parent;
}

/**
 * Breadcrumb trail for one absolute path, filesystem root first.
 * @param value - absolute path.
 * @returns `{ label, path }` pairs from the root down to this path.
 */
export function breadcrumbsFor(value) {
	const normalized = String(value).replace(/\\/gu, "/");
	const parts = normalized.split("/").filter((part) => part !== "");
	const crumbs = [];
	let accumulated;
	if (/^[A-Za-z]:/u.test(normalized)) {
		const root = `${parts.shift()}/`;
		crumbs.push({ label: root, path: root });
		accumulated = root.replace(/\/+$/u, "");
	} else {
		crumbs.push({ label: "/", path: "/" });
		accumulated = "";
	}
	for (const part of parts) {
		accumulated = accumulated === "" || accumulated === "/" ? `/${part}` : `${accumulated}/${part}`;
		crumbs.push({ label: part, path: accumulated });
	}
	return crumbs;
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
 * Resolve the Session's identity, which supplies the default root and proves the
 * caller named a real Session. The filesystem itself is process-wide.
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
 * Resolve one caller path into a filesystem target. A missing or empty path means
 * the Session workspace root; a relative path resolves against it; an absolute
 * path may leave it.
 * @param ctx - host context carrying `ctx.fs`.
 * @param scope - resolved Session scope.
 * @param requested - the path from the wire, or null.
 * @param signal - request cancellation.
 * @returns `{ target, path }` where `path` is the absolute display path.
 */
async function resolveTarget(ctx, scope, requested, signal) {
	const path = requested === null || requested === undefined || requested === "" ? scope.workspaceRoot : requested;
	const target = await ctx.fs.resolve(path, { cwd: scope.workspaceRoot, signal });
	return { target, path: ctx.fs.processPath(target) };
}

/**
 * Validate one access-mode value from the wire.
 * @param value - the raw query value.
 * @returns The mode, undefined when absent, or null when it is not a known mode.
 */
export function parseSandboxMode(value) {
	if (value === null || value === undefined || value === "") return undefined;
	return SANDBOX_MODES.includes(value) ? value : null;
}

/**
 * The access mode the Session's own policy currently resolves to. This is the
 * default a browser starts from; the client may narrow or widen it, because the
 * human behind the authenticated GUI is the principal and may already change the
 * same knob through the official permission control.
 * @param ctx - host context.
 * @param sessionId - Session identity from the wire.
 * @returns The resolved mode.
 */
export function sessionSandboxMode(ctx, sessionId) {
	const sandboxPolicy = ctx.get("sandboxPolicy");
	if (sandboxPolicy === undefined) return "danger-full-access";
	const session = ctx.get("sessions")?.get(sessionId);
	return sandboxPolicy.resolve(session === undefined ? {} : { session }).mode;
}

/**
 * Whether one resolved target sits inside the Session workspace.
 * @param ctx - host context carrying `ctx.fs`.
 * @param scope - resolved Session scope.
 * @param target - resolved target to test.
 * @param signal - request cancellation.
 * @returns True when the target is the workspace root or below it.
 */
async function withinWorkspace(ctx, scope, target, signal) {
	const root = await ctx.fs.resolve(scope.workspaceRoot, { cwd: scope.workspaceRoot, signal });
	return ctx.fs.contains(root, target);
}

/**
 * Enforce one mode against a resolved target. `workspace-write` confines reads
 * as well as writes to the workspace; the other two modes do not confine paths.
 * @param ctx - host context carrying `ctx.fs`.
 * @param scope - resolved Session scope.
 * @param mode - effective access mode.
 * @param target - resolved target about to be read or written.
 * @param signal - request cancellation.
 * @returns A refusal response, or undefined when the access is allowed.
 */
async function modeGate(ctx, scope, mode, target, signal) {
	if (mode !== "workspace-write") return undefined;
	if (await withinWorkspace(ctx, scope, target, signal)) return undefined;
	return new Response("outside the workspace for workspace-write mode", { status: 403 });
}

/**
 * Map one filesystem error onto an HTTP status.
 * @param error - thrown value from `ctx.fs`.
 * @returns The status code.
 */
export function fsStatus(error) {
	switch (error?.code) {
		case "FS_NOT_FOUND": return 404;
		case "FS_NOT_DIRECTORY":
		case "FS_NOT_REGULAR_FILE":
		case "FS_ABORTED": return 400;
		case "FS_PERMISSION_DENIED":
		case "FS_SANDBOX_DENIED": return 403;
		case "FS_TOO_LARGE": return 413;
		default: return 500;
	}
}

/** Short fixed message per filesystem failure status; never echoes a path. */
function fsMessage(status) {
	switch (status) {
		case 404: return "not found";
		case 400: return "not a directory or not a regular file";
		case 403: return "permission denied";
		case 413: return "too large";
		default: return "filesystem read failed";
	}
}

/**
 * Map one filesystem failure onto a short, non-leaking response.
 * @param error - thrown value from `ctx.fs`.
 * @returns The response to bridge.
 */
export function fsFailure(error) {
	const status = fsStatus(error);
	return new Response(fsMessage(status), { status });
}

/**
 * Page one file as a byte stream. Each pull reads one bounded window through the
 * filesystem, so a large file costs one window of memory.
 * @param ctx - host context carrying `ctx.fs`.
 * @param target - resolved file target.
 * @param total - known file size, when the backend reports one.
 * @param signal - request cancellation.
 * @returns The response body stream.
 */
export function fileStream(ctx, target, total, signal) {
	let offset = 0;
	return new ReadableStream({
		async pull(controller) {
			try {
				if (signal?.aborted) throw new Error("download aborted");
				if (total !== undefined && offset >= total) {
					controller.close();
					return;
				}
				const bytes = await ctx.fs.readByteRange(target, { offset, length: DEFAULT_WINDOW_BYTES }, signal);
				if (bytes.byteLength === 0) {
					controller.close();
					return;
				}
				offset += bytes.byteLength;
				controller.enqueue(bytes);
				if (total !== undefined && offset >= total) controller.close();
			} catch (error) {
				controller.error(error);
			}
		}
	});
}

/**
 * Serve one file download: validate the query, resolve the target, and answer
 * with attachment headers plus (for GET) the stream.
 * @param ctx - host context carrying the filesystem.
 * @param request - the authenticated Fetch request.
 * @returns The response to bridge.
 */
export async function downloadResponse(ctx, request) {
	const url = new URL(request.url);
	const sessionId = url.searchParams.get("sessionId");
	const requested = url.searchParams.get("path");
	if (sessionId === null || sessionId === "" || requested === null || requested === "") {
		return new Response("missing sessionId or path query parameter", { status: 400 });
	}
	let scope;
	try {
		scope = await resolveScope(ctx, sessionId);
	} catch {
		return new Response("session lookup failed", { status: 500 });
	}
	if (scope === undefined) return new Response("session not found", { status: 404 });
	let resolved;
	let info;
	try {
		resolved = await resolveTarget(ctx, scope, requested, request.signal);
		info = await ctx.fs.stat(resolved.target, request.signal);
	} catch (error) {
		return fsFailure(error);
	}
	if (info === undefined) return new Response("not found", { status: 404 });
	if (info.type !== "file") return new Response("not a regular file; use the archive route for a directory", { status: 400 });
	const filename = basename(resolved.path) || "download";
	const total = typeof info.size === "number" ? info.size : undefined;
	const headers = {
		"content-type": contentTypeOf(filename),
		"content-disposition": contentDisposition(filename),
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	};
	if (total !== undefined) headers["content-length"] = String(total);
	if (request.method === "HEAD") return new Response(null, { status: 200, headers });
	return new Response(fileStream(ctx, resolved.target, total, request.signal), { status: 200, headers });
}

/**
 * Serve the JSON directory listing the browser file manager consumes.
 * @param ctx - host context carrying the filesystem.
 * @param request - the authenticated Fetch request.
 * @returns A JSON response with `{ path, parent, workspaceRoot, entries, truncated }`.
 */
export async function listResponse(ctx, request) {
	const url = new URL(request.url);
	const sessionId = url.searchParams.get("sessionId");
	if (sessionId === null || sessionId === "") return Response.json({ error: "missing sessionId" }, { status: 400 });
	let scope;
	try {
		scope = await resolveScope(ctx, sessionId);
	} catch {
		return Response.json({ error: "session lookup failed" }, { status: 500 });
	}
	if (scope === undefined) return Response.json({ error: "session not found" }, { status: 404 });
	const sessionMode = sessionSandboxMode(ctx, sessionId);
	let resolved;
	let children;
	try {
		resolved = await resolveTarget(ctx, scope, url.searchParams.get("path"), request.signal);
		children = await ctx.fs.listDir(resolved.target, request.signal);
	} catch (error) {
		const status = fsStatus(error);
		return Response.json({ error: fsMessage(status) }, { status });
	}
	const ordered = orderEntries(children);
	const entries = ordered.slice(0, MAX_LIST_ENTRIES).map((entry) => ({
		name: entry.name,
		type: entry.type,
		...(typeof entry.size === "number" ? { size: entry.size } : {})
	}));
	return Response.json({
		path: resolved.path,
		parent: parentPath(resolved.path),
		workspaceRoot: scope.workspaceRoot,
		sessionMode,
		entries,
		truncated: ordered.length > entries.length
	}, { headers: { "cache-control": "no-store" } });
}

/** Response headers shared by the HTML surfaces. */
const HTML_HEADERS = {
	"content-type": "text/html; charset=utf-8",
	"cache-control": "no-store",
	"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff"
};

/** Page copy, picked from `Accept-Language`; the page ships no script. */
const LABELS = {
	en: {
		title: "Files",
		root: "Filesystem root",
		parent: "Parent directory",
		empty: "This directory is empty",
		truncated: (count) => `Too many entries; showing the first ${count}`,
		archive: "ZIP",
		archiveTitle: "Download this folder as a ZIP archive",
		download: "Download",
		notDirectory: "That path is not a directory.",
		notFound: "No such directory.",
		denied: "That directory cannot be read.",
		failed: "The directory could not be listed."
	},
	zh: {
		title: "文件浏览器",
		root: "根目录",
		parent: "上级目录",
		empty: "此目录为空",
		truncated: (count) => `条目过多，仅显示前 ${count} 项`,
		archive: "ZIP",
		archiveTitle: "把这个文件夹打包成 ZIP 下载",
		download: "下载",
		notDirectory: "该路径不是目录。",
		notFound: "目录不存在。",
		denied: "没有权限读取该目录。",
		failed: "无法列出该目录。"
	}
};

/**
 * HTML-escape one interpolated value.
 * @param value - any value about to be placed in the document.
 * @returns The escaped text.
 */
export function escapeHtml(value) {
	return String(value).replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

/**
 * Whether a request's `Accept-Language` prefers Chinese.
 * @param header - the raw header value.
 * @returns True when the first listed language is Chinese.
 */
export function prefersChinese(header) {
	return typeof header === "string" && /^\s*zh\b/iu.test(header);
}

/**
 * Human-readable byte size for a listing row.
 * @param bytes - size in bytes.
 * @returns A short size label, or an empty string when unknown.
 */
export function formatBytes(bytes) {
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

/**
 * Order one level the way the official tree does: directories, then files, then
 * anything else, each group natural-sorted so `file2` precedes `file10`.
 * @param entries - listing entries from the filesystem.
 * @returns A new sorted array.
 */
export function orderEntries(entries) {
	const rank = (entry) => (entry.type === "directory" ? 0 : entry.type === "file" ? 1 : 2);
	return [...entries].sort((left, right) => {
		const group = rank(left) - rank(right);
		if (group !== 0) return group;
		return String(left.name).localeCompare(String(right.name), undefined, { numeric: true, sensitivity: "base" });
	});
}

/** Same-origin URL of the browse page for one directory. */
function browseHref(sessionId, path) {
	const query = new URLSearchParams({ sessionId: String(sessionId) });
	if (path !== undefined && path !== "") query.set("path", String(path));
	return `${BROWSE_PATH}?${query.toString()}`;
}

/** Same-origin URL of the download route for one file. */
function downloadHref(sessionId, path) {
	return `${DOWNLOAD_PATH}?${new URLSearchParams({ sessionId: String(sessionId), path: String(path) }).toString()}`;
}

/** Same-origin URL of the folder archive route for one directory. */
export function archiveHref(sessionId, path) {
	return `${ARCHIVE_PATH}?${new URLSearchParams({ sessionId: String(sessionId), path: String(path) }).toString()}`;
}

/**
 * Render the server-side browse page. Everything interpolated is escaped, the
 * document carries no script, and every link stays on this origin.
 * @param options - session identity and the directory listing to render.
 * @returns The complete HTML document.
 */
export function renderBrowsePage({ sessionId, listing, chinese }) {
	const labels = chinese ? LABELS.zh : LABELS.en;
	const path = typeof listing.path === "string" && listing.path !== "" ? listing.path : "/";
	const crumbs = breadcrumbsFor(path);
	const rows = [];
	const parent = parentPath(path);
	if (parent !== path) {
		rows.push(`<li class="dir"><a class="label" href="${escapeHtml(browseHref(sessionId, parent))}"><span class="glyph">&#8593;</span><span class="name">${escapeHtml(labels.parent)}</span></a></li>`);
	}
	for (const entry of orderEntries(listing.entries ?? [])) {
		const child = path === "/" ? `/${entry.name}` : `${path.replace(/[\\/]+$/u, "")}/${entry.name}`;
		const name = escapeHtml(entry.name);
		if (entry.type === "directory") {
			rows.push(`<li class="dir"><a class="label" href="${escapeHtml(browseHref(sessionId, child))}"><span class="glyph">&#128193;</span><span class="name">${name}</span></a><a class="action" title="${escapeHtml(labels.archiveTitle)}" href="${escapeHtml(archiveHref(sessionId, child))}">${escapeHtml(labels.archive)}</a></li>`);
		} else if (entry.type === "file") {
			const href = escapeHtml(downloadHref(sessionId, child));
			rows.push(`<li class="file"><a class="label" href="${href}"><span class="glyph">&#11015;</span><span class="name">${name}</span></a><span class="meta">${escapeHtml(formatBytes(entry.size))}<a class="action" href="${href}">${escapeHtml(labels.download)}</a></span></li>`);
		} else {
			rows.push(`<li class="other"><span class="glyph">&#8226;</span><span class="name">${name}</span></li>`);
		}
	}
	if ((listing.entries ?? []).length === 0) rows.push(`<li class="note">${escapeHtml(labels.empty)}</li>`);
	if (listing.truncated === true) rows.push(`<li class="note">${escapeHtml(labels.truncated(MAX_LIST_ENTRIES))}</li>`);
	const trail = crumbs.map((crumb, index) => (index === crumbs.length - 1 ? `<span class="crumb current">${escapeHtml(crumb.label)}</span>` : `<a class="crumb" href="${escapeHtml(browseHref(sessionId, crumb.path))}">${escapeHtml(crumb.label)}</a><span class="sep">/</span>`)).join("");
	return `<!doctype html>
<html lang="${chinese ? "zh-Hans" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(labels.title)} — ${escapeHtml(path)}</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;padding:0 0 48px;font:14px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;background:#fff;color:#1b1b1f}
@media (prefers-color-scheme:dark){body{background:#16161a;color:#e8e8ec}}
header{position:sticky;top:0;z-index:1;padding:14px 16px 10px;background:inherit;border-bottom:1px solid rgba(128,128,128,.25)}
h1{margin:6px 0 0;font-size:15px;font-weight:600;word-break:break-all}
.crumb{color:inherit;text-decoration:none;opacity:.75}
.crumb.current{opacity:1;font-weight:600}
.sep{opacity:.4;margin:0 6px}
ul{list-style:none;margin:0;padding:6px 8px}
li{display:flex;align-items:center;gap:8px;padding:2px 0}
li>a.label,li>span{display:flex;align-items:center;gap:8px;min-width:0;flex:1;color:inherit;text-decoration:none}
li>a.label:hover .name{text-decoration:underline}
.glyph{width:1.3em;text-align:center;flex:none;opacity:.85}
.name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{display:flex;align-items:center;gap:10px;flex:none;opacity:.6;font-size:12px}
.action{flex:none;color:inherit;text-decoration:none;border:1px solid rgba(128,128,128,.45);border-radius:8px;padding:1px 9px;font-size:12px;opacity:.75}
.action:hover{opacity:1;background:rgba(128,128,128,.16)}
.note{opacity:.6;padding-left:4px}
</style>
</head>
<body>
<header><nav>${trail}</nav><h1>${escapeHtml(path)}</h1></header>
<main><ul>${rows.join("")}</ul></main>
</body>
</html>
`;
}

/**
 * Serve one browse request: validate the query, resolve the Session, list one
 * directory, and render the page.
 * @param ctx - host context carrying the filesystem.
 * @param request - the authenticated Fetch request.
 * @returns The HTML response.
 */
export async function browseResponse(ctx, request) {
	const url = new URL(request.url);
	const sessionId = url.searchParams.get("sessionId");
	if (sessionId === null || sessionId === "") return new Response("missing sessionId query parameter", { status: 400 });
	let scope;
	try {
		scope = await resolveScope(ctx, sessionId);
	} catch {
		return new Response("session lookup failed", { status: 500 });
	}
	if (scope === undefined) return new Response("session not found", { status: 404 });
	const chinese = prefersChinese(request.headers.get("accept-language"));
	const labels = chinese ? LABELS.zh : LABELS.en;
	let resolved;
	let children;
	try {
		resolved = await resolveTarget(ctx, scope, url.searchParams.get("path"), request.signal);
		children = await ctx.fs.listDir(resolved.target, request.signal);
	} catch (error) {
		const status = fsStatus(error);
		return new Response(renderBrowseError(labels, browseFailureText(status, labels), chinese), { status, headers: HTML_HEADERS });
	}
	const listing = {
		path: resolved.path,
		entries: children.slice(0, MAX_LIST_ENTRIES).map((entry) => ({
			name: entry.name,
			type: entry.type,
			...(typeof entry.size === "number" ? { size: entry.size } : {})
		})),
		truncated: children.length > MAX_LIST_ENTRIES
	};
	return new Response(renderBrowsePage({ sessionId, listing, chinese }), { status: 200, headers: HTML_HEADERS });
}

/** Copy for one listing failure status. */
function browseFailureText(status, labels) {
	switch (status) {
		case 404: return labels.notFound;
		case 400: return labels.notDirectory;
		case 403: return labels.denied;
		default: return labels.failed;
	}
}

/** Minimal error document for the browse page. */
function renderBrowseError(labels, message, chinese) {
	return `<!doctype html>
<html lang="${chinese ? "zh-Hans" : "en"}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(labels.title)}</title></head>
<body style="font:14px/1.6 system-ui,sans-serif;padding:24px">
<p>${escapeHtml(message)}</p></body></html>
`;
}

/** CRC-32 table and accumulator for ZIP entries. */
const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let index = 0; index < 256; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		table[index] = value;
	}
	return table;
})();

/**
 * CRC-32 of one buffer, the checksum every ZIP entry carries.
 * @param buffer - uncompressed bytes.
 * @returns The unsigned checksum.
 */
export function crc32(buffer) {
	let crc = -1;
	for (let index = 0; index < buffer.byteLength; index += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff];
	return (crc ^ -1) >>> 0;
}

/** MS-DOS packed timestamp, the only clock a base ZIP record carries. */
function dosTimestamp(date) {
	const year = Math.max(1980, date.getFullYear());
	return {
		time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
		date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
	};
}

/** One local file header plus its UTF-8 name. */
function localHeader(entry, stamp) {
	const name = Buffer.from(entry.name, "utf8");
	const header = Buffer.alloc(30);
	header.writeUInt32LE(0x04034b50, 0);
	header.writeUInt16LE(20, 4);
	header.writeUInt16LE(0x0800, 6);
	header.writeUInt16LE(entry.method, 8);
	header.writeUInt16LE(stamp.time, 10);
	header.writeUInt16LE(stamp.date, 12);
	header.writeUInt32LE(entry.crc, 14);
	header.writeUInt32LE(entry.compressedSize, 18);
	header.writeUInt32LE(entry.size, 22);
	header.writeUInt16LE(name.byteLength, 26);
	header.writeUInt16LE(0, 28);
	return Buffer.concat([header, name]);
}

/** One central directory record plus its UTF-8 name. */
function centralHeader(entry, stamp) {
	const name = Buffer.from(entry.name, "utf8");
	const header = Buffer.alloc(46);
	header.writeUInt32LE(0x02014b50, 0);
	header.writeUInt16LE(20, 4);
	header.writeUInt16LE(20, 6);
	header.writeUInt16LE(0x0800, 8);
	header.writeUInt16LE(entry.method, 10);
	header.writeUInt16LE(stamp.time, 12);
	header.writeUInt16LE(stamp.date, 14);
	header.writeUInt32LE(entry.crc, 16);
	header.writeUInt32LE(entry.compressedSize, 20);
	header.writeUInt32LE(entry.size, 24);
	header.writeUInt16LE(name.byteLength, 28);
	header.writeUInt16LE(0, 30);
	header.writeUInt16LE(0, 32);
	header.writeUInt16LE(0, 34);
	header.writeUInt16LE(0, 36);
	header.writeUInt32LE(entry.type === "directory" ? 0x10 : 0, 38);
	header.writeUInt32LE(entry.offset, 42);
	return Buffer.concat([header, name]);
}

/** The end-of-central-directory record closing every base ZIP. */
function endOfCentralDirectory(count, size, offset) {
	const record = Buffer.alloc(22);
	record.writeUInt32LE(0x06054b50, 0);
	record.writeUInt16LE(0, 4);
	record.writeUInt16LE(0, 6);
	record.writeUInt16LE(count, 8);
	record.writeUInt16LE(count, 10);
	record.writeUInt32LE(size, 12);
	record.writeUInt32LE(offset, 16);
	record.writeUInt16LE(0, 20);
	return record;
}

/**
 * Read one file completely into memory, bounded by the archive file cap.
 * @param ctx - host context carrying the filesystem.
 * @param target - resolved file target.
 * @param cap - inclusive byte cap for one archived file.
 * @param signal - request cancellation.
 * @returns The file bytes.
 */
export async function readTargetBuffered(ctx, target, cap, signal) {
	const chunks = [];
	let offset = 0;
	let total = 0;
	for (;;) {
		const bytes = await ctx.fs.readByteRange(target, { offset, length: DEFAULT_WINDOW_BYTES }, signal);
		if (bytes.byteLength === 0) break;
		total += bytes.byteLength;
		if (cap !== undefined && total > cap) throw Object.assign(new Error("file is too large to archive"), { code: "archive/file-too-large" });
		chunks.push(Buffer.from(bytes));
		offset += bytes.byteLength;
	}
	return Buffer.concat(chunks);
}

/**
 * Walk one directory subtree and append every entry the archive will carry.
 * Directories become `name/` records so empty ones survive, and anything that is
 * neither a directory nor a regular file (a symlink, a socket) is skipped rather
 * than followed.
 * @param ctx - host context carrying the filesystem.
 * @param rootTarget - the directory to archive.
 * @param rootName - the folder name entries are nested under inside the archive.
 * @param signal - request cancellation.
 * @param limits - entry and byte caps.
 * @param entries - the array to append to.
 * @param state - shared running byte total.
 */
async function appendTree(ctx, rootTarget, rootName, signal, limits, entries, state) {
	entries.push({ type: "directory", name: `${rootName}/`, target: rootTarget });
	const queue = [{ target: rootTarget, archive: "" }];
	let head = 0;
	while (head < queue.length) {
		const current = queue[head];
		head += 1;
		const children = orderEntries(await ctx.fs.listDir(current.target, signal));
		for (const child of children) {
			if (signal?.aborted) throw new Error("archive aborted");
			const archive = current.archive === "" ? child.name : `${current.archive}/${child.name}`;
			if (child.type === "directory") {
				entries.push({ type: "directory", name: `${rootName}/${archive}/`, target: child.target });
				queue.push({ target: child.target, archive });
			} else if (child.type === "file") {
				entries.push({ type: "file", name: `${rootName}/${archive}`, target: child.target });
				if (typeof child.size === "number") state.bytes += child.size;
			}
			if (entries.length > limits.entries) throw Object.assign(new Error("too many entries"), { code: "archive/too-many-entries" });
			if (state.bytes > limits.bytes) throw Object.assign(new Error("archive too large"), { code: "archive/too-large" });
		}
	}
}

/**
 * Describe one directory subtree for the archive.
 * @param ctx - host context carrying the filesystem.
 * @param rootTarget - the directory to archive.
 * @param signal - request cancellation.
 * @param limits - optional cap overrides, used by tests.
 * @param rootName - the folder name entries nest under; defaults to the target's own name.
 * @returns Archive entries in breadth-first order.
 */
export async function collectArchiveEntries(ctx, rootTarget, signal, limits = {}, rootName = basename(ctx.fs.processPath(rootTarget)) || "workspace") {
	const entries = [];
	await appendTree(ctx, rootTarget, rootName, signal, {
		entries: limits.maxEntries ?? MAX_ARCHIVE_ENTRIES,
		bytes: limits.maxBytes ?? MAX_ARCHIVE_BYTES
	}, entries, { bytes: 0 });
	return entries;
}

/**
 * Stream the archive: one local record per entry, then the central directory and
 * its end record. Only one file is buffered at a time, so archive memory stays
 * bounded by the per-file cap rather than by the tree size.
 * @param ctx - host context carrying the filesystem.
 * @param entries - entries from `collectArchiveEntries` or a selection.
 * @param signal - request cancellation.
 * @returns The response body stream.
 */
export function archiveStream(ctx, entries, signal) {
	const stamp = dosTimestamp(new Date());
	const central = [];
	let offset = 0;
	let index = 0;
	return new ReadableStream({
		async pull(controller) {
			try {
				if (signal?.aborted) throw new Error("archive aborted");
				if (index >= entries.length) {
					const directory = Buffer.concat(central);
					controller.enqueue(new Uint8Array(directory));
					controller.enqueue(new Uint8Array(endOfCentralDirectory(central.length, directory.byteLength, offset)));
					controller.close();
					return;
				}
				const entry = entries[index];
				index += 1;
				if (entry.type === "directory") {
					const record = { ...entry, method: 0, crc: 0, size: 0, compressedSize: 0, offset };
					const header = localHeader(record, stamp);
					offset += header.byteLength;
					central.push(centralHeader(record, stamp));
					controller.enqueue(new Uint8Array(header));
					return;
				}
				const bytes = await readTargetBuffered(ctx, entry.target, MAX_ARCHIVE_FILE_BYTES, signal);
				const compressed = deflateRawSync(bytes);
				const deflated = compressed.byteLength < bytes.byteLength;
				const record = {
					...entry,
					method: deflated ? 8 : 0,
					crc: crc32(bytes),
					size: bytes.byteLength,
					compressedSize: deflated ? compressed.byteLength : bytes.byteLength,
					offset
				};
				const header = localHeader(record, stamp);
				offset += header.byteLength + record.compressedSize;
				central.push(centralHeader(record, stamp));
				controller.enqueue(new Uint8Array(header));
				controller.enqueue(deflated ? new Uint8Array(compressed) : new Uint8Array(bytes));
			} catch (error) {
				controller.error(error);
			}
		}
	});
}

/**
 * Serve one folder archive request: validate the query, resolve the Session and
 * the directory, describe the subtree, then stream it as a ZIP.
 * @param ctx - host context carrying the filesystem.
 * @param request - the authenticated Fetch request.
 * @returns The response to bridge.
 */
export async function archiveResponse(ctx, request) {
	const url = new URL(request.url);
	const sessionId = url.searchParams.get("sessionId");
	if (sessionId === null || sessionId === "") return new Response("missing sessionId query parameter", { status: 400 });
	let scope;
	try {
		scope = await resolveScope(ctx, sessionId);
	} catch {
		return new Response("session lookup failed", { status: 500 });
	}
	if (scope === undefined) return new Response("session not found", { status: 404 });
	let resolved;
	let entries;
	try {
		resolved = await resolveTarget(ctx, scope, url.searchParams.get("path"), request.signal);
		const info = await ctx.fs.stat(resolved.target, request.signal);
		if (info === undefined) return new Response("not found", { status: 404 });
		if (info.type !== "directory") return new Response("not a directory; use the file download route", { status: 400 });
		entries = await collectArchiveEntries(ctx, resolved.target, request.signal);
	} catch (error) {
		return archiveFailure(error);
	}
	const headers = {
		"content-type": "application/zip",
		"content-disposition": contentDisposition(`${basename(resolved.path) || "workspace"}.zip`),
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	};
	if (request.method === "HEAD") return new Response(null, { status: 200, headers });
	return new Response(archiveStream(ctx, entries, request.signal), { status: 200, headers });
}

/**
 * Read a selection archive payload from either JSON or a plain HTML form.
 *
 * The browser normally submits a form POST, because a form navigation hands the
 * streamed ZIP straight to the browser's download manager instead of buffering a
 * whole archive in page memory; the JSON arm keeps the route usable from a
 * script or a test.
 * @param request - the authenticated Fetch request.
 * @returns The decoded payload.
 */
async function readSelectionPayload(request) {
	const type = request.headers.get("content-type") ?? "";
	if (type.includes("application/x-www-form-urlencoded")) {
		const encoded = new URLSearchParams(await request.text()).get("payload");
		return encoded === null ? undefined : JSON.parse(encoded);
	}
	return await request.json();
}

/**
 * Serve one multi-select archive: a JSON body names files and/or directories and
 * the answer is a single ZIP of all of them.
 * @param ctx - host context carrying the filesystem.
 * @param request - the authenticated Fetch request with a buffered JSON body.
 * @returns The response to bridge.
 */
export async function archiveSelectionResponse(ctx, request) {
	let payload;
	try {
		payload = await readSelectionPayload(request);
	} catch {
		return new Response("invalid request body", { status: 400 });
	}
	const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
	const paths = Array.isArray(payload?.paths) ? payload.paths.filter((path) => typeof path === "string" && path !== "") : [];
	if (sessionId === "" || paths.length === 0) return new Response("missing sessionId or paths", { status: 400 });
	if (paths.length > MAX_ARCHIVE_SELECTION) return new Response("too many selected paths", { status: 413 });
	let scope;
	try {
		scope = await resolveScope(ctx, sessionId);
	} catch {
		return new Response("session lookup failed", { status: 500 });
	}
	if (scope === undefined) return new Response("session not found", { status: 404 });
	const limits = { entries: MAX_ARCHIVE_ENTRIES, bytes: MAX_ARCHIVE_BYTES };
	const state = { bytes: 0 };
	const entries = [];
	try {
		for (const path of paths) {
			const resolved = await resolveTarget(ctx, scope, path, request.signal);
			const info = await ctx.fs.stat(resolved.target, request.signal);
			if (info === undefined) continue;
			const name = basename(resolved.path) || "item";
			if (info.type === "directory") await appendTree(ctx, resolved.target, name, request.signal, limits, entries, state);
			else if (info.type === "file") {
				entries.push({ type: "file", name, target: resolved.target });
				if (typeof info.size === "number") state.bytes += info.size;
			}
			if (entries.length > limits.entries) throw Object.assign(new Error("too many entries"), { code: "archive/too-many-entries" });
			if (state.bytes > limits.bytes) throw Object.assign(new Error("archive too large"), { code: "archive/too-large" });
		}
	} catch (error) {
		return archiveFailure(error);
	}
	if (entries.length === 0) return new Response("nothing to archive", { status: 404 });
	const filename = paths.length === 1 ? `${basename(paths[0]) || "selection"}.zip` : "selection.zip";
	const headers = {
		"content-type": "application/zip",
		"content-disposition": contentDisposition(filename),
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	};
	return new Response(archiveStream(ctx, entries, request.signal), { status: 200, headers });
}

/**
 * Map one archive failure onto an HTTP status.
 * @param error - thrown value from the filesystem or the walk.
 * @returns A short, non-leaking response.
 */
export function archiveFailure(error) {
	switch (error?.code) {
		case "FS_NOT_FOUND": return new Response("directory not found", { status: 404 });
		case "FS_NOT_DIRECTORY": return new Response("not a directory; use the file download route", { status: 400 });
		case "FS_PERMISSION_DENIED":
		case "FS_SANDBOX_DENIED": return new Response("permission denied", { status: 403 });
		case "archive/too-many-entries": return new Response("directory has too many entries to archive", { status: 413 });
		case "archive/too-large": return new Response("directory is too large to archive", { status: 413 });
		case "archive/file-too-large": return new Response("a file in that directory is too large to archive", { status: 413 });
		default: return new Response("archive failed", { status: 500 });
	}
}

/** Join one file name onto an absolute directory path. */
export function joinPath(directory, name) {
	const base = String(directory).replace(/[\\/]+$/u, "");
	return base === "" ? `/${name}` : `${base}/${name}`;
}

/**
 * Decode one body as UTF-8 text.
 * @param bytes - the raw upload body.
 * @returns The text, or undefined when the bytes are not valid UTF-8.
 */
export function decodeUtf8(bytes) {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

/**
 * Write one uploaded body under the effective mode.
 *
 * Text takes the composed filesystem's `writeText`, which is atomic and honours
 * the per-call sandbox policy, so the backend fences it as well as this plugin.
 * The filesystem contract has no byte-write, so a binary body is written next to
 * its target through a temp file and a rename; that arm is correct exactly when
 * the backend's execution world is this host, which the local provider is.
 * @param ctx - host context carrying the filesystem.
 * @param scope - resolved Session scope.
 * @param mode - effective access mode.
 * @param target - resolved target for the new file.
 * @param bytes - the upload body.
 * @param overwrite - whether an existing file may be replaced.
 * @param signal - request cancellation.
 * @returns `{ path, encoding }` for the written file.
 */
export async function writeUpload(ctx, scope, mode, target, bytes, overwrite, signal) {
	const text = decodeUtf8(bytes);
	if (text !== undefined && !text.includes("\0")) {
		const intent = overwrite ? undefined : { kind: "createIfAbsent" };
		await ctx.fs.writeText(target, text, intent, signal, { mode, workspaceRoot: scope.workspaceRoot, sessionId: scope.sessionId });
		return { path: ctx.fs.processPath(target), encoding: "utf-8" };
	}
	const local = ctx.fs.processPath(target);
	if (overwrite) {
		const temporary = join(dirname(local), `.dsh-upload-${randomUUID()}.part`);
		await writeFile(temporary, bytes);
		try {
			await rename(temporary, local);
		} catch (error) {
			await unlink(temporary).catch(() => {});
			throw error;
		}
	} else {
		await writeFile(local, bytes, { flag: "wx" });
	}
	return { path: local, encoding: "binary" };
}

/**
 * Map one upload failure onto an HTTP status and a machine-readable body.
 * @param error - thrown value from the filesystem or the local write.
 * @returns The refusal response.
 */
export function uploadFailure(error) {
	switch (error?.code) {
		case "FS_NOT_FOUND":
		case "ENOENT": return Response.json({ error: "directory not found" }, { status: 404 });
		case "EEXIST":
		case "FS_NOT_OBSERVED":
		case "FS_STALE_VERSION": return Response.json({ error: "file already exists", exists: true }, { status: 409 });
		case "EACCES":
		case "EPERM":
		case "FS_PERMISSION_DENIED":
		case "FS_SANDBOX_DENIED": return Response.json({ error: "permission denied" }, { status: 403 });
		case "EISDIR":
		case "ENOTDIR":
		case "FS_NOT_REGULAR_FILE":
		case "FS_NOT_DIRECTORY": return Response.json({ error: "not a regular file target" }, { status: 400 });
		case "FS_TOO_LARGE": return Response.json({ error: "too large" }, { status: 413 });
		default: return Response.json({ error: "upload failed" }, { status: 500 });
	}
}

/**
 * Serve one upload: validate the query and the name, enforce the access mode,
 * then write the body into the named directory.
 * @param ctx - host context carrying the filesystem.
 * @param request - the authenticated Fetch request whose body is the file bytes.
 * @returns A JSON response naming the written path and its size.
 */
export async function uploadResponse(ctx, request) {
	const url = new URL(request.url);
	const sessionId = url.searchParams.get("sessionId");
	const directory = url.searchParams.get("path");
	const name = url.searchParams.get("name");
	if (sessionId === null || sessionId === "") return Response.json({ error: "missing sessionId" }, { status: 400 });
	if (name === null || name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
		return Response.json({ error: "invalid file name" }, { status: 400 });
	}
	const requestedMode = parseSandboxMode(url.searchParams.get("mode"));
	if (requestedMode === null) return Response.json({ error: "unknown mode" }, { status: 400 });
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) return Response.json({ error: "upload too large" }, { status: 413 });
	const overwrite = url.searchParams.get("overwrite") === "1";
	let scope;
	try {
		scope = await resolveScope(ctx, sessionId);
	} catch {
		return Response.json({ error: "session lookup failed" }, { status: 500 });
	}
	if (scope === undefined) return Response.json({ error: "session not found" }, { status: 404 });
	const mode = requestedMode ?? sessionSandboxMode(ctx, sessionId);
	if (mode === "read-only") return Response.json({ error: "uploads are disabled in read-only mode" }, { status: 403 });
	let target;
	try {
		const resolved = await resolveTarget(ctx, scope, directory, request.signal);
		const info = await ctx.fs.stat(resolved.target, request.signal);
		if (info === undefined) return Response.json({ error: "directory not found" }, { status: 404 });
		if (info.type !== "directory") return Response.json({ error: "target is not a directory" }, { status: 400 });
		const refused = await modeGate(ctx, scope, mode, resolved.target, request.signal);
		if (refused !== undefined) return Response.json({ error: "outside the workspace for workspace-write mode" }, { status: 403 });
		target = await ctx.fs.resolve(joinPath(resolved.path, name), { cwd: scope.workspaceRoot, signal: request.signal });
	} catch (error) {
		return uploadFailure(error);
	}
	let body;
	try {
		body = new Uint8Array(await request.arrayBuffer());
	} catch {
		return Response.json({ error: "could not read the request body" }, { status: 400 });
	}
	if (body.byteLength > MAX_UPLOAD_BYTES) return Response.json({ error: "upload too large" }, { status: 413 });
	try {
		const written = await writeUpload(ctx, scope, mode, target, body, overwrite, request.signal);
		return Response.json({ path: written.path, bytes: body.byteLength, encoding: written.encoding, overwritten: overwrite }, { headers: { "cache-control": "no-store" } });
	} catch (error) {
		return uploadFailure(error);
	}
}

/**
 * Register the authenticated list, download, browse, archive, and upload routes
 * for this plugin's lifetime.
 * @param ctx - host context carrying Connection.
 */
export function apply(ctx) {
	ctx.effect(() => ctx.connection.fetch.register({
		path: LIST_PATH,
		methods: ["GET"],
		requestBody: "buffered",
		fetch: (request) => listResponse(ctx, request)
	}), "file-download: list route");
	ctx.effect(() => ctx.connection.fetch.register({
		path: DOWNLOAD_PATH,
		methods: ["GET", "HEAD"],
		requestBody: "buffered",
		fetch: (request) => downloadResponse(ctx, request)
	}), "file-download: download route");
	ctx.effect(() => ctx.connection.fetch.register({
		path: BROWSE_PATH,
		methods: ["GET"],
		requestBody: "buffered",
		fetch: (request) => browseResponse(ctx, request)
	}), "file-download: browse route");
	ctx.effect(() => ctx.connection.fetch.register({
		path: UPLOAD_PATH,
		methods: ["POST"],
		requestBody: "buffered",
		fetch: (request) => uploadResponse(ctx, request)
	}), "file-download: upload route");
	ctx.effect(() => ctx.connection.fetch.register({
		path: ARCHIVE_PATH,
		methods: ["GET", "HEAD", "POST"],
		requestBody: "buffered",
		fetch: (request) => (request.method === "POST" ? archiveSelectionResponse(ctx, request) : archiveResponse(ctx, request))
	}), "file-download: archive route");
}
