#!/usr/bin/env node
// pipeline.mjs — the command-line entry of pi-governance-pipeline.
//
//   pipeline run [flags]        run the loop (see `run --help`)
//   pipeline init [flags]       write the wrapper, check the project, validate the contract
//   pipeline doctor             project-level checks, deterministic
//   pipeline status             counters, tree budget, per-issue state
//   pipeline version

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function packageVersion() {
	return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version;
}

const HELP = `pi-governance-pipeline ${packageVersion()}

  run [flags]        run every open issue (flags: run --help)
  init [flags]       write auto-develop.sh, check .gitignore and HEAD, validate AGENTS.md
  doctor             project checks: contract, gates, issue source, trust, wrapper pin
  status             counters, tree budget, per-issue state
  version
`;

async function main(argv) {
	const [command, ...rest] = argv;
	const root = process.cwd();
	switch (command) {
		case "run": {
			const { runCommand } = await import("../lib/cli/run.mjs");
			return runCommand(rest, { root });
		}
		case "init": {
			const { initCommand } = await import("../lib/cli/init.mjs");
			return initCommand(rest, { root });
		}
		case "doctor": {
			const { doctorCommand } = await import("../lib/cli/doctor.mjs");
			return doctorCommand(rest, { root });
		}
		case "status": {
			const { statusCommand } = await import("../lib/cli/status.mjs");
			return statusCommand(rest, { root });
		}
		case "version":
		case "--version":
		case "-v":
			process.stdout.write(`${packageVersion()}\n`);
			return 0;
		case undefined:
		case "help":
		case "--help":
		case "-h":
			process.stdout.write(HELP);
			return 0;
		default:
			process.stderr.write(`unknown command: ${command}\n${HELP}`);
			return 1;
	}
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code ?? 0),
	(error) => {
		process.stderr.write(`error: ${error?.stack ?? error}\n`);
		process.exit(1);
	},
);
