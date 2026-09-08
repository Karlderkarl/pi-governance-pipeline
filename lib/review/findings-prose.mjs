// findings-prose.mjs — gate findings as prose: file + title/rationale, never
// line numbers. implement_master does not receive the diff, so file:line
// would be unresolvable; a symbol or context in the title is what it can use.

import { existsSync, readFileSync } from "node:fs";

function readGate(gate) {
	if (typeof gate !== "string") return gate && typeof gate === "object" ? gate : null;
	if (!existsSync(gate)) return null;
	try {
		return JSON.parse(readFileSync(gate, "utf8"));
	} catch {
		return null;
	}
}

const line = (f) => {
	const where = f.file || "unknown file";
	const title = f.title || "finding";
	const why = f.rationale ? ` ${f.rationale}` : "";
	const sug = f.suggestion ? ` Suggestion: ${f.suggestion}` : "";
	return `- ${f.severity || "unknown"} in ${where} (${title}).${why}${sug}`;
};

// The follow-up findings alone, as list lines. An approval records them in
// MEMORY.md: gate.json lives under the gitignored .pipeline/, so it is not
// where a human looks for what the project still owes.
export function followupsToProse(gate) {
	const g = readGate(gate);
	const followups = g?.followups ?? [];
	return followups.length ? `${followups.map(line).join("\n")}\n` : "";
}

export function findingsToProse(gate) {
	const g = readGate(gate);
	if (!g) return "";
	const blocking = g.blocking || [];
	const followups = g.followups || [];
	if (blocking.length === 0 && followups.length === 0) return "";
	let out = "";
	if (blocking.length) out += `Blocking findings:\n${blocking.map(line).join("\n")}\n`;
	if (followups.length) out += `Follow-up findings:\n${followups.map(line).join("\n")}\n`;
	return out;
}
