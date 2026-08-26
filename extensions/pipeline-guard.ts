/**
 * pipeline-guard — the runtime half of the governance pipeline's safety rule.
 *
 * The pipeline itself gates privileged work at startup, because `pi -p` has no
 * UI to ask with. This extension covers the other case: an interactive session
 * where the agent reaches for a privileged command on its own. It also exposes
 * the pipeline state the harness owns, so the model can read counters without
 * ever holding them.
 *
 * Off-switch: PIPELINE_GUARD=off. Unattended runs: PIPELINE_UNATTENDED=1 skips
 * the privileged-command confirmations (a human pre-answered them at the
 * pipeline's startup gate) except the highest-consequence patterns (sudo,
 * recursive delete, force-push), which stay armed unless
 * PIPELINE_ALLOW_DESTRUCTIVE=1. Governance writes keep their own gate
 * (PIPELINE_ALLOW_GOVERNANCE_WRITE) in every mode — a pipeline run must never
 * rewrite the contract it runs on.
 *
 * This is a speed bump, not a sandbox. Patterns match the command string the
 * agent typed, not a security boundary: `rm -rf "$HOME"`, `eval`, `bash -c`,
 * and runtime-constructed commands slip through. Run the pipeline in a
 * container or VM when you need isolation.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Always armed, including unattended runs, unless PIPELINE_ALLOW_DESTRUCTIVE=1.
const DESTRUCTIVE: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /\bgit\s+push\b[^\n]*\s(--force|-f)\b/, reason: "force-push" },
	{ pattern: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\b/, reason: "recursive delete" },
	{ pattern: /\bsudo\b/, reason: "privilege escalation" },
];

const PRIVILEGED: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /\bgit\s+push\b[^\n]*\b(main|master)\b/, reason: "push to a protected branch" },
	{ pattern: /\bgit\s+reset\s+--hard\b/, reason: "hard reset (discards work)" },
	{ pattern: /\bgh\s+pr\s+merge\b/, reason: "pull request merge" },
	{ pattern: /\bcurl\b[^\n|]*\|\s*(ba)?sh\b/, reason: "piping a download into a shell" },
	{ pattern: /\bnpm\s+publish\b|\bpi\s+install\b/, reason: "package publish or install" },
];

const GOVERNANCE = ["SOUL.md", "AGENTS.md", "SYSTEM.md", "CLAUDE.md", "MEMORY.md"];

function stateDir(cwd: string): string {
	return join(cwd, ".pipeline", "state");
}

function readStates(cwd: string): Record<string, unknown> {
	const dir = stateDir(cwd);
	if (!existsSync(dir)) return {};
	const out: Record<string, unknown> = {};
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
		try {
			out[file.replace(/\.json$/, "")] = JSON.parse(readFileSync(join(dir, file), "utf8"));
		} catch {
			out[file.replace(/\.json$/, "")] = { error: "unreadable state file" };
		}
	}
	return out;
}

function summarize(states: Record<string, any>): string {
	const keys = Object.keys(states);
	if (keys.length === 0) return "No pipeline state in .pipeline/state — nothing has run in this project yet.";
	return keys
		.map((root) => {
			const s = states[root];
			const issues = Object.entries(s.issues ?? {})
				.map(([id, i]: [string, any]) => `    ${id}: ${i.status} (controller ${i.attempts_controller}, master ${i.attempts_master})`)
				.join("\n");
			return `${root}: ${s.runs_used}/${s.max_runs_per_tree} runs used, depth ${s.depth}\n${issues}`;
		})
		.join("\n\n");
}

export default function (pi: ExtensionAPI) {
	const enabled = process.env.PIPELINE_GUARD !== "off";
	const unattended = process.env.PIPELINE_UNATTENDED === "1";

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return;

		if (isToolCallEventType("bash", event)) {
			const command = event.input.command ?? "";
			const destructive = DESTRUCTIVE.find((entry) => entry.pattern.test(command));
			if (destructive && process.env.PIPELINE_ALLOW_DESTRUCTIVE !== "1") {
				if (!ctx.hasUI) {
					return {
						block: true,
						reason: `pipeline-guard: refused ${destructive.reason} in a non-interactive session. Set PIPELINE_ALLOW_DESTRUCTIVE=1 deliberately to allow it.`,
					};
				}
				const ok = await ctx.ui.confirm(
					"Destructive command",
					`${destructive.reason}:\n\n${command}\n\nAllow?`,
				);
				if (!ok) return { block: true, reason: `pipeline-guard: ${destructive.reason} declined by the user` };
				return;
			}
			// Unattended pre-approval covers the rest of the privileged list;
			// the governance-write gate below stays armed regardless.
			if (unattended) return;
			const hit = PRIVILEGED.find((entry) => entry.pattern.test(command));
			if (!hit) return;
			// No UI means no consent. Blocking is the only safe default here:
			// a privileged step must never proceed just because nobody could answer.
			if (!ctx.hasUI) {
				return {
					block: true,
					reason: `pipeline-guard: refused ${hit.reason} in a non-interactive session. Set PIPELINE_UNATTENDED=1 deliberately to allow it.`,
				};
			}
			const ok = await ctx.ui.confirm("Privileged command", `${hit.reason}:\n\n${command}\n\nAllow?`);
			if (!ok) return { block: true, reason: `pipeline-guard: ${hit.reason} declined by the user` };
			return;
		}

		// Governance is written by the govern mode, never as a side effect of a
		// pipeline run. A silent rewrite makes every later run wrong.
		for (const tool of ["write", "edit"] as const) {
			if (event.toolName !== tool) continue;
			const path = String((event.input as { path?: string }).path ?? "");
			const name = GOVERNANCE.find((g) => path.endsWith(g));
			if (!name) continue;
			if (!ctx.hasUI) {
				if (process.env.PIPELINE_ALLOW_GOVERNANCE_WRITE === "1") return;
				return {
					block: true,
					reason: `pipeline-guard: ${name} may not be rewritten in a non-interactive run. Set PIPELINE_ALLOW_GOVERNANCE_WRITE=1 for the govern step itself.`,
				};
			}
			const ok = await ctx.ui.confirm("Governance write", `Modify ${name}?`);
			if (!ok) return { block: true, reason: `pipeline-guard: ${name} write declined` };
		}
	});

	pi.registerCommand("pipeline-status", {
		description: "Show auto-develop pipeline counters, budget, and issue status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(summarize(readStates(ctx.cwd)), "info");
		},
	});

	pi.registerTool({
		name: "pipeline_state",
		label: "Pipeline state",
		description:
			"Read the auto-develop pipeline state (runs used, tree budget, per-issue attempt counters and status) from .pipeline/state. Use this instead of guessing counters; the harness owns them, not the conversation.",
		parameters: Type.Object({
			root_id: Type.Optional(Type.String({ description: "Root issue id. Omit for every tree." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const states = readStates(ctx.cwd);
			const selected = params.root_id ? { [params.root_id]: states[params.root_id] ?? null } : states;
			return {
				content: [{ type: "text", text: JSON.stringify(selected, null, 2) }],
				details: {},
			};
		},
	});
}
