// INV-17: an approval publishes only reviewed paths, preserving unrelated index entries.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { captureDiff, readDiffPaths } from "../../lib/diff/capture.mjs";
import { commitApproved } from "../../lib/loop/commit.mjs";
import { checkedGit, createProject } from "../fixtures/project.mjs";

test("approval excludes staged governance and wrapper, preserves their index entries, and commits literal paths, deletions and renames", () => {
	const root = createProject();
	writeFileSync(join(root, "AGENTS.md"), readFileSync(join(root, "AGENTS.md"), "utf8") + "\nUnreviewed staged instructions\n");
	writeFileSync(join(root, "auto-develop.sh"), "#!/usr/bin/env bash\n");
	checkedGit(root, ["add", "AGENTS.md", "auto-develop.sh"]);
	const before = checkedGit(root, ["ls-files", "--stage", "--", "AGENTS.md", "auto-develop.sh"]);
	writeFileSync(join(root, "literal[1].txt"), "reviewed code\n");
	unlinkSync(join(root, "obsolete.txt"));
	checkedGit(root, ["mv", "rename-from.txt", "rename-to.txt"]);
	mkdirSync(join(root, ".pipeline"));
	const diff = join(root, ".pipeline", "diff.patch");
	captureDiff({ root, out: diff, maxBytes: 65536, harnessRel: ["tasks.md", "auto-develop.sh"] });
	assert.deepEqual(readDiffPaths(`${diff}.paths`).sort(), ["literal[1].txt", "obsolete.txt", "rename-from.txt", "rename-to.txt"]);
	writeFileSync(join(root, "tasks.md"), "- [x] one: first issue\n- [ ] two: second issue\n");
	let log = "";
	const result = commitApproved({ root, issueId: "one", issueLine: "one", pathsFile: `${diff}.paths`, issueRel: "tasks.md", stderr: { write(text) { log += text; } } });
	assert.equal(result.committed, true, log);
	const changed = checkedGit(root, ["diff-tree", "--no-renames", "--no-commit-id", "--name-only", "-r", "HEAD"]).trim().split("\n").sort();
	assert.deepEqual(changed, ["literal[1].txt", "obsolete.txt", "rename-from.txt", "rename-to.txt", "tasks.md"]);
	assert.equal(checkedGit(root, ["ls-files", "--stage", "--", "AGENTS.md", "auto-develop.sh"]), before);
	assert.deepEqual(checkedGit(root, ["diff", "--cached", "--name-only"]).trim().split("\n"), ["AGENTS.md", "auto-develop.sh"]);
});
