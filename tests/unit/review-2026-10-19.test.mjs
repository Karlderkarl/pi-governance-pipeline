// review-2026-10-19.test.mjs — regressions from the two reviews of the
// controller removal: the attempt counters after a take_over (INV-10), and
// the gate summary the master reads once the reviewer block is capped.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { statusText } from "../../lib/cli/status.mjs";
import { runPipeline } from "../../lib/loop/run.mjs";
import { CONTRACT, createProject } from "../fixtures/project.mjs";

// Reviewers answer from PROBE_REVIEW (or approve); the master walks through
// PROBE_MASTER, one decision per call.
const STUB = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
if (prompt.startsWith("Implement this issue")) appendFileSync("work.txt", "line " + Date.now() + Math.random() + "\\n");
else if (prompt.startsWith("You review a diff for one concern only: security")) console.log(process.env.PROBE_REVIEW || '{"role":"security","verdict":"approve","findings":[]}');
else if (prompt.startsWith("You review")) console.log('{"role":"other","verdict":"approve","findings":[]}');
else if (prompt.startsWith("Decide this attempt")) {
  const counter = ".git/master-calls";
  const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(n + 1));
  const plan = (process.env.PROBE_MASTER || "approve").split(",");
  console.log(JSON.stringify({ decision: plan[Math.min(n, plan.length - 1)], reasons: ["probe"] }));
} else console.log("notes");
`;

async function run(root, env = {}) {
	writeFileSync(join(root, ".git", "stub.mjs"), STUB);
	let output = "";
	const stream = { write(text) { output += text; } };
	const rc = await runPipeline({ root, flags: { onlyIssue: "one" }, stdout: stream, stderr: stream, env: { ...process.env, PIPELINE_PI_BIN: join(root, ".git", "stub.mjs"), ...env } });
	return { rc, output };
}

const prompts = (root, role) => readdirSync(join(root, ".pipeline", "prompts", "one")).filter((f) => f.startsWith(`one-${role}-a`)).sort();

test("after a take_over the next attempt is numbered by the attempts that ran", async () => {
	const root = createProject();
	const { rc, output } = await run(root, { PROBE_MASTER: "take_over,approve" });
	assert.equal(rc, 0, output);
	assert.match(output, /^approved: one/m);
	assert.deepEqual(prompts(root, "implement").map((f) => f.slice(0, "one-implement-a01".length)), ["one-implement-a01"]);
	assert.deepEqual(prompts(root, "implement_master").map((f) => f.slice(0, "one-implement_master-a02".length)), ["one-implement_master-a02"]);
	assert.match(statusText(join(root, ".pipeline")), /one: done \(implement 1 then taken over, implement_master 1\)/);
});

test("a take_over after the implement ceiling was lowered keeps running", async () => {
	const root = createProject();
	writeFileSync(join(root, "AGENTS.md"), CONTRACT.replace("gates: []", "budgets:\n  max_attempts_controller: 2\ngates: []"));
	mkdirSync(join(root, ".pipeline", "state"), { recursive: true });
	writeFileSync(join(root, ".pipeline", "state", "one.json"), JSON.stringify({
		root_id: "one", runs_used: 3, max_runs_per_tree: 25, depth: 0,
		issues: { one: { attempts_controller: 3, implement_runs: 3, attempts_master: 0, status: "open" } },
	}));
	const { rc, output } = await run(root, { PROBE_MASTER: "take_over,approve" });
	assert.equal(rc, 0, output);
	assert.doesNotMatch(output, /invalid state/);
	assert.match(output, /^approved: one/m);
	const state = JSON.parse(readFileSync(join(root, ".pipeline", "state", "one.json"), "utf8"));
	assert.equal(state.issues.one.attempts_controller, 3, "a lowered ceiling never pulls the routing counter back");
	assert.equal(state.issues.one.implement_runs, 3);
	assert.notEqual(state.issues.one.taken_over, true, "implement ran its full budget; nothing was cut short");
	assert.equal(state.issues.one.attempts_master, 2);
});

test("a blocker cut out of the capped reviewer block still reaches the master with its reason", async () => {
	const root = createProject();
	const review = JSON.stringify({ role: "security", verdict: "reject", findings: [
		{ severity: "medium", file: "big.txt", line: 1, title: "padding", rationale: "p".repeat(70000), suggestion: "s" },
		{ severity: "critical", file: "work.txt", line: 2, title: "Real defect", rationale: "CRITICAL-REASON-7f3a", suggestion: "fix it" },
	] });
	const { output } = await run(root, { PROBE_REVIEW: review, PROBE_MASTER: "reject", MIN_REVIEWERS: "2" });
	const work = join(root, ".pipeline", "work", "one");
	assert.ok(existsSync(join(work, "reviewers.trunc")), output);
	assert.doesNotMatch(readFileSync(join(work, "reviewers.trunc"), "utf8"), /CRITICAL-REASON-7f3a/, "precondition: the reviewer block lost it");
	const [first] = prompts(root, "master_review");
	const prompt = readFileSync(join(root, ".pipeline", "prompts", "one", first), "utf8");
	const gateLine = prompt.split("\n").find((line) => line.startsWith("Deterministic gate: "));
	assert.match(gateLine, /CRITICAL-REASON-7f3a/);
	assert.doesNotMatch(gateLine, /p{1000}/, "a follow-up's rationale is not repeated");
	assert.ok(Buffer.byteLength(prompt) < 2 * 65536 + 20000, `master prompt is ${Buffer.byteLength(prompt)} bytes`);
});
