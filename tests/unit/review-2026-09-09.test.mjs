// review-2026-09-09.test.mjs — INV-01, INV-06, INV-08, INV-13, INV-15:
// regressions for the findings of the 2026-09-09 review.
//
//  1. A reviewer that wrote a finding and then hit the role timeout lost it:
//     invokeRole emptied the answer file before the "a finding is evidence
//     whatever the exit code" rule could ever see it. (INV-06)
//  2. `--auto-merge` granted implementer trust by itself — the one effect its
//     name does not mention. Trust is `--unattended` only. (INV-08)
//  3. A prose line `review:` in AGENTS.md was read as a failed contract and
//     refused the whole run. (INV-01)
//  4. A mapped role's `model`/`provider` were only checked for presence, so a
//     nested map routed to `provider/[object Object]`. (INV-01)
//  5. `git stash` ran the project's Git filters outside the integrity guard
//     that already wraps diff capture and approval. (INV-13)
//  6. Byte-exact truncation split UTF-8 sequences into the prompts. (INV-15)
//  7. A JSON object outside a code fence was no candidate at all: the only one
//     that could hold it was the whole text, which `tryParseObject` cuts from
//     the first `{` to the last `}` — across both objects, so it never parsed.
//     A reviewer's free-standing critical vanished behind a fenced approve, and
//     a master's free-standing reject behind a fenced approve. (INV-06, INV-18)
//  8. `init` read any line starting with `auto-develop.sh ` as a line-ending
//     rule, so `linguist-generated=true` pinned nothing and `text eol=crlf`
//     pinned the opposite — while it reported success. (INV-28)
//
// The next three are gaps in the fixes for 7 and 8, found by the review after:
//
//  9. Scanning for free-standing objects in one pass carried brace and quote
//     state through the prose, so `if (authorized) {` or a single `"` in a
//     sentence hid the object again. Each `{` is now its own start, and a key
//     the scan never reached refuses to release work. (INV-06, INV-18)
// 10. `eol=lf` alone proves nothing: `-text eol=lf` resolves eol to lf and
//     normalises nothing, because `text` is explicitly unset. (INV-28)
// 11. A rule that lived only in the user's `core.attributesFile` made `init`
//     skip writing the project's own; it does not travel with a clone. (INV-28)
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { invokeRole, parseHarnessSpec } from "../../lib/harness/adapter.mjs";
import { initCommand } from "../../lib/cli/init.mjs";
import { runDoctor } from "../../lib/cli/doctor.mjs";
import { hasWrapperEolRule } from "../../lib/cli/wrapper.mjs";
import { runGate } from "../../lib/review/gate.mjs";
import { findingsToProse } from "../../lib/review/findings-prose.mjs";
import { UNPROCESSED_SEVERITY, checkReviewerText, extractJson } from "../../lib/review/reviewer-output.mjs";
import { parseMasterDecision } from "../../lib/review/master-decision.mjs";
import { readConfig } from "../../lib/contract/index.mjs";
import { validate } from "../../lib/contract/validate.mjs";
import { resolveAllModels } from "../../lib/contract/parse.mjs";
import { preservePaths } from "../../lib/integrity/governance-paths.mjs";
import { stashRejectedTree } from "../../lib/loop/stash.mjs";
import { runPipeline } from "../../lib/loop/run.mjs";
import { sliceUtf8 } from "../../lib/util/text.mjs";
import { CONTRACT, checkedGit, createProject } from "../fixtures/project.mjs";

// Prints one line, then stays alive until the role timeout ends its tree.
const HANGING = `import { readFileSync } from "node:fs";
readFileSync(0, "utf8");
process.stdout.write(process.env.PROBE_OUT + "\\n");
setInterval(() => {}, 1000);
`;

