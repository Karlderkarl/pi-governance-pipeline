// An isolated Git index pins the normalized blobs, without changing the user's
// index. Filters run during capture, never again on reviewed implementation.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../util/exec.mjs";

export function withIndex(root, action) {
	const dir = mkdtempSync(join(tmpdir(), "pipeline-index-"));
	const index = join(dir, "index");
	const hooks = join(dir, "hooks");
	mkdirSync(hooks);
	const env = { ...process.env, GIT_INDEX_FILE: index };
	const command = (args, input = null) => {
		const r = git(root, ["-c", `core.hooksPath=${hooks}`, ...args], { env, input });
		if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString().trim()}`);
		return r.stdout;
	};
	try { return action({ command, index, dir }); }
	finally { rmSync(dir, { recursive: true, force: true }); }
}

export function indexEntries(raw) {
	return raw.toString("utf8").split("\0").filter(Boolean).map((line) => {
		const tab = line.indexOf("\t");
		const [mode, oid, stage] = line.slice(0, tab).split(" ");
		if (stage !== "0") throw new Error("unmerged index cannot be reviewed");
		return { path: line.slice(tab + 1), mode, oid };
	});
}

export function putEntries(command, entries) {
	if (!entries.length) return;
	command(["update-index", "-z", "--index-info"], Buffer.from(entries.map((e) => `${e.mode} ${e.oid}\t${e.path}\0`).join("")));
}
