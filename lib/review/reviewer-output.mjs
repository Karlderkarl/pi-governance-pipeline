// reviewer-output.mjs — recovering a reviewer's JSON from what a model wrote.
//
// Reviewers wrap the object in prose or fences despite instructions. Recover
// findings; never regex prose into a verdict. Two stages, because they catch
// different mistakes: the prompt shows `"verdict":"approve|reject"` inline,
// so an echo is recognised by the pipe in that word, not by failing the
// approve|reject check — that check is only whether the reviewer gets a retry.
// Severity decides the gate; a schema-conformant critical with verdict
// "blocked" must still block. That is also why candidates are ranked by their
// worst finding rather than by position — see extractJson.

export const KNOWN_SEVERITY = new Set(["critical", "high", "medium", "low"]);
export const RANK = { critical: 3, high: 2, medium: 1, low: 0 };

export function tryParseObject(candidate) {
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	try {
		return JSON.parse(candidate.slice(start, end + 1));
	} catch {
		return null;
	}
}

export const isEcho = (o) => String(o?.verdict ?? "").includes("|");

export function isVerdict(o) {
	return !!o && Array.isArray(o.findings) && ["approve", "reject"].includes(String(o.verdict ?? "").trim().toLowerCase());
}

export const severityOf = (f) => String(f?.severity ?? "").trim().toLowerCase();
// Unknown ranks above critical so a synonym cannot lose to a later "low".
export const rankOf = (f) => (KNOWN_SEVERITY.has(severityOf(f)) ? RANK[severityOf(f)] : 4);

// The strictest object wins, not the last — the same direction as the master
// verdict. Position is not a safe key: a reviewer that judges correctly and
// then quotes a JSON object out of the diff to explain itself would lose its
// own verdict, and the quoted object's empty findings array would clear the
// gate. The key is the worst finding carried, not the verdict word, because
// that is what the gate scores: a reviewer may write "approve" and still
// report a critical, and that critical must block. An appended object can
// therefore only displace the real one by carrying strictly more severe
// findings, which cannot lower the outcome. Ties keep the first within each
// schema tier; a valid verdict wins a cross-tier tie, never a lower severity.
export const worstRank = (o) => o.findings.reduce((max, f) => Math.max(max, rankOf(f)), -1);
const stricter = (a, b) => (worstRank(b) > worstRank(a) ? b : a);

export function jsonCandidates(text) {
	const candidates = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
	candidates.push(text);
	return candidates;
}

export function extractJson(text) {
	let verdict = null;
	let shaped = null;
	for (const candidate of jsonCandidates(text)) {
		const parsed = tryParseObject(candidate);
		if (!parsed || isEcho(parsed)) continue;
		// A finding is an object. `null` or a bare string in the array would
		// throw in the merge and end the gate with a stack trace.
		if (Array.isArray(parsed.findings)) {
			parsed.findings = parsed.findings.filter((f) => f && typeof f === "object" && !Array.isArray(f));
		}
		if (isVerdict(parsed)) verdict = verdict ? stricter(verdict, parsed) : parsed;
		// Same rule for the fallback tier: a reviewer whose real object carries
		// an off-schema verdict word ("blocked") lands here, and an appended
		// quote must not empty it either.
		else if (Array.isArray(parsed.findings)) shaped = shaped ? stricter(shaped, parsed) : parsed;
	}
	// Schema quality is a retry hint, never a reason to discard a stronger
	// finding. Prefer the valid verdict only when its severity is no lower.
	return verdict && shaped ? stricter(verdict, shaped) : verdict ?? shaped;
}

// --check semantics: rank the file so the pipeline retry cannot overwrite a
// usable original with worse output. exit 0 = stage-1 verdict (retry not
// needed), 2 = findings without a valid word (retry, but keep this if the
// retry is worse), 1 = nothing the gate can use. `worst` is the worst
// severity rank the file holds (-1 none, 0 low .. 3 critical, 4 unknown) so
// the caller can refuse a retry that parses better but carries less.
export function checkReviewerText(text) {
	let parsed = null;
	try {
		parsed = extractJson(text);
	} catch {
		parsed = null;
	}
	const usable = parsed && Array.isArray(parsed.findings);
	return {
		worst: usable ? worstRank(parsed) : -1,
		exit: isVerdict(parsed) ? 0 : usable ? 2 : 1,
	};
}
