// One owner per physical working tree, including separate CLI processes.
// Outside .pipeline so git clean cannot remove a live lock. Never steal a
// stale lock automatically: a surviving child may still be writing the tree.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { gitText } from "../util/exec.mjs";

export function runLockPath(root) {
	let canonical = realpathSync.native(resolve(root));
	if (process.platform === "win32") canonical = canonical.toLowerCase();
	const gitdir = gitText(root, ["rev-parse", "--absolute-git-dir"]);
	return gitdir ? join(gitdir, "pipeline-run.lock") : join(homedir(), ".pi-pipeline-locks", `${createHash("sha256").update(canonical).digest("hex")}.lock`);
}

export function acquireRunLock(root) {
	let canonical = realpathSync.native(resolve(root));
	if (process.platform === "win32") canonical = canonical.toLowerCase();
	const path = runLockPath(root);
	mkdirSync(resolve(path, ".."), { recursive: true });
	const token = JSON.stringify({ pid: process.pid, root: canonical, token: randomUUID() });
	let fd;
	try { fd = openSync(path, "wx", 0o600); }
	catch (error) {
		if (error.code !== "EEXIST") throw error;
		throw Object.assign(new Error(`working tree is locked: ${path}. Stop all pipeline processes before removing a stale lock.`), { code: "PIPELINE_CONTROL" });
	}
	try { writeFileSync(fd, token); } finally { closeSync(fd); }
	return () => {
		try { if (readFileSync(path, "utf8") === token) unlinkSync(path); }
		catch (error) { if (error.code !== "ENOENT") throw error; }
	};
}
