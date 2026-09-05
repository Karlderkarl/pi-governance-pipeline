// harness.test.mjs — INV-22 (harness per provider, never from governance) and
// INV-23 (isolation flags per role, and the launch path).
import assert from "node:assert/strict";
import { test } from "node:test";
import { harnessFor, harnessesInUse, isolationOf, parseHarnessSpec, routingErrors } from "../../lib/harness/adapter.mjs";
import * as claude from "../../lib/harness/claude-code.mjs";
import * as pi from "../../lib/harness/pi.mjs";

test("harness spec: default pi, per-provider overrides, unknown names refuse", () => {
	assert.deepEqual(parseHarnessSpec(""), { default: "pi", byProvider: {} });
	const spec = parseHarnessSpec("anthropic=claude-code, openai=pi");
	assert.equal(harnessFor("anthropic/opus:high", spec), "claude-code");
	assert.equal(harnessFor("google/gemini", spec), "pi");
	assert.equal(harnessFor("default", spec), "pi");
	assert.deepEqual(harnessesInUse({ a: "anthropic/x", b: "google/y", c: "default" }, spec).sort(), ["claude-code", "pi"]);
	assert.throws(() => parseHarnessSpec("anthropic=codex"), /unknown harness/);
	assert.throws(() => parseHarnessSpec("=pi"), /empty provider/);
});

test("routing: a harness that runs one provider refuses the other providers' roles", () => {
	const models = { implement: "google/g", controller: "default", "review.correctness": "anthropic/h", "review.quality": "openai/q" };
	const all = routingErrors(models, parseHarnessSpec("claude-code"));
	assert.equal(all.length, 2);
	assert.match(all[0], /role implement \(google\/g\) is routed to claude-code/);
	assert.match(all[1], /review\.quality/);
	assert.deepEqual(routingErrors(models, parseHarnessSpec("anthropic=claude-code")), []);
	assert.deepEqual(routingErrors(models, parseHarnessSpec("pi")), []);
	// A ref without a provider is left to the harness.
	assert.deepEqual(routingErrors({ implement: "sonnet" }, parseHarnessSpec("claude-code")), []);
});

test("isolation classes per role", () => {
	assert.equal(isolationOf("review.security"), "reviewer");
	assert.equal(isolationOf("controller"), "judge");
	assert.equal(isolationOf("master_review"), "judge");
	assert.equal(isolationOf("research"), "research");
	assert.equal(isolationOf("implement"), "implementer");
	assert.equal(isolationOf("implement_master"), "implementer");
});

test("pi flags: reviewers isolated and never trusted; research read-only and untrusted; judges tool-less", () => {
	const prompts = ["--system-prompt", "", "--append-system-prompt", ""];
	assert.deepEqual(pi.buildArgs({ isolation: "reviewer", model: "google/r1", trusted: false }), ["-p", "--no-session", "-nc", "-t", "read,grep,find,ls", "--no-approve", "-ne", "-ns", "-np", ...prompts, "--model", "google/r1"]);
	assert.ok(!pi.buildArgs({ isolation: "reviewer", model: "google/r1", trusted: true }).includes("--approve"));
	// Research is read-only and needs no project tooling: no --approve even after the gate.
	assert.deepEqual(pi.buildArgs({ isolation: "research", model: "default", trusted: true }), ["-p", "--no-session", "-t", "read,grep,find,ls", "--no-approve", "-ne", "-ns", "-np", ...prompts]);
	assert.deepEqual(pi.buildArgs({ isolation: "judge", model: "openai/d", trusted: false }), ["-p", "--no-session", "--no-tools", "--no-approve", "-ne", "-ns", "-np", ...prompts, "--model", "openai/d"]);
	// Judges decide; after the gate they still get no project extension and no .pi/APPEND_SYSTEM.md.
	assert.ok(!pi.buildArgs({ isolation: "judge", model: "openai/d", trusted: true }).includes("--approve"));
	assert.deepEqual(pi.buildArgs({ isolation: "implementer", model: "anthropic/i:high", trusted: true }), ["-p", "--no-session", "--approve", "--model", "anthropic/i:high"]);
	assert.ok(!pi.buildArgs({ isolation: "implementer", model: "anthropic/i:high", trusted: false }).includes("--approve"));
	assert.deepEqual(pi.parseOutput({ stdout: Buffer.from("plain answer") }), { text: "plain answer" });
});

