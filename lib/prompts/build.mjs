// build.mjs — one prompt per role, assembled from the harness-owned template
// text under templates/ and the run's data. Every prompt gets the issue, the
// relevant governance excerpt, and nothing else it does not need. The fixed
// preambles (untrusted-input framing, severity definitions, output schemas)
// are text files so they can be reviewed as text; projects cannot override
// them — project context reaches the roles through SOUL.md.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { blockerHistory } from "../loop/blocker.mjs";
import { countLines, excerpt, tailLines } from "../util/text.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cache = new Map();

export function template(name) {
	if (!cache.has(name)) cache.set(name, readFileSync(join(here, "templates", `${name}.md`), "utf8").replace(/\r\n/g, "\n").replace(/\n$/, ""));
	return cache.get(name);
}

const fill = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] === undefined ? "" : String(vars[k])));

export function buildResearchPrompt({ issueLine, soulFile, memoryFile, issueId, historyMax, historyMaxBytes }) {
	const history = blockerHistory(memoryFile, issueId, historyMax, historyMaxBytes);
	return fill(template("research"), { issue: issueLine, soul: excerpt(soulFile, 120) }) + (history ? `\n${history}` : "");
}

// Gate findings (findingsFile) are never displaced: they are why the retry
// exists. Tool output in exclusionsFile is capped — a chatty linter must not
// push a critical finding out of the window. tail, not head, for the tool log.
export function buildImplementPrompt({
	issueLine,
	researchFile,
	exclusionsText,
	exclusionsMaxLines,
	attemptsLeft,
	findingsText,
	issueId,
	soulFile,
	memoryFile,
	historyMax,
	historyMaxBytes,
}) {
	let findings = "";
	if (findingsText && findingsText.trim() !== "") {
		findings = `Review findings from earlier attempts. Repeating any of them fails again:\n${findingsText.replace(/\n$/, "")}`;
	}
	let excl = "";
	if (exclusionsText && exclusionsText.trim() !== "") {
		let body = "Tool output from earlier attempts (lint/tests/empty diff):\n";
		if (countLines(exclusionsText) > exclusionsMaxLines) body += `[older blocks omitted — newest ${exclusionsMaxLines} lines kept]\n`;
		body += tailLines(exclusionsText, exclusionsMaxLines);
		excl = body.replace(/\n$/, "");
	}
	const history = issueId ? blockerHistory(memoryFile, issueId, historyMax, historyMaxBytes) : "";
	const sections = [history, findings, excl].filter((s) => s && s.trim() !== "").map((s) => `${s.replace(/\n$/, "")}\n\n`);
	const plural = attemptsLeft === 1 ? "" : "s";
	return fill(template("implement"), {
		issue: issueLine,
		research: excerpt(researchFile, 200),
		soul: excerpt(soulFile, 120),
		sections: sections.join(""),
		attempts: `${attemptsLeft} attempt${plural}`,
	});
}

export function buildReviewPrompt({ focus, issueLine, diffText, soulFile }) {
	return fill(template("review"), { focus, issue: issueLine, soul: excerpt(soulFile, 120), diff: diffText.replace(/\n$/, "") });
}

export const REVIEW_REMINDER = "\n\nREMINDER: your previous output was not parseable. Emit ONLY the JSON object — no prose, no code fence.";

export function buildControllerPrompt({ blocking, reviewersJson }) {
	return fill(template("controller"), { blocking, reviewers: reviewersJson.replace(/\n$/, "") });
}

export function buildMasterPrompt({ issueLine, diffText, reviewersJson, controllerText, gateJson, independenceNote, attempt, splitAllowed }) {
	const outcomes = ["- approve: no blocking findings and the diff resolves the issue", "- reject: back to implementation; list what must change", "- take_over: the approach itself is wrong; a stronger model implements the next attempt fresh from the issue"];
	let schema = '{"decision":"approve|reject|take_over","reasons":["..."]}';
	if (splitAllowed) {
		outcomes.push("- split: the issue is too large for one diff; name two to five sub-issues, each with a title and a text, and they replace this issue");
		schema = '{"decision":"approve|reject|take_over|split","reasons":["..."],"issues":[{"title":"...","text":"..."}]}';
	}
	return fill(template("master_review"), {
		issue: issueLine,
		diff: diffText.replace(/\n$/, ""),
		reviewers: reviewersJson.replace(/\n$/, ""),
		controller: controllerText.replace(/\n$/, ""),
		gate: gateJson.replace(/\n$/, ""),
		independence: independenceNote,
		attempt,
		outcomes: outcomes.join("\n"),
		schema,
	});
}
