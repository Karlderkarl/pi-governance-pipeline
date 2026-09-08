// INV-01, INV-15, INV-17, INV-18, INV-19, INV-20, INV-28:
// Regression fixtures reproduce the review findings and retain counterexamples.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { core } from "../fixtures/review-counterexamples.mjs";
import { readConfig } from "../../lib/contract/index.mjs";
import { DECISION_MARKERS } from "../../lib/contract/parse.mjs";
import { captureDiff } from "../../lib/diff/capture.mjs";
import { scanDecisionMarkers } from "../../lib/integrity/markers.mjs";
import { guardGitOperation } from "../../lib/integrity/git-operation.mjs";
import { blockIssue } from "../../lib/loop/blocker.mjs";
import { commitApproved } from "../../lib/loop/commit.mjs";
import { runPipeline } from "../../lib/loop/run.mjs";
import { intEnv } from "../../lib/util/text.mjs";
import { checkedGit, CONTRACT, createProject } from "../fixtures/project.mjs";

test("review counterexamples: retries, filters, submodule pause/resume and explicit API environment", core);

test("multiple marked contracts are refused, including an empty marked example", () => {
	const root = createProject(), file = join(root, "AGENTS.md");
	for (const example of [CONTRACT, "```yaml pipeline-contract\n\n```\n"]) {
		writeFileSync(file, example + CONTRACT);
		assert.throws(() => readConfig(file), /exactly one may be marked/);
	}
	writeFileSync(file, CONTRACT.replace("yaml pipeline-contract", "yaml") + CONTRACT);
	assert.equal(readConfig(file).config.contract_version, 2);
});

test("a lone marked block without contract fields cannot hide an unmarked real contract", () => {
	const root = createProject(), file = join(root, "AGENTS.md");
	const real = CONTRACT.replace("yaml pipeline-contract", "yaml");
	for (const body of ["", "\n", "# example only\n", "example: true\n", "example:\n  models: {}\n", '"models:": example\n']) {
		for (const suffix of ["", real]) {
			writeFileSync(file, "```yaml pipeline-contract\n" + body + "```\n" + suffix);
			assert.throws(() => readConfig(file), /contract.*(no recognized|no fenced YAML)/, body);
		}
	}
	writeFileSync(file, "```yaml pipeline-contract\nmodels: {}\nfuture_option: true\n```\n");
	assert.equal(readConfig(file).config.contract_version, 1, "recognized v1 fields still allow defaults and unknown future fields");
});

test("invalid numeric tuning reports the supplied value and fallback; valid values stay quiet", () => {
	for (const raw of ["1e6", "512k", "1_000_000", " 1000", "-1", "9007199254740992"]) {
		const warnings = [];
		assert.equal(intEnv({ DIFF_MAX_BYTES: raw }, "DIFF_MAX_BYTES", 524288, { warn: s => warnings.push(s) }), 524288);
		assert.equal(warnings.length, 1);
		assert.ok(warnings[0].includes(JSON.stringify(raw)), warnings[0]);
		assert.match(warnings[0], /DIFF_MAX_BYTES.*524288/);
	}
	for (const raw of [undefined, "", "0", "2000000"]) {
		assert.equal(intEnv({ CAP: raw }, "CAP", 5, { warn: () => assert.fail("unexpected warning") }), raw === undefined || raw === "" ? 5 : Number(raw));
	}
});

