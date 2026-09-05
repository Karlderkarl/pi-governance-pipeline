// master-decision.mjs — the master's verdict, parsed fail-closed.
//
// Anything that is not a parseable decision counts as reject. Never grep
// prose for a verdict. Same shape as the reviewer parser: every fence, then
// raw text, every candidate parsed. The strictest decision wins, not the
// last: take_over > reject > approve. Echoing the prompt example costs
// nothing — its decision field reads "approve|reject|take_over", which is not
// a valid word and never a candidate. A stray stricter value does cost an
// attempt; that is the cheap direction. approve is the consequential output
// and the diff sits inside the prompt, so a fragment appended after the real
// object must never upgrade the verdict.
//
// `split` is consequential in its own way (it creates issues and spends the
// tree budget on them), so it is accepted only when it is the sole parseable
// decision and well-formed. Any ambiguity turns it into a reject with a note.
// Sub-issue titles and texts come from a model that has read the diff and
// the issue — untrusted input, like everything else the master saw — and are
// normalised before they can reach the issue source: one line, bounded
// length, two to five of them.

import { jsonCandidates } from "./reviewer-output.mjs";

const RANK = { approve: 0, reject: 1, take_over: 2 };
export const MIN_SPLIT_ISSUES = 2;
export const MAX_SPLIT_ISSUES = 5;
export const MAX_TITLE_LENGTH = 120;
export const MAX_TEXT_LENGTH = 4000;

function parseCandidate(cand) {
	const s = cand.indexOf("{");
	const e = cand.lastIndexOf("}");
	if (s === -1 || e <= s) return null;
	try {
		return JSON.parse(cand.slice(s, e + 1));
	} catch {
		return null;
	}
}

// One line, single spaces, bounded. A title that is a checkbox line in
// disguise cannot become one: the issue source writes it after `<id>: `.
export function normalizeTitle(value) {
	return String(value ?? "")
		.replace(/[\r\n\t\f\v\u2028\u2029]+/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim()
		.slice(0, MAX_TITLE_LENGTH);
}

export function normalizeText(value) {
	return typeof value === "string" ? value.replace(/\r/g, "").slice(0, MAX_TEXT_LENGTH) : "";
}

function wellFormedSplit(obj) {
	if (!Array.isArray(obj.issues)) return false;
	if (obj.issues.length < MIN_SPLIT_ISSUES || obj.issues.length > MAX_SPLIT_ISSUES) return false;
	return obj.issues.every((i) => i && typeof i === "object" && normalizeTitle(i.title) !== "");
}

// Returns { decision, reasons, split, note }. `decision` is one of
// approve | reject | take_over | split.
export function parseMasterDecision(text) {
	let d = null;
	let reasons = [];
	let splitObj = null;
	// The raw text is also a candidate, so one fenced object parses twice;
	// count distinct split objects, not occurrences.
	const splitSeenSet = new Set();
	let others = 0;
	for (const cand of jsonCandidates(text ?? "")) {
		const obj = parseCandidate(cand);
		if (!obj) continue;
		// Trimmed like the reviewer verdict: `" approve "` is a decision, not a
		// reject that costs the attempt.
		const v = String(obj.decision || "").trim().toLowerCase();
		if (v === "split") {
			splitSeenSet.add(JSON.stringify(obj));
			if (!splitObj) splitObj = obj;
			continue;
		}
		if (!Object.hasOwn(RANK, v)) continue;
		others++;
		if (d === null || RANK[v] > RANK[d]) {
			d = v;
			reasons = Array.isArray(obj.reasons) ? obj.reasons.map(String) : [];
		}
	}
	if (splitObj) {
		const splitSeen = splitSeenSet.size;
		if (others === 0 && splitSeen === 1 && wellFormedSplit(splitObj)) {
			return {
				decision: "split",
				reasons: Array.isArray(splitObj.reasons) ? splitObj.reasons.map(String) : [],
				split: splitObj.issues.map((i) => ({ title: normalizeTitle(i.title), text: normalizeText(i.text) })),
				note: null,
			};
		}
		const note =
			others > 0
				? "split ignored: the output also carried another decision; the strictest of those applies"
				: splitSeen > 1
					? "split ignored: more than one split object in the output"
					: `split ignored: it needs an issues list with ${MIN_SPLIT_ISSUES} to ${MAX_SPLIT_ISSUES} entries that each carry a title`;
		return { decision: d ?? "reject", reasons, split: null, note };
	}
	return { decision: d ?? "reject", reasons, split: null, note: null };
}
