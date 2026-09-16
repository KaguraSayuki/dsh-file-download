/**
 * Repository hygiene guard.
 *
 * Public history is hard to rewrite once pushed, so every tracked file is
 * scanned for the leak classes that are easy to miss in review: absolute home
 * directories, private-network addresses, mail addresses, and common credential
 * shapes. The test skips itself and runs only over tracked files, so local
 * scratch files never fail the suite.
 *
 * Run: node --test tests/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "tests/hygiene.test.mjs";

const RULES = [
	["absolute home directory", /(?:\/home\/|\/Users\/|\/root\/)[A-Za-z0-9._-]+\//u],
	["private IPv4 address", /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/u],
	["mail address", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/u],
	["credential shape", /\b(?:sk-[A-Za-z0-9]{16,}|gh[po]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/u]
];

function trackedFiles() {
	try {
		return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
			.split("\n")
			.filter((entry) => entry !== "");
	} catch {
		return undefined;
	}
}

const files = trackedFiles();

test("tracked files carry no home paths, private addresses, mail, or credentials", { skip: files === undefined ? "not a git checkout" : false }, () => {
	const offenders = [];
	for (const file of files) {
		if (file === SELF) continue;
		let text;
		try {
			text = readFileSync(join(root, file), "utf8");
		} catch {
			continue;
		}
		if (text.includes("\u0000")) continue;
		for (const [label, pattern] of RULES) {
			const match = text.match(pattern);
			if (match !== null) offenders.push(`${file}: ${label} — ${match[0]}`);
		}
	}
	assert.deepEqual(offenders, [], `hygiene violations:\n${offenders.join("\n")}`);
});
