/**
 * Resolve the module root of the DSH install this machine actually runs.
 *
 * DSH ships as a normal npm distribution, and `npx @deepseek-ai/dsh@<tag>` puts
 * every version in its own `~/.npm/_npx/<hash>/node_modules`, so a hardcoded
 * cache path silently keeps testing a stale release. The contract test only
 * needs to find whatever the profile runs.
 *
 * Resolution order:
 *   1. `DSH_MODULES` — explicit override, always wins.
 *   2. every `~/.npm/_npx/<hash>/node_modules` holding `@deepseek-ai/dsh`,
 *      newest manifest first (the cache npx materialized last).
 *   3. the global `npm root -g`.
 *
 * @module tests/resolve-dsh
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const DSH = "@deepseek-ai/dsh";

function manifestOf(modules) {
	const path = join(modules, DSH, "package.json");
	if (!existsSync(path)) return null;
	try {
		return {
			modules,
			version: JSON.parse(readFileSync(path, "utf8")).version,
			path,
			mtime: statSync(path).mtimeMs
		};
	} catch {
		return null;
	}
}

function npxCandidates() {
	const root = join(homedir(), ".npm", "_npx");
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(root, entry.name, "node_modules"))
		.map(manifestOf)
		.filter(Boolean);
}

function globalCandidates() {
	try {
		const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		const manifest = manifestOf(root);
		return manifest ? [manifest] : [];
	} catch {
		return [];
	}
}

/**
 * Find the newest DSH install on this machine.
 * @returns `{ modules, version, source, others }`, or undefined when none exists.
 */
export function resolveDsh() {
	const override = process.env.DSH_MODULES ?? process.env.DSH_NPX_MODULES;
	if (override) {
		const manifest = manifestOf(override);
		if (!manifest) throw new Error(`DSH_MODULES=${override} has no ${DSH}`);
		return { ...manifest, source: "DSH_MODULES", others: [] };
	}
	const candidates = [...npxCandidates(), ...globalCandidates()];
	if (candidates.length === 0) return undefined;
	candidates.sort((left, right) => right.mtime - left.mtime);
	const [chosen, ...rest] = candidates;
	return { ...chosen, source: "newest npx cache", others: rest.map((entry) => `${entry.version}  ${entry.modules}`) };
}

/**
 * Resolve one specifier from inside the chosen DSH install.
 * @param modules - node_modules root of the install.
 * @param specifier - package or subpath to resolve.
 * @returns The resolved absolute file path.
 */
export function resolveFrom(modules, specifier) {
	return createRequire(join(modules, "_.js")).resolve(specifier);
}
