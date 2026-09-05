// blocker.mjs — an abort is never silent: mark the issue, write the blocker
// to MEMORY.md, tell a human. The next research and implement prompts for
// that issue receive the last N blocker entries, capped in bytes.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { setIssueStatus } from "../state/store.mjs";
import { isoDate } from "../util/text.mjs";

// Last `max` MEMORY.md blocker entries for this issue, newest last, capped at
// `maxBytes` (newest text kept). The state file already skips blocked issues;
// this is the content the next pass needs so it does not repeat the same
// failed approach blindly.
export function blockerHistory(memoryFile, issueId, max = 5, maxBytes = 16384) {
	if (!memoryFile || !existsSync(memoryFile) || max <= 0) return "";
	const text = readFileSync(memoryFile, "utf8");
	const chunks = text.split(/^## /m);
	const prefix = `Blocker — ${issueId}`;
	const hits = chunks.filter((c) => c === prefix || c.startsWith(`${prefix} `) || c.startsWith(`${prefix}(`) || c.startsWith(`${prefix}\n`));
	const last = hits.slice(-max);
	if (last.length === 0) return "";
	let body = `${last.map((c) => `## ${c.trimEnd()}`).join("\n\n")}\n`;
	if (Buffer.byteLength(body) > maxBytes) {
		const buf = Buffer.from(body);
		body = `[older blocker text omitted — newest ${maxBytes} bytes kept]\n${buf.subarray(buf.length - maxBytes).toString()}`;
	}
	return `Prior blockers for this issue (newest last):\n\n${body}`;
}

// The first argument is the tree root. Passing the issue id twice would, on a
// split, create a new state file with its own budget instead of marking the
// sub-issue in the parent tree.
export function blockIssue({ pipelineDir, root, issueId, reason, memoryFile, stderr = process.stderr }) {
	try {
		setIssueStatus(pipelineDir, root, issueId, "blocked");
	} catch {}
	// The reason carries the tail of a tool log; a line starting with `#`
	// there would read as a new MEMORY.md section and cut the blocker in two
	// for blockerHistory. Escaped as Markdown does it, it renders unchanged.
	const body = reason
		.split("\n")
		.map((line) => (line.startsWith("#") ? `\\${line}` : line))
		.join("\n");
	appendFileSync(memoryFile, `\n## Blocker — ${issueId} (${isoDate()})\n\n${body}\n`);
	stderr.write(`blocked: ${issueId} — written to ${memoryFile}\n`);
}