async function timedOutRole(role) {
	const root = createProject();
	const stub = join(root, ".git", "hang.mjs");
	writeFileSync(stub, HANGING);
	mkdirSync(join(root, ".pipeline"), { recursive: true });
	const outPath = join(root, ".pipeline", "answer.json");
	const finding = '{"role":"security","verdict":"reject","findings":[{"severity":"critical","file":"work.txt","title":"secret in log"}]}';
	const result = await invokeRole({
		spec: parseHarnessSpec("pi"), role, model: "google/m", promptText: "prompt\n", outPath,
		cwd: root, trusted: false, timeoutMs: 2000,
		env: { ...process.env, PIPELINE_PI_BIN: stub, PROBE_OUT: finding },
	});
	assert.equal(result.timedOut, true);
	assert.equal(result.status, 124);
	return readFileSync(outPath, "utf8");
}

test("a timed-out reviewer keeps the finding it already wrote; a judge's half verdict is dropped", async () => {
	// The bug: both were emptied, so a critical written before the hang never
	// reached the gate — the retry could then come back clean and approve.
	assert.match(await timedOutRole("review.security"), /"severity":"critical"/);
	assert.equal(await timedOutRole("master_review"), "");
	assert.equal(await timedOutRole("research"), "");
});

// Logs the argv of every role so the trust flag is visible.
const ARGV_STUB = `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
appendFileSync(process.env.PROBE_ARGV, JSON.stringify(process.argv.slice(2)) + "\\n");
if (prompt.startsWith("Implement this issue")) writeFileSync("work.txt", "line " + Date.now() + "\\n");
else if (prompt.startsWith("You review")) console.log('{"role":"r","verdict":"reject","findings":[{"severity":"critical","file":"work.txt","title":"t"}]}');
else if (prompt.startsWith("Decide this attempt")) console.log('{"decision":"reject"}');
else console.log("notes");
`;

async function trustProbe(flags) {
	const root = createProject();
	const stub = join(root, ".git", "argv.mjs");
	const log = join(root, ".git", "argv.log");
	writeFileSync(stub, ARGV_STUB);
	writeFileSync(log, "");
	let output = "";
	const stream = { write(text) { output += text; } };
	await runPipeline({
		root, flags: { ...flags, assumeYes: true, maxRuns: 1 }, stdout: stream, stderr: stream,
		env: { ...process.env, PIPELINE_PI_BIN: stub, PROBE_ARGV: log, PIPELINE_UNATTENDED: "" },
	});
	return { argv: readFileSync(log, "utf8"), output };
}

test("--auto-merge grants no implementer trust; --unattended does", async () => {
	const merge = await trustProbe({ autoMerge: true });
	assert.ok(merge.argv.includes("--model"), merge.argv);
	assert.doesNotMatch(merge.argv, /--approve/, "auto-merge must not hand the implementer --approve");
	assert.match(merge.output, /auto-merge: not implemented/);

	const unattended = await trustProbe({ unattended: true });
	assert.match(unattended.argv, /--approve/, "--unattended is what grants trust");
});

test("prose in AGENTS.md is not a failed contract; a fence that did not parse still is", () => {
	const root = createProject();
	const file = join(root, "AGENTS.md");

	// The false positive: `review:` opens a normal section, and
	// governance-files.md asks for exactly that section.
	writeFileSync(file, "# Agents\n\nreview:\n- three reviewers, two providers\n\nmodels:\nthe routing lives in the contract block.\n");
	assert.equal(readConfig(file).config.contract_version, 1, "prose must fall through to the documented defaults");

	// Still refused: the author tried and the block did not parse.
	for (const broken of [
		"# A\n~~~yaml\nmodels:\n  implement: { provider: a, model: m }\n~~~\n",
		"# A\n```yaml\nmodels:\n  implement: { provider: a, model: m }\n",
		"# A\n```\nbudgets:\n  max_runs_per_tree: 7\n```\n",
	]) {
		writeFileSync(file, broken);
		assert.throws(() => readConfig(file), /no fenced YAML block parsed/, broken);
	}

	// A shell example that happens to contain a key line is prose, not intent.
	writeFileSync(file, "# A\n```bash\nreview: not yaml\n```\n");
	assert.equal(readConfig(file).config.contract_version, 1);
});