test("quoted marker evidence stays readable without blocking another issue; genuine decisions still refuse", async () => {
	const root = createProject(), memoryFile = join(root, "MEMORY.md");
	blockIssue({ pipelineDir: join(root, ".pipeline"), root: "one", issueId: "one", memoryFile,
		reason: DECISION_MARKERS.map(m => `Reviewer found [${m}] in a retry path`).join("\n"), stderr: { write() {} } });
	assert.deepEqual(scanDecisionMarkers(root), []);
	const memory = readFileSync(memoryFile, "utf8");
	for (const marker of DECISION_MARKERS) assert.ok(memory.replaceAll("&#32;", " ").includes(marker));
	const stub = join(root, ".git", "approve.mjs");
	writeFileSync(stub, `import { readFileSync, writeFileSync } from 'node:fs';
const p = readFileSync(0, 'utf8');
if(p.startsWith('Implement this issue')) writeFileSync('work.txt', 'implementation');
else if(p.startsWith('You review')) console.log('{"verdict":"approve","findings":[]}');
else if(p.startsWith('Decide this attempt')) console.log('{"decision":"approve"}');
else console.log('notes');`);
	let output = ""; const stream = { write(s) { output += s; } };
	const options = { root, flags: { onlyIssue: "two", maxRuns: 1 }, stdout: stream, stderr: stream, env: { ...process.env, PIPELINE_PI_BIN: stub } };
	assert.equal(await runPipeline(options), 0, output);
	assert.match(output, /approved: two/);
	writeFileSync(memoryFile, memory + "\nNEEDS CLARIFICATION: authentication choice\n");
	output = "";
	assert.equal(await runPipeline({ ...options, flags: { onlyIssue: "one" } }), 2, output);
	assert.match(output, /governance error: MEMORY/);
});

test("approval never invokes an issue clean filter or refreshes implementation through a filter", () => {
	const root = createProject();
	checkedGit(root, ["update-index", "--chmod=+x", "tasks.md"]);
	checkedGit(root, ["commit", "-qm", "executable task file"]);
	mkdirSync(join(root, ".pipeline"));
	const out = join(root, ".pipeline", "diff.patch");
	writeFileSync(join(root, "work.txt"), "reviewed implementation\n");
	const { reviewed } = captureDiff({ root, out, maxBytes: 524288, harnessRel: ["tasks.md"] });
	const filter = join(root, ".git", "poison.mjs");
	writeFileSync(filter, "import{readFileSync,writeFileSync}from'node:fs';writeFileSync('.git/filter-ran','yes');writeFileSync('tasks.md','- [x] one: first issue\\n- [x] two: second issue\\n');process.stdout.write(readFileSync(0));");
	checkedGit(root, ["config", "filter.poison.clean", "node .git/poison.mjs"]);
	writeFileSync(join(root, ".gitattributes"), "tasks.md filter=poison\nwork.txt filter=poison\n");
	writeFileSync(join(root, "tasks.md"), "- [x] one: first issue\r\n- [ ] two: second issue\r\n");
	let log = "";
	const result = commitApproved({ root, issueId: "one", issueLine: "one", issueRel: "tasks.md", pathsFile: out + ".paths", reviewed, stderr: { write(s) { log += s; } } });
	assert.equal(result.committed, true, log);
	assert.equal(existsSync(join(root, ".git", "filter-ran")), false);
	assert.equal(checkedGit(root, ["show", "HEAD:tasks.md"]), "- [x] one: first issue\n- [ ] two: second issue\n");
	assert.match(checkedGit(root, ["ls-tree", "HEAD", "tasks.md"]), /^100755 /);
	assert.equal(checkedGit(root, ["show", "HEAD:work.txt"]), "reviewed implementation\n");
});

