// status.mjs — `pipeline status`: counters, tree budget, per-issue state.
// The extension's /pipeline-status prints the same text through statusText.

import { join } from "node:path";
import { readAllStates } from "../state/store.mjs";

export { readAllStates as readStates };

export function formatStatus(states) {
	const keys = Object.keys(states);
	if (keys.length === 0) return "No pipeline state in .pipeline/state — nothing has run in this project yet.\n";
	return `${keys
		.map((root) => {
			const s = states[root];
			if (s.error) return `${root}: ERROR: ${s.error}`;
			const issues = Object.entries(s.issues ?? {})
				.map(([id, i]) => `    ${id}: ${i.status} (controller ${i.attempts_controller}, master ${i.attempts_master}${i.parent ? `, child of ${i.parent}` : ""})${i.review_pause ? ` — ${i.review_pause}` : ""}`)
				.join("\n");
			return `${root}: ${s.runs_used}/${s.max_runs_per_tree} runs used, depth ${s.depth}\n${issues}`;
		})
		.join("\n\n")}\n`;
}

export function statusText(pipelineDir) {
	return formatStatus(readAllStates(pipelineDir));
}

export async function statusCommand(argv, { root = process.cwd() } = {}) {
	const pipelineDir = join(root, ".pipeline");
	const states = readAllStates(pipelineDir);
	const exit = Object.values(states).some((s) => s.error) ? 1 : 0;
	if (argv.includes("--json")) {
		process.stdout.write(`${JSON.stringify(states, null, 2)}\n`);
		return exit;
	}
	process.stdout.write(formatStatus(states));
	return exit;
}
