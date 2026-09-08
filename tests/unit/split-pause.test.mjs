// INV-21: --max-runs reached inside a split is a planned stop. The parent
// keeps `split` and the next run resumes at the open children.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runPipeline } from "../../lib/loop/run.mjs";
import { createProject } from "../fixtures/project.mjs";

const STUB = `import { readFileSync, appendFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
appendFileSync(".pipeline/calls.log", prompt.split("\\n")[0] + " | " + (prompt.match(/\\b(one(?:\\.\\d+)?|two): /) || ["", "?"])[1] + "\\n");
if (prompt.startsWith("Implement this issue")) appendFileSync("work.txt", "line " + Date.now() + Math.random() + "\\n");
else if (prompt.startsWith("You review")) console.log('{"role":"review","verdict":"approve","findings":[]}');
else if (prompt.startsWith("Decide this attempt")) {
  if (/\\bone\\.\\d+: /.test(prompt) || /\\btwo: /.test(prompt)) console.log('{"decision":"approve"}');
  else console.log('{"decision":"split","reasons":["too big"],"issues":[{"title":"sub a","text":"first half"},{"title":"sub b","text":"second half"}]}');
} else console.log("notes");
`;

async function runWith(root, flags) {
	let output = "";
	const stream = { write(text) { output += text; } };
	const rc = await runPipeline({ root, flags, stdout: stream, stderr: stream, env: { ...process.env, PIPELINE_PI_BIN: join(root, ".git", "stub.mjs") } });
	return { rc, output };
}

const state = (root) => JSON.parse(readFileSync(join(root, ".pipeline", "state", "one.json"), "utf8"));

test("--max-runs inside a split leaves the parent split, and the next run resumes at the open child", async () => {
	const root = createProject();
	writeFileSync(join(root, ".git", "stub.mjs"), STUB);

	const first = await runWith(root, { maxRuns: 2 });
	assert.equal(first.rc, 0, first.output);
	assert.match(first.output, /master review splits one into 2 sub-issues/);
	assert.match(first.output, /approved: one\.1/);
	assert.match(first.output, /split one left open: --max-runs 2 reached before every sub-issue finished/);
	assert.doesNotMatch(first.output, /blocked: one/);
	let s = state(root);
	assert.equal(s.issues.one.status, "split", JSON.stringify(s));
	assert.equal(s.issues["one.1"].status, "done");
	assert.notEqual(s.issues["one.2"].status, "blocked");

	const second = await runWith(root, {});
	assert.equal(second.rc, 0, second.output);
	assert.match(second.output, /resuming split one: 1 open sub-issue/);
	assert.match(second.output, /approved: one\.2/);
	assert.match(second.output, /approved: one \(all sub-issues done\)/);
	s = state(root);
	assert.equal(s.issues.one.status, "done");
	// The parent is implemented once, before the split; the resumed run only
	// touches the open child.
	const calls = readFileSync(join(root, ".pipeline", "calls.log"), "utf8");
	const parentImplementations = calls.split("\n").filter((line) => line.startsWith("Implement this issue") && line.endsWith("| one"));
	assert.equal(parentImplementations.length, 1, `the parent was implemented again:\n${calls}`);
});
