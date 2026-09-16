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
	/exports\.inject = inject/u.test(client) && ["slots", "locale", "sessions"].every((name) => client.includes(`"${name}"`))
);
check("browser half uses the official turn-tail chain", client.includes('ctx.slots.inject("conversation.chat.turnTail"'));
check("browser half decorates delivered-file cards", client.includes('"[data-presented-file]"'));
check("browser half decorates file-tree rows", client.includes('li[data-files-entry="file"][data-files-path]'));
check("browser half reads the official deliverables turn data", client.includes('get?.("deliverables")'));
check("browser half calls the host route", client.includes('const DOWNLOAD_PATH = "/api/workspace.download"'));
check("browser half re-applies decorations after re-render", client.includes("new MutationObserver(decorate)"));

check("host half exports the route path", host.includes('export const DOWNLOAD_PATH = "/api/workspace.download"'));
check("host half registers GET and HEAD", host.includes('methods: ["GET", "HEAD"]'));
check("host half streams instead of buffering", host.includes("new ReadableStream({"));
check("host half answers with an attachment disposition", host.includes("content-disposition"));
check("host half reads through workspaceFiles", host.includes('ctx.get("workspaceFiles")'));
check("host half resolves cold Sessions too", host.includes('ctx.get("sessionPersistence")'));

check("browser half declares no build-time import beyond platform seeds", !/require\("(?!react|react\/jsx-runtime")/u.test(client));

console.log("");
if (failed > 0) {
	console.error(`${failed} check(s) failed`);
	process.exit(1);
}
console.log("all static checks passed");
