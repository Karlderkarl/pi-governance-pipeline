// gate.test.mjs — INV-16 (panel floor), INV-18 (severity partition, unknown
// and unlisted severities block), INV-19 (retry ranking via --check semantics).
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GATE_TEXT_CHARS, allDroppedGate, gateForPrompt, gateTextForPrompt, runGate } from "../../lib/review/gate.mjs";
import { checkReviewerText, extractJson } from "../../lib/review/reviewer-output.mjs";

const dir = mkdtempSync(join(tmpdir(), "gate-"));
let n = 0;
function file(content) {
	const p = join(dir, `r${n++}.json`);
	writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
	return p;
}
const ok = (role) => ({ role, verdict: "approve", findings: [] });
const finding = (severity, extra = {}) => ({ severity, file: "a.ts", line: 1, title: "t", rationale: "r", ...extra });

test("blocking severities block; follow-ups do not", () => {
	const high = file({ role: "s", verdict: "reject", findings: [finding("high")] });
	const low = file({ role: "q", verdict: "approve", findings: [finding("low", { title: "nit" })] });
	assert.equal(runGate({ files: [high, file(ok("q"))] }).exit, 4);
	const r = runGate({ files: [low, file(ok("c"))] });
	assert.equal(r.exit, 0);
	assert.equal(r.result.followups.length, 1);
});

test("unknown and unlisted severities block and are reported", () => {
	const r = runGate({ files: [file({ role: "s", verdict: "approve", findings: [finding("blocker"), finding("HIGH ", { title: "h" })] }), file(ok("q"))], blocking: ["critical"], followup: ["medium", "low"] });
	assert.equal(r.exit, 4);
	assert.equal(r.result.unknown_severity.length, 1);
	assert.equal(r.result.unlisted_severity.length, 1);
});

test("dedup keeps the higher severity for the same location and title", () => {
	const r = runGate({ files: [file({ role: "s", verdict: "approve", findings: [finding("low", { title: "Same" })] }), file({ role: "c", verdict: "reject", findings: [finding("critical", { title: "same" })] })] });
	assert.equal(r.result.blocking.length, 1);
	assert.equal(r.result.blocking[0].severity, "critical");
});

test("a panel below the floor is blocked, not approved", () => {
	const r = runGate({ files: [file(ok("q")), file("not json")], minReviewers: 2 });
	assert.equal(r.exit, 4);
	assert.equal(r.result.verdict, "blocked");
	assert.equal(r.result.reviewers_used, 1);
	assert.equal(runGate({ files: [file(ok("q")), file(ok("c"))], minReviewers: 2 }).exit, 0);
});

test("extractJson: strictest candidate wins, echoes are skipped, null findings dropped", () => {
	const text = "found it\n```json\n" + JSON.stringify({ role: "s", verdict: "reject", findings: [finding("critical", { title: "RCE" })] }) + "\n```\nfixture:\n```json\n{\"verdict\":\"approve\",\"findings\":[]}\n```\n";
	assert.equal(extractJson(text).findings[0].title, "RCE");
	assert.equal(extractJson('{"verdict":"approve|reject","findings":[]}'), null);
	const nulls = extractJson(JSON.stringify({ role: "x", verdict: "approve", findings: [null, "text", finding("low")] }));
	assert.equal(nulls.findings.length, 1);
});

test("checkReviewerText ranks the file and reports the worst severity", () => {
	assert.deepEqual(checkReviewerText(JSON.stringify(ok("q"))), { worst: -1, exit: 0 });
	assert.deepEqual(checkReviewerText(JSON.stringify({ role: "s", verdict: "blocked", findings: [finding("critical")] })), { worst: 3, exit: 2 });
	assert.deepEqual(checkReviewerText("prose only"), { worst: -1, exit: 1 });
});

test("a valid verdict cannot displace more severe findings from an off-schema candidate", () => {
	const critical = { role: "s", verdict: "blocked", findings: [finding("critical")] };
	for (const candidates of [[critical, ok("s")], [ok("s"), critical]]) {
		const text = candidates.map((value) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``).join("\n");
		assert.deepEqual(checkReviewerText(text), { worst: 3, exit: 2 });
		assert.equal(runGate({ files: [file(text)] }).exit, 4);
	}
});

