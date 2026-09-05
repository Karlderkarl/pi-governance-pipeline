// exec.test.mjs — INV-29 (a timeout ends the process tree and returns within
// the grace period) and INV-23's launch path: extensionless scripts by
// shebang, .cmd through cmd.exe with a quoted line, never shell: true.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EXIT_GRACE_MS, findOnPath, isWindows, quoteForCmd, resolveCommand, spawnCapture } from "../../lib/util/exec.mjs";

test("quoteForCmd leaves flags and model refs alone and quotes paths with spaces", () => {
	assert.equal(quoteForCmd("--no-session"), "--no-session");
	assert.equal(quoteForCmd("anthropic/opus-4.5:high"), "anthropic/opus-4.5:high");
	assert.equal(quoteForCmd("read,grep,find,ls"), "read,grep,find,ls");
	assert.equal(quoteForCmd("C:\\dir with space\\pi.cmd"), '"C:\\dir with space\\pi.cmd"');
	assert.equal(quoteForCmd(""), '""');
});

test("resolveCommand: .mjs runs under node, .cmd through cmd.exe, a node shebang under node", () => {
	const dir = mkdtempSync(join(tmpdir(), "exec-"));
	const mjs = join(dir, "stub.mjs");
	writeFileSync(mjs, "process.stdout.write('ok')");
	assert.deepEqual(resolveCommand("x", mjs), { file: process.execPath, args: [mjs] });
	const cmd = join(dir, "dir with space", "pi.cmd");
	mkdirSync(join(dir, "dir with space"));
	writeFileSync(cmd, "@echo off\r\necho ARGS:%*\r\n");
	const c = resolveCommand("pi", cmd);
	assert.deepEqual(c.args, ["/d", "/s", "/c"]);
	assert.equal(c.cmdScript, cmd);
	assert.ok(/cmd(\.exe)?$/i.test(c.file));
	const shim = join(dir, "pi");
	writeFileSync(shim, "#!/usr/bin/env node\nprocess.stdout.write('shim')\n");
	assert.deepEqual(resolveCommand("pi", shim), { file: process.execPath, args: [shim] });
	assert.equal(resolveCommand("no-such-binary-xyz", undefined, { PATH: dir }), null);
});

test("findOnPath on Windows prefers .exe, then a shebang shim, then .cmd", { skip: !isWindows }, () => {
	const dir = mkdtempSync(join(tmpdir(), "path-"));
	writeFileSync(join(dir, "tool.cmd"), "@echo off\r\n");
	writeFileSync(join(dir, "tool"), "#!/usr/bin/env node\n");
	assert.equal(findOnPath("tool", { PATH: dir }), join(dir, "tool"));
	writeFileSync(join(dir, "tool.exe"), "");
	assert.equal(findOnPath("tool", { PATH: dir }), join(dir, "tool.exe"));
});

test("a .cmd in a directory with a space launches and receives its arguments", { skip: !isWindows }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "exec space "));
	mkdirSync(join(dir, "dir with space"));
	const cmd = join(dir, "dir with space", "pi.cmd");
	writeFileSync(cmd, "@echo off\r\necho ARGS:%*\r\n");
	const c = resolveCommand("pi", cmd);
	const r = await spawnCapture({ ...c, args: [...c.args, "-p", "--no-session", "--model", "a/b:high"] }, { stdin: "", timeoutMs: 20000 });
	assert.equal(r.status, 0, r.stderr.toString());
	assert.match(r.stdout.toString(), /ARGS:-p --no-session --model a\/b:high/);
});

test("a timeout ends the process tree and returns within the grace period", async () => {
	const dir = mkdtempSync(join(tmpdir(), "exec-timeout-"));
	// The child starts a grandchild that inherits stdout and outlives it.
	const script = join(dir, "hang.mjs");
	writeFileSync(
		script,
		`import { spawn } from "node:child_process";
const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { stdio: ["ignore", "inherit", "inherit"] });
g.on("exit", () => process.exit(0));
setTimeout(() => {}, 8000);
`,
	);
	const t0 = Date.now();
	const r = await spawnCapture({ file: process.execPath, args: [script] }, { stdin: "", timeoutMs: 500 });
	const elapsed = Date.now() - t0;
	assert.equal(r.timedOut, true);
	assert.ok(elapsed < 500 + EXIT_GRACE_MS + 2500, `took ${elapsed} ms`);
});
