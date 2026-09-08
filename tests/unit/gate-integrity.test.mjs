// INV-20, INV-12: the gates run project commands whose scripts the implementer
// writes. Governance and HEAD are checked again after them, on a fresh snapshot.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runPipeline } from "../../lib/loop/run.mjs";
import { CONTRACT, checkedGit, createProject } from "../fixtures/project.mjs";

const STUB = `import { readFileSync, appendFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
appendFileSync(".pipeline/calls.log", prompt.split("\\n")[0] + "\\n");
if (prompt.startsWith("Implement this issue")) appendFileSync("work.txt", "line " + Date.now() + Math.random() + "\\n");
else if (prompt.startsWith("You review")) console.log('{"role":"review","verdict":"approve","findings":[]}');
else if (prompt.startsWith("Decide this attempt")) console.log('{"decision":"approve"}');
else console.log("notes");
`;

// The "test suite" the gate runs: it does what a model-written test script could.
const GATE = `import { appendFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
if (process.env.PROBE_MODE === "governance") appendFileSync("SOUL.md", "\\nrelaxed by the test script\\n");
if (process.env.PROBE_MODE === "commit") {
  writeFileSync("unreviewed.txt", "committed by the test script");
  execFileSync("git", ["add", "unreviewed.txt"]);
  execFileSync("git", ["commit", "-qm", "gate self-commit"]);
}
`;

async function runWith(mode) {
	const root = createProject();
	writeFileSync(join(root, "SOUL.md"), "# Soul\n\nStandards: strict\n");
	writeFileSync(join(root, "AGENTS.md"), CONTRACT.replace("gates: []", 'gates:\n  - { name: test, run: "node .git/gate.mjs" }'));
	checkedGit(root, ["add", "SOUL.md", "AGENTS.md"]);
	checkedGit(root, ["commit", "-qm", "governance"]);
	writeFileSync(join(root, ".git", "stub.mjs"), STUB);
	writeFileSync(join(root, ".git", "gate.mjs"), GATE);
	let output = "";
	const stream = { write(text) { output += text; } };
	const rc = await runPipeline({
		root, flags: { maxRuns: 1 }, stdout: stream, stderr: stream,
		env: { ...process.env, PIPELINE_PI_BIN: join(root, ".git", "stub.mjs"), PROBE_MODE: mode },
	});
	return { root, rc, output, calls: readFileSync(join(root, ".pipeline", "calls.log"), "utf8") };
}

test("a gate that edits governance costs the attempt and is reverted before any review", async () => {
	const { root, output, calls } = await runWith("governance");
	assert.match(output, /governance modified by gate \(.*SOUL\.md.*\); reverted/);
	assert.equal(readFileSync(join(root, "SOUL.md"), "utf8"), "# Soul\n\nStandards: strict\n");
	assert.doesNotMatch(calls, /You review|Decide this attempt/);
	assert.doesNotMatch(output, /approved:/);
	assert.match(readFileSync(join(root, ".pipeline", "work", "one", "exclusions.md"), "utf8"), /The gate step changed governance files/);
});

test("a gate that moves HEAD blocks the issue and stops the run before any review", async () => {
	const { root, rc, output, calls } = await runWith("commit");
	assert.equal(rc, 1, output);
	assert.match(output, /HEAD moved during the gates/);
	assert.match(output, /not started: two/);
	assert.doesNotMatch(calls, /You review|Decide this attempt/);
	assert.doesNotMatch(output, /approved:/);
	assert.equal(checkedGit(root, ["rev-list", "--count", "HEAD"]).trim(), "3");
	assert.match(readFileSync(join(root, "MEMORY.md"), "utf8"), /HEAD moved during the gates/);
});

test("a clean gate changes nothing about the happy path", async () => {
	const { rc, output } = await runWith("clean");
	assert.match(output, /approved: one/);
	assert.equal(rc, 0, output);
});
