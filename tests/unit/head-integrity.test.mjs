// INV-12, INV-17: a role moving HEAD stops before any review or subsequent issue.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runPipeline } from "../../lib/loop/run.mjs";
import { checkedGit, createProject } from "../fixtures/project.mjs";

for (const mode of ["full", "partial", "partial-governance"]) {
	test(`an implementer self-commit (${mode}) blocks and preserves evidence without reviewing or starting the next issue`, async () => {
		const root = createProject();
		const stub = join(root, ".git", "stub.mjs");
		writeFileSync(stub, `import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const prompt = readFileSync(0, "utf8");
appendFileSync(".pipeline/calls.log", prompt.split("\\n")[0] + "\\n");
if (prompt.startsWith("Implement this issue")) {
  writeFileSync("unreviewed.txt", "committed before review");
  execFileSync("git", ["add", "unreviewed.txt"]);
  execFileSync("git", ["commit", "-qm", "role self-commit"]);
  if (process.env.PROBE_MODE !== "full") writeFileSync("remainder.txt", "uncommitted remainder");
  if (process.env.PROBE_MODE === "partial-governance") appendFileSync("AGENTS.md", "tampered");
} else if (prompt.startsWith("You review")) console.log('{"role":"review","verdict":"approve","findings":[]}');
else if (prompt.startsWith("Decide this attempt")) console.log('{"decision":"approve"}');
else console.log("notes");
`);
		let output = "";
		const stream = { write(text) { output += text; } };
		const rc = await runPipeline({
			root, flags: { maxRuns: 3 }, stdout: stream, stderr: stream,
			env: { ...process.env, PIPELINE_PI_BIN: stub, PROBE_MODE: mode },
		});
		assert.equal(rc, 1, output);
		assert.match(output, /HEAD moved during implement/);
		assert.match(output, /not started: two/);
		assert.doesNotMatch(output, /approved:/);
		assert.equal(checkedGit(root, ["rev-list", "--count", "HEAD"]).trim(), "2");
		const calls = readFileSync(join(root, ".pipeline", "calls.log"), "utf8");
		assert.equal(calls.trim().split("\n").length, 2, calls);
		assert.doesNotMatch(calls, /You review|Decide this attempt/);
		assert.match(readFileSync(join(root, "tasks.md"), "utf8"), /- \[ \] one/);
		const state = JSON.parse(readFileSync(join(root, ".pipeline", "state", "one.json"), "utf8"));
		assert.equal(state.issues.one.status, "blocked");
		assert.equal(state.runs_used, 1);
		assert.match(readFileSync(join(root, "MEMORY.md"), "utf8"), /HEAD moved/);
		assert.equal(existsSync(join(root, "remainder.txt")), mode !== "full");
	});
}
