// init.mjs — `pipeline init`: put the wrapper in place, make the project safe
// to run, validate the contract. Never writes governance: that is /govern's
// job. Deterministic, so the automate mode of the skill has nothing to copy.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { effectiveGates, effectiveIssueSource, readConfig, validate } from "../contract/index.mjs";
import { parseHarnessSpec } from "../harness/adapter.mjs";
import { git, hasHead, isGitWorkTree } from "../util/exec.mjs";
import { wrapperPin, wrapperText } from "./wrapper.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageVersion = () => JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")).version;

export async function initCommand(argv, { root = process.cwd(), env = process.env } = {}) {
	let harness = null;
	let local = false;
	let force = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--harness") {
			if (!argv[i + 1]?.trim() || argv[i + 1].startsWith("-")) {
				process.stderr.write("--harness needs a spec\n");
				return 1;
			}
			harness = argv[++i];
		} else if (a === "--local") local = true;
		else if (a === "--force") force = true;
		else if (a === "-h" || a === "--help") {
			process.stdout.write("usage: pipeline init [--harness <spec>] [--local] [--force]\n  --local  pin the wrapper to this checkout of the engine instead of npx\n  --force  overwrite an existing auto-develop.sh\n");
			return 0;
		} else {
			process.stderr.write(`unknown flag: ${a}\n`);
			return 1;
		}
	}
	const out = (m) => process.stdout.write(`${m}\n`);
	const version = packageVersion();
	let fails = 0;
	try {
		parseHarnessSpec(harness ?? "pi");
	} catch (error) {
		process.stderr.write(`${error.message}\n`);
		return 1;
	}

	// Validate before writing or staging any setup files.
	const agentsFile = env.AGENTS_FILE ? resolve(root, env.AGENTS_FILE) : join(root, "AGENTS.md");
	let config;
	if (!existsSync(agentsFile)) {
		out(`contract: ${agentsFile} not found — run /govern first; every role would run the default model`);
		out("next: /govern");
		return 1;
	}
	try {
		const source = readConfig(agentsFile);
		for (const w of source.warnings) out(`contract warning: ${w}`);
		const { errors, warnings } = validate(source.config, source);
		for (const w of warnings) out(`contract warning: ${w}`);
		for (const e of errors) out(`contract error: ${e}`);
		if (errors.length > 0) {
			out("contract: invalid — fix AGENTS.md through /govern");
			return 1;
		}
		config = source.config;
		out(`contract: v${config.contract_version} validates`);
	} catch (error) {
		out(`contract error: ${error.message}`);
		return 1;
	}

	// Wrapper.
	const wrapper = join(root, "auto-develop.sh");
	const text = wrapperText({ version, harness, localBin: local ? resolve(here, "..", "..", "bin", "pipeline.mjs") : null });
	if (existsSync(wrapper) && !force) {
		const pin = wrapperPin(readFileSync(wrapper, "utf8"));
		if (pin === version) out(`auto-develop.sh: already pinned to ${version}`);
		else if (pin) out(`auto-develop.sh: pinned to ${pin}; pass --force to move it to ${version}`);
		else out("auto-develop.sh: exists and is not a generated wrapper; pass --force to replace it");
	} else {
		writeFileSync(wrapper, text, { mode: 0o755 });
		out(`auto-develop.sh: written (pinned to ${version}${local ? ", local engine" : ""})`);
	}

	// The wrapper is a shell script. Windows keeps no executable bit on disk
	// and core.autocrlf=true rewrites a checkout to CRLF; either makes
	// `./auto-develop.sh` fail on Linux and macOS ("permission denied", or
	// `bash\r` as the interpreter). The index is the one place the bit can be
	// recorded, and .gitattributes the one place the line ending can be pinned.
	if (existsSync(wrapper) && isGitWorkTree(root)) {
		const mode = git(root, ["update-index", "--add", "--chmod=+x", "--", "auto-develop.sh"]);
		if (mode.status === 0) out("auto-develop.sh: executable bit recorded in the index");
		else out(`note: could not record the executable bit of auto-develop.sh (${mode.stderr.toString("utf8").trim() || "git update-index failed"})`);
	}
	const attributes = join(root, ".gitattributes");
	const attrText = existsSync(attributes) ? readFileSync(attributes, "utf8") : "";
	if (attrText.split(/\r?\n/).some((l) => /^auto-develop\.sh\s/.test(l.trim()))) out(".gitattributes: auto-develop.sh already has a line-ending rule");
	else {
		appendFileSync(attributes, `${attrText === "" || attrText.endsWith("\n") ? "" : "\n"}auto-develop.sh text eol=lf\n`);
		out(".gitattributes: pinned auto-develop.sh to LF");
	}

	// .gitignore before the first run, not after.
	const gitignore = join(root, ".gitignore");
	const ignored = existsSync(gitignore) ? readFileSync(gitignore, "utf8").split(/\r?\n/).includes(".pipeline/") : false;
	if (ignored) out(".gitignore: .pipeline/ already ignored");
	else {
		const current = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
		appendFileSync(gitignore, `${current === "" || current.endsWith("\n") ? "" : "\n"}.pipeline/\n`);
		out(".gitignore: added .pipeline/");
	}

	// Git.
	if (!isGitWorkTree(root)) {
		fails++;
		out("git: not a repository — run `git init` and make a first commit; a real run needs a HEAD");
	} else if (!hasHead(root)) {
		out("git: no commit yet — commit the governance and this wrapper before the first real run (take_over needs a HEAD)");
	} else {
		out("git: repository with HEAD");
	}

	// Issue source and gates.
	if (config) {
		const src = effectiveIssueSource(config, env);
		if (src.kind === "file") {
			const abs = resolve(root, src.path);
			if (!existsSync(abs)) {
				mkdirSync(dirname(abs), { recursive: true });
				writeFileSync(abs, "# Tasks — one open issue per line: `- [ ] <id>: <title>`. Done issues become `- [x]`.\n");
				out(`issues: created ${src.path} (empty)`);
			} else out(`issues: ${src.path}`);
		} else out(`issues: command (${src.trust})`);
		const gates = effectiveGates(config, env);
		if (gates.gates.length > 0) out(`gates: ${gates.gates.map((g) => g.name).join(", ")} (${gates.origin})`);
		else out(`gates: none — ${gates.origin === "contract-empty" ? "gates: [] is explicit" : "add gates to AGENTS.md through /govern, or set LINT_CMD / TEST_CMD"}`);
	}

	if (git(root, ["check-ignore", "-q", ".pipeline/probe"]).status !== 0 && isGitWorkTree(root)) {
		out("note: git does not ignore .pipeline/ yet (nested .gitignore or untracked root?) — check before the first run");
	}
	if (fails === 0) out("next: ./auto-develop.sh --dry-run");
	else out(`init: ${fails} problem(s) to fix before the first run`);
	return fails === 0 ? 0 : 1;
}
