// patterns.mjs — what the interactive guard recognises. Kept out of the
// extension so the table can be unit-tested and so the governance names come
// from the one list in lib/integrity/governance-paths.mjs.
//
// This is a speed bump, not a sandbox. Patterns match the command string the
// agent typed: `rm -rf "$HOME"`, `eval`, `bash -c`, and runtime-constructed
// commands slip through. The pipeline itself checks governance integrity by
// snapshot, not by regex; the guard is for the interactive session.

import { GUARD_PATHS, guardMatches } from "../integrity/governance-paths.mjs";

// Always armed, including unattended runs, unless PIPELINE_ALLOW_DESTRUCTIVE=1.
export const DESTRUCTIVE = [
	{ pattern: /\bgit\s+push\b[^\n]*\s(--force|-f)\b/, reason: "force-push" },
	{ pattern: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\b/, reason: "recursive delete" },
	{ pattern: /\bRemove-Item\b[^\n]*\s-(Recurse|r)\b/i, reason: "recursive delete" },
	{ pattern: /\bsudo\b/, reason: "privilege escalation" },
	{ pattern: /\bStart-Process\b[^\n]*\s-Verb\s+RunAs\b/i, reason: "privilege escalation" },
];

export const PRIVILEGED = [
	{ pattern: /\bgit\s+push\b[^\n]*\b(main|master)\b/, reason: "push to a protected branch" },
	{ pattern: /\bgit\s+reset\s+--hard\b/, reason: "hard reset (discards work)" },
	{ pattern: /\bgit\s+clean\b[^\n]*\s-[a-zA-Z]*[fd]/, reason: "git clean (discards untracked files)" },
	{ pattern: /\bgh\s+pr\s+merge\b/, reason: "pull request merge" },
	{ pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba|z|da)?sh\b/, reason: "piping a download into a shell" },
	{ pattern: /\bnpm\s+publish\b|\bpi\s+install\b/, reason: "package publish or install" },
];

const GOV_ALT = GUARD_PATHS.map((g) => g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
// One governance path as a shell word: optional quote, optional directory
// prefix, the name, optional quote. Group 1 is the name.
const GOV_TOKEN = `["']?(?:[^\\s"'|;&<>]*/)?(${GOV_ALT})["']?`;
const END = `(?=\\s|$|[;|&)])`;
// The governance file has to be the *target* of the write. A governance name
// anywhere near a `>` used to count, which blocked `cat AGENTS.md 2>/dev/null`
// in every non-interactive child — a read, on the path the roles need most.
export const WRITE_PATTERNS = [
	// redirection into the file; `2>/dev/null` and `>&2` have other targets
	new RegExp(`(?:^|[^0-9])>>?\\s*${GOV_TOKEN}${END}`),
	new RegExp(`(?:^|[\\s;|&(])tee\\b[^|;&]*?\\s${GOV_TOKEN}${END}`),
	new RegExp(`(?:^|[\\s;|&(])sed\\b[^|;&]*?\\s-[a-zA-Z]*i\\b[^|;&]*?\\s${GOV_TOKEN}${END}`),
	// perl -pi / -i.bak edits in place like sed -i; `perl -ne print AGENTS.md` is a read
	new RegExp(`(?:^|[\\s;|&(])perl\\b[^|;&]*?\\s-[a-zA-Z]*i\\b[^|;&]*?\\s${GOV_TOKEN}${END}`),
	// mv/cp/ln/install write their last argument; `cp AGENTS.md /tmp/backup` is a read
	new RegExp(`(?:^|[\\s;|&(])(?:mv|cp|ln|install)\\s+(?:\\S+\\s+)+${GOV_TOKEN}\\s*(?:$|[;|&)])`),
	new RegExp(`(?:^|[\\s;|&(])rm\\b[^|;&]*?\\s${GOV_TOKEN}${END}`),
	new RegExp(`(?:^|[\\s;|&(])truncate\\b[^|;&]*?\\s${GOV_TOKEN}${END}`),
	// dd writes to of=; `dd if=AGENTS.md of=/tmp/backup` is a read
	new RegExp(`(?:^|[\\s;|&(])dd\\b[^|;&]*?\\sof=${GOV_TOKEN}${END}`),
	new RegExp(
		`(?:^|[\\s;|&(])(?:Set-Content|Add-Content|Out-File|Move-Item|Copy-Item|Remove-Item)\\b[^|;&]*?\\s${GOV_TOKEN}${END}`,
		"i",
	),
];

export function shellWritesGovernance(command) {
	for (const re of WRITE_PATTERNS) {
		const m = re.exec(command);
		if (m) return m[1];
	}
	return undefined;
}

export function governancePath(path) {
	return guardMatches(path);
}