test("a mapped role's model and provider must be non-empty strings", () => {
	const root = createProject();
	const file = join(root, "AGENTS.md");
	const withRole = (yaml) => CONTRACT.replace("  implement: { provider: anthropic, model: impl }\n", yaml);

	writeFileSync(file, withRole("  implement:\n    provider: anthropic\n    model:\n      name: impl\n"));
	const nested = readConfig(file);
	assert.equal(resolveAllModels(nested.config).implement, "anthropic/[object Object]", "the routing this used to produce");
	assert.ok(
		validate(nested.config, nested, {}).errors.some((e) => /models\.implement\.model must be a non-empty string/.test(e)),
		JSON.stringify(validate(nested.config, nested, {}).errors),
	);

	writeFileSync(file, withRole("  implement: { provider: 5, model: impl }\n"));
	const numeric = readConfig(file);
	assert.ok(validate(numeric.config, numeric, {}).errors.some((e) => /models\.implement\.provider must be a non-empty string/.test(e)));

	// The valid contract stays valid.
	writeFileSync(file, CONTRACT);
	const good = readConfig(file);
	assert.deepEqual(validate(good.config, good, {}).errors, []);
});

test("git stash runs project filters inside the integrity guard", () => {
	const root = createProject();
	const state = join(root, ".pipeline", "state");
	mkdirSync(join(root, "scripts"), { recursive: true });
	// A clean filter is project code, and `git stash push` runs it. This one
	// resets the run counter the budget is enforced from.
	writeFileSync(
		join(root, "scripts", "clean.mjs"),
		'import { readFileSync, writeFileSync } from "node:fs";\nwriteFileSync(".pipeline/state/one.json", JSON.stringify({ root_id: "one", runs_used: 0 }));\nprocess.stdout.write(readFileSync(0));\n',
	);
	writeFileSync(join(root, ".gitattributes"), "work.txt filter=probe\n");
	writeFileSync(join(root, "work.txt"), "committed\n");
	checkedGit(root, ["config", "filter.probe.clean", "node scripts/clean.mjs"]);
	checkedGit(root, ["add", "."]);
	checkedGit(root, ["commit", "-qm", "filter"]);
	writeFileSync(join(root, "work.txt"), "rejected implementation\n");
	// After the commit: `git add` already ran the filter once, and a snapshot
	// taken over its output would read the identical second write as no change.
	mkdirSync(state, { recursive: true });
	const probe = join(state, "one.json");
	const original = JSON.stringify({ root_id: "one", runs_used: 4 });
	writeFileSync(probe, original);

	const stderr = { write() {} };
	assert.throws(
		() => stashRejectedTree({
			root, workDir: join(root, ".pipeline", "work", "one"), preserve: preservePaths(root),
			message: "pipeline: blocked one", stderr, protectedPaths: [state],
		}),
		(error) => error.code === "PIPELINE_CONTROL" && /during stash/.test(error.message),
	);
	assert.equal(readFileSync(probe, "utf8"), original, "the tampered counter is restored");
	assert.ok(existsSync(probe));
});

test("truncation cuts on a UTF-8 character boundary", () => {
	const buf = Buffer.from("aä€😀b", "utf8"); // 1 + 2 + 3 + 4 + 1 bytes
	assert.equal(sliceUtf8(buf, 100).toString("utf8"), "aä€😀b");
	assert.equal(sliceUtf8(buf, 2).toString("utf8"), "a", "half of ä is dropped, not turned into U+FFFD");
	assert.equal(sliceUtf8(buf, 3).toString("utf8"), "aä");
	assert.equal(sliceUtf8(buf, 9).toString("utf8"), "aä€");
	assert.equal(sliceUtf8(buf, 10).toString("utf8"), "aä€😀", "a cut that is already on a boundary is not moved");
	assert.ok(!sliceUtf8(buf, 5).toString("utf8").includes("�"));
});

