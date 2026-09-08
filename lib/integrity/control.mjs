// Orchestration files must not change during a model or gate process. Keep
// their bytes in the parent process, not in the model-writable work directory.
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitText } from "../util/exec.mjs";
import { compareSnapshots, describeDiff, restoreSnapshot, takeSnapshot } from "./snapshot.mjs";

export function controlPaths(root, pipelineDir) {
	const paths = [join(pipelineDir, "state")];
	for (const flag of ["--git-dir", "--git-common-dir"]) {
		const dir = gitText(root, ["rev-parse", flag]);
		if (dir) paths.push(...["config", "config.worktree", "hooks", "pipeline-run.lock"].map((p) => resolve(root, dir, p)));
	}
	const hooks = gitText(root, ["config", "--path", "core.hooksPath"]);
	if (hooks) paths.push(resolve(root, hooks));
	try { if (statSync(join(root, ".git")).isFile()) paths.push(join(root, ".git")); } catch {}
	return [...new Set(paths)];
}

export async function guardControl(paths, root, phase, action) {
	const before = takeSnapshot(paths, { keepBytes: Infinity });
	try { return await action(); }
	finally {
		const diff = compareSnapshots(before, takeSnapshot(paths, { hashOnly: true }));
		if (!diff.clean) {
			const unrestored = restoreSnapshot(before, diff);
			throw Object.assign(new Error(`pipeline control files modified during ${phase}: ${describeDiff(root, diff)}; ${unrestored.length ? "restoration incomplete" : "restored"}; run stopped`), { code: "PIPELINE_CONTROL" });
		}
	}
}
