// review-2026-10-20.test.mjs — regressions from the two reviews of 1.3.0:
// governance restored when a step also trips the control check (INV-28), a
// refused stash before a take_over halts (INV-13), a blocked --issue is no
// success (INV-07), the wrapper init accepts is the one bash can run, the
// issue-source command never sees trust, upper-case harness copies are
// scanned for markers, and the contract reader takes fences line by line.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { initCommand } from "../../lib/cli/init.mjs";
import { parseWrapper, wrapperPin, wrapperText } from "../../lib/cli/wrapper.mjs";
import { readConfig, validate } from "../../lib/contract/index.mjs";
import { scanDecisionMarkers } from "../../lib/integrity/markers.mjs";
import { runPipeline } from "../../lib/loop/run.mjs";
import { CONTRACT, createProject } from "../fixtures/project.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const governanceCli = join(here, "..", "..", "lib", "governance.mjs");
const packageVersion = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")).version;

// The implementer runs PROBE_IMPLEMENT (a JS snippet) after writing work.txt;
// reviewers approve; the master walks through PROBE_MASTER and runs
// PROBE_MASTER_HOOK first.
const STUB = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
appendFileSync(".git/calls.log", prompt.split("\\n")[0] + "\\n");
if (prompt.startsWith("Implement this issue")) {
  appendFileSync("work.txt", "line " + Date.now() + Math.random() + "\\n");
  if (process.env.PROBE_IMPLEMENT) eval(process.env.PROBE_IMPLEMENT);
} else if (prompt.startsWith("You review")) console.log('{"role":"probe","verdict":"approve","findings":[]}');
else if (prompt.startsWith("Decide this attempt")) {
  const counter = ".git/master-calls";
  const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(n + 1));
  if (process.env.PROBE_MASTER_HOOK) eval(process.env.PROBE_MASTER_HOOK);
  const plan = (process.env.PROBE_MASTER || "approve").split(",");
  console.log(JSON.stringify({ decision: plan[Math.min(n, plan.length - 1)], reasons: ["probe"] }));
} else console.log("notes");
`;

async function run(root, env = {}, flags = { onlyIssue: "one" }) {
	writeFileSync(join(root, ".git", "stub.mjs"), STUB);
	let output = "";
	const stream = { write(text) { output += text; } };
	const rc = await runPipeline({ root, flags, stdout: stream, stderr: stream, env: { ...process.env, PIPELINE_PI_BIN: join(root, ".git", "stub.mjs"), ...env } });
	return { rc, output };
}

const calls = (root) => (existsSync(join(root, ".git", "calls.log")) ? readFileSync(join(root, ".git", "calls.log"), "utf8") : "");

const TAMPER = `appendFileSync("AGENTS.md", "\\nUNAUTHORIZED GOVERNANCE\\n"); writeFileSync(".pipeline/state/one.json", "{}");`;

test("an implementer that changes governance and a control file leaves governance restored", async () => {
	const root = createProject();
	const contract = readFileSync(join(root, "AGENTS.md"), "utf8");
	const { rc, output } = await run(root, { PROBE_IMPLEMENT: TAMPER });
	assert.equal(rc, 1, output);
	assert.match(output, /control files modified during implement/);
	assert.match(output, /governance modified during implement too \(.*AGENTS\.md.*\); restored/);
	assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), contract);
	assert.doesNotMatch(output, /approved:/);
});

test("a gate that changes governance and a control file leaves governance restored", async () => {
	const root = createProject();
	writeFileSync(join(root, ".git", "gate.mjs"), `import { appendFileSync, writeFileSync } from "node:fs";\n${TAMPER}\n`);
	writeFileSync(join(root, "AGENTS.md"), CONTRACT.replace("gates: []", 'gates:\n  - { name: tamper, run: "node .git/gate.mjs" }'));
	const contract = readFileSync(join(root, "AGENTS.md"), "utf8");
	const { rc, output } = await run(root);
	assert.equal(rc, 1, output);
	assert.match(output, /control files modified during gate tamper/);
	assert.match(output, /governance modified during gate tamper too/);
	assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), contract);
});

test("a refused stash before a take_over halts the run instead of escalating on the rejected tree", async () => {
	const root = createProject();
	const { rc, output } = await run(root, {
		PROBE_MASTER: "take_over,approve",
		PROBE_MASTER_HOOK: 'if (n === 0) writeFileSync(".git/index.lock", "held by a crashed git");',
	});
	assert.equal(rc, 1, output);
	assert.match(output, /warning: git stash failed/);
	assert.match(output, /stopped: git stash failed before the take_over of one/);
	assert.equal(calls(root).split("\n").filter((l) => l.startsWith("Implement this issue")).length, 1, calls(root));
	assert.doesNotMatch(output, /approved:/);
	const state = JSON.parse(readFileSync(join(root, ".pipeline", "state", "one.json"), "utf8"));
	assert.equal(state.issues.one.attempts_master, 0, "no escalation was recorded");
});

test("--issue naming a blocked issue exits non-zero without a model call", async () => {
	const root = createProject();
	mkdirSync(join(root, ".pipeline", "state"), { recursive: true });
	writeFileSync(join(root, ".pipeline", "state", "one.json"), JSON.stringify({
		root_id: "one", runs_used: 3, max_runs_per_tree: 25, depth: 0,
		issues: { one: { attempts_controller: 3, implement_runs: 3, attempts_master: 0, status: "blocked" } },
	}));
	const { rc, output } = await run(root);
	assert.equal(rc, 1, output);
	assert.match(output, /skip one \(status: blocked\)/);
	assert.match(output, /node ".*governance\.mjs" state issue \.pipeline one one open/);
	assert.equal(calls(root), "");
});

test("init rewrites a recognised CRLF wrapper to LF and keeps its configuration", async () => {
	const root = createProject();
	const text = wrapperText({ version: packageVersion, harness: "anthropic=claude-code" });
	writeFileSync(join(root, "auto-develop.sh"), text.replace(/\n/g, "\r\n"));
	assert.equal(await initCommand([], { root }), 0);
	assert.equal(readFileSync(join(root, "auto-develop.sh"), "utf8"), text);
});

test("a local wrapper runs the checkout path literally, whatever the path contains", () => {
	const base = mkdtempSync(join(tmpdir(), "pipeline-wrapper-"));
	const dir = join(base, "$PROBE_UNSET it's `here`");
	mkdirSync(dir, { recursive: true });
	const bin = join(dir, "pipeline.mjs");
	writeFileSync(bin, 'console.log("engine " + process.argv.slice(2).join(" "));\n');
	const text = wrapperText({ version: packageVersion, localBin: bin });
	assert.deepEqual(parseWrapper(text), { version: packageVersion, harness: null, localBin: bin.replace(/\\/g, "/") });
	writeFileSync(join(base, "auto-develop.sh"), text);
	const env = { ...process.env, PROBE_UNSET: "expanded-instead-of-literal" };
	delete env.PIPELINE_BIN;
	const r = spawnSync("bash", [join(base, "auto-develop.sh").replace(/\\/g, "/"), "--dry-run"], { env, encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout.trim(), "engine run --dry-run");
	// A 1.3.0 local wrapper is reported by its pin, not as a foreign script.
	assert.equal(wrapperPin(`# auto-develop.sh — generated by \`pi-governance-pipeline init\` (1.3.0). x\nexec node "\${PIPELINE_BIN:-/x/bin/pipeline.mjs}" run "$@"\n`), "1.3.0");
});

