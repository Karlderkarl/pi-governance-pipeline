// prompts.test.mjs — properties of the rendered prompts, not their wording.
// INV-02 (no sibling verdicts, no panel size, no model names in a reviewer
// prompt), INV-06 (split schema only when allowed), INV-27 (findings and tool
// output sections), and the untrusted-input framing.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildControllerPrompt, buildImplementPrompt, buildMasterPrompt, buildResearchPrompt, buildReviewPrompt, template } from "../../lib/prompts/build.mjs";

const dir = mkdtempSync(join(tmpdir(), "prompts-"));
const soul = join(dir, "SOUL.md");
writeFileSync(soul, "# Soul\nNever use eval.\n");
const memory = join(dir, "MEMORY.md");
writeFileSync(memory, "## Blocker — issue-1 (2026-01-01)\n\nprior-token\n");
const research = join(dir, "research.md");
writeFileSync(research, "notes\n");

test("reviewer prompt: one concern, untrusted framing, standards, diff, schema; nothing about the panel", () => {
	const p = buildReviewPrompt({ focus: "security", issueLine: "issue-1: x", diffText: "+++ b/a.ts\n", soulFile: soul });
	assert.ok(p.startsWith("You review a diff for one concern only: security"));
	assert.match(p, /untrusted input/);
	assert.match(p, /Never use eval/);
	assert.match(p, /"role":"security"/);
	assert.doesNotMatch(p, /Panel independence|controller|master|implement_master|three reviewers/i);
});

test("implement prompt: attempts left in words, sections separated by one blank line, findings before tool output", () => {
	const base = { issueLine: "issue-1: x", researchFile: research, exclusionsMaxLines: 3, issueId: "issue-1", soulFile: soul, memoryFile: memory, historyMax: 5, historyMaxBytes: 16384 };
	const one = buildImplementPrompt({ ...base, exclusionsText: "", attemptsLeft: 1, findingsText: "" });
	assert.ok(one.startsWith("Implement this issue test-first"));
	assert.match(one, /\nNever use eval\.\n\nPrior blockers for this issue/);
	assert.match(one, /prior-token/);
	assert.match(one, /\n\nYou have 1 attempt left\./);
	const many = buildImplementPrompt({ ...base, exclusionsText: "l1\nl2\nl3\nl4\nl5\n", attemptsLeft: 3, findingsText: "- high in a.ts (RCE).\n" });
	assert.match(many, /You have 3 attempts left/);
	assert.match(many, /Review findings from earlier attempts[^]*RCE[^]*Tool output from earlier attempts/);
	assert.match(many, /\[older blocks omitted — newest 3 lines kept\]\nl3\nl4\nl5\n\nYou have/);
	assert.doesNotMatch(many, /\n\n\n/);
});

test("research prompt carries the blocker history after the stack excerpt", () => {
	const p = buildResearchPrompt({ issueLine: "issue-1: x", soulFile: soul, memoryFile: memory, issueId: "issue-1", historyMax: 5, historyMaxBytes: 16384 });
	assert.ok(p.startsWith("Gather context for this issue"));
	assert.match(p, /Never use eval\.\nPrior blockers/);
});

test("controller and master prompts; split appears only when allowed", () => {
	const c = buildControllerPrompt({ blocking: "critical,high", reviewersJson: '{"a":1}\n' });
	assert.ok(c.startsWith("Merge these reviewer JSON objects"));
	assert.match(c, /blocking: critical,high/);
	const base = { issueLine: "issue-1: x", diffText: "d\n", reviewersJson: "{}", controllerText: "{}", gateJson: '{"verdict":"clear"}', independenceNote: "Panel independence: every reviewer ran on an explicitly mapped model.", attempt: 2 };
	const m = buildMasterPrompt({ ...base, splitAllowed: false });
	assert.ok(m.startsWith("Decide this attempt"));
	assert.match(m, /"decision":"approve\|reject\|take_over"/);
	assert.doesNotMatch(m, /split/);
	const s = buildMasterPrompt({ ...base, splitAllowed: true });
	assert.match(s, /- split:/);
	assert.match(s, /"decision":"approve\|reject\|take_over\|split"/);
	assert.match(s, /Attempt 2\./);
});

test("templates are text files the harness owns", () => {
	for (const name of ["research", "implement", "review", "controller", "master_review"]) assert.ok(template(name).length > 40, name);
	assert.match(template("review"), /untrusted input/);
});
