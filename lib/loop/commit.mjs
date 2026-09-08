// Commit captured normalized blobs, plus the engine's issue-source update.
// Neither filters nor hooks may extend reviewed implementation at approval.
import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readDiffPaths } from "../diff/capture.mjs";
import { indexEntries, putEntries, withIndex } from "../diff/index.mjs";
import { gitText } from "../util/exec.mjs";

export function commitApproved({ root, issueId, issueLine, pathsFile, issueRel, stderr, reviewed = null }) {
	const paths = readDiffPaths(pathsFile);
	if (!reviewed && paths.length) {
		try { reviewed = JSON.parse(readFileSync(pathsFile.replace(/\.paths$/, ".entries.json"), "utf8")); }
		catch { return { committed: false, reason: "missing reviewed blob manifest" }; }
	}
	const head = gitText(root, ["rev-parse", "HEAD"]);
	if (reviewed && reviewed.baseHead !== head) return { committed: false, reason: "HEAD changed since review capture" };
	const entries = reviewed?.entries ?? [];
	if (paths.some((p) => !entries.some((e) => e.path === p)) || entries.some((e) => !paths.includes(e.path))) return { committed: false, reason: "reviewed path manifest differs" };
	const index = resolve(root, gitText(root, ["rev-parse", "--git-path", "index"]));
	const lock = index + ".lock";
	let fd;
	try {
		// Reserve the real index throughout approval; preserve unrelated staging.
		fd = openSync(lock, "wx");
		return withIndex(root, ({ command, index: scratch }) => {
			command(["read-tree", head]);
			putEntries(command, entries);
			if (issueRel && existsSync(join(root, issueRel))) command(["add", "--", ":(literal)" + issueRel]);
			const selectedPaths = [...new Set([...paths, ...(issueRel ? [issueRel] : [])])];
			if (!selectedPaths.length) return { committed: false, reason: "nothing to commit" };
			const all = indexEntries(command(["ls-files", "--stage", "-z"]));
			const selected = selectedPaths.map((p) => all.find((e) => e.path === p) ?? { path: p, mode: "0", oid: "0".repeat(head.length) });
			// Build the user's replacement index before moving HEAD. A failed
			// signing/commit leaves both the real index and HEAD untouched.
			const commitIndex = readFileSync(scratch);
			if (existsSync(index)) copyFileSync(index, scratch);
			else command(["read-tree", head]);
			putEntries(command, selected);
			const replacement = readFileSync(scratch);
			writeFileSync(scratch, commitIndex);
			const ident = [];
			if (!gitText(root, ["config", "user.email"])) {
				ident.push("-c", "user.name=auto-develop", "-c", "user.email=auto-develop@localhost");
				stderr.write("note: no git identity configured; committing as auto-develop <auto-develop@localhost>\n");
			}
			if (gitText(root, ["rev-parse", "HEAD"]) !== head) throw new Error("HEAD changed before approval commit");
			command([...ident, "commit", "-q", "-m", "pipeline: " + issueLine]);
			writeFileSync(fd, replacement); fsyncSync(fd); closeSync(fd); fd = undefined;
			renameSync(lock, index);
			const sha = gitText(root, ["rev-parse", "--short", "HEAD"]);
			stderr.write("committed " + sha + ": " + issueId + "\n");
			return { committed: true, sha };
		});
	} catch (error) {
		stderr.write(error.message + "\n");
		return { committed: false, reason: error.message };
	} finally {
		if (fd !== undefined) { closeSync(fd); rmSync(lock, { force: true }); }
	}
}