test("a JSON object outside a fence is a candidate: findings and verdicts survive a fenced approve", () => {
	const crit = '{"role":"security","verdict":"reject","findings":[{"severity":"critical","file":"a.js","title":"leak"}]}';
	const ok = '{"role":"security","verdict":"approve","findings":[]}';
	for (const text of [
		`${crit}\n\n\`\`\`json\n${ok}\n\`\`\`\n`, // bare first
		`\`\`\`json\n${ok}\n\`\`\`\n\n${crit}\n`, // fenced first — order must not matter
		`${crit}\n${ok}\n`, // both bare: the whole text parses as neither
	]) {
		const parsed = extractJson(text);
		assert.equal(parsed?.verdict, "reject", text);
		assert.deepEqual(parsed?.findings.map((f) => f.severity), ["critical"], text);
	}
	// Strictest-wins for the master, in both directions.
	assert.equal(parseMasterDecision('{"decision":"reject"}\n\n```json\n{"decision":"approve"}\n```\n').decision, "reject");
	assert.equal(parseMasterDecision('{"decision":"take_over"}\n\n```json\n{"decision":"approve"}\n```\n').decision, "take_over");
	// A brace inside a string must not end the object early.
	assert.equal(extractJson('{"role":"r","verdict":"reject","findings":[],"note":"a } and a \\" quote"}')?.verdict, "reject");
});

test("mixed fenced and free JSON does not release work: no approval, no commit", async () => {
	const root = createProject();
	const stub = join(root, ".git", "mixed.mjs");
	copyFileSync(new URL("../fixtures/mixed-json-stub.mjs", import.meta.url), stub);
	let output = "";
	const stream = { write(text) { output += text; } };
	await runPipeline({
		root, flags: { maxRuns: 1 }, stdout: stream, stderr: stream,
		env: { ...process.env, PIPELINE_PI_BIN: stub },
	});
	// The unit assertions above cannot show this: the consequence of losing the
	// finding was a commit of the implementer's diff, secrets and all.
	assert.doesNotMatch(output, /approved:/, output);
	assert.equal(checkedGit(root, ["rev-list", "--count", "HEAD"]).trim(), "1", "an unreviewed diff was committed");
	assert.doesNotMatch(checkedGit(root, ["show", "HEAD:tasks.md"]), /\[x\] one/);
	const gate = JSON.parse(readFileSync(join(root, ".pipeline", "work", "one", "gate.json"), "utf8"));
	assert.equal(gate.verdict, "blocked", JSON.stringify(gate));
	assert.ok(gate.blocking.some((f) => f.severity === "critical"), JSON.stringify(gate));
});

test("init pins the wrapper to LF by what git resolves, not by how a line looks", async () => {
	// `-text eol=lf` is the trap: `eol` resolves to lf and nothing is
	// normalised, because `text` is explicitly unset.
	for (const existing of [
		"auto-develop.sh linguist-generated=true\n",
		"auto-develop.sh text eol=crlf\n",
		"auto-develop.sh -text\n",
		"auto-develop.sh -text eol=lf\n",
		"",
	]) {
		const root = createProject();
		if (existing) writeFileSync(join(root, ".gitattributes"), existing);
		const said = [];
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = (text) => { said.push(String(text)); return true; };
		try { await initCommand([], { root, env: { ...process.env } }); } finally { process.stdout.write = original; }
		const resolved = checkedGit(root, ["check-attr", "text", "eol", "--", "auto-develop.sh"]).trim().replace(/\n/g, " ");
		assert.match(resolved, /text: set/, `${JSON.stringify(existing)} -> ${resolved}\n${said.join("")}`);
		assert.match(resolved, /eol: lf/, `${JSON.stringify(existing)} -> ${resolved}\n${said.join("")}`);
		assert.doesNotMatch(said.join(""), /already has a line-ending rule/, "the old wording claimed a rule that git did not resolve");
	}
	// A rule that lives only in the user's core.attributesFile is not the
	// project's: init must still write one that travels with a clone.
	const root = createProject();
	const userAttributes = join(mkdtempSync(join(tmpdir(), "pipeline-attrs-")), "attributes");
	writeFileSync(userAttributes, "auto-develop.sh text eol=lf\n");
	checkedGit(root, ["config", "core.attributesFile", userAttributes.split(sep).join("/")]);
	const restore = process.stdout.write.bind(process.stdout);
	process.stdout.write = () => true;
	try { await initCommand([], { root, env: { ...process.env } }); } finally { process.stdout.write = restore; }
	checkedGit(root, ["config", "--unset", "core.attributesFile"]);
	assert.match(
		checkedGit(root, ["check-attr", "eol", "--", "auto-develop.sh"]).trim(),
		/eol: lf$/,
		"the LF pin has to survive without the user's attributes file",
	);
});

