// gate.mjs — severity-based review gate. Reads reviewer JSON files, merges
// the findings, and decides. No vote count, no percentage: over three
// reviewers a percentage collapses into unanimity and hides that it did.

import { readFileSync } from "node:fs";
import { KNOWN_SEVERITY, extractJson, rankOf, severityOf } from "./reviewer-output.mjs";

export function parseSeverityList(flag, raw) {
	if (raw == null) throw new Error(`${flag} needs a comma-separated list`);
	const list = [];
	for (const token of String(raw).split(",")) {
		const item = token.trim().toLowerCase();
		if (!KNOWN_SEVERITY.has(item)) {
			throw new Error(`${flag} contains unknown severity (${token.trim() || token}); expected critical, high, medium, low`);
		}
		list.push(item);
	}
	return list;
}

const brief = (f) => ({
	file: f.file ?? "-",
	line: f.line ?? "-",
	title: f.title ?? "",
	severity: f.severity,
	role: f.role,
});

// files: reviewer output paths. Returns { result, exit } where exit is 0
// (clear) or 4 (blocked). A panel below the floor is not an approval:
// gating on too little is not a gate.
export function runGate({ files, blocking = ["critical", "high"], followup = ["medium", "low"], minReviewers = 1 }) {
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
			const title = typeof finding.title === "string" ? finding.title : JSON.stringify(finding.title ?? "");
			const key = `${finding.file ?? "-"}:${finding.line ?? "-"}:${title.toLowerCase()}`;
			const next = { ...finding, role };
			const prev = seen.get(key);
			if (prev) {
				// Same location+title from two reviewers: keep the higher severity.
				// First-seen would let a later critical lose to an earlier low.
				if (rankOf(prev) >= rankOf(next)) continue;
				findings[findings.indexOf(prev)] = next;
				seen.set(key, next);
				continue;
			}
			seen.set(key, next);
			findings.push(next);
		}
	}

	const unknownFindings = findings.filter((f) => !KNOWN_SEVERITY.has(severityOf(f)));
	// A known severity that the config lists nowhere is not "neither": it
	// blocks, like an unknown one. `--blocking critical --followup low` must
	// not let a high pass because nobody wrote it down. The contract
	// validator refuses such lists up front; this is the runtime half.
	const unlistedFindings = findings.filter(
		(f) => KNOWN_SEVERITY.has(severityOf(f)) && !blocking.includes(severityOf(f)) && !followup.includes(severityOf(f)),
	);
	const blockingFindings = findings.filter(
		(f) => blocking.includes(severityOf(f)) || !KNOWN_SEVERITY.has(severityOf(f)) || !followup.includes(severityOf(f)),
	);
	const followupFindings = findings.filter(
		(f) => KNOWN_SEVERITY.has(severityOf(f)) && followup.includes(severityOf(f)) && !blocking.includes(severityOf(f)),
	);

	const used = files.length - unavailable.length;
	const result = {
		// Every reviewer unreadable — or a panel below the floor — is reported
		// as blocked, matching the exit code: a "clear" verdict here would tell
		// the master the gate passed when it did not.
		verdict: blockingFindings.length > 0 || used < minReviewers ? "blocked" : "clear",
		reviewers_used: used,
		reviewers_unavailable: unavailable,
		min_reviewers: minReviewers,
		blocking: blockingFindings,
		followups: followupFindings,
		unknown_severity: unknownFindings.map(brief),
		unlisted_severity: unlistedFindings.map(brief),
	};
	return { result, exit: used < minReviewers || result.verdict === "blocked" ? 4 : 0 };
}

// The gate JSON written when every reviewer was dropped before running.
export function allDroppedGate(minReviewers, reason = "all dropped by no_self_review") {
	return {
		verdict: "blocked",
		reviewers_used: 0,
		reviewers_unavailable: [reason],
		min_reviewers: minReviewers,
		blocking: [],
		followups: [],
		unknown_severity: [],
		unlisted_severity: [],
	};
}
