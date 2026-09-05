// guard.test.mjs — behavioural test for extensions/pipeline-guard.ts.
//
// The extension ships as TypeScript and imports the pi SDK and typebox at
// runtime. This test runs it under node's type stripping (node >= 22.6,
// `--experimental-strip-types`) against two stub packages, drives the
// `tool_call` handler with synthetic events in a non-interactive context, and
// asserts what is blocked and what is not. smoke.sh calls it as
//   node --experimental-strip-types tests/guard.test.mjs <repo-root> <tmp-dir>

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [root, tmp] = process.argv.slice(2);
if (!root || !tmp) {
	console.error("usage: guard.test.mjs <repo-root> <tmp-dir>");
	process.exit(1);
}

const dir = join(tmp, "guard-run");
const sdk = join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
const typebox = join(dir, "node_modules", "typebox");
mkdirSync(sdk, { recursive: true });
mkdirSync(typebox, { recursive: true });
writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
writeFileSync(join(sdk, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", exports: "./index.js" }));
writeFileSync(join(sdk, "index.js"), "export const isToolCallEventType = (name, ev) => ev.toolName === name;\n");
writeFileSync(join(typebox, "package.json"), JSON.stringify({ name: "typebox", type: "module", exports: "./index.js" }));
writeFileSync(join(typebox, "index.js"), "export const Type = { Object: (s) => s, Optional: (s) => s, String: (s) => s };\n");
copyFileSync(join(root, "extensions", "pipeline-guard.ts"), join(dir, "pipeline-guard.ts"));

const mod = await import(pathToFileURL(join(dir, "pipeline-guard.ts")).href);

function load() {
	let handler;
	const pi = {
		on(event, h) {
			if (event === "tool_call") handler = h;
		},
		registerCommand() {},
		registerTool() {},
	};
	mod.default(pi);
	if (!handler) throw new Error("extension did not register a tool_call handler");
	return handler;
}

// No UI: the guard must block rather than ask. That is the pipeline's case.
const ctx = { hasUI: false, cwd: dir, ui: { confirm: async () => true, notify() {} } };
const bash = (command) => ({ type: "tool_call", toolName: "bash", input: { command } });
const write = (path) => ({ type: "tool_call", toolName: "write", input: { path, content: "" } });

let failures = 0;
async function expect(handler, event, shouldBlock, label) {
	const r = await handler(event, ctx);
	const blocked = Boolean(r && r.block);
	if (blocked !== shouldBlock) {
		failures++;
		console.error(`guard FAIL: ${label} -> ${blocked ? "blocked" : "allowed"}${r?.reason ? ` (${r.reason})` : ""}`);
	}
}

for (const k of ["PIPELINE_UNATTENDED", "PIPELINE_ALLOW_DESTRUCTIVE", "PIPELINE_ALLOW_GOVERNANCE_WRITE"]) delete process.env[k];
process.env.PIPELINE_GUARD = "on";
let h = load();

// Reads of governance files are not writes, whatever else the line redirects.
await expect(h, bash("cat AGENTS.md 2>/dev/null"), false, "cat AGENTS.md 2>/dev/null");
await expect(h, bash("grep -n eval SOUL.md 2>&1"), false, "grep SOUL.md 2>&1");
await expect(h, bash("ls -la SOUL.md 2>&1"), false, "ls SOUL.md 2>&1");
await expect(h, bash("head -50 AGENTS.md > /tmp/x"), false, "head AGENTS.md > /tmp/x");
await expect(h, bash("cp AGENTS.md /tmp/backup"), false, "cp AGENTS.md /tmp/backup");
await expect(h, bash("cat AGENTS.md"), false, "cat AGENTS.md");
await expect(h, bash("echo hi >&2; cat MEMORY.md"), false, "echo >&2; cat MEMORY.md");

// Writes to governance files block in a non-interactive session.
await expect(h, bash("echo hi > AGENTS.md"), true, "echo > AGENTS.md");
await expect(h, bash("printf x >> SOUL.md"), true, "printf >> SOUL.md");
await expect(h, bash("echo x >'./docs/AGENTS.md'"), true, "redirect into quoted path");
await expect(h, bash("echo x > AGENTS.override.md"), true, "echo > AGENTS.override.md");
await expect(h, bash("cp x AGENTS.override.md"), true, "cp x AGENTS.override.md");
await expect(h, bash("mv tmp.md .pi/APPEND_SYSTEM.md"), true, "mv into APPEND_SYSTEM.md");
await expect(h, bash("cat x | tee docs/AGENTS.md"), true, "tee AGENTS.md");
await expect(h, bash("sed -i 's/a/b/' AGENTS.md"), true, "sed -i AGENTS.md");
await expect(h, bash("rm SOUL.md"), true, "rm SOUL.md");
await expect(h, bash("Set-Content -Path AGENTS.md -Value x"), true, "Set-Content AGENTS.md");
await expect(h, bash("echo '{}' > .pi/settings.json"), true, "redirect into .pi/settings.json");

// write/edit tools: exact governance names, the override file, project settings.
await expect(h, write("AGENTS.md"), true, "write AGENTS.md");
await expect(h, write("AGENTS.override.md"), true, "write AGENTS.override.md");
await expect(h, write(".pi/settings.json"), true, "write .pi/settings.json");
await expect(h, write("C:\\proj\\.pi\\settings.json"), true, "write .pi\\settings.json (Windows)");
await expect(h, write("src/agents.ts"), false, "write src/agents.ts");
await expect(h, write("MYAGENTS.md"), false, "write MYAGENTS.md");

// Destructive and privileged commands without a UI: blocked.
await expect(h, bash("git push --force origin main"), true, "force-push");
await expect(h, bash("gh pr merge 12"), true, "pr merge");

// Unattended: the privileged list is pre-approved, governance and destructive stay armed.
process.env.PIPELINE_UNATTENDED = "1";
h = load();
await expect(h, bash("gh pr merge 12"), false, "unattended: pr merge");
await expect(h, bash("echo x > AGENTS.md"), true, "unattended: echo > AGENTS.md");
await expect(h, bash("rm -rf build"), true, "unattended: rm -rf");
process.env.PIPELINE_ALLOW_DESTRUCTIVE = "1";
await expect(h, bash("rm -rf build"), false, "destructive allowed: rm -rf build");
// A confirmed destructive command still hits the governance gate (1.0.14 R6).
await expect(h, bash("sudo tee AGENTS.md"), true, "destructive allowed: sudo tee AGENTS.md");
process.env.PIPELINE_ALLOW_GOVERNANCE_WRITE = "1";
await expect(h, bash("echo x > AGENTS.md"), false, "governance write allowed: echo > AGENTS.md");
await expect(h, write("AGENTS.md"), false, "governance write allowed: write AGENTS.md");

if (failures > 0) {
	console.error(`guard behaviour: ${failures} assertion(s) failed`);
	process.exit(1);
}
console.log("guard behaviour OK");
