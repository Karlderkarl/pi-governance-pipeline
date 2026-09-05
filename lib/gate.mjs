#!/usr/bin/env node
// gate.mjs — command-line facade over lib/review. Argument-compatible with
// the 1.0.x script of the same name.
//
//   node gate.mjs --blocking critical,high [--followup medium,low] [--min-reviewers N] r1.json r2.json r3.json
//   node gate.mjs --check r1.json   -> exit 0 = usable verdict, 2 = findings without
//                                      a valid verdict word, 1 = nothing usable
//
// stdout: merged JSON. Exit 0 = clear, 4 = blocked, 1 = usage error.
// --check also uses 2 (see above); 2 is not a gate verdict, and prints the
// worst severity rank the file carries on stdout.
// --min-reviewers (default 1): a panel shrunk below the floor — reviewers
// dropped by no_self_review or lost to unparseable output — blocks instead of
// approving. One opinion is not a review panel.

import { readFileSync } from "node:fs";
import { parseSeverityList, runGate } from "./review/gate.mjs";
import { checkReviewerText } from "./review/reviewer-output.mjs";

const argv = process.argv.slice(2);
let blocking = ["critical", "high"];
let followup = ["medium", "low"];
let minReviewers = 1;
let checkOnly = false;
const files = [];

function usage(message) {
	if (message) process.stderr.write(`error: ${message}\n`);
	process.stderr.write(
		"usage: gate.mjs [--blocking a,b] [--followup c,d] [--min-reviewers n] <reviewer.json>...\n       gate.mjs --check <reviewer.json>\n",
	);
	process.exit(1);
}

try {
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--blocking") blocking = parseSeverityList("--blocking", argv[++i]);
		else if (argv[i] === "--followup") followup = parseSeverityList("--followup", argv[++i]);
		else if (argv[i] === "--min-reviewers") {
			const raw = argv[++i];
			minReviewers = Number(raw);
			// A typo must not quietly lower the floor to 1 — that would approve
			// a panel the caller thought was still gated.
			if (!Number.isInteger(minReviewers) || minReviewers < 1) {
				usage(`--min-reviewers must be an integer >= 1 (got ${raw})`);
			}
		} else if (argv[i] === "--check") checkOnly = true;
		else if (argv[i].startsWith("--")) usage(`unknown flag: ${argv[i]}`);
		else files.push(argv[i]);
	}
} catch (error) {
	usage(error.message);
}
if (files.length === 0 || (checkOnly && files.length !== 1)) usage();

if (checkOnly) {
	let text = "";
	try {
		text = readFileSync(files[0], "utf8");
	} catch {
		text = "";
	}
	const { worst, exit } = checkReviewerText(text);
	process.stdout.write(`${worst}\n`);
	process.exit(exit);
}

const { result, exit } = runGate({ files, blocking, followup, minReviewers });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(exit);
