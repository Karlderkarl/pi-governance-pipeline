// INV-21: --max-runs reached inside a split is a planned stop. The parent
// keeps `split` and the next run resumes at the open children.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runPipeline } from "../../lib/loop/run.mjs";
import { stateCommand } from "../../lib/state/store.mjs";
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

test("a split whose sub-issue is blocked blocks the parent with its own MEMORY.md entry", async () => {
	const root = createProject();
	writeFileSync(join(root, ".git", "stub.mjs"), STUB);
	const first = await runWith(root, { maxRuns: 2 });
	assert.equal(first.rc, 0, first.output);
	// one.2 stopped on its own (its blocker is its own business); the parent
	// must not end blocked without a word in MEMORY.md (INV-07).
	const s = state(root);
	s.issues["one.2"].status = "blocked";
	writeFileSync(join(root, ".pipeline", "state", "one.json"), JSON.stringify(s));
	const second = await runWith(root, {});
	assert.notEqual(second.rc, 0, second.output);
	assert.equal(second.output.match(/^blocked: one — /gm)?.length, 1, `one explanation per blocked issue:
${second.output}`);
	assert.match(second.output, /^blocked: one — written to/m);
	assert.equal(state(root).issues.one.status, "blocked");
	const memory = readFileSync(join(root, "MEMORY.md"), "utf8");
	assert.match(memory, /## Blocker — one \(/);
	assert.match(memory, /not every sub-issue finished: one\.2 \(blocked\)/);
	assert.doesNotMatch(memory, /one\.1 \(/, "a finished sub-issue is not listed as open");
});

// The recovery after a stop: every blocked issue is reopened with `open`. For
// a split parent that must mean "resume the split", not "implement it again".
test("reopening a blocked split parent resumes at its blocked child instead of implementing the parent again", async () => {
	const root = createProject();
	writeFileSync(join(root, ".git", "stub.mjs"), STUB);
	assert.equal((await runWith(root, { maxRuns: 2 })).rc, 0);
	const s = state(root);
	s.issues["one.2"].status = "blocked";
	writeFileSync(join(root, ".pipeline", "state", "one.json"), JSON.stringify(s));
	assert.notEqual((await runWith(root, {})).rc, 0);
	assert.equal(state(root).issues.one.status, "blocked");

	const dir = join(root, ".pipeline");
	stateCommand(["issue", dir, "one", "one.2", "open"], {});
	stateCommand(["issue", dir, "one", "one", "open"], {});
	assert.equal(state(root).issues.one.status, "split", "a parent with children returns to split");
	assert.equal(state(root).issues["one.2"].status, "open");
	const resumed = await runWith(root, {});
	assert.equal(resumed.rc, 0, resumed.output);
	assert.match(resumed.output, /resuming split one: 1 open sub-issue/);
	assert.match(resumed.output, /approved: one\.2/);
	assert.equal(state(root).issues.one.status, "done");
	const calls = readFileSync(join(root, ".pipeline", "calls.log"), "utf8");
	const parentRuns = calls.split(/\r?\n/).filter((line) => line.startsWith("Implement this issue") && line.endsWith("| one"));
	assert.equal(parentRuns.length, 1, `the parent was implemented again: ${calls}`);
});
