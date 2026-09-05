// commit.mjs — approved work is committed: exactly the reviewed paths plus
// the issue source, so the next issue reviews only its own diff and a later
// take_over cannot stash approved work away. PR creation and --auto-merge
// remain adaptation points for a project's own workflow.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readDiffPaths } from "../diff/capture.mjs";
import { git, gitText } from "../util/exec.mjs";

export function commitApproved({ root, issueId, issueLine, pathsFile, issueRel, stderr }) {
	const add = readDiffPaths(pathsFile);
	if (issueRel && existsSync(join(root, issueRel))) add.push(issueRel);
	if (add.length === 0) return { committed: false, reason: "nothing to commit" };
	const ident = [];
	if (!gitText(root, ["config", "user.email"])) {
		ident.push("-c", "user.name=auto-develop", "-c", "user.email=auto-develop@localhost");
		stderr.write("note: no git identity configured; committing as auto-develop <auto-develop@localhost>\n");
	}
	const unique = [...new Set(add)];
	const paths = unique.map((path) => `:(literal)${path}`);
	const listed = git(root, ["ls-files", "-z", "--", ...paths]);
	if (listed.status !== 0) {
		stderr.write(listed.stderr.toString("utf8"));
		return { committed: false, reason: "git ls-files failed" };
	}
	const indexed = new Set(listed.stdout.toString("utf8").split("\0"));
	// Already-staged deletions (including git mv's old path) exist in neither
	// the index nor the worktree. git add rejects them, but commit --only still
	// needs them to include the deletion from HEAD.
	const toStage = unique.filter((path) => existsSync(join(root, path)) || indexed.has(path)).map((path) => `:(literal)${path}`);
	if (toStage.length > 0) {
		const added = git(root, [...ident, "add", "--", ...toStage]);
		if (added.status !== 0) {
			stderr.write(added.stderr.toString("utf8"));
			return { committed: false, reason: "git add failed" };
		}
	}
	// A plain commit would also publish unrelated entries already in the
	// index (including the wrapper staged by init). Preserve those entries.
	const committed = git(root, [...ident, "commit", "--only", "-q", "-m", `pipeline: ${issueLine}`, "--", ...paths]);
	if (committed.status !== 0) {
		stderr.write(committed.stderr.toString("utf8"));
		return { committed: false, reason: "git commit failed" };
	}
	const sha = gitText(root, ["rev-parse", "--short", "HEAD"]);
	stderr.write(`committed ${sha}: ${issueId}\n`);
	return { committed: true, sha };
}
