// pi.mjs — the pi harness: one role, one `pi -p` process, one fresh context.
//
// Flags per isolation class (pi 0.85):
//   all          -p --no-session      one pi -p is one session file; a 55-call issue
//                                     would otherwise leave 55 sessions
//   reviewer     -nc -t read,grep,find,ls --no-approve -ne -ns -np
//                -nc keeps AGENTS.md out (panel size, roles, implementer model).
//                --no-approve keeps .pi/APPEND_SYSTEM.md out: -nc only drops
//                context files, and SYSTEM.md is trust-gated, so --approve or a
//                saved trust decision would put it back. -ne -ns -np drop
//                extension, skill and prompt-template discovery, global ones
//                included: an extension may register a tool under a built-in
//                name or inject context before the agent starts.
//   research     -t read,grep,find,ls --no-approve -ne -ns -np
//                                     no extension can override a read tool or
//                                     run hooks, including under saved trust
//   judge        --no-tools --no-approve -ne -ns -np
//                                     the diff is inline after per-file truncation;
//                                     the verdict must not be reachable from a
//                                     project extension or .pi/APPEND_SYSTEM.md,
//                                     so judges get the reviewers' trust and
//                                     discovery flags (AGENTS.md stays loaded)
//   non-implementers also get explicit empty --system-prompt and
//                --append-system-prompt values. Pi then uses its built-in base
//                prompt without discovering global or project SYSTEM.md files.
//                Auth, model configuration and provider selection stay available.
//   implementer  (all tools)           the only class that gets --approve, and
//                                     only after the startup gate
//
// The prompt goes in on stdin: interpolating it onto argv exceeds macOS
// ARG_MAX once the master sees the diff plus every reviewer JSON.

import { resolveCommand, spawnCapture } from "../util/exec.mjs";

export const BINARY = "pi";
export const READ_ONLY_TOOLS = "read,grep,find,ls";

export function resolve(env = process.env) {
	return resolveCommand(BINARY, env.PIPELINE_PI_BIN, env);
}

export function buildArgs({ isolation, model, trusted }) {
	const args = ["-p", "--no-session"];
	switch (isolation) {
		case "reviewer":
			args.push("-nc", "-t", READ_ONLY_TOOLS, "--no-approve", "-ne", "-ns", "-np");
			break;
		case "research":
			args.push("-t", READ_ONLY_TOOLS, "--no-approve", "-ne", "-ns", "-np");
			break;
		case "judge":
			args.push("--no-tools", "--no-approve", "-ne", "-ns", "-np");
			break;
		default:
			break;
	}
	if (["reviewer", "research", "judge"].includes(isolation)) {
		args.push("--system-prompt", "", "--append-system-prompt", "");
	}
	// Only the implementer is ever trusted. Reviewers and judges say
	// --no-approve explicitly rather than relying on the absence of --approve;
	// research is read-only and needs no project tooling either.
	if (trusted && isolation === "implementer") args.push("--approve");
	if (model && model !== "default") args.push("--model", model);
	return args;
}

// The resolved spec is passed through whole: a .cmd shim carries the script
// path in `cmdScript`, and dropping it would launch a bare cmd.exe.
export function launch(resolved, args, { promptText, cwd, env, timeoutMs }) {
	return spawnCapture({ ...resolved, args: [...resolved.args, ...args] }, { stdin: promptText, cwd, env, timeoutMs });
}

// pi -p prints the answer; that text is the role's output.
export function parseOutput(result) {
	return { text: result.stdout.toString("utf8") };
}
