/**
 * pipeline-guard — the interactive half of the governance pipeline's safety rule.
 *
 * The pipeline itself gates privileged work at startup, because `pi -p` has no
 * UI to ask with, and checks governance integrity by snapshot around every
 * tool-bearing role. This extension covers the other case: an interactive
 * session where the agent reaches for a privileged command on its own. It also
 * exposes the pipeline state the harness owns, so the model can read counters
 * without ever holding them.
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
 * and runtime-constructed commands slip through. `--exclude-tools bash,powershell`
 * or a container is the only real boundary. The patterns and the governance
 * names live in lib/ (one list for the diff filter, the stash protection, the
 * integrity snapshot and this guard) and are unit-tested there; so does the
 * status text, shared with `pipeline status`.
 */

import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DESTRUCTIVE, PRIVILEGED, shellWritesGovernance, governancePath } from "../lib/guard/patterns.mjs";
import { readStates, statusText } from "../lib/cli/status.mjs";

export default function (pi: ExtensionAPI) {
	const enabled = process.env.PIPELINE_GUARD !== "off";
	const unattended = process.env.PIPELINE_UNATTENDED === "1";

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled) return;

		if (isToolCallEventType("bash", event) || isToolCallEventType("powershell", event)) {
			const command = event.input.command ?? "";
			const destructive = DESTRUCTIVE.find((entry) => entry.pattern.test(command));
			if (destructive && process.env.PIPELINE_ALLOW_DESTRUCTIVE !== "1") {
				if (!ctx.hasUI) {
					return {
						block: true,
						reason: `pipeline-guard: refused ${destructive.reason} in a non-interactive session. Set PIPELINE_ALLOW_DESTRUCTIVE=1 deliberately to allow it.`,
					};
				}
				const ok = await ctx.ui.confirm("Destructive command", `${destructive.reason}:\n\n${command}\n\nAllow?`);
				if (!ok) return { block: true, reason: `pipeline-guard: ${destructive.reason} declined by the user` };
				// Fall through deliberately. A confirmed destructive command is still a
				// governance write or a privileged command if it is one: `sudo tee
				// AGENTS.md` used to raise a single "privilege escalation" prompt and
				// never the governance-write one, and `rm -rf build && gh pr merge 12`
				// asked only about the rm. Each gate names what it is guarding.
			}
			const gov = shellWritesGovernance(command);
			if (gov) {
				if (!ctx.hasUI) {
					if (process.env.PIPELINE_ALLOW_GOVERNANCE_WRITE !== "1") {
						return {
							block: true,
							reason: `pipeline-guard: ${gov} may not be rewritten in a non-interactive run. Set PIPELINE_ALLOW_GOVERNANCE_WRITE=1 for the govern step itself.`,
						};
					}
				} else {
					const ok = await ctx.ui.confirm("Governance write", `Modify ${gov} via a shell command?\n\n${command}`);
					if (!ok) return { block: true, reason: `pipeline-guard: ${gov} write declined` };
				}
			}
			// Unattended pre-approval covers the rest of the privileged list;
			// the governance-write gate above stays armed regardless.
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
			const name = governancePath(path);
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
			ctx.ui.notify(statusText(join(ctx.cwd, ".pipeline")).trimEnd(), "info");
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
			const states = readStates(join(ctx.cwd, ".pipeline")) as Record<string, unknown>;
			const selected = params.root_id ? { [params.root_id]: states[params.root_id] ?? null } : states;
			return {
				content: [{ type: "text", text: JSON.stringify(selected, null, 2) }],
				details: {},
			};
		},
	});
}
