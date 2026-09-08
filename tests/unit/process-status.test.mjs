// INV-06, INV-16, INV-19: a reviewer or master whose process failed cannot
// release work. Approval JSON from a process that exited non-zero is not an
// approval; a blocking finding it wrote is still a finding.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runPipeline } from "../../lib/loop/run.mjs";
import { checkedGit, createProject } from "../fixtures/project.mjs";

const STUB = `import { readFileSync, appendFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
const mode = process.env.PROBE_MODE;
appendFileSync(".pipeline/calls.log", prompt.split("\\n")[0] + "\\n");
const exitWith = (code) => { process.exitCode = code; };
if (prompt.startsWith("Implement this issue")) {
  appendFileSync("work.txt", "line " + Date.now() + Math.random() + "\\n");
} else if (prompt.startsWith("You review")) {
  if (mode === "critical-exit1") {
    console.log('{"role":"review","verdict":"approve","findings":[{"severity":"critical","title":"secret in log","file":"work.txt"}]}');
    exitWith(1);
  } else {
    console.log('{"role":"review","verdict":"approve","findings":[]}');
    if (mode === "approve-exit1") exitWith(1);
  }
} else if (prompt.startsWith("Decide this attempt")) {
  console.log('{"decision":"approve"}');
  if (mode === "approve-exit1" || mode === "master-exit1") exitWith(1);
} else console.log("notes");
`;

async function runWith(mode, maxRuns) {
	const root = createProject();
	const stub = join(root, ".git", "stub.mjs");
	writeFileSync(stub, STUB);
	let output = "";
	const stream = { write(text) { output += text; } };
	const rc = await runPipeline({
		root, flags: { maxRuns }, stdout: stream, stderr: stream,
		env: { ...process.env, PIPELINE_PI_BIN: stub, PROBE_MODE: mode },
	});
	return { root, rc, output, calls: readFileSync(join(root, ".pipeline", "calls.log"), "utf8") };
}

test("reviewers and master that approve but exit non-zero release nothing", async () => {
	const { root, rc, output } = await runWith("approve-exit1", 2);
	assert.doesNotMatch(output, /approved:/, output);
	assert.match(output, /reviewer security process failed; its output is discarded/);
	assert.match(output, /master review process failed \(exit 1\); a failed master cannot approve/);
	assert.match(output, /Configuration error: two consecutive attempts had fewer than 2 parseable reviewers/);
	assert.equal(rc, 1);
	assert.equal(checkedGit(root, ["rev-list", "--count", "HEAD"]).trim(), "1", "an approval was committed");
});

test("a failed reviewer keeps its blocking finding, and that finding blocks", async () => {
	const { root, output } = await runWith("critical-exit1", 1);
	assert.match(output, /reviewer security process failed; its blocking findings are kept, its verdict is not an approval/);
	assert.doesNotMatch(output, /approved:/, output);
	assert.equal(checkedGit(root, ["rev-list", "--count", "HEAD"]).trim(), "1");
	const gate = JSON.parse(readFileSync(join(root, ".pipeline", "work", "one", "gate.json"), "utf8"));
	assert.equal(gate.reviewers_used, 0, JSON.stringify(gate));
	assert.ok(gate.blocking.some((f) => f.severity === "critical"), JSON.stringify(gate));
});

test("a healthy panel with a failed master is a reject, not an approval", async () => {
	const { root, output, calls } = await runWith("master-exit1", 1);
	assert.match(output, /a failed master cannot approve — treating it as reject/);
	assert.doesNotMatch(output, /approved:/, output);
	assert.equal(checkedGit(root, ["rev-list", "--count", "HEAD"]).trim(), "1");
	assert.match(calls, /You review/);
});

test("the healthy path still approves and commits", async () => {
	const { root, rc, output } = await runWith("healthy", 1);
	assert.match(output, /approved: one/);
	assert.equal(rc, 0, output);
	assert.equal(checkedGit(root, ["rev-list", "--count", "HEAD"]).trim(), "2");
});
