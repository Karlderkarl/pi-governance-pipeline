// events.mjs — one JSONL event per step. Timestamp, issue, role, model, exit
// status, the path to the rendered prompt, and which deterministic gates the
// run had (so "none" stays visible afterwards instead of looking like a gate
// that passed). Never the prompt itself.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { localTimestamp } from "../util/text.mjs";

export function createLogger({ pipelineDir, runId, gates }) {
	return {
		runId,
		logEvent({ root, issue, role, model, status, prompt, note = null }) {
			const dir = join(pipelineDir, "logs", root);
			mkdirSync(dir, { recursive: true });
			const event = { ts: localTimestamp(), issue, role, model, status: String(status), prompt, gates };
			if (note) event.note = note;
			appendFileSync(join(dir, `${runId}.jsonl`), `${JSON.stringify(event)}\n`);
		},
	};
}