test("capture restores governance, state and Git configuration changed by a filter", () => {
	const root = createProject();
	mkdirSync(join(root, ".pipeline", "state"), { recursive: true });
	writeFileSync(join(root, ".pipeline", "state", "one.json"), '{"runs_used":3}\n');
	writeFileSync(join(root, ".git", "poison.mjs"), `import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync('AGENTS.md', 'modified contract');
writeFileSync('tasks.md', '- [x] two: second issue');
writeFileSync('.pipeline/state/one.json', '{"runs_used":0}');
writeFileSync('.git/config', readFileSync('.git/config', 'utf8') + '\\n[probe]\\n value = changed\\n');
process.stdout.write(readFileSync(0));`);
	checkedGit(root, ["config", "filter.poison.clean", "node .git/poison.mjs"]);
	writeFileSync(join(root, ".gitattributes"), "work.txt filter=poison\n");
	writeFileSync(join(root, "work.txt"), "implementation\n");
	const paths = ["AGENTS.md", "tasks.md", ".pipeline/state/one.json", ".git/config"];
	const before = paths.map(p => readFileSync(join(root, p)));
	assert.throws(() => captureDiff({ root, out: join(root, ".pipeline", "preflight.patch"), maxBytes: 524288, harnessRel: ["tasks.md"] }), /protected files or HEAD modified during diff capture/);
	for (const [i, p] of paths.entries()) assert.deepEqual(readFileSync(join(root, p)), before[i], p);
});

test("Git operation integrity restores large protected files from temporary recovery copies", () => {
	const root = createProject(), path = join(root, "SOUL.md");
	const original = Buffer.alloc(3 * 1024 * 1024, 7);
	writeFileSync(path, original);
	assert.throws(() => guardGitOperation(root, [path], "large-file probe", () => {
		writeFileSync(path, "changed");
	}), /protected files restored; run stopped/);
	assert.deepEqual(readFileSync(path), original);
	assert.equal(guardGitOperation(root, [path], "unchanged probe", () => 42), 42);
});

test("approval records accepted follow-ups in MEMORY.md without creating tickets or blocking later issues", async () => {
	const root = createProject(), memoryFile = join(root, "MEMORY.md");
	const stub = join(root, ".git", "followups.mjs");
	writeFileSync(stub, `import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const p = readFileSync(0, 'utf8');
if (p.startsWith('Implement this issue')) appendFileSync('work.txt', p.includes('two:') ? 'second\\n' : 'first\\n');
else if (p.startsWith('You review a diff for one concern only: security') && p.includes('one:')) console.log(JSON.stringify({ verdict: 'approve', findings: [{ severity: 'medium', file: 'work.txt', line: 3, title: 'naming is unclear', rationale: 'the spec ${DECISION_MARKERS[2]} on retries.' }] }));
else if (p.startsWith('You review')) console.log('{"verdict":"approve","findings":[]}');
else if (p.startsWith('Decide this attempt')) console.log('{"decision":"approve"}');
else console.log('notes');`);
	let output = ""; const stream = { write(s) { output += s; } };
	const options = { root, stdout: stream, stderr: stream, env: { ...process.env, PIPELINE_PI_BIN: stub } };
	assert.equal(await runPipeline({ ...options, flags: { onlyIssue: "one", maxRuns: 1 } }), 0, output);

	const memory = readFileSync(memoryFile, "utf8");
	assert.match(memory, /^## Follow-ups — one \(\d{4}-\d{2}-\d{2}\)$/m);
	assert.match(memory, /- medium in work\.txt \(naming is unclear\)/);
	// The finding text is reviewer-written: a quoted marker must not become an
	// open decision, and the words must stay readable.
	assert.deepEqual(scanDecisionMarkers(root), []);
	assert.ok(memory.replaceAll("&#32;", " ").includes(DECISION_MARKERS[2]));
	// Recorded, not ticketed: the issue source gains no entry, and MEMORY.md
	// stays out of the approval commit like every other governance file.
	assert.equal(readFileSync(join(root, "tasks.md"), "utf8"), "- [x] one: first issue\n- [ ] two: second issue\n");
	assert.doesNotMatch(checkedGit(root, ["show", "--stat", "--name-only", "HEAD"]), /MEMORY\.md/);

	// A later issue still runs, and an approval without follow-ups adds nothing.
	output = "";
	assert.equal(await runPipeline({ ...options, flags: { onlyIssue: "two", maxRuns: 1 } }), 0, output);
	assert.match(output, /approved: two/);
	assert.equal(readFileSync(memoryFile, "utf8").match(/^## Follow-ups/gm).length, 1);
});
