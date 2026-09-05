// run.mjs — `pipeline run` flag parsing.

import { USAGE, runPipeline } from "../loop/run.mjs";

export function parseRunFlags(argv) {
	const flags = { unattended: false, autoMerge: false, dryRun: false, assumeYes: false, onlyIssue: null, maxRuns: null, harness: null, help: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		switch (a) {
			case "--unattended":
				flags.unattended = true;
				break;
			case "--auto-merge":
				flags.autoMerge = true;
				break;
			case "--dry-run":
				flags.dryRun = true;
				break;
			case "--yes":
			case "-y":
				flags.assumeYes = true;
				break;
			case "--issue":
				if (argv[i + 1] === undefined) throw new Error("--issue needs an id");
				flags.onlyIssue = argv[++i];
				break;
			case "--max-runs":
				if (argv[i + 1] === undefined) throw new Error("--max-runs needs a count");
				flags.maxRuns = argv[++i];
				break;
			case "--harness":
				if (!argv[i + 1]?.trim() || argv[i + 1].startsWith("-")) throw new Error("--harness needs a spec");
				flags.harness = argv[++i];
				break;
			case "-h":
			case "--help":
				flags.help = true;
				break;
			default:
				throw new Error(`unknown flag: ${a}`);
		}
	}
	return flags;
}

export async function runCommand(argv, { root = process.cwd(), env = process.env } = {}) {
	let flags;
	try {
		flags = parseRunFlags(argv);
	} catch (error) {
		process.stderr.write(`${error.message}\n`);
		return 1;
	}
	if (flags.help) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	return runPipeline({ root, flags, env });
}
