#!/usr/bin/env node
// gate.mjs — severity-based review gate. Reads reviewer JSON files, merges the
// findings, and decides. No vote count, no percentage: over three reviewers a
// percentage collapses into unanimity and hides that it did.
//
//   node gate.mjs --blocking critical,high [--followup medium,low] [--min-reviewers N] r1.json r2.json r3.json
//   node gate.mjs --check r1.json   -> exit 0 = usable verdict, 2 = findings without
//                                      a valid verdict word, 1 = nothing usable
//
// stdout: merged JSON. Exit 0 = clear, 4 = blocked, 1 = usage error.
// --check also uses 2 (see above); 2 is not a gate verdict.
// --min-reviewers (default 1): a panel shrunk below the floor — reviewers
// dropped by no_self_review or lost to unparseable output — blocks instead of
// approving. One opinion is not a review panel.

import { readFileSync } from "node:fs";

// Known before argv so a typo in --blocking/--followup cannot empty the
// panel by silently dropping every finding of an unrecognised severity.
const KNOWN_SEVERITY = new Set(["critical", "high", "medium", "low"]);
const RANK = { critical: 3, high: 2, medium: 1, low: 0 };

const argv = process.argv.slice(2);
let blocking = ["critical", "high"];
let followup = ["medium", "low"];
let minReviewers = 1;
let checkOnly = false;
const files = [];

function usage(message) {
	if (message) process.stderr.write(`error: ${message}\n`);
	process.stderr.write(
		"usage: gate.mjs [--blocking a,b] [--followup c,d] [--min-reviewers n] <reviewer.json>...\n       gate.mjs --check <reviewer.json>\n",
	);
	process.exit(1);
}

function parseSeverityList(flag, raw) {
	if (raw == null) usage(`${flag} needs a comma-separated list`);
	const list = [];
	for (const token of String(raw).split(",")) {
		const item = token.trim().toLowerCase();
		if (!KNOWN_SEVERITY.has(item)) {
			usage(`${flag} contains unknown severity (${token.trim() || token}); expected critical, high, medium, low`);
		}
		list.push(item);
	}
	return list;
}

for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--blocking") blocking = parseSeverityList("--blocking", argv[++i]);
	else if (argv[i] === "--followup") followup = parseSeverityList("--followup", argv[++i]);
	else if (argv[i] === "--min-reviewers") {
		const raw = argv[++i];
		minReviewers = Number(raw);
		// A typo must not quietly lower the floor to 1 — that would approve
		// a panel the caller thought was still gated.
		if (!Number.isInteger(minReviewers) || minReviewers < 1) {
			usage(`--min-reviewers must be an integer >= 1 (got ${raw})`);
		}
	} else if (argv[i] === "--check") checkOnly = true;
	else if (argv[i].startsWith("--")) usage(`unknown flag: ${argv[i]}`);
	else files.push(argv[i]);
}
if (files.length === 0 || (checkOnly && files.length !== 1)) usage();

// Reviewers wrap the object in prose or fences despite instructions. Recover
// findings; never regex prose into a verdict. Two stages, because they catch
// different mistakes: the prompt shows `"verdict":"approve|reject"` inline,
// so an echo is recognised by the pipe in that word, not by failing the
// approve|reject check — that check is only whether the reviewer gets a retry.
// Severity decides the gate; a schema-conformant critical with verdict "blocked"
// must still block. That is also why candidates are ranked by their worst
// finding rather than by position — see extractJson.
function tryParseObject(candidate) {
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	try {
		return JSON.parse(candidate.slice(start, end + 1));
	} catch {
		return null;
	}
}

const isEcho = (o) => String(o?.verdict ?? "").includes("|");

function isVerdict(o) {
	return (
		!!o &&
		Array.isArray(o.findings) &&
		["approve", "reject"].includes(String(o.verdict ?? "").trim().toLowerCase())
	);
}

// The strictest object wins, not the last — the same direction as the master
// verdict in auto-develop.sh. Position is not a safe key: a reviewer that
// judges correctly and then quotes a JSON object out of the diff to explain
// itself would lose its own verdict, and the quoted object's empty findings
// array would clear the gate. That is reachable from this repo's own diffs,
// which carry dozens of `{"verdict":"approve","findings":[]}` fixtures into
// every reviewer prompt.
//
// The key is the worst finding carried, not the verdict word, because that is
// what the gate scores further down: a reviewer may write "approve" and still
// report a critical, and that critical must block. Ranking by the word would
// let an appended `{"verdict":"reject","findings":[]}` drop it. An appended
// object can therefore only displace the real one by carrying strictly more
// severe findings, which cannot lower the outcome. Ties keep the first, so the
// leading prompt template stays powerless even when isEcho misses it.
const worstRank = (o) =>
	o.findings.reduce((max, f) => {
		const severity = String(f.severity ?? "").trim().toLowerCase();
		// Unknown ranks above critical, as it does in the merge below.
		return Math.max(max, KNOWN_SEVERITY.has(severity) ? RANK[severity] : 4);
	}, -1);
