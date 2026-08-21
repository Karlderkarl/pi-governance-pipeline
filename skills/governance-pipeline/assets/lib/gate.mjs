#!/usr/bin/env node
// gate.mjs — severity-based review gate. Reads reviewer JSON files, merges the
// findings, and decides. No vote count, no percentage: over three reviewers a
// percentage collapses into unanimity and hides that it did.
//
//   node gate.mjs --blocking critical,high [--followup medium,low] r1.json r2.json r3.json
//
// stdout: merged JSON. Exit 0 = clear, 4 = blocked, 1 = usage error.

import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
let blocking = ["critical", "high"];
let followup = ["medium", "low"];
const files = [];

for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--blocking") blocking = argv[++i].split(",").map((s) => s.trim());
	else if (argv[i] === "--followup") followup = argv[++i].split(",").map((s) => s.trim());
	else files.push(argv[i]);
}
if (files.length === 0) {
	process.stderr.write("usage: gate.mjs [--blocking a,b] [--followup c,d] <reviewer.json>...\n");
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
	verdict: blockingFindings.length > 0 ? "blocked" : "clear",
	reviewers_used: files.length - unavailable.length,
	reviewers_unavailable: unavailable,
	blocking: blockingFindings,
	followups: followupFindings,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
// Every reviewer unreadable is not an approval. Gating on nothing is not a gate.
if (result.reviewers_used === 0) process.exit(4);
process.exit(result.verdict === "blocked" ? 4 : 0);
