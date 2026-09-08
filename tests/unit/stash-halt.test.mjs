// INV-13: a refused stash after a block stops the run; the next issue must
// not review and commit the tree the master rejected.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runPipeline } from "../../lib/loop/run.mjs";
import { createProject } from "../fixtures/project.mjs";

// Reviewers never produce JSON, so the second attempt is a configuration
// error and blocks the issue. The second implementer call leaves an index
// lock behind, which makes the block's stash fail.
const STUB = `import { readFileSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
appendFileSync(".pipeline/calls.log", prompt.split("\\n")[0] + " | " + (prompt.match(/\\b(one|two): /) || ["", "?"])[1] + "\\n");
if (prompt.startsWith("Implement this issue")) {
  appendFileSync("work.txt", "rejected line " + Date.now() + Math.random() + "\\n");
  if (existsSync("work.txt") && readFileSync("work.txt", "utf8").split("\\n").length > 2) writeFileSync(".git/index.lock", "held by a crashed git");
} else if (prompt.startsWith("You review")) console.log("I cannot produce JSON today");
else console.log("notes");
`;

test("a failed stash after a block halts the run instead of feeding the rejected tree to the next issue", async () => {
	const root = createProject();
	const stub = join(root, ".git", "stub.mjs");
	writeFileSync(stub, STUB);
	let output = "";
	const stream = { write(text) { output += text; } };
	const rc = await runPipeline({ root, flags: {}, stdout: stream, stderr: stream, env: { ...process.env, PIPELINE_PI_BIN: stub } });
	assert.equal(rc, 1, output);
	assert.match(output, /Configuration error: two consecutive attempts/);
	assert.match(output, /warning: git stash failed/);
	assert.match(output, /stopped: git stash failed after blocking one; the rejected tree is still in the working tree/);
	assert.match(output, /not started: two/);
	const calls = readFileSync(join(root, ".pipeline", "calls.log"), "utf8");
	assert.doesNotMatch(calls, /Implement this issue \| two/, calls);
	assert.doesNotMatch(output, /approved:/);
	assert.match(readFileSync(join(root, "work.txt"), "utf8"), /rejected line/, "the rejected tree was expected to remain for inspection");
});
