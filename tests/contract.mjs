/**
 * Contract test against the DSH install this profile actually runs.
 *
 * The plugin works by composing official seams: Connection's exact Fetch route
 * table, the `workspaceFiles` service, the `conversation.chat.turnTail` chain
 * slot, the client-plane `sessions`/`slots`/`locale` services, and three
 * published `data-*` DOM hooks. DSH is a moving target, so every one of those is
 * re-checked here before an upgrade is trusted.
 *
 * When no DSH install can be found the test skips successfully, so CI does not
 * need one. Point `DSH_MODULES` at a `node_modules` root to check a specific
 * install.
 *
 * Run: node tests/contract.mjs
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDsh, resolveFrom } from "./resolve-dsh.mjs";

const dsh = resolveDsh();
if (dsh === undefined) {
	console.log("skip: no DSH install found; set DSH_MODULES to a node_modules root to run this test");
	process.exit(0);
}
console.log(`DSH ${dsh.version}  (${dsh.source})`);
for (const other of dsh.others) console.log(`  other install: ${other}`);
console.log("");

const { modules } = dsh;

/** Read a package's browser or host bundle, tolerating either exports layout. */
function packageFile(name, leaf) {
	for (const candidate of [`${name}/${leaf === "client" ? "client" : leaf}`, `${name}/package.json`]) {
		try {
			const resolved = resolveFrom(modules, candidate);
			if (candidate.endsWith("/package.json")) return readFileSync(join(dirname(resolved), "lib", `${leaf}.js`), "utf8");
			return readFileSync(resolved, "utf8");
		} catch {
			// try the next shape
		}
	}
	throw new Error(`cannot resolve ${name}`);
}

/** The single built frontend bundle, whose module table is the boot seed set. */
function frontendBundle() {
	const dist = join(dirname(resolveFrom(modules, "@deepseek-ai/dsh-web-frontend/package.json")), "dist", "assets");
	const bundle = readdirSync(dist).find((entry) => entry.startsWith("index-") && entry.endsWith(".js"));
	if (bundle === undefined) throw new Error("no frontend index bundle");
	return readFileSync(join(dist, bundle), "utf8");
}

let failed = 0;
const check = (label, ok) => {
	console.log(`${ok ? "\u2713" : "\u2717"} ${label}`);
	if (!ok) failed += 1;
};

const connection = readFileSync(resolveFrom(modules, "@deepseek-ai/dsh-client-connection"), "utf8");
check("Connection still owns an exact Fetch route table", connection.includes("register(route") && connection.includes("requestBody"));
const sessionExport = readFileSync(resolveFrom(modules, "@deepseek-ai/dsh-session-log-export"), "utf8");
check("a shipped consumer still calls connection.fetch.register", sessionExport.includes(".fetch.register({"));

const fsRoot = dirname(resolveFrom(modules, "@deepseek-ai/dsh-fs"));
const fsPackage = readFileSync(resolveFrom(modules, "@deepseek-ai/dsh-fs"), "utf8");
const fsTypes = readFileSync(join(fsRoot, "types", "index.d.ts"), "utf8");
const fsValueTypes = readFileSync(join(fsRoot, "types", "types.d.ts"), "utf8");
const localFs = readFileSync(resolveFrom(modules, "@deepseek-ai/dsh-fs-local"), "utf8");
check("the filesystem service is still called fs", fsPackage.includes('super(ctx, "fs")'));
check("the filesystem contract still resolves paths", fsTypes.includes("resolve(path: string, opts?"));
check("the filesystem contract still stats targets", fsTypes.includes("stat(target: FsTarget, signal?"));
check("the filesystem contract still lists directories", fsTypes.includes("listDir(target: FsTarget, signal?"));
check("the filesystem contract still reads byte ranges", fsTypes.includes("readByteRange(target: FsTarget, range:"));
check("the filesystem contract still reports FS_NOT_FOUND", fsValueTypes.includes("FS_NOT_FOUND"));
check("the local backend still implements listDir", localFs.includes("async listDir(target, signal)"));
check("directory entries still carry a resolved target", fsValueTypes.includes("target: FsTarget"));

const sidebarRight = packageFile("@deepseek-ai/dsh-client-ui-sidebar-right", "client");
check("the sidebar right still provides sidebarRightTabs", sidebarRight.includes('provide("sidebarRightTabs"'));
check("the sidebar right still registers tab types", sidebarRight.includes("register(definition)") || sidebarRight.includes("register(definition:"));
check("the tab body seat is still a keyed slot", /"sidebar\.right\.pane\.tab":\s*\{\s*kind:\s*"keyed"/u.test(sidebarRight));
check("the tab title seat still exists", sidebarRight.includes('"sidebar.right.pane.tab.title"'));

const chat = packageFile("@deepseek-ai/dsh-client-ui-chat", "client");
check("conversation.chat.turnTail is still a chain slot", /"conversation\.chat\.turnTail":\s*\{\s*kind:\s*"chain"/u.test(chat));
const deliverables = packageFile("@deepseek-ai/dsh-client-ui-deliverables", "client");
check("deliverables still publishes the turn data key", deliverables.includes('key: "deliverables"'));
check("delivered-file cards still carry data-presented-file", deliverables.includes('"data-presented-file"'));
check("delivered-file cards still carry the menu anchor", deliverables.includes('"aria-haspopup"'));
check("produced files still carry the row hook", deliverables.includes('"data-produced-files-row"'));
const sidebarFiles = packageFile("@deepseek-ai/dsh-client-ui-sidebar-files", "client");
check("file-tree rows still carry data-files-entry", sidebarFiles.includes('"data-files-entry"'));
check("file-tree rows still carry data-files-path", sidebarFiles.includes('"data-files-path"'));

const renderer = packageFile("@deepseek-ai/dsh-client-ui-renderer", "client");
check("the slots service is still provided", renderer.includes('super(ctx, "slots")'));
const sessionController = packageFile("@deepseek-ai/dsh-api-session-controller", "client");
check("the client sessions service is still provided", sessionController.includes('provide("sessions"'));
check("the session list still exposes a current id", sessionController.includes("current: void 0"));
const locale = packageFile("@deepseek-ai/dsh-client-locale", "client");
check("the locale service still registers namespaces", locale.includes("register(") && locale.includes("bind("));

const frontend = frontendBundle();
check("the module table still seeds react/jsx-runtime", frontend.includes('"react/jsx-runtime"'));
check("the module table still seeds react", frontend.includes('"react":'));
check("the module table still seeds the slots module", frontend.includes('"@deepseek-ai/dsh-client-ui-slots"'));

console.log("");
if (failed > 0) {
	console.error(`${failed} contract check(s) failed — an upstream hook this plugin relies on changed`);
	process.exit(1);
}
console.log("all contract checks passed");
