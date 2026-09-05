// INV-17, INV-21: a failed approval commit is an error, also for a split parent.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runPipeline } from "../../lib/loop/run.mjs";
import { initState, loadState, registerSplit, setIssueStatus } from "../../lib/state/store.mjs";
import { checkedGit, createProject } from "../fixtures/project.mjs";

function prepare({ rejectCommit = false } = {}) {
	const root = createProject();
	const stub = join(root, ".git", "stub.mjs");
	writeFileSync(stub, `import { readFileSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
if (prompt.startsWith("Implement this issue")) writeFileSync("reviewed.txt", "approved work\\n");
else if (prompt.startsWith("You review")) console.log('{"verdict":"approve","findings":[]}');
else if (prompt.startsWith("Decide this attempt")) console.log('{"decision":"approve"}');
else console.log("notes");
`);
	if (rejectCommit) {
		const hooks = join(root, ".git", "failing-hooks");
		mkdirSync(hooks);
		writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho 'test: commit refused' >&2\nexit 1\n", { mode: 0o755 });
		checkedGit(root, ["config", "core.hooksPath", hooks]);
	}
	return { root, stub };
}

async function run({ root, stub }, flags = {}, extraEnv = {}) {
	let output = "";
	const stream = { write(text) { output += text; } };
	const rc = await runPipeline({
		root, flags, stdout: stream, stderr: stream,
		env: { ...process.env, PIPELINE_PI_BIN: stub, ...extraEnv },
	});
	return { rc, output };
}

function seedSplit(root, { lastChildOpen = false } = {}) {
	const dir = join(root, ".pipeline");
	initState(dir, "one", { budgets: { max_runs_per_tree: 10 } });
	registerSplit(dir, "one", "one", ["one.1", "one.2"]);
	setIssueStatus(dir, "one", "one.1", "done");
	if (!lastChildOpen) setIssueStatus(dir, "one", "one.2", "done");
	writeFileSync(join(root, "tasks.md"), `- [ ] one: parent issue\n  - [x] one.1: first child\n  - [${lastChildOpen ? " " : "x"}] one.2: second child\n- [ ] two: next issue\n`);
}

test("a failed commit on the only selected issue returns non-zero and preserves approved work", async () => {
	const project = prepare({ rejectCommit: true });
	const head = checkedGit(project.root, ["rev-parse", "HEAD"]);
	const { rc, output } = await run(project, { onlyIssue: "one" });
	assert.equal(rc, 1, output);
	assert.match(output, /approved work of one could not be committed/);
	assert.match(output, /test: commit refused/);
	assert.equal(checkedGit(project.root, ["rev-parse", "HEAD"]), head);
	assert.equal(readFileSync(join(project.root, "reviewed.txt"), "utf8"), "approved work\n");
	assert.match(readFileSync(join(project.root, "tasks.md"), "utf8"), /- \[x\] one:/);
});

test("a failed split-parent closing commit stops before the next issue", async () => {
	const project = prepare({ rejectCommit: true });
	seedSplit(project.root);
	const { rc, output } = await run(project);
	assert.equal(rc, 1, output);
	assert.match(output, /approved work of one could not be committed/);
	assert.match(output, /not started: two/);
	assert.doesNotMatch(output, /approved: two/);
});

test("an intentional uncommitted approval can succeed when no further issue is selected", async () => {
	const project = prepare();
	const { rc, output } = await run(project, { onlyIssue: "one" }, { COMMIT_APPROVED: "0" });
	assert.equal(rc, 0, output);
	assert.match(output, /COMMIT_APPROVED=0/);
});

test("a halt after the last split child leaves the parent open until a reviewed baseline is restored", async () => {
	const project = prepare();
	seedSplit(project.root, { lastChildOpen: true });
	const { rc, output } = await run(project, {}, { COMMIT_APPROVED: "0" });
	assert.equal(rc, 1, output);
	assert.match(output, /split one left open/);
	assert.match(readFileSync(join(project.root, "tasks.md"), "utf8"), /- \[ \] one:/);
	const state = loadState(join(project.root, ".pipeline"), "one");
	assert.equal(state.issues.one.status, "split");
	assert.equal(state.issues["one.2"].status, "done");
});
