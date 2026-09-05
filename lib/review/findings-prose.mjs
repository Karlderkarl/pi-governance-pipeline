// findings-prose.mjs — gate findings as prose: file + title/rationale, never
// line numbers. implement_master does not receive the diff, so file:line
// would be unresolvable; a symbol or context in the title is what it can use.

import { existsSync, readFileSync } from "node:fs";

export function findingsToProse(gate) {
	let g = gate;
	if (typeof gate === "string") {
		if (!existsSync(gate)) return "";
		try {
			g = JSON.parse(readFileSync(gate, "utf8"));
		} catch {
			return "";
		}
	}
	if (!g || typeof g !== "object") return "";
	const blocking = g.blocking || [];
	const followups = g.followups || [];
	if (blocking.length === 0 && followups.length === 0) return "";
	const line = (f) => {
		const where = f.file || "unknown file";
		const title = f.title || "finding";
		const why = f.rationale ? ` ${f.rationale}` : "";
		const sug = f.suggestion ? ` Suggestion: ${f.suggestion}` : "";
		return `- ${f.severity || "unknown"} in ${where} (${title}).${why}${sug}`;
	};
	let out = "";
	if (blocking.length) out += `Blocking findings:\n${blocking.map(line).join("\n")}\n`;
	if (followups.length) out += `Follow-up findings:\n${followups.map(line).join("\n")}\n`;
	return out;
}
