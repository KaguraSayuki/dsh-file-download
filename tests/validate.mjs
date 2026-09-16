/**
 * Static validation: the wiring a boot cannot be bothered to explain.
 *
 * Asserts, without starting DSH, that
 *   1. the package manifest declares a web bundle patch and a browser half;
 *   2. the bundle patch mounts exactly one dual-face row;
 *   3. the browser half is a `__ModuleLoader__.load` bundle whose id matches the
 *      row, that exports `apply`/`inject`, and that knows the official hook
 *      names it decorates;
 *   4. the host half carries the exact route contract the browser half calls;
 *   5. the license is MIT.
 *
 * Run: node tests/validate.mjs
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const patch = await readFile(join(root, "cordis.patch.yml"), "utf8");
const host = await readFile(join(root, "lib/index.js"), "utf8");
const client = await readFile(join(root, "lib/client.js"), "utf8");
const license = await readFile(join(root, "LICENSE"), "utf8");

let failed = 0;
const check = (label, ok) => {
	console.log(`${ok ? "\u2713" : "\u2717"} ${label}`);
	if (!ok) failed += 1;
};

check("package is an ES module", pkg.type === "module");
check("package is MIT", pkg.license === "MIT");
check("LICENSE carries the MIT grant", /MIT License/u.test(license) && /WITHOUT WARRANTY/u.test(license));
check("manifest declares dsh.bundle.patch", pkg.dsh?.bundle?.patch === "./cordis.patch.yml");
check("manifest declares a web browser half", pkg.dsh?.client?.platform === "web");
check("bundle patch file exists", existsSync(join(root, pkg.dsh?.bundle?.patch ?? "missing")));
check("exports the host half", pkg.exports?.["."] === "./lib/index.js");
check("exports the browser half", pkg.exports?.["./client"] === "./lib/client.js");

check("patch mounts one row", (patch.match(/^\s+- id:/gmu) ?? []).length === 1);
check("patch row id is file-download", /-\s+id:\s*file-download\b/u.test(patch));
check("patch row name matches the package", /name:\s*'dsh-file-download'/u.test(patch));

check("browser half registers through the module loader", client.includes("window.__ModuleLoader__.load({"));
check("browser half id matches the row name", client.includes('id: "dsh-file-download"'));
check("browser half exports apply", client.includes("exports.apply = apply"));
check("browser half exports inject", client.includes("exports.inject = inject"));
check(
	"browser half injects only services the client plane provides",
	/exports\.inject = inject/u.test(client) && ["slots", "locale", "sessions", "sidebarRightTabs"].every((name) => client.includes(`"${name}"`))
);
check("browser half registers a Sidebar tab type", client.includes("ctx.sidebarRightTabs.register("));
check("browser half registers the tab body and its chip title", client.includes('"sidebar.right.pane.tab"') && client.includes('"sidebar.right.pane.tab.title"'));
check("browser half opens files through the official preview", client.includes("tab.actions.openResource(sessionFileAddress("));
check("browser half archives a selection through a form", client.includes("submitSelectionArchive("));
check("browser half offers preview, download, and folder ZIP actions", client.includes('t("open")') && client.includes('t("download")') && client.includes('t("zip")'));
check("browser half uses the official turn-tail chain", client.includes('ctx.slots.inject("conversation.chat.turnTail"'));
check("browser half decorates delivered-file cards", client.includes('"[data-presented-file]"'));
check("browser half decorates file-tree rows", client.includes('li[data-files-entry][data-files-path]'));
check("browser half archives directory rows", client.includes("saveArchive(currentSession(), path)"));
check("browser half links the browse page", client.includes("openBrowse(sessionId)"));
check("host half exposes the browse page", host.includes('export const BROWSE_PATH = "/api/workspace.download/browse"'));
check("host half exposes the folder archive route", host.includes('export const ARCHIVE_PATH = "/api/workspace.download/archive"'));
check("host half builds base ZIP records", host.includes("0x04034b50") && host.includes("0x06054b50"));
check("host half escapes the rendered page", host.includes("export function escapeHtml"));
check("host half sends a content security policy", host.includes("content-security-policy"));
check("browser half reads the official deliverables turn data", client.includes('get?.("deliverables")'));
check("browser half calls the host route", client.includes('const DOWNLOAD_PATH = "/api/workspace.download"'));
check("browser half re-applies decorations after re-render", client.includes("new MutationObserver(decorate)"));

check("host half exports the route path", host.includes('export const DOWNLOAD_PATH = "/api/workspace.download"'));
check("host half registers GET and HEAD", host.includes('methods: ["GET", "HEAD"]'));
check("host half streams instead of buffering", host.includes("new ReadableStream({"));
check("host half answers with an attachment disposition", host.includes("content-disposition"));
check("host half injects the filesystem service", host.includes('export const inject = ["connection", "fs"]'));
check("host half lists and reads through ctx.fs", host.includes("ctx.fs.listDir(") && host.includes("ctx.fs.readByteRange(") && host.includes("ctx.fs.resolve("));
check("host half exposes the JSON list route", host.includes('export const LIST_PATH = "/api/workspace.download/list"'));
check("host half accepts a form-encoded selection", host.includes("application/x-www-form-urlencoded"));
check("host half archives a multi-selection", host.includes("export async function archiveSelectionResponse"));
check("host half exposes the upload route", host.includes('export const UPLOAD_PATH = "/api/workspace.download/upload"'));
check("host half knows the three access modes", host.includes('export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"]'));
check("host half gates uploads by mode", host.includes("async function modeGate") && host.includes("uploads are disabled in read-only mode"));
check("host half defaults to the Session mode", host.includes("export function sessionSandboxMode"));
check("host half refuses to clobber without the flag", host.includes('kind: "createIfAbsent"') && host.includes('flag: "wx"'));
check("browser half has a mode selector", client.includes('t(`mode.${value}`)') && client.includes("modeStorageKey("));
check("browser half uploads files with the mode", client.includes("uploadFiles") && client.includes("uploadUrl(sessionId, displayPath, file.name, effectiveMode"));
check("browser half asks before overwriting", client.includes("upload.overwrite"));
check("browser half resolves a typed relative path", client.includes("function resolveDraft(") && client.includes("function isAbsolutePath("));
check("browser half completes a typed path", client.includes("function splitDraft(") && client.includes("dsh-fb-suggest"));
check("host half expands a leading tilde", host.includes("export function expandHome("));
check("host half can resume a download", host.includes("export function parseRange(") && host.includes('"accept-ranges"') && host.includes("content-range"));
check("host half streams archive entries", host.includes("export async function* archiveChunks(") && host.includes("function dataDescriptor("));
check("host half stores already-compressed formats", host.includes("const STORED_EXTENSIONS") && host.includes("export function zipMethodFor("));
check("host half measures compressibility instead of guessing", host.includes("deflateRawSync(sample, { level: 1 })"));
check("host half never buffers a whole archive entry", !host.includes("readTargetBuffered"));
check("host half compresses at the ordinary default level", host.includes("const ZIP_LEVEL = 6;"));
check("host half resolves cold Sessions too", host.includes('ctx.get("sessionPersistence")'));

check("browser half declares no build-time import beyond platform seeds", !/require\("(?!react|react\/jsx-runtime")/u.test(client));

console.log("");
if (failed > 0) {
	console.error(`${failed} check(s) failed`);
	process.exit(1);
}
console.log("all static checks passed");