test("the issue-source command never sees PIPELINE_UNATTENDED", async () => {
	const root = createProject();
	writeFileSync(join(root, ".git", "source.mjs"), 'import { appendFileSync } from "node:fs";\nappendFileSync(".git/source-env.log", String(process.env.PIPELINE_UNATTENDED) + "\\n");\nconsole.log("one: first issue");\n');
	const { output } = await run(root, { ISSUE_SOURCE: "!node .git/source.mjs", PIPELINE_UNATTENDED: "1", COMMIT_APPROVED: "0" }, { onlyIssue: "one", unattended: true, assumeYes: true });
	const seen = readFileSync(join(root, ".git", "source-env.log"), "utf8").trim().split("\n");
	assert.ok(seen.length >= 1, output);
	assert.deepEqual([...new Set(seen)], ["undefined"], output);
});

test("an upper-case harness copy is scanned for markers, and once on a case-insensitive file system", () => {
	const root = createProject();
	writeFileSync(join(root, "CLAUDE.MD"), "# Claude\n[USER DECISION REQUIRED] pick a stack\n");
	const hits = scanDecisionMarkers(root);
	assert.equal(hits.length, 1, JSON.stringify(hits));
	assert.equal(hits[0].line, 2);
});

function contractOf(text) {
	const dir = mkdtempSync(join(tmpdir(), "pipeline-fence-"));
	const file = join(dir, "AGENTS.md");
	writeFileSync(file, text);
	return () => readConfig(file);
}

