import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../../lib/util/exec.mjs";

export const CONTRACT = `# Governance
\`\`\`yaml pipeline-contract
contract_version: 2
models:
  implement: { provider: anthropic, model: impl }
  implement_master: { provider: google, model: master }
  research: { provider: openai, model: research }
  controller: { provider: openai, model: controller }
  master_review: { provider: google, model: judge }
  review:
    security: { provider: google, model: security }
    quality: { provider: openai, model: quality }
    correctness: { provider: anthropic, model: correctness }
  constraints:
    no_self_review: true
issues:
  source: tasks.md
gates: []
\`\`\`
`;

export function checkedGit(root, args) {
	const result = git(root, args);
	assert.equal(result.status, 0, result.stderr.toString());
	return result.stdout.toString("utf8");
}

export function createProject() {
	const root = mkdtempSync(join(tmpdir(), "pipeline-regression-"));
	checkedGit(root, ["init", "-q"]);
	checkedGit(root, ["config", "user.email", "test@example.invalid"]);
	checkedGit(root, ["config", "user.name", "Pipeline Test"]);
	checkedGit(root, ["config", "commit.gpgsign", "false"]);
	checkedGit(root, ["config", "core.hooksPath", join(root, ".test-hooks")]);
	writeFileSync(join(root, ".gitignore"), ".pipeline/\n");
	writeFileSync(join(root, "AGENTS.md"), CONTRACT);
	writeFileSync(join(root, "tasks.md"), "- [ ] one: first issue\n- [ ] two: second issue\n");
	writeFileSync(join(root, "obsolete.txt"), "old code\n");
	writeFileSync(join(root, "rename-from.txt"), "renamed code\n");
	checkedGit(root, ["add", "."]);
	checkedGit(root, ["commit", "-qm", "initial"]);
	return root;
}