// One path per test: a pass on the reviewer path must not cover a regression
// on the master path, which is why they do not share a stub run.
async function proseRun(target) {
	const root = createProject();
	const stub = join(root, ".git", `prose-${target}.mjs`);
	copyFileSync(new URL("../fixtures/prose-hidden-json-stub.mjs", import.meta.url), stub);
	let output = "";
	const stream = { write(text) { output += text; } };
	await runPipeline({
		root, flags: { maxRuns: 1 }, stdout: stream, stderr: stream,
		env: { ...process.env, PIPELINE_PI_BIN: stub, PROBE_TARGET: target },
	});
	return { root, output };
}

test("prose with an unmatched brace and quote cannot hide a reviewer's critical", async () => {
	const { root, output } = await proseRun("reviewer");
	assert.doesNotMatch(output, /approved:/, output);
	assert.equal(checkedGit(root, ["rev-list", "--count", "HEAD"]).trim(), "1", "an unreviewed diff was committed");
	const gate = JSON.parse(readFileSync(join(root, ".pipeline", "work", "one", "gate.json"), "utf8"));
	assert.equal(gate.verdict, "blocked", JSON.stringify(gate));
	assert.ok(gate.blocking.some((f) => f.severity === "critical"), JSON.stringify(gate));
});

test("prose with an unmatched brace and quote cannot hide the master's reject", async () => {
	const { root, output } = await proseRun("master");
	// The panel is clean here: the master's own decision is the only thing
	// standing between the diff and a commit.
	const gate = JSON.parse(readFileSync(join(root, ".pipeline", "work", "one", "gate.json"), "utf8"));
	assert.equal(gate.verdict, "clear", JSON.stringify(gate));
	assert.doesNotMatch(output, /approved:/, output);
	assert.equal(checkedGit(root, ["rev-list", "--count", "HEAD"]).trim(), "1", "the master's reject was lost and the diff committed");
});

test("a severity or decision the scanner never reached refuses to release work", () => {
	// Truncated past any brace matching: the key is stated, no object holds it.
	const stranded = '{"severity":"critical","file":"a.js"\n\n```json\n{"role":"r","verdict":"approve","findings":[]}\n```\n';
	assert.equal(extractJson(stranded)?.invalidFindings, true, "an unreached severity must cost the panel seat");
	assert.notEqual(checkReviewerText(stranded).exit, 0, "and it must trigger the retry");
	const strandedDecision = '{"decision":"reject"\n\n```json\n{"decision":"approve"}\n```\n';
	const verdict = parseMasterDecision(strandedDecision);
	assert.equal(verdict.decision, "reject");
	assert.match(verdict.note, /not read/);
	// Ordinary output is untouched: every severity sits inside a parsed object.
	assert.equal(extractJson('{"role":"r","verdict":"reject","findings":[{"severity":"high","file":"a"}]}')?.invalidFindings, false);
});

