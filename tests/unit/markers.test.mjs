// INV-28: a decision marker anywhere in governance refuses a real run and fails
// doctor; a dry-run notes it. Contract validation covers only the YAML block.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runDoctor } from "../../lib/cli/doctor.mjs";
import { scanDecisionMarkers } from "../../lib/integrity/markers.mjs";
import { runPipeline } from "../../lib/loop/run.mjs";
import { CONTRACT, createProject } from "../fixtures/project.mjs";

const STUB = `import { appendFileSync } from "node:fs";
appendFileSync(".pipeline/calls.log", "called\n");
console.log("notes");
`;

function seed(root) {
	writeFileSync(join(root, "SOUL.md"), "# Soul\n\nStack: node 22\n\nSecurity: [USER DECISION REQUIRED] which auth provider?\n");
	mkdirSync(join(root, ".pi"), { recursive: true });
	writeFileSync(join(root, ".pi", "APPEND_SYSTEM.md"), "Tools: read, bash\n[NEEDS PRD CLARIFICATION] test command\n");
}

test("the scan names file and line for a marker in prose, and ignores clean governance", () => {
	const root = createProject();
	writeFileSync(join(root, "SYSTEM.md"), "clean\n");
	assert.deepEqual(scanDecisionMarkers(root), []);
	seed(root);
	assert.deepEqual(scanDecisionMarkers(root), [
		{ file: "SOUL.md", line: 5, marker: "USER DECISION REQUIRED" },
		{ file: ".pi/APPEND_SYSTEM.md", line: 2, marker: "NEEDS PRD CLARIFICATION" },
	]);
});

test("a relocated governance file is scanned where it lives", () => {
	const root = createProject();
	mkdirSync(join(root, "gov"));
	writeFileSync(join(root, "gov", "soul.md"), "[USER DECISION REQUIRED]\n");
	const hits = scanDecisionMarkers(root, { soulFile: join(root, "gov", "soul.md") });
	assert.deepEqual(hits.map((h) => `${h.file}:${h.line}`), ["gov/soul.md:1"]);
});

test("doctor fails on a prose marker while the contract itself validates", () => {
	const root = createProject();
	seed(root);
	const { lines, fails } = runDoctor({ root, env: { ...process.env } });
	const output = lines.join("\n");
	assert.equal(fails, 2, output);
	assert.match(output, /PASS contract v2/);
	assert.match(output, /FAIL governance: SOUL\.md:5 still carries \[USER DECISION REQUIRED\]/);
	assert.match(output, /FAIL governance: \.pi\/APPEND_SYSTEM\.md:2 still carries \[NEEDS PRD CLARIFICATION\]/);
});

test("a real run refuses before any model call; a dry-run notes the marker and continues", async () => {
	const root = createProject();
	seed(root);
	const stub = join(root, ".git", "stub.mjs");
	writeFileSync(stub, STUB);
	const env = { ...process.env, PIPELINE_PI_BIN: stub };
	let output = "";
	const stream = { write(text) { output += text; } };
	assert.equal(await runPipeline({ root, flags: { maxRuns: 1 }, stdout: stream, stderr: stream, env }), 2, output);
	assert.match(output, /governance error: SOUL\.md:5 still carries \[USER DECISION REQUIRED\]; decide it in \/govern/);
	assert.equal(existsSync(join(root, ".pipeline", "calls.log")), false, "a role was launched");
	assert.equal(existsSync(join(root, ".pipeline", "state")), false, "state was written");

	output = "";
	assert.equal(await runPipeline({ root, flags: { dryRun: true }, stdout: stream, stderr: stream, env }), 0, output);
	assert.match(output, /note: SOUL\.md:5 still carries \[USER DECISION REQUIRED\]/);
	assert.match(output, /note: \.pi\/APPEND_SYSTEM\.md:2/);
	assert.equal(existsSync(join(root, ".pipeline", "calls.log")), false, "dry-run launched a role");
});

test("a marker inside the contract block stays a contract error, reported once by the run", async () => {
	const root = createProject();
	writeFileSync(join(root, "AGENTS.md"), CONTRACT.replace("gates: []", "gates: \"[USER DECISION REQUIRED]\""));
	let output = "";
	const stream = { write(text) { output += text; } };
	assert.equal(await runPipeline({ root, flags: {}, stdout: stream, stderr: stream, env: { ...process.env } }), 2, output);
	assert.match(output, /contract error: AGENTS\.md gates still carries the marker/);
	assert.doesNotMatch(output, /governance error:/);
});
