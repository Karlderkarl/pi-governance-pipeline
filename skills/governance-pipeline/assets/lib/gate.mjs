#!/usr/bin/env node
// gate.mjs — severity-based review gate. Reads reviewer JSON files, merges the
// findings, and decides. No vote count, no percentage: over three reviewers a
// percentage collapses into unanimity and hides that it did.
//
//   node gate.mjs --blocking critical,high [--followup medium,low] [--min-reviewers N] r1.json r2.json r3.json
//   node gate.mjs --check r1.json   -> exit 0 = parseable reviewer JSON, 1 = not
//
// stdout: merged JSON. Exit 0 = clear, 4 = blocked, 1 = usage error.
// --min-reviewers (default 1): a panel shrunk below the floor — reviewers
// dropped by no_self_review or lost to unparseable output — blocks instead of
// approving. One opinion is not a review panel.

import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
let blocking = ["critical", "high"];
let followup = ["medium", "low"];
let minReviewers = 1;
let checkOnly = false;
const files = [];

for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--blocking") blocking = argv[++i].split(",").map((s) => s.trim());
	else if (argv[i] === "--followup") followup = argv[++i].split(",").map((s) => s.trim());
	else if (argv[i] === "--min-reviewers") minReviewers = Number(argv[++i]);
	else if (argv[i] === "--check") checkOnly = true;
	else files.push(argv[i]);
}
if (!Number.isInteger(minReviewers) || minReviewers < 1) minReviewers = 1;
if (files.length === 0 || (checkOnly && files.length !== 1)) {
	process.stderr.write(
		"usage: gate.mjs [--blocking a,b] [--followup c,d] [--min-reviewers n] <reviewer.json>...\n       gate.mjs --check <reviewer.json>\n",
	);
	process.exit(1);
}

// Reviewers sometimes wrap the object in prose or fences despite instructions.
// Recover the object; never regex prose into a verdict.
function extractJson(text) {
	const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
	const candidate = fenced ? fenced[1] : text;
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	try {
		return JSON.parse(candidate.slice(start, end + 1));
	} catch {
		return null;
	}
}

// --check mode: is this one file a parseable reviewer object? The pipeline
// uses it to decide whether a reviewer gets its single retry.
if (checkOnly) {
	let ok = false;
	try {
		const parsed = extractJson(readFileSync(files[0], "utf8"));
		ok = !!parsed && Array.isArray(parsed.findings);
	} catch {
		ok = false;
	}
	process.exit(ok ? 0 : 1);
}

const unavailable = [];
const findings = [];
const seen = new Set();

for (const file of files) {
	let parsed = null;
	try {
		parsed = extractJson(readFileSync(file, "utf8"));
	} catch (error) {
		parsed = null;
	}
	if (!parsed || !Array.isArray(parsed.findings)) {
		unavailable.push(file);
		continue;
	}
	const role = parsed.role ?? file;
	for (const finding of parsed.findings) {
		const key = `${finding.file ?? "-"}:${finding.line ?? "-"}:${(finding.title ?? "").toLowerCase()}`;
		if (seen.has(key)) continue;
		seen.add(key);
		findings.push({ ...finding, role });
	}
}

const blockingFindings = findings.filter((f) => blocking.includes(String(f.severity).toLowerCase()));
const followupFindings = findings.filter((f) => followup.includes(String(f.severity).toLowerCase()));

const result = {
	// Every reviewer unreadable — or a panel below the floor — is reported as
	// blocked, matching the exit code: a "clear" verdict here would tell the
	// master the gate passed when it did not.
	verdict: blockingFindings.length > 0 || files.length - unavailable.length < minReviewers ? "blocked" : "clear",
	reviewers_used: files.length - unavailable.length,
	reviewers_unavailable: unavailable,
	min_reviewers: minReviewers,
	blocking: blockingFindings,
	followups: followupFindings,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
// A panel below the floor is not an approval. Gating on too little is not a gate.
if (result.reviewers_used < minReviewers) process.exit(4);
process.exit(result.verdict === "blocked" ? 4 : 0);