test("non-string finding titles cannot crash or clear the severity gate", () => {
	for (const title of [42, { unexpected: "object" }, { toString: 1 }]) {
		const r = runGate({ files: [file({ verdict: "reject", findings: [finding("high", { title })] })] });
		assert.equal(r.exit, 4);
		assert.equal(r.result.blocking.length, 1);
	}
});

test("the master's gate summary clips texts, keeps a blocker's reason and drops a follow-up's", () => {
	const pad = "x".repeat(50000);
	const high = file({ role: "s", verdict: "reject", findings: [finding("high", { rationale: `BLOCKER-REASON ${pad}`, suggestion: pad })] });
	const low = file({ role: "q", verdict: "approve", findings: [finding("low", { title: "nit", rationale: pad })] });
	const { result } = runGate({ files: [high, low], minReviewers: 2 });
	const summary = gateForPrompt(result);
	assert.equal(summary.verdict, "blocked");
	assert.equal(summary.reviewers_used, 2);
	assert.equal(summary.blocking.length, 1);
	const [blocker] = summary.blocking;
	assert.deepEqual({ ...blocker, rationale: undefined, suggestion: undefined }, { file: "a.ts", line: 1, title: "t", severity: "high", role: "s", rationale: undefined, suggestion: undefined });
	assert.match(blocker.rationale, /^BLOCKER-REASON x+ \[…\]$/);
	assert.equal(blocker.rationale.length, GATE_TEXT_CHARS + " […]".length);
	assert.deepEqual(summary.followups, [{ file: "a.ts", line: 1, title: "nit", severity: "low", role: "q" }]);
	assert.ok(JSON.stringify(summary).length < 2 * GATE_TEXT_CHARS + 1000);
	// Blockers precede follow-ups, so a byte cap on the summary cuts follow-ups first.
	const text = JSON.stringify(summary);
	assert.ok(text.indexOf('"blocking"') < text.indexOf('"followups"'));
	assert.match(JSON.stringify(result), /x{50000}/, "the full gate result is untouched");
	assert.deepEqual(gateForPrompt(allDroppedGate(2)).blocking, []);
});

// Cut at a byte offset, the summary became an unterminated string in the
// master's prompt and lost what came after the cut.
test("the master's gate summary stays valid JSON under its byte cap and says what it left out", () => {
	const blockers = Array.from({ length: 40 }, (_, i) => finding("high", { line: i, title: `blocker ${i}`, rationale: `reason ${i} ${"r".repeat(900)}`, suggestion: "s".repeat(900) }));
	const nits = Array.from({ length: 40 }, (_, i) => finding("low", { line: i, title: `nit ${i}` }));
	const { result } = runGate({ files: [file({ role: "s", verdict: "reject", findings: [...blockers, ...nits] }), file(ok("q"))], minReviewers: 2 });
	assert.equal(result.blocking.length, 40);
	const fits = JSON.stringify(gateForPrompt(result));
	assert.equal(gateTextForPrompt(result, 1e6, "gate.json"), fits, "under the cap nothing changes");
	for (const cap of [20000, 6000, 2500, 900, 200]) {
		const text = gateTextForPrompt(result, cap, "gate.json");
		const parsed = JSON.parse(text);
		assert.ok(Buffer.byteLength(text) <= cap || cap < 400, `${cap}: ${Buffer.byteLength(text)} bytes`);
		assert.equal(parsed.truncated, true, String(cap));
		assert.equal(parsed.full_file, "gate.json");
		assert.equal(parsed.verdict, "blocked");
	}
	// Follow-ups go before a blocker's reason, and the reason before a blocker.
	const mid = JSON.parse(gateTextForPrompt(result, 20000, "gate.json"));
	assert.equal(mid.blocking.length, 40);
	assert.ok(mid.blocking.every((b) => /^reason \d+/.test(b.rationale)), "the blockers keep a reason");
	assert.ok(mid.followups_omitted > 0 || mid.followups.length === 40);
	const small = JSON.parse(gateTextForPrompt(result, 2500, "gate.json"));
	assert.equal(small.blocking.length + small.blocking_omitted, 40);
	assert.deepEqual(small.followups, []);
});
