// INV-06, INV-18, INV-19, INV-28: unprocessed evidence blocks the whole attempt;
// parser recovery must preserve findings and setup must survive a fresh clone.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initCommand } from "../../lib/cli/init.mjs";
import { runDoctor } from "../../lib/cli/doctor.mjs";
import { runPipeline } from "../../lib/loop/run.mjs";
import { runGate } from "../../lib/review/gate.mjs";
import { extractJson } from "../../lib/review/reviewer-output.mjs";
import { parseMasterDecision } from "../../lib/review/master-decision.mjs";
import { CONTRACT, checkedGit, createProject } from "../fixtures/project.mjs";

const clean = '{"verdict":"approve","findings":[]}';
const fence = (body) => `\`\`\`json\n${body}\n\`\`\``;
const finding = { severity: "critical", file: "work.txt", title: "leak" };
const stranded = '{"severity":"critical","file":"work.txt"\n' + fence(clean);
const incomplete = '{"verdict":"reject","findings":[' + JSON.stringify(finding) + ']\n' + fence(clean);

function gateFor(text) {
	const root = mkdtempSync(join(tmpdir(), "pipeline-evidence-gate-"));
	const files = [text, clean, clean].map((body, i) => {
		const file = join(root, `${i}.json`);
		writeFileSync(file, body);
		return file;
	});
	return runGate({ files, minReviewers: 2 });
}

test("an unprocessed severity blocks even when two other reviewers are available", () => {
	for (const text of [stranded, '{"severity":"critical"', stranded.replace('"severity"', '"seve\\u0072ity"')]) {
		const gate = gateFor(text);
		assert.equal(gate.result.reviewers_used, 2);
		assert.equal(gate.exit, 4, JSON.stringify(gate));
		assert.ok(gate.result.blocking.length > 0);
	}
});

test("a finding recovered from a broken review is retained as evidence", () => {
	const parsed = extractJson(incomplete);
	assert.ok(parsed.findings.some((f) => f.severity === "critical" && f.title === "leak"));
	assert.equal(parsed.invalidFindings, true, "a standalone finding cannot fill a panel seat");
	assert.equal(gateFor(incomplete).exit, 4);
});

test("unconsumed nested keys and scanner exhaustion cannot release work", () => {
	const nested = JSON.stringify({ verdict: "approve", findings: [], extra: { severity: "critical" } });
	assert.equal(gateFor(nested).exit, 4);
	const prefix = "{}\n".repeat(513);
	assert.equal(gateFor(prefix + fence(clean)).exit, 4);
	assert.equal(parseMasterDecision(prefix + fence('{"decision":"approve"}')).decision, "reject");
	assert.equal(parseMasterDecision('{"extra":{"decision":"reject"}}\n' + fence('{"decision":"approve"}')).decision, "reject");
});

for (const [name, text] of [["unprocessed severity", stranded], ["recovered finding", incomplete]]) {
	test(`${name} survives a clean retry and prevents approval and commit`, async () => {
		const root = createProject();
		const stub = join(root, ".git", "review.mjs");
		copyFileSync(new URL("../fixtures/unprocessed-review-stub.mjs", import.meta.url), stub);
		let output = "";
		const stream = { write(s) { output += s; } };
		await runPipeline({ root, flags: { onlyIssue: "one", maxRuns: 1 }, stdout: stream, stderr: stream,
			env: { ...process.env, MIN_REVIEWERS: "2", PIPELINE_PI_BIN: stub, PROBE_REVIEW: text } });
		assert.equal(readFileSync(join(root, ".git", "security-calls"), "utf8"), "call\ncall\n");
		const gate = JSON.parse(readFileSync(join(root, ".pipeline", "work", "one", "gate.json"), "utf8"));
		assert.equal(gate.verdict, "blocked", JSON.stringify(gate));
		assert.ok(gate.blocking.length > 0);
		assert.doesNotMatch(output, /^approved:/m);
		assert.equal(checkedGit(root, ["rev-list", "--count", "HEAD"]).trim(), "1");
		assert.match(checkedGit(root, ["show", "HEAD:tasks.md"]), /\[ \] one:/);
	});
}

test("a private LF override cannot replace or hide a conflicting project rule", async () => {
	for (const existing of ["", "auto-develop.sh text eol=lf\n*.sh text eol=crlf\n"]) {
		const root = createProject();
		const privateFile = join(root, ".git", "info", "attributes");
		writeFileSync(privateFile, "auto-develop.sh text eol=lf\n");
		if (existing) writeFileSync(join(root, ".gitattributes"), existing);
		assert.equal(await initCommand(["--local"], { root }), 0);
		assert.ok(existsSync(join(root, ".gitattributes")));
		unlinkSync(privateFile);
		assert.match(checkedGit(root, ["check-attr", "text", "eol", "--", "auto-develop.sh"]), /text: set\s+auto-develop.sh: eol: lf/);
		const attrs = readFileSync(join(root, ".gitattributes"), "utf8");
		assert.equal(await initCommand([], { root }), 0);
		assert.equal(readFileSync(join(root, ".gitattributes"), "utf8"), attrs, "init is idempotent");
		writeFileSync(privateFile, "auto-develop.sh -text eol=lf\n");
		assert.equal(await initCommand([], { root }), 1, "a conflicting private override must be reported");
		assert.equal(readFileSync(join(root, ".gitattributes"), "utf8"), attrs, "a private conflict must not append duplicate rules");
		assert.ok(runDoctor({ root }).lines.some((line) => /WARN.*text=unset/.test(line)));
	}
});

test("init without Git reports the prerequisite instead of reading a missing attributes file", async () => {
	const root = mkdtempSync(join(tmpdir(), "pipeline-fresh-init-"));
	writeFileSync(join(root, "AGENTS.md"), CONTRACT);
	assert.equal(await initCommand([], { root }), 1);
	assert.match(readFileSync(join(root, ".gitattributes"), "utf8"), /auto-develop.sh text eol=lf/);
	assert.equal(await initCommand([], { root }), 1, "repeat setup stays usable");
});
