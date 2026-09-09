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
	return !!o && !o.invalidFindings && Array.isArray(o.findings) && ["approve", "reject"].includes(String(o.verdict ?? "").trim().toLowerCase());
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

// A model that writes one object as free text and another in a fence used to
// lose the free one: the only candidate that could hold it was the whole text,
// and `tryParseObject` cuts that from the first `{` to the last `}` — across
// both objects, which never parses. So free-standing objects are candidates
// too, found independently of the prose around them.
//
// Independence is the whole point, and a single pass that carries brace and
// quote state through the text does not have it: `if (authorized) {` in a
// sentence opens a level the real object then nests inside, and one unmatched
// `"` swallows its braces. Either one hid a reviewer's critical behind a
// fenced approve again. Every `{` is therefore its own start with fresh state.
// A start that yields no parseable JSON costs a scan and nothing else;
// a parsed span is skipped, so nested objects are not re-read as candidates.
const MAX_OBJECT_STARTS = 512;

// Index of the `}` closing the object that opens at `from`, or -1.
function objectEnd(text, from) {
	let depth = 0;
	let inString = false;
	for (let i = from; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (c === "\\") i++;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') inString = true;
		else if (c === "{") depth++;
		else if (c === "}" && --depth === 0) return i;
	}
	return -1;
}

function parsedObjects(text) {
	const found = [];
	let starts = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== "{") continue;
		if (++starts > MAX_OBJECT_STARTS) return { found, limited: true };
		const end = objectEnd(text, i);
		if (end === -1) continue;
		const body = text.slice(i, end + 1);
		if (tryParseObject(body) === null) continue;
		found.push({ body, start: i, end });
		i = end;
	}
	return { found, limited: false };
}

export function jsonCandidates(text) {
	const candidates = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
	candidates.push(...parsedObjects(text).found.map((o) => o.body));
	candidates.push(text);
	return [...new Set(candidates)];
}

// Parsing an object is not the same as consuming its evidence. The caller
// identifies the objects whose key it actually handles; null explicitly
// exempts a schema echo. Nested keys in any other object remain unprocessed.
// A bounded scan also refuses approval when it runs out of starts.
export function hasUnprocessedJsonKey(text, key, consumedOwners) {
	const { found, limited } = parsedObjects(text);
	if (limited) return true;
	const remaining = [];
	let cursor = 0;
	for (const { body, start, end } of found) {
		const root = tryParseObject(body);
		const owners = consumedOwners(root);
		if (owners !== null) {
			const pending = [root];
			while (pending.length) {
				const value = pending.pop();
				if (!value || typeof value !== "object") continue;
				if (Object.hasOwn(value, key) && !owners.has(value)) return true;
				for (const child of Object.values(value)) pending.push(child);
			}
		}
		remaining.push(text.slice(cursor, start));
		cursor = end + 1;
	}
	remaining.push(text.slice(cursor));
	// Decode JSON keys too: an escaped spelling such as seve\u0072ity carries
	// the same evidence. String values inside handled objects are already gone.
	for (const [token] of remaining.join(" ").matchAll(/"(?:\\[\s\S]|[^"\\])*"\s*:/g)) {
		try {
			if (JSON.parse(token.slice(0, -1).trim()) === key) return true;
		} catch { /* An invalid quoted token is not a JSON key. */ }
	}
	return false;
}

const isFinding = (value) => value && typeof value === "object" && !Array.isArray(value);
const reviewFindings = (object) => Array.isArray(object.findings) ? object.findings : Object.hasOwn(object, "severity") ? [object] : [];

// Unknown severity intentionally blocks in every configured severity partition.
// Keeping this as evidence carries it through failed processes, clean retries,
// the gate and the master without depending on how many panel seats remain.
// Not a code-quality finding: it is addressed to the reviewer, and the gate
// and the loop recognise it by this exact severity.
export const UNPROCESSED_SEVERITY = "unprocessed_review";

const unprocessedFinding = () => ({
	severity: UNPROCESSED_SEVERITY,
	file: "-",
	title: "Reviewer evidence could not be fully processed",
	rationale: "A severity was not consumed or the JSON scan limit was reached. Return complete review JSON; this attempt cannot be approved.",
});

export function extractJson(text) {
	let verdict = null;
	let shaped = null;
	const evidence = [];
	let invalid = false;
	for (const candidate of jsonCandidates(text)) {
		let parsed = tryParseObject(candidate);
		if (!parsed || isEcho(parsed)) continue;
		// A complete finding inside an unfinished review is still evidence,
		// but its missing review envelope cannot supply a valid panel seat.
		const standalone = !Array.isArray(parsed.findings) && Object.hasOwn(parsed, "severity");
		if (standalone) parsed = { verdict: "reject", findings: reviewFindings(parsed) };
		// A finding is an object. `null` or a bare string in the array would
		// throw in the merge and end the gate with a stack trace.
		if (Array.isArray(parsed.findings)) {
			parsed.invalidFindings = standalone || parsed.findings.some((f) => !isFinding(f));
			parsed.findings = parsed.findings.filter(isFinding);
			evidence.push(...parsed.findings);
			invalid ||= parsed.invalidFindings;
		}
		if (isVerdict(parsed)) verdict = verdict ? stricter(verdict, parsed) : parsed;
		// Same rule for the fallback tier: a reviewer whose real object carries
		// an off-schema verdict word ("blocked") lands here, and an appended
		// quote must not empty it either.
		else if (Array.isArray(parsed.findings)) shaped = shaped ? stricter(shaped, parsed) : parsed;
	}
	// Schema quality is a retry hint, never a reason to discard a stronger
	// finding. Prefer the valid verdict only when its severity is no lower.
	const selected = verdict && shaped ? stricter(verdict, shaped) : verdict ?? shaped;
	// Selection determines schema/retry metadata only. Every candidate's evidence
	// survives, including blockers in a custom (non-monotonic) severity partition.
	const unreached = hasUnprocessedJsonKey(text, "severity", (object) =>
		isEcho(object) ? null : new Set(reviewFindings(object).filter(isFinding)));
	if (unreached) evidence.push(unprocessedFinding());
	return selected || unreached ? {
		...(selected ?? { verdict: "reject" }),
		findings: [...new Map(evidence.map((f) => [JSON.stringify(f), f])).values()],
		invalidFindings: invalid || unreached,
	} : null;
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
