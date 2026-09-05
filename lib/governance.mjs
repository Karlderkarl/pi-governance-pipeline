#!/usr/bin/env node
// governance.mjs — command-line facade over lib/contract and lib/state.
// Argument-compatible with the 1.0.x script of the same name, so operators
// and the parity suite can keep calling it:
//
//   node governance.mjs config  <AGENTS.md>              -> merged config as JSON
//   node governance.mjs model   <AGENTS.md> <role.path>  -> "provider/model", "provider/model:thinking", or "default"
//   node governance.mjs models  <AGENTS.md>              -> JSON map of every role to its invoke ref
//   node governance.mjs state init     <dir> <root_id>
//   node governance.mjs state show     <dir> <root_id>
//   node governance.mjs state issue    <dir> <root_id> <issue_id> [status]
//   node governance.mjs state attempt  <dir> <root_id> <issue_id> controller|master
//   node governance.mjs state attempts <dir> <root_id> <issue_id> -> counters + status as JSON
//   node governance.mjs state escalate <dir> <root_id> <issue_id> -> force the master path
//   node governance.mjs state split    <dir> <root_id> <parent_id> <child_id>...
//   node governance.mjs state budget   <dir> <root_id> [--set n] -> exit 0 = budget left, 3 = exhausted
//
// Exit codes: 0 ok, 1 usage/IO error, 2 contract validation failed, 3 budget exhausted.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REVIEWERS, ROLES, readConfig, resolveAllModels, resolveModel, validate } from "./contract/index.mjs";
import { stateCommand } from "./state/store.mjs";

function usage() {
	process.stderr.write(
		[
			"usage:",
			"  governance.mjs config  <AGENTS.md>",
			"  governance.mjs model   <AGENTS.md> <role.path>",
			"  governance.mjs models  <AGENTS.md>",
			"  governance.mjs state init|show|budget <dir> <root_id>",
			"  governance.mjs state budget   <dir> <root_id> --set <n>",
			"  governance.mjs state issue    <dir> <root_id> <issue_id> [status]",
			"  governance.mjs state attempt  <dir> <root_id> <issue_id> controller|master",
			"  governance.mjs state attempts <dir> <root_id> <issue_id>",
			"  governance.mjs state escalate <dir> <root_id> <issue_id>",
			"  governance.mjs state split    <dir> <root_id> <parent_id> <child_id>...",
			"",
			`roles: ${ROLES.join(", ")}, review.${REVIEWERS.join(", review.")}`,
		].join("\n") + "\n",
	);
	process.exit(1);
}

// Warnings from `state` calls are printed once per pipeline directory: the
// loop calls state several times per attempt, and the same text eighteen
// times per issue is noise. Errors stay loud every time.
export function emitValidation(config, source = {}, opts = {}) {
	const { errors, warnings } = validate(config, source);
	const extra = opts.extraWarnings ?? [];
	const allWarnings = [...extra, ...warnings];
	let toPrint = allWarnings;
	const dir = opts.dedupDir;
	if (dir) {
		mkdirSync(dir, { recursive: true });
		const marker = join(dir, ".contract-warning-fingerprint");
		const fingerprint = `${allWarnings.join("\n")}\n`;
		if (existsSync(marker) && readFileSync(marker, "utf8") === fingerprint) {
			toPrint = [];
		} else {
			writeFileSync(marker, fingerprint);
		}
	}
	for (const w of toPrint) {
		const tagged = w.startsWith("contract warning:") || w.startsWith("warning:") ? w : `contract warning: ${w}`;
		process.stderr.write(`${tagged}\n`);
	}
	if (errors.length > 0) {
		for (const e of errors) process.stderr.write(`contract error: ${e}\n`);
		process.exit(2);
	}
}

function main(argv) {
	const [command, ...args] = argv;
	if (!command) usage();
	if (command === "models") {
		const [agentsPath] = args;
		if (!agentsPath) usage();
		const { config, warnings } = readConfig(agentsPath);
		for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
		process.stdout.write(`${JSON.stringify(resolveAllModels(config))}\n`);
		return;
	}
	if (command === "config" || command === "model") {
		const [agentsPath, rolePath] = args;
		if (!agentsPath) usage();
		const source = readConfig(agentsPath);
		for (const w of source.warnings) process.stderr.write(`warning: ${w}\n`);
		if (command === "model") {
			if (!rolePath) usage();
			process.stdout.write(`${resolveModel(source.config, rolePath)}\n`);
			return;
		}
		emitValidation(source.config, source);
		process.stdout.write(`${JSON.stringify(source.config, null, 2)}\n`);
		return;
	}
	if (command === "state") {
		const source = readConfig(process.env.GOVERNANCE_AGENTS ?? "AGENTS.md");
		const dedupDir = args[1];
		emitValidation(source.config, source, {
			extraWarnings: source.warnings.map((w) => (w.startsWith("warning:") ? w : `warning: ${w}`)),
			dedupDir,
		});
		const result = stateCommand(args, source.config);
		if (result?.usage) usage();
		if (result?.budget) {
			process.stdout.write(`${JSON.stringify(result.budget)}\n`);
			process.exit(result.exit);
		}
		if (result) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return;
	}
	usage();
}

try {
	main(process.argv.slice(2));
} catch (error) {
	const contract = error.code === "CONTRACT";
	process.stderr.write(`${contract ? "contract error" : "error"}: ${error.message}\n`);
	process.exit(contract ? 2 : 1);
}
