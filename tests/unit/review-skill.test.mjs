// review-skill.test.mjs — regressions from the review of the governance-pipeline
// skill: what its audit checklist trusts doctor to catch, and the recovery
// after a tree-budget stop (INV-04, INV-10).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runDoctor } from "../../lib/cli/doctor.mjs";
import { wrapperPin } from "../../lib/cli/wrapper.mjs";
import { runPipeline } from "../../lib/loop/run.mjs";
import { parseMasterDecision } from "../../lib/review/master-decision.mjs";
import { extractJson } from "../../lib/review/reviewer-output.mjs";
import { createProject } from "../fixtures/project.mjs";

const cleanEnv = () => {
	const env = { ...process.env };
	delete env.PIPELINE_GUARD;
	return env;
};

test("doctor fails a file issue source the runner would refuse", () => {
	const root = createProject();
	const issueLine = (doctor) => doctor.lines.find((line) => /issue source/.test(line));
	assert.match(issueLine(runDoctor({ root, env: cleanEnv() })), /^PASS issue source tasks\.md/);
	// Open `one` beside a closed `ONE`: one work directory on Windows and macOS.
	writeFileSync(join(root, "tasks.md"), "- [ ] one: first\n- [x] ONE: closed\n");
	const doctor = runDoctor({ root, env: cleanEnv() });
	assert.match(issueLine(doctor), /^FAIL issue source tasks\.md .*cannot be listed: .*share one work directory/);
	assert.ok(doctor.fails > 0);
});

// The recovery the skill documents after a tree-budget stop: raise the ceiling
// once the run has ended, then reopen the blocked issue. Raising alone resumes
// nothing — a blocked issue is skipped.
const STUB = `import { appendFileSync, readFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
if (prompt.startsWith("Implement this issue")) appendFileSync("work.txt", "line" + Math.random() + "\\n");
else if (prompt.startsWith("Decide this attempt")) console.log('{"decision":"approve","reasons":["ok"]}');
else if (prompt.startsWith("You review")) console.log('{"role":"r","verdict":"approve","findings":[]}');
else console.log("notes");
`;

test("after a tree-budget stop, raising the budget and reopening the issue resumes the run", async () => {
	const root = createProject();
	writeFileSync(join(root, ".git", "stub.mjs"), STUB);
	const facade = fileURLToPath(new URL("../../lib/governance.mjs", import.meta.url));
	const governance = (...args) => spawnSync(process.execPath, [facade, "state", ...args], { cwd: root, encoding: "utf8" });
	mkdirSync(join(root, ".pipeline", "state"), { recursive: true });
	writeFileSync(join(root, ".pipeline", "state", "one.json"), JSON.stringify({
		root_id: "one", runs_used: 25, max_runs_per_tree: 25, depth: 0,
		issues: { one: { attempts_controller: 0, implement_runs: 0, attempts_master: 0, status: "open" } },
	}));
	const run = async () => {
		let output = "";
		const stream = { write(text) { output += text; } };
		const rc = await runPipeline({ root, flags: { onlyIssue: "one" }, stdout: stream, stderr: stream, env: { ...process.env, PIPELINE_PI_BIN: join(root, ".git", "stub.mjs") } });
		return { rc, output };
	};
	const stopped = await run();
	assert.notEqual(stopped.rc, 0, stopped.output);
	assert.match(readFileSync(join(root, "MEMORY.md"), "utf8"), /Tree budget exhausted/);

	assert.equal(governance("budget", ".pipeline", "one", "--set", "30").status, 0);
	const skipped = await run();
	assert.match(skipped.output, /skip one \(status: blocked\)/, "the budget alone does not reopen a blocked issue");

	// <dir> <root_id> <issue_id> <status>; here the issue is its own root.
	assert.equal(governance("issue", ".pipeline", "one", "one", "open").status, 0);
	const resumed = await run();
	assert.equal(resumed.rc, 0, resumed.output);
	assert.match(resumed.output, /^approved: one/m);
});

// A `.pi` that is a junction to a shared directory put APPEND_SYSTEM.md outside
// the integrity snapshot: a gate could rewrite it and the run committed.
test("a run refuses governance reached through a link outside the integrity check", async () => {
	const root = createProject();
	writeFileSync(join(root, ".git", "stub.mjs"), STUB);
	const shared = mkdtempSync(join(tmpdir(), "shared-pi-"));
	writeFileSync(join(shared, "APPEND_SYSTEM.md"), "rules");
	symlinkSync(shared, join(root, ".pi"), process.platform === "win32" ? "junction" : "dir");
	let output = "";
	const stream = { write(text) { output += text; } };
	const rc = await runPipeline({ root, flags: { onlyIssue: "one" }, stdout: stream, stderr: stream, env: { ...process.env, PIPELINE_PI_BIN: join(root, ".git", "stub.mjs") } });
	assert.notEqual(rc, 0, output);
	assert.match(output, /governance is reached through a link the integrity check cannot see through: .*\.pi -> /);
	assert.doesNotMatch(output, /^approved:/m);
	assert.equal(readFileSync(join(shared, "APPEND_SYSTEM.md"), "utf8"), "rules");
});

// The schema's own placeholders are exempt, nothing else in the same object:
// a critical under an extra key, or a nested reject, is evidence.
test("a real verdict nested in a schema echo is not exempted with it", () => {
	const nested = extractJson('{"verdict":"approve|reject","findings":[],"extra":{"severity":"critical","file":"a","title":"Real"}}');
	assert.equal(nested?.invalidFindings, true);
	assert.ok(nested.findings.some((f) => f.severity === "unprocessed_review"), JSON.stringify(nested));
	assert.equal(extractJson('{"verdict":"approve|reject","findings":[{"severity":"high","file":"path","line":42,"title":"","rationale":"","suggestion":""}]}'), null);

	const echo = '{"decision":"approve|reject|take_over","reasons":["..."],"extra":{"decision":"reject"}}';
	const decided = parseMasterDecision(`${echo}
{"decision":"approve","reasons":["ok"]}`);
	assert.equal(decided.decision, "reject");
	assert.match(decided.note, /not read/);
	assert.equal(parseMasterDecision(`{"decision":"approve|reject|take_over","reasons":["..."]}
{"decision":"approve","reasons":["ok"]}`).decision, "approve");
});

// A version in a comment is in any script: that script is foreign, not a pin
// to bump. An older wrapper is recognised by the line that runs the package.
test("a stray version string is not mistaken for a stale pin", () => {
	const comment = ["#!/usr/bin/env bash", "# pi-governance-pipeline@1.0.0", "exit 97", ""].join("\n");
	const older = ["#!/usr/bin/env bash", 'exec npx --yes pi-governance-pipeline@1.0.0 run "$@"', ""].join("\n");
	assert.equal(wrapperPin(comment), null);
	assert.equal(wrapperPin(older), "1.0.0");
	const root = createProject();
	const wrapperLine = () => runDoctor({ root, env: cleanEnv() }).lines.find((line) => /auto-develop\.sh (pinned|is not a generated)/.test(line));
	writeFileSync(join(root, "auto-develop.sh"), comment);
	assert.match(wrapperLine(), /^WARN auto-develop\.sh is not a generated wrapper/);
	writeFileSync(join(root, "auto-develop.sh"), older);
	assert.match(wrapperLine(), /^WARN auto-develop\.sh pinned to 1\.0\.0/);
});
