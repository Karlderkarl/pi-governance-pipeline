// Git filters execute project code too. Verify before returning captured data
// or publishing a commit; retain hashes in the parent and large recovery
// copies outside the working tree. Restoration verifies spilled bytes too.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { gitText } from "../util/exec.mjs";
import { compareSnapshots, describeDiff, restoreSnapshot, takeSnapshot } from "./snapshot.mjs";

export function guardGitOperation(root, paths, phase, action) {
	const head = gitText(root, ["rev-parse", "--verify", "HEAD"]);
	const canonical = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
	const protectedRoots = [root, ...paths].map(canonical);
	const base = [tmpdir(), homedir()].map(canonical).find((dir) => protectedRoots.every((p) => {
		const rel = relative(p, dir);
		return isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep);
	}));
	if (!base) throw new Error("Git integrity snapshots need a temporary directory outside the working tree and protected paths");
	const recovery = mkdtempSync(join(base, "pipeline-git-snapshot-"));
	try {
		const before = takeSnapshot(paths, { spillDir: join(recovery, "files") });
		const verify = () => {
			const diff = compareSnapshots(before, takeSnapshot(paths, { hashOnly: true }));
			const moved = gitText(root, ["rev-parse", "--verify", "HEAD"]) !== head;
			if (!diff.clean || moved) {
				const unrestored = diff.clean ? [] : restoreSnapshot(before, diff);
				throw Object.assign(new Error(`protected files or HEAD modified during ${phase}: ${describeDiff(root, diff)}${moved ? "; HEAD moved; inspect unexpected commits" : ""}; ${unrestored.length ? "restoration incomplete" : "protected files restored"}; run stopped`), { code: "PIPELINE_CONTROL" });
			}
		};
		try { return action(); }
		finally { verify(); }
	} finally { rmSync(recovery, { recursive: true, force: true }); }
}
