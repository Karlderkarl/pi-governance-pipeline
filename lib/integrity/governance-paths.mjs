// governance-paths.mjs — the one list of paths the pipeline must never
// treat as implementation.
//
// Four places used to carry their own copy (the diff filter's regex, the
// diff's git pathspecs, the take_over stash protection, and the guard
// extension). `AGENTS.override.md` was missing from three of them until the
// 2026-09-05 review. Every consumer now reads this module.
//
// pi loads AGENTS.override.md, AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD as
// context files, in that order, first hit wins. SYSTEM.md is inert at the
// root and lives under .pi/ (APPEND_SYSTEM.md) to take effect. .pi/ also
// holds settings.json, which enables extensions a trusted child executes.
// MEMORY.md is written by the harness (blockers), never by a role.

import { join, relative, resolve, sep } from "node:path";

export const GOVERNANCE_FILES = [
	"SOUL.md",
	"AGENTS.md",
	"AGENTS.override.md",
	"AGENTS.MD",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
	"CLAUDE.md",
	"CLAUDE.MD",
	"MEMORY.md",
];

// Directories under the repository root that are never implementation:
// pi's config dir (CONFIG_DIR_NAME, assumed `.pi`) and the pipeline's own.
export const GOVERNANCE_DIRS = [".pi", ".pipeline"];

// What the interactive guard watches: the files above, anywhere in the tree,
// plus pi's project settings.
export const GUARD_PATHS = [...GOVERNANCE_FILES, ".pi/settings.json"];

const FILE_SET = new Set(GOVERNANCE_FILES);

// Repository-relative path (forward slashes) that is governance: a root-level
// governance file, or anything under a governance directory.
export function isGovernanceTreePath(rel) {
	const p = rel.replace(/\\/g, "/").replace(/^\.\//, "");
	if (FILE_SET.has(p)) return true;
	for (const d of GOVERNANCE_DIRS) {
		if (p === d || p.startsWith(`${d}/`)) return true;
	}
	return false;
}

// git pathspecs that exclude the same set from `git diff --name-only`.
export function diffPathspecExcludes() {
	return [...GOVERNANCE_DIRS.map((d) => `:(exclude)${d}`), ...GOVERNANCE_FILES.map((f) => `:(exclude)${f}`)];
}

// Suffix match for the guard: `docs/AGENTS.md` and `C:\proj\.pi\settings.json`
// both count. Returns the governance name that matched.
export function guardMatches(path) {
	const p = String(path).replace(/\\/g, "/");
	return GUARD_PATHS.find((g) => p === g || p.endsWith(`/${g}`));
}

// Absolute paths `take_over` copies out before `git stash -u` and the
// integrity snapshot hashes around a tool-bearing role. Governance the
// operator relocated via AGENTS_FILE / SOUL_FILE / MEMORY_FILE is included
// wherever it lives; the issue source and the wrapper are harness, not
// implementation.
export function preservePaths(root, { agentsFile, soulFile, memoryFile, extra = [] } = {}) {
	const set = new Set();
	const add = (p) => {
		if (p) set.add(resolve(p));
	};
	add(agentsFile ?? join(root, "AGENTS.md"));
	add(soulFile ?? join(root, "SOUL.md"));
	add(memoryFile ?? join(root, "MEMORY.md"));
	for (const f of GOVERNANCE_FILES) add(join(root, f));
	add(join(root, ".pi"));
	for (const p of extra) add(p);
	return [...set];
}

// Is `abs` inside `root`? Used to turn preserved paths into repo-relative ones.
export function relativeInside(root, abs) {
	const rel = relative(root, abs);
	if (rel === "" || rel.startsWith("..") || rel.includes(`..${sep}`)) return null;
	return rel.replace(/\\/g, "/");
}
