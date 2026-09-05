// doctor.mjs — `pipeline doctor`: the project-level checks, deterministic.
// PASS / WARN / FAIL per line, exit 1 on any FAIL. The loop's own invariants
// are pinned by the package's test suite, not re-derived here.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { effectiveGates, effectiveIssueSource, readConfig, resolveAllModels, validate } from "../contract/index.mjs";
import { ADAPTERS, harnessesInUse, parseHarnessSpec, routingErrors } from "../harness/adapter.mjs";
import { readAllStates as readStates } from "../state/store.mjs";
import { git, gitText, hasHead, isGitWorkTree } from "../util/exec.mjs";
import { wrapperPin } from "./wrapper.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageVersion = () => JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")).version;

export function runDoctor({ root, env = process.env, harness = null }) {
	const lines = [];
	let fails = 0;
	const pass = (m) => lines.push(`PASS ${m}`);
	const warn = (m) => lines.push(`WARN ${m}`);
	const fail = (m) => {
		fails++;
		lines.push(`FAIL ${m}`);
	};

	const major = Number(process.versions.node.split(".")[0]);
	if (major >= 18) pass(`node ${process.versions.node}`);
	else fail(`node ${process.versions.node}; the pipeline needs node >= 18`);

	if (isGitWorkTree(root)) {
		pass("git repository");
		if (hasHead(root)) pass("HEAD exists (take_over can stash, approvals can commit)");
		else fail("no commit yet; a real run refuses to start (git commit --allow-empty -m init is enough)");
		if (git(root, ["check-ignore", "-q", ".pipeline/probe"]).status === 0) pass(".pipeline/ is gitignored");
		else fail(".pipeline/ is not gitignored; it holds diffs and prompts in plaintext");
	} else {
		fail("not a git repository");
	}

	const agentsFile = env.AGENTS_FILE ? resolve(root, env.AGENTS_FILE) : join(root, "AGENTS.md");
	let config = null;
	if (!existsSync(agentsFile)) {
		warn(`${agentsFile} not found; every role would run the default model (run /govern)`);
	} else {
		try {
			const source = readConfig(agentsFile);
			for (const w of source.warnings) warn(`contract: ${w}`);
			const { errors, warnings } = validate(source.config, source);
			for (const w of warnings) warn(`contract: ${w}`);
			for (const e of errors) fail(`contract: ${e}`);
			if (errors.length === 0) pass(`contract v${source.config.contract_version} in ${agentsFile} validates`);
			config = source.config;
		} catch (error) {
			fail(`contract: ${error.message}`);
		}
	}
	if (existsSync(join(root, "AGENTS.override.md"))) warn("AGENTS.override.md exists; pi loads it instead of AGENTS.md in every child process");
	if (existsSync(join(root, "SYSTEM.md")) && !existsSync(join(root, ".pi", "APPEND_SYSTEM.md"))) {
		warn("SYSTEM.md exists at the root but .pi/APPEND_SYSTEM.md does not; pi does not load a root SYSTEM.md");
	}

	if (config) {
		const gates = effectiveGates(config, env);
		if (gates.gates.length > 0) pass(`deterministic gates (${gates.origin}): ${gates.gates.map((g) => g.name).join(", ")}`);
		else if (gates.origin === "contract-empty") warn("gates: [] — model review is the only gate, on purpose");
		else warn("no deterministic gate: neither LINT_CMD nor TEST_CMD is set and the contract lists no gates");
		const src = effectiveIssueSource(config, env);
		if (src.kind === "file") {
			const abs = resolve(root, src.path);
			if (existsSync(abs)) pass(`issue source ${src.spec} (${src.origin})`);
			else fail(`issue source ${src.spec} (${src.origin}) does not exist`);
		} else {
			pass(`issue source command (${src.origin}, trust ${src.trust}): ${src.command}`);
			if (src.trust === "external") warn("issue text is external input; a real run asks for --yes, and the run should be containerized");
		}
		let spec = null;
		try {
			spec = parseHarnessSpec(harness ?? "pi");
		} catch (error) {
			fail(`harness: ${error.message}`);
		}
		if (spec) {
			const models = resolveAllModels(config);
			for (const e of routingErrors(models, spec)) fail(`harness: ${e}`);
			for (const name of harnessesInUse(models, spec)) {
				const adapter = ADAPTERS[name];
				if (adapter.resolve(env)) pass(`${adapter.BINARY} found for harness ${name}`);
				else warn(`${adapter.BINARY} not on PATH; a real run needs it for harness ${name}`);
			}
		}
	}

	const wrapper = join(root, "auto-develop.sh");
	if (!existsSync(wrapper)) warn("auto-develop.sh missing; run `pipeline init`");
	else {
		const text = readFileSync(wrapper, "utf8");
		const pin = wrapperPin(text);
		if (!pin) warn("auto-develop.sh is not a generated wrapper; keep it free of loop logic");
		else if (pin === packageVersion()) pass(`auto-develop.sh pinned to ${pin}`);
		else warn(`auto-develop.sh pinned to ${pin}, this package is ${packageVersion()}; re-run \`pipeline init --force\` to bump`);
		// Windows leaves both behind: the executable bit lives only in the index,
		// and autocrlf turns `#!/usr/bin/env bash` into `bash\r`.
		if (text.includes("\r")) warn("auto-develop.sh has CRLF line endings; bash would look for `bash\\r` — `pipeline init` pins it to LF in .gitattributes, then renormalise the file");
		if (isGitWorkTree(root)) {
			const entry = gitText(root, ["ls-files", "-s", "--", "auto-develop.sh"]);
			if (entry && !entry.startsWith("100755")) {
				warn(`auto-develop.sh is not executable in the index (mode ${entry.split(" ")[0]}); \`pipeline init\` records the bit, or run \`git update-index --chmod=+x auto-develop.sh\``);
			}
		}
	}

	const states = readStates(join(root, ".pipeline"));
	const blocked = [];
	for (const [rootId, s] of Object.entries(states)) {
		for (const [id, i] of Object.entries(s.issues ?? {})) if (i.status === "blocked") blocked.push(`${id} (tree ${rootId})`);
	}
	if (blocked.length) warn(`blocked issues: ${blocked.join(", ")} — see MEMORY.md`);

	return { lines, fails };
}

export async function doctorCommand(argv, { root = process.cwd(), env = process.env } = {}) {
	let harness = null;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--harness") {
			if (!argv[i + 1]?.trim() || argv[i + 1].startsWith("-")) {
				process.stderr.write("--harness needs a spec\n");
				return 1;
			}
			harness = argv[++i];
		} else if (argv[i] === "-h" || argv[i] === "--help") {
			process.stdout.write("usage: pipeline doctor [--harness <spec>]\n");
			return 0;
		} else {
			process.stderr.write(`unknown flag: ${argv[i]}\n`);
			return 1;
		}
	}
	const { lines, fails } = runDoctor({ root, env, harness });
	process.stdout.write(`${lines.join("\n")}\n${fails === 0 ? "doctor: OK" : `doctor: ${fails} check(s) failed`}\n`);
	return fails === 0 ? 0 : 1;
}
