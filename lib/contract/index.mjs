// index.mjs — the contract as the loop sees it: read, validate, resolve.

export * from "./parse.mjs";
export { validate } from "./validate.mjs";
export { contractError } from "./yaml.mjs";

// Deterministic gates for a run. LINT_CMD / TEST_CMD in the environment are
// the v1 adaptation points and stay honoured: when either is set, the
// operator's explicit choice replaces the contract's list for this run.
export function effectiveGates(config, env = process.env) {
	const fromEnv = [];
	if (env.LINT_CMD) fromEnv.push({ name: "lint", run: env.LINT_CMD });
	if (env.TEST_CMD) fromEnv.push({ name: "test", run: env.TEST_CMD });
	if (fromEnv.length > 0) return { gates: fromEnv, origin: "env" };
	if (Array.isArray(config.gates) && config.gates.length > 0) return { gates: config.gates, origin: "contract" };
	return { gates: [], origin: Array.isArray(config.gates) ? "contract-empty" : "none" };
}

// Issue source for a run. ISSUE_SOURCE in the environment (a file, or
// `!command`) is the v1 adaptation point and overrides the contract.
export function effectiveIssueSource(config, env = process.env) {
	if (env.ISSUE_SOURCE) {
		if (env.ISSUE_SOURCE.startsWith("!")) {
			return { kind: "command", command: env.ISSUE_SOURCE.slice(1), trust: "external", origin: "env", spec: env.ISSUE_SOURCE };
		}
		return { kind: "file", path: env.ISSUE_SOURCE, trust: "internal", origin: "env", spec: env.ISSUE_SOURCE };
	}
	const src = config.issues?.source;
	if (typeof src === "string" && src !== "") {
		if (src.startsWith("!")) {
			return { kind: "command", command: src.slice(1), trust: "external", origin: "contract", spec: src };
		}
		return { kind: "file", path: src, trust: "internal", origin: "contract", spec: src };
	}
	if (src && typeof src === "object" && typeof src.command === "string") {
		return {
			kind: "command",
			command: src.command,
			trust: src.trust === "internal" ? "internal" : "external",
			origin: "contract",
			spec: `!${src.command}`,
		};
	}
	return { kind: "file", path: "tasks.md", trust: "internal", origin: "default", spec: "tasks.md" };
}
