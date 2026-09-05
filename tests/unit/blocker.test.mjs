// blocker.test.mjs — INV-07: a blocker entry in MEMORY.md stays one entry,
// whatever the tool log it carries looks like, and INV-27: the history fed
// back is the whole entry, newest last.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { blockIssue, blockerHistory } from "../../lib/loop/blocker.mjs";

test("a `#` line inside the reason does not cut the blocker in two", () => {
	const dir = mkdtempSync(join(tmpdir(), "blocker-"));
	mkdirSync(join(dir, "state"));
	writeFileSync(join(dir, "state", "issue-1.json"), JSON.stringify({ root_id: "issue-1", runs_used: 1, max_runs_per_tree: 25, depth: 0, issues: { "issue-1": { attempts_controller: 1, attempts_master: 0, status: "open" } } }));
	const memory = join(dir, "MEMORY.md");
	writeFileSync(memory, "# MEMORY\n\n## Decisions\n\nnone yet\n");
	const chunks = [];
	blockIssue({ pipelineDir: dir, root: "issue-1", issueId: "issue-1", reason: "Rejected twice.\n\nLast tool output:\n## FAIL tests/x.test.js\n### expected 1\n  got 2\nend of log", memoryFile: memory, stderr: { write: (s) => chunks.push(s) } });
	const text = readFileSync(memory, "utf8");
	assert.match(text, /\n## Blocker — issue-1 \(\d{4}-\d{2}-\d{2}\)\n\nRejected twice\.\n\nLast tool output:\n\\## FAIL tests\/x\.test\.js\n\\### expected 1\n  got 2\nend of log\n$/);
	const history = blockerHistory(memory, "issue-1", 5, 16384);
	assert.match(history, /Rejected twice/);
	assert.match(history, /FAIL tests\/x\.test\.js/);
	assert.match(history, /end of log/);
	assert.doesNotMatch(history, /Decisions/);
	assert.equal(JSON.parse(readFileSync(join(dir, "state", "issue-1.json"), "utf8")).issues["issue-1"].status, "blocked");
	assert.match(chunks.join(""), /blocked: issue-1/);
});
