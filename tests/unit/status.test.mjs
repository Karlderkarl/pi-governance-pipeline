// status.test.mjs — INV-03: the state files are the only counters, and
// `status` shows them as they are, unreadable files included.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatStatus, statusText } from "../../lib/cli/status.mjs";
import { attemptsOf, escalate, initState, loadState, readAllStates, recordAttempt } from "../../lib/state/store.mjs";

test("implement_runs counts what ran, independent of the routing counter a take_over moves", () => {
	const dir = mkdtempSync(join(tmpdir(), "takeover-"));
	const config = (max) => ({ budgets: { max_attempts_controller: max, max_runs_per_tree: 25 } });
	initState(dir, "t", config(3));
	recordAttempt(dir, "t", "t", "controller");
	escalate(dir, "t", "t", config(3));
	let a = attemptsOf(dir, "t", "t");
	assert.equal(a.controller, 3, "the implement path is exhausted by decision");
	assert.equal(a.implementRuns, 1);
	assert.equal(a.takenOver, true);
	assert.equal(loadState(dir, "t").runs_used, 1, "a take_over spends no budget");
	// The ceiling is raised afterwards and implement runs again: the count follows.
	recordAttempt(dir, "t", "t", "controller");
	assert.equal(attemptsOf(dir, "t", "t").implementRuns, 2);
	assert.match(statusText(dir), /t: open \(implement 2 then taken over, implement_master 0\)/);
});

test("a take_over after a lowered ceiling neither crashes nor lowers the routing counter", () => {
	const dir = mkdtempSync(join(tmpdir(), "takeover-low-"));
	const config = (max) => ({ budgets: { max_attempts_controller: max, max_runs_per_tree: 25 } });
	initState(dir, "t", config(3));
	for (let i = 0; i < 3; i++) recordAttempt(dir, "t", "t", "controller");
	recordAttempt(dir, "t", "t", "master");
	escalate(dir, "t", "t", config(2));
	const a = attemptsOf(dir, "t", "t");
	assert.equal(a.controller, 3);
	assert.equal(a.implementRuns, 3);
	// implement ran its full budget; the take_over on the master path cut nothing short.
	assert.equal(a.takenOver, false);
	assert.match(statusText(dir), /t: open \(implement 3, implement_master 1\)/);
});

test("a state written before implement_runs shows the routing counter for what it is", () => {
	const dir = mkdtempSync(join(tmpdir(), "legacy-"));
	mkdirSync(join(dir, "state"));
	writeFileSync(join(dir, "state", "t.json"), JSON.stringify({ root_id: "t", runs_used: 1, max_runs_per_tree: 25, depth: 0, issues: { t: { attempts_controller: 3, attempts_master: 0, status: "open" } } }));
	recordAttempt(dir, "t", "t", "master");
	const a = attemptsOf(dir, "t", "t");
	assert.equal(a.implementRuns, null, "not reconstructable, so not guessed");
	assert.match(statusText(dir), /t: open \(implement path 3, implement_master 1\)/);
	writeFileSync(join(dir, "state", "t.json"), JSON.stringify({ root_id: "t", runs_used: 1, max_runs_per_tree: 25, depth: 0, issues: { t: { attempts_controller: 1, implement_runs: -1, attempts_master: 0, status: "open" } } }));
	assert.throws(() => loadState(dir, "t"), /implement_runs/);
});

test("readAllStates reads every tree and reports an unreadable file instead of throwing", () => {
	const dir = mkdtempSync(join(tmpdir(), "status-"));
	mkdirSync(join(dir, "state"));
	writeFileSync(join(dir, "state", "issue-1.json"), JSON.stringify({ root_id: "issue-1", runs_used: 2, max_runs_per_tree: 25, depth: 1, issues: { "issue-1": { attempts_controller: 2, attempts_master: 0, status: "split" }, "issue-1.1": { attempts_controller: 1, attempts_master: 0, status: "open", parent: "issue-1", depth: 1 } } }));
	writeFileSync(join(dir, "state", "broken.json"), "{not json");
	const states = readAllStates(dir);
	assert.equal(states["issue-1"].runs_used, 2);
	assert.match(states.broken.error, /unreadable state file:.*broken\.json/);
	assert.deepEqual(readAllStates(join(dir, "nowhere")), {});
});

test("formatStatus names trees, budgets, issues and children", () => {
	const text = formatStatus({ "issue-1": { runs_used: 2, max_runs_per_tree: 25, depth: 1, issues: { "issue-1": { status: "split", attempts_controller: 2, attempts_master: 0 }, "issue-1.1": { status: "open", attempts_controller: 1, attempts_master: 0, parent: "issue-1" } } } });
	assert.match(text, /^issue-1: 2\/25 runs used, depth 1\n/);
	assert.match(text, /issue-1: split \(implement path 2, implement_master 0\)/);
	assert.match(text, /issue-1\.1: open \(implement path 1, implement_master 0, child of issue-1\)/);
	assert.match(formatStatus({}), /nothing has run/);
	assert.match(formatStatus({ t: { runs_used: 1, max_runs_per_tree: 25, depth: 0, issues: { t: { status: "open", attempts_controller: 3, implement_runs: 1, taken_over: true, attempts_master: 0 } } } }), /t: open \(implement 1 then taken over, implement_master 0\)/);
	assert.match(statusText(mkdtempSync(join(tmpdir(), "empty-"))), /nothing has run/);
});
