// Commit captured normalized blobs, plus the engine's issue-source update.
// Neither filters nor hooks may extend reviewed implementation at approval.
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readDiffPaths } from "../diff/capture.mjs";
import { indexEntries, putEntries, withIndex } from "../diff/index.mjs";
import { gitText } from "../util/exec.mjs";
import { preservePaths } from "../integrity/governance-paths.mjs";
import { controlPaths } from "../integrity/control.mjs";
import { guardGitOperation } from "../integrity/git-operation.mjs";

export function commitApproved({ root, issueId, issueLine, pathsFile, issueRel, stderr, reviewed = null, protectedPaths }) {
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
	let ownsLock = false;
	try {
		// Reserve the real index throughout approval; preserve unrelated staging.
		fd = openSync(lock, "wx");
		ownsLock = true;
		return withIndex(root, ({ command, index: scratch }) => {
			const protectedFiles = protectedPaths ?? [...preservePaths(root, { extra: issueRel ? [join(root, issueRel)] : [] }), ...controlPaths(root, join(root, ".pipeline"))];
			const prepared = guardGitOperation(root, protectedFiles, "approval preparation", () => {
				command(["read-tree", head]);
				putEntries(command, entries);
				if (issueRel && existsSync(join(root, issueRel))) {
					// The engine owns this Markdown update. Store it as LF text without
					// executing clean filters or letting them rewrite checkbox contents.
					if (!lstatSync(join(root, issueRel)).isFile()) throw new Error("approval requires a regular issue-source file; commit linked issue updates manually");
					const prior = indexEntries(command(["ls-files", "--stage", "-z", "--", ":(literal)" + issueRel]))[0];
					const content = readFileSync(join(root, issueRel), "utf8").replace(/\r\n/g, "\n");
					const oid = command(["hash-object", "-w", "--stdin", "--no-filters"], Buffer.from(content)).toString().trim();
					putEntries(command, [{ path: issueRel, mode: prior?.mode === "100755" ? "100755" : "100644", oid }]);
				}
				const selectedPaths = [...new Set([...paths, ...(issueRel ? [issueRel] : [])])];
				if (!selectedPaths.length) return { committed: false, reason: "nothing to commit" };
				const all = indexEntries(command(["ls-files", "--stage", "-z"]));
				const selected = selectedPaths.map((p) => all.find((e) => e.path === p) ?? { path: p, mode: "0", oid: "0".repeat(head.length) });
				// Build the user's replacement index before moving HEAD. A failed
				// signing/commit leaves both the real index and HEAD untouched.
				const tree = command(["write-tree"]).toString().trim();
				if (tree === gitText(root, ["rev-parse", "HEAD^{tree}"])) return { committed: false, reason: "nothing to commit" };
				if (existsSync(index)) copyFileSync(index, scratch);
				else command(["read-tree", head]);
				putEntries(command, selected);
				const replacement = readFileSync(scratch);
				const ident = [];
				if (!gitText(root, ["config", "user.email"])) {
					ident.push("-c", "user.name=auto-develop", "-c", "user.email=auto-develop@localhost");
					stderr.write("note: no git identity configured; committing as auto-develop <auto-develop@localhost>\n");
				}
				if (gitText(root, ["rev-parse", "HEAD"]) !== head) throw new Error("HEAD changed before approval commit");
				const sign = gitText(root, ["config", "--bool", "commit.gpgsign"]) === "true" ? ["-S"] : [];
				// commit-tree never refreshes the worktree/index and therefore cannot
				// run filters again. Signing configuration remains effective.
				const oid = command([...ident, "commit-tree", tree, "-p", head, ...sign], Buffer.from(`pipeline: ${issueLine}\n`)).toString().trim();
				return { oid, replacement };
			});
			if (!prepared.oid) return prepared;
			command(["update-ref", "-m", "pipeline: " + issueId, "HEAD", prepared.oid, head]);
			writeFileSync(fd, prepared.replacement); fsyncSync(fd); closeSync(fd); fd = undefined;
			renameSync(lock, index);
			ownsLock = false;
			const sha = gitText(root, ["rev-parse", "--short", "HEAD"]);
			stderr.write("committed " + sha + ": " + issueId + "\n");
			return { committed: true, sha };
		});
	} catch (error) {
		stderr.write(error.message + "\n");
		return { committed: false, reason: error.message };
	} finally {
		if (fd !== undefined) closeSync(fd);
		if (ownsLock) rmSync(lock, { force: true });
	}
}
