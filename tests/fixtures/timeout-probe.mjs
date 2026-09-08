// INV-29: time one role directly, excluding unrelated pipeline/Git work.
import assert from "node:assert/strict";
import { join } from "node:path";
import { invokeRole, parseHarnessSpec } from "../../lib/harness/adapter.mjs";

const [root, binary] = process.argv.slice(2);
assert.ok(root && binary, "expected project and hanging stub paths");
const start = performance.now();
const result = await invokeRole({ spec: parseHarnessSpec("pi"), role: "review.security", model: "google/security",
	promptText: "You review a diff\n", outPath: join(root, ".pipeline", "timeout-probe.answer"), cwd: root,
	trusted: false, timeoutMs: 1000, env: { ...process.env, PIPELINE_PI_BIN: binary } });
const elapsed = performance.now() - start;
assert.equal(result.status, 124);
assert.ok(elapsed < 10000, `role timeout waited ${Math.round(elapsed)}ms for a 20-second descendant`);
console.log(`timeout process-tree probe OK: ${Math.round(elapsed)}ms`);