const BODY = CONTRACT.slice(CONTRACT.indexOf("\n", CONTRACT.indexOf("```")) + 1, CONTRACT.lastIndexOf("```"));

test("an unmarked example does not stand in for a contract the reader cannot take", () => {
	const example = "```yaml\nbudgets: { max_runs_per_tree: 99 }\n```\n\n";
	for (const broken of [`\`\`\`\n${BODY}\`\`\`\n`, `~~~yaml\n${BODY}~~~\n`]) {
		assert.throws(contractOf(`# Governance\n\n${example}${broken}`), /not a closed ```yaml fence/);
	}
	assert.throws(contractOf(`# Governance\n\n${example}~~~yaml pipeline-contract\n${BODY}~~~\n`), /cannot take \(a ~~~ fence\)/);
	assert.throws(contractOf(`# Governance\n\n\`\`\`yaml pipeline-contract\n${BODY}`), /cannot take \(its closing backticks are missing\)/);
	// A later fence's opening line does not close it either: the prose in
	// between is read as contract and refused, never run on defaults.
	assert.throws(contractOf(`# Governance\n\n\`\`\`yaml pipeline-contract\n${BODY}\nmore prose\n\`\`\`bash\nnpm test\n\`\`\`\n`), /expected `key: value`, got `more prose`/);
});

// 1.3.1 refused this file, which 1.3.0 read: one key line in sample output is
// no contract attempt.
test("a key line in an untagged example next to an unmarked contract warns instead of refusing", () => {
	const source = contractOf(`# Agents\n\n\`\`\`yaml\n${BODY}\`\`\`\n\nExample output:\n\n\`\`\`\nreview: approve\n\`\`\`\n`)();
	assert.equal(source.config.contract_version, 2);
	assert.ok(source.warnings.some((w) => /outside a ```yaml fence with a contract key line/.test(w)), source.warnings.join("\n"));
});

test("backticks inside a sentence neither open nor close a contract block", () => {
	const text = `# Governance\n\nMark the block as \`\`\`yaml pipeline-contract\`\`\` once.\n\n\`\`\`yaml pipeline-contract\n${BODY}\`\`\`\n`;
	const { config } = contractOf(text)();
	assert.equal(config.contract_version, 2);
	assert.equal(config.issues.source, "tasks.md");
});

test("an empty contract_version is refused instead of read as v1", () => {
	const source = contractOf(`\`\`\`yaml pipeline-contract\n${BODY.replace("contract_version: 2", "contract_version:")}\`\`\`\n`)();
	const { errors } = validate(source.config, source, {});
	assert.ok(errors.some((e) => /contract_version must be 1 or 2; got null/.test(e)), errors.join("\n"));
});

test("the state facade reads the relocated contract the run reads", () => {
	const root = createProject();
	mkdirSync(join(root, "gov"));
	writeFileSync(join(root, "gov", "AGENTS.md"), CONTRACT.replace("gates: []", "gates: []\nbudgets: { max_attempts_controller: 0 }"));
	const env = { ...process.env, AGENTS_FILE: "gov/AGENTS.md" };
	delete env.GOVERNANCE_AGENTS;
	const r = spawnSync(process.execPath, [governanceCli, "state", "show", ".pipeline", "one"], { cwd: root, env, encoding: "utf8" });
	assert.equal(r.status, 2, r.stdout + r.stderr);
	assert.match(r.stderr, /max_attempts_controller/);
});
