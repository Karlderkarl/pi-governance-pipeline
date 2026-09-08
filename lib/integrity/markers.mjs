// markers.mjs — decision markers outside the contract block.
//
// govern leaves `[USER DECISION REQUIRED]` / `[NEEDS PRD CLARIFICATION]`
// wherever a human still has to decide. Contract validation catches a marker
// inside the fenced YAML; a marker in the prose of AGENTS.md, in SOUL.md or in
// the harness copies would otherwise ride into every prompt as if it were a
// decision. This scan covers every governance file a role or a prompt reads.
// A real run refuses on a hit; a dry-run notes it; doctor reports FAIL.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decisionMarker } from "../contract/parse.mjs";
import { relativeInside } from "./governance-paths.mjs";

// The files scanned: the three relocatable governance files plus the harness
// copies at their fixed locations. Missing files are skipped, not errors.
export function governanceMarkerFiles(root, { agentsFile, soulFile, memoryFile } = {}) {
	const set = new Set();
	const add = (p) => {
		if (p) set.add(resolve(p));
	};
	add(agentsFile ?? join(root, "AGENTS.md"));
	add(soulFile ?? join(root, "SOUL.md"));
	add(memoryFile ?? join(root, "MEMORY.md"));
	for (const f of ["AGENTS.override.md", "SYSTEM.md", "CLAUDE.md"]) add(join(root, f));
	add(join(root, ".pi", "SYSTEM.md"));
	add(join(root, ".pi", "APPEND_SYSTEM.md"));
	return [...set].filter((p) => existsSync(p));
}

// Every line of every governance file, checked for a marker. Returns
// `{ file, line, marker }` with a repository-relative path where possible.
export function scanDecisionMarkers(root, files = {}) {
	const hits = [];
	for (const abs of governanceMarkerFiles(root, files)) {
		const lines = readFileSync(abs, "utf8").split(/\r?\n/);
		lines.forEach((text, i) => {
			const marker = decisionMarker(text);
			if (marker) hits.push({ file: relativeInside(root, abs) ?? abs, line: i + 1, marker });
		});
	}
	return hits;
}
