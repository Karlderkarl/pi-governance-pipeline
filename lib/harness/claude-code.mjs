// claude-code.mjs — the Claude Code harness for roles mapped to Anthropic
// models. Flags checked against `claude --help` of the installed CLI; the
// adapter is exercised against a stub in the test suite and carries no live
// verification in this release. Treat it as experimental.
//
//   all          -p --output-format json        one result object; its `result` is the answer
//   reviewer     --safe-mode --permission-mode dontAsk --tools Read Grep Glob
//                --safe-mode disables CLAUDE.md, skills, plugins, hooks, MCP
//                servers and custom commands: the equivalent of pi's
//                -nc -ne -ns -np --no-approve.
//   research     --permission-mode dontAsk --tools Read Grep Glob
//   judge        --safe-mode --tools ""        no tools; the diff is inline
//   implementer  --permission-mode acceptEdits, or bypassPermissions once the
//                startup gate has passed (the counterpart of pi's --approve)
//
// `provider/model:thinking` is reduced to the model id; Claude Code's own
// settings decide the effort level.

import { resolveCommand, spawnCapture } from "../util/exec.mjs";

export const BINARY = "claude";
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];

export function resolve(env = process.env) {
	return resolveCommand(BINARY, env.PIPELINE_CLAUDE_BIN, env);
}

export function modelIdOf(modelRef) {
	if (!modelRef || modelRef === "default") return null;
	let id = modelRef;
	const slash = id.indexOf("/");
	if (slash !== -1) id = id.slice(slash + 1);
	const colon = id.lastIndexOf(":");
	if (colon !== -1) id = id.slice(0, colon);
	return id;
}

export function buildArgs({ isolation, model, trusted }) {
	const args = ["-p", "--output-format", "json"];
	const id = modelIdOf(model);
	if (id) args.push("--model", id);
	switch (isolation) {
		case "reviewer":
			args.push("--safe-mode", "--permission-mode", "dontAsk", "--tools", ...READ_ONLY_TOOLS);
			break;
		case "research":
			args.push("--permission-mode", "dontAsk", "--tools", ...READ_ONLY_TOOLS);
			break;
		case "judge":
			args.push("--safe-mode", "--tools", "");
			break;
		default:
			args.push("--permission-mode", trusted ? "bypassPermissions" : "acceptEdits");
			break;
	}
	return args;
}

export function launch(resolved, args, { promptText, cwd, env, timeoutMs }) {
	return spawnCapture({ ...resolved, args: [...resolved.args, ...args] }, { stdin: promptText, cwd, env, timeoutMs });
}

// `--output-format json` prints one object whose `result` is the answer.
// Anything else is passed through verbatim.
export function parseOutput(result) {
	const raw = result.stdout.toString("utf8");
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end <= start) return { text: raw };
	try {
		const obj = JSON.parse(raw.slice(start, end + 1));
		if (obj && typeof obj === "object" && typeof obj.result === "string") return { text: obj.result };
	} catch {}
	return { text: raw };
}