test("an unrelated later attributes rule neither warns nor duplicates the wrapper rule", async () => {
	const root = createProject();
	const attributes = join(root, ".gitattributes");
	const quiet = async () => {
		const restore = process.stdout.write.bind(process.stdout);
		const said = [];
		process.stdout.write = (text) => { said.push(String(text)); return true; };
		try { await initCommand([], { root, env: { ...process.env } }); } finally { process.stdout.write = restore; }
		return said.join("");
	};
	await quiet();
	// `*.md text` cannot match auto-develop.sh, so it cannot override it. The
	// rule "must be the last line of the file" read it as an override.
	appendFileSync(attributes, "*.md text\n");
	const second = await quiet();
	const rules = readFileSync(attributes, "utf8").split("\n").filter((l) => l.startsWith("auto-develop.sh"));
	assert.equal(rules.length, 1, `init duplicated the wrapper rule: ${JSON.stringify(rules)}`);
	assert.doesNotMatch(second, /FAIL/, second);
	assert.match(checkedGit(root, ["check-attr", "eol", "--", "auto-develop.sh"]).trim(), /eol: lf$/);
	const doctorLines = runDoctor({ root }).lines.filter((l) => /auto-develop\.sh/.test(l) && /LF rule|resolves/.test(l));
	assert.ok(doctorLines.every((l) => l.startsWith("PASS")), doctorLines.join("\n"));
	// Both directions in one test: repairing either one of these broke the
	// other once. A later rule that names the wrapper overrides it…
	appendFileSync(attributes, "auto-develop.sh -text\n");
	assert.equal(hasWrapperEolRule(root), false, "a later rule for the same path overrides ours");
	// …and so does a later wildcard that actually matches it, which no test on
	// the effective attributes can see: `.git/info/attributes` outranks
	// `.gitattributes`, and a private LF rule there would mask the conflict.
	writeFileSync(attributes, "auto-develop.sh text eol=lf\n*.sh text eol=crlf\n");
	assert.equal(hasWrapperEolRule(root), false, "a later matching wildcard overrides the pin");
	writeFileSync(attributes, "auto-develop.sh text eol=lf\n*.md text\n");
	assert.equal(hasWrapperEolRule(root), true, "a later non-matching wildcard does not");
});

test("the unprocessed-review marker blocks, but never reaches the implementer", () => {
	const quoted = 'The config hard-codes "severity": "critical" already.\n{"role":"s","verdict":"approve","findings":[]}';
	const parsed = extractJson(quoted);
	assert.ok(parsed.findings.some((f) => f.severity === UNPROCESSED_SEVERITY), JSON.stringify(parsed.findings));
	const gate = runGate({
		files: [], evidenceFiles: [], blocking: ["critical", "high"], followup: ["medium", "low"], minReviewers: 1,
	});
	assert.equal(gate.result.verdict, "blocked", "an empty panel blocks");
	// What the implementer is told must not be a message to the reviewer: it
	// cannot act on "return complete review JSON", and over every attempt it
	// would be the only feedback it got.
	const withMarker = { blocking: [{ severity: UNPROCESSED_SEVERITY, file: "-", title: "x" }, { severity: "high", file: "a.js", title: "real" }], followups: [] };
	const prose = findingsToProse(withMarker);
	assert.doesNotMatch(prose, new RegExp(UNPROCESSED_SEVERITY), prose);
	assert.match(prose, /real/, prose);
	assert.equal(findingsToProse({ blocking: [{ severity: UNPROCESSED_SEVERITY, file: "-", title: "x" }], followups: [] }), "");
});

test("two unprocessed attempts in a row end the issue as a configuration error", async () => {
	const root = createProject();
	const stub = join(root, ".git", "unprocessed.mjs");
	copyFileSync(new URL("../fixtures/quoting-reviewer-stub.mjs", import.meta.url), stub);
	let output = "";
	const stream = { write(text) { output += text; } };
	const rc = await runPipeline({
		root, flags: {}, stdout: stream, stderr: stream,
		env: { ...process.env, PIPELINE_PI_BIN: stub },
	});
	assert.doesNotMatch(output, /approved:/, output);
	assert.match(output, /two consecutive attempts carried reviewer output that could not be fully processed/, output);
	// The point of the streak: it costs two attempts, not the whole tree.
	const state = JSON.parse(readFileSync(join(root, ".pipeline", "state", "one.json"), "utf8"));
	assert.equal(state.runs_used, 2, JSON.stringify(state));
	assert.equal(state.issues.one.status, "blocked");
	assert.equal(rc, 1);
	assert.equal(checkedGit(root, ["rev-list", "--count", "HEAD"]).trim(), "1");
});
