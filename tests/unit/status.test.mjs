// status.test.mjs — INV-03: the state files are the only counters, and
// `status` shows them as they are, unreadable files included.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatStatus, statusText } from "../../lib/cli/status.mjs";
import { readAllStates } from "../../lib/state/store.mjs";

test("readAllStates reads every tree and reports an unreadable file instead of throwing", () => {
	const dir = mkdtempSync(join(tmpdir(), "status-"));
	mkdirSync(join(dir, "state"));
	writeFileSync(join(dir, "state", "issue-1.json"), JSON.stringify({ root_id: "issue-1", runs_used: 2, max_runs_per_tree: 25, depth: 1, issues: { "issue-1": { attempts_controller: 2, attempts_master: 0, status: "split" }, "issue-1.1": { attempts_controller: 1, attempts_master: 0, status: "open", parent: "issue-1", depth: 1 } } }));
	writeFileSync(join(dir, "state", "broken.json"), "{not json");
	const states = readAllStates(dir);
	assert.equal(states["issue-1"].runs_used, 2);
	assert.deepEqual(states.broken, { error: "unreadable state file" });
	assert.deepEqual(readAllStates(join(dir, "nowhere")), {});
});

test("formatStatus names trees, budgets, issues and children", () => {
	const text = formatStatus({ "issue-1": { runs_used: 2, max_runs_per_tree: 25, depth: 1, issues: { "issue-1": { status: "split", attempts_controller: 2, attempts_master: 0 }, "issue-1.1": { status: "open", attempts_controller: 1, attempts_master: 0, parent: "issue-1" } } } });
	assert.match(text, /^issue-1: 2\/25 runs used, depth 1\n/);
	assert.match(text, /issue-1: split \(controller 2, master 0\)/);
	assert.match(text, /issue-1\.1: open \(controller 1, master 0, child of issue-1\)/);
	assert.match(formatStatus({}), /nothing has run/);
	assert.match(statusText(mkdtempSync(join(tmpdir(), "empty-"))), /nothing has run/);
});
