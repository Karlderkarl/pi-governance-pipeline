// INV-01, INV-03, INV-04, INV-09, INV-14, INV-15, INV-16, INV-17, INV-19,
// INV-21, INV-28: turn the independent review's real-Git reproductions into
// assertions about released work, actual model starts and persisted state.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cases as first } from "../../docs/review-2026-09-08.repro.mjs";
import { cases as second } from "../../docs/review-2026-09-08-2.repro.mjs";

test("F01: failed reviewers with non-contiguous blocking severities cannot fill the panel", async () => {
	const r = await first["failed-reviewers"]();
	assert.equal(r.approved, false);
	assert.equal(r.reviewersUsed, 0);
	assert.equal(r.verdict, "blocked");
});
test("F02: concurrent API runs spend at most one reserved attempt", async () => {
	const r = await first["concurrent-budget"]();
	assert.equal(r.implementationCalls, 1);
	assert.equal(r.runsUsed, 1);
	assert.ok(r.exitCodes.includes(1));
});
test("F03: grandchildren execute once under their original root budget", async () => {
	const r = await first["deep-split"]();
	assert.equal(r.rc, 0);
	assert.deepEqual(r.calls, ["one.1.1: leaf A", "one.1.2: leaf B"]);
	assert.equal(r.rootRuns, 2);
	assert.equal(r.extraTree, null);
});
test("F04: an earlier contributor cannot review retained code after escalation", async () => {
	const r = await first["escalation-self-review"]();
	assert.equal(r.originalModelReviewedRetainedCode, false);
	assert.equal(r.approved, true);
	assert.ok(r.committedPaths.includes("from-first-model.txt"));
});
test("F05: malformed finding arrays cannot become empty approving reviews", async () => {
	const r = await first["malformed-findings"]();
	assert.equal(r.exit, 4);
	assert.equal(r.result.reviewers_used, 0);
});
test("F06: an explicit null no_self_review is a contract error", async () => {
	const r = await first["null-constraint"]();
	assert.ok(r.errors.some((e) => /no_self_review.*null/.test(e)));
});
test("F07: relocated governance is absent from both review and approval commit", async () => {
	const r = await first["relocated-governance"]();
	assert.equal(r.rc, 0);
	assert.equal(r.reviewIncludesGovernance, false);
	assert.deepEqual(r.committedPaths, ["tasks.md", "work.txt"]);
});
test("F08: closing one leaves the one extra ticket open", async () => {
	assert.equal((await first["issue-prefix"]()).tasks, "- [ ] one extra: another issue\n- [x] one: selected issue\n");
});
test("F09: damaged state fails doctor and status reports an actionable error", async () => {
	const r = await first["corrupt-state"]();
	assert.ok(r.doctorFails > 0);
	assert.match(r.status, /ERROR:.*one\.json/);
	assert.doesNotMatch(r.status, /undefined/);
});
test("F10: init refuses an unapplied harness change", async () => {
	const r = await first["init-harness-change"]();
	assert.equal(r.rc, 1);
	assert.equal(r.unchanged, true);
});
test("F11: truncated content cannot reach an approval commit", async () => {
	const r = await second["truncated-but-committed"]();
	assert.equal(r.rc, 1);
	assert.equal(r.manifestNamesTruncatedFiles, true);
	assert.equal(r.approved, false);
	assert.equal(r.markerIsInTheApprovalCommit, false);
});
test("F12: writing a Git hook stops the run, removes the hook and never executes it", async () => {
	const r = await second["git-hook-escape"]();
	assert.equal(r.rc, 1);
	assert.equal(r.approved, false);
	assert.equal(r.hookStillOnDiskAfterTheRun, false);
	assert.equal(r.hookExecutedByTheApprovalCommit, false);
});
test("F13: a model cannot reduce its reserved budget counters", async () => {
	const r = await second["budget-state-writable"]();
	assert.equal(r.rc, 1);
	assert.equal(r.actualImplementationCalls, 1);
	assert.equal(r.runsUsedRecordedInState, 1);
});
