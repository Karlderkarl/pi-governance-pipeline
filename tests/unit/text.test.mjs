// text.test.mjs — INV-27: the tool output that re-enters a prompt is capped in
// a way that keeps what a test runner says last, and INV-05: a gate log keeps
// both its head and its tail.
import assert from "node:assert/strict";
import { test } from "node:test";
import { headTail, sanitizeIssueId, tailLines } from "../../lib/util/text.mjs";

test("headTail keeps the first and the last lines and names the cut", () => {
	const lines = Array.from({ length: 300 }, (_, i) => `line-${i + 1}`);
	const out = headTail(`${lines.join("\n")}\n`, 20, 60);
	const got = out.split("\n");
	assert.equal(got.length, 81);
	assert.equal(got[0], "line-1");
	assert.equal(got[19], "line-20");
	assert.equal(got[20], "[… 220 lines omitted …]");
	assert.equal(got[21], "line-241");
	assert.equal(got[80], "line-300");
	assert.equal(headTail("a\nb\nc\n", 20, 60), "a\nb\nc");
	assert.equal(headTail("a\r\nb\r\n", 1, 1), "a\nb");
});

test("tailLines and sanitizeIssueId stay as they were", () => {
	assert.equal(tailLines("a\nb\nc\n", 2), "b\nc");
	assert.equal(sanitizeIssueId("feat/login: x"), "feat-login--x");
});