const stricter = (a, b) => (worstRank(b) > worstRank(a) ? b : a);

function extractJson(text) {
	const candidates = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
	candidates.push(text);
	let verdict = null;
	let shaped = null;
	for (const candidate of candidates) {
		const parsed = tryParseObject(candidate);
		if (!parsed || isEcho(parsed)) continue;
		// A finding is an object. `null` or a bare string in the array would
		// throw in the merge below and end the gate with a stack trace.
		if (Array.isArray(parsed.findings)) {
			parsed.findings = parsed.findings.filter((f) => f && typeof f === "object" && !Array.isArray(f));
		}
		if (isVerdict(parsed)) verdict = verdict ? stricter(verdict, parsed) : parsed;
		// Same rule for the fallback tier: a reviewer whose real object carries an
		// off-schema verdict word ("blocked") lands here, and an appended quote
		// must not empty it either.
		else if (Array.isArray(parsed.findings)) shaped = shaped ? stricter(shaped, parsed) : parsed;
	}
	return verdict ?? shaped;
}

// --check ranks the file so the pipeline retry cannot overwrite a usable
// original with worse output. 0 = stage-1 verdict (retry not needed),
// 2 = findings without a valid word (retry, but keep this if the retry is worse),
// 1 = nothing the gate can use. stdout carries the worst severity rank the
// file holds (-1 none, 0 low .. 3 critical, 4 unknown) so the caller can
// refuse a retry that parses better but carries less.
if (checkOnly) {
	let parsed = null;
	try {
		parsed = extractJson(readFileSync(files[0], "utf8"));
	} catch {
		parsed = null;
	}
	const usable = parsed && Array.isArray(parsed.findings);
	process.stdout.write(`${usable ? worstRank(parsed) : -1}\n`);
	if (isVerdict(parsed)) process.exit(0);
	process.exit(usable ? 2 : 1);
}

const severityOf = (f) => String(f.severity ?? "").trim().toLowerCase();
// Unknown ranks above critical so a synonym cannot lose to a later "low".
const rank = (f) => (KNOWN_SEVERITY.has(severityOf(f)) ? RANK[severityOf(f)] : 4);

const unavailable = [];
const findings = [];
const seen = new Map();

for (const file of files) {
	let parsed = null;
	try {
		parsed = extractJson(readFileSync(file, "utf8"));
	} catch {
		parsed = null;
	}
	// extractJson already requires a findings array; keep the check so a
	// future edit cannot count a parsed non-reviewer as a panel member.
	if (!parsed || !Array.isArray(parsed.findings)) {
		unavailable.push(file);
		continue;
	}
	const role = parsed.role ?? file;
	for (const finding of parsed.findings) {
		const key = `${finding.file ?? "-"}:${finding.line ?? "-"}:${(finding.title ?? "").toLowerCase()}`;
		const next = { ...finding, role };
		const prev = seen.get(key);
		if (prev) {
			// Same location+title from two reviewers: keep the higher severity.
			// First-seen would let a later critical lose to an earlier low.
			if (rank(prev) >= rank(next)) continue;
			findings[findings.indexOf(prev)] = next;
			seen.set(key, next);
			continue;
		}
		seen.set(key, next);
		findings.push(next);
	}
}

const unknownFindings = findings.filter((f) => !KNOWN_SEVERITY.has(severityOf(f)));
// A known severity that the config lists nowhere is not "neither": it blocks,
// like an unknown one. `--blocking critical --followup low` must not let a
// high pass because nobody wrote it down. The contract validator refuses
// such lists up front; this is the runtime half of the same rule.
const unlistedFindings = findings.filter(
	(f) => KNOWN_SEVERITY.has(severityOf(f)) && !blocking.includes(severityOf(f)) && !followup.includes(severityOf(f)),
);
const blockingFindings = findings.filter(
	(f) => blocking.includes(severityOf(f)) || !KNOWN_SEVERITY.has(severityOf(f)) || !followup.includes(severityOf(f)),
);
const followupFindings = findings.filter(
	(f) => KNOWN_SEVERITY.has(severityOf(f)) && followup.includes(severityOf(f)) && !blocking.includes(severityOf(f)),
);

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
	unknown_severity: unknownFindings.map((f) => ({
		file: f.file ?? "-",
		line: f.line ?? "-",
		title: f.title ?? "",
		severity: f.severity,
		role: f.role,
	})),
	unlisted_severity: unlistedFindings.map((f) => ({
		file: f.file ?? "-",
		line: f.line ?? "-",
		title: f.title ?? "",
		severity: f.severity,
		role: f.role,
	})),
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
// A panel below the floor is not an approval. Gating on too little is not a gate.
if (result.reviewers_used < minReviewers) process.exit(4);
process.exit(result.verdict === "blocked" ? 4 : 0);