test("claude flags: safe mode for reviewers and judges, permission mode by trust, model without provider", () => {
	assert.equal(claude.modelIdOf("anthropic/sonnet-4.5:high"), "sonnet-4.5");
	assert.equal(claude.modelIdOf("default"), null);
	assert.deepEqual(claude.buildArgs({ isolation: "reviewer", model: "anthropic/m", trusted: true }), ["-p", "--output-format", "json", "--model", "m", "--safe-mode", "--permission-mode", "dontAsk", "--tools", "Read", "Grep", "Glob"]);
	assert.deepEqual(claude.buildArgs({ isolation: "judge", model: "default", trusted: false }), ["-p", "--output-format", "json", "--safe-mode", "--tools", ""]);
	assert.ok(claude.buildArgs({ isolation: "implementer", model: "anthropic/m", trusted: false }).includes("acceptEdits"));
	assert.ok(claude.buildArgs({ isolation: "implementer", model: "anthropic/m", trusted: true }).includes("bypassPermissions"));
});

test("claude output: the result text out of the JSON envelope; raw text otherwise", () => {
	const out = claude.parseOutput({ stdout: Buffer.from(JSON.stringify({ type: "result", result: '{"a":1}', other: "ignored" })) });
	assert.equal(out.text, '{"a":1}');
	assert.deepEqual(claude.parseOutput({ stdout: Buffer.from("prose") }), { text: "prose" });
});

test("invokeRole through a .cmd harness in a path with a space (Windows)", { skip: process.platform !== "win32" }, async () => {
	const { mkdirSync, mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { invokeRole } = await import("../../lib/harness/adapter.mjs");
	const dir = mkdtempSync(join(tmpdir(), "adapter cmd "));
	mkdirSync(join(dir, "dir with space"));
	writeFileSync(join(dir, "dir with space", "stub.cjs"), 'const p=require("node:fs").readFileSync(0,"utf8");process.stdout.write("ran:"+p.slice(0,9)+" "+process.argv.slice(2).join(" "));');
	const cmd = join(dir, "dir with space", "pi.cmd");
	writeFileSync(cmd, '@echo off\r\nnode "%~dp0stub.cjs" %*\r\n');
	const out = join(dir, "out.txt");
	const r = await invokeRole({ spec: parseHarnessSpec("pi"), role: "implement", model: "anthropic/impl", promptText: "Implement this issue\n", outPath: out, cwd: dir, trusted: false, timeoutMs: 20000, env: { ...process.env, PIPELINE_PI_BIN: cmd } });
	assert.equal(r.status, 0, r.error ?? "");
	assert.equal(readFileSync(out, "utf8"), "ran:Implement -p --no-session --model anthropic/impl");
});

test("a Windows .cmd launch preserves the empty system-prompt overrides", { skip: process.platform !== "win32" }, async () => {
	const { mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { invokeRole } = await import("../../lib/harness/adapter.mjs");
	const dir = mkdtempSync(join(tmpdir(), "pi empty args "));
	writeFileSync(join(dir, "argv.cjs"), 'require("node:fs").readFileSync(0); process.stdout.write(JSON.stringify(process.argv.slice(2)));');
	const cmd = join(dir, "pi.cmd");
	writeFileSync(cmd, '@echo off\r\nnode "%~dp0argv.cjs" %*\r\n');
	const out = join(dir, "out.json");
	const result = await invokeRole({ spec: parseHarnessSpec("pi"), role: "review.security", model: "google/reviewer", promptText: "Review", outPath: out, cwd: dir, trusted: true, timeoutMs: 20000, env: { ...process.env, PIPELINE_PI_BIN: cmd } });
	assert.equal(result.status, 0, result.error ?? result.stderr);
	const args = JSON.parse(readFileSync(out, "utf8"));
	for (const flag of ["--system-prompt", "--append-system-prompt"]) {
		assert.ok(args.includes(flag));
		assert.equal(args[args.indexOf(flag) + 1], "");
	}
});
