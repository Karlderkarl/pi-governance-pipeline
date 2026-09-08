// Diagnostic reproductions for the third review of 2026-09-08, after the
// fixes for the thirteen findings of the first two passes. These cases cover
// regressions introduced by those fixes, not the original findings — for
// those, run the two earlier repro files, whose observations must now all
// have changed.
//
// Run: node docs/review-2026-09-08-3.repro.mjs [case-name]
//
// No real model, no remote call, no credentials. Every case builds its own
// throwaway git repository under the OS temp directory. Exit code 0 means the
// cases ran, not that the engine is correct.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT } from "../tests/fixtures/project.mjs";
import { runPipeline } from "../lib/loop/run.mjs";
import { git } from "../lib/util/exec.mjs";

export const cases = {};

function project(contract = CONTRACT, tasks = "- [ ] one: first issue\n") {
	const root = mkdtempSync(join(tmpdir(), "review-3-"));
	const g = (args) => git(root, args);
	g(["init", "-q"]);
	g(["config", "user.email", "review@example.invalid"]);
	g(["config", "user.name", "Review"]);
	g(["config", "commit.gpgsign", "false"]);
	writeFileSync(join(root, ".gitignore"), ".pipeline/\n");
	writeFileSync(join(root, "AGENTS.md"), contract);
	writeFileSync(join(root, "tasks.md"), tasks);
	g(["add", "."]);
	g(["commit", "-qm", "initial"]);
	return root;
}

function stub(root, implementBody) {
	const path = join(root, ".git", "review-stub.mjs");
	writeFileSync(
		path,
		`import {readFileSync,writeFileSync} from 'node:fs';
const p = readFileSync(0,'utf8');
if (p.startsWith('Implement this issue')) {
${implementBody}
}
else if (p.startsWith('You review')) console.log(JSON.stringify({verdict:'approve',findings:[]}));
else if (p.startsWith('Decide this attempt')) console.log(JSON.stringify({decision:'approve'}));
else console.log('notes');
`,
	);
	return path;
}

async function run(root, bin, flags = {}, extra = {}) {
	let output = "";
	const stream = {
		write(text) {
			output += text;
		},
	};
	const rc = await runPipeline({ root, flags, env: { ...process.env, PIPELINE_PI_BIN: bin, ...extra }, stdout: stream, stderr: stream });
	return { rc, output };
}

// G01 — a binary file is always reported as omitted by captureDiff, and the
// incomplete-diff guard turns any omission into a run abort. A twelve-byte
// image therefore makes the issue unapprovable, and the advice the error
// gives ("raise DIFF_MAX_BYTES") cannot apply to a binary.
cases["binary-blocks-approval"] = async () => {
	const root = project(CONTRACT, "- [ ] one: add a logo next to a small code change\n");
	const bin = stub(
		root,
		`  writeFileSync('feature.txt','a small, ordinary code change\\n');
  writeFileSync('logo.png', Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x01,0x02,0x03]));`,
	);
	const r = await run(root, bin, { onlyIssue: "one", maxRuns: 3 });
	return {
		rc: r.rc,
		approved: r.output.includes("approved: one"),
		abortedAsIncompleteDiff: /incomplete review diff/.test(r.output),
		errorMessage: (r.output.match(/error: incomplete review diff.*/) || [""])[0].slice(0, 200),
		adviceMentionsBinaries: /binar/i.test(r.output),
	};
};

// G02 — a single ordinary source file above the per-file share aborts too,
// and because the attempt is reserved before the role runs, every retry
// spends one unit of the tree budget while the issue stays `open`. Four
// invocations, four spent units, no progress and no blocker written.
cases["abort-drains-tree-budget"] = async () => {
	const budgets = "budgets:\n  max_attempts_controller: 3\n  max_attempts_master: 3\n  max_runs_per_tree: 6\nissues:";
	const root = project(CONTRACT.replace("issues:", budgets), "- [ ] one: add one module\n");
	// 1800 lines of ~40 characters: about 72 KB, over the 65536 default.
	const bin = stub(root, "  writeFileSync('module.js', Array.from({length:1800},(_,i)=>`export const value${i} = ${i}; // a line of code`).join('\\n')+'\\n');");
	const invocations = [];
	for (let i = 0; i < 4; i++) {
		const r = await run(root, bin, { onlyIssue: "one" });
		const state = JSON.parse(readFileSync(join(root, ".pipeline/state/one.json"), "utf8"));
		invocations.push({ invocation: i + 1, rc: r.rc, runsUsed: state.runs_used, issueStatus: state.issues.one.status, aborted: /incomplete review diff/.test(r.output) });
	}
	return { contractTreeBudget: 6, blockerEverWritten: existsSync(join(root, "MEMORY.md")), invocations };
};

const only = process.argv[2];
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const names = only ? [only] : Object.keys(cases);
	for (const name of names) {
		if (!cases[name]) {
			process.stderr.write(`unknown case: ${name}\nknown: ${Object.keys(cases).join(", ")}\n`);
			process.exitCode = 1;
			break;
		}
		const observed = await cases[name]();
		process.stdout.write(`${JSON.stringify({ case: name, observed })}\n`);
	}
}
