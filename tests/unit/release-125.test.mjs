// 1.2.5 (INV-08, INV-28): what the 2026-09-23 reviews found in practice. doctor and the run
// name a disabled guard, doctor names a drifted .pi copy of SYSTEM.md, and a
// dry-run shows the routing of every role, not only the ones it renders.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runDoctor } from "../../lib/cli/doctor.mjs";
import { runPipeline } from "../../lib/loop/run.mjs";
import { createProject } from "../fixtures/project.mjs";

const cleanEnv = () => {
	const env = { ...process.env };
	delete env.PIPELINE_GUARD;
	return env;
};

test("doctor and a run name PIPELINE_GUARD=off instead of inheriting it silently", async () => {
	const root = createProject();
	const guardWarning = /PIPELINE_GUARD=off is set; pipeline-guard is disabled/;
	assert.doesNotMatch(runDoctor({ root, env: cleanEnv() }).lines.join("\n"), guardWarning);
	const doctor = runDoctor({ root, env: { ...cleanEnv(), PIPELINE_GUARD: "off" } });
	assert.ok(doctor.lines.some((line) => line.startsWith("WARN ") && guardWarning.test(line)), doctor.lines.join("\n"));

	let output = "";
	const stream = { write(text) { output += text; } };
	await runPipeline({ root, flags: { dryRun: true }, stdout: stream, stderr: stream, env: { ...cleanEnv(), PIPELINE_GUARD: "off" } });
	assert.match(output, /warning: PIPELINE_GUARD=off is set/);
});

test("doctor warns when .pi/APPEND_SYSTEM.md is not a copy of SYSTEM.md, line endings aside", () => {
	const root = createProject();
	mkdirSync(join(root, ".pi"), { recursive: true });
	writeFileSync(join(root, "SYSTEM.md"), "# System\n\nnpm test\n");
	writeFileSync(join(root, ".pi", "APPEND_SYSTEM.md"), "# System\r\n\r\nnpm test\r\n");
	const drift = /SYSTEM\.md and \.pi\/APPEND_SYSTEM\.md differ/;
	assert.doesNotMatch(runDoctor({ root, env: cleanEnv() }).lines.join("\n"), drift);
	writeFileSync(join(root, ".pi", "APPEND_SYSTEM.md"), "# System (appended)\n\nnpm test\n");
	assert.match(runDoctor({ root, env: cleanEnv() }).lines.join("\n"), drift);
});

test("a dry-run prints the routing of controller, master_review and implement_master", async () => {
	const root = createProject();
	let output = "";
	const stream = { write(text) { output += text; } };
	assert.equal(await runPipeline({ root, flags: { dryRun: true, issue: "one" }, stdout: stream, stderr: stream, env: cleanEnv() }), 0, output);
	assert.match(output, /^\[dry-run\] controller -> openai\/controller \(not rendered/m);
	assert.match(output, /^\[dry-run\] master_review -> google\/judge \(not rendered/m);
	assert.match(output, /^\[dry-run\] implement_master -> google\/master \(not rendered/m);
});
